import * as assert from 'assert';
import { registerVscodeMock, registerExtensionMock, vscodeMock } from '../helpers/vscodeMock';

(vscodeMock as any).CompletionItemKind = {
    Interface: 7, Method: 1, Function: 2, Class: 6, Module: 8, Field: 4, Keyword: 13,
};
(vscodeMock as any).CompletionItem = class {
    detail?: string;
    insertText?: any;
    sortText?: string;
    documentation?: any;
    constructor(public label: string, public kind?: number) {}
};
(vscodeMock as any).MarkdownString = class { constructor(public value: string) {} };
(vscodeMock as any).SnippetString = class { constructor(public value: string) {} };
(vscodeMock as any).workspace = {
    getConfiguration: () => ({ get: (_: string, dflt?: unknown) => dflt }),
};
(vscodeMock as any).Position = class { constructor(public line: number, public character: number) {} };
(vscodeMock as any).Range = class {};

registerVscodeMock();
registerExtensionMock();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseCtes } = require('../../utils/cteParser');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ExasolCompletionProvider } = require('../../providers/completionProvider');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createRawResult, TEST_CONNECTION } = require('../helpers/mockConnectionManager');

function makeDriver(handler: (sql: string) => any) {
    return {
        query: async (sql: string) => handler(sql),
        execute: async (sql: string) => handler(sql),
    };
}

function makeManager(driver: any) {
    return {
        getActiveConnection: () => ({ id: TEST_CONNECTION.id }),
        getDriver: async () => driver,
        executeWithRetry: async (fn: () => Promise<any>) => fn(),
    };
}

function makeDocument(text: string) {
    const lines = text.split('\n');
    return {
        getText: () => text,
        lineAt: (lineOrPos: any) => {
            const line = typeof lineOrPos === 'number' ? lineOrPos : lineOrPos.line;
            return { text: lines[line] ?? '' };
        },
        getWordRangeAtPosition: () => undefined,
    };
}

function metadataOnlyDriver() {
    return makeDriver((sql: string) => {
        if (sql.includes('exa_sql_keywords')) {
            return createRawResult(['KEYWORD'], [['SELECT']]);
        }
        // Pretend the catalog has no tables/views matching the CTE name.
        return createRawResult(['TABLE_SCHEMA', 'TABLE_NAME'], []);
    });
}

