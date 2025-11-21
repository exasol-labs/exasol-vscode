import * as vscode from 'vscode';
import { ExasolDriver, ExaWebsocket } from '@exasol/exasol-driver-ts';
import { WebSocket } from 'ws';
import { getOutputChannel } from './extension';

export interface ExasolConnection {
    name: string;
    host: string;
    user: string;
    password: string;
    database?: string;
    schema?: string;
}

export interface StoredConnection extends ExasolConnection {
    id: string;
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

    private async createDriver(connection: StoredConnection): Promise<ExasolDriver> {
        const [host, portStr] = connection.host.split(':');
        const port = portStr ? parseInt(portStr) : 8563;

        const driver = new ExasolDriver((url: string) => {
            // For self-signed certificates (common in local/dev environments)
            return new WebSocket(url, {
                rejectUnauthorized: false
            }) as ExaWebsocket;
        }, {
            host,
            port,
            user: connection.user,
            password: connection.password,
            encryption: true  // Enable TLS encryption
        });

        await driver.connect();
        return driver;
    }

    private async testConnection(connection: StoredConnection): Promise<void> {
        const [host, portStr] = connection.host.split(':');
        const port = portStr ? parseInt(portStr) : 8563;

        const outputChannel = getOutputChannel();
        outputChannel.appendLine(`   Creating driver for ${host}:${port}`);
        outputChannel.appendLine(`   User: ${connection.user}`);

        const driver = new ExasolDriver((url: string) => {
            outputChannel.appendLine(`   WebSocket URL: ${url}`);
            // For self-signed certificates (common in local/dev environments)
            return new WebSocket(url, {
                rejectUnauthorized: false
            }) as ExaWebsocket;
        }, {
            host,
            port,
            user: connection.user,
            password: connection.password,
            encryption: true  // Enable TLS encryption
        });

        try {
            outputChannel.appendLine(`   Attempting to connect...`);
            await driver.connect();
            outputChannel.appendLine(`   Connection successful, closing test connection`);
            await driver.close();
        } catch (error) {
            outputChannel.appendLine(`   Connection failed: ${error}`);
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
