import * as vscode from 'vscode';
import { ConnectionManager, BACKGROUND_QUERY_TIMEOUT_MS } from '../connectionManager';
import { getOutputChannel } from '../extension';
import { getRowsFromResult } from '../utils';
import { ObjectTreeProvider, ObjectTreeItem, ObjectNode } from './objectTreeProvider';
import { getNodeTypeConfig, ObjectTreeItemType } from './objectTreeTypes';

interface SearchableObject {
    schema: string;
    name: string;
    type: ObjectTreeItemType;
}

type ObjectTreeView = vscode.TreeView<ObjectNode>;

export class ObjectSearchProvider {
    private readonly itemDataMap = new Map<vscode.QuickPickItem, SearchableObject>();

    constructor(
        private readonly connectionManager: ConnectionManager,
        private readonly objectTreeProvider: ObjectTreeProvider,
        private readonly treeView: ObjectTreeView
    ) {}

    async showSearch(): Promise<void> {
        this.itemDataMap.clear();

        const activeConnection = this.connectionManager.getActiveConnection();
        if (!activeConnection) {
            vscode.window.showInformationMessage('No active connection');
            return;
        }

        const quickPick = vscode.window.createQuickPick();
        quickPick.placeholder = 'Type to search database objects...';
        quickPick.matchOnDescription = true;
        quickPick.matchOnDetail = true;
        quickPick.busy = true;

        quickPick.show();

        try {
            const objects = await this.fetchAllObjects(activeConnection.id);
            quickPick.items = objects.map(obj => this.toQuickPickItem(obj));
            quickPick.busy = false;
        } catch (error) {
            const outputChannel = getOutputChannel();
            const message = `Failed to fetch objects: ${error}`;
            outputChannel?.appendLine(`Object search: ${message}`);
            vscode.window.showErrorMessage(message);
            quickPick.hide();
            quickPick.dispose();
            return;
        }

        quickPick.onDidAccept(async () => {
            const selected = quickPick.selectedItems[0];
            quickPick.hide();
            quickPick.dispose();

            if (selected) {
                await this.revealInTree(selected);
            }
        });

        quickPick.onDidHide(() => {
            quickPick.dispose();
        });
    }

