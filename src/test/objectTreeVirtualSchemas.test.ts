import * as assert from 'assert';
import { ObjectTreeProvider } from '../providers/objectTreeProvider';
import { TEST_CONNECTION, createRawResult, MockConnectionManager } from './helpers/mockConnectionManager';

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
            const provider = new ObjectTreeProvider(manager as any);

            const schemas = await (provider as any).fetchVirtualSchemas(connection);

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
            const provider = new ObjectTreeProvider(manager as any);

            const schemas = await (provider as any).fetchVirtualSchemas(connection);

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
            const provider = new ObjectTreeProvider(manager as any);

            const tables = await (provider as any).fetchVirtualTables(connection, 'VS_S3');

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
            const provider = new ObjectTreeProvider(manager as any);

            const tables = await (provider as any).fetchVirtualTables(connection, 'VS_S3');

            assert.strictEqual(tables.length, 0);
        });
    });

    suite('fetchVirtualColumns', () => {
        test('returns virtual columns for a virtual table', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('EXA_ALL_VIRTUAL_COLUMNS')) {
                        assert.ok(sql.includes("'VS_S3'"), 'query should filter by virtual schema');
                        assert.ok(sql.includes("'BUCKET_DATA'"), 'query should filter by table name');
                        return createRawResult(
                            ['COLUMN_NAME', 'COLUMN_TYPE'],
                            [
                                ['ID', 'DECIMAL(18,0)'],
                                ['FILE_PATH', 'VARCHAR(2000)'],
                                ['SIZE', 'DECIMAL(18,0)']
                            ]
                        );
                    }
                    throw new Error('Unexpected query');
                }
            };

            const manager = new MockConnectionManager(driver, connection);
            const provider = new ObjectTreeProvider(manager as any);

            const columns = await (provider as any).fetchVirtualColumns(connection, 'VS_S3', 'BUCKET_DATA');

            assert.strictEqual(columns.length, 3);
            assert.strictEqual(columns[0].name, 'ID');
            assert.strictEqual(columns[0].type, 'DECIMAL(18,0)');
            assert.strictEqual(columns[1].name, 'FILE_PATH');
            assert.strictEqual(columns[1].type, 'VARCHAR(2000)');
        });

        test('returns empty array on query failure', async () => {
            const driver = {
                async query() {
                    throw new Error('table not found');
                }
            };

            const manager = new MockConnectionManager(driver, connection);
            const provider = new ObjectTreeProvider(manager as any);

            const columns = await (provider as any).fetchVirtualColumns(connection, 'VS_S3', 'BUCKET_DATA');

            assert.strictEqual(columns.length, 0);
        });
    });

    suite('getChildren merges virtual schemas with regular schemas', () => {
        test('virtual schemas appear sorted alongside regular schemas at root level', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('EXA_SCHEMAS') && !sql.includes('VIRTUAL')) {
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
            const provider = new ObjectTreeProvider(manager as any);

            const children = await provider.getChildren();

            assert.strictEqual(children.length, 3, 'Should have 3 items total');
            assert.strictEqual((children[0] as any).label, 'ALPHA');
            assert.strictEqual((children[0] as any).type, 'schema');
            assert.strictEqual((children[1] as any).label, 'BETA_VS');
            assert.strictEqual((children[1] as any).type, 'virtual-schema');
            assert.strictEqual((children[2] as any).label, 'GAMMA');
            assert.strictEqual((children[2] as any).type, 'schema');
        });

        test('virtual schema failure does not block regular schemas', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('EXA_SCHEMAS') && !sql.includes('VIRTUAL')) {
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
            const provider = new ObjectTreeProvider(manager as any);

            const children = await provider.getChildren();

            assert.strictEqual(children.length, 1, 'Regular schemas should still load');
            assert.strictEqual((children[0] as any).label, 'MY_SCHEMA');
            assert.strictEqual((children[0] as any).type, 'schema');
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
            const provider = new ObjectTreeProvider(manager as any);

            const mockElement = {
                type: 'virtual-schema',
                label: 'VS_S3',
                schemaName: 'VS_S3',
                connection
            };

            const children = await provider.getChildren(mockElement as any);

            assert.strictEqual(children.length, 2);
            assert.strictEqual((children[0] as any).label, 'TABLE_A');
            assert.strictEqual((children[0] as any).type, 'virtual-table');
            assert.strictEqual((children[1] as any).label, 'TABLE_B');
            assert.strictEqual((children[1] as any).type, 'virtual-table');
        });
    });

    suite('getChildren for virtual-table node', () => {
        test('expands virtual table to show virtual columns', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('EXA_ALL_VIRTUAL_COLUMNS')) {
                        return createRawResult(
                            ['COLUMN_NAME', 'COLUMN_TYPE'],
                            [
                                ['COL_A', 'INTEGER'],
                                ['COL_B', 'VARCHAR(100)']
                            ]
                        );
                    }
                    throw new Error('Unexpected query');
                }
            };

            const manager = new MockConnectionManager(driver, connection);
            const provider = new ObjectTreeProvider(manager as any);

            const mockElement = {
                type: 'virtual-table',
                label: 'MY_TABLE',
                schemaName: 'VS_S3',
                tableInfo: { name: 'MY_TABLE' },
                connection
            };

            const children = await provider.getChildren(mockElement as any);

            assert.strictEqual(children.length, 2);
            assert.strictEqual((children[0] as any).label, 'COL_A (INTEGER)');
            assert.strictEqual((children[0] as any).type, 'column');
            assert.strictEqual((children[1] as any).label, 'COL_B (VARCHAR(100))');
        });
    });
});
