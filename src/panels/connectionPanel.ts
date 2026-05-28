import * as vscode from 'vscode';
import { ConnectionManager, ExasolConnection, FingerprintRequiredError, FingerprintMismatchError, normalizeFingerprint, extractFingerprintError, TlsMode, formatError } from '../connectionManager';

import { createWebviewRenderContext } from '../utils';

export class ConnectionPanel {
    public static currentPanel: ConnectionPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _resolvePromise?: (value: { name: string; id: string } | undefined) => void;

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
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
                    retainContextWhenHidden: true,
                    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
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

            const errorMsg = formatError(error);
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
        const ctx = createWebviewRenderContext(this._panel.webview, this.extensionUri, vscode.Uri.joinPath);

        const isEdit = !!this.existingConnection;
        const values = {
            name: this.existingConnection?.name || '',
            host: this.existingConnection?.host || '',
            port: String(this.existingConnection?.port || 8563),
            user: this.existingConnection?.user || '',
            tlsMode: this.existingConnection?.tlsMode || 'off',
            fingerprint: this.existingConnection?.fingerprint || ''
        };

        const passwordPlaceholder = isEdit
            ? 'Enter new password (leave blank to keep current)'
            : 'Enter password';
        const passwordHint = isEdit
            ? 'Leave blank to keep current password'
            : 'Password will be stored securely in VS Code';
        const passwordRequired = isEdit ? '' : 'required';
        const fingerprintDisplay = values.tlsMode === 'fingerprint' ? 'block' : 'none';

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${ctx.csp}">
    <title>${isEdit ? 'Edit' : 'Add'} Connection</title>
    <link rel="stylesheet" href="${ctx.mediaUri('connection-panel.css')}">
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
                    placeholder="${passwordPlaceholder}"
                    ${passwordRequired}
                />
                <div class="hint">${passwordHint}</div>
            </div>

            <div class="form-group">
                <label for="tlsMode">
                    <span class="icon">🛡️</span>TLS Certificate Validation
                </label>
                <select id="tlsMode">
                    <option value="off" ${values.tlsMode === 'off' ? 'selected' : ''}>Off (no validation)</option>
                    <option value="fingerprint" ${values.tlsMode === 'fingerprint' ? 'selected' : ''}>Fingerprint (pin certificate)</option>
                    <option value="full" ${values.tlsMode === 'full' ? 'selected' : ''}>Full validation (trusted CA)</option>
                </select>
                <div class="hint">Off: accept any certificate. Fingerprint: pin to specific certificate. Full: require trusted CA.</div>
            </div>

            <div class="form-group" id="fingerprintGroup" style="display: ${fingerprintDisplay};">
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
                <button type="button" class="secondary-button" id="cancelButton">
                    Cancel
                </button>
                <button type="submit" class="primary-button" id="submitButton">
                    Test &amp; ${isEdit ? 'Update' : 'Add'} Connection
                </button>
            </div>
        </form>
    </div>

    ${ctx.dataIsland('conn-data', { isEdit, submitLabel: isEdit ? 'Update' : 'Add' })}
    <script nonce="${ctx.nonce}" src="${ctx.mediaUri('connection-panel.js')}"></script>
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
