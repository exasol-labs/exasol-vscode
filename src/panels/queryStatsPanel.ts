import * as vscode from 'vscode';
import { QueryResult } from '../queryExecutor';

export interface QueryStats {
    query: string;
    executionTime: number;
    rowCount: number;
    columnCount: number;
    timestamp: Date;
}

export class QueryStatsPanel implements vscode.WebviewViewProvider {
    private static instance: QueryStatsPanel | undefined;
    private view: vscode.WebviewView | undefined;
    private currentStats: QueryStats | undefined;

    private constructor(private readonly extensionUri: vscode.Uri) {}

    public static register(context: vscode.ExtensionContext): QueryStatsPanel {
        const provider = new QueryStatsPanel(context.extensionUri);
        QueryStatsPanel.instance = provider;
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('exasol.queryStats', provider, {
                webviewOptions: { retainContextWhenHidden: true }
            })
        );
        return provider;
    }

    public static updateStats(query: string, result: QueryResult) {
        if (!QueryStatsPanel.instance) {
            return;
        }
        const stats: QueryStats = {
            query: query.trim(),
            executionTime: result.executionTime,
            rowCount: result.rowCount,
            columnCount: result.columns.length,
            timestamp: new Date()
        };
        QueryStatsPanel.instance.update(stats);
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void | Thenable<void> {
        this.view = webviewView;
        this.view.webview.options = { enableScripts: true };

        // Listen for messages from other panels
        this.view.webview.onDidReceiveMessage(message => {
            if (message.command === 'updateCellInspector') {
                this.updateCellInspector(message.column, message.value, message.type);
            }
        });

        this.updateWebview();
    }

    private updateCellInspector(column: string, value: any, type: string) {
        if (!this.view) {
            return;
        }

        this.view.webview.postMessage({
            command: 'showCellInspector',
            column,
            value,
            type
        });
    }

    public static updateCellInspector(column: string, value: any, type: string) {
        if (!QueryStatsPanel.instance || !QueryStatsPanel.instance.view) {
            return;
        }

        QueryStatsPanel.instance.view.webview.postMessage({
            command: 'showCellInspector',
            column,
            value,
            type
        });
    }

    private update(stats: QueryStats) {
        this.currentStats = stats;
        this.updateWebview();
    }

    private updateWebview() {
        if (!this.view) {
            return;
        }
        if (!this.currentStats) {
            this.view.webview.html = this.getEmptyHtml();
            return;
        }
        this.view.webview.html = this.getStatsHtml(this.currentStats);
    }

    private getEmptyHtml(): string {
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body {
                        padding: 12px;
                        font-family: var(--vscode-font-family);
                        color: var(--vscode-descriptionForeground);
                        background-color: var(--vscode-sideBar-background);
                        font-size: 12px;
                    }
                    .empty {
                        text-align: center;
                        padding: 20px;
                        opacity: 0.6;
                    }
                </style>
            </head>
            <body>
                <div class="empty">Execute a query to see statistics</div>
            </body>
            </html>
        `;
    }

    private getStatsHtml(stats: QueryStats): string {
        const queryPreview = this.getQueryPreview(stats.query);
        const timeFormatted = this.formatTime(stats.executionTime);
        const timestampFormatted = this.formatTimestamp(stats.timestamp);
        const throughput = this.calculateThroughput(stats);
        const avgRowTime = this.calculateAvgRowTime(stats);

        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    * {
                        margin: 0;
                        padding: 0;
                        box-sizing: border-box;
                    }
                    body {
                        padding: 8px;
                        font-family: var(--vscode-font-family);
                        color: var(--vscode-foreground);
                        background-color: var(--vscode-sideBar-background);
                        font-size: 12px;
                        width: fit-content;
                        min-width: 200px;
                        max-width: 400px;
                    }
                    .section-header {
                        color: var(--vscode-descriptionForeground);
                        font-size: 10px;
                        font-weight: 600;
                        text-transform: uppercase;
                        margin-bottom: 8px;
                        letter-spacing: 0.5px;
                    }
                    .cell-inspector {
                        border: 1px solid var(--vscode-panel-border);
                        border-radius: 3px;
                        padding: 8px;
                        margin-bottom: 12px;
                        background-color: var(--vscode-editor-background);
                        display: none;
                    }
                    .cell-inspector.visible {
                        display: block;
                    }
                    .inspector-header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        margin-bottom: 6px;
                        gap: 6px;
                    }
                    .inspector-column {
                        color: var(--vscode-descriptionForeground);
                        font-size: 10px;
                        font-weight: 600;
                    }
                    .inspector-type {
                        color: var(--vscode-charts-blue);
                        font-size: 10px;
                        font-family: var(--vscode-editor-font-family);
                    }
                    .inspector-value {
                        font-family: var(--vscode-editor-font-family);
                        font-size: 11px;
                        word-wrap: break-word;
                        white-space: pre-wrap;
                        max-height: 100px;
                        overflow-y: auto;
                        padding: 6px;
                        background-color: var(--vscode-input-background);
                        border: 1px solid var(--vscode-input-border);
                        border-radius: 2px;
                    }
                    .inspector-null {
                        color: var(--vscode-disabledForeground);
                        font-style: italic;
                    }
                    .stat-group {
                        margin-bottom: 10px;
                        padding-bottom: 10px;
                        border-bottom: 1px solid var(--vscode-panel-border);
                    }
                    .stat-group:last-child {
                        border-bottom: none;
                        margin-bottom: 0;
                    }
                    .stat-item {
                        display: grid;
                        grid-template-columns: auto 1fr;
                        align-items: baseline;
                        margin-bottom: 5px;
                        gap: 12px;
                    }
                    .stat-label {
                        color: var(--vscode-descriptionForeground);
                        font-size: 11px;
                        white-space: nowrap;
                    }
                    .stat-value {
                        color: var(--vscode-foreground);
                        font-weight: 500;
                        text-align: right;
                        font-size: 12px;
                        white-space: nowrap;
                    }
                    .stat-value.highlight {
                        color: var(--vscode-charts-blue);
                        font-weight: 600;
                    }
                    .stat-value.success {
                        color: var(--vscode-terminal-ansiGreen);
                    }
                    .query-preview {
                        font-family: var(--vscode-editor-font-family);
                        font-size: 10px;
                        background-color: var(--vscode-editor-background);
                        border: 1px solid var(--vscode-panel-border);
                        border-radius: 3px;
                        padding: 6px 8px;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                        color: var(--vscode-editor-foreground);
                        margin-top: 4px;
                        max-width: 100%;
                    }
                    .timestamp {
                        color: var(--vscode-descriptionForeground);
                        font-size: 10px;
                        text-align: center;
                        margin-top: 8px;
                        opacity: 0.7;
                    }
                </style>
            </head>
            <body>
                <div class="cell-inspector" id="cellInspector">
                    <div class="section-header">Cell Value</div>
                    <div class="inspector-header">
                        <span class="inspector-column" id="inspectorColumn"></span>
                        <span class="inspector-type" id="inspectorType"></span>
                    </div>
                    <div class="inspector-value" id="inspectorValue"></div>
                </div>

                <div class="section-header">Query Statistics</div>
                <div class="stat-group">
                    <div class="stat-item">
                        <span class="stat-label">Time</span>
                        <span class="stat-value highlight">${timeFormatted}</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">Rows</span>
                        <span class="stat-value success">${stats.rowCount.toLocaleString()}</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">Cols</span>
                        <span class="stat-value">${stats.columnCount}</span>
                    </div>
                </div>

                <div class="stat-group">
                    <div class="stat-item">
                        <span class="stat-label">Throughput</span>
                        <span class="stat-value">${throughput}</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">Avg/Row</span>
                        <span class="stat-value">${avgRowTime}</span>
                    </div>
                </div>

                <div class="stat-group">
                    <div class="stat-label" style="margin-bottom: 4px;">Query</div>
                    <div class="query-preview" title="${this.escapeHtml(stats.query)}">${queryPreview}</div>
                </div>

                <div class="timestamp">${timestampFormatted}</div>

                <script>
                    const vscode = acquireVsCodeApi();
                    const cellInspector = document.getElementById('cellInspector');
                    const inspectorColumn = document.getElementById('inspectorColumn');
                    const inspectorType = document.getElementById('inspectorType');
                    const inspectorValue = document.getElementById('inspectorValue');

                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.command === 'showCellInspector') {
                            cellInspector.classList.add('visible');
                            inspectorColumn.textContent = message.column;
                            inspectorType.textContent = message.type;

                            if (message.value === null || message.value === undefined || message.value === '') {
                                inspectorValue.innerHTML = '<span class="inspector-null">(null)</span>';
                            } else {
                                inspectorValue.textContent = String(message.value);
                            }
                        }
                    });
                </script>
            </body>
            </html>
        `;
    }

    private getQueryPreview(query: string): string {
        const cleaned = query.replace(/\s+/g, ' ').trim();
        const maxLength = 50;
        if (cleaned.length <= maxLength) {
            return this.escapeHtml(cleaned);
        }
        return this.escapeHtml(cleaned.substring(0, maxLength)) + '...';
    }

    private formatTime(ms: number): string {
        if (ms < 1000) {
            return `${ms}ms`;
        }
        const seconds = ms / 1000;
        if (seconds < 60) {
            return `${seconds.toFixed(2)}s`;
        }
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = (seconds % 60).toFixed(0);
        return `${minutes}m ${remainingSeconds}s`;
    }

    private formatTimestamp(date: Date): string {
        return date.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });
    }

    private calculateThroughput(stats: QueryStats): string {
        if (stats.executionTime === 0 || stats.rowCount === 0) {
            return 'N/A';
        }
        const rowsPerSecond = (stats.rowCount / stats.executionTime) * 1000;
        if (rowsPerSecond < 1) {
            return '< 1 row/s';
        }
        if (rowsPerSecond >= 1000) {
            return `${(rowsPerSecond / 1000).toFixed(1)}K row/s`;
        }
        return `${Math.round(rowsPerSecond)} row/s`;
    }

    private calculateAvgRowTime(stats: QueryStats): string {
        if (stats.rowCount === 0) {
            return 'N/A';
        }
        const msPerRow = stats.executionTime / stats.rowCount;
        if (msPerRow < 0.01) {
            return '< 0.01ms';
        }
        if (msPerRow < 1) {
            return `${msPerRow.toFixed(2)}ms`;
        }
        return `${msPerRow.toFixed(1)}ms`;
    }

    private escapeHtml(text: string): string {
        const div = { textContent: text } as any;
        const element = { innerHTML: '', appendChild: (node: any) => { element.innerHTML = node.textContent; } };
        element.appendChild(div);
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}
