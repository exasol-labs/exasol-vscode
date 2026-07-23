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
import { Plan, PlanNode, PlanWarning } from './planModel';
import { escapeHtml } from '../utils';
import {
    fmtMs, fmtPct, fmtRows, fmtMiB, fmtCpuPct,
    planSourceLabel, planClusterSize, planCategoryBreakdown, hottestNodeId, planLacksDetailMetrics,
    OPERATOR_BADGE, OPERATOR_COLOR_VAR
} from './planFormat';
import { buildPlanTextSummary } from './planTextExport';

const WARNING_LABEL: Record<PlanWarning['type'], string> = {
    HIGH_SKEW: 'skew',
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

/** Full detail for one node, shown in its popover on click — identical
 * field set regardless of how it's displayed. */
function nodePopoverHtml(node: PlanNode): string {
    const titleText = node.objectName
        ? `${node.operatorLabel} — ${node.objectSchema ? `${node.objectSchema}.` : ''}${node.objectName}`
        : node.operatorLabel;

    const rows = [
        detailRow('Part id', node.id),
        detailRow('Operator', `${node.operatorLabel} (${node.operatorType})`),
        detailRow('Object', node.objectSchema ? `${node.objectSchema}.${node.objectName ?? ''}` : node.objectName),
        detailRow('Part info', node.partInfo),
        detailRow('Remarks', node.remarks),
        detailRow('Rows out', node.rowsOut !== undefined ? node.rowsOut.toLocaleString() : undefined),
        detailRow('Duration', fmtMs(node.duration)),
        detailRow('CPU', node.cpu !== undefined ? fmtCpuPct(node.cpu) : undefined),
        detailRow('Net', fmtMiB(node.net)),
        detailRow('Temp DB RAM peak', node.tempDbRamPeak !== undefined ? fmtMiB(node.tempDbRamPeak) : undefined),
        detailRow('HDD write', fmtMiB(node.hddWrite)),
        detailRow('Cost share', fmtPct(node.costPercent)),
        detailRow(
            'Per-node rows',
            node.perNodeStats
                ? `min ${node.perNodeStats.min} / max ${node.perNodeStats.max} / avg ${node.perNodeStats.avg.toFixed(0)} / nodes ${node.perNodeStats.nodeCount}`
                : 'not available'
        ),
        detailRow(
            'Traits',
            Object.entries(node.traits).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'
        )
    ].filter(Boolean).join('');

    const warningDetails = node.warnings.map(w =>
        `<div class="plan-detail-row"><span class="plan-detail-k">Warning</span><span class="plan-detail-v">${escapeHtml(w.message)}</span></div>`
    ).join('');

    return `<div class="plan-popover" data-popover hidden>
        <div class="plan-popover-title">${escapeHtml(titleText)}</div>
        ${rows}${warningDetails}
    </div>`;
}

/**
 * One node in the horizontal flow: a ring (fill share = costPercent, red
 * instead of the operator-type color when this is the plan's single
 * highest-cost node), badge letter, name/type, and a short sub-caption. A
 * real <button> (data-node-toggle/data-node-id, aria-expanded reflecting
 * whether its popover is open) so activating it — click, Enter, or Space —
 * opens that popover. The popover is a sibling in the same .hnode-wrap, not
 * nested inside the button.
 */
function hnodeHtml(node: PlanNode, isHot: boolean): string {
    const badge = OPERATOR_BADGE[node.operatorType] ?? '?';
    const colorVar = isHot ? '--vscode-charts-red' : (OPERATOR_COLOR_VAR[node.operatorType] ?? '--vscode-descriptionForeground');
    const pct = Math.max(0, Math.min(100, node.costPercent ?? 0));
    const hasWarnings = node.warnings.length > 0;
    const warnTitle = hasWarnings ? node.warnings.map(w => WARNING_LABEL[w.type] ?? w.type).join(', ') : '';

    const subLines = [
        node.duration !== undefined ? fmtMs(node.duration) : undefined,
        node.objectName ? `${node.objectSchema ? node.objectSchema + '.' : ''}${node.objectName}` : undefined
    ].filter((v): v is string => v !== undefined);

    const typeWords = node.operatorType.replace('_', ' ').toLowerCase();
    const warningSuffix = hasWarnings ? `, ${node.warnings.length} warning${node.warnings.length === 1 ? '' : 's'}` : '';
    const ariaLabel = `${node.operatorLabel}, ${typeWords}, ${fmtPct(node.costPercent)} of total time${warningSuffix}`;

    return `<div class="hnode-wrap">
        <button type="button" class="hnode${isHot ? ' hnode-hot' : ''}${node.traits.isSystemStep ? ' hnode-system' : ''}"
            data-node-toggle data-node-id="${escapeHtml(node.id)}" aria-label="${escapeHtml(ariaLabel)}" aria-expanded="false">
            <span class="hnode-pct">${fmtPct(node.costPercent)}</span>
            <span class="hnode-ring" data-ring-color="${colorVar}" data-ring-pct="${pct}">
                <span class="hnode-badge">${escapeHtml(badge)}</span>
                ${hasWarnings ? `<span class="hnode-warn" title="${escapeHtml(warnTitle)}" aria-hidden="true">⚠</span>` : ''}
            </span>
            <span class="hnode-name">${escapeHtml(node.operatorLabel)}</span>
            <span class="hnode-type">${escapeHtml(node.operatorType.replace('_', ' '))}</span>
            ${subLines.map(l => `<span class="hnode-sub">${escapeHtml(l)}</span>`).join('')}
        </button>
        ${nodePopoverHtml(node)}
    </div>`;
}

/** The connector between one node and the next, labeled with the row count
 * actually flowing across it (the preceding node's real rowsOut) whenever
 * that value was reported. */
function hconnHtml(prevNode: PlanNode): string {
    const label = prevNode.rowsOut !== undefined
        ? `<span class="hconn-label">${escapeHtml(fmtRows(prevNode.rowsOut))} rows</span>`
        : '';
    return `<div class="hconn"><div class="hconn-line"></div>${label}</div>`;
}

/** Every warning across the whole plan, listed once up front so they read as
 * fast as the "hot" node does — a small ⚠ badge on a 46px ring, reachable
 * only by opening each node's popover in turn, wasn't a fast enough signal
 * for exactly the thing a plan viewer exists to surface. Each item is a
 * button that opens (and scrolls to) the popover for the node it came from. */
function warningsSummaryHtml(plan: Plan): string {
    const items = plan.nodes.flatMap(node => node.warnings.map(warning => ({ node, warning })));
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
function sideRailHtml(plan: Plan): string {
    const clusterSize = planClusterSize(plan);
    const breakdown = planCategoryBreakdown(plan);

    const categoryHtml = breakdown.length > 0
        ? `<div class="hcat-bar">${breakdown.map(b =>
            `<span data-width="${b.percent}" data-color-var="${b.colorVar}" title="${escapeHtml(b.label)} ${b.percent.toFixed(0)}%"></span>`
        ).join('')}</div>
        <div class="hcat-legend">${breakdown.map(b =>
            `<div><span><i data-color-var="${b.colorVar}"></i>${escapeHtml(b.label)}</span><span>${fmtPct(b.percent)}</span></div>`
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
            <div class="plan-side-row"><span>Source</span><span>${escapeHtml(planSourceLabel(plan.source))}</span></div>
            <div class="plan-side-row"><span>Total time</span><span>${fmtMs(plan.totalDuration)}</span></div>
            <div class="plan-side-row"><span>Nodes observed</span><span>${clusterSize !== undefined ? clusterSize : 'not available'}</span></div>
        </div>
        <div class="plan-side-card">
            <h4>Time by category</h4>
            ${categoryHtml}
        </div>
        ${profileHintHtml}
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
                ? hnodeHtml(node, node.id === hotId)
                : `<div class="hstep">${hconnHtml(plan.nodes[i - 1])}${hnodeHtml(node, node.id === hotId)}</div>`
        ).join('')}</div>`
        : '<p class="plan-empty">This statement produced no profiled operators.</p>';

    const textSummary = buildPlanTextSummary(plan);
    const opCount = plan.nodes.length;

    return `
    <div class="plan-flow-caption">
        <span>Statement ${escapeHtml(plan.stmtId)} · ${fmtMs(plan.totalDuration)} total · ${opCount} operator${opCount === 1 ? '' : 's'}</span>
        <button type="button" class="plan-copy-btn" data-copy-plan>⧉ Copy as text</button>
    </div>
    ${plan.queryText ? `
    <button type="button" class="plan-sql-toggle" data-sql-toggle aria-expanded="false">▸ Query text</button>
    <pre class="plan-sql" hidden>${escapeHtml(plan.queryText)}</pre>` : ''}
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
                        labelSpan.textContent = labelText;
                        dropConn.appendChild(labelSpan);
                    }
                    dropWrap.appendChild(dropConn);
                    flowTrack.appendChild(dropWrap);
                }

                var rowEl = document.createElement('div');
                rowEl.className = 'hflow-row' + (reversed ? ' hflow-row-reverse' : '');
                rowItems.forEach(function (item) { rowEl.appendChild(item); });
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

        // Vertical: flips to open *above* the node instead of below when
        // there isn't enough room left in the visible flow area — but only
        // when there's actually MORE room above than below. Blindly flipping
        // whenever below didn't fit (the original logic) missed that
        // scrollArea's getBoundingClientRect() is relative to the currently
        // visible, scrolled viewport, not the whole flow: a node near the
        // top of what's currently in view has just as little room above it,
        // so flipping there ran the popover off the top of the scroll
        // container and got clipped to a barely-visible sliver — confirmed
        // against a real screenshot. Whichever side is picked, its height is
        // also capped to what's actually available there (with its own
        // scrollbar) so a popover that still doesn't fully fit is at least
        // fully reachable, never silently clipped away by the container's
        // own overflow. Horizontal: same edge-aware clamp as before, against
        // the scroll viewport.
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
            var flip = !fitsBelow && spaceAbove > spaceBelow;

            if (flip) {
                pop.classList.add('flip-up');
            }

            var available = (flip ? spaceAbove : spaceBelow) - verticalGap;
            if (popHeight > available) {
                pop.style.maxHeight = Math.max(available, 60) + 'px';
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

        document.querySelectorAll('[data-node-toggle]').forEach(function (node) {
            node.addEventListener('click', function (e) {
                e.stopPropagation();
                openPopoverFor(node);
            });
            node.addEventListener('keydown', function (e) {
                if (!isActivationKey(e)) { return; }
                e.preventDefault();
                openPopoverFor(node);
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

        document.querySelectorAll('.plan-warning-item').forEach(function (item) {
            function activate() {
                var id = item.getAttribute('data-jump-to');
                var target = document.querySelector('.hnode[data-node-id="' + id + '"]');
                if (!target) { return; }
                if (target.scrollIntoView) { target.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
                openPopoverFor(target);
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
                var sql = sqlToggle.nextElementSibling;
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
    })();
    </script>`;
}

export function buildPlanContentCss(): string {
    return `
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
            flex: none;
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
            display: inline-block;
            margin: 6px 0 0 14px;
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
        .plan-flow-h { flex: 1; min-width: 0; overflow: auto; padding: 30px 22px 200px; }
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
            width: 220px; background-color: var(--vscode-editorWidget-background);
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
        .plan-popover-title { font-size: 12px; font-weight: 600; margin-bottom: 4px; word-break: break-word; }
        /* Label stacked above value, not side-by-side: a long label (e.g.
           "Per-node rows") next to a long value (e.g. a Traits list, or the
           "not available" fallback) left almost no room for the value
           column when squeezed side-by-side in a 220px popover, and
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
        .plan-side-row { display: flex; justify-content: space-between; align-items: baseline; padding: 4px 0; font-size: 11.5px; }
        .plan-side-row + .plan-side-row { border-top: 1px solid var(--vscode-panel-border); }
        .plan-side-row span:first-child { color: var(--vscode-descriptionForeground); }
        .plan-side-row span:last-child { font-family: var(--vscode-editor-font-family); font-weight: 600; }
        .hcat-bar {
            display: flex; width: 100%; height: 7px; border-radius: 4px; overflow: hidden;
            margin: 2px 0 8px; background-color: var(--vscode-panel-border);
        }
        .hcat-bar span { display: block; height: 100%; }
        .hcat-legend { display: flex; flex-direction: column; gap: 4px; font-size: 10px; font-family: var(--vscode-editor-font-family); }
        .hcat-legend div { display: flex; justify-content: space-between; }
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
