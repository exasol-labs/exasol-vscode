/**
 * SQL-related utility functions: escaping, tokenization, and statement splitting.
 */

/**
 * Escape a string value for safe interpolation into SQL single-quoted literals.
 * Doubles all single-quote characters to prevent SQL injection.
 */
export function escapeSqlString(value: string): string {
    return value.replace(/'/g, "''");
}

/**
 * Escape a string value for safe interpolation into SQL double-quoted identifiers.
 * Doubles all double-quote characters so that the name cannot escape the identifier context.
 * Use this when embedding user- or database-supplied names inside "identifier" delimiters.
 */
export function escapeSqlIdentifier(name: string): string {
    return name.replace(/"/g, '""');
}

/**
 * The name a database stores for an identifier written in SQL: a quoted
 * identifier as written, without its quotes and with `""` unescaped; any
 * other identifier in uppercase.
 */
export function normalizeIdentifier(written: string): string {
    return /^".*"$/s.test(written) ? written.slice(1, -1).replace(/""/g, '"') : written.toUpperCase();
}

/** Columns of SYS and EXA_STATISTICS tables are listed in EXA_SYS_COLUMNS, not in EXA_ALL_COLUMNS. */
export function columnsViewFor(schemaName: string): string {
    return schemaName === 'SYS' || schemaName === 'EXA_STATISTICS' ? 'SYS.EXA_SYS_COLUMNS' : 'SYS.EXA_ALL_COLUMNS';
}

// ---------------------------------------------------------------------------
// State-machine SQL tokenizer
// ---------------------------------------------------------------------------

/**
 * Parser states for the SQL tokenizer.
 * Numeric enum so TypeScript emits the values at runtime (needed for switch).
 */
const enum SqlTokenState {
    DEFAULT = 0,
    /** Inside a string literal or a quoted identifier; `quote` holds its delimiter. */
    IN_QUOTED = 1,
    IN_LINE_COMMENT = 2,
    IN_BLOCK_COMMENT = 3
}

/** True for the delimiter of a string literal or a quoted identifier. */
function isQuote(ch: string): boolean {
    return ch === "'" || ch === '"';
}

/**
 * Strip SQL comments while preserving string literal contents.
 * Uses an O(n) single-pass state-machine that tracks:
 *   - Single-quoted string literals (Exasol uses '' to escape a quote inside)
 *   - Double-quoted identifiers (with "" as the escape), which may contain
 *     `;`, `--` and slash-star as ordinary characters
 *   - Single-line comments (-- to end of line)
 *   - Block comments (slash-star to star-slash, non-nesting)
 *
 * @param text The SQL text whose comments should be stripped
 * @returns Text with all comments removed, preserving newlines for line fidelity
 */
export function stripCommentsPreservingStrings(text: string): string {
    let state: SqlTokenState = SqlTokenState.DEFAULT;
    let quote = '';
    let result = '';
    let i = 0;
    const len = text.length;

    while (i < len) {
        const ch = text[i];
        const next = i + 1 < len ? text[i + 1] : '';

        switch (state) {
            case SqlTokenState.DEFAULT:
                if (isQuote(ch)) {
                    state = SqlTokenState.IN_QUOTED;
                    quote = ch;
                    result += ch;
                    i++;
                } else if (ch === '-' && next === '-') {
                    state = SqlTokenState.IN_LINE_COMMENT;
                    result += ' ';
                    i += 2;
                } else if (ch === '/' && next === '*') {
                    state = SqlTokenState.IN_BLOCK_COMMENT;
                    result += ' ';
                    i += 2;
                } else {
                    result += ch;
                    i++;
                }
                break;

            case SqlTokenState.IN_QUOTED:
                if (ch === quote && next === quote) {
                    result += ch + next;
                    i += 2;
                } else if (ch === quote) {
                    state = SqlTokenState.DEFAULT;
                    result += ch;
                    i++;
                } else {
                    result += ch;
                    i++;
                }
                break;

            case SqlTokenState.IN_LINE_COMMENT:
                if (ch === '\n') {
                    state = SqlTokenState.DEFAULT;
                    result += '\n';
                }
                i++;
                break;

            case SqlTokenState.IN_BLOCK_COMMENT:
                if (ch === '*' && next === '/') {
                    state = SqlTokenState.DEFAULT;
                    i += 2;
                } else {
                    if (ch === '\n') {
                        result += '\n';
                    }
                    i++;
                }
                break;
        }
    }

    return result;
}

/** Function definition progress while scanning a CREATE FUNCTION statement. */
const enum FunctionBody {
    NONE = 0,
    /** Before BEGIN: parameters, return type and declarations. */
    HEADER = 1,
    /** After BEGIN, before the END that closes the body. */
    OPEN = 2,
    CLOSED = 3
}

const TAB = 9;
const NEWLINE = 10;
const CARRIAGE_RETURN = 13;
const SPACE = 32;
const DOUBLE_QUOTE = 34;
const SINGLE_QUOTE = 39;
const STAR = 42;
const DASH = 45;
const SLASH = 47;
const SEMICOLON = 59;

function isWordCode(c: number): boolean {
    return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

/** True for a character that `\s` matches. */
function isSpaceCode(c: number): boolean {
    return c === SPACE || (c >= TAB && c <= CARRIAGE_RETURN) || (c > 127 && /\s/.test(String.fromCharCode(c)));
}

/** Index of the `\n` that ends the line containing `from`, or the text length. */
function lineEndAt(text: string, from: number): number {
    const nl = text.indexOf('\n', from);
    return nl === -1 ? text.length : nl;
}

/** Index after the string literal or quoted identifier that opens at `from`, or the text length. */
function quotedEnd(text: string, from: number): number {
    const quote = text[from];
    let i = from + 1;
    for (;;) {
        const close = text.indexOf(quote, i);
        if (close === -1) {
            return text.length;
        }
        if (text[close + 1] !== quote) {
            return close + 1;
        }
        i = close + 2;
    }
}

/** Index after the block comment that opens at `from`, or the text length. */
function blockCommentEnd(text: string, from: number): number {
    const close = text.indexOf('*/', from + 2);
    return close === -1 ? text.length : close + 2;
}

/**
 * If the line starting at `lineStart` holds only `/` (with optional
 * whitespace), return the index of the `/`; otherwise -1. This is the
 * terminator the Exasol SQL clients use for script and function definitions.
 */
function slashLineAt(text: string, lineStart: number): number {
    const len = text.length;
    let i = lineStart;
    while (i < len && text.charCodeAt(i) !== NEWLINE && isSpaceCode(text.charCodeAt(i))) {
        i++;
    }
    if (text.charCodeAt(i) !== SLASH) {
        return -1;
    }
    const slash = i++;
    while (i < len && text.charCodeAt(i) !== NEWLINE) {
        if (!isSpaceCode(text.charCodeAt(i))) {
            return -1;
        }
        i++;
    }
    return slash;
}

/**
 * Line marks for script definitions, in ascending order: the `/` of every
 * line that holds only `/`, and the `CREATE` of every line that starts a
 * script or function definition.
 */
function findLineMarks(text: string): { slashes: number[]; definitions: number[] } {
    const slashes: number[] = [];
    const definitions: number[] = [];
    for (let lineStart = 0; lineStart < text.length; lineStart = lineEndAt(text, lineStart) + 1) {
        const slash = slashLineAt(text, lineStart);
        if (slash !== -1) {
            slashes.push(slash);
            continue;
        }
        let i = lineStart;
        while (text.charCodeAt(i) === SPACE || text.charCodeAt(i) === TAB) {
            i++;
        }
        if (text.slice(i, i + 6).toUpperCase() === 'CREATE' && !isWordCode(text.charCodeAt(i + 6))
            && definitionKind(readWords(text, i, 6)) !== undefined) {
            definitions.push(i);
        }
    }
    return { slashes, definitions };
}

/** The first of the ascending `values` that is greater than `after`, or undefined. */
function firstAfter(values: number[], after: number): number | undefined {
    let lo = 0;
    let hi = values.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (values[mid] <= after) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return values[lo];
}

/**
 * Remove one final line that holds only `/`, for text that is sent as one
 * statement without going through splitIntoStatements.
 */
export function stripFinalSlashLine(text: string): string {
    return text.replace(/\r?\n[ \t]*\/\s*$/, '');
}

/** Up to `max` upper-cased words from `from`, skipping whitespace and comments. */
function readWords(text: string, from: number, max: number): string[] {
    const words: string[] = [];
    let i = from;
    while (i < text.length && words.length < max) {
        const c = text.charCodeAt(i);
        if (isSpaceCode(c)) {
            i++;
        } else if (c === DASH && text.charCodeAt(i + 1) === DASH) {
            i = lineEndAt(text, i);
        } else if (c === SLASH && text.charCodeAt(i + 1) === STAR) {
            i = blockCommentEnd(text, i);
        } else if (isWordCode(c)) {
            const start = i;
            while (i < text.length && isWordCode(text.charCodeAt(i))) {
                i++;
            }
            words.push(text.slice(start, i).toUpperCase());
        } else {
            break;
        }
    }
    return words;
}

/**
 * Exclusive end of the statement text before the `/` line at `slashIdx`: the
 * line break in front of that line is part of the terminator, not of the
 * statement, so a body is sent exactly as written.
 */
function textEndBeforeSlash(text: string, slashIdx: number): number {
    const lineBreak = text.lastIndexOf('\n', slashIdx);
    if (lineBreak <= 0) {
        return 0;
    }
    return text[lineBreak - 1] === '\r' ? lineBreak - 1 : lineBreak;
}

/**
 * Classify a statement by its leading keywords:
 * `CREATE [OR REPLACE] [<language>] [SCALAR|SET|ADAPTER] SCRIPT` or
 * `CREATE [OR REPLACE] FUNCTION`. SCRIPT and FUNCTION are reserved words, so
 * they cannot appear there as names of other objects.
 */
function definitionKind(words: string[]): 'script' | 'function' | undefined {
    if (words[0] !== 'CREATE') {
        return undefined;
    }
    const rest = words[1] === 'OR' && words[2] === 'REPLACE' ? words.slice(3) : words.slice(1);
    if (rest[0] === 'FUNCTION') {
        return 'function';
    }
    const script = rest.indexOf('SCRIPT');
    return script !== -1 && script <= 2 ? 'script' : undefined;
}

/**
 * True for a `CREATE [OR REPLACE] ... SCRIPT` or `CREATE [OR REPLACE] FUNCTION`
 * statement. Exasol stores the text of these definitions as sent, including a
 * final `;` and a comment after it; only trailing whitespace is dropped.
 */
export function isScriptOrFunctionDefinition(sql: string): boolean {
    return definitionKind(readWords(sql, 0, 6)) !== undefined;
}

/**
 * Return the character indices where statements end. An index points either
 * at a terminating `;` (part of the statement) or at the `/` of a line that
 * holds only `/` (not part of the statement; the statement ends before the
 * line break that precedes it).
 *
 * Semicolons inside string literals, quoted identifiers and comments are
 * ignored. Exasol script and function definitions follow the convention of
 * the Exasol SQL clients and end at a line that holds only `/`:
 *   - `CREATE ... SCRIPT` runs until the next `/` line, if that line comes
 *     before the next line that starts with a script or function definition.
 *     The body is code in another language, so it is not tokenized as SQL.
 *   - `CREATE ... FUNCTION` ends at a `/` line after the `END [name]` that
 *     closes the body, or at the first `;` after that `END`. Semicolons and
 *     `/` lines inside the body, and the `END` of `IF`, `FOR`, `WHILE` and
 *     `CASE`, do not end it.
 * A script without such a `/` line, and a function that does not end before
 * the end of the text, are split at `;` like any other text, so the
 * statements after them stay separate.
 * A `/` line between statements ends an empty statement; everywhere else
 * (for example a division inside a SELECT) it is ordinary text.
 *
 * @param text The SQL text to scan
 * @returns Array of indices where statements end
 */
export function findStatementEnds(text: string): number[] {
    const ends: number[] = [];
    const len = text.length;
    let lineMarks: { slashes: number[]; definitions: number[] } | undefined;
    let i = 0;
    let statementEmpty = true;
    let functionBody: FunctionBody = FunctionBody.NONE;
    let functionStart = -1;
    // A definition starting here did not end: it is scanned as ordinary statements.
    let plainStart = -1;
    let caseDepth = 0;

    for (;;) {
        while (i < len) {
            const c = text.charCodeAt(i);
            const next = text.charCodeAt(i + 1);
            if ((i === 0 || text.charCodeAt(i - 1) === NEWLINE)
                && (statementEmpty || functionBody === FunctionBody.HEADER || functionBody === FunctionBody.CLOSED)) {
                const slash = slashLineAt(text, i);
                if (slash !== -1) {
                    ends.push(slash);
                    i = lineEndAt(text, i);
                    statementEmpty = true;
                    functionBody = FunctionBody.NONE;
                    continue;
                }
            }
            if (c === SINGLE_QUOTE || c === DOUBLE_QUOTE) {
                // The content of a string or quoted identifier is never a keyword, so it cannot close a function body.
                i = quotedEnd(text, i);
                statementEmpty = false;
            } else if (c === DASH && next === DASH) {
                i = lineEndAt(text, i);
            } else if (c === SLASH && next === STAR) {
                i = blockCommentEnd(text, i);
            } else if (c === SEMICOLON) {
                if (functionBody !== FunctionBody.HEADER && functionBody !== FunctionBody.OPEN) {
                    ends.push(i);
                    statementEmpty = true;
                    functionBody = FunctionBody.NONE;
                }
                i++;
            } else if (isWordCode(c)) {
                const start = i;
                while (i < len && isWordCode(text.charCodeAt(i))) {
                    i++;
                }
                if (statementEmpty) {
                    statementEmpty = false;
                    const kind = start === plainStart || i - start !== 6 || text.slice(start, i).toUpperCase() !== 'CREATE'
                        ? undefined
                        : definitionKind(readWords(text, start, 6));
                    if (kind === 'script') {
                        // The body is not SQL: skip it up to the next `/` line, if one
                        // comes before the next definition that starts a line.
                        lineMarks ??= findLineMarks(text);
                        const end = firstAfter(lineMarks.slashes, lineEndAt(text, start));
                        const nextDefinition = firstAfter(lineMarks.definitions, start);
                        if (end !== undefined && (nextDefinition === undefined || end < nextDefinition)) {
                            ends.push(end);
                            i = lineEndAt(text, end);
                            statementEmpty = true;
                        }
                    } else if (kind === 'function') {
                        functionBody = FunctionBody.HEADER;
                        functionStart = start;
                        caseDepth = 0;
                    }
                } else if (functionBody === FunctionBody.HEADER) {
                    if (text.slice(start, i).toUpperCase() === 'BEGIN') {
                        functionBody = FunctionBody.OPEN;
                    }
                } else if (functionBody === FunctionBody.OPEN) {
                    const word = text.slice(start, i).toUpperCase();
                    if (word === 'CASE') {
                        caseDepth++;
                    } else if (word === 'END' && caseDepth > 0) {
                        caseDepth--;
                    } else if (word === 'END' && !['IF', 'FOR', 'WHILE'].includes(readWords(text, i, 1)[0])) {
                        functionBody = FunctionBody.CLOSED;
                    }
                }
            } else {
                if (!isSpaceCode(c)) {
                    statementEmpty = false;
                }
                i++;
            }
        }
        if (functionBody !== FunctionBody.HEADER && functionBody !== FunctionBody.OPEN) {
            return ends;
        }
        // The function did not end: scan it again from its start, split at `;`.
        plainStart = functionStart;
        i = functionStart;
        statementEmpty = true;
        functionBody = FunctionBody.NONE;
    }
}

/**
 * Compute the character offset of a (line, character) position in `text`.
 * Newlines count as a single character. Mirrors VS Code's TextDocument.offsetAt
 * for files using `\n` line endings (which the extension treats as canonical).
 */
export function offsetAtLineCharacter(text: string, line: number, character: number): number {
    if (line <= 0) { return Math.max(0, character); }
    let lineIdx = 0;
    let i = 0;
    const len = text.length;
    while (i < len && lineIdx < line) {
        if (text[i] === '\n') { lineIdx++; }
        i++;
    }
    return i + Math.max(0, character);
}

/**
 * Build an array where lineOffsets[i] is the character index of the first
 * character on line i (0-based). Accepts the raw document text string.
 */
export function buildLineOffsets(text: string): number[] {
    const offsets: number[] = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') {
            offsets.push(i + 1);
        }
    }
    return offsets;
}

/**
 * Binary search: return the 0-based line number for a character offset,
 * given a lineOffsets table produced by buildLineOffsets.
 */
export function offsetToLine(lineOffsets: number[], offset: number): number {
    let lo = 0;
    let hi = lineOffsets.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineOffsets[mid] <= offset) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    return lo;
}

