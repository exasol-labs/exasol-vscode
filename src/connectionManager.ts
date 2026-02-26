import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as tls from 'tls';
import { ExasolDriver, ExaWebsocket } from '@exasol/exasol-driver-ts';
import { WebSocket } from 'ws';
import { getOutputChannel } from './extension';
import {
    TlsMode,
    ExasolConnection,
    StoredConnection,
    FingerprintRequiredError,
    FingerprintMismatchError,
    normalizeFingerprint,
    formatError,
    extractFingerprintError
} from './connectionTypes';

// Re-export for existing consumers
export {
    TlsMode,
    ExasolConnection,
    StoredConnection,
    FingerprintRequiredError,
    FingerprintMismatchError,
    normalizeFingerprint,
    formatError,
    extractFingerprintError
};

/** Timeout in ms for establishing a new connection (WebSocket + TLS handshake + auth). */
const CONNECTION_TIMEOUT_MS = 10_000;
/** Timeout in ms for the TLS probe used to read the server certificate fingerprint. */
const TLS_PROBE_TIMEOUT_MS = 5_000;
/** Interval in ms between WebSocket ping probes to detect dead connections. */
const PING_INTERVAL_MS = 30_000;
/** Maximum number of attempts when (re)connecting to the server. */
const RECONNECT_MAX_ATTEMPTS = 3;
/** Delay in ms between reconnection attempts. */
const RECONNECT_DELAY_MS = 2_000;
/** Cooldown in ms after a connection failure — subsequent callers get the cached error instead of spawning new attempts. */
const FAILURE_COOLDOWN_MS = 5_000;
/** Skip SELECT 1 validation if a query succeeded within this window (ms). */
const VALIDATION_SKIP_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout;
    return Promise.race([
        promise,
        new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(message)), ms);
        })
    ]).finally(() => clearTimeout(timer));
}

export class ConnectionManager {
    private connections: Map<string, StoredConnection> = new Map();
    private activeConnection: string | null = null;
    private drivers: Map<string, ExasolDriver> = new Map();
    private connectingPromises: Map<string, Promise<ExasolDriver>> = new Map();
    /** Tracks recent connection failures to prevent cascading reconnection attempts. */
    private recentFailures: Map<string, { error: Error; timestamp: number }> = new Map();
    /** Timestamp of the last successful driver.query() per connection, used to skip redundant validation. */
    private lastSuccessfulQuery: Map<string, number> = new Map();
    /** Serializes driver access (validation + query) to prevent pool exhaustion. */
    private queryMutex: Promise<void> = Promise.resolve();
    private readonly connectionsChangedEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeConnections = this.connectionsChangedEmitter.event;
    private readonly activeConnectionChangedEmitter = new vscode.EventEmitter<StoredConnection | undefined>();
    readonly onDidChangeActiveConnection = this.activeConnectionChangedEmitter.event;

    constructor(private context: vscode.ExtensionContext) {
        void this.loadConnections().then(() => {
            this.notifyConnectionsChanged();
            this.notifyActiveConnectionChanged();
        });
    }

    private async loadConnections() {
        const stored = this.context.globalState.get<Array<Omit<StoredConnection, 'password'>>>('exasol.connections', []);
        let needsSave = false;
        for (const conn of stored) {
            // Migrate old host:port format to separate fields
            if (!conn.port && conn.host.includes(':')) {
                const [host, portStr] = conn.host.split(':');
                conn.host = host;
                conn.port = parseInt(portStr, 10) || 8563;
                needsSave = true;
            } else if (!conn.port) {
                conn.port = 8563;
                needsSave = true;
            }
            // Load password from secure storage
            const password = await this.context.secrets.get(`exasol.password.${conn.id}`);
            if (password) {
                this.connections.set(conn.id, {
                    ...conn,
                    password
                });
            }
        }
        if (needsSave) {
            await this.saveConnections();
        }
        // Do not auto-activate any connection - user must manually select
    }

    private notifyConnectionsChanged(): void {
        this.connectionsChangedEmitter.fire();
    }

    private notifyActiveConnectionChanged(): void {
        this.activeConnectionChangedEmitter.fire(this.getActiveConnection());
    }

    private async saveConnections() {
        // Save connection info without passwords to globalState
        const connectionsWithoutPasswords = Array.from(this.connections.values()).map(conn => {
            const { password, ...rest } = conn;
            return rest;
        });
        await this.context.globalState.update('exasol.connections', connectionsWithoutPasswords);
    }

