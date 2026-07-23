/**
 * Pure normalization: raw EXA_*_PROFILE_* / $EXA_PROFILE_DETAILS_LAST_DAY
 * rows -> the normalized Plan model (planModel.ts).
 *
 * Zero VS Code / driver dependencies by design, so this is testable with
 * plain sample row data — this file is the only place that needs to know
 * what Exasol's profile columns are named.
 */
import { Plan, PlanNode, PerNodeStat } from './planModel';
import { classifyOperator } from './operatorTaxonomy';
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

/**
 * Collapses the rows for one PART_ID into a single representative row plus
 * (when the rows came from $EXA_PROFILE_DETAILS_LAST_DAY, i.e. carry IPROC)
 * a real per-node PerNodeStat on OUT_ROWS. Never invents a PerNodeStat for
 * rows that didn't actually carry a node identifier.
 */
function collapseGroup(rows: RawProfileRow[]): { collapsed: RawProfileRow; perNodeStats: PerNodeStat | undefined } {
    const first = rows[0];
    const isPerNode = rows.every(r => r.iproc !== undefined);

    const collapsed: RawProfileRow = {
        ...first,
        objectRows: max(rows.map(r => r.objectRows)),
        outRows: sum(rows.map(r => r.outRows)),
        // The operator isn't done until its slowest node finishes.
        duration: max(rows.map(r => r.duration)),
        cpu: max(rows.map(r => r.cpu)),
        tempDbRamPeak: max(rows.map(r => r.tempDbRamPeak)),
        hddWrite: sum(rows.map(r => r.hddWrite)),
        net: sum(rows.map(r => r.net))
    };

    if (!isPerNode) {
        return { collapsed, perNodeStats: undefined };
    }

    const rowCounts = rows.map(r => r.outRows).filter((v): v is number => v !== undefined);
    if (rowCounts.length === 0) {
        return { collapsed, perNodeStats: undefined };
    }

    const perNodeStats: PerNodeStat = {
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
    };

    return { collapsed, perNodeStats };
}

function buildNode(
    partId: number,
    collapsed: RawProfileRow,
    perNodeStats: PerNodeStat | undefined,
    totalDuration: number,
    thresholds: WarningThresholds
): PlanNode {
    const { operatorType, traits } = classifyOperator(collapsed.partName);
    const costPercent = totalDuration > 0 && collapsed.duration !== undefined
        ? (collapsed.duration / totalDuration) * 100
        : undefined;

    const warnings = computeWarnings(
        { traits, hddWrite: collapsed.hddWrite, net: collapsed.net, perNodeStats, costPercent },
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
        rowsOut: collapsed.outRows,
        duration: collapsed.duration,
        cpu: collapsed.cpu,
        net: collapsed.net,
        tempDbRamPeak: collapsed.tempDbRamPeak,
        hddWrite: collapsed.hddWrite,
        costPercent,
        perNodeStats,
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

    const totalDuration = sum(collapsedByPartId.map(g => g.collapsed.duration)) ?? 0;

    const nodes = collapsedByPartId.map(g =>
        buildNode(g.partId, g.collapsed, g.perNodeStats, totalDuration, thresholds)
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
