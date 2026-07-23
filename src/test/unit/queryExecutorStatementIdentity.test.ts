import * as assert from 'assert';
import { registerVscodeMock, registerExtensionMock, vscodeMock } from '../helpers/vscodeMock';

registerVscodeMock();
registerExtensionMock();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { QueryExecutor } = require('../../queryExecutor');

import { createEmptyRawResult, createRawResult } from '../helpers/mockConnectionManager';

/**
 * Builds a QueryExecutor whose fake driver returns `mainResult` for the real
 * statement's query()/execute() call, and, if `identityRows` is given,
 * SESSION_ID/STMT_ID rows for the baseline identity-capture query
 * captureBaselineStatementIdentity() issues *before* the real statement.
 */
function makeExecutor(options: { mainResult: any; identityRows?: any[] | 'throw'; executionPlanAvailable?: boolean }): { qe: any; queryCalls: string[] } {
    const queryCalls: string[] = [];

    const fakeDriver = {
        execute: async () => options.mainResult,
        query: async (sql: string) => {
            queryCalls.push(sql);
            if (sql.includes('CURRENT_SESSION')) {
                if (options.identityRows === 'throw') {
                    throw new Error('simulated identity capture failure');
                }
                return createRawResult(['SID', 'STID'], options.identityRows ?? []);
            }
            return options.mainResult;
        }
    };

    const fakeConnectionManager = {
        getActiveConnection: () => ({ id: 'conn-1', name: 'Test' }),
        isExecutionPlanAvailable: () => options.executionPlanAvailable ?? true,
        getDriver: async () => fakeDriver,
        executeWithRetry: async (fn: () => Promise<any>) => fn()
    };

    return { qe: new QueryExecutor(fakeConnectionManager), queryCalls };
}

