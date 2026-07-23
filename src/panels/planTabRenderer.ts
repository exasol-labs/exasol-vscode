import { escapeHtml } from '../utils';

/**
 * Renders the "Results | Plan" tab strip shown above a single-statement
 * result. Deliberately uses distinct class names (`rv-tab*`, not `tab*`) so
 * clicks here are never picked up by resultsGrid.tsx's generic
 * `document.querySelectorAll('.tab')` handler, which is wired for the
 * unrelated multi-statement Result-N tab bar (tabBarRenderer.ts).
 */
export type PlanTabStatus = 'idle' | 'loading' | 'ready' | 'error';
export type ResultView = 'results' | 'plan';

export function buildResultPlanTabBarHtml(activeView: ResultView, planStatus: PlanTabStatus, nonce: string): string {
    const planLabel = planStatus === 'loading' ? 'Plan (loading…)' : 'Plan';
    const planErrorClass = planStatus === 'error' ? ' error' : '';

    return `<div class="rv-tab-bar" id="rv-tab-bar">
        <div class="rv-tab${activeView === 'results' ? ' active' : ''}" data-view="results"><span class="rv-tab-label">Results</span></div>
        <div class="rv-tab${activeView === 'plan' ? ' active' : ''}${planErrorClass}" data-view="plan"><span class="rv-tab-label">${escapeHtml(planLabel)}</span></div>
    </div>
    <script nonce="${nonce}">
    (function () {
        var vscodeApi = window.__vscode || (window.acquireVsCodeApi && window.acquireVsCodeApi());
        if (vscodeApi) { window.__vscode = vscodeApi; }
        var bar = document.getElementById('rv-tab-bar');
        if (!bar || !vscodeApi) { return; }
        bar.querySelectorAll('.rv-tab').forEach(function (tab) {
            tab.addEventListener('click', function () {
                vscodeApi.postMessage({ command: 'switchResultView', view: tab.getAttribute('data-view') });
            });
        });
    })();
    </script>`;
}

export function buildResultPlanTabBarCss(): string {
    return `
        .rv-tab-bar {
            display: flex;
            flex-shrink: 0;
            border-bottom: 1px solid var(--vscode-panel-border);
            background-color: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background));
        }
        .rv-tab {
            padding: 6px 14px;
            cursor: pointer;
            font-size: 12px;
            white-space: nowrap;
            border-bottom: 2px solid transparent;
            color: var(--vscode-tab-inactiveForeground, var(--vscode-foreground));
            background-color: var(--vscode-tab-inactiveBackground, transparent);
        }
        .rv-tab:hover {
            background-color: var(--vscode-tab-hoverBackground, var(--vscode-list-hoverBackground));
        }
        .rv-tab.active {
            color: var(--vscode-tab-activeForeground, var(--vscode-foreground));
            background-color: var(--vscode-tab-activeBackground, var(--vscode-editor-background));
            border-bottom-color: var(--vscode-focusBorder, var(--vscode-charts-blue));
        }
        .rv-tab.error {
            color: var(--vscode-errorForeground, #f44747);
        }
        .rv-tab.error::before {
            content: '';
            display: inline-block;
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background-color: var(--vscode-errorForeground, #f44747);
            margin-right: 6px;
            vertical-align: middle;
        }
    `;
}
