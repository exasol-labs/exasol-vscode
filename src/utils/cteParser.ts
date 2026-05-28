/**
 * Parse Common Table Expressions (CTEs) at the top of a SQL statement.
 *
 * Recognises:
 *   WITH [RECURSIVE] name [(col1, col2, ...)] AS ( body )
 *     [, name [(col1, ...)] AS ( body ) ]*
 *   SELECT|INSERT|UPDATE|DELETE|MERGE ...
 *
 * Each CTE's columns are derived from:
 *   - The explicit column list when present, regardless of body.
 *   - Otherwise, the SELECT list of the body (via parseSelectListAliases).
 *
 * Bodies that select `*` or `table.*` yield an empty columns array.
 * Inline derived tables (`FROM (SELECT ...) AS sq`) are NOT handled here.
 */

import { stripCommentsPreservingStrings } from './sql';
import { parseSelectListAliases } from './selectAliases';

export interface CteDefinition {
    name: string;
    columns: string[];
}

export function parseCtes(statementText: string): CteDefinition[] {
    const text = stripCommentsPreservingStrings(statementText);
    const upper = text.toUpperCase();

    const withIdx = findLeadingWith(text, upper);
    if (withIdx < 0) { return []; }

    let i = withIdx + 'WITH'.length;
    i = skipSpaces(text, i);
    // Optional RECURSIVE
    if (matchKeyword(upper, 'RECURSIVE', i)) {
        i += 'RECURSIVE'.length;
        i = skipSpaces(text, i);
    }

    const ctes: CteDefinition[] = [];
    while (i < text.length) {
        // Parse a CTE name
        const nameTok = readIdentifier(text, i);
        if (!nameTok) { break; }
        i = nameTok.end;
        i = skipSpaces(text, i);

        // Optional explicit column list
        let explicitCols: string[] | undefined;
        if (text[i] === '(') {
            const close = findMatchingParen(text, i);
            if (close < 0) { break; }
            explicitCols = parseColumnList(text.slice(i + 1, close));
            i = close + 1;
            i = skipSpaces(text, i);
        }

        // Expect AS
        if (!matchKeyword(upper, 'AS', i)) { break; }
        i += 'AS'.length;
        i = skipSpaces(text, i);

        // Expect ( body )
        if (text[i] !== '(') { break; }
        const bodyClose = findMatchingParen(text, i);
        if (bodyClose < 0) { break; }
        const body = text.slice(i + 1, bodyClose);
        i = bodyClose + 1;

        const columns = explicitCols ?? deriveColumnsFromBody(body);
        ctes.push({ name: nameTok.name, columns });

        i = skipSpaces(text, i);
        // Either a comma (next CTE) or end of CTE list (next is a top-level
        // statement keyword: SELECT/INSERT/UPDATE/DELETE/MERGE).
        if (text[i] === ',') {
            i++;
            i = skipSpaces(text, i);
            continue;
        }
        break;
    }

    return ctes;
}

function findLeadingWith(text: string, upper: string): number {
    let i = 0;
    while (i < text.length && /\s/.test(text[i])) { i++; }
    if (matchKeyword(upper, 'WITH', i)) { return i; }
    return -1;
}

function matchKeyword(upper: string, kw: string, i: number): boolean {
    if (upper.substring(i, i + kw.length) !== kw) { return false; }
    if (i > 0 && /[A-Za-z0-9_]/.test(upper[i - 1])) { return false; }
    const after = upper[i + kw.length];
    if (after !== undefined && /[A-Za-z0-9_]/.test(after)) { return false; }
    return true;
}

function skipSpaces(text: string, i: number): number {
    while (i < text.length && /\s/.test(text[i])) { i++; }
    return i;
}

interface IdentToken { name: string; end: number; }

function readIdentifier(text: string, i: number): IdentToken | undefined {
    if (i >= text.length) { return undefined; }
    if (text[i] === '"') {
        let j = i + 1;
        let out = '';
        while (j < text.length) {
            if (text[j] === '"' && text[j + 1] === '"') { out += '"'; j += 2; continue; }
            if (text[j] === '"') { return out ? { name: out, end: j + 1 } : undefined; }
            out += text[j];
            j++;
        }
        return undefined;
    }
    if (!/[A-Za-z_]/.test(text[i])) { return undefined; }
    let j = i;
    while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) { j++; }
    return { name: text.slice(i, j), end: j };
}

/**
 * Given the index of an opening '(', return the index of the matching ')'.
 * Respects nested parens, single-quoted strings, and double-quoted identifiers.
 * Returns -1 if no match.
 */
function findMatchingParen(text: string, openIdx: number): number {
    let depth = 0;
    let i = openIdx;
    const len = text.length;
    while (i < len) {
        const ch = text[i];
        if (ch === "'") { i = skipSingleQuoted(text, i); continue; }
        if (ch === '"') { i = skipDoubleQuoted(text, i); continue; }
        if (ch === '(') { depth++; i++; continue; }
        if (ch === ')') {
            depth--;
            if (depth === 0) { return i; }
            i++;
            continue;
        }
        i++;
    }
    return -1;
}

function skipSingleQuoted(text: string, i: number): number {
    i++;
    const len = text.length;
    while (i < len) {
        if (text[i] === "'" && text[i + 1] === "'") { i += 2; continue; }
        if (text[i] === "'") { return i + 1; }
        i++;
    }
    return len;
}

function skipDoubleQuoted(text: string, i: number): number {
    i++;
    const len = text.length;
    while (i < len) {
        if (text[i] === '"' && text[i + 1] === '"') { i += 2; continue; }
        if (text[i] === '"') { return i + 1; }
        i++;
    }
    return len;
}

function parseColumnList(text: string): string[] {
    const cols: string[] = [];
    const parts = splitTopLevelCommas(text);
    for (const raw of parts) {
        const tok = readIdentifier(raw.trim(), 0);
        if (tok && tok.name) { cols.push(tok.name); }
    }
    return cols;
}

function splitTopLevelCommas(text: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    let i = 0;
    const len = text.length;
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
    parts.push(text.slice(start, len));
    return parts;
}

function deriveColumnsFromBody(body: string): string[] {
    // parseSelectListAliases already strips comments, splits at top-level commas,
    // and skips '*' / 'table.*' entries.
    return parseSelectListAliases(body).map(a => a.name);
}
