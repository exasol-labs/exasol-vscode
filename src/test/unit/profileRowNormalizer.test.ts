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
