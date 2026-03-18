import * as assert from 'assert';
import { registerVscodeMock, registerExtensionMock } from '../helpers/vscodeMock';

registerVscodeMock();
registerExtensionMock();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ObjectTreeProvider } = require('../../providers/objectTreeProvider');

import { createRawResult, createEmptyRawResult } from '../helpers/mockConnectionManager';
import { MockConnectionManager } from '../helpers/mockConnectionManager';

function getLabelText(item: any): string {
    if (!item || !item.label) { return ''; }
    return typeof item.label === 'string' ? item.label : item.label?.label ?? '';
}

suite('ObjectTreeProvider — getParent()', () => {

    let provider: any;
    let mockDriver: any;

    setup(() => {
        mockDriver = {
            query: async (sql: string) => {
                if (sql.includes('EXA_SCHEMAS')) {
                    return createRawResult(
                        ['SCHEMA_NAME', 'TABLE_COUNT', 'VIEW_COUNT'],
                        [['MY_SCHEMA', 2, 1]]
                    );
                }
                if (sql.includes('EXA_ALL_VIRTUAL_SCHEMAS') && !sql.includes('EXA_ALL_VIRTUAL_TABLES')) {
                    return createEmptyRawResult(['SCHEMA_NAME']);
                }
                if (sql.includes('EXA_ALL_VIRTUAL_TABLES')) {
                    return createEmptyRawResult(['TABLE_SCHEMA', 'TABLE_NAME']);
                }
                if (sql.includes('EXA_ALL_TABLES') && sql.includes('MY_SCHEMA')) {
                    return createRawResult(
                        ['TABLE_NAME', 'TABLE_ROW_COUNT'],
                        [['USERS', 100], ['ORDERS', 200]]
                    );
                }
                if (sql.includes('EXA_ALL_VIEWS') && sql.includes('MY_SCHEMA')) {
                    return createRawResult(
                        ['VIEW_NAME'],
                        [['ACTIVE_USERS']]
                    );
                }
                if (sql.includes('EXA_ALL_COLUMNS') && sql.includes('USERS')) {
                    return createRawResult(
                        ['COLUMN_NAME', 'COLUMN_TYPE', 'COLUMN_IS_NULLABLE'],
                        [['ID', 'DECIMAL(18,0)', false], ['NAME', 'VARCHAR(100)', true]]
                    );
                }
                if (sql.includes('SCRIPT_TYPE') && sql.includes('COUNT')) {
                    return createEmptyRawResult(['SCRIPT_TYPE', 'CNT']);
                }
                if (sql.includes('EXA_ALL_FUNCTIONS') && sql.includes('COUNT')) {
                    return createRawResult(['CNT'], [[0]]);
                }
                if (sql.includes('EXA_ALL_CONSTRAINTS') && sql.includes('COUNT')) {
                    return createRawResult(['CNT'], [[0]]);
                }
                if (sql.includes('EXA_ALL_INDICES') && sql.includes('COUNT')) {
                    return createRawResult(['CNT'], [[0]]);
                }
                if (sql.includes('EXA_SYSCAT')) {
                    return createRawResult(
                        ['OBJECT_NAME'],
                        [['EXA_ALL_COLUMNS']]
                    );
                }
                if (sql.includes('DESCRIBE')) {
                    return createRawResult(
                        ['COLUMN_NAME', 'SQL_TYPE'],
                        [['COL1', 'VARCHAR(128) UTF8']]
                    );
                }
                return createEmptyRawResult(['DUMMY']);
            }
        };
        const mockCM = new MockConnectionManager(mockDriver);
        provider = new ObjectTreeProvider(mockCM);
    });

    test('getParent exists and is a function', () => {
        assert.strictEqual(typeof provider.getParent, 'function');
    });

    test('root schemas have null parent', async () => {
        const rootChildren = await provider.getChildren();
        const schema = rootChildren.find((c: any) => getLabelText(c) === 'MY_SCHEMA');
        assert.ok(schema, 'Should find MY_SCHEMA');
        const parent = provider.getParent(schema);
        assert.strictEqual(parent, null, 'Schema parent should be null');
    });

    test('system-schemas-folder has null parent', async () => {
        const rootChildren = await provider.getChildren();
        const folder = rootChildren.find((c: any) => getLabelText(c) === 'System Schemas');
        assert.ok(folder, 'Should find System Schemas folder');
        const parent = provider.getParent(folder);
        assert.strictEqual(parent, null, 'System-schemas-folder parent should be null');
    });

    test('tables-folder parent is schema', async () => {
        const rootChildren = await provider.getChildren();
        const schema = rootChildren.find((c: any) => getLabelText(c) === 'MY_SCHEMA');
        const schemaChildren = await provider.getChildren(schema);
        const tablesFolder = schemaChildren.find((c: any) => getLabelText(c) === 'Tables');
        assert.ok(tablesFolder, 'Should find Tables folder');
        const parent = provider.getParent(tablesFolder);
        assert.strictEqual(parent, schema, 'Tables-folder parent should be the schema');
    });

    test('views-folder parent is schema', async () => {
        const rootChildren = await provider.getChildren();
        const schema = rootChildren.find((c: any) => getLabelText(c) === 'MY_SCHEMA');
        const schemaChildren = await provider.getChildren(schema);
        const viewsFolder = schemaChildren.find((c: any) => getLabelText(c) === 'Views');
        assert.ok(viewsFolder, 'Should find Views folder');
        const parent = provider.getParent(viewsFolder);
        assert.strictEqual(parent, schema, 'Views-folder parent should be the schema');
    });

    test('table parent is tables-folder', async () => {
        const rootChildren = await provider.getChildren();
        const schema = rootChildren.find((c: any) => getLabelText(c) === 'MY_SCHEMA');
        const schemaChildren = await provider.getChildren(schema);
        const tablesFolder = schemaChildren.find((c: any) => getLabelText(c) === 'Tables');
        const tables = await provider.getChildren(tablesFolder);
        const usersTable = tables.find((c: any) => getLabelText(c) === 'USERS');
        assert.ok(usersTable, 'Should find USERS table');
        const parent = provider.getParent(usersTable);
        assert.strictEqual(parent, tablesFolder, 'Table parent should be tables-folder');
    });

    test('column parent is table', async () => {
        const rootChildren = await provider.getChildren();
        const schema = rootChildren.find((c: any) => getLabelText(c) === 'MY_SCHEMA');
        const schemaChildren = await provider.getChildren(schema);
        const tablesFolder = schemaChildren.find((c: any) => getLabelText(c) === 'Tables');
        const tables = await provider.getChildren(tablesFolder);
        const usersTable = tables.find((c: any) => getLabelText(c) === 'USERS');
        const columns = await provider.getChildren(usersTable);
        assert.ok(columns.length > 0, 'Should have columns');
        const parent = provider.getParent(columns[0]);
        assert.strictEqual(parent, usersTable, 'Column parent should be the table');
    });

    test('system-schema parent is system-schemas-folder', async () => {
        const rootChildren = await provider.getChildren();
        const systemSchemasFolder = rootChildren.find(
            (c: any) => getLabelText(c) === 'System Schemas'
        );
        const systemSchemas = await provider.getChildren(systemSchemasFolder);
        const sysNode = systemSchemas.find((c: any) => getLabelText(c) === 'SYS');
        assert.ok(sysNode, 'Should find SYS');
        const parent = provider.getParent(sysNode);
        assert.strictEqual(parent, systemSchemasFolder, 'System-schema parent should be system-schemas-folder');
    });

    test('system-table parent is system-schema', async () => {
        const rootChildren = await provider.getChildren();
        const systemSchemasFolder = rootChildren.find(
            (c: any) => getLabelText(c) === 'System Schemas'
        );
        const systemSchemas = await provider.getChildren(systemSchemasFolder);
        const sysNode = systemSchemas.find((c: any) => getLabelText(c) === 'SYS');
        const tables = await provider.getChildren(sysNode);
        assert.ok(tables.length > 0, 'Should have system tables');
        const parent = provider.getParent(tables[0]);
        assert.strictEqual(parent, sysNode, 'System-table parent should be system-schema');
    });

    test('view parent is views-folder', async () => {
        const rootChildren = await provider.getChildren();
        const schema = rootChildren.find((c: any) => getLabelText(c) === 'MY_SCHEMA');
        const schemaChildren = await provider.getChildren(schema);
        const viewsFolder = schemaChildren.find((c: any) => getLabelText(c) === 'Views');
        const views = await provider.getChildren(viewsFolder);
        const activeUsersView = views.find((c: any) => getLabelText(c) === 'ACTIVE_USERS');
        assert.ok(activeUsersView, 'Should find ACTIVE_USERS view');
        const parent = provider.getParent(activeUsersView);
        assert.strictEqual(parent, viewsFolder, 'View parent should be views-folder');
    });
});

