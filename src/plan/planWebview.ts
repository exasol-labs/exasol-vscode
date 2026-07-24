/**
 * Renders a normalized Plan as static HTML: a horizontal, left-to-right flow
 * of operator nodes ordered by PART_ID (the one real ordering signal these
 * profile views provide — see planModel.ts). No animation, no live updates;
 * this is regenerated once per plan fetch, matching every other view in
 * ResultsPanel. Horizontal rather than a vertical card stack because the
 * Plan tab lives in VS Code's bottom panel container (wide, short), not a
 * sidebar — see package.json's `panel` viewsContainers entry.
 *
 * Every free-text field on the model (query text, object names, remarks,
 * part info) originates from the database and is escaped via escapeHtml()
 * before being placed in the document — none of it is trusted input.
 *
 * Each node is a real <button>, and clicking it reveals a floating popover
 * with its full detail — anchored right next to the node you clicked, not
 * routed to a persistent panel elsewhere on screen (tried that; it worked,
 * but lost the "detail appears right where I'm looking" immediacy of a
 * popout, which is what this feature is actually for). The popover measures
 * how much room is left below the node before it opens and flips to open
 * *above* instead when there isn't enough (the same trick VS Code's own
 * hover tooltips use) — that, not moving detail to a side panel, is the fix
 * for a popover clipping against the bottom of the panel on a wrapped row.
 * The popover is a sibling of the button (not nested inside it) so it never
 * raises an interactive-content-inside-a-button question.
 *
 * When the flow has enough operators to wrap onto more than one row, the
 * inline <script> below measures where the browser actually broke the rows
 * (this depends on the panel's current width, so it can't be decided up
 * front in this static markup) and restructures alternating rows to read in
 * the opposite direction, continuing directly below where the previous row
 * ended instead of restarting at the far left across a large gap.
 */
import { OperatorType, Plan, PlanNode, PlanWarning } from './planModel';
import { escapeHtml } from '../utils';
import {
    fmtMs, fmtPct, fmtRows, fmtMiB, fmtCpuPct,
    planSourceLabel, planClusterSize, planCategoryBreakdown, hottestNodeId, planLacksDetailMetrics,
    OPERATOR_BADGE, OPERATOR_COLOR_VAR, OPERATOR_TYPE_LABEL
} from './planFormat';
import { buildPlanTextSummary, operatorBlock } from './planTextExport';

const WARNING_LABEL: Record<PlanWarning['type'], string> = {
    HIGH_SKEW: 'skew',
    HIGH_DURATION_SKEW: 'duration skew',
    SPILLED_TO_DISK: 'spilled to disk',
    LARGE_REDISTRIBUTION: 'large redistribution',
    ROW_ESTIMATE_MISMATCH: 'row estimate mismatch'
};

function detailRow(label: string, value: string | undefined): string {
    if (value === undefined) {
        return '';
    }
    return `<div class="plan-detail-row"><span class="plan-detail-k">${escapeHtml(label)}</span><span class="plan-detail-v">${escapeHtml(value)}</span></div>`;
}

/** "N rows -> M (P%)" scan selectivity, or undefined when either side of the
 * ratio isn't available (see PlanNode.objectRows in planModel.ts) or the
 * object reported zero rows (division by zero rather than a signal). */
function scannedSelectivity(node: PlanNode): string | undefined {
    if (node.objectRows === undefined || node.objectRows === 0 || node.rowsOut === undefined) {
        return undefined;
    }
    const rowsPart = `${node.objectRows.toLocaleString()} rows → ${node.rowsOut.toLocaleString()}`;
    // rowsOut > objectRows means the two numbers are inconsistent (e.g. a
    // stale/partial collapse) — still show the raw counts, but never render
    // a selectivity percentage over 100%, which would read as a real signal
    // rather than a data problem.
    if (node.rowsOut > node.objectRows) {
        return rowsPart;
    }
    const pct = (node.rowsOut / node.objectRows) * 100;
    return `${rowsPart} (${pct.toFixed(1)}%)`;
}

/** Duration share is two different denominators depending on node kind (see
 * PlanNode.costPercent in planModel.ts) — the same operator otherwise reads
 * as two contradictory numbers with no hint why (a screenshot showed one
 * node at 45% on its ring, 31% in the side rail's category breakdown, with
 * nothing distinguishing which total each was a share of). Spelling out the
 * denominator in the label itself removes the ambiguity without adding a
 * second, dual-display row. */
function durationShareLabel(node: PlanNode): string {
    return node.traits.isSystemStep ? 'Duration share (of total)' : 'Duration share (of query)';
}

/** Inserts a zero-width space (U+200B) after every '.' and '_' so a long
 * schema-qualified name (e.g. "SNAP_SALESFORCE.CONTRACT_DOCUMENTS") gets a
 * natural break at the schema/table boundary instead of wrapping mid-word.
 * MUST run on the already-escaped string, not the raw one: escapeHtml()
 * never touches '.' or '_' either way, but doing this last removes any need
 * to reason about whether it might. */
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
function withBreakOpportunities(escaped: string): string {
    return escaped.replace(/[._]/g, `$&${ZERO_WIDTH_SPACE}`);
}

/** Full detail for one node, shown in its popover on click — identical
 * field set regardless of how it's displayed. `index` is the node's 0-based
 * position in plan.nodes, needed only to number the embedded per-node copy
 * text (finding 11) identically to its numbering in the full "Copy as text"
 * export (see operatorBlock in planTextExport.ts). */
function nodePopoverHtml(node: PlanNode, index: number): string {
    const titleText = node.objectName
        ? `${node.operatorLabel} — ${node.objectSchema ? `${node.objectSchema}.` : ''}${node.objectName}`
        : node.operatorLabel;

    // Metrics first (the numbers a click here is almost always chasing),
    // then Part info/Remarks — scan popovers carry filter columns in
    // Remarks, worth a glance without scrolling past the rest of the
    // identity block first — then the remaining identity/free-text fields,
    // warnings last (see warningDetails below). Every NUMERIC metric row
    // always renders, using the shared formatters' own "—" for an undefined
    // value, so a field never silently vanishes depending on what this
    // particular node happened to report (identity/text fields — Object,
    // Part info, Remarks — are the exception: omitting them when absent is
    // correct, they're not measurements). HDD read is the one deliberate
    // exception even among numeric fields: shown only when > 0 (see
    // planModel.ts).
    const rows = [
        detailRow('Duration', fmtMs(node.duration)),
        detailRow(durationShareLabel(node), fmtPct(node.costPercent)),
        detailRow('CPU (max node)', fmtCpuPct(node.cpu)),
        detailRow('Rows out', node.rowsOut !== undefined ? node.rowsOut.toLocaleString() : '—'),
        detailRow('Scanned', scannedSelectivity(node)),
        detailRow('Net', fmtMiB(node.net)),
        detailRow('Temp DB RAM peak', fmtMiB(node.tempDbRamPeak)),
        detailRow('HDD write', fmtMiB(node.hddWrite)),
        detailRow('HDD read', node.hddRead !== undefined && node.hddRead > 0 ? `${node.hddRead.toFixed(1)} MiB/s` : undefined),
        detailRow(
            'Per-node rows',
            node.perNodeStats
                ? `min ${node.perNodeStats.min} / max ${node.perNodeStats.max} / avg ${node.perNodeStats.avg.toFixed(0)} / nodes ${node.perNodeStats.nodeCount}`
                : 'not available'
        ),
        detailRow(
            'Per-node durations',
            // Below the 1ms noise floor, a per-node duration spread is
            // measurement granularity, not a real straggler — see the
            // identical floor in planTextExport.ts's perNodeDurationLine().
            node.perNodeDurationStats && node.perNodeDurationStats.max >= 0.001
                ? `min ${fmtMs(node.perNodeDurationStats.min)} / max ${fmtMs(node.perNodeDurationStats.max)} / ` +
                  `avg ${fmtMs(node.perNodeDurationStats.avg)} / nodes ${node.perNodeDurationStats.nodeCount}`
                : undefined
        ),
        detailRow('Part info', node.partInfo),
        detailRow('Remarks', node.remarks),
        detailRow('Part id', node.id),
        detailRow('Operator', `${node.operatorLabel} (${node.operatorType})`),
        detailRow('Object', node.objectSchema ? `${node.objectSchema}.${node.objectName ?? ''}` : node.objectName),
        detailRow(
            'Traits',
            Object.entries(node.traits).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'
        )
    ].filter(Boolean).join('');

    const warningDetails = node.warnings.map(w =>
        `<div class="plan-detail-row"><span class="plan-detail-k">Warning</span><span class="plan-detail-v">${escapeHtml(w.message)}</span></div>`
    ).join('');

    // Per-node copy (finding 11): the exact same text operatorBlock() would
    // render for this node inside the full "Copy as text" export, embedded
    // in a hidden textarea (same CSP-safe pattern as #plan-text-data below)
    // so the click handler has no DOM to build or escape at runtime — it
    // only ever reads a value that was already escaped once, here.
    const copyText = operatorBlock(node, index);

    return `<div class="plan-popover" data-popover hidden>
        <div class="plan-popover-title-row">
            <div class="plan-popover-title">${withBreakOpportunities(escapeHtml(titleText))}</div>
            <button type="button" class="plan-node-copy" data-copy-node="${escapeHtml(node.id)}">⧉ Copy</button>
        </div>
        ${rows}${warningDetails}
        <textarea class="plan-node-copy-data" hidden>${escapeHtml(copyText)}</textarea>
    </div>`;
}

