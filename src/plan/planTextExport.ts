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

function operatorBlock(node: PlanNode, index: number): string {
    const objectSuffix = node.objectName
        ? ` — ${node.objectSchema ? `${node.objectSchema}.` : ''}${node.objectName}`
        : '';
    const title = `${index + 1}. ${node.operatorLabel} [part ${node.id}]${objectSuffix}`;

    const primaryMetrics = `   Duration: ${fmtMs(node.duration)}  CPU: ${fmtCpuPct(node.cpu)}  ` +
        `Cost: ${fmtPct(node.costPercent)}  Rows out: ${fmtRows(node.rowsOut)}`;

    const secondaryMetrics = joinDefinedFields([
        node.net !== undefined ? `Net: ${fmtMiB(node.net)}` : undefined,
        node.hddWrite !== undefined ? `HDD write: ${fmtMiB(node.hddWrite)}` : undefined,
        node.tempDbRamPeak !== undefined ? `Temp DB RAM peak: ${fmtMiB(node.tempDbRamPeak)}` : undefined
    ]);

    const lines = [
        title,
        primaryMetrics,
        secondaryMetrics !== undefined ? `   ${secondaryMetrics}` : undefined,
        `   ${perNodeRowsLine(node)}`,
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
