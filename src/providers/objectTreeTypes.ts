export type ObjectTreeItemType =
    | 'schema'
    | 'tables-folder'
    | 'table'
    | 'views-folder'
    | 'view'
    | 'column'
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
    | 'schema-group';

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
            return { icon: getScriptIcon(metadata?.scriptType), contextValue: 'script' };
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

function getConstraintIcon(constraintType?: string): string {
    if (constraintType === 'FOREIGN KEY') {
        return 'link';
    }
    return 'key';
}
