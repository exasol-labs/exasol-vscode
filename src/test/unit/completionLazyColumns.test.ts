import * as assert from 'assert';
import type * as vscode from 'vscode';
import type { ConnectionManager } from '../../connectionManager';
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

interface QueryCall { sql: string; }

// Deliberate partial double for ConnectionManager (only the methods the
// provider calls); callers cast the `manager` field with `as unknown as
// ConnectionManager` since a full typed double would be larger than the test.
function makeManager(driver: MockDriver): { calls: QueryCall[]; manager: { getActiveConnection: () => { id: string }; getDriver: () => Promise<MockDriver>; executeWithRetry: <T>(fn: () => Promise<T>) => Promise<T> } } {
    const calls: QueryCall[] = [];
    return {
        calls,
        manager: {
            getActiveConnection: () => ({ id: TEST_CONNECTION.id }),
            getDriver: async () => driver,
            executeWithRetry: async <T>(fn: () => Promise<T>) => fn(),
        },
    };
}

// Exposes the completion provider's private caching internals for the cache-cap
// test below; a typed peek is smaller and clearer than reimplementing the cache.
interface CompletionProviderInternals {
    COLUMNS_CACHE_MAX: number;
    columnsCache: Map<string, string[]>;
    getColumnsForTable(connectionId: string, schema: string, table: string): Promise<string[] | undefined>;
}

