import * as assert from 'assert';
import { registerVscodeMock, registerExtensionMock, vscodeMock } from '../helpers/vscodeMock';

// QueryExecutor reads exasol config (maxResultRows, queryTimeout) at execute()
// time; the per-test setup() below installs the config getter it needs.
// registerExtensionMock() is also required here (not just registerVscodeMock):
// queryExecutor.ts imports ./extension, which imports completionProvider.ts,
// whose static initializer touches vscode fields the minimal vscodeMock alone
// doesn't provide. Without this, the file crashes at load time when run on
// its own — it was previously only passing because another test file loaded
// earlier in the shared mocha process had already populated require.cache
// for ./extension, which is not something this file's own setup should rely
// on (confirmed by running `mocha ... queryExecutorRouting.test.ts` alone).
registerVscodeMock();
registerExtensionMock();

// Load after the vscode mock is configured.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { QueryExecutor } = require('../../queryExecutor');

import { createEmptyRawResult } from '../helpers/mockConnectionManager';

interface DriverCalls {
    importFromCsvFile: any[][];
    execute: any[][];
    query: any[][];
}

/**
 * Build a QueryExecutor wired to a fake ConnectionManager whose driver records
 * every call to importFromCsvFile / execute / query. The fake executeWithRetry
 * just invokes the supplied fn so routing logic runs unchanged.
 */
function makeExecutor(): { qe: any; calls: DriverCalls } {
    const calls: DriverCalls = { importFromCsvFile: [], execute: [], query: [] };

    const fakeDriver = {
        importFromCsvFile: async (...args: any[]) => {
            calls.importFromCsvFile.push(args);
            return 42;
        },
        // rawExecute -> driver.execute(sql, undefined, undefined, 'raw')
        execute: async (...args: any[]) => {
            calls.execute.push(args);
            return createEmptyRawResult([]);
        },
        // rawQuery -> driver.query(sql, undefined, undefined, 'raw')
        query: async (...args: any[]) => {
            calls.query.push(args);
            return createEmptyRawResult([]);
        }
    };

    const fakeConnectionManager = {
        getActiveConnection: () => ({ id: 'conn-1', name: 'Test' }),
        getDriver: async () => fakeDriver,
        executeWithRetry: async (fn: () => Promise<any>) => fn()
    };

    return { qe: new QueryExecutor(fakeConnectionManager), calls };
}

suite('QueryExecutor.execute routing: local CSV import interception', () => {
    setup(() => {
        // Other test files share the singleton vscodeMock and may overwrite
        // workspace; re-establish the config getter QueryExecutor.execute reads.
        (vscodeMock as any).workspace = {
            getConfiguration: () => ({
                get: (_key: string, fallback?: unknown) => fallback
            })
        };
    });

    test('a LOCAL CSV import calls importFromCsvFile, bypasses raw execute(), but still captures plan identity', async () => {
        const { qe, calls } = makeExecutor();

        const result = await qe.execute("IMPORT INTO t FROM LOCAL CSV FILE '/abs/x.csv'");

        assert.strictEqual(calls.importFromCsvFile.length, 1, 'should call importFromCsvFile once');
        const [table, absPath] = calls.importFromCsvFile[0];
        assert.strictEqual(table, 't');
        assert.strictEqual(absPath, '/abs/x.csv');

        assert.strictEqual(calls.execute.length, 0, 'must not hit raw execute()');
        // The one query() call is the baseline SESSION_ID/STMT_ID capture
        // (captureBaselineStatementIdentity) — a local CSV import is still a
        // real IMPORT statement from Exasol's own perspective and still gets
        // profiled, so this path captures the same plan-lookup identity as
        // every other statement type, not a second attempt at the import.
        assert.strictEqual(calls.query.length, 1);
        assert.ok(calls.query[0][0].includes('CURRENT_SESSION'));

        assert.strictEqual(result.rowCount, 42);
    });

    test('a cloud import (FROM CSV AT) does not call importFromCsvFile and goes through execute()', async () => {
        const { qe, calls } = makeExecutor();

        await qe.execute("IMPORT INTO t FROM CSV AT 'https://h' FILE '001.csv'");

        assert.strictEqual(calls.importFromCsvFile.length, 0, 'must not intercept a cloud import');
        // IMPORT is classified as a non-result-set command, so it routes to execute().
        assert.strictEqual(calls.execute.length, 1, 'cloud import should go through raw execute()');
        // The one query() call is the post-execution SESSION_ID/STMT_ID capture
        // (captureStatementIdentity), not a second attempt at the import itself.
        assert.strictEqual(calls.query.length, 1);
        assert.ok(calls.query[0][0].includes('CURRENT_SESSION'));
    });
});