    private async fetchAllObjects(connectionId: string): Promise<SearchableObject[]> {
        return await this.connectionManager.executeWithRetry(async () => {
            const driver = await this.connectionManager.getDriver(connectionId, 'background');
            const objects: SearchableObject[] = [];

            const tablesResult = await driver.query(`
                SELECT TABLE_SCHEMA, TABLE_NAME, 'table' AS OBJECT_TYPE
                FROM SYS.EXA_ALL_TABLES
                WHERE TABLE_SCHEMA NOT IN ('SYS', 'EXA_STATISTICS')
                UNION ALL
                SELECT VIEW_SCHEMA, VIEW_NAME, 'view'
                FROM SYS.EXA_ALL_VIEWS
                WHERE VIEW_SCHEMA NOT IN ('SYS', 'EXA_STATISTICS')
                ORDER BY 1, 2
            `);
            for (const row of getRowsFromResult(tablesResult)) {
                objects.push({
                    schema: row.TABLE_SCHEMA,
                    name: row.TABLE_NAME,
                    type: row.OBJECT_TYPE === 'view' ? 'view' : 'table'
                });
            }

            try {
                const scriptsResult = await driver.query(`
                    SELECT SCRIPT_SCHEMA, SCRIPT_NAME
                    FROM SYS.EXA_ALL_SCRIPTS
                    WHERE SCRIPT_SCHEMA NOT IN ('SYS', 'EXA_STATISTICS')
                    ORDER BY SCRIPT_SCHEMA, SCRIPT_NAME
                `);
                for (const row of getRowsFromResult(scriptsResult)) {
                    objects.push({
                        schema: row.SCRIPT_SCHEMA,
                        name: row.SCRIPT_NAME,
                        type: 'script'
                    });
                }
            } catch {
                getOutputChannel()?.appendLine('Object search: Failed to fetch scripts');
            }

            try {
                const functionsResult = await driver.query(`
                    SELECT FUNCTION_SCHEMA, FUNCTION_NAME
                    FROM SYS.EXA_ALL_FUNCTIONS
                    WHERE FUNCTION_SCHEMA NOT IN ('SYS', 'EXA_STATISTICS')
                    ORDER BY FUNCTION_SCHEMA, FUNCTION_NAME
                `);
                for (const row of getRowsFromResult(functionsResult)) {
                    objects.push({
                        schema: row.FUNCTION_SCHEMA,
                        name: row.FUNCTION_NAME,
                        type: 'function'
                    });
                }
            } catch {
                getOutputChannel()?.appendLine('Object search: Failed to fetch functions');
            }

            try {
                const virtualTablesResult = await driver.query(`
                    SELECT TABLE_SCHEMA, TABLE_NAME
                    FROM SYS.EXA_ALL_VIRTUAL_TABLES
                    ORDER BY TABLE_SCHEMA, TABLE_NAME
                `);
                for (const row of getRowsFromResult(virtualTablesResult)) {
                    objects.push({
                        schema: row.TABLE_SCHEMA,
                        name: row.TABLE_NAME,
                        type: 'virtual-table'
                    });
                }
            } catch {
                getOutputChannel()?.appendLine('Object search: Failed to fetch virtual tables');
            }

            try {
                const systemTablesResult = await driver.query(`
                    SELECT SCHEMA_NAME AS TABLE_SCHEMA, OBJECT_NAME AS TABLE_NAME
                    FROM SYS.EXA_SYSCAT
                    WHERE SCHEMA_NAME IN ('SYS', 'EXA_STATISTICS')
                    ORDER BY SCHEMA_NAME, OBJECT_NAME
                `);
                for (const row of getRowsFromResult(systemTablesResult)) {
                    objects.push({
                        schema: row.TABLE_SCHEMA,
                        name: row.TABLE_NAME,
                        type: 'system-table'
                    });
                }
            } catch {
                getOutputChannel()?.appendLine('Object search: Failed to fetch system tables');
            }

            try {
                const columnsResult = await driver.query(`
                    SELECT COLUMN_SCHEMA, COLUMN_TABLE, COLUMN_NAME
                    FROM SYS.EXA_ALL_COLUMNS
                    WHERE COLUMN_SCHEMA NOT IN ('SYS', 'EXA_STATISTICS')
                    ORDER BY COLUMN_SCHEMA, COLUMN_TABLE, COLUMN_ORDINAL_POSITION
                `);
                for (const row of getRowsFromResult(columnsResult)) {
                    objects.push({
                        schema: row.COLUMN_SCHEMA,
                        name: row.COLUMN_NAME,
                        type: 'column'
                    });
                }
            } catch {
                getOutputChannel()?.appendLine('Object search: Failed to fetch columns');
            }

            return objects;
        }, connectionId, { timeoutMs: BACKGROUND_QUERY_TIMEOUT_MS, role: 'background' });
    }

    private toQuickPickItem(obj: SearchableObject): vscode.QuickPickItem {
        const config = getNodeTypeConfig(obj.type);
        const iconId = config?.icon ?? 'symbol-misc';
        const typeLabel = this.formatTypeLabel(obj.type);

        const item: vscode.QuickPickItem = {
            label: `$(${iconId}) ${obj.name}`,
            description: obj.schema,
            detail: typeLabel
        };
        this.itemDataMap.set(item, obj);
        return item;
    }

    private formatTypeLabel(type: ObjectTreeItemType): string {
        switch (type) {
            case 'table': return 'Table';
            case 'view': return 'View';
            case 'script': return 'Script';
            case 'function': return 'Function';
            case 'virtual-table': return 'Virtual Table';
            case 'system-table': return 'System Table';
            case 'column': return 'Column';
            default: return type;
        }
    }

    private async revealInTree(item: vscode.QuickPickItem): Promise<void> {
        const outputChannel = getOutputChannel();
        const obj = this.itemDataMap.get(item);

        if (!obj) {
            return;
        }

        try {
            const targetNode = await this.findTreeNode(obj.name, obj.schema, this.formatTypeLabel(obj.type));
            if (targetNode) {
                await this.treeView.reveal(targetNode, {
                    select: true,
                    focus: true,
                    expand: true
                });
            } else {
                outputChannel?.appendLine(
                    `Object search: Could not find tree node for ${obj.schema}.${obj.name}`
                );
            }
        } catch (error) {
            outputChannel?.appendLine(`Object search: Failed to reveal in tree: ${error}`);
        }
    }