/**
 * Return true if a trimmed line is blank or a pure single-line comment.
 * Used internally; comment detection here is intentionally naive since it is
 * only applied to lines that are already known to be outside string literals
 * (the state-machine tokenizer governs all boundary-detection).
 */
function isBlankOrCommentLine(trimmed: string): boolean {
    return !trimmed || trimmed.startsWith('--');
}

/**
 * Index of the first character in [from, to) that is not whitespace or part
 * of a comment, or `to` when there is none.
 */
function firstContentAt(text: string, from: number, to: number): number {
    let i = from;
    while (i < to) {
        const c = text.charCodeAt(i);
        if (c === DASH && text.charCodeAt(i + 1) === DASH) {
            i = lineEndAt(text, i);
        } else if (c === SLASH && text.charCodeAt(i + 1) === STAR) {
            i = blockCommentEnd(text, i);
        } else if (isSpaceCode(c)) {
            i++;
        } else {
            return i;
        }
    }
    return to;
}

/**
 * Return the character-index ranges of every SQL statement in text.
 * Uses the same tokenizer as findStatementEnds, so semicolons inside string
 * literals, quoted identifiers or comments are never treated as boundaries.
 *
 * Each returned range spans from the first non-whitespace character of the
 * statement to its last character (inclusive): the semicolon, or for a
 * statement closed by a `/` line, the character before that line's line
 * break. Statements with no terminator are NOT included (use
 * splitIntoStatements for those), nor are empty ones.
 *
 * @param text The SQL text to scan
 * @returns Array of {start, end} character index pairs
 */
