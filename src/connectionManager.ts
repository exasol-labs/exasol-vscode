import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as tls from 'tls';
import { ExasolDriver, ExaWebsocket, CsvFormatOptions } from '@exasol/exasol-driver-ts';
import { WebSocket } from 'ws';
import { getOutputChannel } from './extension';
import { getRowsFromResult } from './utils';

export type TlsMode = 'off' | 'fingerprint' | 'full';

export interface ExasolConnection {
    name: string;
    host: string;
    user: string;
    password: string;
    database?: string;
    schema?: string;
    tlsMode?: TlsMode;
    fingerprint?: string;
}

/**
 * Custom error thrown when a fingerprint-mode connection has no stored fingerprint.
 * Contains the server's fingerprint so the caller can prompt the user (TOFU).
 */
export class FingerprintRequiredError extends Error {
    constructor(public readonly serverFingerprint: string) {
        super(`Server fingerprint not yet accepted: ${serverFingerprint}`);
        this.name = 'FingerprintRequiredError';
    }
}

/**
 * Custom error thrown when the server's fingerprint doesn't match the stored one.
 */
export class FingerprintMismatchError extends Error {
    constructor(
        public readonly storedFingerprint: string,
        public readonly serverFingerprint: string
    ) {
        super(`Server certificate fingerprint has changed: stored=${storedFingerprint} server=${serverFingerprint}`);
        this.name = 'FingerprintMismatchError';
    }
}

/**
 * Normalize a fingerprint: strip colons/spaces, uppercase.
 */
export function normalizeFingerprint(fp: string): string {
    return fp.replace(/[:\s]/g, '').toUpperCase();
}

export interface StoredConnection extends ExasolConnection {
    id: string;
}

function quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

export class ConnectionManager {
    private connections: Map<string, StoredConnection> = new Map();
    private activeConnection: string | null = null;
    private drivers: Map<string, ExasolDriver> = new Map();
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
        for (const conn of stored) {
            // Load password from secure storage
            const password = await this.context.secrets.get(`exasol.password.${conn.id}`);
            if (password) {
                this.connections.set(conn.id, {
                    ...conn,
                    password
                });
            }
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

        // Check if we have an existing driver
        if (this.drivers.has(id)) {
            const driver = this.drivers.get(id)!;

            // Validate the connection is still alive
            const isValid = await this.validateDriver(driver, id);
            if (isValid) {
                return driver;
            }

            // Connection is stale, remove it and create a new one
            const outputChannel = getOutputChannel();
            outputChannel.appendLine(`Connection ${connection.name} appears stale, reconnecting...`);
            this.drivers.delete(id);
        }

        // Create new driver
        const driver = await this.createDriver(connection);
        this.drivers.set(id, driver);
        return driver;
    }

