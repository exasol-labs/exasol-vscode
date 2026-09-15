import * as assert from 'assert';
import { registerVscodeMock, registerExtensionMock, vscodeMock } from '../helpers/vscodeMock';
import { asConnectionManager, type ConfigWorkspaceMock, type FakeConnectionManager } from '../helpers/completionMocks';

// QueryExecutor reads exasol config (maxResultRows, queryTimeout) at execute()
// time; the per-test setup() below installs the config getter it needs.
// registerExtensionMock() is also required here (not just registerVscodeMock):
// queryExecutor.ts imports ./extension, which imports completionProvider.ts,
// whose static initializer touches vscode fields the minimal vscodeMock alone
// doesn't provide. Without this, the file crashes at load time when run on
// its own; it was previously only passing because another test file loaded
// earlier in the shared mocha process had already populated require.cache
// for ./extension, which is not something this file's own setup should rely
// on (confirmed by running `mocha ... queryExecutorRouting.test.ts` alone).
registerVscodeMock();
registerExtensionMock();

// Load after the vscode mock is configured.
const { QueryExecutor } = require('../../queryExecutor') as typeof import('../../queryExecutor');

import { createEmptyRawResult, TEST_CONNECTION } from '../helpers/mockConnectionManager';

interface DriverCalls {
    importFromCsvFile: unknown[][];
    importFromParquetFile: unknown[][];
    execute: unknown[][];
    query: unknown[][];
}

interface QueryExecutorVscodeMock {
    workspace: ConfigWorkspaceMock;
}

interface FakeQueryExecutorDriver {
    importFromCsvFile: (...args: unknown[]) => Promise<number>;
    importFromParquetFile: (...args: unknown[]) => Promise<number>;
    execute: (...args: unknown[]) => Promise<unknown>;
    query: (...args: unknown[]) => Promise<unknown>;
}

/**
 * Build a QueryExecutor wired to a fake ConnectionManager whose driver records
 * every call to importFromCsvFile / execute / query. The fake executeWithRetry
 * just invokes the supplied fn so routing logic runs unchanged.
 */
function makeExecutor(): { qe: InstanceType<typeof QueryExecutor>; calls: DriverCalls } {
    const calls: DriverCalls = { importFromCsvFile: [], importFromParquetFile: [], execute: [], query: [] };

    const fakeDriver = {
        importFromCsvFile: async (...args: unknown[]) => {
            calls.importFromCsvFile.push(args);
            return 42;
        },
        importFromParquetFile: async (...args: unknown[]) => {
            calls.importFromParquetFile.push(args);
            return 43;
        },
        // rawExecute -> driver.execute(sql, undefined, undefined, 'raw')
        execute: async (...args: unknown[]) => {
            calls.execute.push(args);
            return createEmptyRawResult([]);
        },
        // rawQuery -> driver.query(sql, undefined, undefined, 'raw')
        query: async (...args: unknown[]) => {
            calls.query.push(args);
            return createEmptyRawResult([]);
        }
    };

    const fakeConnectionManager: FakeConnectionManager<FakeQueryExecutorDriver> = {
        getActiveConnection: () => TEST_CONNECTION,
        getDriver: async () => fakeDriver,
        executeWithRetry: async (fn) => fn()
    };

    return { qe: new QueryExecutor(asConnectionManager(fakeConnectionManager)), calls };
}

suite('QueryExecutor.execute routing: local CSV import interception', () => {
    setup(() => {
        // Other test files share the singleton vscodeMock and may overwrite
        // workspace; re-establish the config getter QueryExecutor.execute reads.
        (vscodeMock as unknown as QueryExecutorVscodeMock).workspace = {
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
        // (captureBaselineStatementIdentity), a local CSV import is still a
        // real IMPORT statement from Exasol's own perspective and still gets
        // profiled, so this path captures the same plan-lookup identity as
        // every other statement type, not a second attempt at the import.
        assert.strictEqual(calls.query.length, 1);
        const identitySql = calls.query[0][0];
        assert.ok(typeof identitySql === 'string');
        assert.ok(identitySql.includes('CURRENT_SESSION'));

        assert.strictEqual(result.rowCount, 42);
    });

    test('a cloud import (FROM CSV AT) does not call importFromCsvFile and goes through execute()', async () => {
        const { qe, calls } = makeExecutor();

        await qe.execute("IMPORT INTO t FROM CSV AT 'https://h' FILE '001.csv'");

        assert.strictEqual(calls.importFromCsvFile.length, 0, 'must not intercept a cloud import');
        // IMPORT is classified as a non-result-set command, so it routes to execute().
        assert.strictEqual(calls.execute.length, 1, 'cloud import should go through raw execute()');
        // The one query() call is the pre-execution SESSION_ID/STMT_ID capture
        // (captureBaselineStatementIdentity), not a second attempt at the import itself.
        assert.strictEqual(calls.query.length, 1);
        const identitySql = calls.query[0][0];
        assert.ok(typeof identitySql === 'string');
        assert.ok(identitySql.includes('CURRENT_SESSION'));
    });
});

suite('QueryExecutor.execute routing: local Parquet import interception', () => {
    setup(() => {
        (vscodeMock as unknown as QueryExecutorVscodeMock).workspace = {
            getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback })
        };
    });

    test('a LOCAL Parquet import calls the driver API and passes an AbortSignal', async () => {
        const { qe, calls } = makeExecutor();
        const result = await qe.execute("IMPORT INTO t FROM LOCAL PARQUET FILE '/abs/x.parquet'");

        assert.strictEqual(calls.importFromParquetFile.length, 1);
        const [table, absPath, parquetOptions, importOptions] = calls.importFromParquetFile[0];
        assert.strictEqual(table, 't');
        assert.strictEqual(absPath, '/abs/x.parquet');
        assert.deepStrictEqual(parquetOptions, {});
        assert.ok(importOptions && typeof importOptions === 'object' && 'signal' in importOptions);
        assert.strictEqual(calls.execute.length, 0);
        assert.strictEqual(result.rowCount, 43);
    });
});
