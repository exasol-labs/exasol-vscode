import * as path from 'path';
import * as vscode from 'vscode';
import { CsvFormatOptions, RowSeparator, TrimMode } from '@exasol/exasol-driver-ts';
import { stripCommentsPreservingStrings } from './utils';

/**
 * A parsed `IMPORT INTO <table> FROM LOCAL [SECURE] CSV FILE '<path>' [options]`
 * statement. The driver streams the local file to Exasol over its own TLS tunnel,
 * which raw SQL over the WebSocket protocol cannot do.
 */
export interface ParsedLocalCsvImport {
    /** The import target, captured verbatim (may include a column list, e.g. `t (a, b)`). */
    table: string;
    /** The single-quoted file path with doubled quotes unescaped. */
    filePath: string;
    /** CSV format options parsed from the trailing clause; unspecified options are omitted. */
    options: CsvFormatOptions;
}

// IMPORT INTO <target> FROM LOCAL [SECURE] CSV FILE '<path>' [trailing-options]
// - target is captured non-greedily up to FROM LOCAL [SECURE] CSV FILE
// - dotall so multi-line statements match
const LOCAL_CSV_IMPORT_RE =
    /^IMPORT\s+INTO\s+(?<target>.+?)\s+FROM\s+LOCAL\s+(?:SECURE\s+)?CSV\s+FILE\s+'(?<path>(?:[^']|'')*)'(?<rest>.*)$/is;

/**
 * Detects a local CSV import statement and parses it into the shape the driver's
 * `importFromCsvFile` expects. Returns `null` for anything that is not a local CSV
 * import (cloud imports without LOCAL, `FROM LOCAL FBV FILE`, plain SELECT, etc.)
 * so those statements flow through the normal execution path untouched.
 */
export function parseLocalCsvImport(sql: string): ParsedLocalCsvImport | null {
    const cleaned = stripCommentsPreservingStrings(sql)
        .trim()
        .replace(/;+\s*$/, '')
        .trim();

    const match = LOCAL_CSV_IMPORT_RE.exec(cleaned);
    if (!match || !match.groups) {
        return null;
    }

    const table = match.groups.target.trim();
    // Unescape doubled single-quotes ('' -> ') from the SQL string literal.
    const filePath = match.groups.path.replace(/''/g, "'");
    const rest = match.groups.rest;

    return {
        table,
        filePath,
        options: parseCsvOptions(rest)
    };
}

/**
 * One option token recognized in the trailing clause: a `KEYWORD = 'value'`
 * pair, a `SKIP = <number>` pair, or a bare `TRIM`/`LTRIM`/`RTRIM` keyword.
 * The regex is anchored at the current cursor (`y` flag) so matching and
 * consuming proceed strictly left-to-right; quoted string values are captured
 * whole and never re-scanned for keywords.
 */
interface OptionTokenMatcher {
    re: RegExp;
    apply: (options: CsvFormatOptions, m: RegExpExecArray) => void;
}

const OPTION_TOKEN_MATCHERS: OptionTokenMatcher[] = [
    {
        re: /SKIP\s*=\s*(\d+)/iy,
        apply: (options, m) => { options.skip = Number(m[1]); }
    },
    {
        re: /COLUMN\s+SEPARATOR\s*=\s*'((?:[^']|'')*)'/iy,
        apply: (options, m) => { options.columnSeparator = m[1].replace(/''/g, "'"); }
    },
    {
        re: /COLUMN\s+DELIMITER\s*=\s*'((?:[^']|'')*)'/iy,
        apply: (options, m) => { options.columnDelimiter = m[1].replace(/''/g, "'"); }
    },
    {
        re: /ROW\s+SEPARATOR\s*=\s*'(LF|CR|CRLF)'/iy,
        apply: (options, m) => {
            const value = m[1].toUpperCase();
            options.rowSeparator = RowSeparator[value as keyof typeof RowSeparator];
        }
    },
    {
        re: /ENCODING\s*=\s*'((?:[^']|'')*)'/iy,
        apply: (options, m) => {
            options.encoding = m[1].replace(/''/g, "'") as CsvFormatOptions['encoding'];
        }
    },
    {
        re: /NULL\s*=\s*'((?:[^']|'')*)'/iy,
        apply: (options, m) => { options.null = m[1].replace(/''/g, "'"); }
    },
    {
        // TRIM / LTRIM / RTRIM as a bare keyword token (no value). The \b after
        // ensures TRIM is not consumed from the middle of a longer identifier.
        re: /(LTRIM|RTRIM|TRIM)\b/iy,
        apply: (options, m) => {
            const value = m[1].toUpperCase();
            if (value === 'LTRIM') {
                options.trim = TrimMode.LEADING;
            } else if (value === 'RTRIM') {
                options.trim = TrimMode.TRAILING;
            } else {
                options.trim = TrimMode.BOTH;
            }
        }
    }
];

