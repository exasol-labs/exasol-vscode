export type ObjectTreeItemType =
    | 'schema'
    | 'tables-folder'
    | 'table'
    | 'views-folder'
    | 'view'
    | 'column'
    | 'virtual-schemas-folder'
    | 'virtual-schema'
    | 'virtual-table'
    | 'udfs-folder'
    | 'procedures-folder'
    | 'adapters-folder'
    | 'functions-folder'
    | 'script'
    | 'function'
    | 'constraints-folder'
    | 'indices-folder'
    | 'constraint'
    | 'index'
    | 'system-schemas-folder'
    | 'system-schema'
    | 'system-table'
    | 'schema-group'
    | 'db-connections-folder'
    | 'db-connection';

/** A database CONNECTION object as listed in EXA_ALL_CONNECTIONS. */
export interface DbConnectionInfo {
    name: string;
    created?: string;
    comment?: string;
}

export interface NodeTypeConfig {
    icon: string;
    contextValue: string;
}

export function getNodeTypeConfig(
    type: ObjectTreeItemType,
    metadata?: { scriptType?: string; constraintType?: string }
): NodeTypeConfig | undefined {
    switch (type) {
        case 'schema':
            return { icon: 'symbol-namespace', contextValue: 'schema' };
        case 'tables-folder':
            return { icon: 'folder', contextValue: 'tables-folder' };
        case 'table':
            return { icon: 'table', contextValue: 'table' };
        case 'views-folder':
            return { icon: 'folder', contextValue: 'views-folder' };
        case 'view':
            return { icon: 'eye', contextValue: 'view' };
        case 'column':
            return { icon: '', contextValue: 'column' };
        case 'virtual-schemas-folder':
            return { icon: 'cloud', contextValue: 'virtual-schemas-folder' };
        case 'virtual-schema':
            return { icon: 'remote', contextValue: 'virtual-schema' };
        case 'virtual-table':
            return { icon: 'table', contextValue: 'virtual-table' };
        case 'udfs-folder':
            return { icon: 'folder', contextValue: 'udfs-folder' };
        case 'procedures-folder':
            return { icon: 'folder', contextValue: 'procedures-folder' };
        case 'adapters-folder':
            return { icon: 'folder', contextValue: 'adapters-folder' };
        case 'functions-folder':
            return { icon: 'folder', contextValue: 'functions-folder' };
        case 'script':
            return { icon: getScriptIcon(metadata?.scriptType), contextValue: getScriptContextValue(metadata?.scriptType) };
        case 'function':
            return { icon: 'symbol-function', contextValue: 'function' };
        case 'constraints-folder':
            return { icon: 'folder', contextValue: 'constraints-folder' };
        case 'indices-folder':
            return { icon: 'folder', contextValue: 'indices-folder' };
        case 'constraint':
            return { icon: getConstraintIcon(metadata?.constraintType), contextValue: 'constraint' };
        case 'index':
            return { icon: 'list-tree', contextValue: 'index' };
        case 'system-schemas-folder':
            return { icon: 'library', contextValue: 'system-schemas-folder' };
        case 'schema-group':
            return { icon: 'folder', contextValue: 'schema-group' };
        case 'system-schema':
            return { icon: 'database', contextValue: 'system-schema' };
        case 'system-table':
            return { icon: 'table', contextValue: 'system-table' };
        case 'db-connections-folder':
            return { icon: 'plug', contextValue: 'db-connections-folder' };
        case 'db-connection':
            return { icon: 'link', contextValue: 'db-connection' };
        default:
            return undefined;
    }
}

function getScriptIcon(scriptType?: string): string {
    switch (scriptType) {
        case 'SCRIPTING':
            return 'symbol-event';
        case 'ADAPTER':
            return 'extensions';
        default:
            return 'symbol-method';
    }
}

/** UDF and adapter scripts get their own context menus; other scripts keep 'script'. */
function getScriptContextValue(scriptType?: string): string {
    switch (scriptType) {
        case 'UDF':
            return 'script-udf';
        case 'ADAPTER':
            return 'script-adapter';
        default:
            return 'script';
    }
}

function getConstraintIcon(constraintType?: string): string {
    if (constraintType === 'FOREIGN KEY') {
        return 'link';
    }
    return 'key';
}
