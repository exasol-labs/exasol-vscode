/**
 * Classify the cursor's lexical context within a SQL statement so the completion
 * provider can rank suggestion buckets (columns vs schemas vs keywords) by what
 * is actually relevant at that cursor position.
 *
 * The classifier is pure: it never touches vscode/document APIs. Callers pass
 * the statement text and the cursor offset within it.
 */

import { normalizeIdentifier, stripCommentsPreservingPositions } from './sql';
import { findEnclosingSelectRange, isDistinctPredicateFrom } from './selectAliases';

export type ContextKind =
    | 'AFTER_DOT'
    | 'AFTER_SELECT_KEYWORD'
    | 'AFTER_FROM_OR_JOIN'
    | 'AFTER_WHERE_HAVING_QUALIFY'
    | 'AFTER_GROUP_BY_ORDER_BY'
    | 'STATEMENT_START'
    | 'UNKNOWN';

/** Names as the database stores them (see normalizeIdentifier). */
export interface FromTableRef {
    schema?: string;
    table: string;
}

export interface CompletionContext {
    kind: ContextKind;
    /** FROM-clause tables in scope of the enclosing SELECT, when applicable. */
    fromTables: FromTableRef[];
}

export function classifyContext(
    queryText: string,
    cursorOffset: number
): CompletionContext {
    // Comments become spaces, so the cursor offset stays valid.
    const text = stripCommentsPreservingPositions(queryText);
    const cursor = clamp(cursorOffset, 0, text.length);

    if (cursor > 0 && lastNonSpaceChar(text, cursor) === '.') {
        return { kind: 'AFTER_DOT', fromTables: [] };
    }

    const trimmedBefore = text.slice(0, cursor).trimEnd();
    if (!trimmedBefore || isStatementStart(text, cursor)) {
        return { kind: 'STATEMENT_START', fromTables: [] };
    }

    const enc = findEnclosingSelectRange(queryText, cursor);
    if (!enc) {
        return { kind: 'UNKNOWN', fromTables: [] };
    }

    const upper = enc.text.toUpperCase();
    const fromTables = enc.fromIdx >= 0 ? extractFromTables(enc.text, upper, enc.fromIdx, enc.scopeEnd) : [];

    // Clause boundaries within enclosing SELECT scope, before cursor.
    const lastClause = findLastClauseKeyword(upper, enc.text, enc.selectStart, cursor);

    if (cursor <= (enc.fromIdx >= 0 ? enc.fromIdx : enc.scopeEnd) && lastClause.kw === 'SELECT') {
        return { kind: 'AFTER_SELECT_KEYWORD', fromTables };
    }

    if (lastClause.kw === 'FROM' || isJoinLikeKw(lastClause.kw)) {
        // If cursor sits directly after FROM/JOIN with nothing yet (or just an
        // unfinished identifier), call it AFTER_FROM_OR_JOIN.
        if (isImmediatelyAfter(upper, enc.text, lastClause.endPos, cursor)) {
            return { kind: 'AFTER_FROM_OR_JOIN', fromTables };
        }
        // Otherwise treat as part of FROM clause body; still pick FROM tables
        // for column suggestions but kind is UNKNOWN to surface objects too.
        return { kind: 'UNKNOWN', fromTables };
    }

    if (lastClause.kw === 'WHERE' || lastClause.kw === 'HAVING' || lastClause.kw === 'QUALIFY'
        || lastClause.kw === 'AND' || lastClause.kw === 'OR' || lastClause.kw === 'ON') {
        return { kind: 'AFTER_WHERE_HAVING_QUALIFY', fromTables };
    }

    if (lastClause.kw === 'GROUP_BY' || lastClause.kw === 'ORDER_BY') {
        return { kind: 'AFTER_GROUP_BY_ORDER_BY', fromTables };
    }

    return { kind: 'UNKNOWN', fromTables };
}

function clamp(n: number, lo: number, hi: number): number {
    if (n < lo) { return lo; }
    if (n > hi) { return hi; }
    return n;
}

function lastNonSpaceChar(text: string, before: number): string {
    let i = before - 1;
    while (i >= 0 && /\s/.test(text[i])) { i--; }
    return i >= 0 ? text[i] : '';
}

/**
 * True when no SQL keyword precedes the cursor in the current statement.
 * Treats whitespace-only or comment-only prefixes as statement-start.
 */
function isStatementStart(text: string, cursor: number): boolean {
    const before = text.slice(0, cursor).trim();
    if (!before) { return true; }
    // Cursor is at statement start if the only token(s) so far don't include
    // a recognised top-level command keyword AND there is no SELECT yet.
    // Easiest signal: no keyword at depth 0 in `before`.
    const upper = text.slice(0, cursor).toUpperCase();
    const cmd = /\b(SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER|DROP|TRUNCATE|MERGE|COMMIT|ROLLBACK)\b/;
    return !cmd.test(upper);
}

