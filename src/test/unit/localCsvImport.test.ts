import * as assert from 'assert';
import { registerVscodeMock } from '../helpers/vscodeMock';
import { RowSeparator, TrimMode } from '@exasol/exasol-driver-ts';

registerVscodeMock();

// Load after the vscode mock is configured, since localCsvImport imports 'vscode'.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseLocalCsvImport } = require('../../localCsvImport');

suite('parseLocalCsvImport: detection and extraction', () => {
    test('detects a basic local CSV import and extracts table and path', () => {
        const result = parseLocalCsvImport("IMPORT INTO t FROM LOCAL CSV FILE '/data/in.csv'");
        assert.ok(result, 'should detect the import');
        assert.strictEqual(result.table, 't');
        assert.strictEqual(result.filePath, '/data/in.csv');
        assert.deepStrictEqual(result.options, {});
    });

    test('is case-insensitive and tolerant of extra whitespace', () => {
        const result = parseLocalCsvImport("import   into   t\n  from local csv file   '/data/in.csv'");
        assert.ok(result);
        assert.strictEqual(result.table, 't');
        assert.strictEqual(result.filePath, '/data/in.csv');
    });

    test('strips a trailing semicolon', () => {
        const result = parseLocalCsvImport("IMPORT INTO t FROM LOCAL CSV FILE '/data/in.csv';");
        assert.ok(result);
        assert.strictEqual(result.filePath, '/data/in.csv');
    });

    test('parses the SECURE variant', () => {
        const result = parseLocalCsvImport("IMPORT INTO t FROM LOCAL SECURE CSV FILE '/data/in.csv'");
        assert.ok(result);
        assert.strictEqual(result.table, 't');
        assert.strictEqual(result.filePath, '/data/in.csv');
    });

    test('captures a column-list target verbatim', () => {
        const result = parseLocalCsvImport("IMPORT INTO t (a, b) FROM LOCAL CSV FILE '/data/in.csv'");
        assert.ok(result);
        assert.strictEqual(result.table, 't (a, b)');
        assert.strictEqual(result.filePath, '/data/in.csv');
    });

    test('captures a schema-qualified target', () => {
        const result = parseLocalCsvImport("IMPORT INTO myschema.mytable FROM LOCAL CSV FILE '/data/in.csv'");
        assert.ok(result);
        assert.strictEqual(result.table, 'myschema.mytable');
    });

    test('unescapes doubled single-quotes in the path', () => {
        const result = parseLocalCsvImport("IMPORT INTO t FROM LOCAL CSV FILE '/data/o''brien.csv'");
        assert.ok(result);
        assert.strictEqual(result.filePath, "/data/o'brien.csv");
    });
});

suite('parseLocalCsvImport: option parsing', () => {
    test('parses SKIP as a number', () => {
        const result = parseLocalCsvImport("IMPORT INTO t FROM LOCAL CSV FILE '/data/in.csv' SKIP = 1");
        assert.ok(result);
        assert.strictEqual(result.options.skip, 1);
    });

    test('parses COLUMN SEPARATOR', () => {
        const result = parseLocalCsvImport("IMPORT INTO t FROM LOCAL CSV FILE '/data/in.csv' COLUMN SEPARATOR = ';'");
        assert.ok(result);
        assert.strictEqual(result.options.columnSeparator, ';');
    });

    test('parses COLUMN DELIMITER', () => {
        const result = parseLocalCsvImport("IMPORT INTO t FROM LOCAL CSV FILE '/data/in.csv' COLUMN DELIMITER = '\"'");
        assert.ok(result);
        assert.strictEqual(result.options.columnDelimiter, '"');
    });

    test('parses ROW SEPARATOR into the RowSeparator enum', () => {
        const result = parseLocalCsvImport("IMPORT INTO t FROM LOCAL CSV FILE '/data/in.csv' ROW SEPARATOR = 'CRLF'");
        assert.ok(result);
        assert.strictEqual(result.options.rowSeparator, RowSeparator.CRLF);
    });

    test('parses ENCODING', () => {
        const result = parseLocalCsvImport("IMPORT INTO t FROM LOCAL CSV FILE '/data/in.csv' ENCODING = 'UTF-8'");
        assert.ok(result);
        assert.strictEqual(result.options.encoding, 'UTF-8');
    });

    test('parses NULL', () => {
        const result = parseLocalCsvImport("IMPORT INTO t FROM LOCAL CSV FILE '/data/in.csv' NULL = '\\N'");
        assert.ok(result);
        assert.strictEqual(result.options.null, '\\N');
    });

    test('parses TRIM, LTRIM, RTRIM into TrimMode', () => {
        const trim = parseLocalCsvImport("IMPORT INTO t FROM LOCAL CSV FILE '/data/in.csv' TRIM");
        assert.strictEqual(trim.options.trim, TrimMode.BOTH);
        const ltrim = parseLocalCsvImport("IMPORT INTO t FROM LOCAL CSV FILE '/data/in.csv' LTRIM");
        assert.strictEqual(ltrim.options.trim, TrimMode.LEADING);
        const rtrim = parseLocalCsvImport("IMPORT INTO t FROM LOCAL CSV FILE '/data/in.csv' RTRIM");
        assert.strictEqual(rtrim.options.trim, TrimMode.TRAILING);
    });

    test('parses multiple options together, tolerant of spacing', () => {
        const result = parseLocalCsvImport(
            "IMPORT INTO t FROM LOCAL CSV FILE '/data/in.csv' SKIP=2 COLUMN SEPARATOR='\\t' ROW SEPARATOR = 'LF'"
        );
        assert.ok(result);
        assert.strictEqual(result.options.skip, 2);
        assert.strictEqual(result.options.columnSeparator, '\\t');
        assert.strictEqual(result.options.rowSeparator, RowSeparator.LF);
    });
});

