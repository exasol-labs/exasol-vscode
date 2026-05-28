import * as assert from 'assert';
import { registerVscodeMock, registerExtensionMock, vscodeMock } from '../helpers/vscodeMock';

// vscode shape used by completionProvider
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
const { ExasolCompletionProvider } = require('../../providers/completionProvider');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createRawResult, TEST_CONNECTION } = require('../helpers/mockConnectionManager');

interface QueryCall { sql: string; }

function makeDriver(handler: (sql: string) => any) {
    return {
        query: async (sql: string) => handler(sql),
        execute: async (sql: string) => handler(sql),
    };
}

function makeManager(driver: any) {
    const calls: QueryCall[] = [];
    return {
        calls,
        manager: {
            getActiveConnection: () => ({ id: TEST_CONNECTION.id }),
            getDriver: async () => driver,
            executeWithRetry: async (fn: () => Promise<any>) => fn(),
        },
    };
}

function makeDocument(text: string, _cursorChar: number) {
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
        const provider = new ExasolCompletionProvider(manager);

        const sql = 'select * from "SCHEMA_A"."TABLE_X" as b\nwhere b.';
        const doc = makeDocument(sql, sql.length) as any;
        const pos = new (vscodeMock as any).Position(1, 8);
        const items = await provider.provideCompletionItems(doc, pos, {} as any, {} as any);

        const labels = items.map((i: any) => i.label).sort();
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
        const provider = new ExasolCompletionProvider(manager);

        const sql = 'select * from "SCHEMA_A"."TABLE_X" as b\nwhere b.';
        const doc = makeDocument(sql, sql.length) as any;
        const pos = new (vscodeMock as any).Position(1, 8);
        const items = await provider.provideCompletionItems(doc, pos, {} as any, {} as any);

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
        const provider = new ExasolCompletionProvider(manager);

        const sql = 'select * from ';
        const doc = makeDocument(sql, sql.length) as any;
        const pos = new (vscodeMock as any).Position(0, sql.length);
        const items = await provider.provideCompletionItems(doc, pos, {} as any, {} as any);

        const tableNames = items
            .filter((i: any) => i.detail && /table in /.test(i.detail))
            .map((i: any) => i.label);
        assert.deepStrictEqual(tableNames, ['good']);

        const schemaItems = items
            .filter((i: any) => i.detail === 'Schema')
            .map((i: any) => i.label)
            .sort();
        // SYS / EXA_STATISTICS are always pushed; user schema 'S' must be there; nulls/blank must be filtered.
        assert.ok(schemaItems.includes('s'));
        assert.ok(!schemaItems.includes(''));
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
        const provider = new ExasolCompletionProvider(manager);
        // Drive the lazy fetch directly for many distinct schema.table keys.
        const cap = (provider as any).COLUMNS_CACHE_MAX as number;
        const total = cap + 50;
        for (let i = 0; i < total; i++) {
            await (provider as any).getColumnsForTable('conn1', 'S', `T${i}`);
        }
        const size = ((provider as any).columnsCache as Map<string, string[]>).size;
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
        const provider = new ExasolCompletionProvider(manager);

        const sql = 'select * from s.t as a\nwhere a.';
        const doc = makeDocument(sql, sql.length) as any;
        const pos = new (vscodeMock as any).Position(1, 8);
        await provider.provideCompletionItems(doc, pos, {} as any, {} as any);
        await provider.provideCompletionItems(doc, pos, {} as any, {} as any);
        assert.strictEqual(columnQueries, 1, 'expected exactly one column fetch (second hit cache)');
    });
});