    private async findTreeNode(
        objectName: string,
        schemaName: string,
        typeLabel: string
    ): Promise<ObjectTreeItem | undefined> {
        const treeType = this.typeLabelToTreeType(typeLabel);
        if (!treeType) {
            return undefined;
        }

        const rootNodes = await this.objectTreeProvider.getChildren();
        const schemaNode = await this.findSchemaNode(rootNodes, schemaName, treeType);
        if (!schemaNode) {
            return undefined;
        }

        if (treeType === 'system-table') {
            return this.findChildByNameAndType(
                await this.objectTreeProvider.getChildren(schemaNode),
                objectName,
                'system-table'
            );
        }

        if (treeType === 'virtual-table') {
            return this.findChildByNameAndType(
                await this.objectTreeProvider.getChildren(schemaNode),
                objectName,
                'virtual-table'
            );
        }

        const folderType = this.getFolderType(treeType);
        if (!folderType) {
            return undefined;
        }

        const schemaChildren = await this.objectTreeProvider.getChildren(schemaNode);
        const folderNode = this.findChildByType(schemaChildren, folderType);
        if (!folderNode) {
            return undefined;
        }

        if (treeType === 'column') {
            return this.findColumnInFolder(folderNode, objectName);
        }

        return this.findChildByNameAndType(
            await this.objectTreeProvider.getChildren(folderNode),
            objectName,
            treeType
        );
    }

    private async findSchemaNode(
        rootNodes: Array<ObjectTreeItem | { label?: string | vscode.TreeItemLabel }>,
        schemaName: string,
        treeType: ObjectTreeItemType
    ): Promise<ObjectTreeItem | undefined> {
        if (treeType === 'system-table') {
            const systemSchemasFolder = rootNodes.find(
                node => node instanceof ObjectTreeItem && node.type === 'system-schemas-folder'
            ) as ObjectTreeItem | undefined;

            if (!systemSchemasFolder) {
                return undefined;
            }

            const systemSchemas = await this.objectTreeProvider.getChildren(systemSchemasFolder);
            return systemSchemas.find(
                node => node instanceof ObjectTreeItem &&
                    node.type === 'system-schema' &&
                    node.schemaName === schemaName
            ) as ObjectTreeItem | undefined;
        }

        return rootNodes.find(
            node => node instanceof ObjectTreeItem &&
                (node.type === 'schema' || node.type === 'virtual-schema') &&
                node.schemaName === schemaName
        ) as ObjectTreeItem | undefined;
    }

    private getFolderType(objectType: ObjectTreeItemType): ObjectTreeItemType | undefined {
        switch (objectType) {
            case 'table': return 'tables-folder';
            case 'view': return 'views-folder';
            case 'script': return 'udfs-folder';
            case 'function': return 'functions-folder';
            case 'column': return 'tables-folder';
            default: return undefined;
        }
    }

    private findChildByType(
        children: Array<ObjectTreeItem | { label?: string | vscode.TreeItemLabel }>,
        type: ObjectTreeItemType
    ): ObjectTreeItem | undefined {
        return children.find(
            node => node instanceof ObjectTreeItem && node.type === type
        ) as ObjectTreeItem | undefined;
    }

    private findChildByNameAndType(
        children: Array<ObjectTreeItem | { label?: string | vscode.TreeItemLabel }>,
        name: string,
        type: ObjectTreeItemType
    ): ObjectTreeItem | undefined {
        return children.find(node => {
            if (!(node instanceof ObjectTreeItem)) {
                return false;
            }
            if (node.type !== type) {
                return false;
            }
            const nodeLabel = typeof node.label === 'string' ? node.label : node.label?.label;
            return nodeLabel === name;
        }) as ObjectTreeItem | undefined;
    }

    private async findColumnInFolder(
        folderNode: ObjectTreeItem,
        columnName: string
    ): Promise<ObjectTreeItem | undefined> {
        const tables = await this.objectTreeProvider.getChildren(folderNode);
        for (const table of tables) {
            if (!(table instanceof ObjectTreeItem)) {
                continue;
            }
            const columns = await this.objectTreeProvider.getChildren(table);
            const match = columns.find(col => {
                if (!(col instanceof ObjectTreeItem) || col.type !== 'column') {
                    return false;
                }
                return col.columnInfo?.name === columnName;
            });
            if (match) {
                return match as ObjectTreeItem;
            }
        }
        return undefined;
    }

    private typeLabelToTreeType(typeLabel: string): ObjectTreeItemType | undefined {
        switch (typeLabel) {
            case 'Table': return 'table';
            case 'View': return 'view';
            case 'Script': return 'script';
            case 'Function': return 'function';
            case 'Virtual Table': return 'virtual-table';
            case 'System Table': return 'system-table';
            case 'Column': return 'column';
            default: return undefined;
        }
    }
}
