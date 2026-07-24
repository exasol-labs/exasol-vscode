import * as assert from 'assert';
import { normalizeProfileRows } from '../../plan/profileRowNormalizer';

/**
 * Builds one raw driver row using the real EXA_*_PROFILE_* /
 * $EXA_PROFILE_DETAILS_LAST_DAY column names verified live against an
 * Exasol 2026.1.0 instance during Step 0 research. Numeric values below are
 * simplified for assertion clarity, not copied verbatim from that session.
 */
function row(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
        SESSION_ID: 1,
        STMT_ID: 5,
        PART_ID: 1,
        PART_NAME: 'SCAN',
        ...overrides
    };
}

suite('normalizeProfileRows', () => {

    suite('basic shape', () => {
        test('produces one node per PART_ID, ordered by PART_ID', () => {
            const rows = [
                row({ PART_ID: 3, PART_NAME: 'GROUP BY', DURATION: 5 }),
                row({ PART_ID: 1, PART_NAME: 'SCAN', DURATION: 2 }),
                row({ PART_ID: 2, PART_NAME: 'JOIN', DURATION: 3 })
            ];

            const plan = normalizeProfileRows(rows, { sessionId: '1', stmtId: '5', source: 'USER_SUMMARY' });

            assert.strictEqual(plan.nodes.length, 3);
            assert.deepStrictEqual(plan.nodes.map(n => n.id), ['1', '2', '3']);
            assert.deepStrictEqual(plan.nodes.map(n => n.operatorType), ['SCAN', 'JOIN', 'GROUP_BY']);
        });

        test('computes costPercent as each node\'s share of total duration', () => {
            const rows = [
                row({ PART_ID: 1, PART_NAME: 'SCAN', DURATION: 2 }),
                row({ PART_ID: 2, PART_NAME: 'JOIN', DURATION: 3 }),
                row({ PART_ID: 3, PART_NAME: 'GROUP BY', DURATION: 5 })
            ];

            const plan = normalizeProfileRows(rows, { sessionId: '1', stmtId: '5', source: 'USER_SUMMARY' });

            assert.strictEqual(plan.totalDuration, 10);
            assert.strictEqual(plan.nodes[0].costPercent, 20);
            assert.strictEqual(plan.nodes[1].costPercent, 30);
            assert.strictEqual(plan.nodes[2].costPercent, 50);
        });

        test('costPercent is undefined rather than NaN when total duration is zero', () => {
            const rows = [row({ PART_ID: 1, PART_NAME: 'COMMIT', DURATION: 0 })];
            const plan = normalizeProfileRows(rows, { sessionId: '1', stmtId: '5', source: 'USER_SUMMARY' });
            assert.strictEqual(plan.nodes[0].costPercent, undefined);
        });

        test('ignores rows belonging to a different session or statement', () => {
            const rows = [
                row({ PART_ID: 1, SESSION_ID: 1, STMT_ID: 5 }),
                row({ PART_ID: 2, SESSION_ID: 1, STMT_ID: 999 }),
                row({ PART_ID: 3, SESSION_ID: 999, STMT_ID: 5 })
            ];

            const plan = normalizeProfileRows(rows, { sessionId: '1', stmtId: '5', source: 'USER_SUMMARY' });

            assert.strictEqual(plan.nodes.length, 1);
            assert.strictEqual(plan.nodes[0].id, '1');
        });

        test('extracts queryText from whichever row carries SQL_TEXT', () => {
            const rows = [
                row({ PART_ID: 1, SQL_TEXT: undefined }),
                row({ PART_ID: 2, SQL_TEXT: 'SELECT 1' })
            ];
            const plan = normalizeProfileRows(rows, { sessionId: '1', stmtId: '5', source: 'USER_SUMMARY' });
            assert.strictEqual(plan.queryText, 'SELECT 1');
        });

        test('passes the source through unchanged', () => {
            const plan = normalizeProfileRows(
                [row({ PART_ID: 1 })],
                { sessionId: '1', stmtId: '5', source: 'DBA_SUMMARY' }
            );
            assert.strictEqual(plan.source, 'DBA_SUMMARY');
        });

        test('edges is always empty in v1 — no parent/child column exists in these views', () => {
            const plan = normalizeProfileRows([row({ PART_ID: 1 })], { sessionId: '1', stmtId: '5', source: 'USER_SUMMARY' });
            assert.deepStrictEqual(plan.edges, []);
            assert.deepStrictEqual(plan.nodes[0].children, []);
        });
    });

    suite('per-node stats ($EXA_PROFILE_DETAILS_LAST_DAY rows, carrying IPROC)', () => {
        test('is undefined when source rows carry no IPROC (summary views)', () => {
            const plan = normalizeProfileRows(
                [row({ PART_ID: 1, PART_NAME: 'JOIN', OUT_ROWS: 1000 })],
                { sessionId: '1', stmtId: '5', source: 'USER_SUMMARY' }
            );
            assert.strictEqual(plan.nodes[0].perNodeStats, undefined);
            assert.strictEqual(plan.perNodeStatsAvailable, false);
        });

        test('collapses multiple IPROC rows for one PART_ID into a single node with real min/max/avg', () => {
            const rows = [
                row({ PART_ID: 6, PART_NAME: 'PIPE JOIN', IPROC: 0, OUT_ROWS: 100 }),
                row({ PART_ID: 6, PART_NAME: 'PIPE JOIN', IPROC: 1, OUT_ROWS: 900 }),
                row({ PART_ID: 6, PART_NAME: 'PIPE JOIN', IPROC: 2, OUT_ROWS: 200 })
            ];

            const plan = normalizeProfileRows(rows, { sessionId: '1', stmtId: '5', source: 'DETAILS' });

            assert.strictEqual(plan.nodes.length, 1, 'the three per-node rows collapse into one operator node');
            const node = plan.nodes[0];
            assert.strictEqual(node.rowsOut, 1200, 'rowsOut is the sum across nodes');
            assert.deepStrictEqual(node.perNodeStats, { metric: 'rows', min: 100, max: 900, avg: 400, nodeCount: 3 });
            assert.strictEqual(plan.perNodeStatsAvailable, true);
        });

        test('duration collapses as the max across nodes (operator finishes when its slowest node does)', () => {
            const rows = [
                row({ PART_ID: 6, PART_NAME: 'PIPE JOIN', IPROC: 0, DURATION: 1.5, OUT_ROWS: 100 }),
                row({ PART_ID: 6, PART_NAME: 'PIPE JOIN', IPROC: 1, DURATION: 4.2, OUT_ROWS: 100 })
            ];
            const plan = normalizeProfileRows(rows, { sessionId: '1', stmtId: '5', source: 'DETAILS' });
            assert.strictEqual(plan.nodes[0].duration, 4.2);
        });

        test('a single-node cluster still yields a (trivial) perNodeStats rather than undefined', () => {
            // Matches what was actually observed against the live single-node
            // exasol-db test container: IPROC = 0 for every row.
            const rows = [row({ PART_ID: 1, PART_NAME: 'PIPE SCAN', IPROC: 0, OUT_ROWS: 1000 })];
            const plan = normalizeProfileRows(rows, { sessionId: '1', stmtId: '5', source: 'DETAILS' });
            assert.deepStrictEqual(plan.nodes[0].perNodeStats, { metric: 'rows', min: 1000, max: 1000, avg: 1000, nodeCount: 1 });
        });

        test('never fabricates perNodeStats for a node whose rows lack OUT_ROWS entirely', () => {
            const rows = [
                row({ PART_ID: 1, PART_NAME: 'PIPE JOIN', IPROC: 0, OUT_ROWS: undefined }),
                row({ PART_ID: 1, PART_NAME: 'PIPE JOIN', IPROC: 1, OUT_ROWS: undefined })
            ];
            const plan = normalizeProfileRows(rows, { sessionId: '1', stmtId: '5', source: 'DETAILS' });
            assert.strictEqual(plan.nodes[0].perNodeStats, undefined);
        });

        test('when OUT_ROWS is only partially reported across a group, nodeCount matches the population min/max/avg were actually computed from', () => {
            // Regression test: nodeCount used to be rows.length (every IPROC
            // row, including ones with an undefined OUT_ROWS), while
            // min/max/avg were computed only from the rows that actually had
            // a defined OUT_ROWS — an internally-inconsistent stat (e.g. an
            // avg over 2 real values mislabeled as spanning 3 nodes), which
            // also understates the true skew ratio if the missing node was
            // actually the outlier.
            const rows = [
                row({ PART_ID: 1, PART_NAME: 'PIPE JOIN', IPROC: 0, OUT_ROWS: 100 }),
                row({ PART_ID: 1, PART_NAME: 'PIPE JOIN', IPROC: 1, OUT_ROWS: undefined }),
                row({ PART_ID: 1, PART_NAME: 'PIPE JOIN', IPROC: 2, OUT_ROWS: 900 })
            ];
            const plan = normalizeProfileRows(rows, { sessionId: '1', stmtId: '5', source: 'DETAILS' });
            assert.deepStrictEqual(plan.nodes[0].perNodeStats, { metric: 'rows', min: 100, max: 900, avg: 500, nodeCount: 2 });
        });
    });

    suite('per-node duration stats (finding 4)', () => {
        test('builds a duration PerNodeStat alongside the rows one, from real per-IPROC DURATION values', () => {
            const rows = [
                row({ PART_ID: 6, PART_NAME: 'PIPE JOIN', IPROC: 0, DURATION: 1, OUT_ROWS: 100 }),
                row({ PART_ID: 6, PART_NAME: 'PIPE JOIN', IPROC: 1, DURATION: 9, OUT_ROWS: 100 }),
                row({ PART_ID: 6, PART_NAME: 'PIPE JOIN', IPROC: 2, DURATION: 2, OUT_ROWS: 100 })
            ];
            const plan = normalizeProfileRows(rows, { sessionId: '1', stmtId: '5', source: 'DETAILS' });
            assert.deepStrictEqual(
                plan.nodes[0].perNodeDurationStats,
                { metric: 'duration', min: 1, max: 9, avg: 4, nodeCount: 3 }
            );
        });

        test('is undefined when source rows carry no IPROC (summary views)', () => {
            const plan = normalizeProfileRows(
                [row({ PART_ID: 1, PART_NAME: 'JOIN', DURATION: 1 })],
                { sessionId: '1', stmtId: '5', source: 'USER_SUMMARY' }
            );
            assert.strictEqual(plan.nodes[0].perNodeDurationStats, undefined);
        });

        test('is computed independently of perNodeStats — present even when OUT_ROWS is missing entirely', () => {
            const rows = [
                row({ PART_ID: 1, PART_NAME: 'PIPE JOIN', IPROC: 0, DURATION: 0.1, OUT_ROWS: undefined }),
                row({ PART_ID: 1, PART_NAME: 'PIPE JOIN', IPROC: 1, DURATION: 0.3, OUT_ROWS: undefined })
            ];
            const plan = normalizeProfileRows(rows, { sessionId: '1', stmtId: '5', source: 'DETAILS' });
            assert.strictEqual(plan.nodes[0].perNodeStats, undefined, 'precondition: no OUT_ROWS anywhere in the group');
            assert.deepStrictEqual(
                plan.nodes[0].perNodeDurationStats,
                { metric: 'duration', min: 0.1, max: 0.3, avg: 0.2, nodeCount: 2 }
            );
        });

        test('never fabricates perNodeDurationStats for a node whose rows lack DURATION entirely', () => {
            const rows = [
                row({ PART_ID: 1, PART_NAME: 'PIPE JOIN', IPROC: 0, DURATION: undefined }),
                row({ PART_ID: 1, PART_NAME: 'PIPE JOIN', IPROC: 1, DURATION: undefined })
            ];
            const plan = normalizeProfileRows(rows, { sessionId: '1', stmtId: '5', source: 'DETAILS' });
            assert.strictEqual(plan.nodes[0].perNodeDurationStats, undefined);
        });
    });

    suite('OBJECT_ROWS / scan selectivity (finding 3)', () => {
        test('carries OBJECT_ROWS through onto the node, alongside OUT_ROWS', () => {
            const rows = [row({ PART_ID: 1, PART_NAME: 'SCAN', OBJECT_ROWS: 10000, OUT_ROWS: 250 })];
            const plan = normalizeProfileRows(rows, { sessionId: '1', stmtId: '5', source: 'USER_SUMMARY' });
            assert.strictEqual(plan.nodes[0].objectRows, 10000);
            assert.strictEqual(plan.nodes[0].rowsOut, 250);
        });

        test('collapses OBJECT_ROWS as a SUM across per-node rows, same as OUT_ROWS — not a max', () => {
            // In the per-IPROC details tier, OBJECT_ROWS is the node-local
            // shard row count (verified live: a 176,792-row temp table
            // reported OBJECT_ROWS 44,632 per node across 4 nodes), the same
            // per-node scale as OUT_ROWS. A prior max-vs-sum mismatch here
            // mixed a per-node scale with a cluster scale and could render
            // selectivity over 100% (real screenshot: "1,594 rows -> 6,314
            // (396.1%)"). This fixture mirrors that shape: 4 nodes each
            // reporting OBJECT_ROWS 1594, OUT_ROWS summing to 6314.
            const rows = [
                row({ PART_ID: 1, PART_NAME: 'PIPE SCAN', IPROC: 0, OBJECT_ROWS: 1594, OUT_ROWS: 1594 }),
                row({ PART_ID: 1, PART_NAME: 'PIPE SCAN', IPROC: 1, OBJECT_ROWS: 1594, OUT_ROWS: 1594 }),
                row({ PART_ID: 1, PART_NAME: 'PIPE SCAN', IPROC: 2, OBJECT_ROWS: 1594, OUT_ROWS: 1594 }),
                row({ PART_ID: 1, PART_NAME: 'PIPE SCAN', IPROC: 3, OBJECT_ROWS: 1594, OUT_ROWS: 1532 })
            ];
            const plan = normalizeProfileRows(rows, { sessionId: '1', stmtId: '5', source: 'DETAILS' });
            const node = plan.nodes[0];
            assert.strictEqual(node.objectRows, 6376, '4 * 1594 summed, not maxed to 1594');
            assert.strictEqual(node.rowsOut, 6314);
            const selectivity = (node.rowsOut! / node.objectRows!) * 100;
            assert.ok(selectivity < 100, `selectivity must not exceed 100%, got ${selectivity}`);
            assert.ok(Math.abs(selectivity - 99.03) < 0.01, `expected ~99%, got ${selectivity}`);
        });

        test('is undefined when OBJECT_ROWS was not reported', () => {
            const plan = normalizeProfileRows(
                [row({ PART_ID: 1, PART_NAME: 'JOIN', OBJECT_ROWS: undefined })],
                { sessionId: '1', stmtId: '5', source: 'USER_SUMMARY' }
            );
            assert.strictEqual(plan.nodes[0].objectRows, undefined);
        });
    });

    suite('HDD_READ (finding 7)', () => {
        test('carries HDD_READ through onto the node', () => {
            const rows = [row({ PART_ID: 1, PART_NAME: 'SCAN', HDD_READ: 3.2 })];
            const plan = normalizeProfileRows(rows, { sessionId: '1', stmtId: '5', source: 'USER_SUMMARY' });
            assert.strictEqual(plan.nodes[0].hddRead, 3.2);
        });

        test('collapses HDD_READ as a max across per-node rows — it is a rate (MiB/s), not a volume, so summing would not mean anything', () => {
            const rows = [
                row({ PART_ID: 1, PART_NAME: 'PIPE SCAN', IPROC: 0, HDD_READ: 1.5 }),
                row({ PART_ID: 1, PART_NAME: 'PIPE SCAN', IPROC: 1, HDD_READ: 4.2 })
            ];
            const plan = normalizeProfileRows(rows, { sessionId: '1', stmtId: '5', source: 'DETAILS' });
            assert.strictEqual(plan.nodes[0].hddRead, 4.2);
        });

        test('is undefined when HDD_READ was not reported', () => {
            const plan = normalizeProfileRows(
                [row({ PART_ID: 1, PART_NAME: 'SCAN', HDD_READ: undefined })],
                { sessionId: '1', stmtId: '5', source: 'USER_SUMMARY' }
            );
            assert.strictEqual(plan.nodes[0].hddRead, undefined);
        });
    });

    suite('cost-share denominator excludes system steps (finding 2)', () => {
        test('a non-system node\'s costPercent divides by total duration minus system-step duration', () => {
            const rows = [
                row({ PART_ID: 1, PART_NAME: 'COMPILE / EXECUTE', DURATION: 36 }),
                row({ PART_ID: 2, PART_NAME: 'SCAN', DURATION: 32 }),
                row({ PART_ID: 3, PART_NAME: 'JOIN', DURATION: 32 })
            ];
            const plan = normalizeProfileRows(rows, { sessionId: '1', stmtId: '5', source: 'USER_SUMMARY' });

            assert.strictEqual(plan.totalDuration, 100, 'Plan.totalDuration stays wall-time-true over every node');

            const compile = plan.nodes.find(n => n.id === '1')!;
            const scan = plan.nodes.find(n => n.id === '2')!;
            const join = plan.nodes.find(n => n.id === '3')!;

            // System step: share of the WHOLE plan (36 / 100).
            assert.strictEqual(compile.costPercent, 36);
            // Non-system: share of total minus the system-step duration
            // (32 / (100 - 36) = 32 / 64 = 50), not deflated by COMPILE.
            assert.strictEqual(scan.costPercent, 50);
            assert.strictEqual(join.costPercent, 50);
        });

        test('with no system steps present, the non-system denominator equals totalDuration (unaffected by this change)', () => {
            const rows = [
                row({ PART_ID: 1, PART_NAME: 'SCAN', DURATION: 2 }),
                row({ PART_ID: 2, PART_NAME: 'JOIN', DURATION: 3 }),
                row({ PART_ID: 3, PART_NAME: 'GROUP BY', DURATION: 5 })
            ];
            const plan = normalizeProfileRows(rows, { sessionId: '1', stmtId: '5', source: 'USER_SUMMARY' });
            assert.strictEqual(plan.nodes[0].costPercent, 20);
            assert.strictEqual(plan.nodes[1].costPercent, 30);
            assert.strictEqual(plan.nodes[2].costPercent, 50);
        });

        test('a non-system node\'s costPercent is undefined (not NaN/Infinity) when every duration is a system step', () => {
            const rows = [
                row({ PART_ID: 1, PART_NAME: 'COMPILE / EXECUTE', DURATION: 10 }),
                row({ PART_ID: 2, PART_NAME: 'SCAN', DURATION: undefined })
            ];
            const plan = normalizeProfileRows(rows, { sessionId: '1', stmtId: '5', source: 'USER_SUMMARY' });
            const scan = plan.nodes.find(n => n.id === '2')!;
            assert.strictEqual(scan.duration, undefined);
            assert.strictEqual(scan.costPercent, undefined);
        });

        test('NODE SYNC stays inside the non-system denominator rather than being excluded like COMPILE/EXECUTE', () => {
            const rows = [
                row({ PART_ID: 1, PART_NAME: 'COMPILE / EXECUTE', DURATION: 10 }),
                row({ PART_ID: 2, PART_NAME: 'NODE SYNC', DURATION: 45 }),
                row({ PART_ID: 3, PART_NAME: 'SCAN', DURATION: 45 })
            ];
            const plan = normalizeProfileRows(rows, { sessionId: '1', stmtId: '5', source: 'USER_SUMMARY' });
            const sync = plan.nodes.find(n => n.id === '2')!;
            const scan = plan.nodes.find(n => n.id === '3')!;
            // Non-system denominator is 45 + 45 = 90 (COMPILE's 10 excluded);
            // NODE SYNC and SCAN split it evenly at 50% each.
            assert.strictEqual(sync.costPercent, 50);
            assert.strictEqual(scan.costPercent, 50);
        });
    });

    suite('warnings integration', () => {
        test('a JOIN node with nonzero HDD_WRITE surfaces a SPILLED_TO_DISK warning', () => {
            const rows = [row({ PART_ID: 1, PART_NAME: 'JOIN', HDD_WRITE: 42 })];
            const plan = normalizeProfileRows(rows, { sessionId: '1', stmtId: '5', source: 'USER_SUMMARY' });
            assert.ok(plan.nodes[0].warnings.some(w => w.type === 'SPILLED_TO_DISK'));
        });

        test('a plain SCAN with no spill/network/skew signal has no warnings', () => {
            const rows = [row({ PART_ID: 1, PART_NAME: 'SCAN', OUT_ROWS: 1000, DURATION: 0.01 })];
            const plan = normalizeProfileRows(rows, { sessionId: '1', stmtId: '5', source: 'USER_SUMMARY' });
            assert.strictEqual(plan.nodes[0].warnings.length, 0);
        });

        test('skewed per-node rows on a JOIN surface a HIGH_SKEW warning', () => {
            const rows = [
                row({ PART_ID: 1, PART_NAME: 'PIPE JOIN', IPROC: 0, OUT_ROWS: 10 }),
                row({ PART_ID: 1, PART_NAME: 'PIPE JOIN', IPROC: 1, OUT_ROWS: 5000 })
            ];
            const plan = normalizeProfileRows(rows, { sessionId: '1', stmtId: '5', source: 'DETAILS' });
            assert.ok(plan.nodes[0].warnings.some(w => w.type === 'HIGH_SKEW'));
        });
    });

    suite('numeric tolerance', () => {
        test('tolerates numeric columns arriving as strings (as some driver paths return decimals)', () => {
            const rows = [row({ PART_ID: 1, PART_NAME: 'SCAN', DURATION: '1.500', OUT_ROWS: '2000' })];
            const plan = normalizeProfileRows(rows, { sessionId: '1', stmtId: '5', source: 'USER_SUMMARY' });
            assert.strictEqual(plan.nodes[0].duration, 1.5);
            assert.strictEqual(plan.nodes[0].rowsOut, 2000);
        });

        test('an empty row set produces an empty, valid plan rather than throwing', () => {
            const plan = normalizeProfileRows([], { sessionId: '1', stmtId: '5', source: 'USER_SUMMARY' });
            assert.deepStrictEqual(plan.nodes, []);
            assert.strictEqual(plan.totalDuration, 0);
            assert.strictEqual(plan.perNodeStatsAvailable, false);
        });
    });
});
