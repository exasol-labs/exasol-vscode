import * as vscode from 'vscode';
import { ConnectionManager, StoredConnection } from '../connectionManager';
import { getOutputChannel } from '../extension';
import { getRowsFromResult } from '../utils';

type ObjectNode = ObjectTreeItem | ObjectMessageItem;

export class ObjectTreeProvider implements vscode.TreeDataProvider<ObjectNode>, vscode.TreeDragAndDropController<ObjectNode> {
    private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ObjectNode | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ObjectNode | undefined | null | void> =
        this.onDidChangeTreeDataEmitter.event;

    // Drag and drop support
    readonly dropMimeTypes: readonly string[] = [];
    readonly dragMimeTypes: readonly string[] = ['text/uri-list', 'text/plain'];

    constructor(private readonly connectionManager: ConnectionManager) {}

    // Handle drag operation
    async handleDrag(source: readonly ObjectNode[], dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
        const items = source.filter((item): item is ObjectTreeItem => item instanceof ObjectTreeItem);

        if (items.length === 0) {
            return;
        }

        // Get the qualified text for each item
        const texts = items
            .map(item => this.getQualifiedName(item))
            .filter((text): text is string => !!text);

        if (texts.length === 0) {
            return;
        }

        // Join multiple items with comma and newline for readability
        const dragText = texts.length === 1 ? texts[0] : texts.join(',\n    ');

        // Set as plain text for drag-and-drop
        dataTransfer.set('text/plain', new vscode.DataTransferItem(dragText));
    }

    private getQualifiedName(item: ObjectTreeItem): string | undefined {
        switch (item.type) {
            case 'schema':
                return item.schemaName ? `"${item.schemaName}"` : undefined;
            case 'table':
            case 'view':
                return item.schemaName && item.tableInfo
                    ? `"${item.schemaName}"."${item.tableInfo.name}"`
                    : undefined;
            case 'column':
                return item.columnInfo ? `"${item.columnInfo.name}"` : undefined;
            default:
                return undefined;
        }
    }

    // We don't support drop operations
    async handleDrop(target: ObjectNode | undefined, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
        // Not implemented - we only support dragging out, not dropping in
    }

    refresh(): void {
        this.onDidChangeTreeDataEmitter.fire();
    }

