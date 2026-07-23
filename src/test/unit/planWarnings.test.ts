import * as assert from 'assert';
import { computeWarnings, DEFAULT_WARNING_THRESHOLDS } from '../../plan/planWarnings';
import { OperatorTraits } from '../../plan/planModel';

const JOIN_TRAITS: OperatorTraits = {
    producesRows: true, consumesRows: true, canSpill: true,
    movesDataOverNetwork: true, blocking: true, isSystemStep: false
};

const SCAN_TRAITS: OperatorTraits = {
    producesRows: true, consumesRows: false, canSpill: false,
    movesDataOverNetwork: false, blocking: false, isSystemStep: false
};

suite('computeWarnings', () => {

    suite('SPILLED_TO_DISK', () => {
        test('fires when a spill-capable operator has nonzero HDD_WRITE', () => {
            const warnings = computeWarnings({ traits: JOIN_TRAITS, hddWrite: 12.5, net: undefined, perNodeStats: undefined, costPercent: undefined });
            assert.strictEqual(warnings.length, 1);
            assert.strictEqual(warnings[0].type, 'SPILLED_TO_DISK');
            assert.strictEqual(warnings[0].detail.hddWriteMiB, 12.5);
        });

        test('does not fire when HDD_WRITE is zero', () => {
            const warnings = computeWarnings({ traits: JOIN_TRAITS, hddWrite: 0, net: undefined, perNodeStats: undefined, costPercent: undefined });
            assert.strictEqual(warnings.length, 0);
        });

        test('does not fire when HDD_WRITE is undefined (metric not reported)', () => {
            const warnings = computeWarnings({ traits: JOIN_TRAITS, hddWrite: undefined, net: undefined, perNodeStats: undefined, costPercent: undefined });
            assert.strictEqual(warnings.length, 0);
        });

        test('does not fire on an operator that cannot spill even with nonzero HDD_WRITE', () => {
            const warnings = computeWarnings({ traits: SCAN_TRAITS, hddWrite: 5, net: undefined, perNodeStats: undefined, costPercent: undefined });
            assert.strictEqual(warnings.length, 0);
        });
    });

    suite('LARGE_REDISTRIBUTION', () => {
        test('fires when a network-capable operator both moved data and dominates the query\'s time', () => {
            const warnings = computeWarnings({ traits: JOIN_TRAITS, hddWrite: undefined, net: 500, perNodeStats: undefined, costPercent: 25 });
            assert.strictEqual(warnings.length, 1);
            assert.strictEqual(warnings[0].type, 'LARGE_REDISTRIBUTION');
            assert.strictEqual(warnings[0].detail.netMiB, 500);
            assert.strictEqual(warnings[0].detail.costPercent, 25);
        });

        test('the message shows one decimal place, so a cost share just over the threshold reads as distinct from it', () => {
            // Regression test: with toFixed(0), costPercent=20.4 against the
            // default 20% threshold rendered as "20% ... threshold 20%" —
            // identical numbers, reading as if the warning fired for no
            // reason. One decimal place makes the real margin visible.
            const warnings = computeWarnings({ traits: JOIN_TRAITS, hddWrite: undefined, net: 12.34, perNodeStats: undefined, costPercent: 20.4 });
            assert.strictEqual(warnings.length, 1);
            assert.ok(warnings[0].message.includes('20.4%'), `expected the exact cost share in the message, got: ${warnings[0].message}`);
            assert.ok(!warnings[0].message.includes('20% of'), 'must not round costPercent down to match the threshold display');
        });

        test('does not fire when the operator\'s cost share is below the threshold, regardless of NET size', () => {
            const warnings = computeWarnings({ traits: JOIN_TRAITS, hddWrite: undefined, net: 500, perNodeStats: undefined, costPercent: 5 });
            assert.strictEqual(warnings.length, 0);
        });

        test('does not fire when NET is zero even if the operator dominates query time', () => {
            const warnings = computeWarnings({ traits: JOIN_TRAITS, hddWrite: undefined, net: 0, perNodeStats: undefined, costPercent: 90 });
            assert.strictEqual(warnings.length, 0);
        });

        test('does not fire when costPercent is undefined (totalDuration was 0), even with large NET', () => {
            const warnings = computeWarnings({ traits: JOIN_TRAITS, hddWrite: undefined, net: 500, perNodeStats: undefined, costPercent: undefined });
            assert.strictEqual(warnings.length, 0);
        });

        test('does not fire on an operator that never moves data over the network, no matter its cost share', () => {
            const warnings = computeWarnings({ traits: SCAN_TRAITS, hddWrite: undefined, net: 999, perNodeStats: undefined, costPercent: 90 });
            assert.strictEqual(warnings.length, 0);
        });

        test('respects a custom threshold', () => {
            const warnings = computeWarnings(
                { traits: JOIN_TRAITS, hddWrite: undefined, net: 50, perNodeStats: undefined, costPercent: 12 },
                { ...DEFAULT_WARNING_THRESHOLDS, redistributionCostSharePercent: 10 }
            );
            assert.strictEqual(warnings.length, 1);
        });
    });

    suite('HIGH_SKEW', () => {
        test('fires when max deviates from avg beyond the skew ratio', () => {
            const warnings = computeWarnings({
                traits: JOIN_TRAITS, hddWrite: undefined, net: undefined, costPercent: undefined,
                perNodeStats: { metric: 'rows', min: 10, max: 1000, avg: 300, nodeCount: 4 }
            });
            assert.strictEqual(warnings.length, 1);
            assert.strictEqual(warnings[0].type, 'HIGH_SKEW');
        });

        test('does not fire when nodes are evenly balanced', () => {
            const warnings = computeWarnings({
                traits: JOIN_TRAITS, hddWrite: undefined, net: undefined, costPercent: undefined,
                perNodeStats: { metric: 'rows', min: 95, max: 105, avg: 100, nodeCount: 4 }
            });
            assert.strictEqual(warnings.length, 0);
        });

        test('never fires when perNodeStats is undefined, no matter how skewed the (unmeasured) data might be', () => {
            const warnings = computeWarnings({ traits: JOIN_TRAITS, hddWrite: undefined, net: undefined, perNodeStats: undefined, costPercent: undefined });
            assert.strictEqual(warnings.length, 0);
        });

        test('does not fire for a single-node cluster even with a nonzero ratio', () => {
            const warnings = computeWarnings({
                traits: JOIN_TRAITS, hddWrite: undefined, net: undefined, costPercent: undefined,
                perNodeStats: { metric: 'rows', min: 100, max: 100, avg: 100, nodeCount: 1 }
            });
            assert.strictEqual(warnings.length, 0);
        });
    });

    suite('ROW_ESTIMATE_MISMATCH', () => {
        test('never fires in v1 — no estimated-rows input exists to compare against', () => {
            const warnings = computeWarnings({
                traits: JOIN_TRAITS, hddWrite: 100, net: 500, costPercent: 50,
                perNodeStats: { metric: 'rows', min: 1, max: 1000, avg: 100, nodeCount: 4 }
            });
            assert.ok(!warnings.some(w => w.type === 'ROW_ESTIMATE_MISMATCH'));
        });
    });

    suite('multiple warnings on one node', () => {
        test('an operator can accumulate more than one warning at once', () => {
            const warnings = computeWarnings({
                traits: JOIN_TRAITS, hddWrite: 50, net: 500, costPercent: 50,
                perNodeStats: { metric: 'rows', min: 1, max: 1000, avg: 100, nodeCount: 4 }
            });
            const types = warnings.map(w => w.type).sort();
            assert.deepStrictEqual(types, ['HIGH_SKEW', 'LARGE_REDISTRIBUTION', 'SPILLED_TO_DISK']);
        });
    });
});