export function findStatementRanges(text: string): Array<{ start: number; end: number }> {
    const ends = findStatementEnds(text);
    if (ends.length === 0) {
        return [];
    }

    const lineOffsets = buildLineOffsets(text);
    const ranges: Array<{ start: number; end: number }> = [];
    // Track the character index from which to begin searching for the next statement.
    // Initialise to 0 so the very first statement is found from the document start.
    let searchFrom = 0;

    for (const endIdx of ends) {
        const last = text[endIdx] === '/' ? textEndBeforeSlash(text, endIdx) - 1 : endIdx;
        // Bounded by this statement, so a quote inside a script body cannot
        // affect the statements after it.
        const content = firstContentAt(text, searchFrom, last + 1);
        if (content > last) {
            searchFrom = endIdx + 1;
            continue;
        }
        // The statement starts on the line of its first content. Lines that
        // hold only whitespace and comments before it are skipped.
        const startLine = offsetToLine(lineOffsets, content);

        // When the statement starts on the line where the previous one ends,
        // use searchFrom rather than the line start so the range begins after
        // the previous terminator rather than at column 0 of the shared line.
        let start: number;
        if (searchFrom > lineOffsets[startLine]) {
            // Skip any whitespace between the previous semicolon and this statement.
            let ws = searchFrom;
            while (ws < last && (text[ws] === ' ' || text[ws] === '\t')) {
                ws++;
            }
            start = ws;
        } else {
            start = lineOffsets[startLine];
        }

        ranges.push({ start, end: last });
        // Next statement begins searching right after this terminator.
        searchFrom = endIdx + 1;
    }

    return ranges;
}

