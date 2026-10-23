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

/** Function body progress while scanning a CREATE FUNCTION statement. */
const enum FunctionBody {
    NONE = 0,
    OPEN = 1,
    CLOSED = 2
}

function isWordChar(ch: string): boolean {
    return /[A-Za-z0-9_]/.test(ch);
}

/** Index of the `\n` that ends the line containing `from`, or the text length. */
function lineEndAt(text: string, from: number): number {
    const nl = text.indexOf('\n', from);
    return nl === -1 ? text.length : nl;
}

/**
 * If the line starting at `lineStart` holds only `/` (with optional
 * whitespace), return the index of the `/`; otherwise -1. This is the
 * terminator the Exasol SQL clients use for script and function definitions.
 */
function slashLineAt(text: string, lineStart: number): number {
    const line = text.slice(lineStart, lineEndAt(text, lineStart));
    return /^\s*\/\s*$/.test(line) ? lineStart + line.indexOf('/') : -1;
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
        if (/\s/.test(text[i])) {
            i++;
        } else if (text.startsWith('--', i)) {
            i = lineEndAt(text, i);
        } else if (text.startsWith('/*', i)) {
            const close = text.indexOf('*/', i + 2);
            i = close === -1 ? text.length : close + 2;
        } else if (isWordChar(text[i])) {
            const start = i;
            while (i < text.length && isWordChar(text[i])) {
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
 * line break that precedes it). O(n) single pass.
 *
 * Semicolons inside string literals, quoted identifiers and comments are
 * ignored. Exasol script and function definitions follow the convention of
 * the Exasol SQL clients:
 *   - `CREATE ... SCRIPT` runs until a `/` line, or to the end of the text.
 *     The body is code in another language, so it is not tokenized as SQL.
 *   - `CREATE ... FUNCTION` ends at a `/` line, or at the first `;` after the
 *     `END [name]` that closes the body. Semicolons inside the body, and the
 *     `END` of `IF`, `FOR`, `WHILE` and `CASE`, do not end it.
 * A `/` line between statements ends an empty statement; everywhere else
 * (for example a division inside a SELECT) it is ordinary text.
 *
 * @param text The SQL text to scan
 * @returns Array of indices where statements end
 */
export function findStatementEnds(text: string): number[] {
    let state: SqlTokenState = SqlTokenState.DEFAULT;
    let quote = '';
    const ends: number[] = [];
    let i = 0;
    const len = text.length;
    let statementEmpty = true;
    let functionBody: FunctionBody = FunctionBody.NONE;
    let caseDepth = 0;

    while (i < len) {
        const ch = text[i];
        const next = i + 1 < len ? text[i + 1] : '';

        switch (state) {
            case SqlTokenState.DEFAULT: {
                const slash = (i === 0 || text[i - 1] === '\n') && (statementEmpty || functionBody !== FunctionBody.NONE)
                    ? slashLineAt(text, i)
                    : -1;
                if (slash !== -1) {
                    ends.push(slash);
                    i = lineEndAt(text, i);
                    statementEmpty = true;
                    functionBody = FunctionBody.NONE;
                } else if (isQuote(ch)) {
                    // The content of a string or quoted identifier is never a keyword, so it cannot close a function body.
                    state = SqlTokenState.IN_QUOTED;
                    quote = ch;
                    statementEmpty = false;
                    i++;
                } else if (ch === '-' && next === '-') {
                    state = SqlTokenState.IN_LINE_COMMENT;
                    i += 2;
                } else if (ch === '/' && next === '*') {
                    state = SqlTokenState.IN_BLOCK_COMMENT;
                    i += 2;
                } else if (ch === ';') {
                    if (functionBody !== FunctionBody.OPEN) {
                        ends.push(i);
                        statementEmpty = true;
                        functionBody = FunctionBody.NONE;
                    }
                    i++;
                } else if (isWordChar(ch)) {
                    const start = i;
                    while (i < len && isWordChar(text[i])) {
                        i++;
                    }
                    if (statementEmpty) {
                        statementEmpty = false;
                        const kind = definitionKind(readWords(text, start, 6));
                        if (kind === 'script') {
                            // The body is not SQL: skip it line by line up to the next `/` line.
                            let lineStart = lineEndAt(text, start) + 1;
                            let end = -1;
                            while (lineStart < len && (end = slashLineAt(text, lineStart)) === -1) {
                                lineStart = lineEndAt(text, lineStart) + 1;
                            }
                            if (end === -1) {
                                i = len;
                            } else {
                                ends.push(end);
                                i = lineEndAt(text, end);
                                statementEmpty = true;
                            }
                        } else if (kind === 'function') {
                            functionBody = FunctionBody.OPEN;
                            caseDepth = 0;
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
                    if (!/\s/.test(ch)) {
                        statementEmpty = false;
                    }
                    i++;
                }
                break;
            }

            case SqlTokenState.IN_QUOTED:
                if (ch === quote && next === quote) {
                    i += 2;
                } else if (ch === quote) {
                    state = SqlTokenState.DEFAULT;
                    i++;
                } else {
                    i++;
                }
                break;

            case SqlTokenState.IN_LINE_COMMENT:
                if (ch === '\n') {
                    state = SqlTokenState.DEFAULT;
                }
                i++;
                break;

            case SqlTokenState.IN_BLOCK_COMMENT:
                if (ch === '*' && next === '/') {
                    state = SqlTokenState.DEFAULT;
                    i += 2;
                } else {
                    i++;
                }
                break;
        }
    }

    return ends;
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
 * Build an array of character offsets at which each line begins.
 * Internal helper used by findStatementAtCursor (takes pre-split lines).
 */
function buildLineStartOffsets(lines: string[]): number[] {
    const offsets: number[] = [];
    let offset = 0;
    for (const line of lines) {
        offsets.push(offset);
        offset += line.length + 1;
    }
    return offsets;
}

/**
 * Binary search: return the 0-based line number for a character offset,
 * given a lineOffsets table produced by buildLineOffsets or buildLineStartOffsets.
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
 * Return the character-index ranges of every SQL statement in text.
 * Uses the same state-machine tokenizer as findStatementEnds, so semicolons
 * inside string literals, quoted identifiers or comments are never treated as boundaries.
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
        // Position-preserving stripped view of this statement only, so a quote
        // inside a script body cannot affect the statements after it. Comment
        // characters are replaced by spaces (newlines preserved verbatim).
        const stripped = stripCommentsPreservingPositions(text.slice(searchFrom, last + 1));
        if (stripped.trim() === '') {
            searchFrom = endIdx + 1;
            continue;
        }
        const endLine = offsetToLine(lineOffsets, last);

        // Find the line that this search window starts on.
        const searchFromLine = offsetToLine(lineOffsets, searchFrom);

        // Walk forward from searchFromLine, skipping lines that are blank or
        // consist entirely of comments. The first line considered may share a
        // line with the previous statement's terminator; only the portion AFTER
        // searchFrom belongs to the upcoming statement, so clamp the slice to
        // start at max(lineStart, searchFrom).
        let startLine = searchFromLine;
        while (startLine < endLine) {
            const lineStart = lineOffsets[startLine];
            const lineEnd = lineOffsets[startLine + 1] - 1;
            const effectiveStart = Math.max(lineStart, searchFrom);
            if (effectiveStart < lineEnd && stripped.slice(effectiveStart - searchFrom, lineEnd - searchFrom).trim() !== '') {
                break;
            }
            startLine++;
        }

        // When the start and end lines coincide (e.g. two statements on one line,
        // or all leading content was consumed by the prev semicolon on the same
        // line), use searchFrom rather than the line start so the range begins
        // after the previous terminator rather than at column 0 of the shared line.
        let start: number;
        if (startLine === endLine && searchFrom > lineOffsets[startLine]) {
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
 * has the same length as the input. Used internally by findStatementRanges so
 * that lineOffsets computed from the original text remain valid indices into
 * the stripped view.
 *
 * String literal and quoted identifier contents are preserved as-is; only --line and slash-star
 * comments are blanked out. This is intentionally not exported: callers should
 * use stripCommentsPreservingStrings for general comment removal, since that
 * variant is shorter and easier to reason about when offsets do not matter.
 */
function stripCommentsPreservingPositions(text: string): string {
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
 * Find the SQL statement at the given cursor position in a document.
 * Uses the state-machine tokenizer to detect statement boundaries so that
 * semicolons inside string literals, quoted identifiers or comments are never treated as terminators,
 * and a script or function definition is one statement (see findStatementEnds).
 *
 * Leading comment-only lines are excluded from each statement's range, so a cursor
 * on a pure comment line returns undefined.
 *
 * Returns the statement text and its range, or undefined if no statement found.
 */
export function findStatementAtCursor(
    documentText: string,
    cursorLine: number
): { text: string; range: { start: number; end: number }; startOffset: number } | undefined {
    const lines = documentText.split('\n');
    const lineStartOffsets = buildLineStartOffsets(lines);
    const ends = findStatementEnds(documentText);

    // `last` is the terminator line, so a cursor on a `/` line selects the statement it closes.
    const statements: Array<{ start: number; end: number; last: number; text: string }> = [];
    let consumedThroughLine = -1;

    for (const endIdx of ends) {
        const terminatorLine = offsetToLine(lineStartOffsets, endIdx);
        // A `/` line is not part of the statement it closes.
        const endLine = documentText[endIdx] === '/' ? terminatorLine - 1 : terminatorLine;

        let startLine = consumedThroughLine + 1;
        while (startLine <= endLine && isBlankOrCommentLine(lines[startLine].trim())) {
            startLine++;
        }

        if (startLine <= endLine) {
            const chunk = lines.slice(startLine, endLine + 1).join('\n');
            const trimmed = chunk.trim();
            if (trimmed && trimmed !== ';') {
                statements.push({ start: startLine, end: endLine, last: terminatorLine, text: chunk });
            }
        } else if (documentText[endIdx] === '/') {
            // An optional `/` line after a definition closed by `;` (`END f;`)
            // selects that definition, so the cursor there never falls through
            // to running the whole file.
            const previous = statements[statements.length - 1];
            if (previous?.last === consumedThroughLine && isScriptOrFunctionDefinition(previous.text)) {
                previous.last = terminatorLine;
            }
        }

        consumedThroughLine = terminatorLine;
    }

    // Handle trailing statement without semicolon
    let tailStart = consumedThroughLine + 1;
    while (tailStart < lines.length && isBlankOrCommentLine(lines[tailStart].trim())) {
        tailStart++;
    }
    if (tailStart < lines.length) {
        const endLine = lines.length - 1;
        const chunk = lines.slice(tailStart, endLine + 1).join('\n');
        const trimmed = chunk.trim();
        if (trimmed) {
            statements.push({ start: tailStart, end: endLine, last: endLine, text: chunk });
        }
    }

    for (const statement of statements) {
        if (cursorLine >= statement.start && cursorLine <= statement.last) {
            return {
                text: statement.text,
                range: { start: statement.start, end: statement.end },
                startOffset: lineStartOffsets[statement.start] ?? 0
            };
        }
    }

    return undefined;
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
 * Uses the state-machine tokenizer so semicolons inside string literals, quoted
 * identifiers or comments are never treated as statement boundaries.
 *
 * Each returned statement includes everything up to and including its terminating
 * semicolon. A statement closed by a `/` line ends before that line and keeps its
 * trailing whitespace, so a script body is sent exactly as written. Leading
 * comment-only lines before any SQL keyword are excluded.
 *
 * @param text The SQL text to split
 * @returns Array of individual SQL statements
 */
/**
 * True when `line` holds only whitespace and comments, and every block comment
 * in it closes on the same line. The `x` after a line break survives a line
 * comment but not an unclosed block comment.
 */
function holdsOnlyClosedComments(line: string): boolean {
    return stripCommentsPreservingStrings(`${line}\nx`).trim() === 'x';
}

export function splitIntoStatements(text: string): string[] {
    const ends = findStatementEnds(text);
    const statements: string[] = [];
    let pos = 0;

    for (const semiIdx of ends) {

        if (text[semiIdx] === '/') {
            // Closed by a `/` line: send the text before it, the body unchanged.
            const chunk = stripLeadingCommentLines(text.slice(pos, textEndBeforeSlash(text, semiIdx))).trimStart();
            pos = lineEndAt(text, semiIdx);
            if (chunk) {
                statements.push(chunk);
            }
            continue;
        }

        // Keep trailing comments on the line of the semicolon ("; -- note",
        // "; /* note */") with its statement. Any other text after the
        // semicolon starts the next statement, which may end on a later line.
        const lineEnd = lineEndAt(text, semiIdx);
        const chunkEnd = holdsOnlyClosedComments(text.slice(semiIdx + 1, lineEnd)) ? lineEnd : semiIdx + 1;

        const raw = text.slice(pos, chunkEnd);
        pos = chunkEnd;

        const chunk = stripLeadingCommentLines(raw).trim();
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
