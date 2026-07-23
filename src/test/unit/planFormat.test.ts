import * as assert from 'assert';
import { fmtRows, planCategoryBreakdown, hottestNodeId, planLacksDetailMetrics } from '../../plan/planFormat';
import { Plan, PlanNode, OperatorTraits } from '../../plan/planModel';

const TRAITS: OperatorTraits = {
    producesRows: true, consumesRows: true, canSpill: true,
    movesDataOverNetwork: true, blocking: true, isSystemStep: false
};

function makeNode(overrides: Partial<PlanNode> = {}): PlanNode {
    return {
        id: '1',
        operatorType: 'JOIN',
        operatorLabel: 'JOIN',
        traits: TRAITS,
        objectSchema: undefined,
        objectName: undefined,
        partInfo: undefined,
        remarks: undefined,
        rowsOut: 100,
        duration: 1,
        cpu: 50,
        net: undefined,
        tempDbRamPeak: undefined,
        hddWrite: undefined,
        costPercent: 25,
        perNodeStats: undefined,
        warnings: [],
        children: [],
        ...overrides
    };
}

function makePlan(nodes: PlanNode[], overrides: Partial<Plan> = {}): Plan {
    return {
        sessionId: '1',
        stmtId: '1',
        queryText: undefined,
        totalDuration: nodes.reduce((sum, n) => sum + (n.duration ?? 0), 0),
        nodes,
        edges: [],
        perNodeStatsAvailable: false,
        source: 'DETAILS',
        ...overrides
    };
}

suite('planCategoryBreakdown', () => {
    test('buckets duration by operatorType and computes percent of totalDuration', () => {
        const plan = makePlan([
            makeNode({ id: '1', operatorType: 'SCAN', duration: 3 }),
            makeNode({ id: '2', operatorType: 'JOIN', duration: 1 })
        ]);
        const breakdown = planCategoryBreakdown(plan);
        assert.strictEqual(breakdown.length, 2);
        const scan = breakdown.find(b => b.type === 'SCAN')!;
        const join = breakdown.find(b => b.type === 'JOIN')!;
        assert.strictEqual(scan.percent, 75);
        assert.strictEqual(join.percent, 25);
    });

    test('sums multiple nodes of the same operatorType into one bucket', () => {
        const plan = makePlan([
            makeNode({ id: '1', operatorType: 'JOIN', duration: 2 }),
            makeNode({ id: '2', operatorType: 'JOIN', duration: 2 }),
            makeNode({ id: '3', operatorType: 'SCAN', duration: 4 })
        ]);
        const breakdown = planCategoryBreakdown(plan);
        assert.strictEqual(breakdown.length, 2);
        assert.strictEqual(breakdown.find(b => b.type === 'JOIN')!.durationSum, 4);
        assert.strictEqual(breakdown.find(b => b.type === 'JOIN')!.percent, 50);
    });

    test('sorts buckets by percent descending', () => {
        const plan = makePlan([
            makeNode({ id: '1', operatorType: 'SORT', duration: 1 }),
            makeNode({ id: '2', operatorType: 'SCAN', duration: 5 }),
            makeNode({ id: '3', operatorType: 'JOIN', duration: 3 })
        ]);
        const order = planCategoryBreakdown(plan).map(b => b.type);
        assert.deepStrictEqual(order, ['SCAN', 'JOIN', 'SORT']);
    });

    test('a node with an undefined duration contributes nothing, rather than counting as zero', () => {
        const plan = makePlan([
            makeNode({ id: '1', operatorType: 'SCAN', duration: 4 }),
            makeNode({ id: '2', operatorType: 'OTHER', duration: undefined })
        ], { totalDuration: 4 });
        const breakdown = planCategoryBreakdown(plan);
        assert.strictEqual(breakdown.length, 1);
        assert.strictEqual(breakdown[0].type, 'SCAN');
        assert.strictEqual(breakdown[0].percent, 100);
    });

    test('returns an empty array when totalDuration is zero, never dividing by zero', () => {
        const plan = makePlan([makeNode({ duration: undefined })], { totalDuration: 0 });
        assert.deepStrictEqual(planCategoryBreakdown(plan), []);
    });

    test('returns an empty array for a plan with no nodes', () => {
        const plan = makePlan([], { totalDuration: 0 });
        assert.deepStrictEqual(planCategoryBreakdown(plan), []);
    });

    test('each bucket carries a label and colorVar for rendering', () => {
        const plan = makePlan([makeNode({ id: '1', operatorType: 'GROUP_BY', duration: 1 })]);
        const [bucket] = planCategoryBreakdown(plan);
        assert.strictEqual(bucket.label, 'Group By');
        assert.strictEqual(bucket.colorVar, '--vscode-charts-green');
    });
});