/** Middle-truncates a long object caption (finding 19): keeps the
 * distinguishing tail (e.g. the actual table name after a shared schema/
 * prefix) instead of a leading-only truncation, which made a row of
 * "PIPE FILTERSCAN / SYS.EXA_SESSION_ROL…"-style captions indistinguishable
 * at a glance. Deterministic string slicing, not JS measuring against the
 * rendered font — the popover shows the untruncated name regardless, so
 * nothing is actually lost, only the compact caption is shortened. The CSS
 * text-overflow: ellipsis on .hnode-sub stays as a backstop for whatever
 * this fixed 18-character budget still doesn't cover at an unusual zoom
 * level, not as the primary mechanism. */
function middleTruncateCaption(s: string): string {
    if (s.length <= 18) {
        return s;
    }
    return `${s.slice(0, 8)}…${s.slice(-9)}`;
}

/**
 * One node in the horizontal flow: a ring (fill share = costPercent, red
 * instead of the operator-type color when this is the plan's single
 * highest-cost node), badge letter, name/type, and a short sub-caption. A
 * real <button> (data-node-toggle/data-node-id, aria-expanded reflecting
 * whether its popover is open) so activating it — click, Enter, or Space —
 * opens that popover. The popover is a sibling in the same .hnode-wrap, not
 * nested inside the button. `index` is the node's 0-based position in
 * plan.nodes — see nodePopoverHtml.
 */
function hnodeHtml(node: PlanNode, isHot: boolean, index: number): string {
    const badge = OPERATOR_BADGE[node.operatorType] ?? '?';
    const colorVar = isHot ? '--vscode-charts-red' : (OPERATOR_COLOR_VAR[node.operatorType] ?? '--vscode-descriptionForeground');
    const pct = Math.max(0, Math.min(100, node.costPercent ?? 0));
    const hasWarnings = node.warnings.length > 0;
    const warnTitle = hasWarnings ? node.warnings.map(w => WARNING_LABEL[w.type] ?? w.type).join(', ') : '';

    const durationLine = node.duration !== undefined ? fmtMs(node.duration) : undefined;
    const objectLineRaw = node.objectName ? `${node.objectSchema ? node.objectSchema + '.' : ''}${node.objectName}` : undefined;
    const objectLine = objectLineRaw !== undefined ? middleTruncateCaption(objectLineRaw) : undefined;
    // Dims/italicizes a temp-object caption (finding 20) — PART_INFO already
    // says "on TEMPORARY table"; a novice reading a bare "tmp_subselect3" in
    // the caption has no way to know that without clicking through, and this
    // survives even the truncation above since it's a class on the whole
    // line, not text content.
    const isTempObject = node.partInfo !== undefined && node.partInfo.toUpperCase().includes('TEMPORARY');
    const subLineHtml = [
        durationLine !== undefined ? `<span class="hnode-sub">${escapeHtml(durationLine)}</span>` : undefined,
        objectLine !== undefined
            ? `<span class="hnode-sub${isTempObject ? ' hnode-sub-temp' : ''}">${escapeHtml(objectLine)}</span>`
            : undefined
    ].filter((v): v is string => v !== undefined).join('');

    const typeWords = node.operatorType.replace('_', ' ').toLowerCase();
    const warningSuffix = hasWarnings ? `, ${node.warnings.length} warning${node.warnings.length === 1 ? '' : 's'}` : '';
    const ariaLabel = `${node.operatorLabel}, ${typeWords}, ${fmtPct(node.costPercent)} of total time${warningSuffix}`;

    // Cheap hover peek (finding 9): a one-line title on the button itself —
    // distinct from the ring's own title (the operator type, finding 5) so
    // hovering the ring still names the type while hovering the rest of the
    // card shows the numbers. Only defined parts are included, so a node
    // with no recorded duration/cost doesn't show a dangling "— · —".
    const hoverParts = [
        durationLine,
        node.costPercent !== undefined ? fmtPct(node.costPercent) : undefined,
        hasWarnings ? `${node.warnings.length} warning${node.warnings.length === 1 ? '' : 's'}` : undefined
    ].filter((v): v is string => v !== undefined);
    const titleAttr = hoverParts.length > 0 ? ` title="${escapeHtml(hoverParts.join(' · '))}"` : '';

    return `<div class="hnode-wrap">
        <button type="button" class="hnode${isHot ? ' hnode-hot' : ''}${node.traits.isSystemStep ? ' hnode-system' : ''}"
            data-node-toggle data-node-id="${escapeHtml(node.id)}" aria-label="${escapeHtml(ariaLabel)}" aria-expanded="false"${titleAttr}>
            <span class="hnode-pct">${fmtPct(node.costPercent)}</span>
            <span class="hnode-ring" title="${escapeHtml(OPERATOR_TYPE_LABEL[node.operatorType])}" data-ring-color="${colorVar}" data-ring-pct="${pct}">
                <span class="hnode-badge">${escapeHtml(badge)}</span>
                ${hasWarnings ? `<span class="hnode-warn" title="${escapeHtml(warnTitle)}" aria-hidden="true">⚠</span>` : ''}
            </span>
            <span class="hnode-name">${escapeHtml(node.operatorLabel)}</span>
            <span class="hnode-type">${escapeHtml(node.operatorType.replace('_', ' '))}</span>
            ${subLineHtml}
        </button>
        ${nodePopoverHtml(node, index)}
    </div>`;
}

/** The connector between one node and the next, labeled with the row count
 * actually flowing across it (the preceding node's real rowsOut) whenever
 * that value was reported. Always built left-to-right ('→', finding 21) —
 * this markup has no idea yet whether the browser will end up wrapping its
 * row and reversing it; layoutFlowRows() below corrects the glyph (never
 * the count text) once it knows. */
function hconnHtml(prevNode: PlanNode): string {
    const label = prevNode.rowsOut !== undefined
        ? `<span class="hconn-label">→ ${escapeHtml(fmtRows(prevNode.rowsOut))} row${prevNode.rowsOut === 1 ? '' : 's'}</span>`
        : '';
    return `<div class="hconn"><div class="hconn-line"></div>${label}</div>`;
}

