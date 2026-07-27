/**
 * Renders a normalized Plan as a plain-text summary for clipboard export.
 *
 * Deliberately block-formatted rather than column-aligned: a fixed-width
 * table only looks right in a monospace-rendering destination, and a copied
 * plan is just as likely to land in a proportional-font target (a Jira/
 * support-ticket comment box, a Slack message, an email) where misaligned
 * columns read worse than no alignment at all.
 *
 * Deliberately full parity with the on-screen detail panel (nodeDetailHtml
 * in planWebview.ts), not just the compact card face: CPU, Net, HDD write,
 * Temp DB RAM peak, and per-node skew all show up here too, whenever Exasol
 * actually reported a value for them — undefined means "not measured" and
 * is omitted, never shown as a fake zero.
 */
import { Plan, PlanNode } from './planModel';
import { fmtMs, fmtPct, fmtRows, fmtMiB, fmtCpuPct, planSourceLabel, planClusterSize } from './planFormat';

function joinDefinedFields(fields: Array<string | undefined>): string | undefined {
    const defined = fields.filter((f): f is string => f !== undefined);
    return defined.length > 0 ? defined.join('  ') : undefined;
}

function perNodeRowsLine(node: PlanNode): string {
    if (!node.perNodeStats) {
        return 'Per-node rows: not available';
    }
    const s = node.perNodeStats;
    return `Per-node rows: min ${s.min} / max ${s.max} / avg ${s.avg.toFixed(0)} / nodes ${s.nodeCount}`;
}

/** Same "not available" convention as perNodeRowsLine — but only when
 * per-node rows were fetched at all; when they weren't, per-node durations
 * were never computable either, and repeating "not available" for both
 * lines every single time (the common no-detail case) is pure noise. Also
 * omitted below the 1ms noise floor — see the identical check in
 * nodePopoverHtml (planWebview.ts). */
function perNodeDurationLine(node: PlanNode): string | undefined {
    if (!node.perNodeDurationStats || node.perNodeDurationStats.max < 0.001) {
        return undefined;
    }
    const s = node.perNodeDurationStats;
    return `Per-node durations: min ${fmtMs(s.min)} / max ${fmtMs(s.max)} / avg ${fmtMs(s.avg)} / nodes ${s.nodeCount}`;
}

/** "N rows -> M (P%)" scan selectivity — see scannedSelectivity() in
 * planWebview.ts for the identical computation shown there. */
function scannedLine(node: PlanNode): string | undefined {
    if (node.objectRows === undefined || node.objectRows === 0 || node.rowsOut === undefined) {
        return undefined;
    }
    const rowsPart = `Scanned: ${node.objectRows.toLocaleString()} rows → ${node.rowsOut.toLocaleString()}`;
    // rowsOut > objectRows means the two numbers are inconsistent — still
    // show the raw counts, but never render a selectivity percentage over
    // 100%, which would read as a real signal rather than a data problem.
    if (node.rowsOut > node.objectRows) {
        return rowsPart;
    }
    const pct = (node.rowsOut / node.objectRows) * 100;
    return `${rowsPart} (${pct.toFixed(1)}%)`;
}

/** Renders one node's full block exactly as it appears inside
 * buildPlanTextSummary()'s output — also the text behind the popover's
 * per-node "Copy" button (see nodePopoverHtml in planWebview.ts), so a
 * single-node copy and the matching block inside a full-plan copy are
 * always character-for-character identical. */
export function operatorBlock(node: PlanNode, index: number): string {
    const objectSuffix = node.objectName
        ? ` — ${node.objectSchema ? `${node.objectSchema}.` : ''}${node.objectName}`
        : '';
    const title = `${index + 1}. ${node.operatorLabel} [part ${node.id}]${objectSuffix}`;

    // Metrics first, in the same order as the popover (planWebview.ts):
    // Duration, Duration share ("Share" — F12 renamed this from "Cost"),
    // CPU (max node), Rows out, then Scanned on its own line below. The
    // share's denominator differs by node kind (see PlanNode.costPercent in
    // planModel.ts) — spelled out here too, or the same operator reads as
    // two contradictory percentages between this export and the side rail's
    // always-of-total category breakdown with no hint why.
    const shareLabel = node.traits.isSystemStep ? 'Share (of total)' : 'Share (of query)';
    const primaryMetrics = `   Duration: ${fmtMs(node.duration)}  ${shareLabel}: ${fmtPct(node.costPercent)}  ` +
        `CPU (max node): ${fmtCpuPct(node.cpu)}  Rows out: ${fmtRows(node.rowsOut)}`;

    const secondaryMetrics = joinDefinedFields([
        node.net !== undefined ? `Net: ${fmtMiB(node.net)}` : undefined,
        node.tempDbRamPeak !== undefined ? `Temp DB RAM peak: ${fmtMiB(node.tempDbRamPeak)}` : undefined,
        node.hddWrite !== undefined ? `HDD write: ${fmtMiB(node.hddWrite)}` : undefined,
        // Deliberately shown only when > 0 — see PlanNode.hddRead in
        // planModel.ts (it's a rate, and 0 is the overwhelming common case).
        node.hddRead !== undefined && node.hddRead > 0 ? `HDD read: ${node.hddRead.toFixed(1)} MiB/s` : undefined
    ]);

    const scanned = scannedLine(node);
    const perNodeDurations = perNodeDurationLine(node);

    const lines = [
        title,
        primaryMetrics,
        scanned !== undefined ? `   ${scanned}` : undefined,
        secondaryMetrics !== undefined ? `   ${secondaryMetrics}` : undefined,
        `   ${perNodeRowsLine(node)}`,
        perNodeDurations !== undefined ? `   ${perNodeDurations}` : undefined,
        node.partInfo ? `   Part info: ${node.partInfo}` : undefined,
        node.remarks ? `   Remarks: ${node.remarks}` : undefined,
        ...node.warnings.map(w => `   ⚠ ${w.message}`)
    ].filter((line): line is string => line !== undefined);

    return lines.join('\n');
}

export function buildPlanTextSummary(plan: Plan): string {
    const clusterSize = planClusterSize(plan);
    const header = [
        `Execution plan — session ${plan.sessionId}, statement ${plan.stmtId}`,
        `Source: ${planSourceLabel(plan.source)}`,
        `Total time: ${fmtMs(plan.totalDuration)}`,
        `Nodes observed: ${clusterSize !== undefined ? clusterSize : 'not available'}`
    ].join('\n');

    if (plan.nodes.length === 0) {
        return `${header}\n\nThis statement produced no profiled operators.\n`;
    }

    const body = plan.nodes.map((node, i) => operatorBlock(node, i)).join('\n\n');
    return `${header}\n\n${body}\n`;
}
