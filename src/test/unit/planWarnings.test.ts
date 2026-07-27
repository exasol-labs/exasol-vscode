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

const SYNC_TRAITS: OperatorTraits = {
    producesRows: false, consumesRows: false, canSpill: false,
    movesDataOverNetwork: false, blocking: true, isSystemStep: false
};

const SYSTEM_TRAITS: OperatorTraits = {
    producesRows: false, consumesRows: false, canSpill: false,
    movesDataOverNetwork: false, blocking: false, isSystemStep: true
};

suite('computeWarnings', () => {

    suite('SPILLED_TO_DISK', () => {
        test('fires when a spill-capable operator has nonzero HDD_WRITE', () => {
            const warnings = computeWarnings({ traits: JOIN_TRAITS, hddWrite: 12.5, net: undefined, perNodeStats: undefined, perNodeDurationStats: undefined, costPercent: undefined });
            assert.strictEqual(warnings.length, 1);
            assert.strictEqual(warnings[0].type, 'SPILLED_TO_DISK');
            assert.strictEqual(warnings[0].detail.hddWriteMiB, 12.5);
        });

        test('does not fire when HDD_WRITE is zero', () => {
            const warnings = computeWarnings({ traits: JOIN_TRAITS, hddWrite: 0, net: undefined, perNodeStats: undefined, perNodeDurationStats: undefined, costPercent: undefined });
            assert.strictEqual(warnings.length, 0);
        });

        test('does not fire when HDD_WRITE is undefined (metric not reported)', () => {
            const warnings = computeWarnings({ traits: JOIN_TRAITS, hddWrite: undefined, net: undefined, perNodeStats: undefined, perNodeDurationStats: undefined, costPercent: undefined });
            assert.strictEqual(warnings.length, 0);
        });

        test('does not fire on an operator that cannot spill even with nonzero HDD_WRITE', () => {
            const warnings = computeWarnings({ traits: SCAN_TRAITS, hddWrite: 5, net: undefined, perNodeStats: undefined, perNodeDurationStats: undefined, costPercent: undefined });
            assert.strictEqual(warnings.length, 0);
        });
    });

    suite('LARGE_REDISTRIBUTION', () => {
        test('fires when a network-capable operator both moved data and dominates the query\'s time', () => {
            const warnings = computeWarnings({ traits: JOIN_TRAITS, hddWrite: undefined, net: 500, perNodeStats: undefined, perNodeDurationStats: undefined, costPercent: 25 });
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
            const warnings = computeWarnings({ traits: JOIN_TRAITS, hddWrite: undefined, net: 12.34, perNodeStats: undefined, perNodeDurationStats: undefined, costPercent: 20.4 });
            assert.strictEqual(warnings.length, 1);
            assert.ok(warnings[0].message.includes('20.4%'), `expected the exact cost share in the message, got: ${warnings[0].message}`);
            assert.ok(!warnings[0].message.includes('20% of'), 'must not round costPercent down to match the threshold display');
        });

        test('does not fire when the operator\'s cost share is below the threshold, regardless of NET size', () => {
            const warnings = computeWarnings({ traits: JOIN_TRAITS, hddWrite: undefined, net: 500, perNodeStats: undefined, perNodeDurationStats: undefined, costPercent: 5 });
            assert.strictEqual(warnings.length, 0);
        });

        test('does not fire when NET is zero even if the operator dominates query time', () => {
            const warnings = computeWarnings({ traits: JOIN_TRAITS, hddWrite: undefined, net: 0, perNodeStats: undefined, perNodeDurationStats: undefined, costPercent: 90 });
            assert.strictEqual(warnings.length, 0);
        });

        test('does not fire when costPercent is undefined (totalDuration was 0), even with large NET', () => {
            const warnings = computeWarnings({ traits: JOIN_TRAITS, hddWrite: undefined, net: 500, perNodeStats: undefined, perNodeDurationStats: undefined, costPercent: undefined });
            assert.strictEqual(warnings.length, 0);
        });

        test('does not fire on an operator that never moves data over the network, no matter its cost share', () => {
            const warnings = computeWarnings({ traits: SCAN_TRAITS, hddWrite: undefined, net: 999, perNodeStats: undefined, perNodeDurationStats: undefined, costPercent: 90 });
            assert.strictEqual(warnings.length, 0);
        });

        test('respects a custom threshold', () => {
            const warnings = computeWarnings(
                { traits: JOIN_TRAITS, hddWrite: undefined, net: 50, perNodeStats: undefined, perNodeDurationStats: undefined, costPercent: 12 },
                { ...DEFAULT_WARNING_THRESHOLDS, redistributionCostSharePercent: 10 }
            );
            assert.strictEqual(warnings.length, 1);
        });
    });

    suite('HIGH_SKEW', () => {
        test('fires when max deviates from avg beyond the skew ratio, above the row-count noise floor', () => {
            const warnings = computeWarnings({
                traits: JOIN_TRAITS, hddWrite: undefined, net: undefined, costPercent: undefined, perNodeDurationStats: undefined,
                perNodeStats: { metric: 'rows', min: 10, max: 5000, avg: 2505, nodeCount: 4 }
            });
            assert.strictEqual(warnings.length, 1);
            assert.strictEqual(warnings[0].type, 'HIGH_SKEW');
        });

        test('does not fire when nodes are evenly balanced', () => {
            const warnings = computeWarnings({
                traits: JOIN_TRAITS, hddWrite: undefined, net: undefined, costPercent: undefined, perNodeDurationStats: undefined,
                perNodeStats: { metric: 'rows', min: 9500, max: 10500, avg: 10000, nodeCount: 4 }
            });
            assert.strictEqual(warnings.length, 0);
        });

        test('never fires when perNodeStats is undefined, no matter how skewed the (unmeasured) data might be', () => {
            const warnings = computeWarnings({ traits: JOIN_TRAITS, hddWrite: undefined, net: undefined, perNodeStats: undefined, perNodeDurationStats: undefined, costPercent: undefined });
            assert.strictEqual(warnings.length, 0);
        });

        test('does not fire for a single-node cluster even with a nonzero ratio', () => {
            const warnings = computeWarnings({
                traits: JOIN_TRAITS, hddWrite: undefined, net: undefined, costPercent: undefined, perNodeDurationStats: undefined,
                perNodeStats: { metric: 'rows', min: 100000, max: 100000, avg: 100000, nodeCount: 1 }
            });
            assert.strictEqual(warnings.length, 0);
        });

        suite('skewMinRows noise floor (finding 1)', () => {
            // Live data: median part outputs 1 row, 38.6% under 10 — a
            // skewed-but-tiny row count (e.g. "0-1 rows across 4 nodes") is
            // statistically meaningless, not a real signal, and used to fire
            // just as loudly as a genuine multi-million-row skew.
            test('a skewed max just under the floor (999) stays silent', () => {
                const warnings = computeWarnings({
                    traits: JOIN_TRAITS, hddWrite: undefined, net: undefined, costPercent: undefined, perNodeDurationStats: undefined,
                    perNodeStats: { metric: 'rows', min: 0, max: 999, avg: 100, nodeCount: 4 }
                });
                assert.strictEqual(warnings.length, 0, 'a max of 999 rows is below the default 1000-row floor and must not fire');
            });

            test('a skewed max exactly at the floor (1000) is eligible to fire', () => {
                const warnings = computeWarnings({
                    traits: JOIN_TRAITS, hddWrite: undefined, net: undefined, costPercent: undefined, perNodeDurationStats: undefined,
                    perNodeStats: { metric: 'rows', min: 0, max: 1000, avg: 100, nodeCount: 4 }
                });
                assert.strictEqual(warnings.length, 1, 'a max of exactly 1000 rows meets the default floor and, with this skew ratio, must fire');
            });

            test('respects a custom skewMinRows threshold', () => {
                const warnings = computeWarnings(
                    {
                        traits: JOIN_TRAITS, hddWrite: undefined, net: undefined, costPercent: undefined, perNodeDurationStats: undefined,
                        perNodeStats: { metric: 'rows', min: 0, max: 50, avg: 10, nodeCount: 4 }
                    },
                    { ...DEFAULT_WARNING_THRESHOLDS, skewMinRows: 10 }
                );
                assert.strictEqual(warnings.length, 1, 'a lowered floor of 10 rows must let a max of 50 fire');
            });
        });
    });

    suite('HIGH_DURATION_SKEW', () => {
        test('fires on a blocking, non-system operator whose slowest node badly exceeds the average', () => {
            const warnings = computeWarnings({
                traits: JOIN_TRAITS, hddWrite: undefined, net: undefined, costPercent: undefined, perNodeStats: undefined,
                perNodeDurationStats: { metric: 'duration', min: 0.05, max: 2, avg: 0.5, nodeCount: 4 }
            });
            assert.strictEqual(warnings.length, 1);
            assert.strictEqual(warnings[0].type, 'HIGH_DURATION_SKEW');
            assert.ok(warnings[0].message.includes('2000ms'), `expected the slowest node's ms in the message, got: ${warnings[0].message}`);
            assert.ok(warnings[0].message.includes('500ms'), `expected the average ms in the message, got: ${warnings[0].message}`);
            assert.ok(warnings[0].message.includes('4 nodes'));
        });

        test('does not fire on a non-blocking operator (e.g. SCAN), even with a large duration spread', () => {
            const warnings = computeWarnings({
                traits: SCAN_TRAITS, hddWrite: undefined, net: undefined, costPercent: undefined, perNodeStats: undefined,
                perNodeDurationStats: { metric: 'duration', min: 0.05, max: 2, avg: 0.5, nodeCount: 4 }
            });
            assert.strictEqual(warnings.length, 0);
        });

        test('does not fire on a system step, even one flagged blocking', () => {
            const warnings = computeWarnings({
                traits: { ...SYSTEM_TRAITS, blocking: true }, hddWrite: undefined, net: undefined, costPercent: undefined, perNodeStats: undefined,
                perNodeDurationStats: { metric: 'duration', min: 0.05, max: 2, avg: 0.5, nodeCount: 4 }
            });
            assert.strictEqual(warnings.length, 0);
        });

        test('does not fire on a SYNC-shaped operator (blocking, not a system step, but produces/consumes nothing) — its spread just mirrors upstream skew already warned on elsewhere', () => {
            const warnings = computeWarnings({
                traits: SYNC_TRAITS, hddWrite: undefined, net: undefined, costPercent: undefined, perNodeStats: undefined,
                perNodeDurationStats: { metric: 'duration', min: 0.05, max: 2, avg: 0.5, nodeCount: 4 }
            });
            assert.strictEqual(warnings.length, 0);
        });

        test('fires on a JOIN-shaped operator (blocking, non-system, real data-flow) with the same skew', () => {
            const warnings = computeWarnings({
                traits: JOIN_TRAITS, hddWrite: undefined, net: undefined, costPercent: undefined, perNodeStats: undefined,
                perNodeDurationStats: { metric: 'duration', min: 0.05, max: 2, avg: 0.5, nodeCount: 4 }
            });
            assert.strictEqual(warnings.length, 1);
            assert.strictEqual(warnings[0].type, 'HIGH_DURATION_SKEW');
        });

        test('does not fire when perNodeDurationStats is undefined', () => {
            const warnings = computeWarnings({ traits: JOIN_TRAITS, hddWrite: undefined, net: undefined, costPercent: undefined, perNodeStats: undefined, perNodeDurationStats: undefined });
            assert.strictEqual(warnings.length, 0);
        });

        test('does not fire for a single-node cluster', () => {
            const warnings = computeWarnings({
                traits: JOIN_TRAITS, hddWrite: undefined, net: undefined, costPercent: undefined, perNodeStats: undefined,
                perNodeDurationStats: { metric: 'duration', min: 1, max: 1, avg: 1, nodeCount: 1 }
            });
            assert.strictEqual(warnings.length, 0);
        });

        test('does not fire when nodes are evenly balanced', () => {
            const warnings = computeWarnings({
                traits: JOIN_TRAITS, hddWrite: undefined, net: undefined, costPercent: undefined, perNodeStats: undefined,
                perNodeDurationStats: { metric: 'duration', min: 0.95, max: 1.05, avg: 1, nodeCount: 4 }
            });
            assert.strictEqual(warnings.length, 0);
        });

        suite('durationSkewMinSeconds noise floor', () => {
            test('a skewed-but-trivial spread under the 50ms floor stays silent', () => {
                const warnings = computeWarnings({
                    traits: JOIN_TRAITS, hddWrite: undefined, net: undefined, costPercent: undefined, perNodeStats: undefined,
                    perNodeDurationStats: { metric: 'duration', min: 0.001, max: 0.04, avg: 0.01, nodeCount: 4 }
                });
                assert.strictEqual(warnings.length, 0, 'the slowest node (40ms) is below the default 50ms floor');
            });

            test('a spread at exactly the 50ms floor is eligible to fire', () => {
                const warnings = computeWarnings({
                    traits: JOIN_TRAITS, hddWrite: undefined, net: undefined, costPercent: undefined, perNodeStats: undefined,
                    perNodeDurationStats: { metric: 'duration', min: 0.001, max: 0.05, avg: 0.01, nodeCount: 4 }
                });
                assert.strictEqual(warnings.length, 1);
            });

            test('respects a custom durationSkewMinSeconds threshold', () => {
                const warnings = computeWarnings(
                    {
                        traits: JOIN_TRAITS, hddWrite: undefined, net: undefined, costPercent: undefined, perNodeStats: undefined,
                        perNodeDurationStats: { metric: 'duration', min: 0.001, max: 0.02, avg: 0.005, nodeCount: 4 }
                    },
                    { ...DEFAULT_WARNING_THRESHOLDS, durationSkewMinSeconds: 0.01 }
                );
                assert.strictEqual(warnings.length, 1, 'a lowered floor of 10ms must let a 20ms slowest node fire');
            });
        });
    });

    suite('ROW_ESTIMATE_MISMATCH', () => {
        test('never fires in v1 — no estimated-rows input exists to compare against', () => {
            const warnings = computeWarnings({
                traits: JOIN_TRAITS, hddWrite: 100, net: 500, costPercent: 50,
                perNodeStats: { metric: 'rows', min: 1, max: 5000, avg: 1000, nodeCount: 4 },
                perNodeDurationStats: { metric: 'duration', min: 0.05, max: 2, avg: 0.5, nodeCount: 4 }
            });
            assert.ok(!warnings.some(w => w.type === 'ROW_ESTIMATE_MISMATCH'));
        });
    });

    suite('multiple warnings on one node', () => {
        test('an operator can accumulate more than one warning at once', () => {
            const warnings = computeWarnings({
                traits: JOIN_TRAITS, hddWrite: 50, net: 500, costPercent: 50,
                perNodeStats: { metric: 'rows', min: 1, max: 5000, avg: 1000, nodeCount: 4 },
                perNodeDurationStats: { metric: 'duration', min: 0.05, max: 2, avg: 0.5, nodeCount: 4 }
            });
            const types = warnings.map(w => w.type).sort();
            assert.deepStrictEqual(types, ['HIGH_DURATION_SKEW', 'HIGH_SKEW', 'LARGE_REDISTRIBUTION', 'SPILLED_TO_DISK']);
        });
    });
});