suite('parseLocalCsvImport: returns null for non-local-CSV statements', () => {
    test('returns null for a SELECT', () => {
        assert.strictEqual(parseLocalCsvImport('SELECT * FROM t'), null);
    });

    test('returns null for a cloud import (FROM CSV AT, no LOCAL)', () => {
        const sql = "IMPORT INTO t FROM CSV AT 'https://example.com/bucket' FILE '001.csv'";
        assert.strictEqual(parseLocalCsvImport(sql), null);
    });

    test('returns null for FROM LOCAL FBV FILE', () => {
        assert.strictEqual(parseLocalCsvImport("IMPORT INTO t FROM LOCAL FBV FILE '/data/in.fbv'"), null);
    });

    test('returns null for a comment-only string', () => {
        assert.strictEqual(parseLocalCsvImport('-- just a comment'), null);
    });
});

suite('parseLocalCsvImport: multiple files', () => {
    test('throws when the options clause contains another FILE token', () => {
        assert.throws(
            () => parseLocalCsvImport("IMPORT INTO t FROM LOCAL CSV FILE '/data/a.csv' FILE '/data/b.csv'"),
            /single FILE/
        );
    });
});

suite('parseLocalCsvImport: string-literal-aware option parsing (#3)', () => {
    test("NULL = 'FILE' parses without a false multi-file error", () => {
        const result = parseLocalCsvImport("IMPORT INTO t FROM LOCAL CSV FILE '/data/in.csv' NULL = 'FILE'");
        assert.ok(result, 'should detect the import');
        assert.strictEqual(result.options.null, 'FILE');
    });

    test("COLUMN SEPARATOR = 'SKIP' sets the separator, not skip", () => {
        const result = parseLocalCsvImport("IMPORT INTO t FROM LOCAL CSV FILE '/data/in.csv' COLUMN SEPARATOR = 'SKIP'");
        assert.ok(result);
        assert.strictEqual(result.options.columnSeparator, 'SKIP');
        assert.strictEqual(result.options.skip, undefined);
    });

    test('a quoted value containing TRIM is not misread as a trim mode', () => {
        const result = parseLocalCsvImport("IMPORT INTO t FROM LOCAL CSV FILE '/data/in.csv' NULL = 'TRIM'");
        assert.ok(result);
        assert.strictEqual(result.options.null, 'TRIM');
        assert.strictEqual(result.options.trim, undefined);
    });

    test("a quoted value containing ROW SEPARATOR is not misread as a row separator", () => {
        const result = parseLocalCsvImport("IMPORT INTO t FROM LOCAL CSV FILE '/data/in.csv' NULL = 'ROW SEPARATOR'");
        assert.ok(result);
        assert.strictEqual(result.options.null, 'ROW SEPARATOR');
        assert.strictEqual(result.options.rowSeparator, undefined);
    });

    test('still throws on a genuine second FILE token after a quoted option', () => {
        assert.throws(
            () => parseLocalCsvImport("IMPORT INTO t FROM LOCAL CSV FILE '/data/a.csv' NULL = 'x' FILE '/data/b.csv'"),
            /single FILE/
        );
    });
});