suite('ObjectTreeProvider — getParent() extended node types', () => {

    let provider: any;
    let mockDriver: any;

    setup(() => {
        mockDriver = {
            query: async (sql: string) => {
                if (sql.includes('EXA_SCHEMAS')) {
                    return createRawResult(
                        ['SCHEMA_NAME', 'TABLE_COUNT', 'VIEW_COUNT'],
                        [['TEST_SCHEMA', 1, 0]]
                    );
                }
                if (sql.includes('EXA_ALL_VIRTUAL_SCHEMAS') && !sql.includes('EXA_ALL_VIRTUAL_TABLES')) {
                    return createRawResult(
                        ['SCHEMA_NAME', 'ADAPTER_SCRIPT_SCHEMA', 'ADAPTER_SCRIPT_NAME', 'LAST_REFRESH', 'LAST_REFRESH_BY'],
                        [['VS_ORACLE', 'MY_SCHEMA', 'ORA_ADAPTER', null, null]]
                    );
                }
                if (sql.includes('EXA_ALL_VIRTUAL_TABLES') && sql.includes('VS_ORACLE')) {
                    return createRawResult(
                        ['TABLE_NAME'],
                        [['REMOTE_TABLE']]
                    );
                }
                if (sql.includes('EXA_ALL_VIRTUAL_TABLES')) {
                    return createEmptyRawResult(['TABLE_NAME']);
                }
                if (sql.includes('EXA_ALL_TABLES') && sql.includes('TEST_SCHEMA')) {
                    return createRawResult(
                        ['TABLE_NAME', 'TABLE_ROW_COUNT'],
                        [['MY_TABLE', 50]]
                    );
                }
                if (sql.includes('EXA_ALL_VIEWS') && sql.includes('TEST_SCHEMA')) {
                    return createEmptyRawResult(['VIEW_NAME']);
                }
                if (sql.includes('EXA_ALL_COLUMNS') && sql.includes('MY_TABLE')) {
                    return createRawResult(
                        ['COLUMN_NAME', 'COLUMN_TYPE', 'COLUMN_IS_NULLABLE'],
                        [['COL_A', 'INTEGER', false]]
                    );
                }
                if (sql.includes('SCRIPT_TYPE') && sql.includes('COUNT')) {
                    return createRawResult(
                        ['SCRIPT_TYPE', 'SCRIPT_COUNT'],
                        [['UDF', 1], ['SCRIPTING', 1], ['ADAPTER', 1]]
                    );
                }
                if (sql.includes('EXA_ALL_SCRIPTS') && sql.includes('UDF')) {
                    return createRawResult(
                        ['SCRIPT_NAME', 'SCRIPT_LANGUAGE', 'SCRIPT_INPUT_TYPE', 'SCRIPT_TYPE'],
                        [['MY_UDF', 'PYTHON3', 'SCALAR', 'UDF']]
                    );
                }
                if (sql.includes('EXA_ALL_SCRIPTS') && sql.includes('SCRIPTING')) {
                    return createRawResult(
                        ['SCRIPT_NAME', 'SCRIPT_LANGUAGE', 'SCRIPT_INPUT_TYPE', 'SCRIPT_TYPE'],
                        [['MY_PROC', 'LUA', null, 'SCRIPTING']]
                    );
                }
                if (sql.includes('EXA_ALL_SCRIPTS') && sql.includes('ADAPTER')) {
                    return createRawResult(
                        ['SCRIPT_NAME', 'SCRIPT_LANGUAGE', 'SCRIPT_INPUT_TYPE', 'SCRIPT_TYPE'],
                        [['ORA_ADAPTER', 'JAVA', null, 'ADAPTER']]
                    );
                }
                if (sql.includes('EXA_ALL_FUNCTIONS') && sql.includes('COUNT')) {
                    return createRawResult(['FUNCTION_COUNT'], [[1]]);
                }
                if (sql.includes('FUNCTION_NAME') && sql.includes('TEST_SCHEMA')) {
                    return createRawResult(
                        ['FUNCTION_NAME'],
                        [['MY_FUNC']]
                    );
                }
                if (sql.includes('EXA_ALL_CONSTRAINTS') && sql.includes('COUNT')) {
                    return createRawResult(['CONSTRAINT_COUNT'], [[1]]);
                }
                if (sql.includes('CONSTRAINT_NAME') && sql.includes('MY_TABLE')) {
                    return createRawResult(
                        ['CONSTRAINT_NAME', 'CONSTRAINT_TYPE'],
                        [['PK_MY_TABLE', 'PRIMARY KEY']]
                    );
                }
                if (sql.includes('EXA_ALL_INDICES') && sql.includes('COUNT')) {
                    return createRawResult(['INDEX_COUNT'], [[1]]);
                }
                if (sql.includes('INDEX_NAME') && sql.includes('MY_TABLE')) {
                    return createRawResult(
                        ['INDEX_NAME', 'INDEX_TYPE', 'INDEX_COLUMNS'],
                        [['IDX_COL_A', 'LOCAL', 'COL_A']]
                    );
                }
                if (sql.includes('EXA_SYSCAT')) {
                    return createRawResult(
                        ['OBJECT_NAME'],
                        [['EXA_ALL_COLUMNS']]
                    );
                }
                if (sql.includes('DESCRIBE')) {
                    return createRawResult(
                        ['COLUMN_NAME', 'SQL_TYPE'],
                        [['VC1', 'VARCHAR(128) UTF8']]
                    );
                }
                return createEmptyRawResult(['DUMMY']);
            }
        };
        const mockCM = new MockConnectionManager(mockDriver);
        provider = new ObjectTreeProvider(mockCM);
    });

    test('virtual-schema has null parent', async () => {
        const rootChildren = await provider.getChildren();
        const vs = rootChildren.find((c: any) => getLabelText(c) === 'VS_ORACLE');
        assert.ok(vs, 'Should find VS_ORACLE');
        const parent = provider.getParent(vs);
        assert.strictEqual(parent, null, 'Virtual-schema parent should be null');
    });

    test('virtual-table parent is virtual-schema', async () => {
        const rootChildren = await provider.getChildren();
        const vs = rootChildren.find((c: any) => getLabelText(c) === 'VS_ORACLE');
        const vsTables = await provider.getChildren(vs);
        const remoteTable = vsTables.find((c: any) => getLabelText(c) === 'REMOTE_TABLE');
        assert.ok(remoteTable, 'Should find REMOTE_TABLE');
        const parent = provider.getParent(remoteTable);
        assert.strictEqual(parent, vs, 'Virtual-table parent should be virtual-schema');
    });

    test('script parent is udfs-folder', async () => {
        const rootChildren = await provider.getChildren();
        const schema = rootChildren.find((c: any) => getLabelText(c) === 'TEST_SCHEMA');
        const schemaChildren = await provider.getChildren(schema);
        const udfsFolder = schemaChildren.find((c: any) => getLabelText(c) === 'UDFs');
        assert.ok(udfsFolder, 'Should find UDFs folder');
        const scripts = await provider.getChildren(udfsFolder);
        const myUdf = scripts.find((c: any) => getLabelText(c) === 'MY_UDF');
        assert.ok(myUdf, 'Should find MY_UDF script');
        const parent = provider.getParent(myUdf);
        assert.strictEqual(parent, udfsFolder, 'Script parent should be udfs-folder');
    });

    test('script parent is procedures-folder', async () => {
        const rootChildren = await provider.getChildren();
        const schema = rootChildren.find((c: any) => getLabelText(c) === 'TEST_SCHEMA');
        const schemaChildren = await provider.getChildren(schema);
        const procsFolder = schemaChildren.find((c: any) => getLabelText(c) === 'Procedures');
        assert.ok(procsFolder, 'Should find Procedures folder');
        const scripts = await provider.getChildren(procsFolder);
        const myProc = scripts.find((c: any) => getLabelText(c) === 'MY_PROC');
        assert.ok(myProc, 'Should find MY_PROC script');
        const parent = provider.getParent(myProc);
        assert.strictEqual(parent, procsFolder, 'Script parent should be procedures-folder');
    });

    test('script parent is adapters-folder', async () => {
        const rootChildren = await provider.getChildren();
        const schema = rootChildren.find((c: any) => getLabelText(c) === 'TEST_SCHEMA');
        const schemaChildren = await provider.getChildren(schema);
        const adaptersFolder = schemaChildren.find((c: any) => getLabelText(c) === 'Adapters');
        assert.ok(adaptersFolder, 'Should find Adapters folder');
        const scripts = await provider.getChildren(adaptersFolder);
        const adapter = scripts.find((c: any) => getLabelText(c) === 'ORA_ADAPTER');
        assert.ok(adapter, 'Should find ORA_ADAPTER script');
        const parent = provider.getParent(adapter);
        assert.strictEqual(parent, adaptersFolder, 'Script parent should be adapters-folder');
    });

    test('function parent is functions-folder', async () => {
        const rootChildren = await provider.getChildren();
        const schema = rootChildren.find((c: any) => getLabelText(c) === 'TEST_SCHEMA');
        const schemaChildren = await provider.getChildren(schema);
        const functionsFolder = schemaChildren.find((c: any) => getLabelText(c) === 'Functions');
        assert.ok(functionsFolder, 'Should find Functions folder');
        const functions = await provider.getChildren(functionsFolder);
        const myFunc = functions.find((c: any) => getLabelText(c) === 'MY_FUNC');
        assert.ok(myFunc, 'Should find MY_FUNC');
        const parent = provider.getParent(myFunc);
        assert.strictEqual(parent, functionsFolder, 'Function parent should be functions-folder');
    });

    test('constraint parent is constraints-folder', async () => {
        const rootChildren = await provider.getChildren();
        const schema = rootChildren.find((c: any) => getLabelText(c) === 'TEST_SCHEMA');
        const schemaChildren = await provider.getChildren(schema);
        const tablesFolder = schemaChildren.find((c: any) => getLabelText(c) === 'Tables');
        const tables = await provider.getChildren(tablesFolder);
        const myTable = tables.find((c: any) => getLabelText(c) === 'MY_TABLE');
        const tableChildren = await provider.getChildren(myTable);
        const constraintsFolder = tableChildren.find((c: any) => getLabelText(c) === 'Constraints');
        assert.ok(constraintsFolder, 'Should find Constraints folder');
        const constraints = await provider.getChildren(constraintsFolder);
        const pk = constraints.find((c: any) => getLabelText(c) === 'PK_MY_TABLE');
        assert.ok(pk, 'Should find PK_MY_TABLE');
        const parent = provider.getParent(pk);
        assert.strictEqual(parent, constraintsFolder, 'Constraint parent should be constraints-folder');
    });

    test('index parent is indices-folder', async () => {
        const rootChildren = await provider.getChildren();
        const schema = rootChildren.find((c: any) => getLabelText(c) === 'TEST_SCHEMA');
        const schemaChildren = await provider.getChildren(schema);
        const tablesFolder = schemaChildren.find((c: any) => getLabelText(c) === 'Tables');
        const tables = await provider.getChildren(tablesFolder);
        const myTable = tables.find((c: any) => getLabelText(c) === 'MY_TABLE');
        const tableChildren = await provider.getChildren(myTable);
        const indicesFolder = tableChildren.find((c: any) => getLabelText(c) === 'Indices');
        assert.ok(indicesFolder, 'Should find Indices folder');
        const indices = await provider.getChildren(indicesFolder);
        const idx = indices.find((c: any) => getLabelText(c) === 'IDX_COL_A');
        assert.ok(idx, 'Should find IDX_COL_A');
        const parent = provider.getParent(idx);
        assert.strictEqual(parent, indicesFolder, 'Index parent should be indices-folder');
    });
});