/**
 * Position-preserving variant of stripCommentsPreservingStrings: every comment
 * character is replaced with a space (newlines are kept verbatim) so the result
 * has the same length as the input, and an offset into the input, such as the
 * cursor, is the same offset in the result.
 *
 * String literal and quoted identifier contents are preserved as-is; only --line and slash-star
 * comments are blanked out.
 */
export function stripCommentsPreservingPositions(text: string): string {
    let state: SqlTokenState = SqlTokenState.DEFAULT;
    let quote = '';
    const out: string[] = [];
    let i = 0;
    const len = text.length;

    while (i < len) {
        const ch = text[i];
        const next = i + 1 < len ? text[i + 1] : '';

        switch (state) {
            case SqlTokenState.DEFAULT:
                if (isQuote(ch)) {
                    state = SqlTokenState.IN_QUOTED;
                    quote = ch;
                    out.push(ch);
                    i++;
                } else if (ch === '-' && next === '-') {
                    state = SqlTokenState.IN_LINE_COMMENT;
                    out.push(' ', ' ');
                    i += 2;
                } else if (ch === '/' && next === '*') {
                    state = SqlTokenState.IN_BLOCK_COMMENT;
                    out.push(' ', ' ');
                    i += 2;
                } else {
                    out.push(ch);
                    i++;
                }
                break;

            case SqlTokenState.IN_QUOTED:
                if (ch === quote && next === quote) {
                    out.push(ch, next);
                    i += 2;
                } else if (ch === quote) {
                    state = SqlTokenState.DEFAULT;
                    out.push(ch);
                    i++;
                } else {
                    out.push(ch);
                    i++;
                }
                break;

            case SqlTokenState.IN_LINE_COMMENT:
                if (ch === '\n') {
                    state = SqlTokenState.DEFAULT;
                    out.push('\n');
                } else {
                    out.push(' ');
                }
                i++;
                break;

            case SqlTokenState.IN_BLOCK_COMMENT:
                if (ch === '*' && next === '/') {
                    state = SqlTokenState.DEFAULT;
                    out.push(' ', ' ');
                    i += 2;
                } else {
                    out.push(ch === '\n' ? '\n' : ' ');
                    i++;
                }
                break;
        }
    }

    return out.join('');
}

