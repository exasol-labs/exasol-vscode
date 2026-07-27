import * as assert from 'assert';
import { buildPlanTextSummary, operatorBlock } from '../../plan/planTextExport';
import { Plan, PlanNode, OperatorTraits } from '../../plan/planModel';

const PASSTHROUGH_TRAITS: OperatorTraits = {
    producesRows: true, consumesRows: true, canSpill: true,
    movesDataOverNetwork: true, blocking: true, isSystemStep: false
};

function makeNode(overrides: Partial<PlanNode> = {}): PlanNode {
    return {
        id: '1',
        operatorType: 'JOIN',
        operatorLabel: 'JOIN',
        traits: PASSTHROUGH_TRAITS,
        objectSchema: undefined,
        objectName: undefined,
        partInfo: undefined,
        remarks: undefined,
        objectRows: undefined,
        rowsOut: 1000,
        duration: 0.5,
        cpu: 50,
        net: undefined,
        tempDbRamPeak: undefined,
        hddWrite: undefined,
        hddRead: undefined,
        costPercent: 50,
        perNodeStats: undefined,
        perNodeDurationStats: undefined,
        warnings: [],
        children: [],
        ...overrides
    };
}

function makePlan(overrides: Partial<Plan> = {}): Plan {
    return {
        sessionId: '42',
        stmtId: '16',
        queryText: undefined,
        totalDuration: 1,
        nodes: [makeNode()],
        edges: [],
        perNodeStatsAvailable: false,
        source: 'DETAILS',
        ...overrides
    };
}

