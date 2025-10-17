import * as vscode from 'vscode';

interface QueryHistoryItem {
    query: string;
    timestamp: number;
    rowCount: number;
    error?: string;
}

export class QueryHistoryProvider implements vscode.TreeDataProvider<QueryHistoryTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<QueryHistoryTreeItem | undefined | null | void> =
        new vscode.EventEmitter<QueryHistoryTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<QueryHistoryTreeItem | undefined | null | void> =
        this._onDidChangeTreeData.event;

    private history: QueryHistoryItem[] = [];
    private maxHistorySize: number = 1000;

    constructor(private context: vscode.ExtensionContext) {
        this.loadHistory();
        const config = vscode.workspace.getConfiguration('exasol');
        this.maxHistorySize = config.get<number>('maxQueryHistorySize', 1000);
    }

    private loadHistory() {
        this.history = this.context.globalState.get<QueryHistoryItem[]>('exasol.queryHistory', []);
    }

    private async saveHistory() {
        await this.context.globalState.update('exasol.queryHistory', this.history);
    }

    addQuery(query: string, rowCount: number, error?: string) {
        const item: QueryHistoryItem = {
            query: query.trim(),
            timestamp: Date.now(),
            rowCount,
            error
        };

        this.history.unshift(item);

        // Trim history to max size
        if (this.history.length > this.maxHistorySize) {
            this.history = this.history.slice(0, this.maxHistorySize);
        }

        this.saveHistory();
        this.refresh();
    }

    clearHistory() {
        this.history = [];
        this.saveHistory();
        this.refresh();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: QueryHistoryTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: QueryHistoryTreeItem): Promise<QueryHistoryTreeItem[]> {
        if (!element) {
            return this.history.map((item, index) => {
                const date = new Date(item.timestamp);
                const label = `${date.toLocaleTimeString()} - ${item.query.substring(0, 50)}${item.query.length > 50 ? '...' : ''}`;
                const description = item.error ? 'Error' : `${item.rowCount} rows`;

                return new QueryHistoryTreeItem(
                    label,
                    description,
                    item.query,
                    item.error !== undefined
                );
            });
        }
        return [];
    }
}

class QueryHistoryTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly description: string,
        public readonly query: string,
        public readonly hasError: boolean
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);

        this.tooltip = query;
        this.iconPath = new vscode.ThemeIcon(hasError ? 'error' : 'pass');
        this.contextValue = 'queryHistoryItem';

        this.command = {
            command: 'exasol.openQueryFromHistory',
            title: 'Open Query',
            arguments: [query]
        };
    }
}
