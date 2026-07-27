/**
 * Pure normalization: raw EXA_*_PROFILE_* / $EXA_PROFILE_DETAILS_LAST_DAY
 * rows -> the normalized Plan model (planModel.ts).
 *
 * Zero VS Code / driver dependencies by design, so this is testable with
 * plain sample row data — this file is the only place that needs to know
 * what Exasol's profile columns are named.
 */
import { Plan, PlanNode, PerNodeStat } from './planModel';
import { classifyOperator, OperatorClassification } from './operatorTaxonomy';
import { computeWarnings, WarningThresholds, DEFAULT_WARNING_THRESHOLDS } from './planWarnings';

/** One profile row, field names shared verbatim across all three source views
 * except iproc/inRows/memPeak which only $EXA_PROFILE_DETAILS_LAST_DAY provides. */
export interface RawProfileRow {
    /** Kept as an exact digit string — see Plan.sessionId/stmtId in planModel.ts. */
    sessionId: string;
    stmtId: string;
    partId: number;
    /** Node index within the cluster — present only from $EXA_PROFILE_DETAILS_LAST_DAY. */
    iproc: number | undefined;
    partName: string;
    partInfo: string | undefined;
    objectSchema: string | undefined;
    objectName: string | undefined;
    objectRows: number | undefined;
    outRows: number | undefined;
    duration: number | undefined;
    cpu: number | undefined;
    tempDbRamPeak: number | undefined;
    hddWrite: number | undefined;
    /** HDD_READ, MiB/s — see PlanNode.hddRead in planModel.ts. */
    hddRead: number | undefined;
    net: number | undefined;
    remarks: string | undefined;
    sqlText: string | undefined;
}

export type ProfileSource = Plan['source'];

function toNumber(value: unknown): number | undefined {
    if (value === null || value === undefined || value === '') {
        return undefined;
    }
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : undefined;
}

function toStringOrUndefined(value: unknown): string | undefined {
    if (value === null || value === undefined) {
        return undefined;
    }
    const s = String(value);
    return s.length > 0 ? s : undefined;
}

/**
 * Maps one raw driver row (column names as returned by getRowsFromResult,
 * e.g. row.PART_ID) into the typed RawProfileRow shape. Tolerant of the
 * driver returning numeric columns as strings.
 */
export function mapDbRowToRawProfileRow(row: Record<string, unknown>): RawProfileRow {
    return {
        sessionId: toStringOrUndefined(row.SESSION_ID) ?? '',
        stmtId: toStringOrUndefined(row.STMT_ID) ?? '',
        partId: toNumber(row.PART_ID) ?? 0,
        iproc: toNumber(row.IPROC),
        partName: toStringOrUndefined(row.PART_NAME) ?? 'UNKNOWN',
        partInfo: toStringOrUndefined(row.PART_INFO),
        objectSchema: toStringOrUndefined(row.OBJECT_SCHEMA),
        objectName: toStringOrUndefined(row.OBJECT_NAME),
        objectRows: toNumber(row.OBJECT_ROWS),
        outRows: toNumber(row.OUT_ROWS),
        duration: toNumber(row.DURATION),
        cpu: toNumber(row.CPU),
        tempDbRamPeak: toNumber(row.TEMP_DB_RAM_PEAK),
        hddWrite: toNumber(row.HDD_WRITE),
        hddRead: toNumber(row.HDD_READ),
        net: toNumber(row.NET),
        remarks: toStringOrUndefined(row.REMARKS),
        sqlText: toStringOrUndefined(row.SQL_TEXT)
    };
}

function sum(values: Array<number | undefined>): number | undefined {
    const defined = values.filter((v): v is number => v !== undefined);
    return defined.length > 0 ? defined.reduce((a, b) => a + b, 0) : undefined;
}

function max(values: Array<number | undefined>): number | undefined {
    const defined = values.filter((v): v is number => v !== undefined);
    return defined.length > 0 ? Math.max(...defined) : undefined;
}

interface CollapsedGroup {
    collapsed: RawProfileRow;
    perNodeStats: PerNodeStat | undefined;
    perNodeDurationStats: PerNodeStat | undefined;
}

