import * as vscode from 'vscode';
import { ConnectionManager, StoredConnection } from '../connectionManager';
import { getOutputChannel } from '../extension';
import { ObjectTreeItemType, getNodeTypeConfig } from './objectTreeTypes';
import {
    fetchSchemas,
    fetchTables,
    fetchViews,
    fetchColumns,
    fetchScriptCounts,
    fetchFunctionCount,
    fetchScripts,
    fetchFunctions,
    fetchConstraintCount,
    fetchIndexCount,
    fetchConstraints,
    fetchConstraintColumns,
    fetchIndices,
    fetchVirtualSchemas,
    fetchVirtualTables,
    fetchVirtualColumns,
    fetchSystemTables,
    fetchSystemTableColumns
} from './objectTreeFetchers';

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
    async handleDrag(source: readonly ObjectNode[], dataTransfer: vscode.DataTransfer, _token: vscode.CancellationToken): Promise<void> {
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
    async handleDrop(_target: ObjectNode | undefined, _dataTransfer: vscode.DataTransfer, _token: vscode.CancellationToken): Promise<void> {
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
                    fetchSchemas(this.connectionManager, activeConnection),
                    fetchVirtualSchemas(this.connectionManager, activeConnection)
                ]);
                outputChannel?.appendLine(`📂 Objects view: Found ${schemas.length} schemas, ${virtualSchemas.length} virtual schemas`);

                const cfg = vscode.workspace.getConfiguration('exasol');
                const groupingEnabled = cfg.get<boolean>('schemaGrouping.enabled', false);
                const delimiter = cfg.get<string>('schemaGrouping.delimiter', '_');

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

                const allNodes: ObjectNode[] = [];

                if (!groupingEnabled || !delimiter) {
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
                    allNodes.push(...schemaNodes, ...virtualSchemaNodes);
                    allNodes.sort((a, b) => {
                        const labelA = (a as ObjectTreeItem).label as string;
                        const labelB = (b as ObjectTreeItem).label as string;
                        return labelA.localeCompare(labelB);
                    });
                } else {
                    const groups = new Map<string, SchemaInfo[]>();
                    const ungrouped: SchemaInfo[] = [];
                    for (const schema of schemas) {
                        const info: SchemaInfo = {
                            name: schema.name,
                            tableCount: schema.tableCount,
                            viewCount: schema.viewCount
                        };
                        if (schema.name.includes(delimiter)) {
                            const prefix = schema.name.split(delimiter)[0];
                            if (prefix !== '') {
                                const bucket = groups.get(prefix);
                                if (bucket) {
                                    bucket.push(info);
                                } else {
                                    groups.set(prefix, [info]);
                                }
                                continue;
                            }
                        }
                        ungrouped.push(info);
                    }

                    for (const members of groups.values()) {
                        members.sort((a, b) => a.name.localeCompare(b.name));
                    }
                    ungrouped.sort((a, b) => a.name.localeCompare(b.name));

                    const groupNodes: ObjectTreeItem[] = Array.from(groups.entries())
                        .sort(([a], [b]) => a.localeCompare(b))
                        .map(([prefix, members]) => new ObjectTreeItem({
                            label: prefix,
                            id: `${activeConnection.id}:schema-group:${prefix}`,
                            collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                            type: 'schema-group',
                            connection: activeConnection,
                            groupedSchemas: members
                        }));

                    allNodes.push(...groupNodes, ...virtualSchemaNodes);
                    allNodes.sort((a, b) => {
                        const labelA = (a as ObjectTreeItem).label as string;
                        const labelB = (b as ObjectTreeItem).label as string;
                        return labelA.localeCompare(labelB);
                    });

                    if (ungrouped.length > 0) {
                        allNodes.push(new ObjectTreeItem({
                            label: '(ungrouped)',
                            id: `${activeConnection.id}:schema-group:__ungrouped__`,
                            collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                            type: 'schema-group',
                            connection: activeConnection,
                            groupedSchemas: ungrouped
                        }));
                    }
                }

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

        if (element.type === 'schema-group') {
            const members = element.groupedSchemas ?? [];
            return members.map(schema => {
                const id = `${element.connection!.id}:${schema.name}`;
                return new ObjectTreeItem({
                    label: schema.name,
                    id,
                    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                    type: 'schema',
                    connection: element.connection,
                    schemaName: schema.name,
                    tableCount: schema.tableCount,
                    viewCount: schema.viewCount,
                    parent: element
                });
            });
        }

        if (element.type === 'schema') {
            const connId = element.connection!.id;
            const schema = element.schemaName!;

            const [scriptCounts, functionCount] = await Promise.all([
                fetchScriptCounts(this.connectionManager, element.connection!, schema),
                fetchFunctionCount(this.connectionManager, element.connection!, schema)
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
                const tables = await fetchTables(this.connectionManager, element.connection!, element.schemaName!);
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
                const views = await fetchViews(this.connectionManager, element.connection!, element.schemaName!);
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
            outputChannel?.appendLine(`Objects view: Fetching functions for '${element.schemaName}'`);
            const functions = await fetchFunctions(this.connectionManager, element.connection!, element.schemaName!);
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
        }

        if (element.type === 'constraints-folder') {
            const constraints = await fetchConstraints(
                this.connectionManager, element.connection!, element.schemaName!, element.tableInfo!.name
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
        }

        if (element.type === 'indices-folder') {
            const indices = await fetchIndices(
                this.connectionManager, element.connection!, element.schemaName!, element.tableInfo!.name
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
        }

        if (element.type === 'constraint') {
            const columns = await fetchConstraintColumns(
                this.connectionManager, element.connection!, element.schemaName!, element.tableInfo!.name, element.label as string
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
        }

        if (element.type === 'table' || element.type === 'view') {
            const connId = element.connection!.id;
            const schema = element.schemaName!;
            const tableName = element.tableInfo!.name;

            const [constraintCount, indexCount] = await Promise.all([
                fetchConstraintCount(this.connectionManager, element.connection!, schema, tableName),
                fetchIndexCount(this.connectionManager, element.connection!, schema, tableName)
            ]);

            try {
                outputChannel?.appendLine(
                    `📊 Objects view: Fetching columns for ${element.type} '${tableName}'`
                );
                const columns = await fetchColumns(
                    this.connectionManager,
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
            outputChannel?.appendLine(`Objects view: Fetching virtual tables for '${element.schemaName}'`);
            const tables = await fetchVirtualTables(this.connectionManager, element.connection!, element.schemaName!);
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
        }

        if (element.type === 'virtual-table') {
            outputChannel?.appendLine(
                `Objects view: Fetching virtual columns for '${element.schemaName}'.'${element.tableInfo!.name}'`
            );
            const columns = await fetchVirtualColumns(
                this.connectionManager, element.connection!, element.schemaName!, element.tableInfo!.name
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
            const tables = await fetchSystemTables(this.connectionManager, element.connection!, element.schemaName!);
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
            const columns = await fetchSystemTableColumns(
                this.connectionManager, element.connection!, element.schemaName!, element.tableInfo!.name
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
        const scripts = await fetchScripts(this.connectionManager, element.connection!, element.schemaName!, scriptType);
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
    }

}

interface SchemaInfo {
    name: string;
    tableCount?: number;
    viewCount?: number;
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
    groupedSchemas?: SchemaInfo[];
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
    public readonly groupedSchemas?: SchemaInfo[];

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
        this.groupedSchemas = options.groupedSchemas;

        const config = getNodeTypeConfig(options.type, {
            scriptType: this.scriptType,
            constraintType: this.constraintType
        });
        if (config) {
            if (config.icon) {
                this.iconPath = new vscode.ThemeIcon(config.icon);
            }
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
