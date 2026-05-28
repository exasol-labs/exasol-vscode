/**
 * Parse column aliases from the SELECT list of a single SQL statement.
 * Used by completion of `LOCAL.<alias>` (Exasol-specific): inside WHERE/HAVING/
 * QUALIFY/GROUP BY, `LOCAL.foo` references an alias defined in the same
 * statement's SELECT list.
 *
 * Supported alias forms:
 *   expr AS alias          -> alias
 *   expr AS "Quoted"       -> Quoted (quotes stripped)
 *   table.column           -> column (Exasol resolves LOCAL.column for this)
 *   bare_column            -> bare_column
 *
 * Intentionally NOT supported (false-positive prone, omitted by design):
 *   expr alias             (bare alias without AS)
 *
 * Skipped entries: `*`, `table.*`.
 *
 * Nested subquery aliases never leak out: items are split at top-level commas
 * only, respecting paren depth and string/identifier quoting.
 */

import { stripCommentsPreservingStrings } from './sql';

export interface SelectAlias {
    /** Alias name as written (unquoted form of the identifier). */
    name: string;
    /** True when the source token was `"quoted"` (forces requoting on insert). */
    quoted: boolean;
}

/**
 * Locate the SELECT-list substring of the statement: from the first top-level
 * SELECT keyword to the matching top-level FROM, or to end of statement when
 * no FROM exists (e.g. `SELECT 1 AS one`).
 *
 * Returns undefined when no SELECT is found at paren depth 0.
 */
export function extractSelectListText(statementText: string): string | undefined {
    const text = stripCommentsPreservingStrings(statementText);
    const upper = text.toUpperCase();
    const selectStart = findKeywordAt(upper, text, 'SELECT', 0, 0);
    if (selectStart < 0) { return undefined; }
    const listStart = selectStart + 'SELECT'.length;
    const fromIdx = findKeywordAt(upper, text, 'FROM', listStart, 0);
    const listEnd = fromIdx < 0 ? text.length : fromIdx;
    return text.slice(listStart, listEnd);
}

/**
 * Extract SELECT-list aliases from a statement. Returns aliases in the order
 * they appear in the SELECT list, de-duplicated (case-insensitive on the
 * normalized identifier form).
 */
export function parseSelectListAliases(statementText: string): SelectAlias[] {
    return aliasesFromListText(extractSelectListText(statementText));
}

/**
 * Locate the SELECT-list substring of the SELECT clause that lexically encloses
 * `cursorOffsetInStatement`. Used to resolve `LOCAL.<alias>` from inside a
 * CTE body, a derived-table subquery, or any other nested SELECT, where the
 * outermost SELECT is not the relevant one.
 *
 * Algorithm: scan forward through the comment-stripped statement to enumerate
 * top-level paren matches and the position+scope of every SELECT keyword.
 * Then walk backward from the cursor: skip closed paren ranges (they are out
 * of scope), and return the first SELECT encountered. From that SELECT, the
 * SELECT-list ends at the first FROM at the same paren depth, or at the
 * enclosing scope's closing paren / end of statement.
 *
 * Returns undefined when no enclosing SELECT is found.
 */
export function findEnclosingSelectListText(
    statementText: string,
    cursorOffsetInStatement: number
): string | undefined {
    const text = stripCommentsPreservingStrings(statementText);
    const upper = text.toUpperCase();
    const cursor = clamp(cursorOffsetInStatement, 0, text.length);

    const scan = scanParens(text);
    const selects = findSelectPositions(text, upper);

    const enclosingSelect = findEnclosingSelectIdx(selects, scan, cursor);
    if (enclosingSelect < 0) { return undefined; }

    const selectStart = selects[enclosingSelect].pos;
    const listStart = selectStart + 'SELECT'.length;

    // Scope ends at the close-paren of the innermost enclosing open-paren, or
    // at end of text when SELECT is at depth 0.
    const scopeEnd = scopeEndFor(scan, selectStart, selects[enclosingSelect].depth);

    // Find the matching FROM at the SELECT's depth, bounded by scopeEnd so we
    // never spill into a sibling subquery via paren-imbalance walks.
    const searchEnd = Math.min(text.length, scopeEnd);
    const fromIdx = findKeywordWithin(upper, text, 'FROM', listStart, searchEnd);
    let listEnd = fromIdx < 0 ? searchEnd : fromIdx;
    if (listEnd < listStart) { listEnd = listStart; }
    return text.slice(listStart, listEnd);
}

