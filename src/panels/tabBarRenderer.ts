import { TabResult } from './tabManager';

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

export function buildTabBarHtml(tabs: TabResult[], activeIndex: number): string {
    const tabElements = tabs.map((tab, i) => {
        const activeClass = i === activeIndex ? ' active' : '';
        const errorClass = tab.error ? ' error' : '';
        return `<div class="tab${activeClass}${errorClass}" data-index="${i}"><span class="tab-label">${escapeHtml(tab.label)}</span><span class="tab-close" data-index="${i}">&times;</span></div>`;
    }).join('');
    return `<div class="tab-bar">${tabElements}</div>`;
}

export function buildTabBarCss(): string {
    return `
            .tab-bar {
                display: flex;
                flex-shrink: 0;
                overflow-x: auto;
                border-bottom: 1px solid var(--vscode-panel-border);
                background-color: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background));
                margin-bottom: 0;
            }
            .tab {
                padding: 6px 14px;
                cursor: pointer;
                font-size: 12px;
                white-space: nowrap;
                border-bottom: 2px solid transparent;
                color: var(--vscode-tab-inactiveForeground, var(--vscode-foreground));
                background-color: var(--vscode-tab-inactiveBackground, transparent);
            }
            .tab {
                display: flex;
                align-items: center;
                gap: 6px;
            }
            .tab:hover {
                background-color: var(--vscode-tab-hoverBackground, var(--vscode-list-hoverBackground));
            }
            .tab-close {
                font-size: 14px;
                line-height: 1;
                opacity: 0;
                transition: opacity 0.1s;
            }
            .tab:hover .tab-close {
                opacity: 0.6;
            }
            .tab-close:hover {
                opacity: 1 !important;
            }
            .tab.active {
                color: var(--vscode-tab-activeForeground, var(--vscode-foreground));
                background-color: var(--vscode-tab-activeBackground, var(--vscode-editor-background));
                border-bottom-color: var(--vscode-focusBorder, var(--vscode-charts-blue));
            }
            .tab.error {
                color: var(--vscode-errorForeground, #f44747);
            }
            .tab.error::before {
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
