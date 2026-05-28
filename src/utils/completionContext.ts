/**
 * Classify the cursor's lexical context within a SQL statement so the completion
 * provider can rank suggestion buckets (columns vs schemas vs keywords) by what
 * is actually relevant at that cursor position.
 *
 * The classifier is pure: it never touches vscode/document APIs. Callers pass
 * the comment-stripped statement text and the cursor offset within it.
 */

import { stripCommentsPreservingStrings } from './sql';
import { findEnclosingSelectRange } from './selectAliases';

export type ContextKind =
    | 'AFTER_DOT'
    | 'AFTER_SELECT_KEYWORD'
    | 'AFTER_FROM_OR_JOIN'
    | 'AFTER_WHERE_HAVING_QUALIFY'
    | 'AFTER_GROUP_BY_ORDER_BY'
    | 'STATEMENT_START'
    | 'UNKNOWN';

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
    const text = stripCommentsPreservingStrings(queryText);
    const cursor = clamp(cursorOffset, 0, text.length);

    if (cursor > 0 && lastNonSpaceChar(text, cursor) === '.') {
        return { kind: 'AFTER_DOT', fromTables: [] };
    }

    const trimmedBefore = text.slice(0, cursor).replace(/\s+$/, '');
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
        if (matchAt(upper, i, k)) { return { kw: k, len: k.length }; }
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
 * (or before the next clause keyword such as WHERE/GROUP BY). Reuses the same
 * regex shape that completionProvider.parseAliases uses so it picks up the
 * exact set of named FROM/JOIN tables and nothing else.
 */
function extractFromTables(text: string, upper: string, fromIdx: number, scopeEnd: number): FromTableRef[] {
    const bodyStart = fromIdx + 4;
    const bodyEnd = findFromBodyEnd(upper, text, bodyStart, scopeEnd);
    const body = text.slice(bodyStart, bodyEnd);

    const out: FromTableRef[] = [];
    const ident = '(?:"([^"]+)"|([A-Za-z_]\\w*))';
    // Anchor on FROM/JOIN to avoid grabbing aliases or ON-clause refs.
    // We synthesise a leading FROM so the first table in the body matches too.
    const withFrom = 'FROM ' + body;
    const re = new RegExp(
        `\\b(?:from|(?:(?:inner|left|right|full|cross)\\s+)?(?:outer\\s+)?join)\\s+` +
        `(?:${ident}\\s*\\.\\s*)?${ident}`,
        'gi'
    );
    let m: RegExpExecArray | null;
    const STOP = new Set(['ON','WHERE','GROUP','ORDER','HAVING','QUALIFY','LIMIT',
        'UNION','INTERSECT','EXCEPT','JOIN','INNER','LEFT','RIGHT','FULL','CROSS','OUTER','AS']);
    while ((m = re.exec(withFrom)) !== null) {
        const schema = m[1] ?? m[2];
        const table = m[3] ?? m[4];
        if (!table) { continue; }
        const tu = table.toUpperCase();
        if (STOP.has(tu)) { continue; }
        if (schema && STOP.has(schema.toUpperCase())) { continue; }
        out.push(schema ? { schema, table } : { table });
    }
    return dedupe(out);
}

function dedupe(refs: FromTableRef[]): FromTableRef[] {
    const seen = new Set<string>();
    const out: FromTableRef[] = [];
    for (const r of refs) {
        const k = `${(r.schema ?? '').toUpperCase()}.${r.table.toUpperCase()}`;
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
