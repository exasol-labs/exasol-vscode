import * as vscode from 'vscode';
import { QueryResult } from '../queryExecutor';

interface ResultViewOptions {
    title: string;
    showExport: boolean;
}

export class ResultsPanel implements vscode.WebviewViewProvider {
    private static instance: ResultsPanel | undefined;
    private static currentResult: QueryResult | undefined;
    private static currentError: string | undefined;
    private view: vscode.WebviewView | undefined;

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

    public static show(result: QueryResult) {
        if (!ResultsPanel.instance) {
            return;
        }
        ResultsPanel.currentResult = result;
        ResultsPanel.currentError = undefined;
        ResultsPanel.instance.updateWebview();
        vscode.commands.executeCommand('exasol.results.focus');
    }

    public static showError(error: string) {
        if (!ResultsPanel.instance) {
            return;
        }
        ResultsPanel.currentError = error;
        ResultsPanel.currentResult = undefined;
        ResultsPanel.instance.updateWebview();
        vscode.commands.executeCommand('exasol.results.focus');
    }

    public static async exportCurrentToCSV() {
        await ResultsPanel.instance?.exportToCSV();
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void | Thenable<void> {
        this.view = webviewView;
        this.view.webview.options = { enableScripts: true }; 
        this.view.webview.onDidReceiveMessage(async message => {
            if (message.command === 'export') {
                await this.exportToCSV();
            }
        });

        this.updateWebview();
    }

    private updateWebview() {
        if (!this.view) {
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

        this.view.webview.html = getResultHtml(ResultsPanel.currentResult, {
            title: 'Query Results',
            showExport: true
        });
    }

    private getErrorHtml(error: string): string {
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Query Error</title>
                <style>
                    body {
                        padding: 16px;
                        font-family: var(--vscode-font-family);
                        color: var(--vscode-foreground);
                        background-color: var(--vscode-editor-background);
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
                        <span class="error-icon">⚠</span>
                        <span>Query Execution Error</span>
                    </div>
                    <div class="error-message">${this.escapeHtml(error)}</div>
                </div>
            </body>
            </html>
        `;
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    private async exportToCSV() {
        const result = ResultsPanel.currentResult;
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
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Query Results</title>
                <style>
                    body {
                        padding: 16px;
                        font-family: var(--vscode-font-family);
                        color: var(--vscode-foreground);
                        background-color: var(--vscode-editor-background);
                    }
                </style>
            </head>
            <body>
                <p>No results yet. Execute a query to see results here.</p>
            </body>
            </html>
        `;
    }
}

export function getResultHtml(result: QueryResult, options: ResultViewOptions): string {
    const filterId = `filter-${Date.now()}`;
    const dataJson = JSON.stringify({ columns: result.columns, rows: result.rows });
    const exportButton = options.showExport
        ? '<button id="export">Export CSV</button>'
        : '';

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${options.title}</title>
        <style>
            body {
                padding: 10px;
                font-family: var(--vscode-font-family);
                color: var(--vscode-foreground);
                background-color: var(--vscode-editor-background);
            }
            .header {
                display: flex;
                align-items: center;
                gap: 8px;
                margin-bottom: 10px;
                flex-wrap: wrap;
            }
            input[type="text"] {
                flex: 1;
                min-width: 180px;
                padding: 6px 10px;
                border: 1px solid var(--vscode-panel-border);
                background-color: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
            }
            button {
                padding: 6px 12px;
                border: none;
                cursor: pointer;
                background-color: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
            }
            button:hover {
                background-color: var(--vscode-button-hoverBackground);
            }
            .table-container {
                overflow: auto;
                max-height: calc(100vh - 160px);
                border: 1px solid var(--vscode-panel-border);
            }
            table {
                width: 100%;
                border-collapse: collapse;
                font-size: 13px;
            }
            th, td {
                padding: 6px 10px;
                border: 1px solid var(--vscode-panel-border);
                text-align: left;
            }
            th {
                background-color: var(--vscode-editor-background);
                position: sticky;
                top: 0;
                cursor: pointer;
                user-select: none;
            }
            th:hover {
                background-color: var(--vscode-list-hoverBackground);
            }
            th.sorted-asc::after {
                content: ' ▲';
                font-size: 10px;
                color: var(--vscode-charts-blue);
            }
            th.sorted-desc::after {
                content: ' ▼';
                font-size: 10px;
                color: var(--vscode-charts-blue);
            }
            tr:nth-child(even) {
                background-color: var(--vscode-sideBarSectionHeader-background);
            }
        </style>
    </head>
    <body>
        <div class="header">
            <input id="${filterId}" type="text" placeholder="Filter results..." />
            <span id="count">${result.rowCount} rows</span>
            ${exportButton}
        </div>
        <div class="table-container">
            <table id="results">
                <thead>
                    <tr>
                        ${result.columns.map(col => `<th>${col}</th>`).join('')}
                    </tr>
                </thead>
                <tbody></tbody>
            </table>
        </div>
        <script>
            const vscode = acquireVsCodeApi();
            const data = ${dataJson};
            const filterInput = document.getElementById('${filterId}');
            const tbody = document.querySelector('#results tbody');
            const countEl = document.getElementById('count');
            const thead = document.querySelector('#results thead tr');

            let currentRows = data.rows;
            let sortColumn = null;
            let sortDirection = 'asc';

            const render = (rows) => {
                tbody.innerHTML = '';
                rows.forEach(row => {
                    const tr = document.createElement('tr');
                    data.columns.forEach(col => {
                        const td = document.createElement('td');
                        td.textContent = row[col] ?? '';
                        tr.appendChild(td);
                    });
                    tbody.appendChild(tr);
                });
                countEl.textContent = ${result.rowCount} + ' rows (' + rows.length + ' visible)';
            };

            const sortRows = (column) => {
                const newDirection = sortColumn === column && sortDirection === 'asc' ? 'desc' : 'asc';
                sortColumn = column;
                sortDirection = newDirection;

                const sorted = [...currentRows].sort((a, b) => {
                    let aVal = a[column];
                    let bVal = b[column];

                    if (aVal === null || aVal === undefined) aVal = '';
                    if (bVal === null || bVal === undefined) bVal = '';

                    // Try numeric comparison
                    const aNum = Number(aVal);
                    const bNum = Number(bVal);
                    if (!isNaN(aNum) && !isNaN(bNum)) {
                        return sortDirection === 'asc' ? aNum - bNum : bNum - aNum;
                    }

                    // String comparison
                    const aStr = String(aVal).toLowerCase();
                    const bStr = String(bVal).toLowerCase();
                    if (sortDirection === 'asc') {
                        return aStr < bStr ? -1 : aStr > bStr ? 1 : 0;
                    } else {
                        return bStr < aStr ? -1 : bStr > aStr ? 1 : 0;
                    }
                });

                // Update column headers
                document.querySelectorAll('th').forEach(th => {
                    th.classList.remove('sorted-asc', 'sorted-desc');
                });
                const thIndex = data.columns.indexOf(column);
                const th = document.querySelectorAll('th')[thIndex];
                th.classList.add('sorted-' + sortDirection);

                currentRows = sorted;
                render(sorted);
            };

            // Add click handlers to headers
            data.columns.forEach((col, idx) => {
                const th = document.querySelectorAll('th')[idx];
                th.addEventListener('click', () => sortRows(col));
            });

            filterInput?.addEventListener('input', () => {
                const term = filterInput.value.toLowerCase();
                const filtered = data.rows.filter(row =>
                    data.columns.some(col => (row[col] ?? '').toString().toLowerCase().includes(term))
                );
                currentRows = filtered;
                render(filtered);
            });

            render(data.rows);

            const exportBtn = document.getElementById('export');
            exportBtn?.addEventListener('click', () => {
                vscode.postMessage({ command: 'export' });
            });
        </script>
    </body>
    </html>`;
}