suite('parseCtes', () => {
    test('bug-report fixture: single CTE referenced via alias', () => {
        const stmt = `WITH test AS (
  SELECT b.col_a, b.col_b FROM SCHEMA_A.TABLE_X AS b
  WHERE b.col_a = '90'
)
SELECT * FROM test AS t
WHERE t.col
LIMIT 100`;
        const ctes = parseCtes(stmt);
        assert.strictEqual(ctes.length, 1);
        assert.strictEqual(ctes[0].name, 'test');
        assert.deepStrictEqual(ctes[0].columns, ['col_a', 'col_b']);
    });

    test('WITH RECURSIVE is supported', () => {
        const stmt = `WITH RECURSIVE foo AS (SELECT a, b FROM bar) SELECT * FROM foo`;
        const ctes = parseCtes(stmt);
        assert.strictEqual(ctes.length, 1);
        assert.strictEqual(ctes[0].name, 'foo');
        assert.deepStrictEqual(ctes[0].columns, ['a', 'b']);
    });

    test('explicit column list overrides the body SELECT list', () => {
        const stmt = `WITH foo (a, b) AS (SELECT x, y FROM t) SELECT * FROM foo`;
        const ctes = parseCtes(stmt);
        assert.strictEqual(ctes.length, 1);
        assert.deepStrictEqual(ctes[0].columns, ['a', 'b']);
    });

    test('multiple chained CTEs both resolve', () => {
        const stmt = `WITH
            a AS (SELECT one, two FROM t1),
            b AS (SELECT three FROM t2)
            SELECT * FROM a JOIN b ON a.one = b.three`;
        const ctes = parseCtes(stmt);
        assert.deepStrictEqual(ctes.map((c: any) => c.name), ['a', 'b']);
        assert.deepStrictEqual(ctes[0].columns, ['one', 'two']);
        assert.deepStrictEqual(ctes[1].columns, ['three']);
    });

    test('SELECT * body returns empty columns', () => {
        const stmt = `WITH foo AS (SELECT * FROM t) SELECT * FROM foo`;
        const ctes = parseCtes(stmt);
        assert.strictEqual(ctes.length, 1);
        assert.deepStrictEqual(ctes[0].columns, []);
    });

    test('table.* body also returns empty columns', () => {
        const stmt = `WITH foo AS (SELECT t.* FROM t) SELECT * FROM foo`;
        assert.deepStrictEqual(parseCtes(stmt)[0].columns, []);
    });

    test('no WITH keyword returns []', () => {
        assert.deepStrictEqual(parseCtes('SELECT * FROM t'), []);
    });

    test('nested parens inside CTE body do not confuse the parser', () => {
        const stmt = `WITH foo AS (
            SELECT (CASE WHEN x > 0 THEN 1 ELSE 0 END) AS flag, b.id
            FROM t b
        ) SELECT * FROM foo`;
        const ctes = parseCtes(stmt);
        assert.deepStrictEqual(ctes[0].columns, ['flag', 'id']);
    });

    test('quoted CTE name and quoted column list', () => {
        const stmt = `WITH "MyCte" ("A", "B") AS (SELECT 1, 2) SELECT * FROM "MyCte"`;
        const ctes = parseCtes(stmt);
        assert.strictEqual(ctes[0].name, 'MyCte');
        assert.deepStrictEqual(ctes[0].columns, ['A', 'B']);
    });

    test('comments inside the WITH clause are ignored', () => {
        const stmt = `WITH foo AS ( -- pull col_as
            SELECT col_a, /* total */ col_b FROM t
        ) SELECT * FROM foo`;
        const ctes = parseCtes(stmt);
        assert.deepStrictEqual(ctes[0].columns, ['col_a', 'col_b']);
    });
});