/**
 * Find the last clause-introducing keyword between `selectStart` and `cursor`
 * (exclusive of cursor) at the SELECT's paren depth. Returns the keyword name
 * and the offset just past it (its `endPos`).
 */
interface LastClause { kw: string; endPos: number; }

function isJoinLikeKw(kw: string): boolean {
    return kw === 'JOIN' || kw.endsWith('_JOIN');
}

function findLastClauseKeyword(
    upper: string, original: string, from: number, to: number
): LastClause {
    let depth = 0;
    let i = from;
    let last: LastClause = { kw: '', endPos: from };
    const limit = Math.min(upper.length, to);
    while (i < limit) {
        const ch = original[i];
        if (ch === "'") { i = skipSingleQuoted(original, i, limit); continue; }
        if (ch === '"') { i = skipDoubleQuoted(original, i, limit); continue; }
        if (ch === '(') { depth++; i++; continue; }
        if (ch === ')') { if (depth > 0) { depth--; } i++; continue; }
        if (depth === 0) {
            const m = matchClauseKeyword(upper, i);
            if (m) {
                last = { kw: m.kw, endPos: i + m.len };
                i += m.len;
                continue;
            }
        }
        i++;
    }
    return last;
}

interface KeywordMatch { kw: string; len: number; }
function matchClauseKeyword(upper: string, i: number): KeywordMatch | undefined {
    // Multi-word first.
    if (matchAt(upper, i, 'GROUP') && hasFollow(upper, i + 5, 'BY')) {
        return { kw: 'GROUP_BY', len: lenWithSpace(upper, i, 5, 'BY') };
    }
    if (matchAt(upper, i, 'ORDER') && hasFollow(upper, i + 5, 'BY')) {
        return { kw: 'ORDER_BY', len: lenWithSpace(upper, i, 5, 'BY') };
    }
    for (const prefix of ['INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS']) {
        if (matchAt(upper, i, prefix)) {
            const after = skipSpacesIn(upper, i + prefix.length);
            // Optional OUTER
            const afterOuter = matchAt(upper, after, 'OUTER') ? skipSpacesIn(upper, after + 5) : after;
            if (matchAt(upper, afterOuter, 'JOIN')) {
                return { kw: `${prefix}_JOIN`, len: afterOuter + 4 - i };
            }
        }
    }
    for (const k of ['JOIN', 'SELECT', 'FROM', 'WHERE', 'HAVING', 'QUALIFY']) {
        if (matchAt(upper, i, k) && !(k === 'FROM' && isDistinctPredicateFrom(upper, i))) {
            return { kw: k, len: k.length };
        }
    }
    for (const k of ['AND', 'OR', 'ON']) {
        if (matchAt(upper, i, k)) { return { kw: k, len: k.length }; }
    }
    return undefined;
}

function matchAt(upper: string, i: number, kw: string): boolean {
    if (upper.substring(i, i + kw.length) !== kw) { return false; }
    if (i > 0 && /[A-Z0-9_]/.test(upper[i - 1])) { return false; }
    const next = upper[i + kw.length];
    if (next !== undefined && /[A-Z0-9_]/.test(next)) { return false; }
    return true;
}
function hasFollow(upper: string, after: number, kw: string): boolean {
    const j = skipSpacesIn(upper, after);
    return matchAt(upper, j, kw);
}
function lenWithSpace(upper: string, start: number, firstLen: number, follow: string): number {
    const j = skipSpacesIn(upper, start + firstLen);
    return j + follow.length - start;
}
function skipSpacesIn(s: string, i: number): number {
    while (i < s.length && /\s/.test(s[i])) { i++; }
    return i;
}