/**
 * Collapses the rows for one PART_ID into a single representative row plus
 * (when the rows came from $EXA_PROFILE_DETAILS_LAST_DAY, i.e. carry IPROC)
 * real per-node PerNodeStats on OUT_ROWS and DURATION. Never invents a
 * PerNodeStat for rows that didn't actually carry a node identifier.
 */
function collapseGroup(rows: RawProfileRow[]): CollapsedGroup {
    const first = rows[0];
    const isPerNode = rows.every(r => r.iproc !== undefined);

    const collapsed: RawProfileRow = {
        ...first,
        // Selectivity's numerator (see PlanNode.objectRows): in the
        // per-IPROC details tier, OBJECT_ROWS is the node-local shard row
        // count (verified live: a 176,792-row temp table reported
        // OBJECT_ROWS 44,632 per node across 4 nodes), i.e. the same
        // per-node scale as OUT_ROWS — so it must sum across rows exactly
        // like OUT_ROWS does, not max. Summary tiers (one row per part, no
        // IPROC) are unaffected either way. A prior max-vs-sum mismatch here
        // mixed a per-node scale with a cluster scale and could render
        // selectivity over 100%.
        objectRows: sum(rows.map(r => r.objectRows)),
        outRows: sum(rows.map(r => r.outRows)),
        // The operator isn't done until its slowest node finishes.
        duration: max(rows.map(r => r.duration)),
        cpu: max(rows.map(r => r.cpu)),
        tempDbRamPeak: max(rows.map(r => r.tempDbRamPeak)),
        hddWrite: sum(rows.map(r => r.hddWrite)),
        // HDD_READ is a per-node RATE (MiB/s), not a volume — summing rates
        // across nodes would not mean anything, so it collapses the same way
        // as duration/cpu: the max observed rate across nodes.
        hddRead: max(rows.map(r => r.hddRead)),
        net: sum(rows.map(r => r.net))
    };

    if (!isPerNode) {
        return { collapsed, perNodeStats: undefined, perNodeDurationStats: undefined };
    }

    const rowCounts = rows.map(r => r.outRows).filter((v): v is number => v !== undefined);
    const perNodeStats: PerNodeStat | undefined = rowCounts.length > 0 ? {
        metric: 'rows',
        min: Math.min(...rowCounts),
        max: Math.max(...rowCounts),
        avg: rowCounts.reduce((a, b) => a + b, 0) / rowCounts.length,
        // Must be rowCounts.length, not rows.length: if some IPROC rows carry
        // an undefined OUT_ROWS, min/max/avg above are only ever computed from
        // rowCounts — using the larger rows.length here would describe a
        // "nodeCount" that doesn't match the population the other three
        // fields summarize (e.g. an avg over 2 real values mislabeled as
        // spanning 3 nodes, understating the true skew ratio in the process).
        nodeCount: rowCounts.length
    } : undefined;

    // Independent of perNodeStats above: a node group can have per-node
    // DURATION values (every real IPROC row carries one) even when OUT_ROWS
    // itself is missing, so this is computed from its own defined population
    // rather than gated on rowCounts.
    const durations = rows.map(r => r.duration).filter((v): v is number => v !== undefined);
    const perNodeDurationStats: PerNodeStat | undefined = durations.length > 0 ? {
        metric: 'duration',
        min: Math.min(...durations),
        max: Math.max(...durations),
        avg: durations.reduce((a, b) => a + b, 0) / durations.length,
        nodeCount: durations.length
    } : undefined;

    return { collapsed, perNodeStats, perNodeDurationStats };
}

