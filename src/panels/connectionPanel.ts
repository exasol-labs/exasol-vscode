import * as vscode from 'vscode';
import { ConnectionManager } from '../connectionManager';

export class ConnectionPanel {
    public static currentPanel: ConnectionPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _resolvePromise?: (value: { name: string; id: string } | undefined) => void;

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        private connectionManager: ConnectionManager,
        private outputChannel: vscode.OutputChannel,
        private existingConnection?: any
    ) {
        this._panel = panel;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._update();
    }

    public static show(
        extensionUri: vscode.Uri,
        connectionManager: ConnectionManager,
        outputChannel: vscode.OutputChannel
    ): Promise<{ name: string; id: string } | undefined> {
        return ConnectionPanel.showPanel(extensionUri, connectionManager, outputChannel, undefined);
    }

    public static showEdit(
        extensionUri: vscode.Uri,
        connectionManager: ConnectionManager,
        outputChannel: vscode.OutputChannel,
        existingConnection: any
    ): Promise<{ name: string; id: string } | undefined> {
        return ConnectionPanel.showPanel(extensionUri, connectionManager, outputChannel, existingConnection);
    }

    private static showPanel(
        extensionUri: vscode.Uri,
        connectionManager: ConnectionManager,
        outputChannel: vscode.OutputChannel,
        existingConnection?: any
    ): Promise<{ name: string; id: string } | undefined> {
        return new Promise((resolve) => {
            const column = vscode.ViewColumn.One;

            // If we already have a panel, dispose it
            if (ConnectionPanel.currentPanel) {
                ConnectionPanel.currentPanel.dispose();
            }

            // Create new panel
            const title = existingConnection ? 'Edit Exasol Connection' : 'Add Exasol Connection';
            const panel = vscode.window.createWebviewPanel(
                'exasolConnection',
                title,
                column,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            const connectionPanel = new ConnectionPanel(panel, extensionUri, connectionManager, outputChannel, existingConnection);
            ConnectionPanel.currentPanel = connectionPanel;
            connectionPanel._resolvePromise = resolve;

            // Handle messages from webview
            connectionPanel._panel.webview.onDidReceiveMessage(
                async message => {
                    switch (message.command) {
                        case 'submit':
                            await connectionPanel.handleSubmit(message.data);
                            return;
                        case 'cancel':
                            connectionPanel.dispose();
                            resolve(undefined);
                            return;
                    }
                },
                null,
                connectionPanel._disposables
            );
        });
    }

    private async handleSubmit(data: { name: string; host: string; port: string; user: string; password: string }) {
        const { name, host, port, user, password } = data;

        const action = this.existingConnection ? 'update' : 'add';
        this.outputChannel.appendLine(`📝 Attempting to ${action} connection '${name}'`);
        this.outputChannel.appendLine(`   Host: ${host}`);
        this.outputChannel.appendLine(`   Port: ${port}`);
        this.outputChannel.appendLine(`   User: ${user}`);

        // Combine host and port
        const hostWithPort = `${host}:${port}`;

        try {
            // Show testing state in webview
            this._panel.webview.postMessage({ command: 'testing' });

            this.outputChannel.appendLine(`🔌 Testing connection to ${hostWithPort}...`);

            let id: string;
            if (this.existingConnection) {
                // Update existing connection
                id = await this.connectionManager.updateConnection(this.existingConnection.id, {
                    name,
                    host: hostWithPort,
                    user,
                    password
                });
            } else {
                // Add new connection
                id = await this.connectionManager.addConnection({
                    name,
                    host: hostWithPort,
                    user,
                    password
                });
            }

            this.outputChannel.appendLine(`✅ Connection test successful`);

            // Close panel and resolve with success
            this.dispose();
            if (this._resolvePromise) {
                this._resolvePromise({ name, id });
            }
        } catch (error) {
            const errorMsg = String(error);
            this.outputChannel.appendLine(`❌ Connection test failed: ${errorMsg}`);

            // Send error back to webview to display
            this._panel.webview.postMessage({
                command: 'error',
                error: errorMsg
            });
        }
    }

    private _update() {
        this._panel.webview.html = this._getHtmlForWebview();
    }

    private _getHtmlForWebview(): string {
        // Pre-fill values for edit mode
        const [hostPart, portPart] = this.existingConnection?.host?.split(':') || ['', ''];
        const values = {
            name: this.existingConnection?.name || '',
            host: hostPart || '',
            port: portPart || '8563',
            user: this.existingConnection?.user || '',
            password: ''
        };
        const isEdit = !!this.existingConnection;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${isEdit ? 'Edit' : 'Add'} Connection</title>
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
        input:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        input::placeholder {
            color: var(--vscode-input-placeholderForeground);
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
        .icon {
            margin-right: 8px;
        }
    </style>
</head>
<body>
    <div class="form-container">
        <h1>🔌 ${isEdit ? 'Edit' : 'Add'} Exasol Connection</h1>

        <div id="errorMessage" class="error-message"></div>

        <form id="connectionForm">
            <div class="form-group">
                <label for="name">
                    <span class="icon">📝</span>Connection Name
                </label>
                <input
                    type="text"
                    id="name"
                    placeholder="My Exasol Database"
                    value="${values.name}"
                    required
                    autofocus
                />
                <div class="hint">A friendly name to identify this connection</div>
            </div>

            <div class="form-group">
                <label for="host">
                    <span class="icon">🌐</span>Host
                </label>
                <input
                    type="text"
                    id="host"
                    placeholder="localhost"
                    value="${values.host}"
                    required
                />
                <div class="hint">Hostname or IP address</div>
            </div>

            <div class="form-group">
                <label for="port">
                    <span class="icon">🔌</span>Port
                </label>
                <input
                    type="text"
                    id="port"
                    value="${values.port}"
                    required
                />
                <div class="hint">Exasol database port (default: 8563)</div>
            </div>

            <div class="form-group">
                <label for="user">
                    <span class="icon">👤</span>Username
                </label>
                <input
                    type="text"
                    id="user"
                    placeholder="sys"
                    value="${values.user}"
                    required
                />
                <div class="hint">Your Exasol database username</div>
            </div>

            <div class="form-group">
                <label for="password">
                    <span class="icon">🔒</span>Password
                </label>
                <input
                    type="password"
                    id="password"
                    placeholder="${isEdit ? 'Enter new password (leave blank to keep current)' : 'Enter password'}"
                    ${isEdit ? '' : 'required'}
                />
                <div class="hint">${isEdit ? 'Leave blank to keep current password' : 'Password will be stored securely in VS Code'}</div>
            </div>

            <div class="button-group">
                <button type="button" class="secondary-button" onclick="cancel()">
                    Cancel
                </button>
                <button type="submit" class="primary-button" id="submitButton">
                    Test & ${isEdit ? 'Update' : 'Add'} Connection
                </button>
            </div>
        </form>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        // Listen for messages from extension
        window.addEventListener('message', event => {
            const message = event.data;

            switch (message.command) {
                case 'error':
                    showError(message.error);
                    break;
                case 'testing':
                    // Already handled by submit button state
                    break;
            }
        });

        document.getElementById('connectionForm').addEventListener('submit', function(e) {
            e.preventDefault();

            const name = document.getElementById('name').value.trim();
            const host = document.getElementById('host').value.trim();
            const port = document.getElementById('port').value.trim();
            const user = document.getElementById('user').value.trim();
            const password = document.getElementById('password').value;

            // Validate inputs
            if (!name || !host || !port || !user || !password) {
                showError('All fields are required');
                return;
            }

            // Validate port is a number
            if (isNaN(port) || parseInt(port) <= 0 || parseInt(port) > 65535) {
                showError('Port must be a valid number between 1 and 65535');
                return;
            }

            // Hide any previous errors
            document.getElementById('errorMessage').style.display = 'none';

            // Disable submit button
            const submitButton = document.getElementById('submitButton');
            submitButton.disabled = true;
            submitButton.textContent = 'Testing Connection...';

            // Send data to extension
            vscode.postMessage({
                command: 'submit',
                data: { name, host, port, user, password }
            });
        });

        function cancel() {
            vscode.postMessage({ command: 'cancel' });
        }

        function showError(message) {
            const errorDiv = document.getElementById('errorMessage');
            errorDiv.textContent = '❌ ' + message;
            errorDiv.style.display = 'block';

            // Re-enable submit button
            const submitButton = document.getElementById('submitButton');
            submitButton.disabled = false;
            submitButton.textContent = 'Test & Add Connection';
        }

        // Focus on first input
        document.getElementById('name').focus();
    </script>
</body>
</html>`;
    }

    public dispose() {
        ConnectionPanel.currentPanel = undefined;
        this._panel.dispose();

        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