suite('ExasolCompletionProvider - lazy column fetch', () => {
    test('alias path fetches columns lazily on demand', async () => {
        const seenSql: string[] = [];
        const driver = makeDriver((sql: string) => {
            seenSql.push(sql);
            if (sql.includes('exa_sql_keywords')) {
                return createRawResult(['KEYWORD'], [['SELECT']]);
            }
            if (sql.includes('EXA_ALL_TABLES')) {
                return createRawResult(
                    ['TABLE_SCHEMA', 'TABLE_NAME', 'OBJECT_TYPE'],
                    [['SCHEMA_A', 'TABLE_X', 'table']]
                );
            }
            if (sql.includes('EXA_ALL_COLUMNS')) {
                // single-table targeted query
                assert.match(sql, /COLUMN_SCHEMA = 'SCHEMA_A'/);
                assert.match(sql, /COLUMN_TABLE = 'TABLE_X'/);
                return createRawResult(['COLUMN_NAME'], [['COL_A'], ['COL_D'], ['COL_C']]);
            }
            // every other metadata fetch -> empty
            return createRawResult(['TABLE_SCHEMA', 'TABLE_NAME'], []);
        });
        const { manager } = makeManager(driver);
        const provider = new ExasolCompletionProvider(manager as unknown as ConnectionManager);

        const sql = 'select * from "SCHEMA_A"."TABLE_X" as b\nwhere b.';
        const doc = makeDocument(sql);
        const pos = makePosition(1, 8);
        const items = await provider.provideCompletionItems(doc, pos, {} as vscode.CancellationToken, {} as vscode.CompletionContext);

        const labels = items.map((i) => i.label).sort();
        assert.deepStrictEqual(labels, ['col_a', 'col_c', 'col_d']);
        // Bulk EXA_ALL_COLUMNS scan must NOT be issued anymore.
        const bulkScan = seenSql.find(s =>
            s.includes('EXA_ALL_COLUMNS') &&
            !s.includes('COLUMN_TABLE =')
        );
        assert.strictEqual(bulkScan, undefined, 'unexpected bulk EXA_ALL_COLUMNS scan');
    });

    test('column fetch error returns [] (not schema list)', async () => {
        const driver = makeDriver((sql: string) => {
            if (sql.includes('exa_sql_keywords')) {
                return createRawResult(['KEYWORD'], [['SELECT']]);
            }
            if (sql.includes('EXA_ALL_TABLES')) {
                return createRawResult(
                    ['TABLE_SCHEMA', 'TABLE_NAME', 'OBJECT_TYPE'],
                    [['SCHEMA_A', 'TABLE_X', 'table'], ['PUBLIC', 'X', 'table']]
                );
            }
            if (sql.includes('COLUMN_TABLE =')) {
                throw new Error('SQL Error [42X99]: Received packet type not expected');
            }
            return createRawResult(['TABLE_SCHEMA', 'TABLE_NAME'], []);
        });
        const { manager } = makeManager(driver);
        const provider = new ExasolCompletionProvider(manager as unknown as ConnectionManager);

        const sql = 'select * from "SCHEMA_A"."TABLE_X" as b\nwhere b.';
        const doc = makeDocument(sql);
        const pos = makePosition(1, 8);
        const items = await provider.provideCompletionItems(doc, pos, {} as vscode.CancellationToken, {} as vscode.CompletionContext);

        // Bug A regression: must NOT fall through to schema/object suggestions.
        assert.deepStrictEqual(items, []);
    });

    test('null TABLE_NAME / TABLE_SCHEMA rows are skipped, no crash (Bug B)', async () => {
        const driver = makeDriver((sql: string) => {
            if (sql.includes('exa_sql_keywords')) {
                return createRawResult(['KEYWORD'], [['SELECT']]);
            }
            if (sql.includes('EXA_ALL_TABLES')) {
                return createRawResult(
                    ['TABLE_SCHEMA', 'TABLE_NAME', 'OBJECT_TYPE'],
                    [
                        [null, 'X', 'table'],
                        ['S', null, 'table'],
                        ['S', 'GOOD', 'table'],
                    ]
                );
            }
            if (sql.includes('EXA_SCHEMAS')) {
                return createRawResult(['SCHEMA_NAME'], [['S'], [null], ['']]);
            }
            return createRawResult(['TABLE_SCHEMA', 'TABLE_NAME'], []);
        });
        const { manager } = makeManager(driver);
        const provider = new ExasolCompletionProvider(manager as unknown as ConnectionManager);

        const sql = 'select * from ';
        const doc = makeDocument(sql);
        const pos = makePosition(0, sql.length);
        const items = await provider.provideCompletionItems(doc, pos, {} as vscode.CancellationToken, {} as vscode.CompletionContext);

        const tableNames = items
            .filter((i) => i.detail && /table in /.test(i.detail))
            .map((i) => i.label);
        assert.deepStrictEqual(tableNames, ['good']);

        const schemaItems = items
            .filter((i) => i.detail === 'Schema')
            .map((i) => i.label)
            .sort();
        // SYS / EXA_STATISTICS are always pushed; user schema 'S' must be there; nulls/blank must be filtered.
        assert.ok(schemaItems.includes('s'));
        assert.ok(!schemaItems.includes(''));
    });

    test('schema and table queries exclude virtual objects, which are merged separately', async () => {
        const seenSql: string[] = [];
        const driver = makeDriver((sql: string) => {
            seenSql.push(sql);
            if (sql.includes('exa_sql_keywords')) {
                return createRawResult(['KEYWORD'], [['SELECT']]);
            }
            return createRawResult(['TABLE_SCHEMA', 'TABLE_NAME'], []);
        });
        const { manager } = makeManager(driver);
        const provider = new ExasolCompletionProvider(manager as unknown as ConnectionManager);

        const sql = 'select * from ';
        await provider.provideCompletionItems(makeDocument(sql), makePosition(0, sql.length), {} as vscode.CancellationToken, {} as vscode.CompletionContext);

        const schemasSql = seenSql.find(q => q.includes('SYS.EXA_SCHEMAS'));
        assert.ok(schemasSql?.includes('SCHEMA_IS_VIRTUAL = FALSE'), `Got: ${schemasSql}`);
        const tablesSql = seenSql.find(q => q.includes('SYS.EXA_ALL_TABLES'));
        assert.ok(tablesSql?.includes('TABLE_IS_VIRTUAL = FALSE'), `Got: ${tablesSql}`);
    });

    test('columnsCache stays under soft cap when many tables are queried', async () => {
        const driver = makeDriver((sql: string) => {
            if (sql.includes('exa_sql_keywords')) {
                return createRawResult(['KEYWORD'], [['SELECT']]);
            }
            if (sql.includes('COLUMN_TABLE =')) {
                return createRawResult(['COLUMN_NAME'], [['C1']]);
            }
            return createRawResult(['TABLE_SCHEMA', 'TABLE_NAME'], []);
        });
        const { manager } = makeManager(driver);
        const provider = new ExasolCompletionProvider(manager as unknown as ConnectionManager);
        // Drive the lazy fetch directly for many distinct schema.table keys.
        const internals = provider as unknown as CompletionProviderInternals;
        const cap = internals.COLUMNS_CACHE_MAX;
        const total = cap + 50;
        for (let i = 0; i < total; i++) {
            await internals.getColumnsForTable('conn1', 'S', `T${i}`);
        }
        const size = internals.columnsCache.size;
        assert.ok(size <= cap, `columnsCache size ${size} exceeded cap ${cap}`);
    });

    test('per-table column cache hits avoid a second query', async () => {
        let columnQueries = 0;
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
                columnQueries++;
                return createRawResult(['COLUMN_NAME'], [['C1']]);
            }
            return createRawResult(['TABLE_SCHEMA', 'TABLE_NAME'], []);
        });
        const { manager } = makeManager(driver);
        const provider = new ExasolCompletionProvider(manager as unknown as ConnectionManager);

        const sql = 'select * from s.t as a\nwhere a.';
        const doc = makeDocument(sql);
        const pos = makePosition(1, 8);
        await provider.provideCompletionItems(doc, pos, {} as vscode.CancellationToken, {} as vscode.CompletionContext);
        await provider.provideCompletionItems(doc, pos, {} as vscode.CancellationToken, {} as vscode.CompletionContext);
        assert.strictEqual(columnQueries, 1, 'expected exactly one column fetch (second hit cache)');
    });

    test('a quoted lowercase table gets its columns, queried with the stored names', async () => {
        const columnQueries: string[] = [];
        const driver = makeDriver((sql: string) => {
            if (sql.includes('exa_sql_keywords')) {
                return createRawResult(['KEYWORD'], [['SELECT']]);
            }
            if (sql.includes('EXA_ALL_TABLES')) {
                // Stored as created with CREATE TABLE S."lower v" (docker, 2026-10-22).
                return createRawResult(['TABLE_SCHEMA', 'TABLE_NAME', 'OBJECT_TYPE'], [['S', 'lower v', 'table']]);
            }
            if (sql.includes('COLUMN_TABLE =')) {
                columnQueries.push(sql);
                return createRawResult(['COLUMN_NAME'], [['c one'], ['C2']]);
            }
            return createRawResult(['TABLE_SCHEMA', 'TABLE_NAME'], []);
        });
        const { manager } = makeManager(driver);
        const provider = new ExasolCompletionProvider(manager as unknown as ConnectionManager);

        for (const sql of ['select * from s."lower v" x\nwhere x.', 'select * from s."lower v"\nwhere ']) {
            const lines = sql.split('\n');
            const items = await provider.provideCompletionItems(
                makeDocument(sql), makePosition(1, lines[1].length), {} as vscode.CancellationToken, {} as vscode.CompletionContext
            );
            const labels = items.map(i => typeof i.label === 'string' ? i.label : i.label.label);
            assert.ok(labels.some(l => l.includes('c one')), `no column of "lower v" in ${JSON.stringify(labels)}`);
        }
        assert.strictEqual(columnQueries.length, 1, 'the second lookup should hit the cache');
        assert.match(columnQueries[0], /COLUMN_SCHEMA = 'S' AND COLUMN_TABLE = 'lower v'/);
    });

    test('columns of SYS and EXA_STATISTICS tables come from EXA_SYS_COLUMNS', async () => {
        const seenSql: string[] = [];
        const driver = makeDriver((sql: string) => {
            seenSql.push(sql);
            return createRawResult(['COLUMN_NAME'], [['USER_NAME']]);
        });
        const { manager } = makeManager(driver);
        const provider = new ExasolCompletionProvider(manager as unknown as ConnectionManager);
        const internals = provider as unknown as CompletionProviderInternals;

        assert.deepStrictEqual(await internals.getColumnsForTable('conn1', 'SYS', 'EXA_DBA_USERS'), ['USER_NAME']);
        await internals.getColumnsForTable('conn1', 'EXA_STATISTICS', 'EXA_DBA_AUDIT_SQL');
        await internals.getColumnsForTable('conn1', 'MY_SCHEMA', 'T');

        assert.deepStrictEqual(seenSql.map(sql => /FROM (SYS\.EXA_\w+_COLUMNS)/.exec(sql)?.[1]), [
            'SYS.EXA_SYS_COLUMNS', 'SYS.EXA_SYS_COLUMNS', 'SYS.EXA_ALL_COLUMNS'
        ]);
    });
});