suite('ExasolCompletionProvider - CTE column completion', () => {
    test('bug-report: t.| inside WITH test AS (...) suggests CTE columns in source order', async () => {
        const driver = metadataOnlyDriver();
        const provider = new ExasolCompletionProvider(makeManager(driver));

        const sql = `WITH test AS (
  SELECT b.col_a, b.col_b FROM SCHEMA_A.TABLE_X AS b
  WHERE b.col_a = '90'
)
SELECT * FROM test AS t
WHERE t.`;
        const doc = makeDocument(sql) as any;
        // Last line is "WHERE t."
        const lastLineIdx = sql.split('\n').length - 1;
        const pos = new (vscodeMock as any).Position(lastLineIdx, 'WHERE t.'.length);
        const items = await provider.provideCompletionItems(doc, pos, {} as any, {} as any);

        const labels = items.map((i: any) => i.label);
        assert.deepStrictEqual(labels, ['col_a', 'col_b']);
    });

    test('direct CTE reference: test.| (no alias) suggests CTE columns', async () => {
        const driver = metadataOnlyDriver();
        const provider = new ExasolCompletionProvider(makeManager(driver));

        const sql = `WITH test AS (SELECT a, b FROM t)
SELECT test. FROM test`;
        const doc = makeDocument(sql) as any;
        const pos = new (vscodeMock as any).Position(1, 'SELECT test.'.length);
        const items = await provider.provideCompletionItems(doc, pos, {} as any, {} as any);
        const labels = items.map((i: any) => i.label);
        assert.deepStrictEqual(labels, ['a', 'b']);
    });

    test('CTE column completions sort in source order, not alphabetical', async () => {
        const driver = metadataOnlyDriver();
        const provider = new ExasolCompletionProvider(makeManager(driver));

        const sql = `WITH t AS (SELECT z, a, m FROM x)
SELECT * FROM t AS s WHERE s.`;
        const doc = makeDocument(sql) as any;
        const pos = new (vscodeMock as any).Position(1, 'SELECT * FROM t AS s WHERE s.'.length);
        const items = await provider.provideCompletionItems(doc, pos, {} as any, {} as any);

        const bySortText = [...items].sort((x: any, y: any) =>
            (x.sortText ?? '').localeCompare(y.sortText ?? '')
        );
        assert.deepStrictEqual(bySortText.map((i: any) => i.label), ['z', 'a', 'm']);
    });

    test('CTE does not leak across statements in the same document', async () => {
        const driver = metadataOnlyDriver();
        const provider = new ExasolCompletionProvider(makeManager(driver));

        const sql = `WITH test AS (SELECT a, b FROM t1) SELECT * FROM test;
SELECT test. FROM test;`;
        const doc = makeDocument(sql) as any;
        // Cursor on the second statement (line index 1). The CTE from line 0 must
        // not leak into the second statement, so completion returns no CTE-based
        // suggestions; without a real catalog match, the result should be [].
        const pos = new (vscodeMock as any).Position(1, 'SELECT test.'.length);
        const items = await provider.provideCompletionItems(doc, pos, {} as any, {} as any);
        // The first statement's CTE name must NOT contribute completions here.
        const labels = items.map((i: any) => i.label);
        assert.ok(!labels.includes('a'));
        assert.ok(!labels.includes('b'));
    });

    test('SELECT * body falls through (no CTE columns to suggest)', async () => {
        const driver = metadataOnlyDriver();
        const provider = new ExasolCompletionProvider(makeManager(driver));

        const sql = `WITH test AS (SELECT * FROM t)
SELECT * FROM test AS s WHERE s.`;
        const doc = makeDocument(sql) as any;
        const pos = new (vscodeMock as any).Position(1, 'SELECT * FROM test AS s WHERE s.'.length);
        const items = await provider.provideCompletionItems(doc, pos, {} as any, {} as any);
        // No catalog table named 'test' either -> empty.
        assert.deepStrictEqual(items, []);
    });
});

suite('ExasolCompletionProvider - sortText preserves source order', () => {
    test('column array [z, a, m] -> sortText sorts as z, a, m', async () => {
        // Drive the column path with a catalog table whose columns come back
        // in non-alphabetical order; ensure CompletionItems sort lexically by
        // sortText into the SAME order, not alphabetical.
        const driver = makeDriver((sql: string) => {
            if (sql.includes('exa_sql_keywords')) {
                return createRawResult(['KEYWORD'], [['SELECT']]);
            }
            if (sql.includes('EXA_ALL_TABLES')) {
                return createRawResult(
                    ['TABLE_SCHEMA', 'TABLE_NAME', 'OBJECT_TYPE'],
                    [['S', 'T', 'table']]
                );
            }
            if (sql.includes('COLUMN_TABLE =')) {
                return createRawResult(['COLUMN_NAME'], [['Z'], ['A'], ['M']]);
            }
            return createRawResult(['TABLE_SCHEMA', 'TABLE_NAME'], []);
        });
        const provider = new ExasolCompletionProvider(makeManager(driver));

        const sql = 'select * from s.t as x\nwhere x.';
        const doc = makeDocument(sql) as any;
        const pos = new (vscodeMock as any).Position(1, 'where x.'.length);
        const items = await provider.provideCompletionItems(doc, pos, {} as any, {} as any);

        const bySortText = [...items].sort((a: any, b: any) =>
            (a.sortText ?? '').localeCompare(b.sortText ?? '')
        );
        assert.deepStrictEqual(bySortText.map((i: any) => i.label), ['z', 'a', 'm']);
    });
});
