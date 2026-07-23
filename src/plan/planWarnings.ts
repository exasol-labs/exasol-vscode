/**
 * Pure warning computation over an already-normalized node's metrics.
 *
 * Every threshold here is a v1 heuristic, not a value Exasol itself defines —
 * documented per-warning below. None of these ever run against a fabricated
 * or estimated number: HIGH_SKEW only fires when real per-node rows were
 * fetched (see planProvider.ts), and ROW_ESTIMATE_MISMATCH can never fire at
 * all in v1 because these profile views expose no pre-execution row estimate
 * (OBJECT_ROWS/OUT_ROWS are both post-execution actuals) — see honesty
 * constraint in the project brief.
 *
 * LARGE_REDISTRIBUTION deliberately flags by share of total query time, not a
 * fixed byte cutoff. A fixed MiB threshold would not scale across very
 * different query sizes or cluster sizes.
 */
import { OperatorTraits, PerNodeStat, PlanWarning } from './planModel';

export interface WarningThresholds {
    /** (max - avg) / avg across nodes, above which HIGH_SKEW fires. */
    skewRatio: number;
    /** Share of the query's total duration (0-100) an operator must both
     * exceed and move real network data over, to get LARGE_REDISTRIBUTION. */
    redistributionCostSharePercent: number;
}

export const DEFAULT_WARNING_THRESHOLDS: WarningThresholds = {
    skewRatio: 0.3,
    redistributionCostSharePercent: 20
};

export interface WarningInputs {
    traits: OperatorTraits;
    hddWrite: number | undefined;
    net: number | undefined;
    perNodeStats: PerNodeStat | undefined;
    /** Share of the query's total duration this node accounts for — the
     * same number shown on its card. Undefined only when totalDuration
     * itself is 0 (see profileRowNormalizer.ts), in which case
     * LARGE_REDISTRIBUTION cannot be evaluated and never fires. */
    costPercent: number | undefined;
}

export function computeWarnings(
    node: WarningInputs,
    thresholds: WarningThresholds = DEFAULT_WARNING_THRESHOLDS
): PlanWarning[] {
    const warnings: PlanWarning[] = [];

    // Heuristic: nonzero disk write on an operator capable of spilling (JOIN/
    // GROUP BY/SORT). Exasol's profile views have no explicit "spilled" flag,
    // so this infers it from HDD_WRITE > 0 rather than claiming certainty.
    if (node.traits.canSpill && node.hddWrite !== undefined && node.hddWrite > 0) {
        warnings.push({
            type: 'SPILLED_TO_DISK',
            message: `Wrote ${node.hddWrite.toFixed(1)} MiB to disk during execution`,
            detail: { hddWriteMiB: node.hddWrite }
        });
    }

    if (
        node.traits.movesDataOverNetwork &&
        node.net !== undefined &&
        node.net > 0 &&
        node.costPercent !== undefined &&
        node.costPercent > thresholds.redistributionCostSharePercent
    ) {
        warnings.push({
            type: 'LARGE_REDISTRIBUTION',
            // One decimal place here, not zero: with costPercent just over the
            // threshold (e.g. 20.4% vs. a 20% threshold), toFixed(0) rounded
            // both to the same displayed number ("20% ... threshold 20%"),
            // reading as if the warning had fired for no reason.
            message: `Moved ${node.net.toFixed(1)} MiB across the network — this step alone accounted for ` +
                `${node.costPercent.toFixed(1)}% of the query's total time (threshold ${thresholds.redistributionCostSharePercent}%)`,
            detail: { netMiB: node.net, costPercent: node.costPercent, thresholdPercent: thresholds.redistributionCostSharePercent }
        });
    }

    if (node.perNodeStats && node.perNodeStats.nodeCount > 1 && node.perNodeStats.avg > 0) {
        const ratio = (node.perNodeStats.max - node.perNodeStats.avg) / node.perNodeStats.avg;
        if (ratio > thresholds.skewRatio) {
            warnings.push({
                type: 'HIGH_SKEW',
                message: `Rows per node ranged ${node.perNodeStats.min}-${node.perNodeStats.max} ` +
                    `(avg ${node.perNodeStats.avg.toFixed(0)}) across ${node.perNodeStats.nodeCount} nodes`,
                detail: {
                    min: node.perNodeStats.min,
                    max: node.perNodeStats.max,
                    avg: node.perNodeStats.avg,
                    nodeCount: node.perNodeStats.nodeCount,
                    ratio
                }
            });
        }
    }

    // ROW_ESTIMATE_MISMATCH intentionally never fires in v1: see file header.

    return warnings;
}
