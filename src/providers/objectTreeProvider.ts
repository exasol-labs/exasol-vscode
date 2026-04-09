import * as vscode from 'vscode';
import { ConnectionManager, StoredConnection, BACKGROUND_QUERY_TIMEOUT_MS } from '../connectionManager';
import { getOutputChannel } from '../extension';
import { getRowsFromResult, escapeSqlString } from '../utils';
import { ObjectTreeItemType, getNodeTypeConfig } from './objectTreeTypes';

export type ObjectNode = ObjectTreeItem | ObjectMessageItem;

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

    getParent(element: ObjectNode): ObjectTreeItem | null {
        if (element instanceof ObjectTreeItem) {
            return element.parent;
        }
        return null;
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
                const [schemas, virtualSchemas] = await Promise.all([
                    this.fetchSchemas(activeConnection),
                    this.fetchVirtualSchemas(activeConnection)
                ]);
                outputChannel?.appendLine(`📂 Objects view: Found ${schemas.length} schemas, ${virtualSchemas.length} virtual schemas`);

                const schemaNodes: ObjectNode[] = schemas.map(schema => {
                    const id = `${activeConnection.id}:${schema.name}`;
                    return new ObjectTreeItem({
                        label: schema.name,
                        id,
                        collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                        type: 'schema',
                        connection: activeConnection,
                        schemaName: schema.name,
                        tableCount: schema.tableCount,
                        viewCount: schema.viewCount
                    });
                });

                const virtualSchemaNodes: ObjectNode[] = virtualSchemas.map(vs => {
                    const id = `${activeConnection.id}:${vs.name}:virtual-schema`;
                    const item = new ObjectTreeItem({
                        label: vs.name,
                        id,
                        collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                        type: 'virtual-schema',
                        connection: activeConnection,
                        schemaName: vs.name
                    });
                    if (vs.adapterName) {
                        item.description = `via ${vs.adapterName}`;
                    }
                    if (vs.lastRefresh || vs.lastRefreshBy) {
                        const parts: string[] = [];
                        if (vs.lastRefresh) {
                            parts.push(`Last refresh: ${vs.lastRefresh}`);
                        }
                        if (vs.lastRefreshBy) {
                            parts.push(`Refreshed by: ${vs.lastRefreshBy}`);
                        }
                        item.tooltip = parts.join('\n');
                    }
                    return item;
                });

                const allNodes = [...schemaNodes, ...virtualSchemaNodes];
                allNodes.sort((a, b) => {
                    const labelA = (a as ObjectTreeItem).label as string;
                    const labelB = (b as ObjectTreeItem).label as string;
                    return labelA.localeCompare(labelB);
                });

                allNodes.push(new ObjectTreeItem({
                    label: 'System Schemas',
                    id: `${activeConnection.id}:system-schemas-folder`,
                    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                    type: 'system-schemas-folder',
                    connection: activeConnection
                }));

                return allNodes;
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
            const connId = element.connection!.id;
            const schema = element.schemaName!;

            const [scriptCounts, functionCount] = await Promise.all([
                this.fetchScriptCounts(element.connection!, schema),
                this.fetchFunctionCount(element.connection!, schema)
            ]);

            const children: ObjectNode[] = [
                new ObjectTreeItem({
                    label: 'Tables',
                    id: `${connId}:${schema}:tables-folder`,
                    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                    type: 'tables-folder',
                    connection: element.connection,
                    schemaName: schema,
                    tableCount: element.tableCount,
                    parent: element
                }),
                new ObjectTreeItem({
                    label: 'Views',
                    id: `${connId}:${schema}:views-folder`,
                    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                    type: 'views-folder',
                    connection: element.connection,
                    schemaName: schema,
                    viewCount: element.viewCount,
                    parent: element
                })
            ];

            const udfCount = scriptCounts.get('UDF') ?? 0;
            if (udfCount > 0) {
                children.push(new ObjectTreeItem({
                    label: 'UDFs',
                    id: `${connId}:${schema}:udfs-folder`,
                    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                    type: 'udfs-folder',
                    connection: element.connection,
                    schemaName: schema,
                    itemCount: udfCount,
                    parent: element
                }));
            }

            const procCount = scriptCounts.get('SCRIPTING') ?? 0;
            if (procCount > 0) {
                children.push(new ObjectTreeItem({
                    label: 'Procedures',
                    id: `${connId}:${schema}:procedures-folder`,
                    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                    type: 'procedures-folder',
                    connection: element.connection,
                    schemaName: schema,
                    itemCount: procCount,
                    parent: element
                }));
            }

            const adapterCount = scriptCounts.get('ADAPTER') ?? 0;
            if (adapterCount > 0) {
                children.push(new ObjectTreeItem({
                    label: 'Adapters',
                    id: `${connId}:${schema}:adapters-folder`,
                    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                    type: 'adapters-folder',
                    connection: element.connection,
                    schemaName: schema,
                    parent: element
                }));
            }

            if (functionCount > 0) {
                children.push(new ObjectTreeItem({
                    label: 'Functions',
                    id: `${connId}:${schema}:functions-folder`,
                    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                    type: 'functions-folder',
                    connection: element.connection,
                    schemaName: schema,
                    itemCount: functionCount,
                    parent: element
                }));
            }

            return children;
        }

        if (element.type === 'tables-folder') {
            try {
                outputChannel?.appendLine(`📋 Objects view: Fetching tables for '${element.schemaName}'`);
                const tables = await this.fetchTables(element.connection!, element.schemaName!);
                outputChannel?.appendLine(`📋 Objects view: Found ${tables.length} tables`);
                return tables.map(table => {
                    const id = `${element.connection!.id}:${element.schemaName}:${table.name}:table`;
                    return new ObjectTreeItem({
                        label: table.name,
                        id,
                        collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                        type: 'table',
                        connection: element.connection,
                        schemaName: element.schemaName,
                        tableInfo: table,
                        parent: element
                    });
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
                    return new ObjectTreeItem({
                        label: view.name,
                        id,
                        collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                        type: 'view',
                        connection: element.connection,
                        schemaName: element.schemaName,
                        tableInfo: view,
                        parent: element
                    });
                });
            } catch (error) {
                const message = `Failed to fetch views: ${error}`;
                outputChannel?.appendLine(`❌ Objects view: ${message}`);
                vscode.window.showErrorMessage(message);
                return [];
            }
        }

        if (element.type === 'udfs-folder') {
            return this.getScriptFolderChildren(element, 'UDF');
        }

        if (element.type === 'procedures-folder') {
            return this.getScriptFolderChildren(element, 'SCRIPTING');
        }

        if (element.type === 'adapters-folder') {
            return this.getScriptFolderChildren(element, 'ADAPTER');
        }

        if (element.type === 'functions-folder') {
            try {
                outputChannel?.appendLine(`Objects view: Fetching functions for '${element.schemaName}'`);
                const functions = await this.fetchFunctions(element.connection!, element.schemaName!);
                outputChannel?.appendLine(`Objects view: Found ${functions.length} functions`);
                return functions.map(fn => new ObjectTreeItem({
                    label: fn.name,
                    id: `${element.connection!.id}:${element.schemaName}:${fn.name}:function`,
                    collapsibleState: vscode.TreeItemCollapsibleState.None,
                    type: 'function',
                    connection: element.connection,
                    schemaName: element.schemaName,
                    functionInfo: fn,
                    parent: element
                }));
            } catch (error) {
                outputChannel?.appendLine(`Failed to fetch functions: ${error}`);
                return [];
            }
        }

        if (element.type === 'constraints-folder') {
            try {
                const constraints = await this.fetchConstraints(
                    element.connection!, element.schemaName!, element.tableInfo!.name
                );
                return constraints.map(c => new ObjectTreeItem({
                    label: c.name,
                    id: `${element.connection!.id}:${element.schemaName}:${element.tableInfo!.name}:${c.name}:constraint`,
                    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                    type: 'constraint',
                    connection: element.connection,
                    schemaName: element.schemaName,
                    tableInfo: element.tableInfo,
                    constraintType: c.type,
                    parent: element
                }));
            } catch (error) {
                outputChannel?.appendLine(`Failed to fetch constraints: ${error}`);
                return [];
            }
        }

        if (element.type === 'indices-folder') {
            try {
                const indices = await this.fetchIndices(
                    element.connection!, element.schemaName!, element.tableInfo!.name
                );
                return indices.map(idx => {
                    const item = new ObjectTreeItem({
                        label: idx.name,
                        id: `${element.connection!.id}:${element.schemaName}:${element.tableInfo!.name}:${idx.name}:index`,
                        collapsibleState: vscode.TreeItemCollapsibleState.None,
                        type: 'index',
                        connection: element.connection,
                        schemaName: element.schemaName,
                        tableInfo: element.tableInfo,
                        parent: element
                    });
                    item.description = idx.columns;
                    return item;
                });
            } catch (error) {
                outputChannel?.appendLine(`Failed to fetch indices: ${error}`);
                return [];
            }
        }

        if (element.type === 'constraint') {
            try {
                const columns = await this.fetchConstraintColumns(
                    element.connection!, element.schemaName!, element.tableInfo!.name, element.label as string
                );
                return columns.map(col => new ObjectTreeItem({
                    label: col.name,
                    id: `${element.connection!.id}:${element.schemaName}:${element.tableInfo!.name}:${element.label}:${col.name}:constraint-column`,
                    collapsibleState: vscode.TreeItemCollapsibleState.None,
                    type: 'column',
                    connection: element.connection,
                    schemaName: element.schemaName,
                    parent: element
                }));
            } catch (error) {
                outputChannel?.appendLine(`Failed to fetch constraint columns: ${error}`);
                return [];
            }
        }

        if (element.type === 'table' || element.type === 'view') {
            const connId = element.connection!.id;
            const schema = element.schemaName!;
            const tableName = element.tableInfo!.name;

            let constraintCount = 0;
            let indexCount = 0;

            try {
                [constraintCount, indexCount] = await Promise.all([
                    this.fetchConstraintCount(element.connection!, schema, tableName),
                    this.fetchIndexCount(element.connection!, schema, tableName)
                ]);
            } catch (error) {
                outputChannel?.appendLine(`Failed to fetch constraint/index counts: ${error}`);
            }

            try {
                outputChannel?.appendLine(
                    `📊 Objects view: Fetching columns for ${element.type} '${tableName}'`
                );
                const columns = await this.fetchColumns(
                    element.connection!,
                    schema,
                    tableName
                );
                outputChannel?.appendLine(`📊 Objects view: Found ${columns.length} columns`);
                const children: ObjectNode[] = columns.map(col => {
                    const id = `${connId}:${schema}:${tableName}:${col.name}:column`;
                    return new ObjectTreeItem({
                        label: `${col.name} (${col.type})`,
                        id,
                        collapsibleState: vscode.TreeItemCollapsibleState.None,
                        type: 'column',
                        connection: element.connection,
                        schemaName: element.schemaName,
                        columnInfo: col,
                        parent: element
                    });
                });

                if (constraintCount > 0) {
                    children.push(new ObjectTreeItem({
                        label: 'Constraints',
                        id: `${connId}:${schema}:${tableName}:constraints-folder`,
                        collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                        type: 'constraints-folder',
                        connection: element.connection,
                        schemaName: schema,
                        tableInfo: element.tableInfo,
                        constraintCount,
                        parent: element
                    }));
                }

                if (indexCount > 0) {
                    children.push(new ObjectTreeItem({
                        label: 'Indices',
                        id: `${connId}:${schema}:${tableName}:indices-folder`,
                        collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                        type: 'indices-folder',
                        connection: element.connection,
                        schemaName: schema,
                        tableInfo: element.tableInfo,
                        parent: element
                    }));
                }

                return children;
            } catch (error) {
                const message = `Failed to fetch columns: ${error}`;
                outputChannel?.appendLine(`❌ Objects view: ${message}`);
                vscode.window.showErrorMessage(message);
                return [];
            }
        }

        if (element.type === 'virtual-schema') {
            try {
                outputChannel?.appendLine(`Objects view: Fetching virtual tables for '${element.schemaName}'`);
                const tables = await this.fetchVirtualTables(element.connection!, element.schemaName!);
                outputChannel?.appendLine(`Objects view: Found ${tables.length} virtual tables`);
                return tables.map(table => {
                    const id = `${element.connection!.id}:${element.schemaName}:${table.name}:virtual-table`;
                    return new ObjectTreeItem({
                        label: table.name,
                        id,
                        collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                        type: 'virtual-table',
                        connection: element.connection,
                        schemaName: element.schemaName,
                        tableInfo: { name: table.name },
                        parent: element
                    });
                });
            } catch (error) {
                outputChannel?.appendLine(`Failed to fetch virtual tables: ${error}`);
                return [];
            }
        }

        if (element.type === 'virtual-table') {
            try {
                outputChannel?.appendLine(
                    `Objects view: Fetching virtual columns for '${element.schemaName}'.'${element.tableInfo!.name}'`
                );
                const columns = await this.fetchVirtualColumns(
                    element.connection!, element.schemaName!, element.tableInfo!.name
                );
                outputChannel?.appendLine(`Objects view: Found ${columns.length} virtual columns`);
                return columns.map(col => {
                    const id = `${element.connection!.id}:${element.schemaName}:${element.tableInfo!.name}:${col.name}:column`;
                    return new ObjectTreeItem({
                        label: `${col.name} (${col.type})`,
                        id,
                        collapsibleState: vscode.TreeItemCollapsibleState.None,
                        type: 'column',
                        connection: element.connection,
                        schemaName: element.schemaName,
                        columnInfo: { name: col.name, type: col.type, nullable: false },
                        parent: element
                    });
                });
            } catch (error) {
                outputChannel?.appendLine(`Failed to fetch virtual columns: ${error}`);
                return [];
            }
        }

        if (element.type === 'system-schemas-folder') {
            const connId = element.connection!.id;
            return [
                new ObjectTreeItem({
                    label: 'SYS',
                    id: `${connId}:SYS:system-schema`,
                    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                    type: 'system-schema',
                    connection: element.connection,
                    schemaName: 'SYS',
                    parent: element
                }),
                new ObjectTreeItem({
                    label: 'EXA_STATISTICS',
                    id: `${connId}:EXA_STATISTICS:system-schema`,
                    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                    type: 'system-schema',
                    connection: element.connection,
                    schemaName: 'EXA_STATISTICS',
                    parent: element
                })
            ];
        }

        if (element.type === 'system-schema') {
            const tables = await this.fetchSystemTables(element.connection!, element.schemaName!);
            return tables.map(table => {
                const id = `${element.connection!.id}:${element.schemaName}:${table.name}:system-table`;
                return new ObjectTreeItem({
                    label: table.name,
                    id,
                    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                    type: 'system-table',
                    connection: element.connection,
                    schemaName: element.schemaName,
                    tableInfo: { name: table.name },
                    parent: element
                });
            });
        }

        if (element.type === 'system-table') {
            const columns = await this.fetchSystemTableColumns(
                element.connection!, element.schemaName!, element.tableInfo!.name
            );
            return columns.map(col => {
                const id = `${element.connection!.id}:${element.schemaName}:${element.tableInfo!.name}:${col.name}:column`;
                return new ObjectTreeItem({
                    label: `${col.name} (${col.type})`,
                    id,
                    collapsibleState: vscode.TreeItemCollapsibleState.None,
                    type: 'column',
                    connection: element.connection,
                    schemaName: element.schemaName,
                    columnInfo: { name: col.name, type: col.type, nullable: false },
                    parent: element
                });
            });
        }

        return [];
    }

    private async getScriptFolderChildren(element: ObjectTreeItem, scriptType: string): Promise<ObjectNode[]> {
        const outputChannel = getOutputChannel();
        try {
            const scripts = await this.fetchScripts(element.connection!, element.schemaName!, scriptType);
            outputChannel?.appendLine(`Objects view: Found ${scripts.length} ${scriptType} scripts`);
            return scripts.map(script => new ObjectTreeItem({
                label: script.name,
                id: `${element.connection!.id}:${element.schemaName}:${script.name}:script`,
                collapsibleState: vscode.TreeItemCollapsibleState.None,
                type: 'script',
                connection: element.connection,
                schemaName: element.schemaName,
                scriptType,
                scriptInfo: script,
                parent: element
            }));
        } catch (error) {
            outputChannel?.appendLine(`Failed to fetch ${scriptType} scripts: ${error}`);
            return [];
        }
    }

    private async fetchSchemas(connection: StoredConnection): Promise<Array<{ name: string; tableCount?: number; viewCount?: number }>> {
        const outputChannel = getOutputChannel();
        try {
            return await this.connectionManager.executeWithRetry(async () => {
                outputChannel?.appendLine(`   Getting driver for connection ID: ${connection.id}`);
                const driver = await this.connectionManager.getDriver(connection.id, 'background');
                outputChannel?.appendLine(`   Driver obtained, running schema query with object counts...`);

            // Try to get schema counts in a single query
            try {
                const result = await driver.query(`
                    SELECT
                        s.SCHEMA_NAME,
                        COALESCE(t.TABLE_COUNT, 0) AS TABLE_COUNT,
                        COALESCE(v.VIEW_COUNT, 0) AS VIEW_COUNT
                    FROM SYS.EXA_SCHEMAS s
                    LEFT JOIN (
                        SELECT TABLE_SCHEMA, COUNT(*) AS TABLE_COUNT
                        FROM SYS.EXA_ALL_TABLES
                        GROUP BY TABLE_SCHEMA
                    ) t ON s.SCHEMA_NAME = t.TABLE_SCHEMA
                    LEFT JOIN (
                        SELECT VIEW_SCHEMA, COUNT(*) AS VIEW_COUNT
                        FROM SYS.EXA_ALL_VIEWS
                        GROUP BY VIEW_SCHEMA
                    ) v ON s.SCHEMA_NAME = v.VIEW_SCHEMA
                    WHERE s.SCHEMA_NAME NOT IN ('SYS', 'EXA_STATISTICS')
                    ORDER BY s.SCHEMA_NAME
                `, undefined, undefined, 'raw');
                const rows = getRowsFromResult(result);
                outputChannel?.appendLine(`   Schema query with counts returned ${rows.length} rows`);
                return rows.map((row: any) => ({
                    name: row.SCHEMA_NAME,
                    tableCount: this.parseRowCount(row.TABLE_COUNT),
                    viewCount: this.parseRowCount(row.VIEW_COUNT)
                }));
            } catch (error) {
                outputChannel?.appendLine(`   Failed to fetch counts with optimized query: ${error}`);
                outputChannel?.appendLine(`   Falling back to simple schema query without counts...`);

                // Fallback to simple query without counts
                const result = await driver.query(`
                    SELECT SCHEMA_NAME
                    FROM SYS.EXA_SCHEMAS
                    WHERE SCHEMA_NAME NOT IN ('SYS', 'EXA_STATISTICS')
                    ORDER BY SCHEMA_NAME
                `);
                const rows = getRowsFromResult(result);
                outputChannel?.appendLine(`   Schema query returned ${rows.length} rows`);
                return rows.map((row: any) => ({ name: row.SCHEMA_NAME }));
            }
            }, connection.id, { timeoutMs: BACKGROUND_QUERY_TIMEOUT_MS, role: 'background' });
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
            return await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connection.id, 'background');
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
                        WHERE TABLE_SCHEMA = '${escapeSqlString(schemaName)}'
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
                        WHERE TABLE_SCHEMA = '${escapeSqlString(schemaName)}'
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
                        WHERE OBJECT_SCHEMA = '${escapeSqlString(schemaName)}'
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
                        WHERE COLUMN_SCHEMA = '${escapeSqlString(schemaName)}'
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
            }, connection.id, { timeoutMs: BACKGROUND_QUERY_TIMEOUT_MS, role: 'background' });
        } catch (error) {
            outputChannel?.appendLine(`   Error in fetchTables: ${error}`);
            throw new Error(`Failed to fetch tables: ${error}`);
        }
    }

    private async fetchViews(connection: StoredConnection, schemaName: string): Promise<Array<{ name: string }>> {
        const outputChannel = getOutputChannel();
        try {
            return await this.connectionManager.executeWithRetry(async () => {
                outputChannel?.appendLine(`   Running views query for schema '${schemaName}'`);
                const driver = await this.connectionManager.getDriver(connection.id, 'background');

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
                        WHERE VIEW_SCHEMA = '${escapeSqlString(schemaName)}'
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
                        WHERE OBJECT_SCHEMA = '${escapeSqlString(schemaName)}'
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
                        WHERE COLUMN_SCHEMA = '${escapeSqlString(schemaName)}'
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
            }, connection.id, { timeoutMs: BACKGROUND_QUERY_TIMEOUT_MS, role: 'background' });
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
            return await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connection.id, 'background');
                const result = await driver.query(`
                    SELECT
                        COLUMN_NAME,
                        COLUMN_TYPE,
                        COLUMN_IS_NULLABLE
                    FROM SYS.EXA_ALL_COLUMNS
                    WHERE COLUMN_SCHEMA = '${escapeSqlString(schemaName)}'
                    AND COLUMN_TABLE = '${escapeSqlString(tableName)}'
                    ORDER BY COLUMN_ORDINAL_POSITION
                `);
                const rows = getRowsFromResult(result);
                return rows.map((row: any) => ({
                    name: row.COLUMN_NAME,
                    type: row.COLUMN_TYPE,
                    nullable: row.COLUMN_IS_NULLABLE
                }));
            }, connection.id, { timeoutMs: BACKGROUND_QUERY_TIMEOUT_MS, role: 'background' });
        } catch (error) {
            throw new Error(`Failed to fetch columns: ${error}`);
        }
    }

    private async fetchScriptCounts(
        connection: StoredConnection,
        schemaName: string
    ): Promise<Map<string, number>> {
        const outputChannel = getOutputChannel();
        try {
            return await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connection.id, 'background');
                const result = await driver.query(`
                    SELECT SCRIPT_TYPE, COUNT(*) AS SCRIPT_COUNT
                    FROM SYS.EXA_ALL_SCRIPTS
                    WHERE SCRIPT_SCHEMA = '${escapeSqlString(schemaName)}'
                    GROUP BY SCRIPT_TYPE
                `, undefined, undefined, 'raw');
                const rows = getRowsFromResult(result);
                const counts = new Map<string, number>();
                for (const row of rows) {
                    const scriptType = row.SCRIPT_TYPE as string;
                    const count = this.parseRowCount(row.SCRIPT_COUNT) ?? 0;
                    if (scriptType && count > 0) {
                        counts.set(scriptType, count);
                    }
                }
                return counts;
            }, connection.id, { role: 'background' });
        } catch (error) {
            outputChannel?.appendLine(`Failed to fetch script counts for '${schemaName}': ${error}`);
            return new Map();
        }
    }

    private async fetchFunctionCount(
        connection: StoredConnection,
        schemaName: string
    ): Promise<number> {
        const outputChannel = getOutputChannel();
        try {
            return await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connection.id, 'background');
                const result = await driver.query(`
                    SELECT COUNT(*) AS FUNCTION_COUNT
                    FROM SYS.EXA_ALL_FUNCTIONS
                    WHERE FUNCTION_SCHEMA = '${escapeSqlString(schemaName)}'
                `, undefined, undefined, 'raw');
                const rows = getRowsFromResult(result);
                if (rows.length > 0) {
                    return this.parseRowCount(rows[0].FUNCTION_COUNT) ?? 0;
                }
                return 0;
            }, connection.id, { role: 'background' });
        } catch (error) {
            outputChannel?.appendLine(`Failed to fetch function count for '${schemaName}': ${error}`);
            return 0;
        }
    }

    private async fetchScripts(
        connection: StoredConnection,
        schemaName: string,
        scriptType: string
    ): Promise<Array<{ name: string; language: string; inputType: string | null; scriptType: string }>> {
        const outputChannel = getOutputChannel();
        try {
            return await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connection.id, 'background');
                const result = await driver.query(`
                    SELECT
                        SCRIPT_NAME,
                        SCRIPT_LANGUAGE,
                        SCRIPT_INPUT_TYPE,
                        SCRIPT_TYPE
                    FROM SYS.EXA_ALL_SCRIPTS
                    WHERE SCRIPT_SCHEMA = '${escapeSqlString(schemaName)}'
                    AND SCRIPT_TYPE = '${escapeSqlString(scriptType)}'
                    ORDER BY SCRIPT_NAME
                `, undefined, undefined, 'raw');
                const rows = getRowsFromResult(result);
                return rows.map((row: any) => ({
                    name: row.SCRIPT_NAME,
                    language: row.SCRIPT_LANGUAGE,
                    inputType: row.SCRIPT_INPUT_TYPE ?? null,
                    scriptType: row.SCRIPT_TYPE
                }));
            }, connection.id, { role: 'background' });
        } catch (error) {
            outputChannel?.appendLine(`Failed to fetch scripts (${scriptType}) for '${schemaName}': ${error}`);
            return [];
        }
    }

    private async fetchFunctions(
        connection: StoredConnection,
        schemaName: string
    ): Promise<Array<{ name: string }>> {
        const outputChannel = getOutputChannel();
        try {
            return await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connection.id, 'background');
                const result = await driver.query(`
                    SELECT FUNCTION_NAME
                    FROM SYS.EXA_ALL_FUNCTIONS
                    WHERE FUNCTION_SCHEMA = '${escapeSqlString(schemaName)}'
                    ORDER BY FUNCTION_NAME
                `, undefined, undefined, 'raw');
                const rows = getRowsFromResult(result);
                return rows.map((row: any) => ({
                    name: row.FUNCTION_NAME
                }));
            }, connection.id, { role: 'background' });
        } catch (error) {
            outputChannel?.appendLine(`Failed to fetch functions for '${schemaName}': ${error}`);
            return [];
        }
    }

    private async fetchConstraintCount(
        connection: StoredConnection,
        schemaName: string,
        tableName: string
    ): Promise<number> {
        const outputChannel = getOutputChannel();
        try {
            return await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connection.id, 'background');
                const result = await driver.query(`
                    SELECT COUNT(*) AS CONSTRAINT_COUNT
                    FROM SYS.EXA_ALL_CONSTRAINTS
                    WHERE CONSTRAINT_SCHEMA = '${escapeSqlString(schemaName)}'
                    AND CONSTRAINT_TABLE = '${escapeSqlString(tableName)}'
                `, undefined, undefined, 'raw');
                const rows = getRowsFromResult(result);
                if (rows.length > 0) {
                    return this.parseRowCount(rows[0].CONSTRAINT_COUNT) ?? 0;
                }
                return 0;
            }, connection.id, { role: 'background' });
        } catch (error) {
            outputChannel?.appendLine(`Failed to fetch constraint count for '${schemaName}'.'${tableName}': ${error}`);
            return 0;
        }
    }

    private async fetchIndexCount(
        connection: StoredConnection,
        schemaName: string,
        tableName: string
    ): Promise<number> {
        const outputChannel = getOutputChannel();
        try {
            return await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connection.id, 'background');
                const result = await driver.query(`
                    SELECT COUNT(*) AS INDEX_COUNT
                    FROM SYS.EXA_ALL_INDICES
                    WHERE INDEX_SCHEMA = '${escapeSqlString(schemaName)}'
                    AND INDEX_TABLE = '${escapeSqlString(tableName)}'
                `, undefined, undefined, 'raw');
                const rows = getRowsFromResult(result);
                if (rows.length > 0) {
                    return this.parseRowCount(rows[0].INDEX_COUNT) ?? 0;
                }
                return 0;
            }, connection.id, { role: 'background' });
        } catch (error) {
            outputChannel?.appendLine(`Failed to fetch index count for '${schemaName}'.'${tableName}': ${error}`);
            return 0;
        }
    }

    private async fetchConstraints(
        connection: StoredConnection,
        schemaName: string,
        tableName: string
    ): Promise<Array<{ name: string; type: string }>> {
        const outputChannel = getOutputChannel();
        try {
            return await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connection.id, 'background');
                const result = await driver.query(`
                    SELECT CONSTRAINT_NAME, CONSTRAINT_TYPE
                    FROM SYS.EXA_ALL_CONSTRAINTS
                    WHERE CONSTRAINT_SCHEMA = '${escapeSqlString(schemaName)}'
                    AND CONSTRAINT_TABLE = '${escapeSqlString(tableName)}'
                    ORDER BY CONSTRAINT_NAME
                `, undefined, undefined, 'raw');
                const rows = getRowsFromResult(result);
                return rows.map((row: any) => ({
                    name: row.CONSTRAINT_NAME,
                    type: row.CONSTRAINT_TYPE
                }));
            }, connection.id, { role: 'background' });
        } catch (error) {
            outputChannel?.appendLine(`Failed to fetch constraints for '${schemaName}'.'${tableName}': ${error}`);
            return [];
        }
    }

    private async fetchConstraintColumns(
        connection: StoredConnection,
        schemaName: string,
        tableName: string,
        constraintName: string
    ): Promise<Array<{ name: string }>> {
        const outputChannel = getOutputChannel();
        try {
            return await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connection.id, 'background');
                const result = await driver.query(`
                    SELECT COLUMN_NAME, ORDINAL_POSITION
                    FROM SYS.EXA_ALL_CONSTRAINT_COLUMNS
                    WHERE CONSTRAINT_SCHEMA = '${escapeSqlString(schemaName)}'
                    AND CONSTRAINT_TABLE = '${escapeSqlString(tableName)}'
                    AND CONSTRAINT_NAME = '${escapeSqlString(constraintName)}'
                    ORDER BY ORDINAL_POSITION
                `, undefined, undefined, 'raw');
                const rows = getRowsFromResult(result);
                return rows.map((row: any) => ({
                    name: row.COLUMN_NAME
                }));
            }, connection.id, { role: 'background' });
        } catch (error) {
            outputChannel?.appendLine(`Failed to fetch constraint columns for '${constraintName}': ${error}`);
            return [];
        }
    }

    private async fetchIndices(
        connection: StoredConnection,
        schemaName: string,
        tableName: string
    ): Promise<Array<{ name: string; columns: string }>> {
        const outputChannel = getOutputChannel();
        try {
            return await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connection.id, 'background');
                const result = await driver.query(`
                    SELECT INDEX_NAME, INDEX_TYPE, INDEX_COLUMNS
                    FROM SYS.EXA_ALL_INDICES
                    WHERE INDEX_SCHEMA = '${escapeSqlString(schemaName)}'
                    AND INDEX_TABLE = '${escapeSqlString(tableName)}'
                    ORDER BY INDEX_NAME
                `, undefined, undefined, 'raw');
                const rows = getRowsFromResult(result);
                return rows.map((row: any) => ({
                    name: row.INDEX_NAME ?? row.INDEX_TYPE ?? 'INDEX',
                    columns: row.INDEX_COLUMNS ?? ''
                }));
            }, connection.id, { role: 'background' });
        } catch (error) {
            outputChannel?.appendLine(`Failed to fetch indices for '${schemaName}'.'${tableName}': ${error}`);
            return [];
        }
    }

    private async fetchVirtualSchemas(
        connection: StoredConnection
    ): Promise<Array<{ name: string; adapterName?: string; lastRefresh?: string; lastRefreshBy?: string }>> {
        const outputChannel = getOutputChannel();
        try {
            return await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connection.id, 'background');
                const result = await driver.query(`
                    SELECT
                        SCHEMA_NAME,
                        ADAPTER_SCRIPT_SCHEMA,
                        ADAPTER_SCRIPT_NAME,
                        LAST_REFRESH,
                        LAST_REFRESH_BY
                    FROM SYS.EXA_ALL_VIRTUAL_SCHEMAS
                    ORDER BY SCHEMA_NAME
                `, undefined, undefined, 'raw');
                const rows = getRowsFromResult(result);
                return rows.map((row: any) => ({
                    name: row.SCHEMA_NAME,
                    adapterName: row.ADAPTER_SCRIPT_NAME ?? undefined,
                    lastRefresh: row.LAST_REFRESH ?? undefined,
                    lastRefreshBy: row.LAST_REFRESH_BY ?? undefined
                }));
            }, connection.id, { role: 'background' });
        } catch (error) {
            outputChannel?.appendLine(`Failed to fetch virtual schemas: ${error}`);
            return [];
        }
    }

    private async fetchVirtualTables(
        connection: StoredConnection,
        virtualSchemaName: string
    ): Promise<Array<{ name: string }>> {
        const outputChannel = getOutputChannel();
        try {
            return await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connection.id, 'background');
                const result = await driver.query(`
                    SELECT TABLE_NAME
                    FROM SYS.EXA_ALL_VIRTUAL_TABLES
                    WHERE TABLE_SCHEMA = '${escapeSqlString(virtualSchemaName)}'
                    ORDER BY TABLE_NAME
                `, undefined, undefined, 'raw');
                const rows = getRowsFromResult(result);
                return rows.map((row: any) => ({
                    name: row.TABLE_NAME
                }));
            }, connection.id, { role: 'background' });
        } catch (error) {
            outputChannel?.appendLine(`Failed to fetch virtual tables for '${virtualSchemaName}': ${error}`);
            return [];
        }
    }

    private async fetchVirtualColumns(
        connection: StoredConnection,
        virtualSchemaName: string,
        tableName: string
    ): Promise<Array<{ name: string; type: string }>> {
        const outputChannel = getOutputChannel();
        try {
            return await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connection.id, 'background');
                const result = await driver.query(`
                    SELECT COLUMN_NAME, COLUMN_TYPE
                    FROM SYS.EXA_ALL_VIRTUAL_COLUMNS
                    WHERE COLUMN_SCHEMA = '${escapeSqlString(virtualSchemaName)}'
                    AND COLUMN_TABLE = '${escapeSqlString(tableName)}'
                    ORDER BY COLUMN_ORDINAL_POSITION
                `, undefined, undefined, 'raw');
                const rows = getRowsFromResult(result);
                return rows.map((row: any) => ({
                    name: row.COLUMN_NAME,
                    type: row.COLUMN_TYPE
                }));
            }, connection.id, { role: 'background' });
        } catch (error) {
            outputChannel?.appendLine(`Failed to fetch virtual columns for '${virtualSchemaName}'.'${tableName}': ${error}`);
            return [];
        }
    }

    private async fetchSystemTables(
        connection: StoredConnection,
        schemaName: string
    ): Promise<Array<{ name: string }>> {
        const outputChannel = getOutputChannel();
        try {
            return await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connection.id, 'background');
                const result = await driver.query(`
                    SELECT OBJECT_NAME
                    FROM SYS.EXA_SYSCAT
                    WHERE SCHEMA_NAME = '${escapeSqlString(schemaName)}'
                    ORDER BY OBJECT_NAME
                `, undefined, undefined, 'raw');
                const rows = getRowsFromResult(result);
                return rows.map((row: any) => ({
                    name: row.OBJECT_NAME
                }));
            }, connection.id, { role: 'background' });
        } catch (error) {
            outputChannel?.appendLine(`Failed to fetch system tables for '${schemaName}': ${error}`);
            return [];
        }
    }

    private async fetchSystemTableColumns(
        connection: StoredConnection,
        schemaName: string,
        tableName: string
    ): Promise<Array<{ name: string; type: string }>> {
        const outputChannel = getOutputChannel();
        try {
            return await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connection.id, 'background');
                const result = await driver.query(`
                    DESCRIBE "${escapeSqlString(schemaName)}"."${escapeSqlString(tableName)}"
                `, undefined, undefined, 'raw');
                const rows = getRowsFromResult(result);
                return rows.map((row: any) => ({
                    name: row.COLUMN_NAME,
                    type: row.SQL_TYPE ?? 'UNKNOWN'
                }));
            }, connection.id, { role: 'background' });
        } catch (error) {
            outputChannel?.appendLine(`Failed to fetch system table columns for '${schemaName}'.'${tableName}': ${error}`);
            return [];
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

interface ObjectTreeItemOptions {
    label: string;
    id: string;
    collapsibleState: vscode.TreeItemCollapsibleState;
    type: ObjectTreeItemType;
    connection?: StoredConnection;
    schemaName?: string;
    tableInfo?: { name: string; rowCount?: number };
    columnInfo?: { name: string; type: string; nullable: boolean };
    tableCount?: number;
    viewCount?: number;
    constraintCount?: number;
    scriptType?: string;
    constraintType?: string;
    itemCount?: number;
    scriptInfo?: { name: string; language: string; inputType: string | null; scriptType: string };
    functionInfo?: { name: string };
    parent?: ObjectTreeItem | null;
}

export class ObjectTreeItem extends vscode.TreeItem {
    public readonly type: ObjectTreeItemType;
    public readonly connection?: StoredConnection;
    public readonly schemaName?: string;
    public readonly tableInfo?: { name: string; rowCount?: number };
    public readonly columnInfo?: { name: string; type: string; nullable: boolean };
    public readonly tableCount?: number;
    public readonly viewCount?: number;
    public readonly constraintCount?: number;
    public readonly scriptType?: string;
    public readonly constraintType?: string;
    public readonly itemCount?: number;
    public readonly scriptInfo?: { name: string; language: string; inputType: string | null; scriptType: string };
    public readonly functionInfo?: { name: string };
    public readonly parent: ObjectTreeItem | null;

    constructor(options: ObjectTreeItemOptions) {
        super(options.label, options.collapsibleState);
        this.id = options.id;
        this.type = options.type;
        this.connection = options.connection;
        this.schemaName = options.schemaName;
        this.tableInfo = options.tableInfo;
        this.columnInfo = options.columnInfo;
        this.tableCount = options.tableCount;
        this.viewCount = options.viewCount;
        this.constraintCount = options.constraintCount;
        this.scriptType = options.scriptType;
        this.constraintType = options.constraintType;
        this.itemCount = options.itemCount;
        this.scriptInfo = options.scriptInfo;
        this.functionInfo = options.functionInfo;
        this.parent = options.parent ?? null;

        const config = getNodeTypeConfig(options.type, {
            scriptType: this.scriptType,
            constraintType: this.constraintType
        });
        if (config) {
            this.iconPath = new vscode.ThemeIcon(config.icon);
            this.contextValue = config.contextValue;
        }

        switch (options.type) {
            case 'schema':
                if (this.tableCount !== undefined || this.viewCount !== undefined) {
                    const parts: string[] = [];
                    if (this.tableCount !== undefined && this.tableCount > 0) {
                        parts.push(`${this.tableCount} ${this.tableCount === 1 ? 'table' : 'tables'}`);
                    }
                    if (this.viewCount !== undefined && this.viewCount > 0) {
                        parts.push(`${this.viewCount} ${this.viewCount === 1 ? 'view' : 'views'}`);
                    }
                    if (parts.length > 0) {
                        this.description = parts.join(', ');
                    } else if (this.tableCount === 0 && this.viewCount === 0) {
                        this.description = 'empty';
                    }
                }
                break;
            case 'tables-folder':
                if (this.tableCount !== undefined) {
                    this.description = `${this.tableCount}`;
                }
                break;
            case 'table':
                if (this.tableInfo?.rowCount !== undefined) {
                    this.description = `${this.tableInfo.rowCount.toLocaleString()} rows`;
                }
                this.command = {
                    command: 'exasol.openObject',
                    title: 'Open Table',
                    arguments: [this]
                };
                break;
            case 'views-folder':
                if (this.viewCount !== undefined) {
                    this.description = `${this.viewCount}`;
                }
                break;
            case 'view':
                this.command = {
                    command: 'exasol.openObject',
                    title: 'Open View',
                    arguments: [this]
                };
                break;
            case 'system-table':
                this.command = {
                    command: 'exasol.openObject',
                    title: 'Open System Table',
                    arguments: [this]
                };
                break;
            case 'column':
                if (this.columnInfo) {
                    this.tooltip = `${this.columnInfo.name}: ${this.columnInfo.type}${this.columnInfo.nullable ? ' (nullable)' : ''}`;
                }
                break;
            case 'constraints-folder':
                if (this.constraintCount !== undefined) {
                    this.description = `${this.constraintCount}`;
                }
                break;
            case 'udfs-folder':
            case 'procedures-folder':
            case 'functions-folder':
                if (this.itemCount !== undefined) {
                    this.description = `${this.itemCount}`;
                }
                break;
            case 'script':
                if (this.scriptInfo) {
                    if (this.scriptInfo.scriptType === 'UDF' && this.scriptInfo.inputType) {
                        this.description = `${this.scriptInfo.language}, ${this.scriptInfo.inputType}`;
                    } else {
                        this.description = this.scriptInfo.language;
                    }
                }
                this.command = {
                    command: 'exasol.openScriptSource',
                    title: 'Open Script Source',
                    arguments: [this]
                };
                break;
            case 'function':
                this.command = {
                    command: 'exasol.openFunctionSource',
                    title: 'Open Function Source',
                    arguments: [this]
                };
                break;
            case 'constraint':
                if (this.constraintType) {
                    this.description = this.constraintType;
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
