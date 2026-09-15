import * as assert from 'assert';
import { fetchTables } from '../providers/objectTreeFetchers';
import type { StoredConnection } from '../connectionManager';
import { MockConnectionManager, asConnectionManager, createRawResult as createRawTableResult } from './helpers/mockConnectionManager';

suite('ObjectTreeProvider Metadata Fallback', () => {
    const createRawResult = (columnName: string, values: string[]) => createRawTableResult([columnName], values.map(value => [value]));

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
            host: 'localhost',
            port: 8563,
            user: 'sys',
            password: 'secret'
        };

        const manager = new MockConnectionManager(driver, connection);

        const tables = await fetchTables(asConnectionManager(manager), connection, 'TEST_SCHEMA');

        assert.strictEqual(tables.length, 1, 'Should return one table from fallback query');
        assert.strictEqual(tables[0].name, 'FALLBACK_TABLE', 'Should use fallback table name');
        assert.strictEqual(queries.length, 4, 'Should attempt 4 queries before succeeding');
    });
});
