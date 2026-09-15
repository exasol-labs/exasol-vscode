import * as assert from 'assert';
import type * as vscode from 'vscode';
import type { ConnectionManager } from '../../connectionManager';
import type { CteDefinition } from '../../utils/cteParser';
import { parseCtes } from '../../utils/cteParser';
// createRawResult/mockConnectionManager imports no vscode (only a type-only
// import, fully erased at compile time), so a static import is safe here.
import { createRawResult, TEST_CONNECTION } from '../helpers/mockConnectionManager';
import { registerVscodeMock, registerExtensionMock, vscodeMock } from '../helpers/vscodeMock';
import {
    applyCompletionVscodeMock,
    makeDocument,
    makeDriver,
    makePosition,
    type MockDriver,
} from '../helpers/completionMocks';

// Mocks must be applied BEFORE registerVscodeMock(); see the load-order note
// at the top of completionMocks.ts.
applyCompletionVscodeMock(vscodeMock);

registerVscodeMock();
registerExtensionMock();

// completionProvider.ts imports `vscode` at module scope, so it must stay a
// deferred require() issued AFTER the mocks above are registered. A static
// import would resolve 'vscode' before require.cache is patched.
const { ExasolCompletionProvider } = require('../../providers/completionProvider') as typeof import('../../providers/completionProvider');

// Deliberate partial double for ConnectionManager (only the methods the
// provider calls); callers cast it with `as unknown as ConnectionManager`
// since a full typed double would be larger than the test.
function makeManager(driver: MockDriver): { getActiveConnection: () => { id: string }; getDriver: () => Promise<MockDriver>; executeWithRetry: <T>(fn: () => Promise<T>) => Promise<T> } {
    return {
        getActiveConnection: () => ({ id: TEST_CONNECTION.id }),
        getDriver: async () => driver,
        executeWithRetry: async <T>(fn: () => Promise<T>) => fn(),
    };
}

function metadataOnlyDriver(): MockDriver {
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
        assert.deepStrictEqual(ctes.map((c: CteDefinition) => c.name), ['a', 'b']);
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
        const provider = new ExasolCompletionProvider(makeManager(driver) as unknown as ConnectionManager);

        const sql = `WITH test AS (
  SELECT b.col_a, b.col_b FROM SCHEMA_A.TABLE_X AS b
  WHERE b.col_a = '90'
)
SELECT * FROM test AS t
WHERE t.`;
        const doc = makeDocument(sql);
        // Last line is "WHERE t."
        const lastLineIdx = sql.split('\n').length - 1;
        const pos = makePosition(lastLineIdx, 'WHERE t.'.length);
        const items = await provider.provideCompletionItems(doc, pos, {} as vscode.CancellationToken, {} as vscode.CompletionContext);

        const labels = items.map((i) => i.label);
        assert.deepStrictEqual(labels, ['col_a', 'col_b']);
    });

    test('direct CTE reference: test.| (no alias) suggests CTE columns', async () => {
        const driver = metadataOnlyDriver();
        const provider = new ExasolCompletionProvider(makeManager(driver) as unknown as ConnectionManager);

        const sql = `WITH test AS (SELECT a, b FROM t)
SELECT test. FROM test`;
        const doc = makeDocument(sql);
        const pos = makePosition(1, 'SELECT test.'.length);
        const items = await provider.provideCompletionItems(doc, pos, {} as vscode.CancellationToken, {} as vscode.CompletionContext);
        const labels = items.map((i) => i.label);
        assert.deepStrictEqual(labels, ['a', 'b']);
    });

    test('CTE column completions sort in source order, not alphabetical', async () => {
        const driver = metadataOnlyDriver();
        const provider = new ExasolCompletionProvider(makeManager(driver) as unknown as ConnectionManager);

        const sql = `WITH t AS (SELECT z, a, m FROM x)
SELECT * FROM t AS s WHERE s.`;
        const doc = makeDocument(sql);
        const pos = makePosition(1, 'SELECT * FROM t AS s WHERE s.'.length);
        const items = await provider.provideCompletionItems(doc, pos, {} as vscode.CancellationToken, {} as vscode.CompletionContext);

        const bySortText = [...items].sort((x, y) =>
            (x.sortText ?? '').localeCompare(y.sortText ?? '')
        );
        assert.deepStrictEqual(bySortText.map((i) => i.label), ['z', 'a', 'm']);
    });

    test('CTE does not leak across statements in the same document', async () => {
        const driver = metadataOnlyDriver();
        const provider = new ExasolCompletionProvider(makeManager(driver) as unknown as ConnectionManager);

        const sql = `WITH test AS (SELECT a, b FROM t1) SELECT * FROM test;
SELECT test. FROM test;`;
        const doc = makeDocument(sql);
        // Cursor on the second statement (line index 1). The CTE from line 0 must
        // not leak into the second statement, so completion returns no CTE-based
        // suggestions; without a real catalog match, the result should be [].
        const pos = makePosition(1, 'SELECT test.'.length);
        const items = await provider.provideCompletionItems(doc, pos, {} as vscode.CancellationToken, {} as vscode.CompletionContext);
        // The first statement's CTE name must NOT contribute completions here.
        const labels = items.map((i) => i.label);
        assert.ok(!labels.includes('a'));
        assert.ok(!labels.includes('b'));
    });

    test('SELECT * body falls through (no CTE columns to suggest)', async () => {
        const driver = metadataOnlyDriver();
        const provider = new ExasolCompletionProvider(makeManager(driver) as unknown as ConnectionManager);

        const sql = `WITH test AS (SELECT * FROM t)
SELECT * FROM test AS s WHERE s.`;
        const doc = makeDocument(sql);
        const pos = makePosition(1, 'SELECT * FROM test AS s WHERE s.'.length);
        const items = await provider.provideCompletionItems(doc, pos, {} as vscode.CancellationToken, {} as vscode.CompletionContext);
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
        const provider = new ExasolCompletionProvider(makeManager(driver) as unknown as ConnectionManager);

        const sql = 'select * from s.t as x\nwhere x.';
        const doc = makeDocument(sql);
        const pos = makePosition(1, 'where x.'.length);
        const items = await provider.provideCompletionItems(doc, pos, {} as vscode.CancellationToken, {} as vscode.CompletionContext);

        const bySortText = [...items].sort((a, b) =>
            (a.sortText ?? '').localeCompare(b.sortText ?? '')
        );
        assert.deepStrictEqual(bySortText.map((i) => i.label), ['z', 'a', 'm']);
    });
});