    async resetDriver(connectionId?: string): Promise<void> {
        const id = connectionId || this.activeConnection;
        if (!id) {
            return;
        }

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
        if (ConnectionManager.extractFingerprintError(error)) {
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
        try {
            return await fn();
        } catch (error) {
            // Check if it's a connection-related error that requires reconnection
            if (this.isConnectionError(error)) {
                const id = connectionId || this.activeConnection;
                if (id) {
                    const outputChannel = getOutputChannel();
                    outputChannel.appendLine(`Connection error detected, resetting driver and retrying...`);

                    // Reset driver and retry once
                    await this.resetDriver(id);

                    // Wait a bit for the connection to stabilize
                    await new Promise(resolve => setTimeout(resolve, 100));

                    return await fn();
                }
            }
            throw error;
        }
    }

    /**
     * Import a CSV file into a new table with VARCHAR columns.
     * Creates the table, streams data via importFromFile, and cleans up on failure.
     */
    async importCsvFile(
        connectionId: string,
        schema: string,
        tableName: string,
        filePath: string,
        columnNames: string[],
        csvOptions?: CsvFormatOptions
    ): Promise<number> {
        const qualifiedTable = `${quoteIdentifier(schema)}.${quoteIdentifier(tableName)}`;
        const outputChannel = getOutputChannel();

        return await this.executeWithRetry(async () => {
            const driver = await this.getDriver(connectionId);

            const columnDefs = columnNames
                .map(col => `${quoteIdentifier(col)} VARCHAR(2000000)`)
                .join(', ');

            // DROP IF EXISTS makes the retry idempotent if a previous attempt created the table
            await driver.execute(`DROP TABLE IF EXISTS ${qualifiedTable}`);
            await driver.execute(`CREATE TABLE ${qualifiedTable} (${columnDefs})`);

            try {
                const rowCount = await driver.importFromFile(
                    qualifiedTable,
                    filePath,
                    { skip: 1, ...csvOptions }
                );
                outputChannel.appendLine(`Imported ${rowCount} rows into ${qualifiedTable}`);
                return rowCount;
            } catch (importError) {
                outputChannel.appendLine(`Import failed, dropping table ${qualifiedTable}: ${importError}`);
                try {
                    await driver.execute(`DROP TABLE ${qualifiedTable}`);
                    outputChannel.appendLine(`Cleaned up table ${qualifiedTable}`);
                } catch (dropError) {
                    outputChannel.appendLine(`Failed to drop table during cleanup: ${dropError}`);
                }
                throw importError;
            }
        }, connectionId);
    }

    /**
     * Check whether a table exists in the given schema.
     */
    async tableExists(connectionId: string, schema: string, tableName: string): Promise<boolean> {
        return await this.executeWithRetry(async () => {
            const driver = await this.getDriver(connectionId);
            const safeSchema = schema.replace(/'/g, "''");
            const safeTableName = tableName.replace(/'/g, "''");
            const result = await driver.query(`
                SELECT COUNT(*) AS TABLE_COUNT
                FROM SYS.EXA_ALL_TABLES
                WHERE TABLE_SCHEMA = '${safeSchema}'
                AND TABLE_NAME = '${safeTableName}'
            `);
            const rows = getRowsFromResult(result);
            if (rows.length === 0) {
                return false;
            }
            const count = Number(rows[0].TABLE_COUNT);
            return count > 0;
        }, connectionId);
    }

    /**
     * Fetch all non-system schema names for the given connection.
     */
    async fetchSchemaNames(connectionId: string): Promise<string[]> {
        return await this.executeWithRetry(async () => {
            const driver = await this.getDriver(connectionId);
            const result = await driver.query(`
                SELECT SCHEMA_NAME
                FROM SYS.EXA_SCHEMAS
                WHERE SCHEMA_NAME NOT IN ('SYS', 'EXA_STATISTICS')
                ORDER BY SCHEMA_NAME
            `);
            const rows = getRowsFromResult(result);
            return rows.map((row: any) => row.SCHEMA_NAME);
        }, connectionId);
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

    private async validateDriver(driver: ExasolDriver, connectionId: string): Promise<boolean> {
        try {
            // FAST CHECK: First check WebSocket state for instant detection
            if (!this.isWebSocketHealthy(driver)) {
                const outputChannel = getOutputChannel();
                outputChannel.appendLine(`WebSocket is closed or closing - connection is stale`);
                return false;
            }

            const config = vscode.workspace.getConfiguration('exasol');
            const validationTimeout = config.get<number>('connectionValidationTimeout', 1) * 1000; // Convert to milliseconds

            // Run a simple query with a short timeout to check if connection is alive
            const validationPromise = driver.query('SELECT 1');
            const timeoutPromise = new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error('Validation timeout')), validationTimeout);
            });

            await Promise.race([validationPromise, timeoutPromise]);
            return true;
        } catch (error) {
            // Connection is not responsive, consider it stale
            const outputChannel = getOutputChannel();
            outputChannel.appendLine(`Connection validation failed: ${error}`);
            return false;
        }
    }