/** Rail order, most actionable first (finding 16): a real spill or a
 * dominant network move is always worth looking at; row/duration skew is
 * only as worth looking at as how far it strayed from the average, so
 * those two tiers order by impact rather than plan position. */
const WARNING_PRIORITY: Record<PlanWarning['type'], number> = {
    SPILLED_TO_DISK: 0,
    LARGE_REDISTRIBUTION: 1,
    HIGH_DURATION_SKEW: 2,
    HIGH_SKEW: 3,
    ROW_ESTIMATE_MISMATCH: 4
};

/** (max - avg) / avg * max — the same ratio computeWarnings() itself used to
 * decide whether a skew warning fires at all, times the busiest node's raw
 * value, so a wildly skewed but tiny count doesn't outrank a merely
 * moderately skewed but enormous one. Both fields travel in `detail` already
 * (see planWarnings.ts); non-skew warning types have no notion of impact and
 * sort purely by WARNING_PRIORITY above. */
function warningImpact(warning: PlanWarning): number {
    const ratio = typeof warning.detail.ratio === 'number' ? warning.detail.ratio : 0;
    if (warning.type === 'HIGH_SKEW') {
        const max = typeof warning.detail.max === 'number' ? warning.detail.max : 0;
        return ratio * max;
    }
    if (warning.type === 'HIGH_DURATION_SKEW') {
        const max = typeof warning.detail.maxSeconds === 'number' ? warning.detail.maxSeconds : 0;
        return ratio * max;
    }
    return 0;
}

/** Severity-sorted, not document order — see WARNING_PRIORITY/warningImpact
 * above. Array.prototype.sort is spec-stable (ES2019+), so two warnings
 * tied on both keys keep their original plan order rather than shuffling. */
function sortedWarningItems(plan: Plan): Array<{ node: PlanNode; warning: PlanWarning }> {
    const items = plan.nodes.flatMap(node => node.warnings.map(warning => ({ node, warning })));
    return items.slice().sort((a, b) => {
        const priorityDiff = WARNING_PRIORITY[a.warning.type] - WARNING_PRIORITY[b.warning.type];
        return priorityDiff !== 0 ? priorityDiff : warningImpact(b.warning) - warningImpact(a.warning);
    });
}

/** Every warning across the whole plan, listed once up front so they read as
 * fast as the "hot" node does — a small ⚠ badge on a 46px ring, reachable
 * only by opening each node's popover in turn, wasn't a fast enough signal
 * for exactly the thing a plan viewer exists to surface. Each item is a
 * button that opens (and scrolls to) the popover for the node it came from. */
function warningsSummaryHtml(plan: Plan): string {
    const items = sortedWarningItems(plan);
    if (items.length === 0) {
        return '';
    }

    const itemsHtml = items.map(({ node, warning }) =>
        `<button type="button" class="plan-warning-item" data-jump-to="${escapeHtml(node.id)}">
            <span class="plan-warning-part">${escapeHtml(node.operatorLabel)} · part ${escapeHtml(node.id)}</span>
            <span class="plan-warning-msg">${escapeHtml(warning.message)}</span>
        </button>`
    ).join('');

    return `<div class="plan-side-card plan-side-warnings">
        <h4>⚠ Warnings (${items.length})</h4>
        ${itemsHtml}
    </div>`;
}

/** Persistent right rail: stays fixed while the flow above scrolls/wraps.
 * Plan-level summaries only — Warnings lead (most actionable), then
 * orientation stats, then the category breakdown, then — only when
 * relevant — the PROFILE hint. Per-node detail lives in each node's own
 * popover, not here, so there's exactly one place to look for it. */
/** Fixed reading order for the badge legend card below — not OperatorType's
 * own declaration order in planModel.ts (which groups SYSTEM before SYNC);
 * this instead groups the real data-flow operators first and the two
 * non-operator kinds (Sync, System) last, ending on the deliberate
 * catch-all Other. */
const LEGEND_ORDER: OperatorType[] = ['SCAN', 'JOIN', 'GROUP_BY', 'SORT', 'NETWORK', 'DML', 'SYNC', 'SYSTEM', 'OTHER'];

function sideRailHtml(plan: Plan): string {
    const clusterSize = planClusterSize(plan);
    const breakdown = planCategoryBreakdown(plan);
    const opCount = plan.nodes.length;

    // No new data: exactly the OPERATOR_BADGE/OPERATOR_TYPE_LABEL pairs
    // every node already renders on its ring (see hnodeHtml) and its
    // title-attribute hover legend (finding 5) — this just lists all nine
    // in one place instead of requiring a click (or a hover) per operator
    // type to learn what a badge glyph means.
    const legendHtml = LEGEND_ORDER.map(type =>
        `<div class="plan-legend-item"><span class="plan-legend-badge">${escapeHtml(OPERATOR_BADGE[type])}</span><span>${escapeHtml(OPERATOR_TYPE_LABEL[type])}</span></div>`
    ).join('');

    const categoryHtml = breakdown.length > 0
        ? `<div class="hcat-bar">${breakdown.map(b =>
            `<span data-width="${b.percent}" data-color-var="${b.colorVar}" title="${escapeHtml(b.label)} ${b.percent.toFixed(0)}%"></span>`
        ).join('')}</div>
        <div class="hcat-legend">${breakdown.map(b =>
            `<div><span><i data-color-var="${b.colorVar}"></i>${escapeHtml(b.label)}</span><span>${fmtMs(b.durationSum)}</span><span>${fmtPct(b.percent)}</span></div>`
        ).join('')}</div>`
        : `<div class="hcat-empty">not available</div>`;

    // Shown only when nothing in the plan has CPU/Net at all, which usually
    // means profiling was not active for the session when this statement ran.
    const profileHintHtml = planLacksDetailMetrics(plan)
        ? `<div class="plan-side-card plan-side-hint">
            <h4>Want more detail?</h4>
            <p>CPU, network, and disk metrics weren't captured for this run. Reconnect with
            execution plans enabled, then run the query again.</p>
        </div>`
        : '';

    return `<div class="plan-side">
        ${warningsSummaryHtml(plan)}
        <div class="plan-side-card">
            <h4>Profile overview</h4>
            <!-- Session/Statement first — together they're the composite
                 key copied verbatim into a EXA_*_PROFILE_LAST_DAY /
                 EXA_SQL_LAST_DAY cross-check (WHERE SESSION_ID = ... AND
                 STMT_ID = ...), and that pair's own order follows those
                 views' own column order (SESSION_ID precedes STMT_ID) —
                 Session also being the wider of the two keys. Facts about
                 the plan itself come next; Source, a provenance caveat
                 rather than something about the query, comes last. -->
            <div class="plan-side-row"><span>Session</span><span>${escapeHtml(plan.sessionId)}</span></div>
            <div class="plan-side-row" title="Serial number of the statement within its session"><span>Statement</span><span>${escapeHtml(plan.stmtId)}</span></div>
            <div class="plan-side-row"><span>Total time</span><span>${fmtMs(plan.totalDuration)}</span></div>
            <div class="plan-side-row"><span>Operators</span><span>${opCount} operator${opCount === 1 ? '' : 's'}</span></div>
            <div class="plan-side-row"><span>Nodes observed</span><span>${clusterSize !== undefined ? clusterSize : 'not available'}</span></div>
            <div class="plan-side-row"><span>Source</span><span>${escapeHtml(planSourceLabel(plan.source))}</span></div>
        </div>
        <div class="plan-side-card">
            <!-- This breakdown is always share-of-total (every node,
                 bookkeeping included) — unlike a non-system node's own ring,
                 whose share excludes system-step time (see costPercent in
                 planModel.ts). The suffix says so directly instead of
                 leaving the same operator reading as two silently
                 contradictory percentages. -->
            <h4>Time by category (of total)</h4>
            ${categoryHtml}
        </div>
        ${profileHintHtml}
        <div class="plan-side-card">
            <h4>Legend</h4>
            <div class="plan-legend">${legendHtml}</div>
        </div>
    </div>`;
}