/**
 * Exclusive end of the text that belongs to the statement closed by the `;`
 * at `semi`. Trailing comments on its line ("; -- note", "; /* note *\/")
 * stay with it, up to the end of that line; any other text after the `;`
 * starts the next statement, so the statement ends right after the `;`. A
 * block comment that does not close on the line counts as such text. Scans
 * only the gap after the `;`.
 */
function semicolonChunkEnd(text: string, semi: number): number {
    const len = text.length;
    let i = semi + 1;
    while (i < len) {
        const c = text.charCodeAt(i);
        if (c === NEWLINE) {
            return i;
        }
        if (c === DASH && text.charCodeAt(i + 1) === DASH) {
            return lineEndAt(text, i);
        }
        if (c === SLASH && text.charCodeAt(i + 1) === STAR) {
            i += 2;
            while (i < len && text.charCodeAt(i) !== NEWLINE && !(text.charCodeAt(i) === STAR && text.charCodeAt(i + 1) === SLASH)) {
                i++;
            }
            if (i >= len || text.charCodeAt(i) === NEWLINE) {
                return semi + 1;
            }
            i += 2;
        } else if (isSpaceCode(c)) {
            i++;
        } else {
            return semi + 1;
        }
    }
    return len;
}

/**
 * Offset where the statement that begins at or after `from` starts, or -1
 * when none starts on a line up to `lastLine`. Lines that are blank or hold
 * a line comment are skipped. The statement starts at the beginning of its
 * line, or on the line where the previous statement ended, at the first
 * character after it.
 */