    /**
     * Extract a FingerprintRequiredError or FingerprintMismatchError from a potentially wrapped error.
     * The TLS/WebSocket layer may wrap our custom errors.
     */
    static extractFingerprintError(error: unknown): FingerprintRequiredError | FingerprintMismatchError | null {
        if (error instanceof FingerprintRequiredError || error instanceof FingerprintMismatchError) {
            return error;
        }
        // Check if the error message contains our custom error markers
        const msg = error instanceof Error ? error.message : String(error);
        const tofuMatch = msg.match(/Server fingerprint not yet accepted: ([A-Fa-f0-9]{64})/);
        if (tofuMatch) {
            return new FingerprintRequiredError(tofuMatch[1].toUpperCase());
        }
        if (msg.includes('Server certificate fingerprint has changed')) {
            // Try to reconstruct from the cause chain first
            const cause = (error as any)?.cause;
            if (cause instanceof FingerprintMismatchError) {
                return cause;
            }
            // Parse fingerprints from the error message
            const mismatchMatch = msg.match(/stored=([A-Fa-f0-9]{64})\s+server=([A-Fa-f0-9]{64})/);
            if (mismatchMatch) {
                return new FingerprintMismatchError(mismatchMatch[1].toUpperCase(), mismatchMatch[2].toUpperCase());
            }
            // Last resort: fingerprints not recoverable
            return new FingerprintMismatchError('unknown', 'unknown');
        }
        return null;
    }

    /**
     * Build a WebSocket factory function that applies TLS settings based on the connection's tlsMode.
     *
     * For "fingerprint" mode, validation is done by testConnection() before
     * the connection is stored, so the factory just uses rejectUnauthorized: false.
     */
    private createWebSocketFactory(connection: StoredConnection): (url: string) => ExaWebsocket {
        const tlsMode = connection.tlsMode || 'off';

        return (url: string) => {
            const rejectUnauthorized = tlsMode === 'full';
            return new WebSocket(url, { rejectUnauthorized }) as ExaWebsocket;
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
            socket.setTimeout(10000, () => {
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

        const [host, portStr] = connection.host.split(':');
        const port = portStr ? parseInt(portStr) : 8563;

        const serverFp = await this.getServerCertificateFingerprint(host, port);
        const storedFp = connection.fingerprint ? normalizeFingerprint(connection.fingerprint) : '';

        if (!storedFp) {
            throw new FingerprintRequiredError(serverFp);
        }
        if (serverFp !== storedFp) {
            throw new FingerprintMismatchError(storedFp, serverFp);
        }
    }

    // Fingerprint validation is performed by testConnection() during add/update,
    // so createDriver() does not re-validate.
    private async createDriver(connection: StoredConnection): Promise<ExasolDriver> {
        const [host, portStr] = connection.host.split(':');
        const port = portStr ? parseInt(portStr) : 8563;

        const driver = new ExasolDriver(this.createWebSocketFactory(connection), {
            host,
            port,
            user: connection.user,
            password: connection.password,
            encryption: true
        });

        await driver.connect();
        return driver;
    }

    private async testConnection(connection: StoredConnection): Promise<void> {
        // Validate fingerprint before attempting the full connection
        await this.validateFingerprint(connection);

        const [host, portStr] = connection.host.split(':');
        const port = portStr ? parseInt(portStr) : 8563;

        const outputChannel = getOutputChannel();
        outputChannel.appendLine(`   Creating driver for ${host}:${port}`);
        outputChannel.appendLine(`   User: ${connection.user}`);
        outputChannel.appendLine(`   TLS mode: ${connection.tlsMode || 'off'}`);

        const driver = new ExasolDriver(this.createWebSocketFactory(connection), {
            host,
            port,
            user: connection.user,
            password: connection.password,
            encryption: true
        });

        try {
            outputChannel.appendLine(`   Attempting to connect...`);
            await driver.connect();
            outputChannel.appendLine(`   Connection successful, closing test connection`);
            await driver.close();
        } catch (error) {
            outputChannel.appendLine(`   Connection failed: ${error}`);
            // Re-throw fingerprint errors directly so callers can handle TOFU
            const fpError = ConnectionManager.extractFingerprintError(error);
            if (fpError) {
                throw fpError;
            }
            throw new Error(`Connection test failed: ${error}`);
        }
    }

    async closeAll(): Promise<void> {
        for (const driver of this.drivers.values()) {
            await driver.close();
        }
        this.drivers.clear();
    }
}
