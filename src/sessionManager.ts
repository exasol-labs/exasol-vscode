import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { executeWithoutResult, getRowsFromResult } from './utils';

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
            const driver = await this.connectionManager.getDriver();
            await executeWithoutResult(driver, `OPEN SCHEMA ${schemaName}`);
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
            const driver = await this.connectionManager.getDriver();
            const result = await driver.query('SELECT CURRENT_SCHEMA');
            const rows = getRowsFromResult(result);
            if (rows.length > 0) {
                this.currentSchema = rows[0].CURRENT_SCHEMA;
                await this.saveSession();
                this._onDidChangeSession.fire();
            }
        } catch (error) {
            console.error('Failed to refresh session:', error);
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

        let text = `Exasol: ${activeConnection.name}`;
        if (this.currentSchema) {
            text += ` | Schema: ${this.currentSchema}`;
        }
        return text;
    }
}