/** Matches an unconsumed `FILE` keyword token in the option structure. */
const FILE_TOKEN_RE = /FILE\b/iy;
/** Matches leading whitespace and optional comma/AND separators between tokens. */
const SEPARATOR_RE = /[\s,]*(?:AND[\s,]+)?/iy;

/**
 * Parses the trailing options clause of a local CSV import into CsvFormatOptions.
 *
 * Walks `rest` left-to-right, matching and consuming one option token at a time.
 * Because quoted string values are captured whole and the cursor only advances
 * past matched spans, a keyword that appears INSIDE a quoted value (e.g.
 * `NULL = 'FILE'`, `COLUMN SEPARATOR = 'SKIP'`) is never re-interpreted as an
 * option keyword. The multi-file guard likewise only fires on a real `FILE`
 * token found in the unconsumed structure, not on text inside a quoted value.
 * Tolerant of arbitrary whitespace and optional spacing around `=`.
 */
function parseCsvOptions(rest: string): CsvFormatOptions {
    const options: CsvFormatOptions = {};
    let pos = 0;

    const skipSeparators = (): void => {
        SEPARATOR_RE.lastIndex = pos;
        const sep = SEPARATOR_RE.exec(rest);
        if (sep) {
            pos = SEPARATOR_RE.lastIndex;
        }
    };

    while (pos < rest.length) {
        skipSeparators();
        if (pos >= rest.length) {
            break;
        }

        // A real FILE token in the unconsumed structure means a second file.
        FILE_TOKEN_RE.lastIndex = pos;
        if (FILE_TOKEN_RE.exec(rest)) {
            throw new Error('Local CSV import supports a single FILE; found multiple. Run one IMPORT per file.');
        }

        let matched = false;
        for (const matcher of OPTION_TOKEN_MATCHERS) {
            matcher.re.lastIndex = pos;
            const m = matcher.re.exec(rest);
            if (m) {
                matcher.apply(options, m);
                pos = matcher.re.lastIndex;
                matched = true;
                break;
            }
        }

        if (!matched) {
            // Unrecognized token: advance past it so a quoted value or stray
            // token cannot wedge the loop, and keep scanning for a FILE keyword.
            const advance = /\S+/y;
            advance.lastIndex = pos;
            if (advance.exec(rest)) {
                pos = advance.lastIndex;
            } else {
                break;
            }
        }
    }

    return options;
}

/**
 * Resolves a CSV import path to an absolute filesystem path. Absolute paths are
 * returned unchanged; relative paths resolve against the active SQL document's
 * directory, falling back to the first workspace folder.
 */
export function resolveImportPath(filePath: string): string {
    if (path.isAbsolute(filePath)) {
        return filePath;
    }

    const activeDoc = vscode.window.activeTextEditor?.document?.uri;
    if (activeDoc && activeDoc.scheme === 'file') {
        return path.resolve(path.dirname(activeDoc.fsPath), filePath);
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
        return path.resolve(workspaceFolder.uri.fsPath, filePath);
    }

    throw new Error('Relative import path; open the SQL file from a folder or use an absolute path.');
}
