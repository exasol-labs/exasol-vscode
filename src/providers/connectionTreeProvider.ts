import * as vscode from 'vscode';
import { ConnectionManager, StoredConnection } from '../connectionManager';
import { getOutputChannel } from '../extension';

export class ConnectionTreeProvider implements vscode.TreeDataProvider<ConnectionItem> {
    private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ConnectionItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ConnectionItem | undefined | null | void> =
        this.onDidChangeTreeDataEmitter.event;

    constructor(private readonly connectionManager: ConnectionManager) {}

    refresh(): void {
        this.onDidChangeTreeDataEmitter.fire();
    }

    getTreeItem(element: ConnectionItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: ConnectionItem): Promise<ConnectionItem[]> {
        if (element) {
            return [];
        }

        const outputChannel = getOutputChannel();
        const connections = this.connectionManager.getConnections();
        const activeId = this.connectionManager.getActiveConnection()?.id;

        outputChannel?.appendLine(`🔌 Connections view: Showing ${connections.length} connections`);

        return connections.map(conn => new ConnectionItem(conn, conn.id === activeId));
    }
}

export class ConnectionItem extends vscode.TreeItem {
    constructor(
        public readonly connection: StoredConnection,
        public readonly isActive: boolean
    ) {
        super(connection.name, vscode.TreeItemCollapsibleState.None);

        this.id = connection.id;
        this.contextValue = 'connection';

        // Use checkmark icon for active connection
        if (isActive) {
            this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('terminal.ansiGreen'));
        } else {
            this.iconPath = new vscode.ThemeIcon('database');
        }

        this.description = isActive && connection.host
            ? `${connection.host} • active`
            : connection.host ?? '';
        this.tooltip = connection.host
            ? `${connection.name}\n${connection.host}${isActive ? '\nActive connection' : ''}`
            : `${connection.name}${isActive ? '\nActive connection' : ''}`;
        this.command = {
            command: 'exasol.setActiveConnection',
            title: 'Set Active Connection',
            arguments: [this]
        };
    }
}