    async addConnection(connection: ExasolConnection): Promise<string> {
        const id = `${connection.name}-${Date.now()}`;
        const stored: StoredConnection = {
            ...connection,
            id
        };

        // Test connection
        await this.testConnection(stored);

        this.connections.set(id, stored);

        // Store password securely
        await this.context.secrets.store(`exasol.password.${id}`, connection.password);

        // Save connection metadata (without password)
        await this.saveConnections();

        // Do not auto-activate - user must manually select the connection
        this.notifyConnectionsChanged();

        return id;
    }

    async updateConnection(id: string, connection: ExasolConnection): Promise<string> {
        const existing = this.connections.get(id);
        if (!existing) {
            throw new Error(`Connection ${id} not found`);
        }

        // Use existing password if new one not provided
        const password = connection.password || existing.password;

        const updated: StoredConnection = {
            ...connection,
            password,
            id
        };

        // Test connection
        await this.testConnection(updated);

        // Close existing driver if any
        const driver = this.drivers.get(id);
        if (driver) {
            await driver.close();
            this.drivers.delete(id);
        }

        // Update connection
        this.connections.set(id, updated);

        // Update password in secure storage
        await this.context.secrets.store(`exasol.password.${id}`, password);

        // Save connection metadata
        await this.saveConnections();

        this.notifyConnectionsChanged();
        if (this.activeConnection === id) {
            this.notifyActiveConnectionChanged();
        }

        return id;
    }

    async renameConnection(id: string, newName: string): Promise<void> {
        const existing = this.connections.get(id);
        if (!existing) {
            throw new Error(`Connection ${id} not found`);
        }

        this.connections.set(id, {
            ...existing,
            name: newName
        });

        await this.saveConnections();
        this.notifyConnectionsChanged();
        if (this.activeConnection === id) {
            this.notifyActiveConnectionChanged();
        }
    }

    async removeConnection(id: string): Promise<void> {
        this.connections.delete(id);

        // Remove password from secure storage
        await this.context.secrets.delete(`exasol.password.${id}`);

        // Close driver if exists
        const driver = this.drivers.get(id);
        if (driver) {
            await driver.close();
            this.drivers.delete(id);
        }

        const wasActive = this.activeConnection === id;

        if (this.activeConnection === id) {
            this.activeConnection = null;
            const firstConnection = this.connections.values().next().value;
            if (firstConnection) {
                this.activeConnection = firstConnection.id;
            }
        }

        await this.saveConnections();
        this.notifyConnectionsChanged();
        if (wasActive) {
            this.notifyActiveConnectionChanged();
        }
    }

    getConnections(): StoredConnection[] {
        return Array.from(this.connections.values());
    }

    getConnection(id: string): StoredConnection | undefined {
        return this.connections.get(id);
    }

    async setActiveConnection(id: string): Promise<void> {
        if (!this.connections.has(id)) {
            throw new Error(`Connection ${id} not found`);
        }
        this.activeConnection = id;
        this.notifyActiveConnectionChanged();
    }

    getActiveConnection(): StoredConnection | undefined {
        if (!this.activeConnection) {
            return undefined;
        }
        return this.connections.get(this.activeConnection);
    }

    async getDriver(connectionId?: string): Promise<ExasolDriver> {
        const id = connectionId || this.activeConnection;

        if (!id) {
            throw new Error('No active connection');
        }

        const connection = this.connections.get(id);
        if (!connection) {
            throw new Error(`Connection ${id} not found`);
        }

        // If a recent connection attempt failed, re-throw the cached error
        // instead of spawning another reconnection sequence
        const recent = this.recentFailures.get(id);
        if (recent && Date.now() - recent.timestamp < FAILURE_COOLDOWN_MS) {
            throw recent.error;
        }

        let isReconnect = false;

        // Check if we have an existing driver
        if (this.drivers.has(id)) {
            const driver = this.drivers.get(id)!;

            // Validate the connection is still alive
            const isValid = await this.validateDriver(driver, id);
            if (isValid) {
                return driver;
            }

            // Connection is stale — close old driver to free the WebSocket, then reconnect
            const outputChannel = getOutputChannel();
            outputChannel.appendLine(`Connection ${connection.name} appears stale, reconnecting...`);
            this.drivers.delete(id);
            this.lastSuccessfulQuery.delete(id);
            try { await withTimeout(driver.close(), 2000, 'Driver close timeout'); } catch { /* ignore close errors */ }
            isReconnect = true;
        }

        // Dedup: if already connecting, wait for that promise
        if (this.connectingPromises.has(id)) {
            return this.connectingPromises.get(id)!;
        }

        // Connect with retry + progress
        const promise = this.connectWithRetry(connection, isReconnect);
        this.connectingPromises.set(id, promise);
        try {
            const driver = await promise;
            this.drivers.set(id, driver);
            this.recentFailures.delete(id);
            return driver;
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            // Don't cache intentional user cancellation — they should be able to retry immediately
            if (!err.message.includes('cancelled by user')) {
                this.recentFailures.set(id, { error: err, timestamp: Date.now() });
            }
            throw err;
        } finally {
            this.connectingPromises.delete(id);
        }
    }

