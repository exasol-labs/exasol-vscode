import * as assert from 'assert';
import { registerVscodeMock, vscodeMock } from '../helpers/vscodeMock';

// QueryExecutor reads exasol config (maxResultRows, queryTimeout) at execute()
// time; the per-test setup() below installs the config getter it needs.
registerVscodeMock();

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

    test('a LOCAL CSV import calls importFromCsvFile and bypasses raw execute/query', async () => {
        const { qe, calls } = makeExecutor();

        const result = await qe.execute("IMPORT INTO t FROM LOCAL CSV FILE '/abs/x.csv'");

        assert.strictEqual(calls.importFromCsvFile.length, 1, 'should call importFromCsvFile once');
        const [table, absPath] = calls.importFromCsvFile[0];
        assert.strictEqual(table, 't');
        assert.strictEqual(absPath, '/abs/x.csv');

        assert.strictEqual(calls.execute.length, 0, 'must not hit raw execute()');
        assert.strictEqual(calls.query.length, 0, 'must not hit raw query()');

        assert.strictEqual(result.rowCount, 42);
    });

    test('a cloud import (FROM CSV AT) does not call importFromCsvFile and goes through execute()', async () => {
        const { qe, calls } = makeExecutor();

        await qe.execute("IMPORT INTO t FROM CSV AT 'https://h' FILE '001.csv'");

        assert.strictEqual(calls.importFromCsvFile.length, 0, 'must not intercept a cloud import');
        // IMPORT is classified as a non-result-set command, so it routes to execute().
        assert.strictEqual(calls.execute.length, 1, 'cloud import should go through raw execute()');
        assert.strictEqual(calls.query.length, 0);
    });
});