suite('fmtRows', () => {
    test('rounds values near one million to M instead of 1000k', () => {
        assert.strictEqual(fmtRows(999_999), '1.0M');
    });

    test('rounds values near one billion to B instead of 1000M', () => {
        assert.strictEqual(fmtRows(999_950_000), '1.0B');
    });

    test('formats a value comfortably within the B range with one decimal', () => {
        assert.strictEqual(fmtRows(1_500_000_000), '1.5B');
    });
});

suite('hottestNodeId', () => {
    test('returns the id of the node with the highest costPercent', () => {
        const plan = makePlan([
            makeNode({ id: '1', costPercent: 10 }),
            makeNode({ id: '2', costPercent: 62 }),
            makeNode({ id: '3', costPercent: 30 })
        ]);
        assert.strictEqual(hottestNodeId(plan), '2');
    });

    test('breaks ties by returning the first node encountered at the max value', () => {
        const plan = makePlan([
            makeNode({ id: '1', costPercent: 50 }),
            makeNode({ id: '2', costPercent: 50 })
        ]);
        assert.strictEqual(hottestNodeId(plan), '1');
    });

    test('skips nodes with an undefined costPercent when finding the max', () => {
        const plan = makePlan([
            makeNode({ id: '1', costPercent: undefined }),
            makeNode({ id: '2', costPercent: 15 })
        ]);
        assert.strictEqual(hottestNodeId(plan), '2');
    });

    test('returns undefined when no node has a defined costPercent', () => {
        const plan = makePlan([
            makeNode({ id: '1', costPercent: undefined }),
            makeNode({ id: '2', costPercent: undefined })
        ]);
        assert.strictEqual(hottestNodeId(plan), undefined);
    });

    test('returns undefined for a plan with no nodes', () => {
        assert.strictEqual(hottestNodeId(makePlan([])), undefined);
    });
});

suite('planLacksDetailMetrics', () => {
    test('is true when every node has both cpu and net undefined', () => {
        const plan = makePlan([
            makeNode({ id: '1', cpu: undefined, net: undefined }),
            makeNode({ id: '2', cpu: undefined, net: undefined })
        ]);
        assert.strictEqual(planLacksDetailMetrics(plan), true);
    });

    test('is false when at least one node has a defined cpu', () => {
        const plan = makePlan([
            makeNode({ id: '1', cpu: undefined, net: undefined }),
            makeNode({ id: '2', cpu: 12.5, net: undefined })
        ]);
        assert.strictEqual(planLacksDetailMetrics(plan), false);
    });

    test('is false when at least one node has a defined net, even if cpu is undefined everywhere', () => {
        const plan = makePlan([
            makeNode({ id: '1', cpu: undefined, net: undefined }),
            makeNode({ id: '2', cpu: undefined, net: 0 })
        ]);
        assert.strictEqual(planLacksDetailMetrics(plan), false);
    });

    test('is false for a plan with no nodes — nothing to educate the user about yet', () => {
        assert.strictEqual(planLacksDetailMetrics(makePlan([])), false);
    });

    test('a real net:0 (recorded, not missing) counts as defined and prevents the hint', () => {
        const plan = makePlan([makeNode({ id: '1', cpu: undefined, net: 0 })]);
        assert.strictEqual(planLacksDetailMetrics(plan), false);
    });
});