    getTreeItem(element: ObjectNode): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: ObjectNode): Promise<ObjectNode[]> {
        const outputChannel = getOutputChannel();

        if (!element) {
            const activeConnection = this.connectionManager.getActiveConnection();
            if (!activeConnection) {
                outputChannel?.appendLine('📂 Objects view: No active connection');
                return [
                    new ObjectMessageItem(
                        'No active connection',
                        'Select a connection from the Connections view to browse objects.'
                    )
                ];
            }

            // Directly show schemas without the connection node
            try {
                outputChannel?.appendLine(`📂 Objects view: Fetching schemas for active connection '${activeConnection.name}'`);
                const schemas = await this.fetchSchemas(activeConnection);
                outputChannel?.appendLine(`📂 Objects view: Found ${schemas.length} schemas`);
                return schemas.map(schema => {
                    const id = `${activeConnection.id}:${schema.name}`;
                    return new ObjectTreeItem(
                        schema.name,
                        id,
                        vscode.TreeItemCollapsibleState.Collapsed,
                        'schema',
                        activeConnection,
                        schema.name
                    );
                });
            } catch (error) {
                const message = `Failed to fetch schemas: ${error}`;
                outputChannel?.appendLine(`❌ Objects view: ${message}`);
                vscode.window.showErrorMessage(message);
                return [];
            }
        }

        if (element instanceof ObjectMessageItem) {
            return [];
        }

        if (element.type === 'schema') {
            return [
                new ObjectTreeItem(
                    'Tables',
                    `${element.connection!.id}:${element.schemaName}:tables-folder`,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'tables-folder',
                    element.connection,
                    element.schemaName
                ),
                new ObjectTreeItem(
                    'Views',
                    `${element.connection!.id}:${element.schemaName}:views-folder`,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'views-folder',
                    element.connection,
                    element.schemaName
                )
            ];
        }

        if (element.type === 'tables-folder') {
            try {
                outputChannel?.appendLine(`📋 Objects view: Fetching tables for '${element.schemaName}'`);
                const tables = await this.fetchTables(element.connection!, element.schemaName!);
                outputChannel?.appendLine(`📋 Objects view: Found ${tables.length} tables`);
                return tables.map(table => {
                    const id = `${element.connection!.id}:${element.schemaName}:${table.name}:table`;
                    return new ObjectTreeItem(
                        table.name,
                        id,
                        vscode.TreeItemCollapsibleState.Collapsed,
                        'table',
                        element.connection,
                        element.schemaName,
                        table
                    );
                });
            } catch (error) {
                const message = `Failed to fetch tables: ${error}`;
                outputChannel?.appendLine(`❌ Objects view: ${message}`);
                vscode.window.showErrorMessage(message);
                return [];
            }
        }

        if (element.type === 'views-folder') {
            try {
                outputChannel?.appendLine(`👁️ Objects view: Fetching views for '${element.schemaName}'`);
                const views = await this.fetchViews(element.connection!, element.schemaName!);
                outputChannel?.appendLine(`👁️ Objects view: Found ${views.length} views`);
                return views.map(view => {
                    const id = `${element.connection!.id}:${element.schemaName}:${view.name}:view`;
                    return new ObjectTreeItem(
                        view.name,
                        id,
                        vscode.TreeItemCollapsibleState.Collapsed,
                        'view',
                        element.connection,
                        element.schemaName,
                        view
                    );
                });
            } catch (error) {
                const message = `Failed to fetch views: ${error}`;
                outputChannel?.appendLine(`❌ Objects view: ${message}`);
                vscode.window.showErrorMessage(message);
                return [];
            }
        }

        if (element.type === 'table' || element.type === 'view') {
            try {
                outputChannel?.appendLine(
                    `📊 Objects view: Fetching columns for ${element.type} '${element.tableInfo!.name}'`
                );
                const columns = await this.fetchColumns(
                    element.connection!,
                    element.schemaName!,
                    element.tableInfo!.name
                );
                outputChannel?.appendLine(`📊 Objects view: Found ${columns.length} columns`);
                return columns.map(col => {
                    const id = `${element.connection!.id}:${element.schemaName}:${element.tableInfo!.name}:${col.name}:column`;
                    return new ObjectTreeItem(
                        `${col.name} (${col.type})`,
                        id,
                        vscode.TreeItemCollapsibleState.None,
                        'column',
                        element.connection,
                        element.schemaName,
                        undefined,
                        col
                    );
                });
            } catch (error) {
                const message = `Failed to fetch columns: ${error}`;
                outputChannel?.appendLine(`❌ Objects view: ${message}`);
                vscode.window.showErrorMessage(message);
                return [];
            }
        }

        return [];
    }

    private async fetchSchemas(connection: StoredConnection): Promise<Array<{ name: string }>> {
        const outputChannel = getOutputChannel();
        try {
            outputChannel?.appendLine(`   Getting driver for connection ID: ${connection.id}`);
            const driver = await this.connectionManager.getDriver(connection.id);
            outputChannel?.appendLine(`   Driver obtained, running schema query...`);
            const result = await driver.query(`
                SELECT SCHEMA_NAME
                FROM SYS.EXA_SCHEMAS
                WHERE SCHEMA_NAME NOT IN ('SYS', 'EXA_STATISTICS')
                ORDER BY SCHEMA_NAME
            `);
            const rows = getRowsFromResult(result);
            outputChannel?.appendLine(`   Schema query returned ${rows.length} rows`);
            return rows.map((row: any) => ({ name: row.SCHEMA_NAME }));
        } catch (error) {
            outputChannel?.appendLine(`   Error fetching schemas: ${error}`);
            throw new Error(`Failed to fetch schemas: ${error}`);
        }
    }

    private async fetchTables(
        connection: StoredConnection,
        schemaName: string
    ): Promise<Array<{ name: string; rowCount?: number }>> {
        const outputChannel = getOutputChannel();
        try {
            const driver = await this.connectionManager.getDriver(connection.id);
            const attempts: Array<{
                description: string;
                sql: string;
                map: (rows: any[]) => Array<{ name: string; rowCount?: number }>;
                isRecoverable: (error: unknown) => boolean;
            }> = [
                {
                    description: 'tables with row counts from EXA_ALL_TABLES',
                    sql: `
                        SELECT
                            TABLE_NAME,
                            TABLE_ROW_COUNT
                        FROM SYS.EXA_ALL_TABLES
                        WHERE TABLE_SCHEMA = '${schemaName}'
                        ORDER BY TABLE_NAME
                    `,
                    map: rows => rows.map((row: any) => ({
                        name: row.TABLE_NAME,
                        rowCount: this.parseRowCount(row.TABLE_ROW_COUNT)
                    })),
                    isRecoverable: error =>
                        this.isColumnMissingError(error, 'TABLE_ROW_COUNT') ||
                        this.isColumnMissingError(error, 'EXA_ALL_TABLES')
                },
                {
                    description: 'tables without row counts from EXA_ALL_TABLES',
                    sql: `
                        SELECT TABLE_NAME
                        FROM SYS.EXA_ALL_TABLES
                        WHERE TABLE_SCHEMA = '${schemaName}'
                        ORDER BY TABLE_NAME
                    `,
                    map: rows => rows.map((row: any) => ({
                        name: row.TABLE_NAME
                    })),
                    isRecoverable: error =>
                        this.isColumnMissingError(error, 'EXA_ALL_TABLES') ||
                        this.isColumnMissingError(error, 'TABLE_NAME')
                },
                {
                    description: 'tables from EXA_ALL_OBJECTS',
                    sql: `
                        SELECT OBJECT_NAME AS TABLE_NAME
                        FROM SYS.EXA_ALL_OBJECTS
                        WHERE OBJECT_SCHEMA = '${schemaName}'
                        AND OBJECT_TYPE = 'TABLE'
                        ORDER BY OBJECT_NAME
                    `,
                    map: rows => rows.map((row: any) => ({
                        name: row.TABLE_NAME ?? row.OBJECT_NAME
                    })),
                    isRecoverable: error =>
                        this.isColumnMissingError(error, 'EXA_ALL_OBJECTS') ||
                        this.isColumnMissingError(error, 'OBJECT_TYPE')
                },
                {
                    description: 'tables from EXA_ALL_COLUMNS fallback',
                    sql: `
                        SELECT DISTINCT COLUMN_TABLE AS TABLE_NAME
                        FROM SYS.EXA_ALL_COLUMNS
                        WHERE COLUMN_SCHEMA = '${schemaName}'
                        AND (COLUMN_OBJECT_TYPE = 'TABLE' OR COLUMN_OBJECT_TYPE IS NULL)
                        ORDER BY COLUMN_TABLE
                    `,
                    map: rows => rows.map((row: any) => ({
                        name: row.TABLE_NAME ?? row.COLUMN_TABLE
                    })),
                    isRecoverable: () => false
                }
            ];

            let lastError: unknown = undefined;

            for (const attempt of attempts) {
                outputChannel?.appendLine(`   Running tables query (${attempt.description}) for '${schemaName}'`);
                try {
                    const result = await driver.query(attempt.sql, undefined, undefined, 'raw');
                    const rows = getRowsFromResult(result);
                    outputChannel?.appendLine(`   ${attempt.description} returned ${rows.length} rows`);
                    return attempt.map(rows);
                } catch (error) {
                    lastError = error;
                    if (attempt.isRecoverable(error)) {
                        outputChannel?.appendLine(
                            `   Tables query failed due to missing metadata (${error}). Trying fallback...`
                        );
                        continue;
                    }

                    throw error;
                }
            }

            throw lastError ?? new Error('Unknown error fetching tables');
        } catch (error) {
            outputChannel?.appendLine(`   Error in fetchTables: ${error}`);
            throw new Error(`Failed to fetch tables: ${error}`);
        }
    }

    private async fetchViews(connection: StoredConnection, schemaName: string): Promise<Array<{ name: string }>> {
        const outputChannel = getOutputChannel();
        try {
            outputChannel?.appendLine(`   Running views query for schema '${schemaName}'`);
            const driver = await this.connectionManager.getDriver(connection.id);

            const attempts: Array<{
                description: string;
                sql: string;
                map: (rows: any[]) => Array<{ name: string }>;
                recoverable: (error: unknown) => boolean;
            }> = [
                {
                    description: 'views from EXA_ALL_VIEWS',
                    sql: `
                        SELECT TABLE_NAME AS VIEW_NAME
                        FROM SYS.EXA_ALL_VIEWS
                        WHERE VIEW_SCHEMA = '${schemaName}'
                        ORDER BY TABLE_NAME
                    `,
                    map: rows => rows.map((row: any) => ({ name: row.VIEW_NAME ?? row.TABLE_NAME })),
                    recoverable: error =>
                        this.isColumnMissingError(error, 'TABLE_NAME') ||
                        this.isColumnMissingError(error, 'VIEW_SCHEMA') ||
                        this.isRawDataError(error)
                },
                {
                    description: 'views from EXA_ALL_OBJECTS',
                    sql: `
                        SELECT
                            OBJECT_NAME AS VIEW_NAME
                        FROM SYS.EXA_ALL_OBJECTS
                        WHERE OBJECT_SCHEMA = '${schemaName}'
                        AND OBJECT_TYPE = 'VIEW'
                        ORDER BY OBJECT_NAME
                    `,
                    map: rows => rows.map((row: any) => ({ name: row.VIEW_NAME ?? row.OBJECT_NAME })),
                    recoverable: error =>
                        this.isColumnMissingError(error, 'OBJECT_NAME') ||
                        this.isColumnMissingError(error, 'OBJECT_SCHEMA') ||
                        this.isColumnMissingError(error, 'OBJECT_TYPE') ||
                        this.isRawDataError(error)
                },
                {
                    description: 'views from EXA_ALL_COLUMNS',
                    sql: `
                        SELECT DISTINCT
                            COLUMN_TABLE AS VIEW_NAME
                        FROM SYS.EXA_ALL_COLUMNS
                        WHERE COLUMN_SCHEMA = '${schemaName}'
                        AND (
                            COLUMN_OBJECT_TYPE IS NULL OR
                            COLUMN_OBJECT_TYPE = 'VIEW' OR
                            COLUMN_OBJECT_TYPE = 'VIRTUAL TABLE'
                        )
                        ORDER BY COLUMN_TABLE
                    `,
                    map: rows => rows.map((row: any) => ({ name: row.VIEW_NAME ?? row.COLUMN_TABLE })),
                    recoverable: () => false
                }
            ];

            let lastError: unknown = undefined;

            for (const attempt of attempts) {
                outputChannel?.appendLine(`   Running views query (${attempt.description}) for schema '${schemaName}'`);
                try {
                    const rawResult = await driver.query(attempt.sql, undefined, undefined, 'raw');
                    const validated = this.getRawResultOrThrow(rawResult);
                    const rows = getRowsFromResult(validated);
                    outputChannel?.appendLine(`   ${attempt.description} returned ${rows.length} rows`);
                    return attempt.map(rows);
                } catch (error) {
                    lastError = error;
                    if (attempt.recoverable(error)) {
                        outputChannel?.appendLine(
                            `   Views query failed (${error}). Trying next fallback...`
                        );
                        continue;
                    }

                    throw error;
                }
            }

            throw lastError ?? new Error('Unknown error fetching views');
        } catch (error) {
            outputChannel?.appendLine(`   Error in fetchViews: ${error}`);
            outputChannel?.appendLine(`   Error stack: ${(error as Error).stack}`);
            throw new Error(`Failed to fetch views: ${error}`);
        }
    }

    private async fetchColumns(
        connection: StoredConnection,
        schemaName: string,
        tableName: string
    ): Promise<Array<{ name: string; type: string; nullable: boolean }>> {
        try {
            const driver = await this.connectionManager.getDriver(connection.id);
            const result = await driver.query(`
                SELECT
                    COLUMN_NAME,
                    COLUMN_TYPE,
                    COLUMN_IS_NULLABLE
                FROM SYS.EXA_ALL_COLUMNS
                WHERE COLUMN_SCHEMA = '${schemaName}'
                AND COLUMN_TABLE = '${tableName}'
                ORDER BY COLUMN_ORDINAL_POSITION
            `);
            const rows = getRowsFromResult(result);
            return rows.map((row: any) => ({
                name: row.COLUMN_NAME,
                type: row.COLUMN_TYPE,
                nullable: row.COLUMN_IS_NULLABLE
            }));
        } catch (error) {
            throw new Error(`Failed to fetch columns: ${error}`);
        }
    }

    private parseRowCount(rowCount: unknown): number | undefined {
        if (rowCount === null || rowCount === undefined) {
            return undefined;
        }

        if (typeof rowCount === 'number') {
            return Number.isFinite(rowCount) ? rowCount : undefined;
        }

        const parsed = Number(rowCount);
        return Number.isFinite(parsed) ? parsed : undefined;
    }

    private isColumnMissingError(error: unknown, columnOrTableName: string): boolean {
        const message = (error instanceof Error ? error.message : String(error ?? '')).toUpperCase();
        const searchTerm = columnOrTableName.toUpperCase();
        return message.includes(searchTerm) &&
            (message.includes('NOT FOUND') || message.includes('INVALID') || message.includes('OBJECT'));
    }

    private isRawDataError(error: unknown): boolean {
        const message = (error instanceof Error ? error.message : String(error ?? '')).toUpperCase();
        return message.includes('NUMRESULTS') || error instanceof TypeError;
    }

    private getRawResultOrThrow(result: any): any {
        if (!result) {
            throw new Error('Empty result set');
        }

        if (typeof result.status === 'string' && result.status !== 'ok') {
            const message = result.exception?.text || 'Unknown error';
            throw new Error(message);
        }

        if (!result.responseData || typeof result.responseData.numResults !== 'number') {
            throw new Error('Unexpected result format: missing numResults');
        }

        return result;
    }
}

class ObjectTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly id: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly type: 'schema' | 'tables-folder' | 'table' | 'views-folder' | 'view' | 'column',
        public readonly connection?: StoredConnection,
        public readonly schemaName?: string,
        public readonly tableInfo?: { name: string; rowCount?: number },
        public readonly columnInfo?: { name: string; type: string; nullable: boolean }
    ) {
        super(label, collapsibleState);
        this.id = id;

        switch (type) {
            case 'schema':
                this.iconPath = new vscode.ThemeIcon('symbol-namespace');
                this.contextValue = 'schema';
                break;
            case 'tables-folder':
                this.iconPath = new vscode.ThemeIcon('folder');
                this.contextValue = 'tables-folder';
                break;
            case 'table':
                this.iconPath = new vscode.ThemeIcon('table');
                this.contextValue = 'table';
                if (tableInfo?.rowCount !== undefined) {
                    this.description = `${tableInfo.rowCount.toLocaleString()} rows`;
                }
                this.command = {
                    command: 'exasol.openObject',
                    title: 'Open Table',
                    arguments: [this]
                };
                break;
            case 'views-folder':
                this.iconPath = new vscode.ThemeIcon('folder');
                this.contextValue = 'views-folder';
                break;
            case 'view':
                this.iconPath = new vscode.ThemeIcon('eye');
                this.contextValue = 'view';
                this.command = {
                    command: 'exasol.openObject',
                    title: 'Open View',
                    arguments: [this]
                };
                break;
            case 'column':
                this.iconPath = new vscode.ThemeIcon('symbol-field');
                this.contextValue = 'column';
                if (columnInfo) {
                    this.tooltip = `${columnInfo.name}: ${columnInfo.type}${columnInfo.nullable ? ' (nullable)' : ''}`;
                }
                break;
        }
    }
}

class ObjectMessageItem extends vscode.TreeItem {
    constructor(label: string, tooltip?: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('info');
        this.contextValue = 'info';
        this.tooltip = tooltip;
    }
}
