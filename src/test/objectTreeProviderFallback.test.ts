import * as assert from 'assert';
import { ObjectTreeProvider } from '../providers/objectTreeProvider';
import type { StoredConnection } from '../connectionManager';

suite('ObjectTreeProvider Metadata Fallback', () => {
    class MockConnectionManager {
        constructor(private readonly driver: any, private readonly connection: StoredConnection) {}

        getConnections(): StoredConnection[] {
            return [this.connection];
        }

        async getDriver(): Promise<any> {
            return this.driver;
        }
    }

    const createRawResult = (columnName: string, values: string[]) => ({
        status: 'ok',
        responseData: {
            numResults: 1,
            results: [
                {
                    resultType: 'resultSet',
                    resultSet: {
                        columns: [{ name: columnName }],
                        numColumns: 1,
                        numRows: values.length,
                        numRowsInMessage: values.length,
                        data: [values]
                    }
                }
            ]
        }
    });

    test('falls back through multiple query attempts', async () => {
        const queries: string[] = [];
        const driver = {
            async query(sql: string) {
                queries.push(sql);
                // Each query should fail with a different error until the last one succeeds
                if (sql.includes('EXA_ALL_TABLES')) {
                    throw new Error('object EXA_ALL_TABLES not found');
                } else if (sql.includes('EXA_ALL_OBJECTS')) {
                    throw new Error('object EXA_ALL_OBJECTS not found');
                } else if (sql.includes('EXA_ALL_COLUMNS')) {
                    // Succeed on EXA_ALL_COLUMNS fallback
                    return createRawResult('COLUMN_TABLE', ['FALLBACK_TABLE']);
                }
                throw new Error('Unexpected query');
            }
        };

        const connection: StoredConnection = {
            id: 'conn-1',
            name: 'Test Connection',
            host: 'localhost:8563',
            user: 'sys',
            password: 'secret'
        };

        const manager = new MockConnectionManager(driver, connection);
        const provider = new ObjectTreeProvider(manager as any);

        const tables = await (provider as any).fetchTables(connection, 'TEST_SCHEMA');

        assert.strictEqual(tables.length, 1, 'Should return one table from fallback query');
        assert.strictEqual(tables[0].name, 'FALLBACK_TABLE', 'Should use fallback table name');
        assert.strictEqual(queries.length, 4, 'Should attempt 4 queries before succeeding');
    });
});
