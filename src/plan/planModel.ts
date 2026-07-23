/**
 * Normalized execution plan model.
 *
 * This is the only shape the webview (or any other consumer) should ever see.
 * Nothing here encodes Exasol's system table column names directly — that
 * knowledge is isolated to profileRowNormalizer.ts and planProvider.ts so a
 * future Exasol schema change only touches those two files.
 */

/**
 * A small taxonomy of operator traits rather than a flat enum: new operator
 * types just need a traits declaration (see operatorTaxonomy.ts) and every
 * consumer (warnings, rendering) picks up correct behavior automatically.
 */
export type OperatorType = 'SCAN' | 'JOIN' | 'GROUP_BY' | 'SORT' | 'NETWORK' | 'DML' | 'SYSTEM' | 'OTHER';

export interface OperatorTraits {
    /** Reads base/temporary table rows into the pipeline (e.g. SCAN). */
    producesRows: boolean;
    /** Consumes rows from a preceding part (e.g. JOIN, GROUP BY, SORT). */
    consumesRows: boolean;
    /** Can spill to disk under memory pressure (JOIN, GROUP BY, SORT). */
    canSpill: boolean;
    /** Moves data between cluster nodes (redistribution/broadcast). */
    movesDataOverNetwork: boolean;
    /** Must fully consume its input before producing output (blocking) vs pipelined. */
    blocking: boolean;
    /**
     * Execution-engine bookkeeping (COMPILE, COLUMN STATISTICS, INDEX CREATE, ...)
     * rather than a data-flow operator — these exist in real profile traces but
     * are not what a box-and-arrow query plan should render as an operator box.
     */
    isSystemStep: boolean;
}

/**
 * Per-node distribution of a single metric across the cluster, computed only
 * when true per-node rows were available (see planProvider.ts). Never
 * estimated or synthesized — absence of this field means "not measured",
 * not "zero skew".
 */
export interface PerNodeStat {
    metric: 'rows';
    min: number;
    max: number;
    avg: number;
    nodeCount: number;
}

export type WarningType = 'HIGH_SKEW' | 'SPILLED_TO_DISK' | 'LARGE_REDISTRIBUTION' | 'ROW_ESTIMATE_MISMATCH';

export interface PlanWarning {
    type: WarningType;
    message: string;
    /** The raw values/threshold that triggered this warning, for the detail panel. */
    detail: Record<string, number | string>;
}

export interface PlanNode {
    /** PART_ID from the source profile view, as a string (stable within one plan). */
    id: string;
    operatorType: OperatorType;
    /** Raw PART_NAME, verbatim — always shown alongside the derived operatorType. */
    operatorLabel: string;
    traits: OperatorTraits;
    objectSchema: string | undefined;
    objectName: string | undefined;
    /** Free-text detail from PART_INFO/REMARKS, shown in the detail panel/tooltip. */
    partInfo: string | undefined;
    remarks: string | undefined;
    rowsOut: number | undefined;
    duration: number | undefined;
    cpu: number | undefined;
    net: number | undefined;
    tempDbRamPeak: number | undefined;
    hddWrite: number | undefined;
    /** Share of the statement's total duration, derived by the normalizer (not a raw column). */
    costPercent: number | undefined;
    /** undefined when per-node rows were not available for this plan (see Plan.perNodeStatsAvailable). */
    perNodeStats: PerNodeStat | undefined;
    warnings: PlanWarning[];
    /**
     * Operator ids this one consumes from. Left empty in v1: Exasol's profile
     * views expose PART_ID as a flat chronological sequence with no parent/child
     * column, so a true data-flow DAG cannot be derived without fabricating
     * relationships. See Plan.nodes ordering (by PART_ID) for the real signal.
     */
    children: string[];
}

export interface Plan {
    /**
     * Exasol SESSION_ID/STMT_ID values (DECIMAL(20,0)/DECIMAL(12,0)) routinely
     * exceed Number.MAX_SAFE_INTEGER — kept as exact digit strings throughout
     * this module rather than `number` so identifiers are never silently
     * rounded. Only ever compared for equality or interpolated into SQL as a
     * numeric literal, never used arithmetically.
     */
    sessionId: string;
    stmtId: string;
    queryText: string | undefined;
    /** Sum of every node's duration — the denominator for each node's costPercent. */
    totalDuration: number;
    /** Ordered by PART_ID — the one true ordering signal these views provide. */
    nodes: PlanNode[];
    /**
     * Reserved for a future version that can derive real data-flow edges.
     * Always empty in v1 — see PlanNode.children.
     */
    edges: Array<{ from: string; to: string }>;
    /** Whether per-node rows were fetched at all for this plan (privilege-gated). */
    perNodeStatsAvailable: boolean;
    /** Which profile view ultimately supplied the data, for diagnostics/support. */
    source: 'DETAILS' | 'DBA_SUMMARY' | 'USER_SUMMARY';
}