/**
 * Convenience: combine findEnclosingSelectListText with comma-splitting and
 * per-item alias extraction. Mirrors parseSelectListAliases' return shape.
 */
export function parseEnclosingSelectListAliases(
    statementText: string,
    cursorOffsetInStatement: number
): SelectAlias[] {
    return aliasesFromListText(findEnclosingSelectListText(statementText, cursorOffsetInStatement));
}

export interface EnclosingSelectRange {
    /** Offset (into the comment-stripped statement) of the SELECT keyword. */
    selectStart: number;
    /** Offset just past the SELECT keyword (start of SELECT-list text). */
    listStart: number;
    /** Offset of the matching FROM keyword, or -1 when this SELECT has no FROM. */
    fromIdx: number;
    /** Scope end (exclusive); end-of-text when SELECT is at paren depth 0. */
    scopeEnd: number;
    /** Paren depth at which the SELECT lives. */
    depth: number;
    /** Comment-stripped statement text. Offsets above index into this. */
    text: string;
}

/**
 * Locate the full lexical range of the SELECT clause enclosing
 * `cursorOffsetInStatement`. Returns undefined when no enclosing SELECT exists.
 *
 * Offsets are into the comment-stripped view (`text`); callers should also
 * translate their cursor through stripCommentsPreservingStrings if they need
 * to compare. In practice, stripping replaces comments with whitespace so the
 * cursor offset is identical between raw and stripped views; this matches the
 * function's contract elsewhere.
 */
export function findEnclosingSelectRange(
    statementText: string,
    cursorOffsetInStatement: number
): EnclosingSelectRange | undefined {
    const text = stripCommentsPreservingStrings(statementText);
    const upper = text.toUpperCase();
    const cursor = clamp(cursorOffsetInStatement, 0, text.length);

    const scan = scanParens(text);
    const selects = findSelectPositions(text, upper);

    const enclosingSelect = findEnclosingSelectIdx(selects, scan, cursor);
    if (enclosingSelect < 0) { return undefined; }

    const s = selects[enclosingSelect];
    const listStart = s.pos + 'SELECT'.length;
    const scopeEnd = scopeEndFor(scan, s.pos, s.depth);
    const searchEnd = Math.min(text.length, scopeEnd);
    const fromIdx = findKeywordWithin(upper, text, 'FROM', listStart, searchEnd);
    return {
        selectStart: s.pos,
        listStart,
        fromIdx,
        scopeEnd: searchEnd,
        depth: s.depth,
        text
    };
}

function aliasesFromListText(list: string | undefined): SelectAlias[] {
    if (list === undefined) { return []; }
    const items = splitTopLevelCommas(list);
    const out: SelectAlias[] = [];
    const seen = new Set<string>();
    for (const raw of items) {
        const item = raw.trim();
        if (!item) { continue; }
        const alias = extractAliasFromItem(item);
        if (!alias) { continue; }
        const key = alias.name.toUpperCase();
        if (seen.has(key)) { continue; }
        seen.add(key);
        out.push(alias);
    }
    return out;
}

function clamp(n: number, lo: number, hi: number): number {
    if (n < lo) { return lo; }
    if (n > hi) { return hi; }
    return n;
}

interface ParenScan {
    /** For each `(` index in `opens`, matching `)` index (or text.length when unmatched). */
    closeOf: Map<number, number>;
    /** For each `)` index, the matching `(` index (or -1 when unmatched). */
    openOf: Map<number, number>;
}

/**
 * Forward scan over (already comment-stripped) text producing open->close and
 * close->open paren maps, respecting single-quoted strings and double-quoted
 * identifiers. Unmatched opens map to text.length; unmatched closes map to -1.
 */
function scanParens(text: string): ParenScan {
    const closeOf = new Map<number, number>();
    const openOf = new Map<number, number>();
    const stack: number[] = [];
    const len = text.length;
    let i = 0;
    while (i < len) {
        const ch = text[i];
        if (ch === "'") { i = skipSingleQuoted(text, i); continue; }
        if (ch === '"') { i = skipDoubleQuoted(text, i); continue; }
        if (ch === '(') { stack.push(i); i++; continue; }
        if (ch === ')') {
            const open = stack.pop();
            if (open !== undefined) {
                closeOf.set(open, i);
                openOf.set(i, open);
            } else {
                openOf.set(i, -1);
            }
            i++;
            continue;
        }
        i++;
    }
    for (const open of stack) { closeOf.set(open, len); }
    return { closeOf, openOf };
}