suite('buildPlanTextSummary', () => {

    test('includes the session/statement id, source label, and total time in the header', () => {
        const text = buildPlanTextSummary(makePlan({ sessionId: '1871224275982483456', stmtId: '27', source: 'USER_SUMMARY' }));
        assert.ok(text.includes('session 1871224275982483456, statement 27'));
        assert.ok(text.includes('Source: cluster summary'));
    });

    test('reports "not available" for node count when no per-node stats exist anywhere', () => {
        const text = buildPlanTextSummary(makePlan());
        assert.ok(text.includes('Nodes observed: not available'));
    });

    test('shows the max observed node count when per-node stats exist', () => {
        const text = buildPlanTextSummary(makePlan({
            nodes: [makeNode({ perNodeStats: { metric: 'rows', min: 1, max: 10, avg: 5, nodeCount: 8 } })]
        }));
        assert.ok(text.includes('Nodes observed: 8'));
    });

    test('numbers each operator in plan order and tags it with its PART_ID, one block per node', () => {
        const text = buildPlanTextSummary(makePlan({
            nodes: [
                makeNode({ id: '2', operatorLabel: 'PIPE SCAN' }),
                makeNode({ id: '5', operatorLabel: 'JOIN (HASH)' })
            ]
        }));
        assert.ok(text.includes('1. PIPE SCAN [part 2]'));
        assert.ok(text.includes('2. JOIN (HASH) [part 5]'));
    });

    test('includes the object name (schema-qualified) next to the operator label when present', () => {
        const text = buildPlanTextSummary(makePlan({
            nodes: [makeNode({ id: '1', objectSchema: 'REPORTS', objectName: 'DAILY_SUMMARY' })]
        }));
        assert.ok(text.includes('1. JOIN [part 1] — REPORTS.DAILY_SUMMARY'));
    });

    test('omits the object suffix entirely when no object name is present', () => {
        const text = buildPlanTextSummary(makePlan({ nodes: [makeNode({ id: '1', objectName: undefined })] }));
        assert.ok(text.includes('1. JOIN [part 1]\n'), 'the operator line must not carry a trailing " — ..." suffix');
    });

    test('includes duration, duration share, CPU, and rows out on the primary metrics line', () => {
        const text = buildPlanTextSummary(makePlan({
            nodes: [makeNode({ duration: 0.12, cpu: 38, costPercent: 33, rowsOut: 4500 })]
        }));
        assert.ok(text.includes('Duration: 120 ms'));
        assert.ok(text.includes('Share (of query): 33%'), 'F12: the primary metrics line renamed "Cost:" to "Share:"');
        assert.ok(text.includes('CPU (max node): 38%'), 'F24: CPU is labeled as a per-node max');
        assert.ok(text.includes('Rows out: 4.5k'));
    });

    suite('share denominator suffix (finding B)', () => {
        test('a non-system node reads "Share (of query)"', () => {
            const text = buildPlanTextSummary(makePlan({
                nodes: [makeNode({ costPercent: 45, traits: { ...PASSTHROUGH_TRAITS, isSystemStep: false } })]
            }));
            assert.ok(text.includes('Share (of query): 45%'));
        });

        test('a system-step node reads "Share (of total)" instead', () => {
            const text = buildPlanTextSummary(makePlan({
                nodes: [makeNode({ costPercent: 31, traits: { ...PASSTHROUGH_TRAITS, isSystemStep: true } })]
            }));
            assert.ok(text.includes('Share (of total): 31%'));
            assert.ok(!text.includes('Share (of query)'));
        });
    });

    test('shows a dash for CPU when the profile row did not report it, not a fake 0%', () => {
        const text = buildPlanTextSummary(makePlan({ nodes: [makeNode({ cpu: undefined })] }));
        assert.ok(text.includes('CPU (max node): —'));
        assert.ok(!text.includes('CPU (max node): 0%'));
    });

    test('shows Net, Temp DB RAM peak, and HDD write on their own line, including real zero values', () => {
        const text = buildPlanTextSummary(makePlan({
            nodes: [makeNode({ net: 0, hddWrite: 340.2, tempDbRamPeak: 12 })]
        }));
        assert.ok(text.includes('Net: 0.0 MiB'), 'a real recorded zero must still be shown, not omitted');
        assert.ok(text.includes('HDD write: 340.2 MiB'));
        // Temp DB RAM peak now goes through the same fmtMiB() formatter as
        // Net/HDD write for consistent precision (was a bare `${n} MiB`
        // template, which showed "12 MiB" here but "340.2 MiB" for HDD write
        // a line above — inconsistent decimal precision for the same unit).
        assert.ok(text.includes('Temp DB RAM peak: 12.0 MiB'));
    });

    test('omits the Net/HDD write/Temp DB RAM peak line entirely when none of the three were reported', () => {
        const text = buildPlanTextSummary(makePlan({
            nodes: [makeNode({ net: undefined, hddWrite: undefined, tempDbRamPeak: undefined })]
        }));
        assert.ok(!text.includes('Net:'));
        assert.ok(!text.includes('HDD write:'));
        assert.ok(!text.includes('Temp DB RAM peak:'));
    });

    test('includes only the reported fields when some of Net/HDD write/Temp DB RAM peak are undefined', () => {
        const text = buildPlanTextSummary(makePlan({
            nodes: [makeNode({ net: undefined, hddWrite: 5.5, tempDbRamPeak: undefined })]
        }));
        assert.ok(text.includes('HDD write: 5.5 MiB'));
        assert.ok(!text.includes('Net:'));
        assert.ok(!text.includes('Temp DB RAM peak:'));
    });

    suite('HDD read (finding 7)', () => {
        test('is shown, as a rate, only when greater than zero', () => {
            const text = buildPlanTextSummary(makePlan({ nodes: [makeNode({ hddRead: 3.2 })] }));
            assert.ok(text.includes('HDD read: 3.2 MiB/s'));
        });

        test('is omitted when zero — the overwhelming common case, not worth showing as noise', () => {
            const text = buildPlanTextSummary(makePlan({ nodes: [makeNode({ hddRead: 0 })] }));
            assert.ok(!text.includes('HDD read:'));
        });

        test('is omitted when undefined (not measured)', () => {
            const text = buildPlanTextSummary(makePlan({ nodes: [makeNode({ hddRead: undefined })] }));
            assert.ok(!text.includes('HDD read:'));
        });
    });

    suite('scan selectivity (finding 3)', () => {
        test('shows objectRows -> rowsOut with a one-decimal percentage when both are defined', () => {
            const text = buildPlanTextSummary(makePlan({
                nodes: [makeNode({ objectRows: 10000, rowsOut: 250 })]
            }));
            assert.ok(text.includes('Scanned: 10,000 rows → 250 (2.5%)'));
        });

        test('omits the Scanned line when objectRows is undefined', () => {
            const text = buildPlanTextSummary(makePlan({ nodes: [makeNode({ objectRows: undefined, rowsOut: 250 })] }));
            assert.ok(!text.includes('Scanned:'));
        });

        test('omits the Scanned line when rowsOut is undefined', () => {
            const text = buildPlanTextSummary(makePlan({ nodes: [makeNode({ objectRows: 10000, rowsOut: undefined })] }));
            assert.ok(!text.includes('Scanned:'));
        });

        test('omits the Scanned line when objectRows is zero, guarding the division', () => {
            const text = buildPlanTextSummary(makePlan({ nodes: [makeNode({ objectRows: 0, rowsOut: 0 })] }));
            assert.ok(!text.includes('Scanned:'));
        });

        test('shows the raw row counts but omits the percentage when rowsOut exceeds objectRows (inconsistent data, not >100% selectivity)', () => {
            const text = buildPlanTextSummary(makePlan({
                nodes: [makeNode({ objectRows: 1594, rowsOut: 6314 })]
            }));
            assert.ok(text.includes('Scanned: 1,594 rows → 6,314'), 'the raw row counts must still be shown');
            assert.ok(!/Scanned:[^\n]*%/.test(text), 'must never render a >100% selectivity percentage');
        });
    });

    test('shows "not available" for per-node rows when no per-node stats exist for that operator', () => {
        const text = buildPlanTextSummary(makePlan({ nodes: [makeNode({ perNodeStats: undefined })] }));
        assert.ok(text.includes('Per-node rows: not available'));
    });

    test('shows the full min/max/avg/nodes breakdown when per-node stats exist for that operator', () => {
        const text = buildPlanTextSummary(makePlan({
            nodes: [makeNode({ perNodeStats: { metric: 'rows', min: 4180, max: 4340, avg: 4300, nodeCount: 4 } })]
        }));
        assert.ok(text.includes('Per-node rows: min 4180 / max 4340 / avg 4300 / nodes 4'));
    });

    suite('per-node durations (finding 4)', () => {
        test('is omitted entirely when perNodeDurationStats is undefined', () => {
            const text = buildPlanTextSummary(makePlan({ nodes: [makeNode({ perNodeDurationStats: undefined })] }));
            assert.ok(!text.includes('Per-node durations:'));
        });

        test('shows the min/max/avg/nodes breakdown, formatted the same way as Duration, when present', () => {
            const text = buildPlanTextSummary(makePlan({
                nodes: [makeNode({ perNodeDurationStats: { metric: 'duration', min: 0.01, max: 0.34, avg: 0.12, nodeCount: 4 } })]
            }));
            assert.ok(text.includes('Per-node durations: min 10.0 ms / max 340 ms / avg 120 ms / nodes 4'));
        });

        suite('1ms noise floor (finding C)', () => {
            test('shows the line when the slowest node is exactly at the 1ms floor', () => {
                const text = buildPlanTextSummary(makePlan({
                    nodes: [makeNode({ perNodeDurationStats: { metric: 'duration', min: 0.0001, max: 0.001, avg: 0.0005, nodeCount: 4 } })]
                }));
                assert.ok(text.includes('Per-node durations:'), 'a 1ms max meets the floor and must render');
            });

            test('omits the line when the slowest node is just under the 1ms floor — measurement noise, not a real distribution', () => {
                const text = buildPlanTextSummary(makePlan({
                    nodes: [makeNode({ perNodeDurationStats: { metric: 'duration', min: 0.0001, max: 0.0009, avg: 0.0005, nodeCount: 4 } })]
                }));
                assert.ok(!text.includes('Per-node durations:'), 'a 0.9ms max is below the floor');
            });

            test('per-node ROWS behavior is unaffected by the duration floor', () => {
                const text = buildPlanTextSummary(makePlan({
                    nodes: [makeNode({
                        perNodeStats: { metric: 'rows', min: 1, max: 2, avg: 1.5, nodeCount: 4 },
                        perNodeDurationStats: { metric: 'duration', min: 0.0001, max: 0.0009, avg: 0.0005, nodeCount: 4 }
                    })]
                }));
                assert.ok(text.includes('Per-node rows: min 1 / max 2 / avg 2 / nodes 4'), 'the rows line must still render regardless of the duration floor');
                assert.ok(!text.includes('Per-node durations:'));
            });
        });
    });

    test('includes part info and remarks when present, omits them when absent', () => {
        const withText = buildPlanTextSummary(makePlan({
            nodes: [makeNode({ partInfo: 'JOIN CONDITION: A.ID = B.ID', remarks: 'temporary result' })]
        }));
        assert.ok(withText.includes('Part info: JOIN CONDITION: A.ID = B.ID'));
        assert.ok(withText.includes('Remarks: temporary result'));

        const without = buildPlanTextSummary(makePlan({ nodes: [makeNode({ partInfo: undefined, remarks: undefined })] }));
        assert.ok(!without.includes('Part info:'));
        assert.ok(!without.includes('Remarks:'));
    });

    test('lists every warning message on its own line, prefixed with the warning glyph', () => {
        const text = buildPlanTextSummary(makePlan({
            nodes: [makeNode({
                warnings: [
                    { type: 'SPILLED_TO_DISK', message: 'Wrote 12.5 MiB to disk during execution', detail: {} },
                    { type: 'HIGH_SKEW', message: 'Rows per node ranged 1-1000 (avg 300) across 4 nodes', detail: {} }
                ]
            })]
        }));
        assert.ok(text.includes('⚠ Wrote 12.5 MiB to disk during execution'));
        assert.ok(text.includes('⚠ Rows per node ranged 1-1000 (avg 300) across 4 nodes'));
    });

    test('an operator with no warnings has no warning lines', () => {
        const text = buildPlanTextSummary(makePlan({ nodes: [makeNode({ warnings: [] })] }));
        assert.ok(!text.includes('⚠'));
    });

    test('a plan with no nodes says so plainly instead of an empty operator list', () => {
        const text = buildPlanTextSummary(makePlan({ nodes: [] }));
        assert.ok(text.includes('This statement produced no profiled operators.'));
    });
});

suite('operatorBlock (finding 11 — per-node copy)', () => {
    test('is exported directly, with no separate wrapper function', () => {
        assert.strictEqual(typeof operatorBlock, 'function');
    });

    test('renders exactly the block buildPlanTextSummary embeds for that node, at the same index', () => {
        const nodeA = makeNode({ id: '2', operatorLabel: 'PIPE SCAN', duration: 0.05, costPercent: 20 });
        const nodeB = makeNode({ id: '5', operatorLabel: 'JOIN (HASH)', duration: 0.2, costPercent: 80 });
        const plan = makePlan({ nodes: [nodeA, nodeB] });

        const fullText = buildPlanTextSummary(plan);
        const blockForB = operatorBlock(nodeB, 1);

        assert.ok(fullText.includes(blockForB), 'the standalone block for node B must appear verbatim inside the full export');
        assert.ok(blockForB.startsWith('2. JOIN (HASH) [part 5]'), 'the index parameter numbers the block the same way as the full export');
    });
});
