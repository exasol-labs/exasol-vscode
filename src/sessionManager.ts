import * as vscode from 'vscode';
import { ConnectionManager, BACKGROUND_QUERY_TIMEOUT_MS } from './connectionManager';
import { executeWithoutResult, getRowsFromResult, rawQuery } from './utils';
import { getOutputChannel } from './extension';

export class SessionManager {
    private currentSchema: string | undefined;
    private _onDidChangeSession: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    readonly onDidChangeSession: vscode.Event<void> = this._onDidChangeSession.event;

    constructor(
        private connectionManager: ConnectionManager,
        private context: vscode.ExtensionContext
    ) {
        this.loadSession();
    }

    private loadSession() {
        const activeConnection = this.connectionManager.getActiveConnection();
        if (activeConnection) {
            this.currentSchema = this.context.workspaceState.get(`exasol.session.${activeConnection.id}.schema`);
        }
    }

    private async saveSession() {
        const activeConnection = this.connectionManager.getActiveConnection();
        if (activeConnection && this.currentSchema) {
            await this.context.workspaceState.update(
                `exasol.session.${activeConnection.id}.schema`,
                this.currentSchema
            );
        }
    }

    async setSchema(schemaName: string): Promise<void> {
        const activeConnection = this.connectionManager.getActiveConnection();
        if (!activeConnection) {
            throw new Error('No active connection');
        }

        try {
            // Open schema on both connections so user queries and background operations
            // (tree, completions) both see the correct schema context
            await Promise.all([
                this.connectionManager.executeWithRetry(async () => {
                    const driver = await this.connectionManager.getDriver();
                    await executeWithoutResult(driver, `OPEN SCHEMA ${schemaName}`);
                }),
                this.connectionManager.executeWithRetry(async () => {
                    const driver = await this.connectionManager.getDriver(undefined, 'background');
                    await executeWithoutResult(driver, `OPEN SCHEMA ${schemaName}`);
                }, undefined, { timeoutMs: BACKGROUND_QUERY_TIMEOUT_MS, role: 'background' }),
            ]);
            this.currentSchema = schemaName;
            await this.saveSession();
            this._onDidChangeSession.fire();
            vscode.window.showInformationMessage(`Schema set to: ${schemaName}`);
        } catch (error) {
            throw new Error(`Failed to set schema: ${error}`);
        }
    }

    getCurrentSchema(): string | undefined {
        return this.currentSchema;
    }

    async refreshSession(): Promise<void> {
        const activeConnection = this.connectionManager.getActiveConnection();
        if (!activeConnection) {
            this.currentSchema = undefined;
            return;
        }

        try {
            const rows = await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(undefined, 'background');
                const result = await rawQuery(driver, 'SELECT CURRENT_SCHEMA');
                return getRowsFromResult(result);
            }, undefined, { timeoutMs: BACKGROUND_QUERY_TIMEOUT_MS, role: 'background' });
            if (rows.length > 0) {
                this.currentSchema = rows[0].CURRENT_SCHEMA;
                await this.saveSession();
                this._onDidChangeSession.fire();
            }
        } catch (error) {
            getOutputChannel()?.appendLine(`Failed to refresh session: ${error}`);
        }
    }

    async clearSession(): Promise<void> {
        this.currentSchema = undefined;
        const activeConnection = this.connectionManager.getActiveConnection();
        if (activeConnection) {
            await this.context.workspaceState.update(
                `exasol.session.${activeConnection.id}.schema`,
                undefined
            );
        }
        this._onDidChangeSession.fire();
    }

    getStatusBarText(): string {
        const activeConnection = this.connectionManager.getActiveConnection();
        if (!activeConnection) {
            return 'Exasol: No connection';
        }
        const schemaSuffix = this.currentSchema ? ` | Schema: ${this.currentSchema}` : '';
        return `Exasol: ${activeConnection.name}${schemaSuffix}`;
    }
}
