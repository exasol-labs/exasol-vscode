import * as assert from 'assert';
import { ObjectTreeProvider } from '../providers/objectTreeProvider';
import { TEST_CONNECTION, createRawResult, MockConnectionManager } from './helpers/mockConnectionManager';

const connection = TEST_CONNECTION;

suite('ObjectTreeProvider Constraints & Indices', () => {

    suite('fetchConstraints', () => {
        test('returns constraint nodes with name, type, and correct icon metadata', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('EXA_ALL_CONSTRAINTS')) {
                        return createRawResult(
                            ['CONSTRAINT_NAME', 'CONSTRAINT_TYPE'],
                            [
                                ['PK_USERS', 'PRIMARY KEY'],
                                ['FK_ORDERS_USER', 'FOREIGN KEY'],
                                ['NN_EMAIL', 'NOT NULL']
                            ]
                        );
                    }
                    throw new Error('Unexpected query');
                }
            };

            const manager = new MockConnectionManager(driver);
            const provider = new ObjectTreeProvider(manager as any);

            const constraints = await (provider as any).fetchConstraints(connection, 'TEST_SCHEMA', 'USERS');

            assert.strictEqual(constraints.length, 3);
            assert.strictEqual(constraints[0].name, 'PK_USERS');
            assert.strictEqual(constraints[0].type, 'PRIMARY KEY');
            assert.strictEqual(constraints[1].name, 'FK_ORDERS_USER');
            assert.strictEqual(constraints[1].type, 'FOREIGN KEY');
            assert.strictEqual(constraints[2].name, 'NN_EMAIL');
            assert.strictEqual(constraints[2].type, 'NOT NULL');
        });

        test('returns empty array on query error', async () => {
            const driver = {
                async query() { throw new Error('Connection failed'); }
            };

            const manager = new MockConnectionManager(driver);
            const provider = new ObjectTreeProvider(manager as any);

            const constraints = await (provider as any).fetchConstraints(connection, 'TEST_SCHEMA', 'USERS');
            assert.deepStrictEqual(constraints, []);
        });
    });

    suite('fetchConstraintColumns', () => {
        test('returns column names for a constraint', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('EXA_ALL_CONSTRAINT_COLUMNS')) {
                        return createRawResult(
                            ['COLUMN_NAME', 'ORDINAL_POSITION'],
                            [
                                ['USER_ID', 1],
                                ['EMAIL', 2]
                            ]
                        );
                    }
                    throw new Error('Unexpected query');
                }
            };

            const manager = new MockConnectionManager(driver);
            const provider = new ObjectTreeProvider(manager as any);

            const columns = await (provider as any).fetchConstraintColumns(
                connection, 'TEST_SCHEMA', 'USERS', 'PK_USERS'
            );

            assert.strictEqual(columns.length, 2);
            assert.strictEqual(columns[0].name, 'USER_ID');
            assert.strictEqual(columns[1].name, 'EMAIL');
        });

        test('returns empty array on query error', async () => {
            const driver = {
                async query() { throw new Error('Connection failed'); }
            };

            const manager = new MockConnectionManager(driver);
            const provider = new ObjectTreeProvider(manager as any);

            const columns = await (provider as any).fetchConstraintColumns(
                connection, 'TEST_SCHEMA', 'USERS', 'PK_USERS'
            );
            assert.deepStrictEqual(columns, []);
        });
    });

    suite('fetchIndices', () => {
        test('returns index nodes with name and column list', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('EXA_ALL_INDICES')) {
                        return createRawResult(
                            ['INDEX_NAME', 'INDEX_TYPE', 'INDEX_COLUMNS'],
                            [
                                ['IDX_EMAIL', 'LOCAL', 'EMAIL'],
                                ['IDX_NAME_DOB', 'LOCAL', 'LAST_NAME, DATE_OF_BIRTH']
                            ]
                        );
                    }
                    throw new Error('Unexpected query');
                }
            };

            const manager = new MockConnectionManager(driver);
            const provider = new ObjectTreeProvider(manager as any);

            const indices = await (provider as any).fetchIndices(connection, 'TEST_SCHEMA', 'USERS');

            assert.strictEqual(indices.length, 2);
            assert.strictEqual(indices[0].name, 'IDX_EMAIL');
            assert.strictEqual(indices[0].columns, 'EMAIL');
            assert.strictEqual(indices[1].name, 'IDX_NAME_DOB');
            assert.strictEqual(indices[1].columns, 'LAST_NAME, DATE_OF_BIRTH');
        });

        test('returns empty array on query error', async () => {
            const driver = {
                async query() { throw new Error('Connection failed'); }
            };

            const manager = new MockConnectionManager(driver);
            const provider = new ObjectTreeProvider(manager as any);

            const indices = await (provider as any).fetchIndices(connection, 'TEST_SCHEMA', 'USERS');
            assert.deepStrictEqual(indices, []);
        });
    });

    suite('table node expansion with constraints and indices folders', () => {
        test('includes Constraints and Indices folders when counts are non-zero', async () => {
            const driver = {
                async query(sql: string) {
                    // Column query
                    if (sql.includes('EXA_ALL_COLUMNS') && !sql.includes('COUNT')) {
                        return createRawResult(
                            ['COLUMN_NAME', 'COLUMN_TYPE', 'COLUMN_IS_NULLABLE'],
                            [['ID', 'DECIMAL(18,0)', false]]
                        );
                    }
                    // Constraint count
                    if (sql.includes('EXA_ALL_CONSTRAINTS') && sql.includes('COUNT')) {
                        return createRawResult(['CONSTRAINT_COUNT'], [[2]]);
                    }
                    // Index count
                    if (sql.includes('EXA_ALL_INDICES') && sql.includes('COUNT')) {
                        return createRawResult(['INDEX_COUNT'], [[1]]);
                    }
                    throw new Error(`Unexpected query: ${sql}`);
                }
            };

            const manager = new MockConnectionManager(driver);
            const provider = new ObjectTreeProvider(manager as any);

            const tableElement = {
                type: 'table' as const,
                connection,
                schemaName: 'TEST_SCHEMA',
                tableInfo: { name: 'USERS' },
                label: 'USERS',
                id: 'conn-1:TEST_SCHEMA:USERS:table'
            };

            const children = await provider.getChildren(tableElement as any);

            const labels = children.map((c: any) => c.label);
            assert.ok(labels.some((l: string) => l === 'Constraints'), 'Should have Constraints folder');
            assert.ok(labels.some((l: string) => l === 'Indices'), 'Should have Indices folder');
        });

        test('omits Constraints folder when constraint count is zero', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('EXA_ALL_COLUMNS') && !sql.includes('COUNT')) {
                        return createRawResult(
                            ['COLUMN_NAME', 'COLUMN_TYPE', 'COLUMN_IS_NULLABLE'],
                            [['ID', 'DECIMAL(18,0)', false]]
                        );
                    }
                    if (sql.includes('EXA_ALL_CONSTRAINTS') && sql.includes('COUNT')) {
                        return createRawResult(['CONSTRAINT_COUNT'], [[0]]);
                    }
                    if (sql.includes('EXA_ALL_INDICES') && sql.includes('COUNT')) {
                        return createRawResult(['INDEX_COUNT'], [[0]]);
                    }
                    throw new Error(`Unexpected query: ${sql}`);
                }
            };

            const manager = new MockConnectionManager(driver);
            const provider = new ObjectTreeProvider(manager as any);

            const tableElement = {
                type: 'table' as const,
                connection,
                schemaName: 'TEST_SCHEMA',
                tableInfo: { name: 'USERS' },
                label: 'USERS',
                id: 'conn-1:TEST_SCHEMA:USERS:table'
            };

            const children = await provider.getChildren(tableElement as any);
            const labels = children.map((c: any) => c.label);
            assert.ok(!labels.includes('Constraints'), 'Should NOT have Constraints folder');
            assert.ok(!labels.includes('Indices'), 'Should NOT have Indices folder');
        });

        test('still shows columns when constraint query fails', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('EXA_ALL_COLUMNS') && !sql.includes('COUNT')) {
                        return createRawResult(
                            ['COLUMN_NAME', 'COLUMN_TYPE', 'COLUMN_IS_NULLABLE'],
                            [['ID', 'DECIMAL(18,0)', false]]
                        );
                    }
                    if (sql.includes('EXA_ALL_CONSTRAINTS')) {
                        throw new Error('Access denied');
                    }
                    if (sql.includes('EXA_ALL_INDICES')) {
                        throw new Error('Access denied');
                    }
                    throw new Error(`Unexpected query: ${sql}`);
                }
            };

            const manager = new MockConnectionManager(driver);
            const provider = new ObjectTreeProvider(manager as any);

            const tableElement = {
                type: 'table' as const,
                connection,
                schemaName: 'TEST_SCHEMA',
                tableInfo: { name: 'USERS' },
                label: 'USERS',
                id: 'conn-1:TEST_SCHEMA:USERS:table'
            };

            const children = await provider.getChildren(tableElement as any);
            assert.ok(children.length > 0, 'Should still have column children');
            const labels = children.map((c: any) => c.label);
            assert.ok(!labels.includes('Constraints'), 'Should NOT have Constraints folder on error');
            assert.ok(!labels.includes('Indices'), 'Should NOT have Indices folder on error');
        });
    });
});
