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
        manager: {
            getActiveConnection: () => ({ id: TEST_CONNECTION.id }),
            getDriver: async () => driver,
            executeWithRetry: async (fn: () => Promise<any>) => fn(),
        },
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

function defaultDriver(extra?: (sql: string) => any) {
    return makeDriver((sql: string) => {
        if (sql.includes('exa_sql_keywords')) {
            return createRawResult(['KEYWORD'], [['SELECT']]);
        }
        if (sql.includes('EXA_ALL_TABLES')) {
            return createRawResult(
                ['TABLE_SCHEMA', 'TABLE_NAME', 'OBJECT_TYPE'],
                [['SCHEMA_D', 'TABLE_DATES', 'table']]
            );
        }
        if (sql.includes('EXA_SCHEMAS')) {
            return createRawResult(['SCHEMA_NAME'], [['SCHEMA_D'], ['PUBLIC']]);
        }
        if (sql.includes('COLUMN_TABLE =')) {
            return createRawResult(['COLUMN_NAME'], [['DATE_ID'], ['YEAR'], ['MONTH']]);
        }
        if (extra) {
            const r = extra(sql);
            if (r) { return r; }
        }
        return createRawResult(['TABLE_SCHEMA', 'TABLE_NAME'], []);
    });
}

function bucketPrefix(sortText: string | undefined): string {
    if (!sortText) { return ''; }
    return sortText.split('_')[0];
}

suite('ExasolCompletionProvider - context-driven sortText buckets', () => {
    test('WHERE after FROM: column items rank above schema items', async () => {
        const driver = defaultDriver();
        const { manager } = makeManager(driver);
        const provider = new ExasolCompletionProvider(manager);

        const sql = 'SELECT * FROM schema_d.table_dates WHERE ';
        const doc = makeDocument(sql) as any;
        const pos = new (vscodeMock as any).Position(0, sql.length);
        const items = await provider.provideCompletionItems(doc, pos, {} as any, {} as any);

        const col = items.find((i: any) => i.label === 'date_id');
        const schema = items.find((i: any) => i.label === 'schema_d');
        assert.ok(col, 'expected table_dates column "date_id"');
        assert.ok(schema, 'expected schema "schema_d"');
        assert.ok(
            (col.sortText ?? '') < (schema.sortText ?? ''),
            `columns must outrank schemas at WHERE; got col=${col.sortText} schema=${schema.sortText}`
        );

        // `local` keyword must be offered at WHERE so `local.` completes cleanly.
        const local = items.find((i: any) => i.label === 'local');
        assert.ok(local, 'expected "local" keyword at WHERE');
    });

    test('SELECT before FROM: columns rank above schemas', async () => {
        const driver = defaultDriver();
        const { manager } = makeManager(driver);
        const provider = new ExasolCompletionProvider(manager);

        const sql = 'SELECT  FROM schema_d.table_dates;';
        const doc = makeDocument(sql) as any;
        // Cursor between SELECT and FROM (after the two spaces after SELECT)
        const pos = new (vscodeMock as any).Position(0, 'SELECT '.length);
        const items = await provider.provideCompletionItems(doc, pos, {} as any, {} as any);

        const col = items.find((i: any) => i.label === 'date_id');
        const schema = items.find((i: any) => i.label === 'schema_d');
        assert.ok(col, 'expected table_dates column');
        assert.ok(schema, 'expected schema');
        assert.ok(
            (col.sortText ?? '') < (schema.sortText ?? ''),
            `columns must outrank schemas at SELECT list; got col=${col.sortText} schema=${schema.sortText}`
        );
    });

    test('STATEMENT_START: command keywords rank top, no schemas surfaced', async () => {
        const driver = defaultDriver();
        const { manager } = makeManager(driver);
        const provider = new ExasolCompletionProvider(manager);

        const sql = '';
        const doc = makeDocument(sql) as any;
        const pos = new (vscodeMock as any).Position(0, 0);
        const items = await provider.provideCompletionItems(doc, pos, {} as any, {} as any);

        const select = items.find((i: any) => i.label === 'select');
        assert.ok(select, 'expected command keyword "select"');
        const schemaItems = items.filter((i: any) => i.detail === 'Schema');
        assert.strictEqual(schemaItems.length, 0, 'no schemas at statement start');
        // Command keywords use bucket "0_".
        assert.strictEqual(bucketPrefix(select.sortText), '0');
    });

    test('AFTER_FROM_OR_JOIN: schemas rank top', async () => {
        const driver = defaultDriver();
        const { manager } = makeManager(driver);
        const provider = new ExasolCompletionProvider(manager);

        const sql = 'SELECT * FROM ';
        const doc = makeDocument(sql) as any;
        const pos = new (vscodeMock as any).Position(0, sql.length);
        const items = await provider.provideCompletionItems(doc, pos, {} as any, {} as any);

        const schema = items.find((i: any) => i.detail === 'Schema');
        const keyword = items.find((i: any) => i.label === 'where');
        assert.ok(schema);
        assert.ok(keyword);
        assert.ok(
            (schema.sortText ?? '') < (keyword.sortText ?? ''),
            `schemas must outrank keywords after FROM; got schema=${schema.sortText} kw=${keyword.sortText}`
        );
    });
});