suite('QueryExecutor.execute: baseline statement identity capture', () => {
    setup(() => {
        (vscodeMock as any).workspace = {
            getConfiguration: () => ({
                get: (_key: string, fallback?: unknown) => fallback
            })
        };
    });

    test('attaches sessionId/baselineStmtId to a SELECT result when capture succeeds', async () => {
        const { qe } = makeExecutor({
            mainResult: createRawResult(['X'], [[1]]),
            identityRows: [[42, 7]]
        });

        const result = await qe.execute('SELECT 1 AS X');

        assert.strictEqual(result.sessionId, '42');
        assert.strictEqual(result.baselineStmtId, '7');
    });

    test('attaches the originating connectionId so the plan can be looked up against the right connection later', async () => {
        const { qe } = makeExecutor({
            mainResult: createRawResult(['X'], [[1]]),
            identityRows: [[42, 7]]
        });

        const result = await qe.execute('SELECT 1 AS X');

        assert.strictEqual(result.connectionId, 'conn-1', 'must record which connection actually ran the query');
    });

    test('attaches sessionId/baselineStmtId to a DDL/DML result (execute() path) too', async () => {
        const { qe } = makeExecutor({
            mainResult: createEmptyRawResult([]),
            identityRows: [[100, 3]]
        });

        const result = await qe.execute('CREATE TABLE t (x INT)');

        assert.strictEqual(result.sessionId, '100');
        assert.strictEqual(result.baselineStmtId, '3');
    });

    test('captures the baseline before the real statement runs, not after', async () => {
        const calls: string[] = [];
        const fakeDriver = {
            query: async (sql: string) => {
                calls.push(sql);
                if (sql.includes('CURRENT_SESSION')) {
                    return createRawResult(['SID', 'STID'], [[1, 1]]);
                }
                return createRawResult(['X'], [[1]]);
            }
        };
        const fakeConnectionManager = {
            getActiveConnection: () => ({ id: 'conn-1', name: 'Test' }),
            getDriver: async () => fakeDriver,
            executeWithRetry: async (fn: () => Promise<any>) => fn()
        };
        const qe = new QueryExecutor(fakeConnectionManager);

        await qe.execute('SELECT 1 AS X');

        assert.strictEqual(calls.length, 2);
        assert.ok(calls[0].includes('CURRENT_SESSION'), 'baseline capture must be the first call, before the real query');
        assert.strictEqual(calls[1], 'SELECT 1 AS X LIMIT 10000');
    });

    test('round-trips a session id larger than Number.MAX_SAFE_INTEGER without truncation', async () => {
        const huge = '1871214140502573056';
        const { qe } = makeExecutor({
            mainResult: createRawResult(['X'], [[1]]),
            identityRows: [[huge, '16']]
        });

        const result = await qe.execute('SELECT 1 AS X');

        assert.strictEqual(result.sessionId, huge, 'must preserve every digit, not a rounded double');
    });

    test('leaves sessionId/baselineStmtId undefined (not throw) when identity capture fails', async () => {
        const { qe } = makeExecutor({
            mainResult: createRawResult(['X'], [[1]]),
            identityRows: 'throw'
        });

        const result = await qe.execute('SELECT 1 AS X');

        assert.strictEqual(result.sessionId, undefined);
        assert.strictEqual(result.baselineStmtId, undefined);
        assert.strictEqual(result.rows.length, 1, 'the actual query result must still come through');
    });

    test('leaves sessionId/baselineStmtId undefined when the identity query returns no rows', async () => {
        const { qe } = makeExecutor({
            mainResult: createRawResult(['X'], [[1]]),
            identityRows: []
        });

        const result = await qe.execute('SELECT 1 AS X');

        assert.strictEqual(result.sessionId, undefined);
        assert.strictEqual(result.baselineStmtId, undefined);
    });

    test('does not capture identity when execution plans are disabled', async () => {
        (vscodeMock as any).workspace = {
            getConfiguration: () => ({
                get: (key: string, fallback?: unknown) => key === 'executionPlan' ? false : fallback
            })
        };
        const { qe, queryCalls } = makeExecutor({
            mainResult: createRawResult(['X'], [[1]]),
            identityRows: [[42, 7]]
        });

        const result = await qe.execute('SELECT 1 AS X');

        assert.strictEqual(queryCalls.length, 1, 'only the real SELECT should run');
        assert.ok(!queryCalls[0].includes('CURRENT_SESSION'));
        assert.strictEqual(result.sessionId, undefined);
        assert.strictEqual(result.baselineStmtId, undefined);
    });

    test('does not capture identity when connection-time profiling setup failed', async () => {
        const { qe, queryCalls } = makeExecutor({
            mainResult: createRawResult(['X'], [[1]]),
            identityRows: [[42, 7]],
            executionPlanAvailable: false
        });

        const result = await qe.execute('SELECT 1 AS X');

        assert.strictEqual(queryCalls.length, 1, 'only the real SELECT should run');
        assert.ok(!queryCalls[0].includes('CURRENT_SESSION'));
        assert.strictEqual(result.sessionId, undefined);
        assert.strictEqual(result.baselineStmtId, undefined);
    });

    test('does not inflate executionTime with the baseline capture round-trip', async () => {
        let queryCallCount = 0;
        const fakeDriver = {
            query: async (sql: string) => {
                queryCallCount++;
                if (sql.includes('CURRENT_SESSION')) {
                    // Simulate the baseline capture itself taking a while.
                    await new Promise(resolve => setTimeout(resolve, 50));
                    return createRawResult(['SID', 'STID'], [[1, 1]]);
                }
                return createRawResult(['X'], [[1]]);
            }
        };
        const fakeConnectionManager = {
            getActiveConnection: () => ({ id: 'conn-1', name: 'Test' }),
            getDriver: async () => fakeDriver,
            executeWithRetry: async (fn: () => Promise<any>) => fn()
        };
        const qe = new QueryExecutor(fakeConnectionManager);

        const result = await qe.execute('SELECT 1 AS X');

        assert.strictEqual(queryCallCount, 2);
        assert.ok(result.executionTime < 40, `executionTime (${result.executionTime}ms) should exclude the ~50ms baseline capture`);
    });

    test('captures identity for a local CSV import too — it is still a real, profiled IMPORT statement', async () => {
        const calls: string[] = [];
        const fakeDriver = {
            importFromCsvFile: async () => 5,
            query: async (sql: string) => {
                calls.push(sql);
                if (sql.includes('CURRENT_SESSION')) {
                    return createRawResult(['SID', 'STID'], [[42, 7]]);
                }
                return createEmptyRawResult([]);
            }
        };
        const fakeConnectionManager = {
            getActiveConnection: () => ({ id: 'conn-1', name: 'Test' }),
            getDriver: async () => fakeDriver,
            executeWithRetry: async (fn: () => Promise<any>) => fn()
        };
        const qe = new QueryExecutor(fakeConnectionManager);

        const result = await qe.execute("IMPORT INTO t FROM LOCAL CSV FILE '/abs/x.csv'");

        assert.strictEqual(calls.length, 1, 'the baseline identity capture must run once, before the import');
        assert.ok(calls[0].includes('CURRENT_SESSION'));
        assert.strictEqual(result.sessionId, '42');
        assert.strictEqual(result.baselineStmtId, '7');
        assert.strictEqual(result.connectionId, 'conn-1');
        assert.strictEqual(result.rowCount, 5, 'the actual import result must still come through');
    });

    test('leaves sessionId/baselineStmtId undefined (not throw) when identity capture fails for a local CSV import', async () => {
        const fakeDriver = {
            importFromCsvFile: async () => 5,
            query: async () => { throw new Error('simulated identity capture failure'); }
        };
        const fakeConnectionManager = {
            getActiveConnection: () => ({ id: 'conn-1', name: 'Test' }),
            getDriver: async () => fakeDriver,
            executeWithRetry: async (fn: () => Promise<any>) => fn()
        };
        const qe = new QueryExecutor(fakeConnectionManager);

        const result = await qe.execute("IMPORT INTO t FROM LOCAL CSV FILE '/abs/x.csv'");

        assert.strictEqual(result.sessionId, undefined);
        assert.strictEqual(result.baselineStmtId, undefined);
        assert.strictEqual(result.rowCount, 5, 'the import itself must still succeed even if identity capture fails');
    });

    test('does not inflate executionTime with the baseline capture round-trip, for a local CSV import too', async () => {
        let queryCallCount = 0;
        const fakeDriver = {
            importFromCsvFile: async () => 5,
            query: async () => {
                queryCallCount++;
                // Simulate the baseline capture itself taking a while.
                await new Promise(resolve => setTimeout(resolve, 50));
                return createRawResult(['SID', 'STID'], [[1, 1]]);
            }
        };
        const fakeConnectionManager = {
            getActiveConnection: () => ({ id: 'conn-1', name: 'Test' }),
            getDriver: async () => fakeDriver,
            executeWithRetry: async (fn: () => Promise<any>) => fn()
        };
        const qe = new QueryExecutor(fakeConnectionManager);

        const result = await qe.execute("IMPORT INTO t FROM LOCAL CSV FILE '/abs/x.csv'");

        assert.strictEqual(queryCallCount, 1);
        assert.ok(result.executionTime < 40, `executionTime (${result.executionTime}ms) should exclude the ~50ms baseline capture`);
    });
});
