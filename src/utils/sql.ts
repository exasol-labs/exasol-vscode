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

// ---------------------------------------------------------------------------
// State-machine SQL tokenizer
// ---------------------------------------------------------------------------

/**
 * Parser states for the SQL tokenizer.
 * Numeric enum so TypeScript emits the values at runtime (needed for switch).
 */
const enum SqlTokenState {
    DEFAULT = 0,
    IN_STRING = 1,
    IN_LINE_COMMENT = 2,
    IN_BLOCK_COMMENT = 3
}

/**
 * Strip SQL comments while preserving string literal contents.
 * Uses an O(n) single-pass state-machine that tracks:
 *   - Single-quoted string literals (Exasol uses '' to escape a quote inside)
 *   - Single-line comments (-- to end of line)
 *   - Block comments (slash-star to star-slash, non-nesting)
 *
 * @param text The SQL text whose comments should be stripped
 * @returns Text with all comments removed, preserving newlines for line fidelity
 */
export function stripCommentsPreservingStrings(text: string): string {
    let state: SqlTokenState = SqlTokenState.DEFAULT;
    let result = '';
    let i = 0;
    const len = text.length;

    while (i < len) {
        const ch = text[i];
        const next = i + 1 < len ? text[i + 1] : '';

        switch (state) {
            case SqlTokenState.DEFAULT:
                if (ch === "'") {
                    state = SqlTokenState.IN_STRING;
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

            case SqlTokenState.IN_STRING:
                if (ch === "'" && next === "'") {
                    result += "''";
                    i += 2;
                } else if (ch === "'") {
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

/**
 * Return the character indices of statement-terminating semicolons: those at
 * the top level, not inside string literals or comments.
 * O(n) single-pass via the state-machine tokenizer.
 *
 * @param text The SQL text to scan
 * @returns Array of indices where top-level semicolons appear
 */
export function findStatementEnds(text: string): number[] {
    let state: SqlTokenState = SqlTokenState.DEFAULT;
    const ends: number[] = [];
    let i = 0;
    const len = text.length;

    while (i < len) {
        const ch = text[i];
        const next = i + 1 < len ? text[i + 1] : '';

        switch (state) {
            case SqlTokenState.DEFAULT:
                if (ch === "'") {
                    state = SqlTokenState.IN_STRING;
                    i++;
                } else if (ch === '-' && next === '-') {
                    state = SqlTokenState.IN_LINE_COMMENT;
                    i += 2;
                } else if (ch === '/' && next === '*') {
                    state = SqlTokenState.IN_BLOCK_COMMENT;
                    i += 2;
                } else if (ch === ';') {
                    ends.push(i);
                    i++;
                } else {
                    i++;
                }
                break;

            case SqlTokenState.IN_STRING:
                if (ch === "'" && next === "'") {
                    i += 2;
                } else if (ch === "'") {
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
 * inside string literals or comments are never treated as boundaries.
 *
 * Each returned range spans from the first non-whitespace character of the
 * statement to the semicolon (inclusive). Statements with no trailing semicolon
 * are NOT included (use splitIntoStatements for those).
 *
 * @param text The SQL text to scan
 * @returns Array of {start, end} character index pairs (end = semicolon index)
 */
export function findStatementRanges(text: string): Array<{ start: number; end: number }> {
    const ends = findStatementEnds(text);
    if (ends.length === 0) {
        return [];
    }

    const lineOffsets = buildLineOffsets(text);
    // Build a position-preserving stripped view so character offsets line up with
    // the original text and can be indexed via lineOffsets. Comment characters
    // are replaced by spaces (newlines preserved verbatim) so each line's
    // substring in stripPP matches its original line in length and newline layout.
    const stripPP = stripCommentsPreservingPositions(text);
    const ranges: Array<{ start: number; end: number }> = [];
    // Track the character index from which to begin searching for the next statement.
    // Initialise to 0 so the very first statement is found from the document start.
    let searchFrom = 0;

    for (const semiIdx of ends) {
        const endLine = offsetToLine(lineOffsets, semiIdx);

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
            const lineEnd = startLine + 1 < lineOffsets.length ? lineOffsets[startLine + 1] - 1 : text.length;
            const effectiveStart = Math.max(lineStart, searchFrom);
            if (effectiveStart < lineEnd && stripPP.slice(effectiveStart, lineEnd).trim() !== '') {
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
            while (ws < semiIdx && (text[ws] === ' ' || text[ws] === '\t')) {
                ws++;
            }
            start = ws;
        } else {
            start = lineOffsets[startLine];
        }

        ranges.push({ start, end: semiIdx });
        // Next statement begins searching right after this semicolon.
        searchFrom = semiIdx + 1;
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
 * String literal contents are preserved as-is; only --line and slash-star
 * comments are blanked out. This is intentionally not exported: callers should
 * use stripCommentsPreservingStrings for general comment removal, since that
 * variant is shorter and easier to reason about when offsets do not matter.
 */
function stripCommentsPreservingPositions(text: string): string {
    let state: SqlTokenState = SqlTokenState.DEFAULT;
    const out: string[] = [];
    let i = 0;
    const len = text.length;

    while (i < len) {
        const ch = text[i];
        const next = i + 1 < len ? text[i + 1] : '';

        switch (state) {
            case SqlTokenState.DEFAULT:
                if (ch === "'") {
                    state = SqlTokenState.IN_STRING;
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

            case SqlTokenState.IN_STRING:
                if (ch === "'" && next === "'") {
                    out.push("'", "'");
                    i += 2;
                } else if (ch === "'") {
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
 * semicolons inside string literals or comments are never treated as terminators.
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

    const statements: Array<{ start: number; end: number; text: string }> = [];
    let consumedThroughLine = -1;

    for (const semiIdx of ends) {
        const semiLine = offsetToLine(lineStartOffsets, semiIdx);

        let startLine = consumedThroughLine + 1;
        while (startLine <= semiLine && isBlankOrCommentLine(lines[startLine].trim())) {
            startLine++;
        }

        const endLine = semiLine;

        if (startLine <= endLine) {
            const chunk = lines.slice(startLine, endLine + 1).join('\n');
            const trimmed = chunk.trim();
            if (trimmed && trimmed !== ';') {
                statements.push({ start: startLine, end: endLine, text: chunk });
            }
        }

        consumedThroughLine = semiLine;
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
            statements.push({ start: tailStart, end: endLine, text: chunk });
        }
    }

    for (const statement of statements) {
        if (cursorLine >= statement.start && cursorLine <= statement.end) {
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
 * Split text into individual SQL statements based on semicolon delimiters.
 * Returns an array of statement strings, trimmed and filtered for non-empty statements.
 * Uses the state-machine tokenizer so semicolons inside string literals or comments
 * are never treated as statement boundaries.
 *
 * Each returned statement includes everything up to and including its terminating
 * semicolon. Leading comment-only lines before any SQL keyword are excluded.
 *
 * @param text The SQL text to split
 * @returns Array of individual SQL statements
 */
export function splitIntoStatements(text: string): string[] {
    const ends = findStatementEnds(text);
    const statements: string[] = [];
    let pos = 0;

    for (let ei = 0; ei < ends.length; ei++) {
        const semiIdx = ends[ei];

        // Determine the end of the chunk for this statement.
        // If there's another semicolon on the same line, end the chunk right after
        // the current semicolon; there's more SQL following on the same line.
        // Otherwise, include to end of line so trailing inline comments ("; -- note")
        // are kept as part of the statement text.
        const nextSemiIdx = ei + 1 < ends.length ? ends[ei + 1] : -1;

        // Find the end of the current line (first '\n' or end of text)
        let lineEnd = semiIdx + 1;
        while (lineEnd < text.length && text[lineEnd] !== '\n') {
            lineEnd++;
        }

        let chunkEnd: number;
        if (nextSemiIdx !== -1 && nextSemiIdx < lineEnd) {
            // Another statement starts before the end of this line; don't include trailing content
            chunkEnd = semiIdx + 1;
        } else {
            // Include to end of line (captures trailing inline comments)
            chunkEnd = lineEnd;
        }

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
