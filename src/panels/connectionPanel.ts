import * as vscode from 'vscode';
import { ConnectionManager, ExasolConnection, FingerprintRequiredError, FingerprintMismatchError, normalizeFingerprint, extractFingerprintError, TlsMode } from '../connectionManager';

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

    private async handleSubmit(data: {
        name: string; host: string; port: string; user: string; password: string;
        tlsMode: TlsMode; fingerprint: string;
    }) {
        const { name, host, port, user, password, tlsMode, fingerprint } = data;
        const portNum = parseInt(port, 10);

        const action = this.existingConnection ? 'update' : 'add';
        this.outputChannel.appendLine(`📝 Attempting to ${action} connection '${name}'`);
        this.outputChannel.appendLine(`   Host: ${host}`);
        this.outputChannel.appendLine(`   Port: ${portNum}`);
        this.outputChannel.appendLine(`   User: ${user}`);
        this.outputChannel.appendLine(`   TLS mode: ${tlsMode}`);

        const normalizedFp = fingerprint ? normalizeFingerprint(fingerprint) : undefined;

        const connectionData = {
            name,
            host,
            port: portNum,
            user,
            password,
            tlsMode,
            fingerprint: normalizedFp
        };

        try {
            // Show testing state in webview
            this._panel.webview.postMessage({ command: 'testing' });

            this.outputChannel.appendLine(`🔌 Testing connection to ${host}:${portNum}...`);

            let id: string;
            if (this.existingConnection) {
                id = await this.connectionManager.updateConnection(this.existingConnection.id, connectionData);
            } else {
                id = await this.connectionManager.addConnection(connectionData);
            }

            this.outputChannel.appendLine(`✅ Connection test successful`);

            // Close panel and resolve with success
            this.dispose();
            if (this._resolvePromise) {
                this._resolvePromise({ name, id });
            }
        } catch (error) {
            // Handle TOFU: fingerprint required (no stored fingerprint yet)
            const fpError = extractFingerprintError(error);
            if (fpError instanceof FingerprintRequiredError) {
                this.outputChannel.appendLine(`🔑 Server fingerprint: ${fpError.serverFingerprint}`);
                const accept = await vscode.window.showWarningMessage(
                    `Trust this server certificate?\n\nSHA-256 fingerprint:\n${fpError.serverFingerprint}`,
                    { modal: true },
                    'Accept',
                    'Reject'
                );
                if (accept === 'Accept') {
                    await this.acceptFingerprintAndRetry(connectionData, name, fpError.serverFingerprint, 'Fingerprint accepted');
                } else {
                    this.outputChannel.appendLine(`❌ Fingerprint rejected by user`);
                    this._panel.webview.postMessage({ command: 'error', error: 'Certificate fingerprint rejected.' });
                }
                return;
            }

            // Handle fingerprint mismatch
            if (fpError instanceof FingerprintMismatchError) {
                this.outputChannel.appendLine(`⚠️ Fingerprint mismatch! Stored: ${fpError.storedFingerprint}, Server: ${fpError.serverFingerprint}`);
                const accept = await vscode.window.showWarningMessage(
                    `Server certificate has changed!\n\nStored fingerprint:\n${fpError.storedFingerprint}\n\nNew fingerprint:\n${fpError.serverFingerprint}\n\nAccept the new certificate?`,
                    { modal: true },
                    'Accept New',
                    'Reject'
                );
                if (accept === 'Accept New') {
                    await this.acceptFingerprintAndRetry(connectionData, name, fpError.serverFingerprint, 'New fingerprint accepted');
                } else {
                    this.outputChannel.appendLine(`❌ New fingerprint rejected by user`);
                    this._panel.webview.postMessage({ command: 'error', error: 'Certificate fingerprint change rejected.' });
                }
                return;
            }

            const errorMsg = String(error);
            this.outputChannel.appendLine(`❌ Connection test failed: ${errorMsg}`);
            this._panel.webview.postMessage({ command: 'error', error: errorMsg });
        }
    }

    /**
     * Save the accepted fingerprint on the connection data, persist, and close the panel.
     * Shared by both the TOFU and mismatch-accept flows.
     */
    private async acceptFingerprintAndRetry(
        connectionData: { fingerprint?: string } & ExasolConnection,
        name: string,
        fingerprint: string,
        successLabel: string
    ): Promise<void> {
        connectionData.fingerprint = fingerprint;
        try {
            let id: string;
            if (this.existingConnection) {
                id = await this.connectionManager.updateConnection(this.existingConnection.id, connectionData);
            } else {
                id = await this.connectionManager.addConnection(connectionData);
            }
            this.outputChannel.appendLine(`✅ ${successLabel}, connection successful`);
            this.dispose();
            if (this._resolvePromise) {
                this._resolvePromise({ name, id });
            }
        } catch (retryError) {
            const retryMsg = String(retryError);
            this.outputChannel.appendLine(`❌ Retry after fingerprint accept failed: ${retryMsg}`);
            this._panel.webview.postMessage({ command: 'error', error: retryMsg });
        }
    }

    private _update() {
        this._panel.webview.html = this._getHtmlForWebview();
    }

    private _getHtmlForWebview(): string {
        // Pre-fill values for edit mode
        const values = {
            name: this.existingConnection?.name || '',
            host: this.existingConnection?.host || '',
            port: String(this.existingConnection?.port || 8563),
            user: this.existingConnection?.user || '',
            password: '',
            tlsMode: this.existingConnection?.tlsMode || 'off',
            fingerprint: this.existingConnection?.fingerprint || ''
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

            <div class="form-group">
                <label for="tlsMode">
                    <span class="icon">🛡️</span>TLS Certificate Validation
                </label>
                <select id="tlsMode" onchange="toggleFingerprint()">
                    <option value="off" ${values.tlsMode === 'off' ? 'selected' : ''}>Off (no validation)</option>
                    <option value="fingerprint" ${values.tlsMode === 'fingerprint' ? 'selected' : ''}>Fingerprint (pin certificate)</option>
                    <option value="full" ${values.tlsMode === 'full' ? 'selected' : ''}>Full validation (trusted CA)</option>
                </select>
                <div class="hint">Off: accept any certificate. Fingerprint: pin to specific certificate. Full: require trusted CA.</div>
            </div>

            <div class="form-group" id="fingerprintGroup" style="display: ${values.tlsMode === 'fingerprint' ? 'block' : 'none'};">
                <label for="fingerprint">
                    <span class="icon">🔑</span>Certificate Fingerprint (SHA-256)
                </label>
                <input
                    type="text"
                    id="fingerprint"
                    placeholder="e.g. AB:CD:EF:01:23... or ABCDEF0123..."
                    value="${values.fingerprint}"
                />
                <div class="hint">64-character hex string (colons optional). Leave blank to accept on first connect (TOFU).</div>
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
        const isEdit = ${isEdit};

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

        function toggleFingerprint() {
            const tlsMode = document.getElementById('tlsMode').value;
            document.getElementById('fingerprintGroup').style.display = tlsMode === 'fingerprint' ? 'block' : 'none';
        }

        document.getElementById('connectionForm').addEventListener('submit', function(e) {
            e.preventDefault();

            const name = document.getElementById('name').value.trim();
            const host = document.getElementById('host').value.trim();
            const port = document.getElementById('port').value.trim();
            const user = document.getElementById('user').value.trim();
            const password = document.getElementById('password').value;
            const tlsMode = document.getElementById('tlsMode').value;
            const fingerprint = document.getElementById('fingerprint').value.trim();

            // Validate inputs
            if (!name || !host || !port || !user || (!isEdit && !password)) {
                showError('All fields are required');
                return;
            }

            // Validate port is a number
            if (isNaN(port) || parseInt(port) <= 0 || parseInt(port) > 65535) {
                showError('Port must be a valid number between 1 and 65535');
                return;
            }

            // Validate fingerprint if provided
            if (tlsMode === 'fingerprint' && fingerprint) {
                const normalized = fingerprint.replace(/[:\\s]/g, '').toUpperCase();
                if (!/^[0-9A-F]{64}$/.test(normalized)) {
                    showError('Fingerprint must be a 64-character hexadecimal string (SHA-256)');
                    return;
                }
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
                data: { name, host, port, user, password, tlsMode, fingerprint }
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
            submitButton.textContent = 'Test & ${isEdit ? 'Update' : 'Add'} Connection';
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
