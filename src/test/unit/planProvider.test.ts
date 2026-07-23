import * as assert from 'assert';
import { registerVscodeMock, registerExtensionMock } from '../helpers/vscodeMock';

registerVscodeMock();
registerExtensionMock();

// Loaded after the vscode/extension mocks are configured, matching the
// convention in queryExecutorRouting.test.ts / objectActions.test.ts.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PlanProvider, RETRY_DELAYS_AFTER_FLUSH_FAILURE_MS } = require('../../plan/planProvider');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { BACKGROUND_QUERY_TIMEOUT_MS } = require('../../connectionManager');

import { createRawResult, createEmptyRawResult, createRawErrorResult, TEST_CONNECTION } from '../helpers/mockConnectionManager';

// afterStmtId is a baseline (CURRENT_STATEMENT read before the real query
// ran), not the real query's own STMT_ID — see planProvider.ts's file header.
// Both are exact digit strings end-to-end; real Exasol SESSION_IDs exceed
// what a JS number can represent exactly.
const TARGET = { sessionId: '42', afterStmtId: '3' };

const DETAILS_COLUMNS = ['SESSION_ID', 'STMT_ID', 'PART_ID', 'IPROC', 'PART_NAME', 'OUT_ROWS', 'DURATION'];
const SUMMARY_COLUMNS = ['SESSION_ID', 'STMT_ID', 'PART_ID', 'PART_NAME', 'OUT_ROWS', 'DURATION'];

// Resolved STMT_ID (7) is greater than the baseline (3), as it must be.
function detailsRow(): any[] {
    return [42, 7, 1, 0, 'PIPE SCAN', 1000, 0.5];
}

function summaryRow(): any[] {
    return [42, 7, 1, 'SCAN', 1000, 0.5];
}

interface Call { method: 'query' | 'execute'; sql: string }

/**
 * Builds a PlanProvider wired to a fake driver. `queryResponses` are consumed
 * in order by each rawQuery() call (the tier-fetch attempts); the FLUSH
 * STATISTICS call (rawExecute) always succeeds unless `flushThrows` or
 * `flushReturnsError` is set. These model the two distinct ways a raw-mode
 * driver call can fail: a thrown exception (e.g. connection reset) vs. a
 * returned {status:'error'} response with no throw at all (e.g. a genuine
 * SQL-level error like insufficient privilege — verified against the real
 * driver's source, which only throws for the 'default' response type).
 */
function makeProvider(
    queryResponses: Array<() => any>,
    options: { flushThrows?: boolean; flushReturnsError?: boolean; retryOptions?: any } = {}
): { provider: any; calls: Call[] } {
    const calls: Call[] = [];
    let callIndex = 0;

    const fakeDriver = {
        execute: async (sql: string) => {
            calls.push({ method: 'execute', sql });
            if (options.flushThrows) {
                throw new Error('simulated FLUSH STATISTICS failure');
            }
            if (options.flushReturnsError) {
                return createRawErrorResult('42500', 'insufficient privileges to execute FLUSH STATISTICS');
            }
            return createEmptyRawResult([]);
        },
        query: async (sql: string) => {
            calls.push({ method: 'query', sql });
            const respond = queryResponses[callIndex++];
            if (!respond) {
                throw new Error(`Unexpected extra driver query() call: ${sql}`);
            }
            return respond();
        }
    };

    const fakeConnectionManager = {
        getDriver: async (_connectionId?: string, _role?: string) => fakeDriver,
        executeWithRetry: async (fn: () => Promise<any>) => fn()
    };

    return { provider: new PlanProvider(fakeConnectionManager, options.retryOptions), calls };
}

function queryCalls(calls: Call[]): Call[] {
    return calls.filter(c => c.method === 'query');
}

