import * as assert from 'assert';
import * as vscode from 'vscode';
import { ObjectTreeItem, ObjectTreeProvider } from '../providers/objectTreeProvider';
import { fetchVirtualSchemas, fetchVirtualTables, fetchVirtualColumns } from '../providers/objectTreeFetchers';
import { TEST_CONNECTION, createRawResult, MockConnectionManager, asConnectionManager } from './helpers/mockConnectionManager';

const connection = TEST_CONNECTION;

suite('ObjectTreeProvider Virtual Schemas', () => {

    suite('fetchVirtualSchemas', () => {
        test('returns virtual schema data from EXA_ALL_VIRTUAL_SCHEMAS', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('EXA_ALL_VIRTUAL_SCHEMAS')) {
                        return createRawResult(
                            ['SCHEMA_NAME', 'ADAPTER_SCRIPT_SCHEMA', 'ADAPTER_SCRIPT_NAME', 'LAST_REFRESH', 'LAST_REFRESH_BY'],
                            [
                                ['VS_S3', 'ADAPTER_SCHEMA', 'S3_ADAPTER', '2024-01-15 10:30:00', 'SYS'],
                                ['VS_JDBC', 'ADAPTER_SCHEMA', 'JDBC_ADAPTER', '2024-01-16 11:00:00', 'ADMIN']
                            ]
                        );
                    }
                    throw new Error('Unexpected query');
                }
            };

            const manager = new MockConnectionManager(driver, connection);

            const schemas = await fetchVirtualSchemas(asConnectionManager(manager), connection);

            assert.strictEqual(schemas.length, 2);
            assert.strictEqual(schemas[0].name, 'VS_S3');
            assert.strictEqual(schemas[0].adapterName, 'S3_ADAPTER');
            assert.strictEqual(schemas[0].lastRefresh, '2024-01-15 10:30:00');
            assert.strictEqual(schemas[0].lastRefreshBy, 'SYS');
            assert.strictEqual(schemas[1].name, 'VS_JDBC');
            assert.strictEqual(schemas[1].adapterName, 'JDBC_ADAPTER');
        });

        test('returns empty array on query failure', async () => {
            const driver = {
                async query() {
                    throw new Error('table not found');
                }
            };

            const manager = new MockConnectionManager(driver, connection);

            const schemas = await fetchVirtualSchemas(asConnectionManager(manager), connection);

            assert.strictEqual(schemas.length, 0);
        });
    });

    suite('fetchVirtualTables', () => {
        test('returns virtual tables for a virtual schema', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('EXA_ALL_VIRTUAL_TABLES')) {
                        assert.ok(sql.includes("'VS_S3'"), 'query should filter by virtual schema name');
                        return createRawResult(
                            ['TABLE_NAME'],
                            [
                                ['BUCKET_DATA'],
                                ['LOG_FILES']
                            ]
                        );
                    }
                    throw new Error('Unexpected query');
                }
            };

            const manager = new MockConnectionManager(driver, connection);

            const tables = await fetchVirtualTables(asConnectionManager(manager), connection, 'VS_S3');

            assert.strictEqual(tables.length, 2);
            assert.strictEqual(tables[0].name, 'BUCKET_DATA');
            assert.strictEqual(tables[1].name, 'LOG_FILES');
        });

        test('returns empty array on query failure', async () => {
            const driver = {
                async query() {
                    throw new Error('table not found');
                }
            };

            const manager = new MockConnectionManager(driver, connection);

            const tables = await fetchVirtualTables(asConnectionManager(manager), connection, 'VS_S3');

            assert.strictEqual(tables.length, 0);
        });
    });

    suite('fetchVirtualColumns', () => {
        test('returns virtual columns for a virtual table', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('EXA_ALL_COLUMNS')) {
                        assert.ok(!sql.includes('EXA_ALL_VIRTUAL_COLUMNS'), 'EXA_ALL_VIRTUAL_COLUMNS has no type or position columns');
                        assert.ok(sql.includes('ORDER BY COLUMN_ORDINAL_POSITION'), 'columns should keep table order');
                        assert.ok(sql.includes("'VS_S3'"), 'query should filter by virtual schema');
                        assert.ok(sql.includes("'BUCKET_DATA'"), 'query should filter by table name');
                        return createRawResult(
                            ['COLUMN_NAME', 'COLUMN_TYPE', 'COLUMN_IS_NULLABLE'],
                            [
                                ['ID', 'DECIMAL(18,0)', false],
                                ['FILE_PATH', 'VARCHAR(2000)', true],
                                ['SIZE', 'DECIMAL(18,0)', null]
                            ]
                        );
                    }
                    throw new Error('Unexpected query');
                }
            };

            const manager = new MockConnectionManager(driver, connection);

            const columns = await fetchVirtualColumns(asConnectionManager(manager), connection, 'VS_S3', 'BUCKET_DATA');

            assert.strictEqual(columns.length, 3);
            assert.strictEqual(columns[0].name, 'ID');
            assert.strictEqual(columns[0].type, 'DECIMAL(18,0)');
            assert.strictEqual(columns[1].name, 'FILE_PATH');
            assert.strictEqual(columns[1].type, 'VARCHAR(2000)');
            assert.deepStrictEqual(columns.map(c => c.nullable), [false, true, null]);
        });

        test('returns empty array on query failure', async () => {
            const driver = {
                async query() {
                    throw new Error('table not found');
                }
            };

            const manager = new MockConnectionManager(driver, connection);

            const columns = await fetchVirtualColumns(asConnectionManager(manager), connection, 'VS_S3', 'BUCKET_DATA');

            assert.strictEqual(columns.length, 0);
        });
    });

    suite('getChildren lists virtual schemas in the Virtual Schemas folder', () => {
        test('the root lists regular schemas; virtual schemas are inside the folder', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('SYS.EXA_SCHEMAS')) {
                        assert.ok(sql.includes('SCHEMA_IS_VIRTUAL = FALSE'), 'regular schema query must exclude virtual schemas');
                        return createRawResult(
                            ['SCHEMA_NAME', 'TABLE_COUNT', 'VIEW_COUNT'],
                            [
                                ['ALPHA', 5, 2],
                                ['GAMMA', 3, 1]
                            ]
                        );
                    }
                    if (sql.includes('EXA_ALL_VIRTUAL_SCHEMAS')) {
                        return createRawResult(
                            ['SCHEMA_NAME', 'ADAPTER_SCRIPT_SCHEMA', 'ADAPTER_SCRIPT_NAME', 'LAST_REFRESH', 'LAST_REFRESH_BY'],
                            [
                                ['BETA_VS', 'ADAPTER_SCHEMA', 'S3_ADAPTER', '2024-01-15 10:30:00', 'SYS']
                            ]
                        );
                    }
                    throw new Error(`Unexpected query: ${sql}`);
                }
            };

            const manager = new MockConnectionManager(driver, connection);
            const provider = new ObjectTreeProvider(asConnectionManager(manager));

            const roots = await provider.getChildren();
            assert.deepStrictEqual(roots.map(c => c.label), ['ALPHA', 'GAMMA', 'Virtual Schemas', 'Connections', 'System Schemas']);
            assert.deepStrictEqual(roots.slice(0, 2).map(c => (c as ObjectTreeItem).type), ['schema', 'schema']);

            const children = await provider.getChildren(roots[2]);
            assert.strictEqual(children.length, 1);
            assert.strictEqual(children[0].label, 'BETA_VS');
            assert.strictEqual((children[0] as ObjectTreeItem).type, 'virtual-schema');
            assert.strictEqual(children[0].description, 'via S3_ADAPTER');
        });

        test('virtual schema failure does not block regular schemas', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('SYS.EXA_SCHEMAS')) {
                        assert.ok(sql.includes('SCHEMA_IS_VIRTUAL = FALSE'), 'regular schema query must exclude virtual schemas');
                        return createRawResult(
                            ['SCHEMA_NAME', 'TABLE_COUNT', 'VIEW_COUNT'],
                            [
                                ['MY_SCHEMA', 10, 5]
                            ]
                        );
                    }
                    if (sql.includes('EXA_ALL_VIRTUAL_SCHEMAS')) {
                        throw new Error('EXA_ALL_VIRTUAL_SCHEMAS not found');
                    }
                    throw new Error(`Unexpected query: ${sql}`);
                }
            };

            const manager = new MockConnectionManager(driver, connection);
            const provider = new ObjectTreeProvider(asConnectionManager(manager));

            const roots = await provider.getChildren();
            assert.deepStrictEqual(roots.map(c => c.label), ['MY_SCHEMA', 'Virtual Schemas', 'Connections', 'System Schemas']);
            assert.deepStrictEqual(await provider.getChildren(roots[1]), [], 'a failed listing gives an empty folder');
        });
    });

    suite('getChildren for virtual-schema node', () => {
        test('expands virtual schema to show virtual tables', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('EXA_ALL_VIRTUAL_TABLES')) {
                        return createRawResult(
                            ['TABLE_NAME'],
                            [
                                ['TABLE_A'],
                                ['TABLE_B']
                            ]
                        );
                    }
                    throw new Error('Unexpected query');
                }
            };

            const manager = new MockConnectionManager(driver, connection);
            const provider = new ObjectTreeProvider(asConnectionManager(manager));

            const mockElement = new ObjectTreeItem({
                type: 'virtual-schema',
                label: 'VS_S3',
                id: 'conn-1:VS_S3:virtual-schema',
                schemaName: 'VS_S3',
                connection,
                collapsibleState: vscode.TreeItemCollapsibleState.Collapsed
            });

            const children = await provider.getChildren(mockElement);

            assert.strictEqual(children.length, 2);
            assert.strictEqual(children[0].label, 'TABLE_A');
            assert.strictEqual((children[0] as ObjectTreeItem).type, 'virtual-table');
            assert.strictEqual(children[1].label, 'TABLE_B');
            assert.strictEqual((children[1] as ObjectTreeItem).type, 'virtual-table');
        });
    });

    suite('getChildren for virtual-table node', () => {
        test('expands virtual table to show virtual columns', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('EXA_ALL_COLUMNS')) {
                        return createRawResult(
                            ['COLUMN_NAME', 'COLUMN_TYPE', 'COLUMN_IS_NULLABLE'],
                            [
                                ['COL_A', 'INTEGER', false],
                                ['COL_B', 'VARCHAR(100)', true]
                            ]
                        );
                    }
                    throw new Error('Unexpected query');
                }
            };

            const manager = new MockConnectionManager(driver, connection);
            const provider = new ObjectTreeProvider(asConnectionManager(manager));

            const mockElement = new ObjectTreeItem({
                type: 'virtual-table',
                label: 'MY_TABLE',
                id: 'conn-1:VS_S3:MY_TABLE:virtual-table',
                schemaName: 'VS_S3',
                tableInfo: { name: 'MY_TABLE' },
                connection,
                collapsibleState: vscode.TreeItemCollapsibleState.Collapsed
            });

            const children = await provider.getChildren(mockElement);

            assert.strictEqual(children.length, 2);
            assert.strictEqual(children[0].label, 'COL_A (INTEGER)');
            assert.strictEqual((children[0] as ObjectTreeItem).type, 'column');
            assert.strictEqual(children[1].label, 'COL_B (VARCHAR(100))');
            assert.strictEqual(children[0].tooltip, 'COL_A: INTEGER');
            assert.strictEqual(children[1].tooltip, 'COL_B: VARCHAR(100) (nullable)');
        });
    });
});
