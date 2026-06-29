import * as vscode from 'vscode';
import { QueryResult } from '../queryExecutor';
import { TabManager, TabResult } from './tabManager';
import { buildTabBarHtml, buildTabBarCss } from './tabBarRenderer';
import { escapeHtml, createWebviewRenderContext } from '../utils';

interface ResultViewOptions {
    title: string;
    showExport: boolean;
}

export class ResultsPanel implements vscode.WebviewViewProvider {
    private static instance: ResultsPanel | undefined;
    private static currentResult: QueryResult | undefined;
    private static currentQuery: string | undefined;
    private static currentError: string | undefined;
    private view: vscode.WebviewView | undefined;
    private tabManager: TabManager = new TabManager();

    private constructor(private readonly extensionUri: vscode.Uri) {}

    public static register(context: vscode.ExtensionContext): ResultsPanel {
        const provider = new ResultsPanel(context.extensionUri);
        ResultsPanel.instance = provider;

        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('exasol.results', provider, {
                webviewOptions: { retainContextWhenHidden: true }
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('exasol.results.export', async () => {
                await provider.exportToCSV();
            })
        );

        return provider;
    }

    public static show(result: QueryResult, query?: string) {
        if (!ResultsPanel.instance) {
            return;
        }
        ResultsPanel.currentResult = result;
        ResultsPanel.currentQuery = query;
        ResultsPanel.currentError = undefined;
        ResultsPanel.instance.tabManager.clearTabs();
        ResultsPanel.instance.updateWebview();
        ResultsPanel.instance.revealWithoutFocus();
    }

    public static showError(error: string) {
        if (!ResultsPanel.instance) {
            return;
        }
        ResultsPanel.currentError = error;
        ResultsPanel.currentResult = undefined;
        ResultsPanel.currentQuery = undefined;
        ResultsPanel.instance.tabManager.clearTabs();
        ResultsPanel.instance.updateWebview();
        ResultsPanel.instance.revealWithoutFocus();
    }

    public static showMultiple(tabs: TabResult[]) {
        if (!ResultsPanel.instance) {
            return;
        }
        ResultsPanel.currentResult = undefined;
        ResultsPanel.currentQuery = undefined;
        ResultsPanel.currentError = undefined;
        ResultsPanel.instance.tabManager.setTabs(tabs);
        ResultsPanel.instance.updateWebview();
        ResultsPanel.instance.revealWithoutFocus();
    }

    public static async exportCurrentToCSV() {
        await ResultsPanel.instance?.exportToCSV();
    }

    private revealWithoutFocus(): void {
        if (this.view) {
            this.view.show(true); // preserveFocus = true
        }
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void | Thenable<void> {
        this.view = webviewView;
        this.view.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
        };
        this.view.webview.onDidReceiveMessage(async message => {
            if (message.command === 'export') {
                await this.exportToCSV();
            } else if (message.command === 'switchTab') {
                if (message.currentState) {
                    this.tabManager.updateTabState(this.tabManager.getActiveIndex(), message.currentState);
                }
                this.tabManager.switchTab(message.index);
                this.updateWebview();
            } else if (message.command === 'closeTab') {
                this.tabManager.removeTab(message.index);
                if (this.tabManager.getTabs().length === 0) {
                    this.tabManager.clearTabs();
                }
                this.updateWebview();
            } else if (message.command === 'copy') {
                // Copy to clipboard
                await vscode.env.clipboard.writeText(message.text);
                vscode.window.showInformationMessage(`Copied ${message.text.split('\n').length} cell(s) to clipboard`);
            } else if (message.command === 'openExternal') {
                this.openExternalLink(message.url);
            }
        });

        this.updateWebview();
    }

    private openExternalLink(url: unknown): void {
        if (typeof url !== 'string') {
            return;
        }
        let parsed: vscode.Uri;
        try {
            parsed = vscode.Uri.parse(url, true);
        } catch {
            return;
        }
        if (parsed.scheme !== 'http' && parsed.scheme !== 'https') {
            return;
        }
        void vscode.env.openExternal(parsed);
    }

    private updateWebview() {
        if (!this.view) {
            return;
        }

        if (this.tabManager.getTabs().length > 0) {
            this.view.webview.html = this.getMultiTabHtml();
            return;
        }

        if (ResultsPanel.currentError) {
            this.view.webview.html = this.getErrorHtml(ResultsPanel.currentError);
            return;
        }

        if (!ResultsPanel.currentResult) {
            this.view.webview.html = this.getEmptyHtml();
            return;
        }

        this.view.webview.html = this.getResultHtml(ResultsPanel.currentResult, {
            title: 'Query Results',
            showExport: true
        }, ResultsPanel.currentQuery);
    }

    private buildQueryStats(result: QueryResult, query: string | undefined) {
        return {
            query: (query ?? '').trim(),
            executionTime: result.executionTime,
            rowCount: result.rowCount,
            columnCount: result.columns.length,
            timestamp: new Date().toISOString()
        };
    }

    private getTabBarHtml(): string {
        return buildTabBarHtml(this.tabManager.getTabs(), this.tabManager.getActiveIndex());
    }

    private getTabBarCss(nonce: string): string {
        return `<style nonce="${nonce}">${buildTabBarCss()}</style>`;
    }

    private getMultiTabHtml(): string {
        const activeTab = this.tabManager.getActiveTab();
        if (!activeTab) {
            return this.getEmptyHtml();
        }

        if (!this.tabManager.shouldShowTabBar()) {
            if (activeTab.error) {
                return this.getErrorHtml(activeTab.error);
            }
            if (activeTab.result) {
                return this.getResultHtml(activeTab.result, { title: 'Query Results', showExport: true }, activeTab.label);
            }
            return this.getEmptyHtml();
        }

        if (activeTab.error) {
            return this.getMultiTabErrorHtml(activeTab.error);
        }

        if (activeTab.result) {
            return this.getMultiTabResultHtml(activeTab.result, activeTab.label);
        }

        return this.getEmptyHtml();
    }

    private getMultiTabErrorHtml(error: string): string {
        const ctx = createWebviewRenderContext(this.view!.webview, this.extensionUri, vscode.Uri.joinPath);
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="${ctx.csp}">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Query Error</title>
                <style nonce="${ctx.nonce}">
                    html, body {
                        margin: 0;
                        padding: 0;
                        height: 100%;
                        overflow: hidden;
                        font-family: var(--vscode-font-family);
                        color: var(--vscode-foreground);
                        background-color: var(--vscode-editor-background);
                    }
                    body {
                        display: flex;
                        flex-direction: column;
                        box-sizing: border-box;
                    }
                    .error-content {
                        padding: 16px;
                        flex: 1;
                        overflow: auto;
                    }
                    .error-container {
                        background-color: var(--vscode-inputValidation-errorBackground);
                        border: 1px solid var(--vscode-inputValidation-errorBorder);
                        border-radius: 4px;
                        padding: 12px;
                    }
                    .error-title {
                        color: var(--vscode-errorForeground);
                        font-weight: 600;
                        margin-bottom: 8px;
                        display: flex;
                        align-items: center;
                        gap: 6px;
                    }
                    .error-message {
                        font-family: var(--vscode-editor-font-family);
                        font-size: 12px;
                        line-height: 1.5;
                        white-space: pre-wrap;
                        word-wrap: break-word;
                        color: var(--vscode-foreground);
                    }
                </style>
                ${this.getTabBarCss(ctx.nonce)}
            </head>
            <body>
                ${this.getTabBarHtml()}
                <div class="error-content">
                    <div class="error-container">
                        <div class="error-title">
                            <span>Query Execution Error</span>
                        </div>
                        <div class="error-message">${escapeHtml(error)}</div>
                    </div>
                </div>
                <script nonce="${ctx.nonce}" src="${ctx.mediaUri('results-grid-bundle.js')}"></script>
            </body>
            </html>
        `;
    }

    private getMultiTabResultHtml(result: QueryResult, query: string): string {
        if (!result.columns || result.columns.length === 0) {
            return this.getMultiTabErrorHtml('Query executed successfully (no result set)');
        }

        const ctx = createWebviewRenderContext(this.view!.webview, this.extensionUri, vscode.Uri.joinPath);
        const tabState = this.tabManager.getTabState(this.tabManager.getActiveIndex());
        const filterId = `filter-${Date.now()}`;

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="${ctx.csp}">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Query Results</title>
            <link rel="stylesheet" href="${ctx.mediaUri('results-grid-glide.css')}">
            <link rel="stylesheet" href="${ctx.mediaUri('results-grid.css')}">
            ${this.getTabBarCss(ctx.nonce)}
            <style nonce="${ctx.nonce}">
                .result-content {
                    display: flex;
                    flex-direction: column;
                    flex: 1;
                    min-height: 0;
                    padding: 10px;
                }
            </style>
        </head>
        <body>
            ${this.getTabBarHtml()}
            <div class="result-content">
                ${ResultsPanel.getGridHtmlStructure(result, filterId, '<button id="export">Export CSV</button>')}
            </div>
            ${ctx.dataIsland('result-data', { columns: result.columns, columnMetadata: result.columnMetadata || [], rows: result.rows })}
            ${ctx.dataIsland('render-state', { filterId, initialSortColumn: tabState.sortColumn || null, initialSortDirection: tabState.sortDirection || 'asc' })}
            ${ctx.dataIsland('saved-tab-state', tabState)}
            ${ctx.dataIsland('query-stats', this.buildQueryStats(result, query))}
            <script nonce="${ctx.nonce}" src="${ctx.mediaUri('results-grid-bundle.js')}"></script>
        </body>
        </html>`;
    }

    static getGridHtmlStructure(result: QueryResult, filterId: string, exportButton: string): string {
        return `
                <div class="header">
                    <input id="${filterId}" type="text" placeholder="Filter results..." />
                    <span id="count">${result.rowCount} rows</span>
                    ${exportButton}
                </div>
                <div id="grid-root" class="grid-root"></div>`;
    }

    private getErrorHtml(error: string): string {
        const ctx = createWebviewRenderContext(this.view!.webview, this.extensionUri, vscode.Uri.joinPath);
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="${ctx.csp}">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Query Error</title>
                <style nonce="${ctx.nonce}">
                    html, body {
                        margin: 0;
                        padding: 0;
                        height: 100%;
                        overflow: hidden;
                        font-family: var(--vscode-font-family);
                        color: var(--vscode-foreground);
                        background-color: var(--vscode-editor-background);
                    }
                    body {
                        padding: 16px;
                        box-sizing: border-box;
                    }
                    .error-container {
                        background-color: var(--vscode-inputValidation-errorBackground);
                        border: 1px solid var(--vscode-inputValidation-errorBorder);
                        border-radius: 4px;
                        padding: 12px;
                    }
                    .error-title {
                        color: var(--vscode-errorForeground);
                        font-weight: 600;
                        margin-bottom: 8px;
                        display: flex;
                        align-items: center;
                        gap: 6px;
                    }
                    .error-icon {
                        font-size: 18px;
                    }
                    .error-message {
                        font-family: var(--vscode-editor-font-family);
                        font-size: 12px;
                        line-height: 1.5;
                        white-space: pre-wrap;
                        word-wrap: break-word;
                        color: var(--vscode-foreground);
                    }
                </style>
            </head>
            <body>
                <div class="error-container">
                    <div class="error-title">
                        <span class="error-icon">&#x26A0;</span>
                        <span>Query Execution Error</span>
                    </div>
                    <div class="error-message">${escapeHtml(error)}</div>
                </div>
            </body>
            </html>
        `;
    }

    private async exportToCSV() {
        const activeTab = this.tabManager.getActiveTab();
        const result = activeTab?.result ?? ResultsPanel.currentResult;
        if (!result || !result.columns || result.columns.length === 0) {
            vscode.window.showWarningMessage('No results to export');
            return;
        }

        const uri = await vscode.window.showSaveDialog({
            filters: { 'CSV Files': ['csv'] }
        });

        if (!uri) {
            return;
        }

        let csv = result.columns.join(',') + '\n';
        for (const row of result.rows) {
            const values = result.columns.map(col => {
                let value = row[col];
                if (value === null || value === undefined) {
                    return '';
                }
                value = String(value);
                if (value.includes(',') || value.includes('"') || value.includes('\n')) {
                    value = '"' + value.replace(/"/g, '""') + '"';
                }
                return value;
            });
            csv += values.join(',') + '\n';
        }

        await vscode.workspace.fs.writeFile(uri, Buffer.from(csv, 'utf8'));
        vscode.window.showInformationMessage(`Results exported to ${uri.fsPath}`);
    }

    private getEmptyHtml(): string {
        const ctx = createWebviewRenderContext(this.view!.webview, this.extensionUri, vscode.Uri.joinPath);
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="${ctx.csp}">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Query Results</title>
                <style nonce="${ctx.nonce}">
                    html, body {
                        margin: 0;
                        padding: 0;
                        height: 100%;
                        overflow: hidden;
                        font-family: var(--vscode-font-family);
                        color: var(--vscode-foreground);
                        background-color: var(--vscode-editor-background);
                    }
                    body {
                        padding: 16px;
                        box-sizing: border-box;
                    }
                </style>
            </head>
            <body>
                <p>No results yet. Execute a query to see results here.</p>
            </body>
            </html>
        `;
    }

    private getResultHtml(result: QueryResult, options: ResultViewOptions, query: string | undefined): string {
        if (!result.columns || result.columns.length === 0) {
            return getSuccessHtml(result);
        }

        const ctx = createWebviewRenderContext(this.view!.webview, this.extensionUri, vscode.Uri.joinPath);
        const filterId = `filter-${Date.now()}`;
        const exportButton = options.showExport
            ? '<button id="export">Export CSV</button>'
            : '';

        return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="${ctx.csp}">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${escapeHtml(options.title)}</title>
        <link rel="stylesheet" href="${ctx.mediaUri('results-grid-glide.css')}">
        <link rel="stylesheet" href="${ctx.mediaUri('results-grid.css')}">
        <style nonce="${ctx.nonce}">body { padding: 10px; }</style>
    </head>
    <body>
        ${ResultsPanel.getGridHtmlStructure(result, filterId, exportButton)}
        ${ctx.dataIsland('result-data', { columns: result.columns, columnMetadata: result.columnMetadata || [], rows: result.rows })}
        ${ctx.dataIsland('render-state', { filterId, initialSortColumn: null, initialSortDirection: 'asc' })}
        ${ctx.dataIsland('query-stats', this.buildQueryStats(result, query))}
        <script nonce="${ctx.nonce}" src="${ctx.mediaUri('results-grid-bundle.js')}"></script>
    </body>
    </html>`;
    }
}

function getSuccessHtml(result: QueryResult): string {
    const executionTimeMs = result.executionTime;
    const executionTimeSec = (executionTimeMs / 1000).toFixed(2);

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Query Executed</title>
        <style>
            html, body {
                margin: 0;
                padding: 0;
                height: 100%;
                overflow: hidden;
                font-family: var(--vscode-font-family);
                color: var(--vscode-foreground);
                background-color: var(--vscode-editor-background);
            }
            body {
                padding: 16px;
                box-sizing: border-box;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .success-container {
                background-color: var(--vscode-inputValidation-infoBackground);
                border: 1px solid var(--vscode-inputValidation-infoBorder);
                border-radius: 4px;
                padding: 20px 24px;
                max-width: 500px;
            }
            .success-title {
                color: var(--vscode-charts-green);
                font-weight: 600;
                margin-bottom: 12px;
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 16px;
            }
            .success-icon {
                font-size: 24px;
            }
            .success-details {
                font-size: 13px;
                line-height: 1.6;
                color: var(--vscode-foreground);
            }
            .detail-row {
                display: flex;
                justify-content: space-between;
                padding: 4px 0;
            }
            .detail-label {
                color: var(--vscode-descriptionForeground);
            }
            .detail-value {
                font-weight: 500;
            }
        </style>
    </head>
    <body>
        <div class="success-container">
            <div class="success-title">
                <span class="success-icon">&#x2713;</span>
                <span>Query executed successfully</span>
            </div>
            <div class="success-details">
                <div class="detail-row">
                    <span class="detail-label">Rows affected:</span>
                    <span class="detail-value">${result.rowCount.toLocaleString()}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Execution time:</span>
                    <span class="detail-value">${executionTimeSec}s (${executionTimeMs.toLocaleString()}ms)</span>
                </div>
            </div>
        </div>
    </body>
    </html>
    `;
}