export function buildPlanContentHtml(plan: Plan, nonce: string): string {
    const hotId = hottestNodeId(plan);

    // Each non-first node is grouped with its incoming connector in one
    // .hstep so they wrap onto the next row together — otherwise flex-wrap
    // can leave a connector arrow stranded at the end of a row pointing at
    // a node that wrapped to the row below it.
    const flowInner = plan.nodes.length > 0
        ? `<div class="hflow-track">${plan.nodes.map((node, i) =>
            i === 0
                ? hnodeHtml(node, node.id === hotId, i)
                : `<div class="hstep">${hconnHtml(plan.nodes[i - 1])}${hnodeHtml(node, node.id === hotId, i)}</div>`
        ).join('')}</div>`
        : '<p class="plan-empty">This statement produced no profiled operators.</p>';

    const textSummary = buildPlanTextSummary(plan);

    // No statement/total/operator-count summary here any more — it duplicated
    // the Profile overview rail (see sideRailHtml), which is now the single
    // source for all of it. This strip is just the toolbar row: the
    // Query-text toggle (when there's query text to toggle) on the left,
    // Copy-as-text on the right, sharing one row instead of two near-empty
    // ones. The .plan-sql pre itself stays outside this row, directly below
    // it, so toggling it doesn't disturb the toolbar's own height.
    return `
    <div class="plan-flow-caption">
        ${plan.queryText ? '<button type="button" class="plan-sql-toggle" data-sql-toggle aria-expanded="false">▸ Query text</button>' : ''}
        <button type="button" class="plan-copy-btn" data-copy-plan>⧉ Copy as text</button>
    </div>
    ${plan.queryText ? `<pre class="plan-sql" hidden>${escapeHtml(plan.queryText)}</pre>` : ''}
    <div class="plan-body">
        <div class="plan-flow-h">${flowInner}</div>
        ${sideRailHtml(plan)}
    </div>
    <textarea id="plan-text-data" hidden>${escapeHtml(textSummary)}</textarea>
    <script nonce="${nonce}">
    (function () {
        // The CSP here has no 'unsafe-hashes'/'unsafe-inline' on style-src, and a
        // nonce on style-src only permits nonce'd <style> ELEMENTS, never inline
        // style="" ATTRIBUTES on arbitrary markup — the browser silently drops
        // them. So every per-node/per-segment color and percentage below is
        // carried as data-* attributes and painted here via the CSSOM instead,
        // which this already-nonce'd script is allowed to do.
        document.querySelectorAll('.hnode-ring[data-ring-pct]').forEach(function (ring) {
            var pct = ring.getAttribute('data-ring-pct');
            var colorVar = ring.getAttribute('data-ring-color');
            ring.style.background = 'conic-gradient(var(' + colorVar + ') 0% ' + pct + '%, var(--vscode-panel-border) ' + pct + '% 100%)';
        });
        document.querySelectorAll('.hcat-bar span[data-width]').forEach(function (segment) {
            segment.style.width = segment.getAttribute('data-width') + '%';
            segment.style.backgroundColor = 'var(' + segment.getAttribute('data-color-var') + ')';
        });
        document.querySelectorAll('.hcat-legend i[data-color-var]').forEach(function (swatch) {
            swatch.style.backgroundColor = 'var(' + swatch.getAttribute('data-color-var') + ')';
        });

        var flowTrack = document.querySelector('.hflow-track');

        // Pure CSS can't do this: where a row actually breaks depends on the
        // panel's current width, which changes whenever the user resizes it,
        // so row membership has to be measured after layout, not assumed up
        // front. resetFlowRows() is idempotent so every relayout — the
        // initial one and every later resize — starts from the original flat
        // structure rather than restructuring an already-restructured one.
        function resetFlowRows() {
            if (!flowTrack) { return; }
            Array.prototype.slice.call(flowTrack.querySelectorAll('.hflow-row')).forEach(function (row) {
                Array.prototype.slice.call(row.children).forEach(function (child) { flowTrack.appendChild(child); });
                row.remove();
            });
            Array.prototype.slice.call(flowTrack.querySelectorAll('.hflow-drop')).forEach(function (drop) { drop.remove(); });
            Array.prototype.slice.call(flowTrack.querySelectorAll('.hconn.hconn-hidden')).forEach(function (conn) {
                conn.classList.remove('hconn-hidden');
            });
            // A previous relayout may have flipped some of these to '←' for
            // a reversed row (finding 21) — every real .hconn-label survives
            // a reset (only the .hflow-drop ones just removed above were
            // ever destroyed), so each one needs its arrow put back to the
            // build-time default before the next measurement pass decides
            // fresh which rows, if any, are reversed this time.
            Array.prototype.slice.call(flowTrack.querySelectorAll('.hconn-label')).forEach(function (label) {
                label.textContent = (label.textContent || '').replace(/^[→←]/, '→');
            });
            flowTrack.classList.remove('hflow-track-snaked');
        }

        // The x-center of an item's ring (its actual visual anchor), not the
        // item box as a whole — measured relative to the track, so it stays
        // valid across whatever position-shifting layoutFlowRows() below
        // applies to earlier rows.
        function ringCenterX(item, trackRect) {
            var ring = item.querySelector('.hnode-ring') || item;
            var rect = ring.getBoundingClientRect();
            return (rect.left + rect.right) / 2 - trackRect.left;
        }

        // Groups the flow's top-level items (the bare first node, then one
        // .hstep per remaining node) into rows by their measured offsetTop,
        // then — only when there's more than one row — wraps each row in its
        // own .hflow-row, reversing alternate ones (.hflow-row-reverse flips
        // both the row's own direction and, via a descendant selector, each
        // .hstep's internal [connector, node] order and arrow direction, so
        // the connector still lands on the correct side of its node once the
        // row reads right-to-left). The .hconn that used to sit between the
        // last node of one row and the first node of the next no longer
        // means anything (those nodes aren't adjacent on screen anymore) —
        // it's hidden (not removed, so a later relayout with a different
        // wrap point can bring it back) and replaced with a short vertical
        // .hflow-drop connector between the two rows, carrying over the same
        // rows-out label.
        //
        // Both the drop connector and the next row itself are then
        // positioned by MEASURING where the previous row's last ring
        // actually ended up, not by packing against the track's edge —
        // edge-packing only lines up with the previous row by coincidence,
        // since a row's real content width is whatever fit before it
        // wrapped, which is essentially never exactly the track's full
        // width.
        function layoutFlowRows() {
            if (!flowTrack) { return; }
            resetFlowRows();

            var items = Array.prototype.slice.call(flowTrack.children).filter(function (el) {
                return el.classList.contains('hnode-wrap') || el.classList.contains('hstep');
            });
            if (items.length === 0) { return; }

            var rows = [];
            var current = [];
            var currentTop = null;
            items.forEach(function (item) {
                var top = item.offsetTop;
                if (currentTop !== null && Math.abs(top - currentTop) > 2) {
                    rows.push(current);
                    current = [];
                }
                current.push(item);
                currentTop = top;
            });
            if (current.length > 0) { rows.push(current); }

            if (rows.length <= 1) { return; }

            flowTrack.classList.add('hflow-track-snaked');

            var prevLastItem = null;

            rows.forEach(function (rowItems, rowIndex) {
                var reversed = rowIndex % 2 === 1;
                var dropConn = null;

                if (rowIndex > 0) {
                    var firstItem = rowItems[0];
                    var oldConn = firstItem.querySelector('.hconn');
                    var labelText = '';
                    if (oldConn) {
                        var oldLabel = oldConn.querySelector('.hconn-label');
                        if (oldLabel) { labelText = oldLabel.textContent || ''; }
                        oldConn.classList.add('hconn-hidden');
                    }

                    var dropWrap = document.createElement('div');
                    dropWrap.className = 'hflow-drop';
                    dropConn = document.createElement('div');
                    dropConn.className = 'hflow-drop-connector';
                    var dropLine = document.createElement('div');
                    dropLine.className = 'hflow-drop-line';
                    dropConn.appendChild(dropLine);
                    if (labelText) {
                        var labelSpan = document.createElement('span');
                        labelSpan.className = 'hconn-label';
                        // The drop is already a vertical connector — '↓',
                        // not the carried-over '→' (finding 21), and never
                        // the count text itself, which is untouched either
                        // way. A literal space here, not \s — this whole
                        // script is itself the body of an outer TS template
                        // literal (see buildPlanContentHtml), which silently
                        // drops the backslash off unrecognized string
                        // escapes like \s before this regex source ever
                        // reaches the browser.
                        labelSpan.textContent = '↓ ' + labelText.replace(/^[→←] /, '');
                        dropConn.appendChild(labelSpan);
                    }
                    dropWrap.appendChild(dropConn);
                    flowTrack.appendChild(dropWrap);
                }

                var rowEl = document.createElement('div');
                rowEl.className = 'hflow-row' + (reversed ? ' hflow-row-reverse' : '');
                rowItems.forEach(function (item) { rowEl.appendChild(item); });
                if (reversed) {
                    // Visual order reversed, so the connector's arrow has to
                    // follow (finding 21) — only the glyph, never the count
                    // text (see the regex, which touches only a leading
                    // arrow character).
                    Array.prototype.slice.call(rowEl.querySelectorAll('.hconn-label')).forEach(function (label) {
                        label.textContent = (label.textContent || '').replace(/^→/, '←');
                    });
                }
                flowTrack.appendChild(rowEl);

                if (rowIndex > 0) {
                    var trackRect = flowTrack.getBoundingClientRect();
                    var targetX = ringCenterX(prevLastItem, trackRect);

                    var dropWidth = dropConn.offsetWidth || 0;
                    dropConn.style.marginLeft = (targetX - dropWidth / 2) + 'px';

                    var currentX = ringCenterX(rowItems[0], trackRect);
                    // Must not be a CSS transform: a transform creates a new
                    // stacking context on this row, which traps the open
                    // popover's z-index inside that row's own context —
                    // later sibling rows (also stacking contexts, painted
                    // later in DOM order) then draw over a popover that's
                    // supposed to be on top. position: relative + left
                    // shifts the row the same way without creating one.
                    rowEl.style.position = 'relative';
                    rowEl.style.left = (targetX - currentX) + 'px';
                }

                prevLastItem = rowItems[rowItems.length - 1];
            });
        }

        layoutFlowRows();
        window.addEventListener('resize', layoutFlowRows);

        var scrollArea = document.querySelector('.plan-flow-h');

        function resetPopover(pop) {
            pop.classList.remove('flip-up');
            pop.style.transform = '';
            pop.style.removeProperty('--arrow-shift');
            pop.style.maxHeight = '';
            pop.style.overflowY = '';
        }

        function closeAllPopovers() {
            document.querySelectorAll('[data-popover]').forEach(function (p) { p.hidden = true; resetPopover(p); });
            document.querySelectorAll('[data-node-toggle]').forEach(function (n) { n.setAttribute('aria-expanded', 'false'); });
        }

        // Vertical: opens below by default, flipping above (.flip-up) only
        // when below genuinely doesn't fit AND flipping is actually the
        // better move — either above fits outright, or above simply has
        // more room to work with than below (finding 18). The earlier
        // "flip whenever spaceAbove > spaceBelow" rule flipped (and clamped
        // with an internal scrollbar) even when the popover fit fully
        // above outright, on plans where the two sides happened to be
        // close — screenshots of a tall snaked plan showed bottom-row
        // popovers scrolling internally with ample space sitting unused
        // above them. Both spaceAbove/spaceBelow are already relative to
        // the visible, scrolled slice of the flow (scrollArea's own
        // getBoundingClientRect()), not the whole flow — a node near the
        // top of what's in view has just as little room above it as below,
        // so this still won't flip a popover off the top of the scroll
        // container the way blindly flipping on "below didn't fit" alone
        // used to. Whichever side is picked, its height is capped to what's
        // actually available there, with its own scrollbar, and that cap is
        // floored to a whole multiple of the popover's own line-height
        // (finding 15) so the clamp never lands mid-line — a real
        // screenshot showed the title row itself half-clipped right above
        // the scrollbar it triggered. Horizontal: same edge-aware clamp as
        // before, against the scroll viewport.
        function positionPopover(pop, node) {
            resetPopover(pop);
            if (!scrollArea) { return; }
            var margin = 10;
            var verticalGap = 16;
            var nodeRect = node.getBoundingClientRect();
            var areaRect = scrollArea.getBoundingClientRect();

            var popHeight = pop.offsetHeight || 160;
            var spaceBelow = areaRect.bottom - nodeRect.bottom;
            var spaceAbove = nodeRect.top - areaRect.top;
            var fitsBelow = popHeight + verticalGap <= spaceBelow;
            var fitsAbove = popHeight + verticalGap <= spaceAbove;
            var flip = !fitsBelow && (fitsAbove || spaceAbove > spaceBelow);

            if (flip) {
                pop.classList.add('flip-up');
            }

            var available = (flip ? spaceAbove : spaceBelow) - verticalGap;
            if (popHeight > available) {
                // 16px (VS Code's own default body line-height) is the
                // fallback for when a real computed line-height isn't
                // resolvable (e.g. this JSDOM test environment, which never
                // loads the actual stylesheet).
                var lineHeight = parseFloat(window.getComputedStyle(pop).lineHeight) || 16;
                var cappedAvailable = Math.max(available, 60);
                var flooredHeight = Math.floor(cappedAvailable / lineHeight) * lineHeight;
                pop.style.maxHeight = Math.max(flooredHeight, 60) + 'px';
                pop.style.overflowY = 'auto';
            }

            var popRect = pop.getBoundingClientRect();
            var shift = 0;
            if (popRect.left < areaRect.left + margin) {
                shift = (areaRect.left + margin) - popRect.left;
            } else if (popRect.right > areaRect.right - margin) {
                shift = (areaRect.right - margin) - popRect.right;
            }
            if (shift !== 0) {
                pop.style.transform = 'translateX(-50%) translateX(' + shift + 'px)';
                pop.style.setProperty('--arrow-shift', shift + 'px');
            }
        }

        function openPopoverFor(node) {
            var pop = node.parentElement.querySelector('[data-popover]');
            if (!pop) { return; }
            var wasOpen = !pop.hidden;
            closeAllPopovers();
            if (!wasOpen) {
                pop.hidden = false;
                node.setAttribute('aria-expanded', 'true');
                positionPopover(pop, node);
            }
        }

        // Real <button> elements already activate on Enter/Space in every
        // real browser (this webview runs in Chromium via VS Code, a fully
        // spec-compliant engine) — the keydown handler below is defensive
        // belt-and-suspenders, not a workaround for a real gap, and it
        // guarantees Space never also scrolls the panel the way it can on a
        // non-button focusable element.
        function isActivationKey(e) {
            return e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar';
        }

        // Arrow-key walk between node buttons (finding 9): DOM order is
        // logical flow order regardless of a snaked row's visual reversal
        // (see layoutFlowRows above), so this needs no awareness of which
        // row anything ended up on — the same index math works before and
        // after a relayout.
        function focusAdjacentNode(current, delta) {
            var all = Array.prototype.slice.call(document.querySelectorAll('[data-node-toggle]'));
            var idx = all.indexOf(current);
            var target = all[idx + delta];
            if (target && target.focus) { target.focus(); }
        }

        document.querySelectorAll('[data-node-toggle]').forEach(function (node) {
            node.addEventListener('click', function (e) {
                e.stopPropagation();
                openPopoverFor(node);
            });
            node.addEventListener('keydown', function (e) {
                if (isActivationKey(e)) {
                    e.preventDefault();
                    openPopoverFor(node);
                    return;
                }
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                    e.preventDefault();
                    focusAdjacentNode(node, e.key === 'ArrowRight' ? 1 : -1);
                }
            });
        });

        document.querySelectorAll('[data-popover]').forEach(function (pop) {
            // A click inside the open popover (e.g. to select its text) must
            // not bubble to the document-level "click anywhere closes it"
            // handler below.
            pop.addEventListener('click', function (e) { e.stopPropagation(); });
        });

        document.addEventListener('click', closeAllPopovers);
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { closeAllPopovers(); }
        });

        // Transient ring highlight on the node a warning jump lands on
        // (finding 8) — the jump itself scrolls to and opens the node's
        // popover, but once that's dismissed nothing marked which node it
        // was. Clears any previous highlight first so only ever one node
        // carries it, then times its own removal out so it reads as a
        // pointer, not a permanent state change.
        var highlightTimer;
        function jumpHighlight(target) {
            // Clears any pending removal first — jumping to the same node
            // twice within the timeout window must not let the first timer
            // remove the second jump's fresh highlight early.
            clearTimeout(highlightTimer);
            document.querySelectorAll('.hnode-jumped').forEach(function (n) { n.classList.remove('hnode-jumped'); });
            target.classList.add('hnode-jumped');
            highlightTimer = setTimeout(function () { target.classList.remove('hnode-jumped'); }, 1600);
        }

        document.querySelectorAll('.plan-warning-item').forEach(function (item) {
            function activate() {
                var id = item.getAttribute('data-jump-to');
                var target = document.querySelector('.hnode[data-node-id="' + id + '"]');
                if (!target) { return; }
                if (target.scrollIntoView) { target.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
                openPopoverFor(target);
                jumpHighlight(target);
                if (target.focus) { target.focus(); }
            }
            item.addEventListener('click', function (e) { e.stopPropagation(); activate(); });
            item.addEventListener('keydown', function (e) {
                if (!isActivationKey(e)) { return; }
                e.preventDefault();
                activate();
            });
        });

        var sqlToggle = document.querySelector('[data-sql-toggle]');
        if (sqlToggle) {
            sqlToggle.addEventListener('click', function () {
                // .plan-sql is no longer the toggle's own next sibling — the
                // toggle now shares .plan-flow-caption with the copy button
                // (the merged toolbar row) — but it's still the next sibling
                // of that whole row, one level up.
                var captionRow = sqlToggle.closest('.plan-flow-caption');
                var sql = captionRow && captionRow.nextElementSibling;
                if (!sql) { return; }
                sql.hidden = !sql.hidden;
                sqlToggle.textContent = (sql.hidden ? '▸' : '▾') + ' Query text';
                sqlToggle.setAttribute('aria-expanded', sql.hidden ? 'false' : 'true');
            });
        }
        var copyBtn = document.querySelector('[data-copy-plan]');
        if (copyBtn) {
            copyBtn.addEventListener('click', function () {
                var vscodeApi = window.__vscode || (window.acquireVsCodeApi && window.acquireVsCodeApi());
                if (vscodeApi) { window.__vscode = vscodeApi; }
                var data = document.getElementById('plan-text-data');
                if (!vscodeApi || !data) { return; }
                vscodeApi.postMessage({ command: 'copyPlanText', text: data.value });
            });
        }

        // Per-node copy (finding 11): each popover carries its own hidden
        // textarea (see nodePopoverHtml above) with exactly the text this
        // button should post — no per-click DOM building or escaping, just
        // reading a value that was already escaped once at render time.
        // stopPropagation keeps the click from reaching the document-level
        // "click anywhere closes the popover" handler, same as every other
        // interactive element already inside the popover.
        document.querySelectorAll('.plan-node-copy').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                var pop = btn.closest('[data-popover]');
                var data = pop ? pop.querySelector('.plan-node-copy-data') : null;
                var vscodeApi = window.__vscode || (window.acquireVsCodeApi && window.acquireVsCodeApi());
                if (vscodeApi) { window.__vscode = vscodeApi; }
                if (!vscodeApi || !data) { return; }
                vscodeApi.postMessage({ command: 'copyPlanText', text: data.value });
            });
        });
    })();
    </script>`;
}

