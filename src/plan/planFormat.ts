/**
 * Pure number/label formatting shared by every Plan renderer (HTML cards in
 * planWebview.ts, the clipboard text summary in planTextExport.ts). Kept in
 * one place so a copied plan always shows the exact same numbers as the
 * on-screen cards it was copied from.
 */
import { OperatorType, Plan } from './planModel';

/** SYSTEM/OTHER deliberately get symbols instead of a first-letter initial —
 * they aren't real data-flow operators, and a symbol makes that legible at a
 * glance rather than implying a made-up initial. ⚙ (bookkeeping) and ⋯
 * (uncategorized, not an error) were chosen over a bare "·"/"?" after those
 * read as barely-visible and alarming respectively in real screenshots. */
export const OPERATOR_BADGE: Record<OperatorType, string> = {
    SCAN: 'S', JOIN: 'J', GROUP_BY: 'G', SORT: 'O', NETWORK: 'N', DML: 'D', SYSTEM: '⚙', SYNC: '‖', OTHER: '⋯'
};

export const OPERATOR_COLOR_VAR: Record<OperatorType, string> = {
    SCAN: '--vscode-charts-blue',
    JOIN: '--vscode-charts-purple',
    GROUP_BY: '--vscode-charts-green',
    SORT: '--vscode-charts-yellow',
    NETWORK: '--vscode-charts-orange',
    DML: '--vscode-charts-red',
    SYSTEM: '--vscode-descriptionForeground',
    // Every other slot in VS Code's charts palette is already claimed above
    // (orange: NETWORK, yellow: SORT); charts.pink is the next distinct,
    // themed color VS Code exposes rather than reusing another type's hue.
    SYNC: '--vscode-charts-pink',
    OTHER: '--vscode-foreground'
};

export const OPERATOR_TYPE_LABEL: Record<OperatorType, string> = {
    SCAN: 'Scan', JOIN: 'Join', GROUP_BY: 'Group By', SORT: 'Sort',
    NETWORK: 'Network', DML: 'DML', SYSTEM: 'System', SYNC: 'Sync', OTHER: 'Other'
};

export function fmtMs(seconds: number | undefined): string {
    if (seconds === undefined) {
        return '—';
    }
    const ms = seconds * 1000;
    if (ms < 1) {
        return `${ms.toFixed(3)} ms`;
    }
    if (ms < 100) {
        return `${ms.toFixed(1)} ms`;
    }
    return `${ms.toFixed(0)} ms`;
}

export function fmtRows(n: number | undefined): string {
    if (n === undefined) {
        return '—';
    }
    const roundedMillions = n / 1_000_000;
    if (n >= 1_000_000_000 || roundedMillions >= 999.5) {
        return `${(n / 1_000_000_000).toFixed(n >= 99_950_000_000 ? 0 : 1)}B`;
    }
    const roundedThousands = n / 1_000;
    if (n >= 1_000_000 || roundedThousands >= 999.5) {
        return `${(n / 1_000_000).toFixed(n >= 99_950_000 ? 0 : 1)}M`;
    }
    if (n >= 1_000) {
        return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
    }
    return String(n);
}

export function fmtPct(p: number | undefined): string {
    if (p === undefined) {
        return '—';
    }
    return p < 1 ? '<1%' : `${p.toFixed(0)}%`;
}

export function fmtMiB(n: number | undefined): string {
    if (n === undefined) {
        return '—';
    }
    return `${n.toFixed(1)} MiB`;
}

/** Shared so CPU always renders identically wherever it's shown — previously
 * inlined separately in planWebview.ts and planTextExport.ts, which is an
 * easy place for the two to drift apart. */
export function fmtCpuPct(n: number | undefined): string {
    if (n === undefined) {
        return '—';
    }
    return `${n}%`;
}

export function planSourceLabel(source: Plan['source']): string {
    return source === 'DETAILS' ? 'per-node detail' : source === 'DBA_SUMMARY' ? 'cluster summary (DBA)' : 'cluster summary';
}

/** The largest per-node cluster size observed across nodes, or undefined if
 * no node had per-node stats at all (see Plan.perNodeStatsAvailable). */
export function planClusterSize(plan: Plan): number | undefined {
    const counts = plan.nodes
        .map(n => n.perNodeStats?.nodeCount)
        .filter((n): n is number => n !== undefined);
    return counts.length > 0 ? Math.max(...counts) : undefined;
}

export interface CategoryTime {
    type: OperatorType;
    label: string;
    colorVar: string;
    /** Sum of every node's own duration for this operator type, in seconds. */
    durationSum: number;
    /** Share of plan.totalDuration, 0-100. */
    percent: number;
}

/**
 * Buckets every node's real per-node `duration` by its `operatorType`, sorted
 * by share descending. Never estimated: a node with an undefined duration
 * simply contributes nothing, rather than being counted as zero or dropped
 * from totalDuration's denominator.
 */
export function planCategoryBreakdown(plan: Plan): CategoryTime[] {
    if (plan.totalDuration <= 0) {
        return [];
    }

    const sums = new Map<OperatorType, number>();
    for (const node of plan.nodes) {
        if (node.duration === undefined) {
            continue;
        }
        sums.set(node.operatorType, (sums.get(node.operatorType) ?? 0) + node.duration);
    }

    return Array.from(sums.entries())
        .map(([type, durationSum]) => ({
            type,
            label: OPERATOR_TYPE_LABEL[type],
            colorVar: OPERATOR_COLOR_VAR[type],
            durationSum,
            percent: (durationSum / plan.totalDuration) * 100
        }))
        .sort((a, b) => b.percent - a.percent);
}

/**
 * True when no node has recorded CPU or network data. This usually means
 * profiling was not active for the session when the statement ran.
 */
export function planLacksDetailMetrics(plan: Plan): boolean {
    return plan.nodes.length > 0 && plan.nodes.every(n => n.cpu === undefined && n.net === undefined);
}

/**
 * The id of the single node with the highest costPercent in the plan, or
 * undefined if no node has a defined costPercent. A ties-go-to-first rule
 * (Array.reduce's default) rather than declaring multiple "hot" nodes keeps
 * the visual signal singular and unambiguous.
 */
export function hottestNodeId(plan: Plan): string | undefined {
    let hottest: { id: string; costPercent: number } | undefined;
    for (const node of plan.nodes) {
        // System steps (COMPILE, EXECUTE, ...) carry share-of-total while
        // user operators carry share-of-query (see PlanNode.costPercent /
        // finding 2) — mixing the two denominators here would let a system
        // step outrank an actionable operator on numbers that aren't
        // comparable. System overhead also isn't an actionable "hot spot" to
        // chase; it's already visible via its own ring share and the
        // category rail, so it's excluded from the hot-node race entirely.
        if (node.traits.isSystemStep || node.costPercent === undefined) {
            continue;
        }
        if (!hottest || node.costPercent > hottest.costPercent) {
            hottest = { id: node.id, costPercent: node.costPercent };
        }
    }
    return hottest?.id;
}