function statementStartOffset(text: string, lineOffsets: number[], from: number, lastLine: number): number {
    for (let line = offsetToLine(lineOffsets, from); line <= lastLine; line++) {
        const lineStart = lineOffsets[line];
        const lineEnd = line + 1 < lineOffsets.length ? lineOffsets[line + 1] - 1 : text.length;
        const start = Math.max(lineStart, from);
        if (!isBlankOrCommentLine(text.slice(start, lineEnd).trim())) {
            if (start === lineStart) {
                return lineStart;
            }
            let ws = start;
            while (text[ws] === ' ' || text[ws] === '\t') {
                ws++;
            }
            return ws;
        }
    }
    return -1;
}

/**
 * Find the SQL statement at the given cursor position in a document.
 * Uses the tokenizer of findStatementEnds to detect statement boundaries so that
 * semicolons inside string literals, quoted identifiers or comments are never treated as terminators,
 * and a script or function definition is one statement (see findStatementEnds).
 *
 * Leading comment-only lines are excluded from each statement's range, so a cursor
 * on a pure comment line returns undefined. A statement that starts on the line
 * where the previous one ends starts after it, and the previous one ends at its
 * `;`. On a line with more than one statement, the cursor selects the statement
 * it is in, or the one whose `;` is right before it; after the last `;` on the
 * line, it selects the last statement on that line.
 *
 * Returns the statement text, its line range, and the offset of its first character,
 * or undefined if no statement found.
 */