export function buildPlanContentCss(): string {
    return `
        /* Query-text toggle (left, only when there's query text) and
           Copy-as-text (right) share this one row now — used to be two
           near-empty lines. space-between is enough to place both when the
           toggle renders; .plan-copy-btn's own margin-left: auto below is
           what keeps it pinned right even when the toggle doesn't (a lone
           flex child under space-between has nothing to "space between"
           and sits at the LEFT edge instead). */
        .plan-flow-caption {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 12px;
            padding: 10px 14px;
            border-bottom: 1px solid var(--vscode-panel-border);
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            font-family: var(--vscode-editor-font-family);
        }
        .plan-copy-btn {
            /* margin-left: auto, not just flex: none — this is what actually
               guarantees the button sits flush right in BOTH cases (query
               text present or not), since an auto margin claims all free
               space on its side regardless of sibling count, where
               justify-content: space-between alone only works once there
               are two children to space apart. */
            flex: none;
            margin-left: auto;
            font-size: 11px;
            padding: 3px 8px;
            border-radius: 4px;
            border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
            background-color: var(--vscode-button-secondaryBackground, transparent);
            color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
            cursor: pointer;
        }
        .plan-copy-btn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
        }
        .plan-copy-btn:focus-visible, .plan-sql-toggle:focus-visible {
            outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px;
        }
        .plan-sql-toggle {
            font-size: 11px;
            font-family: inherit;
            background: none;
            border: none;
            padding: 0;
            color: var(--vscode-textLink-foreground, var(--vscode-descriptionForeground));
            cursor: pointer;
            user-select: none;
        }
        .plan-sql-toggle:hover { text-decoration: underline; }
        .plan-sql {
            display: block;
            margin: 6px 14px 0;
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
            white-space: pre-wrap;
            word-break: break-word;
            color: var(--vscode-descriptionForeground);
            background-color: var(--vscode-textCodeBlock-background, var(--vscode-editorWidget-background));
            border-radius: 4px;
            padding: 8px 10px;
        }
        /* Explicit override, same reasoning as .plan-popover[hidden]
           below — author "display" rules beat the browser's default
           [hidden] handling, so it must be restated here too. */
        .plan-sql[hidden] {
            display: none;
        }

        .plan-body { display: flex; flex: 1; min-height: 0; overflow: hidden; }
        /* Bottom padding only needs to clear a popover on a bare one-row
           plan now (finding 10) — the flip-up condition (see positionPopover
           below) and its own internal scroll already guarantee a popover
           stays reachable regardless of where it opens, so this no longer
           has to reserve enough empty space to fit one below every node. */
        .plan-flow-h { flex: 1; min-width: 0; overflow: auto; padding: 30px 22px 56px; }
        .plan-empty { color: var(--vscode-descriptionForeground); padding: 4px; }
        /* Wraps onto additional rows instead of forcing a long horizontal
           scroll for plans with many operators — each connector travels
           with its destination node in one .hstep flex item (below) so a
           row never wraps with an arrow left pointing at nothing. */
        .hflow-track { display: flex; flex-wrap: wrap; align-items: flex-start; width: 100%; row-gap: 28px; }
        /* Once the script above finds the flow actually wrapped, it swaps
           this to a plain vertical stack of .hflow-row children — each one
           already the full width it needs, so flex-wrap above is no longer
           relevant. */
        .hflow-track-snaked { flex-direction: column; flex-wrap: nowrap; row-gap: 0; }
        .hstep { display: flex; align-items: flex-start; flex: none; }

        /* -- snake/boustrophedon row wrap: alternating rows read in the
           opposite direction and start directly below where the previous
           row ended, instead of restarting at the far left across a large
           gap (a real complaint on a wide, many-operator plan). Reversing
           just the row's own direction isn't enough — each .hstep's own
           [connector, node] child order also has to flip via the descendant
           selector below, or a node's incoming connector ends up rendered
           on the wrong side of it once the row reads right-to-left. -- */
        .hflow-row { display: flex; align-items: flex-start; width: 100%; }
        /* No justify-content here: row-reverse already swaps which edge is
           "main-start" to the right, so default flex-start packs this row's
           content flush against the right edge on its own. */
        .hflow-row-reverse { flex-direction: row-reverse; }
        .hflow-row-reverse .hstep { flex-direction: row-reverse; }
        .hflow-row-reverse .hconn-line::after {
            right: auto; left: -1px; border-left: none; border-right: 6px solid var(--vscode-panel-border);
        }
        /* The connector between the last node of one row and the first node
           of the next no longer means anything spatially (see hconn-hidden
           below) — this vertical stub replaces it. Both its horizontal
           position (margin-left) and the following row's own position
           (position: relative + left, on .hflow-row/.hflow-row-reverse
           above — NOT transform, which would create a stacking context
           and trap a popover's z-index inside this row) are computed in
           script from the actual measured position of the ring the
           previous row ended on, not packed against the track's edge. */
        .hflow-drop { display: flex; width: 100%; margin: 2px 0; }
        .hflow-drop-connector {
            width: 118px; flex: none; display: flex; flex-direction: column; align-items: center; padding: 2px 0 6px;
        }
        .hflow-drop-line { width: 2px; height: 18px; background-color: var(--vscode-panel-border); position: relative; }
        .hflow-drop-line::after {
            content: ''; position: absolute; left: 50%; bottom: -1px; transform: translateX(-50%);
            width: 0; height: 0; border-left: 4px solid transparent; border-right: 4px solid transparent;
            border-top: 6px solid var(--vscode-panel-border);
        }
        /* .hconn.hconn-hidden (two classes), not .hconn-hidden alone: .hconn's
           own display:flex rule below is also a single-class selector, so a
           same-specificity override here would be a tie the browser resolves
           by source order — fragile, and exactly the bug this already was
           until caught against a real screenshot. Two classes beats one
           regardless of where either rule sits in the sheet. */
        .hconn.hconn-hidden { display: none; }

        .hnode-wrap { display: flex; flex-direction: column; align-items: center; width: 118px; flex: none; position: relative; }
        .hnode {
            display: flex; flex-direction: column; align-items: center; width: 100%;
            cursor: pointer; background: none; border: none; padding: 0; margin: 0; font: inherit; color: inherit;
        }
        .hnode:focus-visible {
            outline: 2px solid var(--vscode-focusBorder); outline-offset: 3px; border-radius: 8px;
        }
        .hnode-system { opacity: 0.75; }
        .hnode:hover .hnode-ring { filter: brightness(1.15); }
        .hnode-pct {
            font-family: var(--vscode-editor-font-family); font-size: 11px; font-weight: 700;
            color: var(--vscode-descriptionForeground); margin-bottom: 5px;
        }
        .hnode-hot .hnode-pct { color: var(--vscode-charts-red); font-size: 13px; }
        .hnode-ring {
            width: 46px; height: 46px; border-radius: 50%; flex: none; position: relative;
            display: flex; align-items: center; justify-content: center;
        }
        .hnode-ring::before {
            content: ''; position: absolute; inset: 5px; border-radius: 50%;
            background-color: var(--vscode-editor-background);
        }
        /* Transient marker for the node a warning-rail jump landed on
           (finding 8) — class-based and removed by the script after ~1600ms
           (see planWebview.ts), not a CSS animation/keyframe: the script
           already owns the timing (it has to, to clear a *previous*
           highlight first), so a keyframe here would just be a second clock
           to keep in sync with the first. */
        .hnode-jumped .hnode-ring {
            outline: 2px solid var(--vscode-editorWarning-foreground, var(--vscode-charts-orange));
            outline-offset: 3px;
            border-radius: 50%;
            transition: outline-color 0.3s;
        }
        .hnode-badge {
            position: relative; z-index: 1; font-family: var(--vscode-editor-font-family);
            font-weight: 700; font-size: 12px; color: var(--vscode-foreground);
        }
        .hnode-hot .hnode-badge { color: var(--vscode-charts-red); }
        .hnode-warn {
            position: absolute; top: -2px; right: -2px; z-index: 2;
            background-color: var(--vscode-editorWarning-foreground, var(--vscode-charts-orange));
            color: var(--vscode-editor-background); font-size: 8px; line-height: 1; border-radius: 50%;
            width: 13px; height: 13px; display: flex; align-items: center; justify-content: center;
        }
        .hnode-name { display: block; font-size: 11px; font-weight: 600; margin-top: 7px; text-align: center; line-height: 1.3; }
        .hnode-type {
            display: block; font-size: 8.5px; color: var(--vscode-descriptionForeground); text-transform: uppercase;
            letter-spacing: 0.04em; margin-top: 1px;
        }
        .hnode-sub {
            display: block; font-size: 9px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family);
            text-align: center; margin-top: 2px; max-width: 112px; overflow: hidden;
            text-overflow: ellipsis; white-space: nowrap;
        }
        /* Temp-object caption, dimmed (finding 20) — see middleTruncateCaption's
           isTempObject check above; PART_INFO already says "on TEMPORARY
           table" for these, this just makes that legible without a click. */
        .hnode-sub-temp { opacity: 0.65; font-style: italic; }

        .hconn { display: flex; flex-direction: column; align-items: center; flex: none; width: 44px; margin-top: 27px; }
        .hconn-line { width: 100%; height: 2px; background-color: var(--vscode-panel-border); position: relative; }
        .hconn-line::after {
            content: ''; position: absolute; right: -1px; top: 50%; transform: translateY(-50%);
            width: 0; height: 0; border-top: 4px solid transparent; border-bottom: 4px solid transparent;
            border-left: 6px solid var(--vscode-panel-border);
        }
        .hconn-label {
            margin-top: 6px; background-color: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
            color: var(--vscode-foreground); font-family: var(--vscode-editor-font-family);
            font-weight: 700; font-size: 9.5px; padding: 2px 7px; border-radius: 9px; white-space: nowrap;
        }

        /* -- click-to-reveal popover: a sibling of the node button in
           .hnode-wrap, not nested inside it. Flips to open above the node
           (.flip-up) instead of below when there isn't enough room left in
           the visible flow area — the actual fix for a popover clipping
           against the row beneath it once the flow could wrap onto multiple
           rows (a prior version routed detail to a persistent side panel
           instead of fixing this directly; that traded away the "detail
           appears right where you clicked" immediacy this feature is
           actually for, so it's back to a fixed popover). -- */
        .plan-popover {
            position: absolute; left: 50%; transform: translateX(-50%);
            top: calc(100% + 12px);
            width: 280px; background-color: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
            border-radius: 6px; padding: 8px 10px; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
            z-index: 30; text-align: left; cursor: default;
            display: flex; flex-direction: column; gap: 3px;
        }
        .plan-popover.flip-up { top: auto; bottom: calc(100% + 12px); }
        .plan-popover::before {
            content: ''; position: absolute; top: -6px; left: calc(50% - var(--arrow-shift, 0px)); transform: translateX(-50%);
            width: 0; height: 0; border-left: 6px solid transparent; border-right: 6px solid transparent;
            border-bottom: 6px solid var(--vscode-widget-border, var(--vscode-panel-border));
        }
        .plan-popover.flip-up::before {
            top: auto; bottom: -6px; border-bottom: none;
            border-top: 6px solid var(--vscode-widget-border, var(--vscode-panel-border));
        }
        /* [hidden] is a plain (non-!important) UA-stylesheet rule, so the
           class rule above — an author style setting display: flex — silently
           overrides it without this explicit, higher-specificity override.
           Same class of bug caught (via live screenshot) in earlier versions
           of this file. */
        .plan-popover[hidden] {
            display: none;
        }
        .plan-popover-title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
        .plan-popover-title { font-size: 12px; font-weight: 600; word-break: break-word; }
        /* Per-node copy (finding 11) — same secondary-button look as the
           whole-plan .plan-copy-btn up in the caption row, scaled down to
           fit a 280px popover's title row. */
        .plan-node-copy {
            flex: none; font-size: 9.5px; font-family: inherit; padding: 2px 6px; border-radius: 4px;
            border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
            background-color: var(--vscode-button-secondaryBackground, transparent);
            color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
            cursor: pointer;
        }
        .plan-node-copy:hover {
            background-color: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
        }
        .plan-node-copy:focus-visible {
            outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px;
        }
        /* Label stacked above value, not side-by-side: a long label (e.g.
           "Per-node rows") next to a long value (e.g. a Traits list, or the
           "not available" fallback) left almost no room for the value
           column when squeezed side-by-side in a 280px popover, and
           word-break: break-word chopped it mid-word ("not avai / labl / e")
           to fit — confirmed via a real screenshot. Full-width, top-aligned
           text wraps at normal word boundaries instead. */
        .plan-detail-row { display: flex; flex-direction: column; gap: 1px; font-size: 11px; }
        .plan-detail-k {
            color: var(--vscode-descriptionForeground); font-size: 9.5px;
            text-transform: uppercase; letter-spacing: 0.04em;
        }
        .plan-detail-v { text-align: left; overflow-wrap: break-word; font-family: var(--vscode-editor-font-family); }

        /* -- persistent side rail: plan-level summaries only -- */
        .plan-side {
            width: 208px; flex: none; border-left: 1px solid var(--vscode-panel-border);
            padding: 14px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px;
        }
        .plan-side-card {
            background-color: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
            border-radius: 6px; padding: 10px 12px;
        }
        .plan-side-card h4 {
            margin: 0 0 8px; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.06em;
            color: var(--vscode-descriptionForeground); font-weight: 700;
        }
        /* flex-wrap: wrap is a no-op for every short value here (Source,
           Total time, Nodes observed) — space-between still lands them on
           one line same as before. It only matters for a full-length
           SESSION_ID (up to 20 digits), which drops to its own line rather
           than clipping against the rail's 208px width. */
        .plan-side-row { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; padding: 4px 0; font-size: 11.5px; }
        .plan-side-row + .plan-side-row { border-top: 1px solid var(--vscode-panel-border); }
        .plan-side-row span:first-child { color: var(--vscode-descriptionForeground); }
        .plan-side-row span:last-child {
            font-family: var(--vscode-editor-font-family); font-weight: 600; text-align: right;
            /* A 20-digit SESSION_ID has no word boundary to break at —
               overflow-wrap lets the browser break it as a last resort, once
               the wrap above has already dropped it to its own line, instead
               of it overflowing/clipping against the card edge. Same
               word-boundary-first choice already made for .plan-detail-v in
               the popover. min-width: 0 overrides the flex-item default of
               auto, which would otherwise refuse to shrink below the
               value's un-wrapped intrinsic width and defeat both of these. */
            min-width: 0; overflow-wrap: break-word;
        }
        .hcat-bar {
            display: flex; width: 100%; height: 7px; border-radius: 4px; overflow: hidden;
            margin: 2px 0 8px; background-color: var(--vscode-panel-border);
        }
        .hcat-bar span { display: block; height: 100%; }
        .hcat-legend { display: flex; flex-direction: column; gap: 4px; font-size: 10px; font-family: var(--vscode-editor-font-family); }
        /* Three spans per row now (label, absolute duration, percent) — a
           plain justify-content: space-between would spread the duration
           span across the middle of the row's free space instead of next to
           the percent it belongs with. The label grows to fill whatever
           room is left; duration/percent stay fixed-width and hug the right
           edge together, with a small gap between the two of them. */
        .hcat-legend div { display: flex; align-items: baseline; gap: 6px; }
        .hcat-legend div span:first-child { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .hcat-legend div span:not(:first-child) { flex: none; }
        .hcat-legend div span:nth-child(2) { color: var(--vscode-descriptionForeground); }
        .hcat-legend i { display: inline-block; width: 7px; height: 7px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
        .hcat-empty { color: var(--vscode-descriptionForeground); font-size: 11px; }
        .plan-side-hint {
            border-style: dashed;
            border-color: var(--vscode-widget-border, var(--vscode-panel-border));
        }
        .plan-side-hint p {
            margin: 0; font-size: 11px; line-height: 1.5; color: var(--vscode-descriptionForeground);
        }
        .plan-side-hint code {
            font-family: var(--vscode-editor-font-family);
            background-color: var(--vscode-textCodeBlock-background, var(--vscode-editorWidget-background));
            border-radius: 3px; padding: 1px 4px;
        }

        /* Badge legend: two columns read better than one long list in a
           208px rail (see LEGEND_ORDER above) — grid, not flex-wrap, so a
           short final row (9 items, an odd count) doesn't stretch its lone
           item across the full width. */
        .plan-legend { display: grid; grid-template-columns: 1fr 1fr; gap: 5px 10px; font-size: 10px; }
        .plan-legend-item { display: flex; align-items: center; gap: 5px; color: var(--vscode-descriptionForeground); }
        .plan-legend-badge {
            display: inline-flex; align-items: center; justify-content: center; flex: none;
            width: 14px; height: 14px; border-radius: 50%;
            font-family: var(--vscode-editor-font-family); font-weight: 700; font-size: 9px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
        }

        /* -- warnings summary: leads the rail, reads as fast as the hot node -- */
        .plan-side-warnings h4 { color: var(--vscode-editorWarning-foreground, var(--vscode-charts-orange)); }
        .plan-warning-item {
            display: block; width: 100%; text-align: left; background: none; border: none;
            padding: 6px 0; margin: 0; font: inherit; color: inherit; cursor: pointer;
        }
        .plan-warning-item + .plan-warning-item { border-top: 1px solid var(--vscode-panel-border); }
        .plan-warning-item:hover { background-color: var(--vscode-list-hoverBackground); }
        .plan-warning-item:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
        .plan-warning-part {
            display: block; font-size: 10px; font-weight: 600;
            color: var(--vscode-editorWarning-foreground, var(--vscode-charts-orange)); margin-bottom: 2px;
        }
        .plan-warning-msg { display: block; font-size: 10.5px; color: var(--vscode-descriptionForeground); line-height: 1.4; }
    `;
}

