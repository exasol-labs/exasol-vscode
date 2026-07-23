import * as assert from 'assert';
import { buildPlanTextSummary } from '../../plan/planTextExport';
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
        rowsOut: 1000,
        duration: 0.5,
        cpu: 50,
        net: undefined,
        tempDbRamPeak: undefined,
        hddWrite: undefined,
        costPercent: 50,
        perNodeStats: undefined,
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
        assert.ok(text.includes('Nodes: not available'));
    });

    test('shows the max observed node count when per-node stats exist', () => {
        const text = buildPlanTextSummary(makePlan({
            nodes: [makeNode({ perNodeStats: { metric: 'rows', min: 1, max: 10, avg: 5, nodeCount: 8 } })]
        }));
        assert.ok(text.includes('Nodes: 8'));
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

    test('includes duration, CPU, cost share, and rows out on the primary metrics line', () => {
        const text = buildPlanTextSummary(makePlan({
            nodes: [makeNode({ duration: 0.12, cpu: 38, costPercent: 33, rowsOut: 4500 })]
        }));
        assert.ok(text.includes('Duration: 120 ms'));
        assert.ok(text.includes('CPU: 38%'));
        assert.ok(text.includes('Cost: 33%'));
        assert.ok(text.includes('Rows out: 4.5k'));
    });

    test('shows a dash for CPU when the profile row did not report it, not a fake 0%', () => {
        const text = buildPlanTextSummary(makePlan({ nodes: [makeNode({ cpu: undefined })] }));
        assert.ok(text.includes('CPU: —'));
        assert.ok(!text.includes('CPU: 0%'));
    });

    test('shows Net, HDD write, and Temp DB RAM peak on their own line, including real zero values', () => {
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
