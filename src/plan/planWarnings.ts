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
    /** (max - avg) / avg across nodes, above which HIGH_SKEW/HIGH_DURATION_SKEW fire. */
    skewRatio: number;
    /** Share of the query's total duration (0-100) an operator must both
     * exceed and move real network data over, to get LARGE_REDISTRIBUTION. */
    redistributionCostSharePercent: number;
    /** Noise floor for HIGH_SKEW: real per-node ROWS distributions are only
     * worth flagging once the busiest node handled at least this many rows.
     * Live data showed the median part outputs 1 row and 38.6% output under
     * 10 — without this floor, HIGH_SKEW fired constantly on statistically
     * meaningless row counts (e.g. "0-1 rows across 4 nodes"), training users
     * to ignore the warnings rail entirely. */
    skewMinRows: number;
    /** Noise floor for HIGH_DURATION_SKEW, in seconds: the busiest node must
     * have taken at least this long, so a skewed-but-trivial (sub-50ms)
     * duration spread doesn't fire alongside the real row-skew floor above. */
    durationSkewMinSeconds: number;
}

export const DEFAULT_WARNING_THRESHOLDS: WarningThresholds = {
    skewRatio: 0.3,
    redistributionCostSharePercent: 20,
    skewMinRows: 1000,
    durationSkewMinSeconds: 0.05
};

export interface WarningInputs {
    traits: OperatorTraits;
    hddWrite: number | undefined;
    net: number | undefined;
    perNodeStats: PerNodeStat | undefined;
    /** Per-node DURATION distribution — see PlanNode.perNodeDurationStats. */
    perNodeDurationStats: PerNodeStat | undefined;
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
        // skewMinRows: see WarningThresholds doc — without this floor, a
        // handful of rows split unevenly across nodes (statistically
        // meaningless) fired the same warning as a genuine multi-million-row
        // skew.
        if (ratio > thresholds.skewRatio && node.perNodeStats.max >= thresholds.skewMinRows) {
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

    // Duration skew: restricted to blocking, non-system data-flow operators.
    // Non-blocking (pipelined) operators don't wait on their slowest node the
    // same way, and system steps are excluded on the same basis as HIGH_SKEW.
    // Sync barriers (SYNC: producesRows/consumesRows both false) are also
    // excluded even though they're blocking and non-system: a sync barrier's
    // own per-node duration spread just mirrors whatever skew already exists
    // upstream (already warned on the real data-flow operator that caused
    // it), so flagging it too is redundant noise, not a second finding.
    if (
        node.traits.blocking &&
        !node.traits.isSystemStep &&
        (node.traits.producesRows || node.traits.consumesRows) &&
        node.perNodeDurationStats &&
        node.perNodeDurationStats.nodeCount > 1 &&
        node.perNodeDurationStats.avg > 0
    ) {
        const stats = node.perNodeDurationStats;
        const ratio = (stats.max - stats.avg) / stats.avg;
        if (ratio > thresholds.skewRatio && stats.max >= thresholds.durationSkewMinSeconds) {
            warnings.push({
                type: 'HIGH_DURATION_SKEW',
                message: `Slowest node took ${(stats.max * 1000).toFixed(0)}ms vs ` +
                    `${(stats.avg * 1000).toFixed(0)}ms average across ${stats.nodeCount} nodes`,
                detail: {
                    minSeconds: stats.min,
                    maxSeconds: stats.max,
                    avgSeconds: stats.avg,
                    nodeCount: stats.nodeCount,
                    ratio
                }
            });
        }
    }

    // ROW_ESTIMATE_MISMATCH intentionally never fires in v1: see file header.

    return warnings;
}