suite('PlanProvider.getPlan', () => {

    test('flushes statistics before attempting any tier', async () => {
        const { provider, calls } = makeProvider([
            () => createRawResult(DETAILS_COLUMNS, [detailsRow()])
        ]);

        await provider.getPlan(TEST_CONNECTION, TARGET);

        assert.strictEqual(calls[0].method, 'execute');
        assert.ok(calls[0].sql.includes('FLUSH STATISTICS'));
        assert.strictEqual(calls[1].method, 'query');
    });

    test('a FLUSH STATISTICS failure does not block the fetch (best-effort)', async () => {
        const { provider } = makeProvider(
            [() => createRawResult(DETAILS_COLUMNS, [detailsRow()])],
            { flushThrows: true }
        );

        const plan = await provider.getPlan(TEST_CONNECTION, TARGET);
        assert.strictEqual(plan.source, 'DETAILS');
    });

    test('a FLUSH STATISTICS returned-error response (no throw) is still treated as a flush failure, using the long retry schedule', async () => {
        // Regression test: rawExecute() requests the driver's 'raw' response
        // type, which never throws on a SQL-level error (verified against the
        // real driver's source — it only calls verifyNoError() for 'default'
        // responses). The old code awaited rawExecute() and discarded the
        // result without checking it, so a privilege-denied FLUSH STATISTICS
        // returned normally, flushSucceeded stayed true, and the short
        // 3-round schedule was used instead of the long one — reintroducing
        // the exact false "No profiling data found" bug this schedule split
        // exists to prevent.
        const empty = () => createEmptyRawResult(SUMMARY_COLUMNS);
        const responses: Array<() => any> = [];
        for (let round = 0; round < 5; round++) {
            responses.push(empty, empty, empty);
        }
        const { provider, calls } = makeProvider(responses, {
            flushReturnsError: true,
            retryOptions: { retryDelaysAfterFlushFailureMs: [0, 0, 0, 0, 0] }
        });

        await assert.rejects(() => provider.getPlan(TEST_CONNECTION, TARGET), /No profiling data found/);

        assert.strictEqual(
            queryCalls(calls).length, 15,
            'a returned-error flush response must be treated as a flush failure (5-round schedule), not a success (3-round schedule)'
        );
    });

    test('returns a plan from the first (DETAILS) tier when it succeeds', async () => {
        const { provider, calls } = makeProvider([
            () => createRawResult(DETAILS_COLUMNS, [detailsRow()])
        ]);

        const plan = await provider.getPlan(TEST_CONNECTION, TARGET);

        const qCalls = queryCalls(calls);
        assert.strictEqual(qCalls.length, 1);
        assert.ok(qCalls[0].sql.includes('$EXA_PROFILE_DETAILS_LAST_DAY'));
        assert.strictEqual(plan.source, 'DETAILS');
        assert.strictEqual(plan.nodes.length, 1);
    });

    test('the resolved stmtId on the returned Plan comes from the actual row data, not the baseline', async () => {
        const { provider } = makeProvider([
            () => createRawResult(DETAILS_COLUMNS, [detailsRow()])
        ]);

        const plan = await provider.getPlan(TEST_CONNECTION, TARGET);

        assert.strictEqual(plan.stmtId, '7', 'must be the resolved STMT_ID (7), not the baseline afterStmtId (3)');
    });

    test('falls back to DBA_SUMMARY when DETAILS is denied by privilege', async () => {
        const { provider, calls } = makeProvider([
            () => ({ status: 'error', responseData: {}, exception: { sqlCode: '42500', text: 'insufficient privileges for accessing view' } }),
            () => createRawResult(SUMMARY_COLUMNS, [summaryRow()])
        ]);

        const plan = await provider.getPlan(TEST_CONNECTION, TARGET);

        const qCalls = queryCalls(calls);
        assert.strictEqual(qCalls.length, 2);
        assert.ok(qCalls[1].sql.includes('EXA_DBA_PROFILE_LAST_DAY'));
        assert.strictEqual(plan.source, 'DBA_SUMMARY');
    });

    test('falls back all the way to USER_SUMMARY when both privileged tiers are denied', async () => {
        const { provider, calls } = makeProvider([
            () => ({ status: 'error', responseData: {}, exception: { sqlCode: '42500', text: 'insufficient privileges for accessing view' } }),
            () => ({ status: 'error', responseData: {}, exception: { sqlCode: '42500', text: 'insufficient privileges for accessing view' } }),
            () => createRawResult(SUMMARY_COLUMNS, [summaryRow()])
        ]);

        const plan = await provider.getPlan(TEST_CONNECTION, TARGET);

        const qCalls = queryCalls(calls);
        assert.strictEqual(qCalls.length, 3);
        assert.ok(qCalls[2].sql.includes('EXA_USER_PROFILE_LAST_DAY'));
        assert.strictEqual(plan.source, 'USER_SUMMARY');
    });

    test('also falls back when a tier reports the object does not exist (schema-drift defense)', async () => {
        const { provider, calls } = makeProvider([
            () => ({ status: 'error', responseData: {}, exception: { sqlCode: '42000', text: 'object "$EXA_PROFILE_DETAILS_LAST_DAY" not found' } }),
            () => createRawResult(SUMMARY_COLUMNS, [summaryRow()])
        ]);

        const plan = await provider.getPlan(TEST_CONNECTION, TARGET);

        assert.strictEqual(queryCalls(calls).length, 2);
        assert.strictEqual(plan.source, 'DBA_SUMMARY');
    });

    test('fails fast with a clear permission message when every tier is denied by privilege', async () => {
        const deniedByPrivilege = () => ({ status: 'error', responseData: {}, exception: { sqlCode: '42500', text: 'insufficient privileges for accessing view' } });
        const { provider, calls } = makeProvider([deniedByPrivilege, deniedByPrivilege, deniedByPrivilege]);

        await assert.rejects(
            () => provider.getPlan(TEST_CONNECTION, TARGET),
            (error: Error) => {
                assert.ok(error.message.includes("doesn't have permission"));
                assert.ok(error.message.includes('SELECT ANY DICTIONARY'));
                assert.ok(!error.message.includes('No profiling data found'), 'must not use the generic timing-oriented message');
                return true;
            }
        );
        assert.strictEqual(queryCalls(calls).length, 3, 'must fail after the first round — retrying a hard permission wall cannot help');
    });

    test('does not fail fast when the fallback chain is a mix of privilege denial and genuinely empty tiers', async function () {
        // DETAILS denied by privilege, but USER_SUMMARY was *reached* and is
        // just empty (e.g. profiling was never turned on) — this is still
        // worth the normal retry/generic-message path, since it's not a
        // permission wall on every tier.
        this.timeout(5000);
        const deniedByPrivilege = () => ({ status: 'error', responseData: {}, exception: { sqlCode: '42500', text: 'insufficient privileges for accessing view' } });
        const { provider, calls } = makeProvider([
            deniedByPrivilege, () => createEmptyRawResult(SUMMARY_COLUMNS), () => createEmptyRawResult(SUMMARY_COLUMNS),
            deniedByPrivilege, () => createEmptyRawResult(SUMMARY_COLUMNS), () => createEmptyRawResult(SUMMARY_COLUMNS),
            deniedByPrivilege, () => createEmptyRawResult(SUMMARY_COLUMNS), () => createEmptyRawResult(SUMMARY_COLUMNS)
        ]);

        await assert.rejects(
            () => provider.getPlan(TEST_CONNECTION, TARGET),
            (error: Error) => {
                assert.ok(error.message.includes('No profiling data found'));
                return true;
            }
        );
        assert.strictEqual(queryCalls(calls).length, 9, 'all 3 rounds should still run since it is not a hard permission wall');
    });

    test('throws a descriptive "no profiling data" error when every tier returns zero rows on every retry round', async function () {
        this.timeout(5000); // exhausts the full [0, 500, 1000]ms retry budget
        const { provider, calls } = makeProvider([
            () => createEmptyRawResult(DETAILS_COLUMNS), () => createEmptyRawResult(SUMMARY_COLUMNS), () => createEmptyRawResult(SUMMARY_COLUMNS),
            () => createEmptyRawResult(DETAILS_COLUMNS), () => createEmptyRawResult(SUMMARY_COLUMNS), () => createEmptyRawResult(SUMMARY_COLUMNS),
            () => createEmptyRawResult(DETAILS_COLUMNS), () => createEmptyRawResult(SUMMARY_COLUMNS), () => createEmptyRawResult(SUMMARY_COLUMNS)
        ]);

        await assert.rejects(
            () => provider.getPlan(TEST_CONNECTION, TARGET),
            (error: Error) => {
                assert.ok(error.message.includes('No profiling data found'));
                assert.ok(error.message.includes('42'));
                assert.ok(error.message.includes('3'));
                assert.ok(error.message.includes('FLUSH STATISTICS'));
                return true;
            }
        );
        assert.strictEqual(queryCalls(calls).length, 9, 'all 3 tiers attempted on all 3 retry rounds');
    });

    test('the flush-failure retry schedule outlasts the ~9s cross-connection propagation delay', () => {
        // A FLUSH STATISTICS failure (e.g. no flush privilege) means the data
        // only becomes visible from this background session after Exasol's own
        // ~8-9s cross-connection propagation. The retry window for that case
        // must comfortably exceed it, or a user with read (but not flush)
        // access gets a false "no profiling data found".
        const total = RETRY_DELAYS_AFTER_FLUSH_FAILURE_MS.reduce((a: number, b: number) => a + b, 0);
        assert.ok(total > 9000, `flush-failure retry window (${total}ms) must comfortably exceed the ~8-9s propagation delay`);
    });

    test('when FLUSH STATISTICS fails, polls the longer flush-failure schedule (more rounds) before giving up', async () => {
        // FLUSH fails and every tier is genuinely empty on every round. The
        // fetch must run one full fallback pass per entry in the flush-failure
        // schedule — more rounds than the 3-round post-flush-success path —
        // rather than reporting "no data" after the short window. Delays are
        // zeroed here so the assertion is about round count, not wall-clock.
        const empty = () => createEmptyRawResult(SUMMARY_COLUMNS);
        const responses: Array<() => any> = [];
        for (let round = 0; round < 5; round++) {
            responses.push(empty, empty, empty);
        }
        const { provider, calls } = makeProvider(responses, {
            flushThrows: true,
            retryOptions: { retryDelaysAfterFlushFailureMs: [0, 0, 0, 0, 0] }
        });

        await assert.rejects(() => provider.getPlan(TEST_CONNECTION, TARGET), /No profiling data found/);

        assert.strictEqual(
            queryCalls(calls).length, 15,
            'must run all 5 flush-failure rounds x 3 tiers (not the 3-round post-flush-success schedule)'
        );
    });

    test('when FLUSH STATISTICS succeeds, uses the short 3-round schedule, not the flush-failure one', async function () {
        // Contrast to the test above: flush succeeded, so the data should be
        // visible almost immediately — no reason to poll the long schedule.
        this.timeout(5000);
        const empty = () => createEmptyRawResult(SUMMARY_COLUMNS);
        const responses: Array<() => any> = [];
        for (let round = 0; round < 3; round++) {
            responses.push(empty, empty, empty);
        }
        const { provider, calls } = makeProvider(responses); // flush succeeds (default)

        await assert.rejects(() => provider.getPlan(TEST_CONNECTION, TARGET), /No profiling data found/);

        assert.strictEqual(queryCalls(calls).length, 9, 'post-flush-success path is the short 3-round schedule');
    });

    test('a non-recoverable error propagates immediately without trying further tiers or retry rounds', async () => {
        const { provider, calls } = makeProvider([
            () => { throw new Error('connection reset'); }
        ]);

        await assert.rejects(
            () => provider.getPlan(TEST_CONNECTION, TARGET),
            /connection reset/
        );
        assert.strictEqual(queryCalls(calls).length, 1, 'must not attempt further tiers or retry rounds after a non-recoverable error');
    });

    test('rejects a non-digit-string sessionId/afterStmtId before ever touching the driver', async () => {
        const { provider, calls } = makeProvider([() => createRawResult(SUMMARY_COLUMNS, [summaryRow()])]);

        await assert.rejects(() => provider.getPlan(TEST_CONNECTION, { sessionId: 'not-a-number', afterStmtId: '7' }));
        assert.strictEqual(calls.length, 0, 'not even the flush should run');
    });

    test('fetches via the background driver role with the background query timeout', async () => {
        let capturedRole: string | undefined;
        let capturedTimeout: number | undefined;

        const fakeDriver = {
            execute: async () => createEmptyRawResult([]),
            query: async () => createRawResult(SUMMARY_COLUMNS, [summaryRow()])
        };
        const fakeConnectionManager = {
            getDriver: async (_connectionId?: string, role?: string) => {
                capturedRole = role;
                return fakeDriver;
            },
            executeWithRetry: async (fn: () => Promise<any>, _connectionId?: string, options?: any) => {
                capturedTimeout = options?.timeoutMs;
                return fn();
            }
        };

        const provider = new PlanProvider(fakeConnectionManager);
        await provider.getPlan(TEST_CONNECTION, TARGET);

        assert.strictEqual(capturedRole, 'background');
        assert.strictEqual(capturedTimeout, BACKGROUND_QUERY_TIMEOUT_MS);
    });

    test('SQL scopes every tier to the target session and searches strictly after the baseline', async () => {
        const { provider, calls } = makeProvider([() => createRawResult(DETAILS_COLUMNS, [detailsRow()])]);
        await provider.getPlan(TEST_CONNECTION, TARGET);

        const sql = queryCalls(calls)[0].sql;
        assert.ok(sql.includes('SESSION_ID = 42'));
        assert.ok(sql.includes('STMT_ID > 3'), 'must search strictly after the baseline, not for an exact match');
        assert.ok(sql.includes('MIN(STMT_ID)'), 'must resolve to the first qualifying statement');
        assert.ok(sql.includes("COMMAND_NAME NOT IN ('COMMIT', 'ROLLBACK')"), 'must exclude implicit transaction bookkeeping');
    });

    test('only the DETAILS tier orders by IPROC — the summary views have no such column', async () => {
        // Regression test: EXA_DBA_PROFILE_LAST_DAY/EXA_USER_PROFILE_LAST_DAY
        // have no IPROC column (confirmed via DESCRIBE against a live
        // instance); a prior refactor briefly ordered by it unconditionally,
        // which failed live with "object IPROC not found" on those tiers.
        const { provider, calls } = makeProvider([
            () => ({ status: 'error', responseData: {}, exception: { sqlCode: '42500', text: 'insufficient privileges for accessing view' } }),
            () => ({ status: 'error', responseData: {}, exception: { sqlCode: '42500', text: 'insufficient privileges for accessing view' } }),
            () => createRawResult(SUMMARY_COLUMNS, [summaryRow()])
        ]);

        await provider.getPlan(TEST_CONNECTION, TARGET);

        const [detailsSql, dbaSql, userSql] = queryCalls(calls).map(c => c.sql);
        assert.ok(detailsSql.includes('ORDER BY PART_ID, IPROC'), 'DETAILS tier should still order by IPROC');
        assert.ok(!dbaSql.includes('IPROC'), 'DBA_SUMMARY tier must not reference IPROC');
        assert.ok(!userSql.includes('IPROC'), 'USER_SUMMARY tier must not reference IPROC');
        assert.ok(dbaSql.includes('ORDER BY PART_ID') && !dbaSql.includes('ORDER BY PART_ID,'));
        assert.ok(userSql.includes('ORDER BY PART_ID') && !userSql.includes('ORDER BY PART_ID,'));
    });
});