interface SelectPos { pos: number; depth: number; }

/** Forward scan recording every top-level/nested SELECT keyword with its paren depth. */
function findSelectPositions(text: string, upper: string): SelectPos[] {
    const out: SelectPos[] = [];
    const len = text.length;
    let depth = 0;
    let i = 0;
    while (i < len) {
        const ch = text[i];
        if (ch === "'") { i = skipSingleQuoted(text, i); continue; }
        if (ch === '"') { i = skipDoubleQuoted(text, i); continue; }
        if (ch === '(') { depth++; i++; continue; }
        if (ch === ')') { if (depth > 0) { depth--; } i++; continue; }
        if (matchesKeywordAt(upper, 'SELECT', i)) {
            out.push({ pos: i, depth });
            i += 'SELECT'.length;
            continue;
        }
        i++;
    }
    return out;
}

/**
 * Walk backward from cursor selecting the most recent SELECT whose position is
 * reachable without re-entering a closed paren range. Returns the index into
 * `selects`, or -1.
 */
function findEnclosingSelectIdx(selects: SelectPos[], scan: ParenScan, cursor: number): number {
    // Candidates: SELECTs before cursor that are not nested in a paren which
    // was already closed before the cursor.
    let bestIdx = -1;
    for (let i = selects.length - 1; i >= 0; i--) {
        const s = selects[i];
        if (s.pos >= cursor) { continue; }
        if (selectIsReachable(s, scan, cursor)) {
            bestIdx = i;
            break;
        }
    }
    return bestIdx;
}

/**
 * A SELECT at `s.pos` is reachable from `cursor` (i.e., the cursor lies within
 * its lexical scope) when, for each paren open enclosing the SELECT that has a
 * matching close, that close is at or after the cursor. Equivalently: the
 * SELECT's depth at every prefix it sits at remains <= the depth at cursor for
 * the enclosing scope of the SELECT.
 *
 * We compute it directly: depth at SELECT must equal depth at cursor (or the
 * cursor must still be in the same enclosing paren). We check by walking up
 * from the SELECT's enclosing open-paren (if any) and verifying its close is
 * at or after cursor.
 */
function selectIsReachable(s: SelectPos, scan: ParenScan, cursor: number): boolean {
    // The SELECT is reachable iff no `)` that closes a scope opened at or after
    // the SELECT's enclosing scope occurs between s.pos and cursor.
    // We test by finding any close-paren in (s.pos, cursor) whose matching
    // open is at < s.pos and inside an outer scope, which would mean the
    // SELECT's scope was closed before cursor.
    // Simpler: walk closes in (s.pos, cursor); if any close's matching open
    // index is < s.pos, that scope wraps the SELECT and closes before cursor,
    // so the SELECT is OUT of scope.
    for (const [closeIdx, openIdx] of scan.openOf) {
        if (closeIdx <= s.pos || closeIdx >= cursor) { continue; }
        if (openIdx < s.pos) { return false; }
    }
    return true;
}

/**
 * Return the end (exclusive) of the lexical scope containing a SELECT at
 * `selectStart` with paren-depth `selectDepth`. If selectDepth is 0 the scope
 * is the entire text. Otherwise it is bounded by the close of the innermost
 * open-paren strictly before `selectStart` that has not yet closed at
 * `selectStart`.
 */
