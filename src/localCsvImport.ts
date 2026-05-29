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

    // Multiple files are not supported by the single-file driver method.
    if (/\bFILE\b/i.test(rest)) {
        throw new Error('Local CSV import supports a single FILE; found multiple. Run one IMPORT per file.');
    }

    return {
        table,
        filePath,
        options: parseCsvOptions(rest)
    };
}

/**
 * Parses the trailing options clause of a local CSV import into CsvFormatOptions.
 * Tolerant of arbitrary whitespace and optional spacing around `=`.
 */
function parseCsvOptions(rest: string): CsvFormatOptions {
    const options: CsvFormatOptions = {};

    const skipMatch = /\bSKIP\s*=\s*(\d+)/i.exec(rest);
    if (skipMatch) {
        options.skip = Number(skipMatch[1]);
    }

    const columnSeparatorMatch = /\bCOLUMN\s+SEPARATOR\s*=\s*'((?:[^']|'')*)'/i.exec(rest);
    if (columnSeparatorMatch) {
        options.columnSeparator = columnSeparatorMatch[1].replace(/''/g, "'");
    }

    const columnDelimiterMatch = /\bCOLUMN\s+DELIMITER\s*=\s*'((?:[^']|'')*)'/i.exec(rest);
    if (columnDelimiterMatch) {
        options.columnDelimiter = columnDelimiterMatch[1].replace(/''/g, "'");
    }

    const rowSeparatorMatch = /\bROW\s+SEPARATOR\s*=\s*'(LF|CR|CRLF)'/i.exec(rest);
    if (rowSeparatorMatch) {
        const value = rowSeparatorMatch[1].toUpperCase();
        options.rowSeparator = RowSeparator[value as keyof typeof RowSeparator];
    }

    const encodingMatch = /\bENCODING\s*=\s*'((?:[^']|'')*)'/i.exec(rest);
    if (encodingMatch) {
        options.encoding = encodingMatch[1].replace(/''/g, "'") as CsvFormatOptions['encoding'];
    }

    // TRIM / LTRIM / RTRIM (match the most specific token first).
    const trimMatch = /\b(LTRIM|RTRIM|TRIM)\b/i.exec(rest);
    if (trimMatch) {
        const value = trimMatch[1].toUpperCase();
        if (value === 'LTRIM') {
            options.trim = TrimMode.LEADING;
        } else if (value === 'RTRIM') {
            options.trim = TrimMode.TRAILING;
        } else {
            options.trim = TrimMode.BOTH;
        }
    }

    const nullMatch = /\bNULL\s*=\s*'((?:[^']|'')*)'/i.exec(rest);
    if (nullMatch) {
        options.null = nullMatch[1].replace(/''/g, "'");
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
