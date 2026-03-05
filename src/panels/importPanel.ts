import * as vscode from 'vscode';
import { ConnectionManager } from '../connectionManager';
import { SessionManager } from '../sessionManager';
import { parseCsvPreview } from '../csvUtils';
import { CsvFormatOptions } from '@exasol/exasol-driver-ts';

export class ImportPanel {
    public static currentPanel: ImportPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        private connectionManager: ConnectionManager,
        private sessionManager: SessionManager,
        private outputChannel: vscode.OutputChannel,
        private objectTreeRefresh: () => void
    ) {
        this._panel = panel;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._update();

        // Handle messages from webview
        this._panel.webview.onDidReceiveMessage(
            async message => {
                await this.handleMessage(message);
            },
            null,
            this._disposables
        );
    }

    public static show(
        connectionManager: ConnectionManager,
        sessionManager: SessionManager,
        outputChannel: vscode.OutputChannel,
        objectTreeRefresh: () => void
    ): void {
        const column = vscode.ViewColumn.One;

        // If we already have a panel, dispose it
        if (ImportPanel.currentPanel) {
            ImportPanel.currentPanel.dispose();
        }

        // Create new panel
        const panel = vscode.window.createWebviewPanel(
            'exasolImportCsv',
            'Import CSV File',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        ImportPanel.currentPanel = new ImportPanel(
            panel,
            connectionManager,
            sessionManager,
            outputChannel,
            objectTreeRefresh
        );
    }

    private async handleMessage(message: any): Promise<void> {
        const activeConnection = this.connectionManager.getActiveConnection();
        if (!activeConnection && message.command !== 'cancel') {
            vscode.window.showErrorMessage('No active connection');
            return;
        }

        switch (message.command) {
            case 'requestSchemas': {
                try {
                    const schemas = await this.connectionManager.fetchSchemaNames(activeConnection!.id);
                    const currentSchema = this.sessionManager.getCurrentSchema();
                    this._panel.webview.postMessage({
                        command: 'schemas',
                        schemas,
                        activeSchema: currentSchema
                    });
                } catch (error) {
                    const msg = this.formatError(error);
                    this._panel.webview.postMessage({
                        command: 'importError',
                        message: `Failed to load schemas: ${msg}`
                    });
                }
                return;
            }

            case 'checkTableExists': {
                try {
                    const exists = await this.connectionManager.tableExists(
                        activeConnection!.id,
                        message.schema,
                        message.tableName
                    );
                    this._panel.webview.postMessage({
                        command: 'tableExistsResult',
                        exists
                    });
                } catch (error) {
                    const msg = this.formatError(error);
                    this._panel.webview.postMessage({
                        command: 'importError',
                        message: `Failed to check table existence: ${msg}`
                    });
                }
                return;
            }

            case 'selectFile': {
                const uris = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: false,
                    filters: {
                        'CSV Files': ['csv', 'tsv', 'txt']
                    },
                    title: 'Select CSV File to Import'
                });

                if (uris && uris.length > 0) {
                    const filePath = uris[0].fsPath;
                    try {
                        const separator = message.separator || ',';
                        const result = await parseCsvPreview(filePath, separator);
                        this._panel.webview.postMessage({
                            command: 'fileSelected',
                            filePath,
                            columnNames: result.columns,
                            previewRows: result.rows
                        });
                    } catch (error) {
                        const msg = this.formatError(error);
                        this._panel.webview.postMessage({
                            command: 'importError',
                            message: `Failed to parse CSV header: ${msg}`
                        });
                    }
                }
                return;
            }

            case 'reparseHeader': {
                if (message.filePath) {
                    try {
                        const result = await parseCsvPreview(message.filePath, message.separator || ',');
                        this._panel.webview.postMessage({
                            command: 'fileSelected',
                            filePath: message.filePath,
                            columnNames: result.columns,
                            previewRows: result.rows
                        });
                    } catch (error) {
                        const msg = this.formatError(error);
                        this._panel.webview.postMessage({
                            command: 'importError',
                            message: `Failed to re-parse CSV header: ${msg}`
                        });
                    }
                }
                return;
            }

            case 'import': {
                const { schema, tableName, filePath, columnNames, csvOptions } = message;
                const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || filePath;

                this.outputChannel.appendLine(
                    `Importing ${fileName} into "${schema}"."${tableName}"...`
                );

                try {
                    const rowCount = await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Notification,
                            title: `Importing ${fileName} into ${schema}.${tableName}...`,
                            cancellable: false
                        },
                        async () => {
                            const opts: CsvFormatOptions = {};
                            if (csvOptions) {
                                if (csvOptions.columnSeparator) {
                                    opts.columnSeparator = csvOptions.columnSeparator;
                                }
                                if (csvOptions.columnDelimiter) {
                                    opts.columnDelimiter = csvOptions.columnDelimiter;
                                }
                                if (csvOptions.rowSeparator) {
                                    opts.rowSeparator = csvOptions.rowSeparator;
                                }
                                if (csvOptions.encoding) {
                                    opts.encoding = csvOptions.encoding;
                                }
                                if (csvOptions.skip !== undefined && csvOptions.skip !== null && csvOptions.skip !== '') {
                                    opts.skip = Number(csvOptions.skip);
                                }
                                if (csvOptions.trim) {
                                    opts.trim = csvOptions.trim;
                                }
                                if (csvOptions.nullValue !== undefined && csvOptions.nullValue !== '') {
                                    opts.null = csvOptions.nullValue;
                                }
                            }

                            return await this.connectionManager.importCsvFile(
                                activeConnection!.id,
                                schema,
                                tableName,
                                filePath,
                                columnNames,
                                Object.keys(opts).length > 0 ? opts : undefined
                            );
                        }
                    );

                    this.outputChannel.appendLine(
                        `Created table "${schema}"."${tableName}" and imported ${rowCount} rows`
                    );

                    vscode.window.showInformationMessage(
                        `Created table ${schema}.${tableName} and imported ${rowCount} rows`
                    );

                    this.objectTreeRefresh();

                    this._panel.webview.postMessage({
                        command: 'importComplete',
                        rowCount,
                        tableName
                    });

                    // Close the panel after successful import
                    this.dispose();

                } catch (error) {
                    const errorMsg = this.formatError(error);
                    this.outputChannel.appendLine(`Import failed: ${errorMsg}`);
                    this._panel.webview.postMessage({
                        command: 'importError',
                        message: errorMsg
                    });
                }
                return;
            }

            case 'cancel': {
                this.dispose();
                return;
            }
        }
    }

    private formatError(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    private _update(): void {
        this._panel.webview.html = this._getHtmlForWebview();
    }

    private _getHtmlForWebview(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Import CSV File</title>
    <style>
        body {
            padding: 20px;
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
        }
        .form-container {
            max-width: 500px;
            margin: 0 auto;
        }
        h1 {
            font-size: 24px;
            margin-bottom: 30px;
            color: var(--vscode-foreground);
        }
        .form-group {
            margin-bottom: 20px;
        }
        label {
            display: block;
            margin-bottom: 8px;
            font-weight: 600;
            color: var(--vscode-foreground);
        }
        input {
            width: 100%;
            padding: 10px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
            font-size: 14px;
            box-sizing: border-box;
        }
        input:focus, select:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        input::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }
        select {
            width: 100%;
            padding: 10px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
            font-size: 14px;
            box-sizing: border-box;
        }
        .hint {
            margin-top: 5px;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        .button-group {
            margin-top: 30px;
            display: flex;
            gap: 10px;
        }
        button {
            flex: 1;
            padding: 10px 20px;
            border: none;
            border-radius: 2px;
            font-size: 14px;
            cursor: pointer;
            font-weight: 600;
        }
        .primary-button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .primary-button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .primary-button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .secondary-button {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .secondary-button:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .error-message {
            color: var(--vscode-errorForeground);
            background-color: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            padding: 10px;
            margin-bottom: 20px;
            border-radius: 2px;
            display: none;
        }
        .inline-error {
            color: var(--vscode-errorForeground);
            font-size: 12px;
            margin-top: 5px;
            display: none;
        }
        .icon {
            margin-right: 8px;
        }
        .file-picker {
            display: flex;
            gap: 10px;
            align-items: center;
        }
        .file-picker input {
            flex: 1;
        }
        .file-picker button {
            flex: 0 0 auto;
            padding: 10px 16px;
        }
        .column-preview {
            display: none;
            margin-top: 10px;
            padding: 10px;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
        }
        .preview-table-container {
            overflow-x: auto;
            margin-top: 8px;
            max-height: 350px;
            overflow-y: auto;
        }
        .preview-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
            font-family: var(--vscode-editor-font-family, monospace);
        }
        .preview-table th, .preview-table td {
            padding: 4px 8px;
            border: 1px solid var(--vscode-input-border);
            text-align: left;
            max-width: 200px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .preview-table th {
            background-color: var(--vscode-editor-selectionBackground);
            font-weight: 600;
            position: sticky;
            top: 0;
        }
        .preview-table tr:nth-child(even) {
            background-color: var(--vscode-list-hoverBackground);
        }
        details {
            margin-top: 20px;
            margin-bottom: 20px;
        }
        summary {
            cursor: pointer;
            font-weight: 600;
            color: var(--vscode-foreground);
            padding: 8px 0;
        }
        summary:hover {
            color: var(--vscode-textLink-foreground);
        }
        .advanced-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 16px;
            margin-top: 12px;
        }
        .advanced-grid .form-group {
            margin-bottom: 0;
        }
        .importing-indicator {
            display: none;
            text-align: center;
            padding: 10px;
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }
    </style>
</head>
<body>
    <div class="form-container">
        <h1>Import CSV File</h1>

        <div id="errorMessage" class="error-message"></div>

        <form id="importForm">
            <div class="form-group">
                <label for="schema">Schema</label>
                <select id="schema" disabled>
                    <option value="">Loading schemas...</option>
                </select>
                <div class="hint">Target schema for the new table</div>
            </div>

            <div class="form-group">
                <label for="tableName">Table Name</label>
                <input
                    type="text"
                    id="tableName"
                    placeholder="Enter new table name"
                    required
                />
                <div id="tableNameError" class="inline-error"></div>
                <div class="hint">Name for the new table (must not already exist)</div>
            </div>

            <div class="form-group">
                <label>CSV File</label>
                <div class="file-picker">
                    <input type="text" id="filePath" readonly placeholder="No file selected" />
                    <button type="button" class="secondary-button" onclick="selectFile()" style="flex: 0 0 auto;">Browse...</button>
                </div>
                <div class="hint">Select a .csv, .tsv, or .txt file</div>
            </div>

            <div id="columnPreview" class="column-preview">
                <label>Preview — <span id="columnCount">0</span> columns</label>
                <div class="preview-table-container">
                    <table id="previewTable" class="preview-table">
                        <thead id="previewHead"></thead>
                        <tbody id="previewBody"></tbody>
                    </table>
                </div>
            </div>

            <details>
                <summary>Advanced Options</summary>
                <div class="advanced-grid">
                    <div class="form-group">
                        <label for="columnSeparator">Column Separator</label>
                        <input type="text" id="columnSeparator" placeholder="," maxlength="10" />
                        <div class="hint">Character between columns: , (comma) ; (semicolon) \\t (tab)</div>
                    </div>
                    <div class="form-group">
                        <label for="columnDelimiter">Text Qualifier</label>
                        <input type="text" id="columnDelimiter" placeholder='&quot;' maxlength="10" />
                        <div class="hint">Character that encloses field values (usually ")</div>
                    </div>
                    <div class="form-group">
                        <label for="rowSeparator">Row Separator</label>
                        <input type="text" id="rowSeparator" placeholder="\\n" maxlength="10" />
                    </div>
                    <div class="form-group">
                        <label for="encoding">Encoding</label>
                        <select id="encoding">
                            <option value="">Default (UTF-8)</option>
                            <option value="UTF-8">UTF-8</option>
                            <option value="ASCII">ASCII</option>
                            <option value="ISO-8859-1">ISO-8859-1</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label for="skip">Skip Rows</label>
                        <input type="number" id="skip" placeholder="1" min="0" />
                        <div class="hint">Default: 1 (header row)</div>
                    </div>
                    <div class="form-group">
                        <label for="trim">Trim</label>
                        <select id="trim">
                            <option value="">None</option>
                            <option value="LEADING">LEADING</option>
                            <option value="TRAILING">TRAILING</option>
                            <option value="BOTH">BOTH</option>
                        </select>
                    </div>
                    <div class="form-group" style="grid-column: span 2;">
                        <label for="nullValue">NULL Representation</label>
                        <input type="text" id="nullValue" placeholder="(empty)" />
                        <div class="hint">String value to interpret as NULL</div>
                    </div>
                </div>
            </details>

            <div id="importingIndicator" class="importing-indicator">
                Importing...
            </div>

            <div class="button-group">
                <button type="button" class="secondary-button" onclick="cancel()">
                    Cancel
                </button>
                <button type="submit" class="primary-button" id="importButton" disabled>
                    Import
                </button>
            </div>
        </form>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        // State
        let selectedSchema = '';
        let selectedFilePath = '';
        let columnNames = [];
        let tableNameValid = false;
        let tableNameChecked = false;
        let schemasLoaded = false;

        // Request schemas on load
        vscode.postMessage({ command: 'requestSchemas' });

        // Listen for messages from extension
        window.addEventListener('message', event => {
            const message = event.data;

            switch (message.command) {
                case 'schemas':
                    populateSchemas(message.schemas, message.activeSchema);
                    break;
                case 'tableExistsResult':
                    handleTableExistsResult(message.exists);
                    break;
                case 'fileSelected':
                    handleFileSelected(message.filePath, message.columnNames, message.previewRows);
                    break;
                case 'importComplete':
                    // Panel will be disposed by extension host
                    break;
                case 'importError':
                    showError(message.message);
                    enableForm();
                    break;
            }
        });

        function populateSchemas(schemas, activeSchema) {
            const schemaSelect = document.getElementById('schema');
            schemaSelect.innerHTML = '';

            if (schemas.length === 0) {
                schemaSelect.innerHTML = '<option value="">No schemas available</option>';
                schemaSelect.disabled = true;
                return;
            }

            schemas.forEach(function(schema) {
                const option = document.createElement('option');
                option.value = schema;
                option.textContent = schema;
                if (schema === activeSchema) {
                    option.selected = true;
                }
                schemaSelect.appendChild(option);
            });

            schemaSelect.disabled = false;
            schemasLoaded = true;
            selectedSchema = schemaSelect.value;
            updateImportButton();

            // If table name is already entered, re-check existence
            const tableName = document.getElementById('tableName').value.trim();
            if (tableName) {
                checkTableExists();
            }
        }

        function handleTableExistsResult(exists) {
            const errorDiv = document.getElementById('tableNameError');
            const tableName = document.getElementById('tableName').value.trim();
            const schema = document.getElementById('schema').value;

            if (exists) {
                errorDiv.textContent = 'Table ' + tableName + ' already exists in schema ' + schema;
                errorDiv.style.display = 'block';
                tableNameValid = false;
            } else {
                errorDiv.style.display = 'none';
                tableNameValid = true;
            }
            tableNameChecked = true;
            updateImportButton();
        }

        function escapeHtml(text) {
            var div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function handleFileSelected(filePath, cols, previewRows) {
            selectedFilePath = filePath;
            columnNames = cols;

            document.getElementById('filePath').value = filePath;

            // Render preview table
            var thead = document.getElementById('previewHead');
            var tbody = document.getElementById('previewBody');
            var columnCount = document.getElementById('columnCount');

            // Header row
            thead.innerHTML = '<tr>' + cols.map(function(col) {
                var display = col.length > 50 ? col.substring(0, 50) + '...' : col;
                return '<th title="' + escapeHtml(col) + '">' + escapeHtml(display) + '</th>';
            }).join('') + '</tr>';

            // Data rows
            if (previewRows && previewRows.length > 0) {
                tbody.innerHTML = previewRows.map(function(row) {
                    return '<tr>' + cols.map(function(_, colIndex) {
                        var cell = (row[colIndex] !== undefined) ? row[colIndex] : '';
                        var display = cell.length > 50 ? cell.substring(0, 50) + '...' : cell;
                        return '<td title="' + escapeHtml(cell) + '">' + escapeHtml(display) + '</td>';
                    }).join('') + '</tr>';
                }).join('');
            } else {
                tbody.innerHTML = '<tr><td colspan="' + cols.length + '" style="text-align:center; color: var(--vscode-descriptionForeground);">No data rows found</td></tr>';
            }

            columnCount.textContent = cols.length;
            document.getElementById('columnPreview').style.display = 'block';

            // Separator hint
            var separatorHint = document.getElementById('separatorHint');
            if (!separatorHint) {
                separatorHint = document.createElement('div');
                separatorHint.id = 'separatorHint';
                separatorHint.className = 'inline-error';
                document.getElementById('columnPreview').appendChild(separatorHint);
            }
            if (cols.length === 1 && cols[0].length > 20) {
                separatorHint.textContent = 'Only 1 column detected. Check the Column Separator in Advanced Options (e.g. use ; or \\\\t for tab).';
                separatorHint.style.display = 'block';
            } else {
                separatorHint.style.display = 'none';
            }

            updateImportButton();
        }

        function selectFile() {
            const separator = document.getElementById('columnSeparator').value || ',';
            vscode.postMessage({ command: 'selectFile', separator: separator });
        }

        function cancel() {
            vscode.postMessage({ command: 'cancel' });
        }

        function checkTableExists() {
            const tableName = document.getElementById('tableName').value.trim();
            const schema = document.getElementById('schema').value;

            if (!tableName || !schema) {
                document.getElementById('tableNameError').style.display = 'none';
                tableNameValid = false;
                tableNameChecked = false;
                updateImportButton();
                return;
            }

            vscode.postMessage({
                command: 'checkTableExists',
                schema: schema,
                tableName: tableName
            });
        }

        function updateImportButton() {
            const tableName = document.getElementById('tableName').value.trim();
            const schema = document.getElementById('schema').value;
            const hasFile = selectedFilePath !== '';
            const hasColumns = columnNames.length > 0;

            const canImport = schemasLoaded
                && schema
                && tableName
                && tableNameValid
                && tableNameChecked
                && hasFile
                && hasColumns;

            document.getElementById('importButton').disabled = !canImport;
        }

        // Table name validation on blur
        document.getElementById('tableName').addEventListener('blur', function() {
            checkTableExists();
        });

        // Table name validation on input (with debounce)
        let tableNameTimeout;
        document.getElementById('tableName').addEventListener('input', function() {
            clearTimeout(tableNameTimeout);
            const errorDiv = document.getElementById('tableNameError');
            errorDiv.style.display = 'none';
            tableNameValid = false;
            tableNameChecked = false;
            updateImportButton();

            tableNameTimeout = setTimeout(function() {
                checkTableExists();
            }, 500);
        });

        // Schema change: re-check table name
        document.getElementById('schema').addEventListener('change', function() {
            selectedSchema = this.value;
            const tableName = document.getElementById('tableName').value.trim();
            if (tableName) {
                checkTableExists();
            }
            updateImportButton();
        });

        // Column separator change: re-parse header if file is selected
        document.getElementById('columnSeparator').addEventListener('change', function() {
            if (selectedFilePath) {
                vscode.postMessage({
                    command: 'reparseHeader',
                    filePath: selectedFilePath,
                    separator: this.value || ','
                });
            }
        });

        // Form submission
        document.getElementById('importForm').addEventListener('submit', function(e) {
            e.preventDefault();

            const schema = document.getElementById('schema').value;
            const tableName = document.getElementById('tableName').value.trim();

            if (!schema || !tableName || !selectedFilePath || columnNames.length === 0) {
                showError('Please fill in all required fields');
                return;
            }

            if (!tableNameValid) {
                showError('Please resolve table name issues before importing');
                return;
            }

            // Gather CSV options
            const csvOptions = {};
            const colSep = document.getElementById('columnSeparator').value;
            if (colSep) { csvOptions.columnSeparator = colSep; }

            const colDel = document.getElementById('columnDelimiter').value;
            if (colDel) { csvOptions.columnDelimiter = colDel; }

            const rowSep = document.getElementById('rowSeparator').value;
            if (rowSep) { csvOptions.rowSeparator = rowSep; }

            const encoding = document.getElementById('encoding').value;
            if (encoding) { csvOptions.encoding = encoding; }

            const skip = document.getElementById('skip').value;
            if (skip !== '') { csvOptions.skip = skip; }

            const trim = document.getElementById('trim').value;
            if (trim) { csvOptions.trim = trim; }

            const nullValue = document.getElementById('nullValue').value;
            if (nullValue !== '') { csvOptions.nullValue = nullValue; }

            // Disable form while importing
            disableForm();

            vscode.postMessage({
                command: 'import',
                schema: schema,
                tableName: tableName,
                filePath: selectedFilePath,
                columnNames: columnNames,
                csvOptions: Object.keys(csvOptions).length > 0 ? csvOptions : undefined
            });
        });

        function disableForm() {
            document.getElementById('importButton').disabled = true;
            document.getElementById('importButton').textContent = 'Importing...';
            document.getElementById('importingIndicator').style.display = 'block';
            document.getElementById('errorMessage').style.display = 'none';
        }

        function enableForm() {
            document.getElementById('importButton').textContent = 'Import';
            document.getElementById('importingIndicator').style.display = 'none';
            updateImportButton();
        }

        function showError(message) {
            const errorDiv = document.getElementById('errorMessage');
            errorDiv.textContent = message;
            errorDiv.style.display = 'block';
        }
    </script>
</body>
</html>`;
    }

    public dispose(): void {
        ImportPanel.currentPanel = undefined;
        this._panel.dispose();

        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