function scopeEndFor(scan: ParenScan, selectStart: number, selectDepth: number): number {
    if (selectDepth === 0) { return Number.MAX_SAFE_INTEGER; }
    // Find the innermost enclosing open paren: largest open index < selectStart
    // whose matching close index > selectStart.
    let bestOpen = -1;
    for (const [open, close] of scan.closeOf) {
        if (open < selectStart && close > selectStart && open > bestOpen) {
            bestOpen = open;
        }
    }
    if (bestOpen < 0) { return Number.MAX_SAFE_INTEGER; }
    return scan.closeOf.get(bestOpen) ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Find the offset of a keyword in `upper` (the uppercased view of `original`)
 * at exact paren-depth `wantedDepth`, starting at `from`. Respects single-
 * quoted strings and double-quoted identifiers. Matches only on word boundaries.
 * Returns -1 if not found.
 */
function findKeywordAt(upper: string, original: string, kw: string, from: number, wantedDepth: number): number {
    const len = upper.length;
    let i = from;
    let depth = 0;
    while (i < len) {
        const ch = original[i];
        if (ch === "'") { i = skipSingleQuoted(original, i); continue; }
        if (ch === '"') { i = skipDoubleQuoted(original, i); continue; }
        if (ch === '(') { depth++; i++; continue; }
        if (ch === ')') { depth--; i++; continue; }
        if (depth === wantedDepth && matchesKeywordAt(upper, kw, i)) {
            return i;
        }
        i++;
    }
    return -1;
}

/**
 * Find the offset of `kw` in `[from, end)` at the SAME paren depth as `from`.
 * `from` is assumed to be outside any string/comment. Returns -1 when missing.
 */
function findKeywordWithin(upper: string, original: string, kw: string, from: number, end: number): number {
    const limit = Math.min(upper.length, end);
    let i = from;
    let depth = 0;
    while (i < limit) {
        const ch = original[i];
        if (ch === "'") { i = skipSingleQuoted(original, i); continue; }
        if (ch === '"') { i = skipDoubleQuoted(original, i); continue; }
        if (ch === '(') { depth++; i++; continue; }
        if (ch === ')') { if (depth > 0) { depth--; } else { return -1; } i++; continue; }
        if (depth === 0 && matchesKeywordAt(upper, kw, i)) { return i; }
        i++;
    }
    return -1;
}

function matchesKeywordAt(upper: string, kw: string, i: number): boolean {
    if (upper.substring(i, i + kw.length) !== kw) { return false; }
    if (i > 0 && isIdentChar(upper[i - 1])) { return false; }
    const after = upper[i + kw.length];
    if (after !== undefined && isIdentChar(after)) { return false; }
    return true;
}

function isIdentChar(ch: string | undefined): boolean {
    if (!ch) { return false; }
    return /[A-Za-z0-9_]/.test(ch);
}

function skipSingleQuoted(text: string, i: number): number {
    const len = text.length;
    i++;
    while (i < len) {
        if (text[i] === "'" && text[i + 1] === "'") { i += 2; continue; }
        if (text[i] === "'") { return i + 1; }
        i++;
    }
    return len;
}

function skipDoubleQuoted(text: string, i: number): number {
    const len = text.length;
    i++;
    while (i < len) {
        if (text[i] === '"' && text[i + 1] === '"') { i += 2; continue; }
        if (text[i] === '"') { return i + 1; }
        i++;
    }
    return len;
}

/** Split text by commas at paren-depth 0, respecting quoting. */
function splitTopLevelCommas(text: string): string[] {
    const parts: string[] = [];
    const len = text.length;
    let depth = 0;
    let start = 0;
    let i = 0;
    while (i < len) {
        const ch = text[i];
        if (ch === "'") { i = skipSingleQuoted(text, i); continue; }
        if (ch === '"') { i = skipDoubleQuoted(text, i); continue; }
        if (ch === '(') { depth++; i++; continue; }
        if (ch === ')') { depth--; i++; continue; }
        if (ch === ',' && depth === 0) {
            parts.push(text.slice(start, i));
            start = i + 1;
        }
        i++;
    }
    if (start <= len) { parts.push(text.slice(start, len)); }
    return parts;
}

/**
 * Extract the alias from one SELECT-list item.
 *
 * Strategy:
 *   1. Skip `*` or `table.*` (no alias).
 *   2. Look for a top-level `AS <ident>` near the tail; if found, that's the alias.
 *   3. Else, if the item is a simple `[table.]column` reference (the trailing
 *      token is a bare identifier and what precedes it is empty, a dot, or a
 *      qualifier), use the trailing identifier as the alias.
 *   4. Else give up (covers expressions without explicit AS; intentionally
 *      ignored to avoid false positives).
 */
function extractAliasFromItem(item: string): SelectAlias | undefined {
    const trimmed = item.replace(/\s+$/, '');
    if (!trimmed) { return undefined; }
    if (trimmed === '*' || /(^|[\s.])\*$/.test(trimmed)) { return undefined; }

    const asAlias = extractAsAlias(trimmed);
    if (asAlias) { return asAlias; }

    return extractTrailingColumnAlias(trimmed);
}

/**
 * Look for ` AS <ident>` (case-insensitive) at paren-depth 0 in the item,
 * where <ident> is the last token of the item. Returns the alias when the
 * tail matches `\b AS \s+ (ident|"quoted") \s*$`.
 */
function extractAsAlias(item: string): SelectAlias | undefined {
    // Scan for top-level AS occurrences; pick the last one whose remainder is
    // a single identifier (possibly quoted).
    const upper = item.toUpperCase();
    const len = item.length;
    let depth = 0;
    let lastAsEnd = -1;
    let i = 0;
    while (i < len) {
        const ch = item[i];
        if (ch === "'") { i = skipSingleQuoted(item, i); continue; }
        if (ch === '"') { i = skipDoubleQuoted(item, i); continue; }
        if (ch === '(') { depth++; i++; continue; }
        if (ch === ')') { depth--; i++; continue; }
        if (depth === 0 && matchesKeywordAt(upper, 'AS', i)) {
            lastAsEnd = i + 2;
        }
        i++;
    }
    if (lastAsEnd < 0) { return undefined; }
    const tail = item.slice(lastAsEnd).trim();
    return parseIdentifierToken(tail);
}

/**
 * Parse a single identifier token from the start of `text`, requiring that the
 * identifier consumes the entire input (no trailing junk). Accepts
 * `bare_ident` or `"quoted ident"`.
 */
function parseIdentifierToken(text: string): SelectAlias | undefined {
    const t = text.trim();
    if (!t) { return undefined; }
    if (t[0] === '"') {
        const close = findClosingDoubleQuote(t, 0);
        if (close < 0) { return undefined; }
        if (t.slice(close + 1).trim() !== '') { return undefined; }
        const name = t.slice(1, close).replace(/""/g, '"');
        return name ? { name, quoted: true } : undefined;
    }
    if (/^[A-Za-z_]\w*$/.test(t)) {
        return { name: t, quoted: false };
    }
    return undefined;
}

function findClosingDoubleQuote(t: string, openIdx: number): number {
    let i = openIdx + 1;
    while (i < t.length) {
        if (t[i] === '"' && t[i + 1] === '"') { i += 2; continue; }
        if (t[i] === '"') { return i; }
        i++;
    }
    return -1;
}

/**
 * If `item` is a column reference (`bare_column` or `table.column` or
 * `"schema"."table"."column"`), return the trailing column identifier as the
 * alias. Anything more complex (function calls, arithmetic, CASE) returns
 * undefined here; those need explicit AS.
 */
function extractTrailingColumnAlias(item: string): SelectAlias | undefined {
    const t = item.trim();
    if (!t) { return undefined; }
    // Item must look like: (ident|"q")(\.(ident|"q"))* with nothing else.
    let i = 0;
    let lastTokenStart = -1;
    let lastTokenEnd = -1;
    let lastQuoted = false;
    const len = t.length;
    while (i < len) {
        if (t[i] === '"') {
            const close = findClosingDoubleQuote(t, i);
            if (close < 0) { return undefined; }
            lastTokenStart = i + 1;
            lastTokenEnd = close;
            lastQuoted = true;
            i = close + 1;
        } else if (/[A-Za-z_]/.test(t[i])) {
            const start = i;
            while (i < len && /[A-Za-z0-9_]/.test(t[i])) { i++; }
            lastTokenStart = start;
            lastTokenEnd = i;
            lastQuoted = false;
        } else {
            return undefined;
        }
        // Allow optional whitespace, then either end or a dot.
        while (i < len && (t[i] === ' ' || t[i] === '\t' || t[i] === '\n' || t[i] === '\r')) { i++; }
        if (i >= len) { break; }
        if (t[i] !== '.') { return undefined; }
        i++;
        while (i < len && (t[i] === ' ' || t[i] === '\t' || t[i] === '\n' || t[i] === '\r')) { i++; }
        if (i >= len) { return undefined; }
        if (t[i] === '*') { return undefined; }
    }
    if (lastTokenStart < 0) { return undefined; }
    const raw = t.slice(lastTokenStart, lastTokenEnd);
    const name = lastQuoted ? raw.replace(/""/g, '"') : raw;
    return name ? { name, quoted: lastQuoted } : undefined;
}
