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
    type RawResult,
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

function makeManager(driver: MockDriver): { manager: { getActiveConnection: () => { id: string }; getDriver: () => Promise<MockDriver>; executeWithRetry: <T>(fn: () => Promise<T>) => Promise<T> } } {
    return {
        manager: {
            getActiveConnection: () => ({ id: TEST_CONNECTION.id }),
            getDriver: async () => driver,
            executeWithRetry: async <T>(fn: () => Promise<T>) => fn(),
        },
    };
}

function defaultDriver(extra?: (sql: string) => RawResult | undefined): MockDriver {
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
        const provider = new ExasolCompletionProvider(manager as unknown as ConnectionManager);

        const sql = 'SELECT * FROM schema_d.table_dates WHERE ';
        const doc = makeDocument(sql);
        const pos = makePosition(0, sql.length);
        const items = await provider.provideCompletionItems(doc, pos, {} as vscode.CancellationToken, {} as vscode.CompletionContext);

        const col = items.find((i) => i.label === 'date_id');
        const schema = items.find((i) => i.label === 'schema_d');
        assert.ok(col, 'expected table_dates column "date_id"');
        assert.ok(schema, 'expected schema "schema_d"');
        assert.ok(
            (col.sortText ?? '') < (schema.sortText ?? ''),
            `columns must outrank schemas at WHERE; got col=${col.sortText} schema=${schema.sortText}`
        );

        // `local` keyword must be offered at WHERE so `local.` completes cleanly.
        const local = items.find((i) => i.label === 'local');
        assert.ok(local, 'expected "local" keyword at WHERE');
    });

    test('SELECT before FROM: columns rank above schemas', async () => {
        const driver = defaultDriver();
        const { manager } = makeManager(driver);
        const provider = new ExasolCompletionProvider(manager as unknown as ConnectionManager);

        const sql = 'SELECT  FROM schema_d.table_dates;';
        const doc = makeDocument(sql);
        // Cursor between SELECT and FROM (after the two spaces after SELECT)
        const pos = makePosition(0, 'SELECT '.length);
        const items = await provider.provideCompletionItems(doc, pos, {} as vscode.CancellationToken, {} as vscode.CompletionContext);

        const col = items.find((i) => i.label === 'date_id');
        const schema = items.find((i) => i.label === 'schema_d');
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
        const provider = new ExasolCompletionProvider(manager as unknown as ConnectionManager);

        const sql = '';
        const doc = makeDocument(sql);
        const pos = makePosition(0, 0);
        const items = await provider.provideCompletionItems(doc, pos, {} as vscode.CancellationToken, {} as vscode.CompletionContext);

        const select = items.find((i) => i.label === 'select');
        assert.ok(select, 'expected command keyword "select"');
        const schemaItems = items.filter((i) => i.detail === 'Schema');
        assert.strictEqual(schemaItems.length, 0, 'no schemas at statement start');
        // Command keywords use bucket "0_".
        assert.strictEqual(bucketPrefix(select.sortText), '0');
    });

    test('AFTER_FROM_OR_JOIN: schemas rank top', async () => {
        const driver = defaultDriver();
        const { manager } = makeManager(driver);
        const provider = new ExasolCompletionProvider(manager as unknown as ConnectionManager);

        const sql = 'SELECT * FROM ';
        const doc = makeDocument(sql);
        const pos = makePosition(0, sql.length);
        const items = await provider.provideCompletionItems(doc, pos, {} as vscode.CancellationToken, {} as vscode.CompletionContext);

        const schema = items.find((i) => i.detail === 'Schema');
        const keyword = items.find((i) => i.label === 'where');
        assert.ok(schema);
        assert.ok(keyword);
        assert.ok(
            (schema.sortText ?? '') < (keyword.sortText ?? ''),
            `schemas must outrank keywords after FROM; got schema=${schema.sortText} kw=${keyword.sortText}`
        );
    });
});