export function findStatementAtCursor(
    documentText: string,
    cursorLine: number,
    cursorCharacter: number
): { text: string; range: { start: number; end: number }; startOffset: number } | undefined {
    const lineOffsets = buildLineOffsets(documentText);
    const lastLine = lineOffsets.length - 1;
    const ends = findStatementEnds(documentText);

    // `last` is the terminator line, so a cursor on a `/` line selects the statement it closes.
    // `endOffset` is the offset right after the `;`, or the end of the `/` line.
    const statements: Array<{ start: number; end: number; last: number; text: string; startOffset: number; endOffset: number }> = [];
    let from = 0;
    let previousTerminatorLine = -1;

    for (const endIdx of ends) {
        const terminatorLine = offsetToLine(lineOffsets, endIdx);
        const slash = documentText[endIdx] === '/';
        // A `/` line is not part of the statement it closes.
        const endLine = slash ? terminatorLine - 1 : terminatorLine;
        const textEnd = slash ? textEndBeforeSlash(documentText, endIdx) : semicolonChunkEnd(documentText, endIdx);

        const start = statementStartOffset(documentText, lineOffsets, from, endLine);
        const chunk = start === -1 ? '' : documentText.slice(start, textEnd);
        const trimmed = chunk.trim();
        if (trimmed && trimmed !== ';') {
            statements.push({
                start: offsetToLine(lineOffsets, start), end: endLine, last: terminatorLine, text: chunk, startOffset: start,
                endOffset: slash ? lineEndAt(documentText, endIdx) : endIdx + 1
            });
        } else if (slash) {
            // An optional `/` line after a definition closed by `;` (`END f;`)
            // selects that definition, so the cursor there never falls through
            // to running the whole file.
            const previous = statements[statements.length - 1];
            if (previous?.last === previousTerminatorLine && isScriptOrFunctionDefinition(previous.text)) {
                previous.last = terminatorLine;
                previous.endOffset = lineEndAt(documentText, endIdx);
            }
        }

        previousTerminatorLine = terminatorLine;
        from = slash ? lineEndAt(documentText, endIdx) : textEnd;
    }

    // Handle trailing statement without semicolon
    const tailStart = statementStartOffset(documentText, lineOffsets, from, lastLine);
    if (tailStart !== -1) {
        const chunk = documentText.slice(tailStart);
        if (chunk.trim()) {
            statements.push({
                start: offsetToLine(lineOffsets, tailStart), end: lastLine, last: lastLine, text: chunk, startOffset: tailStart,
                endOffset: documentText.length
            });
        }
    }

    const cursor = cursorLine <= lastLine ? lineOffsets[cursorLine] + cursorCharacter : documentText.length;
    const onLine = statements.filter(s => cursorLine >= s.start && cursorLine <= s.last);
    const statement = onLine.find(s => cursor <= s.endOffset) ?? onLine[onLine.length - 1];
    return statement && {
        text: statement.text,
        range: { start: statement.start, end: statement.end },
        startOffset: statement.startOffset
    };
}

/**
 * Strip leading blank lines and pure comment lines from a SQL chunk.
 * Used to remove decorative comment headers before a statement.
 */
function stripLeadingCommentLines(chunk: string): string {
    const lines = chunk.split('\n');
    let start = 0;
    while (start < lines.length && isBlankOrCommentLine(lines[start].trim())) {
        start++;
    }
    return lines.slice(start).join('\n');
}

/**
 * Split text into individual SQL statements at the ends found by findStatementEnds.
 * Returns an array of statement strings, trimmed and filtered for non-empty statements.
 * Uses the tokenizer of findStatementEnds so semicolons inside string literals, quoted
 * identifiers or comments are never treated as statement boundaries.
 *
 * Each returned statement includes everything up to and including its terminating
 * semicolon, and trailing comments on the line of the semicolon. A statement closed
 * by a `/` line ends before that line and keeps its trailing whitespace, so a script
 * body is sent exactly as written. Leading comment-only lines before any SQL keyword
 * are excluded.
 *
 * @param text The SQL text to split
 * @returns Array of individual SQL statements
 */
export function splitIntoStatements(text: string): string[] {
    const ends = findStatementEnds(text);
    const statements: string[] = [];
    let pos = 0;

    for (const endIdx of ends) {
        if (text[endIdx] === '/') {
            // Closed by a `/` line: send the text before it, the body unchanged.
            const chunk = stripLeadingCommentLines(text.slice(pos, textEndBeforeSlash(text, endIdx))).trimStart();
            pos = lineEndAt(text, endIdx);
            if (chunk) {
                statements.push(chunk);
            }
            continue;
        }

        const chunkEnd = semicolonChunkEnd(text, endIdx);
        const chunk = stripLeadingCommentLines(text.slice(pos, chunkEnd)).trim();
        pos = chunkEnd;
        if (chunk && chunk !== ';') {
            statements.push(chunk);
        }
    }

    // Handle remaining text after the last semicolon (statement without trailing semicolon)
    const tail = stripLeadingCommentLines(text.slice(pos)).trim();
    if (tail) {
        statements.push(tail);
    }

    return statements;
}