function buildNode(
    partId: number,
    collapsed: RawProfileRow,
    perNodeStats: PerNodeStat | undefined,
    perNodeDurationStats: PerNodeStat | undefined,
    classification: OperatorClassification,
    totalDuration: number,
    nonSystemDuration: number,
    thresholds: WarningThresholds
): PlanNode {
    const { operatorType, traits } = classification;
    // See PlanNode.costPercent in planModel.ts: system steps divide by the
    // whole plan (there is no more meaningful denominator for COMPILE/
    // EXECUTE); every other node divides by totalDuration with system-step
    // time already subtracted out, so bookkeeping no longer deflates every
    // real operator's share.
    const denominator = traits.isSystemStep ? totalDuration : nonSystemDuration;
    const costPercent = denominator > 0 && collapsed.duration !== undefined
        ? (collapsed.duration / denominator) * 100
        : undefined;

    const warnings = computeWarnings(
        { traits, hddWrite: collapsed.hddWrite, net: collapsed.net, perNodeStats, perNodeDurationStats, costPercent },
        thresholds
    );

    return {
        id: String(partId),
        operatorType,
        operatorLabel: collapsed.partName,
        traits,
        objectSchema: collapsed.objectSchema,
        objectName: collapsed.objectName,
        partInfo: collapsed.partInfo,
        remarks: collapsed.remarks,
        objectRows: collapsed.objectRows,
        rowsOut: collapsed.outRows,
        duration: collapsed.duration,
        cpu: collapsed.cpu,
        net: collapsed.net,
        tempDbRamPeak: collapsed.tempDbRamPeak,
        hddWrite: collapsed.hddWrite,
        hddRead: collapsed.hddRead,
        costPercent,
        perNodeStats,
        perNodeDurationStats,
        warnings,
        // No parent/child column exists in any of these profile views — see
        // planModel.ts. Node ordering (by PART_ID) is the real signal.
        children: []
    };
}

/**
 * Builds the normalized Plan from raw profile rows already scoped to one
 * (sessionId, stmtId) — the caller (planProvider) is responsible for that
 * filtering via SQL WHERE clauses; this function additionally defends by
 * ignoring any row that doesn't match, rather than trusting the caller blindly.
 */
export function normalizeProfileRows(
    rawRows: Record<string, unknown>[],
    context: { sessionId: string; stmtId: string; source: ProfileSource },
    thresholds: WarningThresholds = DEFAULT_WARNING_THRESHOLDS
): Plan {
    const rows = rawRows
        .map(mapDbRowToRawProfileRow)
        .filter(r => r.sessionId === context.sessionId && r.stmtId === context.stmtId);

    const byPartId = new Map<number, RawProfileRow[]>();
    for (const row of rows) {
        const group = byPartId.get(row.partId);
        if (group) {
            group.push(row);
        } else {
            byPartId.set(row.partId, [row]);
        }
    }

    const partIds = Array.from(byPartId.keys()).sort((a, b) => a - b);
    const collapsedByPartId = partIds.map(partId => ({ partId, ...collapseGroup(byPartId.get(partId)!) }));

    // Classified up front (not inside buildNode) because the F2 denominator
    // below needs isSystemStep for every node before any node can be built.
    const classifications = collapsedByPartId.map(g => classifyOperator(g.collapsed.partName));

    // Plan.totalDuration itself is untouched by this — it stays wall-time
    // over every node (system steps included) for the overview's "Total
    // time" figure. nonSystemDuration is only ever used as costPercent's
    // denominator for non-system nodes (see buildNode above).
    const totalDuration = sum(collapsedByPartId.map(g => g.collapsed.duration)) ?? 0;
    const systemDuration = sum(
        collapsedByPartId.map((g, i) => classifications[i].traits.isSystemStep ? g.collapsed.duration : undefined)
    ) ?? 0;
    const nonSystemDuration = totalDuration - systemDuration;

    const nodes = collapsedByPartId.map((g, i) =>
        buildNode(
            g.partId, g.collapsed, g.perNodeStats, g.perNodeDurationStats,
            classifications[i], totalDuration, nonSystemDuration, thresholds
        )
    );

    const perNodeStatsAvailable = nodes.some(n => n.perNodeStats !== undefined);
    const queryText = rows.find(r => r.sqlText !== undefined)?.sqlText;

    return {
        sessionId: context.sessionId,
        stmtId: context.stmtId,
        queryText,
        totalDuration,
        nodes,
        edges: [],
        perNodeStatsAvailable,
        source: context.source
    };
}
