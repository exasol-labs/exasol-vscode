import * as vscode from 'vscode';
import { QueryResult } from '../queryExecutor';
import { QueryStatsPanel } from './queryStatsPanel';
import { getOutputChannel } from '../extension';

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
        this.view.webview.options = {
            enableScripts: true,
            localResourceRoots: []
        }; 
        this.view.webview.onDidReceiveMessage(async message => {
            if (message.command === 'export') {
                await this.exportToCSV();
            } else if (message.command === 'cellSelected') {
                // Forward cell selection to query stats panel
                QueryStatsPanel.updateCellInspector(message.column, message.value, message.type);
            } else if (message.command === 'copy') {
                // Copy to clipboard
                await vscode.env.clipboard.writeText(message.text);
                vscode.window.showInformationMessage(`Copied ${message.text.split('\n').length} cell(s) to clipboard`);
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
                <span class="success-icon">✓</span>
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

export function getResultHtml(result: QueryResult, options: ResultViewOptions): string {
    // Check if this is a DDL/DML statement (no columns returned)
    if (!result.columns || result.columns.length === 0) {
        return getSuccessHtml(result);
    }

    const filterId = `filter-${Date.now()}`;
    const dataJson = JSON.stringify({
        columns: result.columns,
        columnMetadata: result.columnMetadata || [],
        rows: result.rows
    });
    const exportButton = options.showExport
        ? '<button id="export">Export CSV</button>'
        : '';

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${options.title}</title>
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
                display: flex;
                flex-direction: column;
                padding: 10px;
                box-sizing: border-box;
            }
            .header {
                display: flex;
                align-items: center;
                gap: 8px;
                margin-bottom: 10px;
                flex-wrap: wrap;
                flex-shrink: 0;
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
                flex: 1;
                overflow: auto;
                border: 1px solid var(--vscode-panel-border);
                min-height: 0;
                outline: none;
            }
            table {
                border-collapse: collapse;
                font-size: 13px;
            }
            th, td {
                padding: 6px 10px;
                border: 1px solid var(--vscode-panel-border);
                text-align: left;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                position: relative;
                user-select: none;
                -webkit-user-select: none;
                max-width: 400px;
            }
            td.truncated {
                cursor: help;
                font-style: italic;
                opacity: 0.95;
            }
            td.truncated::after {
                content: '📋';
                position: absolute;
                right: 4px;
                top: 50%;
                transform: translateY(-50%);
                font-size: 10px;
                opacity: 0.5;
            }
            th {
                background-color: var(--vscode-editor-background);
                position: sticky;
                top: -1px;
                cursor: pointer;
                min-width: 80px;
                z-index: 10;
                box-shadow: 0 1px 0 0 var(--vscode-panel-border);
                border-top: 1px solid var(--vscode-editor-background);
            }
            th.row-number-header {
                min-width: 30px;
                width: 30px;
                max-width: 30px;
                text-align: left;
                padding-left: 6px;
                cursor: default;
                background-color: var(--vscode-sideBarSectionHeader-background);
                user-select: none;
                border-right: 1px solid var(--vscode-panel-border);
            }
            td {
                cursor: cell;
            }
            td.row-number {
                min-width: 30px;
                width: 30px;
                max-width: 30px;
                text-align: left;
                padding-left: 6px;
                background-color: var(--vscode-sideBarSectionHeader-background);
                color: var(--vscode-descriptionForeground);
                font-size: 11px;
                user-select: none;
                cursor: default;
                font-weight: 500;
                border-right: 1px solid var(--vscode-panel-border);
            }
            th:hover {
                background-color: var(--vscode-list-hoverBackground);
            }
            th .resizer {
                position: absolute;
                top: 0;
                right: 0;
                width: 5px;
                height: 100%;
                cursor: col-resize;
                user-select: none;
                z-index: 1;
            }
            th .resizer:hover {
                background-color: var(--vscode-focusBorder);
            }
            td.selected {
                background-color: var(--vscode-list-activeSelectionBackground);
                color: var(--vscode-list-activeSelectionForeground);
            }
            td.selecting {
                background-color: var(--vscode-list-inactiveSelectionBackground);
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
            .null-value {
                color: var(--vscode-disabledForeground);
                font-style: italic;
                font-size: 11px;
            }
            .context-menu {
                position: fixed;
                background-color: var(--vscode-menu-background);
                border: 1px solid var(--vscode-menu-border);
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
                z-index: 1000;
                padding: 4px 0;
                min-width: 200px;
                display: none;
            }
            .context-menu-item {
                padding: 6px 20px;
                cursor: pointer;
                color: var(--vscode-menu-foreground);
                font-size: 13px;
            }
            .context-menu-item:hover {
                background-color: var(--vscode-menu-selectionBackground);
                color: var(--vscode-menu-selectionForeground);
            }
            #scroll-sentinel {
                height: 1px;
                visibility: hidden;
            }
        </style>
    </head>
    <body>
        <div class="header">
            <input id="${filterId}" type="text" placeholder="Filter results..." />
            <span id="count">${result.rowCount} rows</span>
            ${exportButton}
        </div>
        <div class="table-container" tabindex="0" id="tableContainer">
            <table id="results">
                <thead>
                    <tr>
                        <th class="row-number-header">#</th>
                        ${result.columns.map(col => `<th><span>${col}</span><div class="resizer"></div></th>`).join('')}
                    </tr>
                </thead>
                <tbody></tbody>
            </table>
        </div>
        <div id="contextMenu" class="context-menu">
            <div class="context-menu-item" data-action="copy">Copy</div>
            <div class="context-menu-item" data-action="copyWithHeaders">Copy with Headers</div>
            <div class="context-menu-item" data-action="copyAsCsv">Copy as CSV</div>
            <div class="context-menu-item" data-action="copyAsCsvWithHeaders">Copy as CSV with Headers</div>
        </div>
        <script>
            const vscode = acquireVsCodeApi();
            const data = ${dataJson};

            // Get DOM elements
            const filterInput = document.getElementById('${filterId}');
            const tbody = document.querySelector('#results tbody');
            const countEl = document.getElementById('count');
            const thead = document.querySelector('#results thead tr');

            let currentRows = data.rows;
            let sortColumn = null;
            let sortDirection = 'asc';

            // Cell inspector functions - must be defined before render
            const getColumnType = (columnName) => {
                // Look up the column type from metadata
                const metadata = data.columnMetadata || [];
                const colMeta = metadata.find(col => col.name === columnName);

                if (!colMeta) {
                    return 'VARCHAR';
                }

                // Format the type with precision/scale/size if available
                let type = colMeta.type;
                if (colMeta.precision !== undefined && colMeta.scale !== undefined) {
                    type += '(' + colMeta.precision + ',' + colMeta.scale + ')';
                } else if (colMeta.size !== undefined) {
                    type += '(' + colMeta.size + ')';
                } else if (colMeta.precision !== undefined) {
                    type += '(' + colMeta.precision + ')';
                }

                return type;
            };

            const showCellInspector = (columnName, value) => {
                const columnType = getColumnType(columnName);

                // Send message to update Query Info panel
                vscode.postMessage({
                    command: 'cellSelected',
                    column: columnName,
                    value: value,
                    type: columnType
                });
            };

            // Cell selection state
            let isSelecting = false;
            let selectionStart = null;
            let selectionEnd = null;

            const clearSelection = () => {
                document.querySelectorAll('td.selecting, td.selected').forEach(el => {
                    el.classList.remove('selecting', 'selected');
                });
            };

            const highlightSelection = (startRow, startCol, endRow, endCol) => {
                const minRow = Math.min(startRow, endRow);
                const maxRow = Math.max(startRow, endRow);
                const minCol = Math.min(startCol, endCol);
                const maxCol = Math.max(startCol, endCol);

                const allTds = document.querySelectorAll('td');
                allTds.forEach(td => {
                    const row = parseInt(td.dataset.row);
                    const col = parseInt(td.dataset.col);

                    if (row >= minRow && row <= maxRow && col >= minCol && col <= maxCol) {
                        td.classList.add('selecting');
                    } else {
                        td.classList.remove('selecting');
                    }
                });
            };

            const getSelectedCellsData = () => {
                const selectedCells = Array.from(document.querySelectorAll('td.selecting, td.selected'));
                if (selectedCells.length === 0) return null;

                // Group cells by row and column
                const cellsByRow = new Map();
                const columns = new Set();

                selectedCells.forEach(td => {
                    // Skip row-number cells (they don't have dataset attributes)
                    if (td.classList.contains('row-number')) {
                        return;
                    }

                    const row = parseInt(td.dataset.row);
                    const col = parseInt(td.dataset.col);
                    const colName = td.dataset.colname;
                    const value = td.dataset.value || '';

                    if (!cellsByRow.has(row)) {
                        cellsByRow.set(row, new Map());
                    }
                    cellsByRow.get(row).set(col, { value, colName });
                    columns.add(col);
                });

                return { cellsByRow, columns: Array.from(columns).sort((a, b) => a - b) };
            };

            const copyValues = (format, includeHeaders) => {
                const selectionData = getSelectedCellsData();
                if (!selectionData) return;

                const { cellsByRow, columns } = selectionData;
                const rows = Array.from(cellsByRow.keys()).sort((a, b) => a - b);

                let text = '';
                const separator = format === 'csv' ? ',' : String.fromCharCode(9); // Tab character
                const lineSep = String.fromCharCode(10); // Newline character

                // Add headers if requested
                if (includeHeaders) {
                    const headers = columns.map(colIdx => {
                        // Find ANY row that has this column to get the column name
                        for (const row of cellsByRow.values()) {
                            const cell = row.get(colIdx);
                            if (cell && cell.colName) {
                                return cell.colName;
                            }
                        }
                        return '';
                    });

                    if (format === 'csv') {
                        text += headers.map(h => h.includes(',') || h.includes('"') || h.includes(String.fromCharCode(10)) ? '"' + h.replace(/"/g, '""') + '"' : h).join(',') + lineSep;
                    } else {
                        text += headers.join(separator) + lineSep;
                    }
                }

                // Add data rows
                rows.forEach(rowIdx => {
                    const rowData = cellsByRow.get(rowIdx);
                    const values = columns.map(colIdx => {
                        const cell = rowData.get(colIdx);
                        const value = cell ? cell.value : '';

                        if (format === 'csv' && (value.includes(',') || value.includes('"') || value.includes(String.fromCharCode(10)))) {
                            return '"' + value.replace(/"/g, '""') + '"';
                        }
                        return value;
                    });
                    text += values.join(separator) + lineSep;
                });

                // Send to extension to copy
                vscode.postMessage({
                    command: 'copy',
                    text: text.trim()
                });
            };

            // Truncate long values for display
            const truncateValue = (value, maxLength = 200) => {
                const str = String(value);
                if (str.length <= maxLength) {
                    return { display: str, isTruncated: false };
                }
                return { display: str.substring(0, maxLength) + '...', isTruncated: true };
            };

            // Progressive rendering for large datasets
            const CHUNK_SIZE = 1000;
            let renderedRowCount = 0;
            let isRendering = false;

            const renderRows = (rows, startIdx, endIdx) => {
                const fragment = document.createDocumentFragment();

                for (let rowIdx = startIdx; rowIdx < endIdx && rowIdx < rows.length; rowIdx++) {
                    const row = rows[rowIdx];
                    const tr = document.createElement('tr');

                    // Add row number cell
                    const rowNumTd = document.createElement('td');
                    rowNumTd.className = 'row-number';
                    rowNumTd.textContent = (rowIdx + 1).toString();
                    tr.appendChild(rowNumTd);

                    data.columns.forEach((col, colIdx) => {
                        const td = document.createElement('td');
                        const value = row[col];
                        if (value === null || value === undefined) {
                            td.innerHTML = '<span class="null-value">(null)</span>';
                        } else {
                            const fullValue = String(value);
                            const truncated = truncateValue(fullValue);
                            td.textContent = truncated.display;

                            // Add tooltip with full value if truncated
                            if (truncated.isTruncated) {
                                td.title = fullValue;
                                td.classList.add('truncated');
                            }
                        }
                        td.dataset.row = rowIdx;
                        td.dataset.col = colIdx;
                        td.dataset.colname = col;
                        td.dataset.value = value === null || value === undefined ? '' : String(value);

                        // Mouse down - start selection
                        td.addEventListener('mousedown', (e) => {
                            if (e.button !== 0) return; // Only left click

                            // Focus the table container to capture keyboard events
                            const tableContainer = document.getElementById('tableContainer');
                            if (tableContainer) {
                                tableContainer.focus();
                            }

                            isSelecting = true;
                            selectionStart = { row: rowIdx, col: colIdx };
                            selectionEnd = { row: rowIdx, col: colIdx };
                            clearSelection();
                            td.classList.add('selecting');
                            e.preventDefault();
                        });

                        // Mouse enter - extend selection
                        td.addEventListener('mouseenter', (e) => {
                            if (isSelecting) {
                                selectionEnd = { row: rowIdx, col: colIdx };
                                clearSelection();
                                highlightSelection(selectionStart.row, selectionStart.col, selectionEnd.row, selectionEnd.col);
                            }
                        });

                        // Click to inspect cell - always use full value from dataset
                        td.addEventListener('click', (e) => {
                            const fullValue = td.dataset.value;
                            showCellInspector(col, fullValue);
                        });

                        tr.appendChild(td);
                    });
                    fragment.appendChild(tr);
                }

                tbody.appendChild(fragment);
                renderedRowCount = endIdx;
                updateCountDisplay(rows.length);
            };

            const updateCountDisplay = (totalRows) => {
                if (renderedRowCount < totalRows) {
                    countEl.textContent = totalRows.toLocaleString() + ' rows (' + renderedRowCount.toLocaleString() + ' rendered, ' + (totalRows - renderedRowCount).toLocaleString() + ' pending...)';
                    countEl.style.color = 'var(--vscode-charts-orange)';
                } else {
                    countEl.textContent = totalRows.toLocaleString() + ' rows';
                    countEl.style.color = '';
                }
            };

            const renderNextChunk = (rows) => {
                if (isRendering || renderedRowCount >= rows.length) {
                    return;
                }

                isRendering = true;
                const endIdx = Math.min(renderedRowCount + CHUNK_SIZE, rows.length);

                // Use requestAnimationFrame for smooth rendering
                requestAnimationFrame(() => {
                    renderRows(rows, renderedRowCount, endIdx);
                    isRendering = false;

                    // If there are more rows, set up observer for next chunk
                    if (renderedRowCount < rows.length) {
                        setupScrollObserver(rows);
                    }
                });
            };

            let scrollObserver = null;

            const setupScrollObserver = (rows) => {
                // Remove existing observer
                if (scrollObserver) {
                    scrollObserver.disconnect();
                }

                // Create sentinel element at the bottom
                const sentinel = document.createElement('tr');
                sentinel.id = 'scroll-sentinel';
                sentinel.style.height = '1px';
                tbody.appendChild(sentinel);

                // Observe when sentinel comes into view
                scrollObserver = new IntersectionObserver((entries) => {
                    entries.forEach(entry => {
                        if (entry.isIntersecting && !isRendering) {
                            renderNextChunk(rows);
                        }
                    });
                }, {
                    root: document.querySelector('.table-container'),
                    rootMargin: '200px'  // Load when within 200px of bottom
                });

                scrollObserver.observe(sentinel);
            };

            const render = (rows) => {
                tbody.innerHTML = '';
                renderedRowCount = 0;
                isRendering = false;

                if (scrollObserver) {
                    scrollObserver.disconnect();
                    scrollObserver = null;
                }

                // Show info message if dataset is large
                if (rows.length > CHUNK_SIZE) {
                    console.log('Large dataset detected: ' + rows.length + ' rows. Rendering progressively in chunks of ' + CHUNK_SIZE + '.');
                }

                // Render first chunk immediately
                const initialChunk = Math.min(CHUNK_SIZE, rows.length);
                renderRows(rows, 0, initialChunk);

                // Set up lazy loading for remaining rows
                if (rows.length > initialChunk) {
                    setupScrollObserver(rows);
                }
            };

            // Mouse up - finish selection
            document.addEventListener('mouseup', (e) => {
                if (isSelecting) {
                    isSelecting = false;
                    // Convert selecting to selected
                    document.querySelectorAll('td.selecting').forEach(td => {
                        td.classList.remove('selecting');
                        td.classList.add('selected');
                    });
                }
            });

            // Keyboard shortcuts
            document.addEventListener('keydown', (e) => {
                const target = e.target;

                // Cmd+A / Ctrl+A - Select all cells in table
                if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
                    // Don't interfere with input field selection
                    if (target && target.tagName === 'INPUT') {
                        return;
                    }

                    e.preventDefault();
                    e.stopPropagation();

                    // Clear existing selection
                    clearSelection();

                    // Select all cells in the table (excluding row-number cells)
                    const allCells = document.querySelectorAll('#results tbody td:not(.row-number)');
                    allCells.forEach(td => td.classList.add('selected'));
                    return;
                }

                // Cmd+C / Ctrl+C - Copy selected cells
                if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
                    const selectedCells = document.querySelectorAll('td.selecting, td.selected');
                    if (selectedCells.length > 0) {
                        e.preventDefault();
                        e.stopPropagation();
                        copyValues('plain', false);
                        return;
                    }
                }
            });

            // Context menu
            const contextMenu = document.getElementById('contextMenu');

            tbody.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                const selectedCells = document.querySelectorAll('td.selecting, td.selected');
                if (selectedCells.length > 0) {
                    contextMenu.style.display = 'block';
                    contextMenu.style.left = e.pageX + 'px';
                    contextMenu.style.top = e.pageY + 'px';
                }
            });

            // Hide context menu on click elsewhere
            document.addEventListener('click', () => {
                contextMenu.style.display = 'none';
            });

            // Context menu item handlers
            document.querySelectorAll('.context-menu-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const action = item.dataset.action;

                    switch (action) {
                        case 'copy':
                            copyValues('plain', false);
                            break;
                        case 'copyWithHeaders':
                            copyValues('plain', true);
                            break;
                        case 'copyAsCsv':
                            copyValues('csv', false);
                            break;
                        case 'copyAsCsvWithHeaders':
                            copyValues('csv', true);
                            break;
                    }

                    contextMenu.style.display = 'none';
                });
            });

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
                const th = document.querySelectorAll('th')[thIndex + 1]; // +1 to skip row number header
                th.classList.add('sorted-' + sortDirection);

                currentRows = sorted;
                render(sorted);
            };


            // Column resizing
            let isResizing = false;
            let currentTh = null;
            let currentCol = -1;
            let startX = 0;
            let startWidth = 0;

            // Initialize column widths
            const table = document.querySelector('#results');
            const ths = document.querySelectorAll('th');
            ths.forEach((th, idx) => {
                // Skip row number header (index 0)
                if (idx === 0) return;
                // Set initial width based on content
                th.style.width = '150px';
                th.style.minWidth = '80px';
            });

            document.querySelectorAll('th .resizer').forEach((resizer, idx) => {
                resizer.addEventListener('mousedown', (e) => {
                    e.stopPropagation(); // Prevent sorting when resizing
                    isResizing = true;
                    currentTh = resizer.parentElement;
                    currentCol = idx;
                    startX = e.pageX;
                    startWidth = currentTh.offsetWidth;
                    document.body.style.cursor = 'col-resize';
                    e.preventDefault();
                });
            });

            document.addEventListener('mousemove', (e) => {
                if (!isResizing) return;
                const diff = e.pageX - startX;
                const newWidth = Math.max(80, startWidth + diff);
                currentTh.style.width = newWidth + 'px';

                // Also set width on all cells in this column to maintain alignment
                const rows = document.querySelectorAll('#results tbody tr');
                rows.forEach(row => {
                    const cell = row.children[currentCol + 1]; // +1 to skip row number cell
                    if (cell) {
                        cell.style.width = newWidth + 'px';
                    }
                });
            });

            document.addEventListener('mouseup', () => {
                if (isResizing) {
                    isResizing = false;
                    currentTh = null;
                    currentCol = -1;
                    document.body.style.cursor = '';
                }
            });

            // Add click handlers to headers (for sorting)
            data.columns.forEach((col, idx) => {
                const th = document.querySelectorAll('th')[idx + 1]; // +1 to skip row number header
                th.querySelector('span').addEventListener('click', (e) => {
                    e.stopPropagation();
                    sortRows(col);
                });
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