    private async connectWithRetry(connection: StoredConnection, isReconnect: boolean): Promise<ExasolDriver> {
        const title = isReconnect
            ? `Reconnecting to ${connection.name}...`
            : `Connecting to ${connection.name}...`;

        return await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title, cancellable: true },
            async (_progress, token) => {
                const outputChannel = getOutputChannel();
                for (let attempt = 1; attempt <= RECONNECT_MAX_ATTEMPTS; attempt++) {
                    if (token.isCancellationRequested) {
                        throw new Error('Connection cancelled by user');
                    }
                    try {
                        if (attempt > 1) {
                            _progress.report({ message: `Attempt ${attempt}/${RECONNECT_MAX_ATTEMPTS}...` });
                        }
                        return await this.createDriver(connection);
                    } catch (error) {
                        // Fingerprint errors are never retriable — they require user action
                        if (extractFingerprintError(error)) {
                            throw error;
                        }
                        outputChannel.appendLine(
                            `Connection attempt ${attempt}/${RECONNECT_MAX_ATTEMPTS} failed: ${formatError(error)}`
                        );
                        if (attempt === RECONNECT_MAX_ATTEMPTS) {
                            throw error;
                        }
                        // Wait before next attempt
                        await new Promise<void>((resolve) => {
                            const timer = setTimeout(resolve, RECONNECT_DELAY_MS);
                            token.onCancellationRequested(() => {
                                clearTimeout(timer);
                                resolve();
                            });
                        });
                    }
                }
                // Unreachable, but satisfies TypeScript
                throw new Error('Connection failed');
            }
        );
    }

    async resetDriver(connectionId?: string): Promise<void> {
        const id = connectionId || this.activeConnection;
        if (!id) {
            return;
        }

        this.recentFailures.delete(id);
        this.lastSuccessfulQuery.delete(id);

        const driver = this.drivers.get(id);
        if (driver) {
            try {
                await driver.close();
            } catch (error) {
                // Ignore errors when closing
            }
            this.drivers.delete(id);
        }
    }

    /**
     * Checks if an error is a connection-related error that requires reconnection
     */
    private isConnectionError(error: unknown): boolean {
        // Fingerprint errors are not retriable — they must be surfaced to the user
        if (extractFingerprintError(error)) {
            return false;
        }
        const errorMsg = error instanceof Error ? error.message : String(error);
        return (
            errorMsg.includes('E-EDJS-8') || // Pool exhaustion
            errorMsg.includes('pool reached its limit') ||
            errorMsg.includes('ECONNRESET') || // Connection reset
            errorMsg.includes('EPIPE') || // Broken pipe
            errorMsg.includes('ETIMEDOUT') || // Timeout
            errorMsg.includes('ENOTFOUND') || // Host not found
            errorMsg.includes('ECONNREFUSED') || // Connection refused
            errorMsg.includes('connection closed') ||
            errorMsg.includes('WebSocket') ||
            errorMsg.includes('socket hang up') ||
            errorMsg.toLowerCase().includes('timeout')
        );
    }

    /**
     * Executes a function with automatic retry on connection errors.
     * If a connection error occurs, the driver is reset and the function is retried once.
     *
     * @param fn The function to execute
     * @param connectionId Optional connection ID (defaults to active connection)
     * @returns The result of the function
     */
    async executeWithRetry<T>(fn: () => Promise<T>, connectionId?: string): Promise<T> {
        const id = connectionId || this.activeConnection;
        try {
            const result = await this.runExclusive(fn);
            // Track successful query so validateDriver can skip SELECT 1
            if (id) {
                this.lastSuccessfulQuery.set(id, Date.now());
            }
            return result;
        } catch (error) {
            // Check if it's a connection-related error that requires reconnection
            if (this.isConnectionError(error) && id && this.drivers.has(id)) {
                // Only retry if a driver existed — meaning the query itself failed
                // on an established connection. If no driver exists, getDriver()/
                // connectWithRetry() already exhausted its retries; retrying here
                // would just double-stack connection attempts.
                const outputChannel = getOutputChannel();
                outputChannel.appendLine(`Connection error detected, retrying...`);

                // Clear stale caches so getDriver() validates properly on retry.
                // We intentionally do NOT call resetDriver() here — we're outside
                // the mutex, so another caller may have already reconnected. Calling
                // resetDriver() would destroy that fresh connection. Instead, let
                // getDriver() (inside fn) validate and reconnect if needed.
                this.recentFailures.delete(id);
                this.lastSuccessfulQuery.delete(id);

                const result = await this.runExclusive(fn);
                if (id) {
                    this.lastSuccessfulQuery.set(id, Date.now());
                }
                return result;
            }
            throw error;
        }
    }

    private isWebSocketHealthy(driver: ExasolDriver): boolean {
        try {
            // Access the internal WebSocket connection to check its state
            // The driver has a connection property that may contain the WebSocket
            const driverAny = driver as any;
            const connection = driverAny._connection || driverAny.connection || driverAny._ws || driverAny.ws;

            if (connection && connection.readyState !== undefined) {
                // WebSocket.OPEN = 1
                // If not open (CONNECTING=0, CLOSING=2, CLOSED=3), connection is not healthy
                return connection.readyState === 1;
            }

            // If we can't access WebSocket state, assume we need to validate with query
            return true;
        } catch (error) {
            // If we can't check WebSocket state, assume we need to validate with query
            return true;
        }
    }

    /**
     * Serializes access to the driver's single-connection pool.
     * Callers queue behind each other so only one query runs at a time,
     * preventing E-EDJS-8 "pool reached its limit" errors.
     */
    private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
        const prev = this.queryMutex;
        let resolve!: () => void;
        this.queryMutex = new Promise<void>(r => { resolve = r; });
        return prev.then(fn).finally(resolve);
    }

    private async validateDriver(driver: ExasolDriver, connectionId: string): Promise<boolean> {
        try {
            // FAST CHECK: WebSocket state for instant detection of dead connections
            if (!this.isWebSocketHealthy(driver)) {
                const outputChannel = getOutputChannel();
                outputChannel.appendLine(`WebSocket is closed or closing - connection is stale`);
                return false;
            }

            // SKIP expensive SELECT 1 if a query succeeded recently.
            // The ping/pong keep-alive (30s) terminates dead WebSockets proactively,
            // so the fast check above catches most stale connections. The SELECT 1
            // only helps detect server-side session expiry, which is rare within
            // the skip window.
            const lastSuccess = this.lastSuccessfulQuery.get(connectionId);
            if (lastSuccess && Date.now() - lastSuccess < VALIDATION_SKIP_MS) {
                return true;
            }

            const config = vscode.workspace.getConfiguration('exasol');
            const validationTimeout = config.get<number>('connectionValidationTimeout', 1) * 1000;

            // No mutex here — callers (executeWithRetry) already hold the mutex,
            // so this runs inside the exclusive section.
            await withTimeout(
                driver.query('SELECT 1'),
                validationTimeout,
                'Validation timeout'
            );
            this.lastSuccessfulQuery.set(connectionId, Date.now());
            return true;
        } catch (error) {
            const outputChannel = getOutputChannel();
            outputChannel.appendLine(`Connection validation failed: ${error}`);
            return false;
        }
    }

    /**
     * Build a WebSocket factory function that applies TLS settings based on the connection's tlsMode.
     *
     * For "fingerprint" mode, validation is done by testConnection() before
     * the connection is stored, so the factory just uses rejectUnauthorized: false.
     */
    private createWebSocketFactory(connection: StoredConnection, errorHolder?: { lastError?: Error }): (url: string) => ExaWebsocket {
        const tlsMode = connection.tlsMode || 'off';

        return (url: string) => {
            const rejectUnauthorized = tlsMode === 'full';
            const ws = new WebSocket(url, { rejectUnauthorized });
            if (errorHolder) {
                ws.on('error', (err: Error) => {
                    errorHolder.lastError = err;
                });
            }

            // Ping/pong keep-alive to detect dead connections proactively
            let alive = true;
            ws.on('pong', () => { alive = true; });
            ws.on('open', () => {
                const interval = setInterval(() => {
                    if (ws.readyState !== WebSocket.OPEN) {
                        clearInterval(interval);
                        return;
                    }
                    if (!alive) {
                        ws.terminate();
                        clearInterval(interval);
                        return;
                    }
                    alive = false;
                    ws.ping();
                }, PING_INTERVAL_MS);

                ws.on('close', () => clearInterval(interval));
            });

            return ws as ExaWebsocket;
        };
    }

    /**
     * Connect to the server with TLS (no application protocol) just to read
     * the peer certificate. Returns the SHA-256 fingerprint (uppercase hex).
     */
    private getServerCertificateFingerprint(host: string, port: number): Promise<string> {
        return new Promise((resolve, reject) => {
            const socket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
                const cert = socket.getPeerCertificate(true);
                socket.destroy();
                if (cert && cert.raw) {
                    const fp = crypto.createHash('sha256').update(cert.raw).digest('hex').toUpperCase();
                    resolve(fp);
                } else {
                    reject(new Error('Server did not present a certificate'));
                }
            });
            socket.on('error', (err) => {
                socket.destroy();
                reject(err);
            });
            socket.setTimeout(TLS_PROBE_TIMEOUT_MS, () => {
                socket.destroy();
                reject(new Error('TLS connection timeout while checking certificate'));
            });
        });
    }

    /**
     * Validate the server certificate fingerprint for connections using "fingerprint" TLS mode.
     * Called before creating a driver. Throws FingerprintRequiredError (TOFU) or
     * FingerprintMismatchError if validation fails.
     */
    private async validateFingerprint(connection: StoredConnection): Promise<void> {
        if ((connection.tlsMode || 'off') !== 'fingerprint') {
            return;
        }

        const serverFp = await this.getServerCertificateFingerprint(connection.host, connection.port);
        const storedFp = connection.fingerprint ? normalizeFingerprint(connection.fingerprint) : '';

        if (!storedFp) {
            throw new FingerprintRequiredError(serverFp);
        }
        if (serverFp !== storedFp) {
            throw new FingerprintMismatchError(storedFp, serverFp);
        }
    }

    private async createDriver(connection: StoredConnection): Promise<ExasolDriver> {
        await this.validateFingerprint(connection);
        const wsErrors: { lastError?: Error } = {};
        const driver = new ExasolDriver(this.createWebSocketFactory(connection, wsErrors), {
            host: connection.host,
            port: connection.port,
            user: connection.user,
            password: connection.password,
            encryption: true
        });

        try {
            await withTimeout(
                driver.connect(),
                CONNECTION_TIMEOUT_MS,
                `Connection to ${connection.host}:${connection.port} timed out after ${CONNECTION_TIMEOUT_MS / 1000}s`
            );
        } catch (error) {
            const wsMsg = wsErrors.lastError ? formatError(wsErrors.lastError) : '';
            const driverMsg = formatError(error);
            throw new Error(`Connection failed: ${wsMsg || driverMsg}`);
        }
        return driver;
    }

    private async testConnection(connection: StoredConnection): Promise<void> {
        // Validate fingerprint before attempting the full connection
        await this.validateFingerprint(connection);

        const outputChannel = getOutputChannel();
        outputChannel.appendLine(`   Creating driver for ${connection.host}:${connection.port}`);
        outputChannel.appendLine(`   User: ${connection.user}`);
        outputChannel.appendLine(`   TLS mode: ${connection.tlsMode || 'off'}`);

        const wsErrors: { lastError?: Error } = {};
        const driver = new ExasolDriver(this.createWebSocketFactory(connection, wsErrors), {
            host: connection.host,
            port: connection.port,
            user: connection.user,
            password: connection.password,
            encryption: true
        });

        try {
            outputChannel.appendLine(`   Attempting to connect...`);
            await withTimeout(
                driver.connect(),
                CONNECTION_TIMEOUT_MS,
                `Connection to ${connection.host}:${connection.port} timed out after ${CONNECTION_TIMEOUT_MS / 1000}s`
            );
            outputChannel.appendLine(`   Connection successful, closing test connection`);
            await driver.close();
        } catch (error) {
            const wsMsg = wsErrors.lastError ? formatError(wsErrors.lastError) : '';
            const driverMsg = formatError(error);
            outputChannel.appendLine(`   Connection failed: ${driverMsg}`);
            if (wsMsg) {
                outputChannel.appendLine(`   Original WebSocket error: ${wsMsg}`);
            }
            // Re-throw fingerprint errors directly so callers can handle TOFU
            const fpError = extractFingerprintError(error);
            if (fpError) {
                throw fpError;
            }
            throw new Error(`Connection failed: ${wsMsg || driverMsg}`);
        }
    }

    async closeAll(): Promise<void> {
        for (const driver of this.drivers.values()) {
            await driver.close();
        }
        this.drivers.clear();
        this.recentFailures.clear();
        this.lastSuccessfulQuery.clear();
    }
}