function isImmediatelyAfter(_upper: string, original: string, endPos: number, cursor: number): boolean {
    // True when between endPos and cursor we have only whitespace, an optional
    // partial identifier, and nothing terminal like a comma or newline-ish boundary.
    let i = endPos;
    while (i < cursor && /\s/.test(original[i])) { i++; }
    // allow an unfinished identifier
    while (i < cursor && /[A-Za-z0-9_"]/.test(original[i])) { i++; }
    return i >= cursor;
}

/**
 * Extract FROM/JOIN table references between the FROM keyword and scopeEnd
 * (or before the next clause keyword such as WHERE/GROUP BY), including the
 * tables after a comma in the FROM list.
 */
function extractFromTables(text: string, upper: string, fromIdx: number, scopeEnd: number): FromTableRef[] {
    const bodyEnd = findFromBodyEnd(upper, text, fromIdx + 4, scopeEnd);
    return dedupe(findTableReferences(text.slice(fromIdx, bodyEnd))
        .map(r => r.schema ? { schema: r.schema, table: r.table } : { table: r.table }));
}

/** A table in a FROM list or after JOIN; names as the database stores them (see normalizeIdentifier). */
export interface TableReference {
    schema?: string;
    table: string;
    alias?: string;
}

/**
 * Reserved words that end a table reference or cannot be a table name, so
 * unquoted they are neither a table nor an alias. VALUES starts a list of
 * rows; LOCAL, CSV, FBV, PARQUET, SCRIPT and AT follow the FROM of an IMPORT
 * inside parentheses.
 */
const NON_TABLE_WORDS = new Set(['AS', 'ON', 'USING', 'WHERE', 'FROM', 'JOIN', 'NATURAL', 'INNER', 'LEFT', 'RIGHT',
    'FULL', 'CROSS', 'OUTER', 'ORDER', 'GROUP', 'HAVING', 'QUALIFY', 'LIMIT', 'UNION', 'INTERSECT', 'EXCEPT', 'MINUS',
    'CONNECT', 'START', 'PREFERRING', 'SELECT', 'VALUES', 'LOCAL', 'CSV', 'FBV', 'PARQUET', 'SCRIPT', 'AT']);

const TABLE_IDENT = '("(?:[^"]|"")+"|[A-Za-z_]\\w*)';
/** `[schema.]table [[AS] alias]` at the start of a table reference. */
const TABLE_REFERENCE = new RegExp(
    `\\s*(?:${TABLE_IDENT}\\s*\\.\\s*)?${TABLE_IDENT}(?:\\s+(?:AS\\s+)?${TABLE_IDENT})?`, 'iy');

/**
 * The tables in the FROM lists and after the JOINs of `text`, in order, such
 * as `a x` and `b y` in `FROM a x, b y`. Text in strings, quoted identifiers
 * and comments is not read as SQL, except a quoted identifier as a name. A
 * FROM starts a FROM list only at the paren depth of a SELECT, or outside
 * parentheses, as after DELETE: the FROM of `SUBSTRING(x FROM 1)` or
 * `EXTRACT(YEAR FROM d)` does not, and neither does the FROM of
 * `IS [NOT] DISTINCT FROM`. A table after `FROM VALUES (...)` is not listed:
 * its alias names rows, not a table with columns in the database. The FROM of
 * an IMPORT statement names a file, a database or a script, never a table.
 */
export function findTableReferences(text: string): TableReference[] {
    const masked = stripCommentsPreservingPositions(text);
    const refs: TableReference[] = [];
    for (const start of findTableStarts(masked)) {
        TABLE_REFERENCE.lastIndex = start;
        const m = TABLE_REFERENCE.exec(masked);
        if (!m || isNonTableWord(m[1]) || isNonTableWord(m[2])) { continue; }
        const schema = m[1] && normalizeIdentifier(m[1]);
        const table = normalizeIdentifier(m[2]);
        const alias = m[3] && !isNonTableWord(m[3]) ? normalizeIdentifier(m[3]) : undefined;
        refs.push({ ...(schema ? { schema } : {}), table, ...(alias ? { alias } : {}) });
    }
    return refs;
}

function isNonTableWord(written: string | undefined): boolean {
    return written !== undefined && !written.startsWith('"') && NON_TABLE_WORDS.has(written.toUpperCase());
}

/** Keywords that end a FROM list. */
const FROM_LIST_END = new Set(['WHERE', 'GROUP', 'ORDER', 'HAVING', 'QUALIFY', 'LIMIT', 'UNION', 'INTERSECT',
    'EXCEPT', 'MINUS', 'CONNECT', 'START', 'PREFERRING', 'SELECT']);

/**
 * Offsets in comment-free `text` where a table reference starts: after a FROM
 * that starts a FROM list, after JOIN, and after each top-level comma of a
 * FROM list. A FROM list ends at a clause keyword such as WHERE, at a `;`, or
 * at the `)` that closes its parentheses. Strings and quoted identifiers are
 * skipped. The FROM of a statement that starts with IMPORT starts no FROM
 * list; inside parentheses, as in `FROM (IMPORT ...)`, no SELECT is at the
 * depth of its FROM. An IMPORT statement has no SELECT outside parentheses,
 * so such a SELECT starts a new statement even after an IMPORT without `;`.
 * A line with only `/` ends a statement too, as it ends a script or function
 * definition. A `;` in the body of a CREATE SCRIPT or CREATE FUNCTION belongs
 * to that body, so the word after it does not start a statement: the
 * `import(...)` of a Lua script or the `import json` of a Python script is
 * not an IMPORT statement.
 */
function findTableStarts(text: string): number[] {
    const len = text.length;
    // Per paren depth: a SELECT is at this depth (always true outside parentheses).
    const query: boolean[] = [true];
    // Per paren depth: the text at this depth is in a FROM list.
    const inFrom: boolean[] = [false];
    const starts: number[] = [];
    // The word right before the current token, or '' after any other token.
    let previousWord = '';
    // The first word of the current statement is still to come.
    let statementStart = true;
    let importStatement = false;
    let createStatement = false;
    // The text is in the body of a CREATE SCRIPT or CREATE FUNCTION, which ends at a `/` line.
    let definitionBody = false;
    let i = 0;
    while (i < len) {
        const ch = text[i];
        const top = inFrom.length - 1;
        if (/[A-Za-z_]/.test(ch)) {
            const start = i;
            while (i < len && /\w/.test(text[i])) { i++; }
            const word = text.slice(start, i).toUpperCase();
            if (statementStart) {
                importStatement = word === 'IMPORT';
                createStatement = word === 'CREATE';
                statementStart = false;
            } else if (createStatement && top === 0 && (word === 'SCRIPT' || word === 'FUNCTION')) {
                definitionBody = true;
                createStatement = false;
            }
            if (word === 'SELECT' && top === 0) { importStatement = false; }
            if (word === 'FROM') {
                if (query[top] && previousWord !== 'DISTINCT' && !(top === 0 && importStatement)) {
                    inFrom[top] = true;
                    starts.push(i);
                }
            } else if (word === 'JOIN') {
                starts.push(i);
            } else if (FROM_LIST_END.has(word)) {
                inFrom[top] = false;
                if (word === 'SELECT') { query[top] = true; }
            }
            previousWord = word;
            continue;
        }
        if (ch === "'") {
            i = skipSingleQuoted(text, i, len);
        } else if (ch === '"') {
            i = skipDoubleQuoted(text, i, len);
        } else {
            if (ch === '(') {
                query.push(false);
                inFrom.push(false);
            } else if (ch === ')') {
                if (inFrom.length > 1) { query.pop(); inFrom.pop(); }
            } else if ((ch === ';' && !definitionBody) || (ch === '/' && isSlashLine(text, i))) {
                query.length = 1;
                inFrom.length = 1;
                inFrom[0] = false;
                statementStart = true;
                importStatement = false;
                createStatement = false;
                definitionBody = false;
            } else if (ch === ',' && inFrom[top]) {
                starts.push(i + 1);
            }
            i++;
        }
        if (!/\s/.test(ch)) { previousWord = ''; }
    }
    return starts;
}

/** The `/` at `i` is the only character on its line, apart from whitespace. */
function isSlashLine(text: string, i: number): boolean {
    let j = i - 1;
    while (j >= 0 && text[j] !== '\n') {
        if (!/\s/.test(text[j])) { return false; }
        j--;
    }
    for (j = i + 1; j < text.length && text[j] !== '\n'; j++) {
        if (!/\s/.test(text[j])) { return false; }
    }
    return true;
}

function dedupe(refs: FromTableRef[]): FromTableRef[] {
    const seen = new Set<string>();
    const out: FromTableRef[] = [];
    for (const r of refs) {
        const k = JSON.stringify([r.schema, r.table]);
        if (seen.has(k)) { continue; }
        seen.add(k);
        out.push(r);
    }
    return out;
}

function findFromBodyEnd(upper: string, original: string, from: number, scopeEnd: number): number {
    const STOPS = ['WHERE', 'GROUP', 'ORDER', 'HAVING', 'QUALIFY', 'LIMIT',
        'UNION', 'INTERSECT', 'EXCEPT'];
    let depth = 0;
    let i = from;
    const limit = Math.min(upper.length, scopeEnd);
    while (i < limit) {
        const ch = original[i];
        if (ch === "'") { i = skipSingleQuoted(original, i, limit); continue; }
        if (ch === '"') { i = skipDoubleQuoted(original, i, limit); continue; }
        if (ch === '(') { depth++; i++; continue; }
        if (ch === ')') { if (depth > 0) { depth--; } else { return i; } i++; continue; }
        if (depth === 0) {
            for (const k of STOPS) {
                if (matchAt(upper, i, k)) { return i; }
            }
        }
        i++;
    }
    return limit;
}

function skipSingleQuoted(text: string, i: number, limit: number): number {
    i++;
    while (i < limit) {
        if (text[i] === "'" && text[i + 1] === "'") { i += 2; continue; }
        if (text[i] === "'") { return i + 1; }
        i++;
    }
    return limit;
}
function skipDoubleQuoted(text: string, i: number, limit: number): number {
    i++;
    while (i < limit) {
        if (text[i] === '"' && text[i + 1] === '"') { i += 2; continue; }
        if (text[i] === '"') { return i + 1; }
        i++;
    }
    return limit;
}