export interface PlanErrorViewOptions {
    message: string;
    canRetry?: boolean;
}

export function buildPlanErrorHtml(options: PlanErrorViewOptions): string {
    const retryHtml = options.canRetry
        ? '<button type="button" class="plan-retry-btn" data-plan-retry>Retry</button>'
        : '';
    return `<div class="plan-status-container">
        <div class="plan-status-title">⚠ Couldn't load the execution plan</div>
        <div class="plan-status-message">${escapeHtml(options.message)}</div>
        ${retryHtml}
    </div>`;
}

export function buildPlanLoadingHtml(): string {
    return `<div class="plan-status-container">
        <div class="plan-status-title">Fetching execution plan…</div>
    </div>`;
}

export function buildPlanStatusCss(): string {
    return `
        .plan-status-container { padding: 20px; }
        .plan-status-title { font-weight: 600; margin-bottom: 6px; }
        .plan-status-message {
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
            white-space: pre-wrap;
            color: var(--vscode-descriptionForeground);
        }
        .plan-retry-btn {
            margin-top: 12px;
            font-size: 12px;
            padding: 4px 10px;
            border-radius: 4px;
            border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
            background-color: var(--vscode-button-secondaryBackground, transparent);
            color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
            cursor: pointer;
        }
        .plan-retry-btn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
        }
        .plan-retry-btn:focus-visible {
            outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px;
        }
    `;
}
