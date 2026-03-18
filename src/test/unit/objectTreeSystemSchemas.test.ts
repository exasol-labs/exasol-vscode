import * as assert from 'assert';
import { registerVscodeMock, registerExtensionMock } from '../helpers/vscodeMock';

registerVscodeMock();
registerExtensionMock();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ObjectTreeProvider } = require('../../providers/objectTreeProvider');

import { TEST_CONNECTION, createRawResult, createEmptyRawResult } from '../helpers/mockConnectionManager';
import { MockConnectionManager } from '../helpers/mockConnectionManager';

function getLabelText(item: any): string {
    if (!item || !item.label) { return ''; }
    return typeof item.label === 'string' ? item.label : item.label?.label ?? '';
}

suite('ObjectTreeProvider — System Schemas', () => {

    suite('System Schemas folder at root level', () => {
        test('appears after user and virtual schemas', async () => {
            const mockDriver = {
                query: async (sql: string) => {
                    if (sql.includes('EXA_SCHEMAS')) {
                        return createRawResult(
                            ['SCHEMA_NAME'],
                            [['MY_SCHEMA'], ['PUBLIC']]
                        );
                    }
                    if (sql.includes('EXA_ALL_VIRTUAL_SCHEMAS')) {
                        return createRawResult(
                            ['SCHEMA_NAME'],
                            [['VS_ONE']]
                        );
                    }
                    // Virtual schema tables query
                    if (sql.includes('EXA_ALL_VIRTUAL_TABLES')) {
                        return createEmptyRawResult(['TABLE_SCHEMA', 'TABLE_NAME']);
                    }
                    return createEmptyRawResult(['DUMMY']);
                }
            };
            const mockCM = new MockConnectionManager(mockDriver);
            const provider = new ObjectTreeProvider(mockCM);

            const rootChildren = await provider.getChildren();

            // Last item should be "System Schemas"
            const lastItem = rootChildren[rootChildren.length - 1];
            assert.strictEqual(getLabelText(lastItem), 'System Schemas');

            // SYS and EXA_STATISTICS should not appear as root-level schema nodes
            const labels = rootChildren.map((c: any) => getLabelText(c));
            assert.ok(!labels.includes('SYS'), 'SYS should not be a root-level user schema');
            assert.ok(!labels.includes('EXA_STATISTICS'), 'EXA_STATISTICS should not be a root-level user schema');
        });
    });

    suite('System Schemas folder contains SYS and EXA_STATISTICS', () => {
        test('expanding the folder returns two children', async () => {
            const mockDriver = {
                query: async () => createEmptyRawResult(['DUMMY'])
            };
            const mockCM = new MockConnectionManager(mockDriver);
            const provider = new ObjectTreeProvider(mockCM);

            const rootChildren = await provider.getChildren();
            const systemSchemasFolder = rootChildren.find(
                (c: any) => getLabelText(c) === 'System Schemas'
            );

            const children = await provider.getChildren(systemSchemasFolder);
            assert.strictEqual(children.length, 2);

            const labels = children.map((c: any) => getLabelText(c));
            assert.ok(labels.includes('SYS'), 'Should contain SYS');
            assert.ok(labels.includes('EXA_STATISTICS'), 'Should contain EXA_STATISTICS');
        });
    });

    suite('System tables listed alphabetically', () => {
        test('returns tables in alphabetical order from the DB', async () => {
            const mockDriver = {
                query: async (sql: string) => {
                    if (sql.includes('EXA_SCHEMAS')) {
                        return createRawResult(['SCHEMA_NAME'], [['MY_SCHEMA']]);
                    }
                    if (sql.includes('EXA_ALL_VIRTUAL_SCHEMAS')) {
                        return createEmptyRawResult(['SCHEMA_NAME']);
                    }
                    if (sql.includes('EXA_ALL_VIRTUAL_TABLES')) {
                        return createEmptyRawResult(['TABLE_SCHEMA', 'TABLE_NAME']);
                    }
                    if (sql.includes('EXA_SYSCAT') && sql.includes("'SYS'")) {
                        return createRawResult(
                            ['OBJECT_NAME'],
                            [['EXA_ALL_COLUMNS'], ['EXA_ALL_OBJECTS'], ['EXA_ALL_TABLES']]
                        );
                    }
                    return createEmptyRawResult(['DUMMY']);
                }
            };
            const mockCM = new MockConnectionManager(mockDriver);
            const provider = new ObjectTreeProvider(mockCM);

            // Navigate to SYS system-schema node
            const rootChildren = await provider.getChildren();
            const systemSchemasFolder = rootChildren.find(
                (c: any) => getLabelText(c) === 'System Schemas'
            );
            const systemSchemas = await provider.getChildren(systemSchemasFolder);
            const sysNode = systemSchemas.find((c: any) => getLabelText(c) === 'SYS');

            const tables = await provider.getChildren(sysNode);
            assert.strictEqual(tables.length, 3);
            assert.strictEqual(getLabelText(tables[0]), 'EXA_ALL_COLUMNS');
            assert.strictEqual(getLabelText(tables[1]), 'EXA_ALL_OBJECTS');
            assert.strictEqual(getLabelText(tables[2]), 'EXA_ALL_TABLES');
        });
    });

    suite('Table columns expandable', () => {
        test('expanding a system table returns columns with types', async () => {
            const mockDriver = {
                query: async (sql: string) => {
                    if (sql.includes('EXA_SCHEMAS')) {
                        return createRawResult(['SCHEMA_NAME'], [['MY_SCHEMA']]);
                    }
                    if (sql.includes('EXA_ALL_VIRTUAL_SCHEMAS')) {
                        return createEmptyRawResult(['SCHEMA_NAME']);
                    }
                    if (sql.includes('EXA_ALL_VIRTUAL_TABLES')) {
                        return createEmptyRawResult(['TABLE_SCHEMA', 'TABLE_NAME']);
                    }
                    if (sql.includes('EXA_SYSCAT') && sql.includes("'SYS'")) {
                        return createRawResult(
                            ['OBJECT_NAME'],
                            [['EXA_ALL_COLUMNS']]
                        );
                    }
                    if (sql.includes('DESCRIBE')) {
                        return createRawResult(
                            ['COLUMN_NAME', 'SQL_TYPE'],
                            [
                                ['COLUMN_SCHEMA', 'VARCHAR(128) UTF8'],
                                ['COLUMN_TABLE', 'VARCHAR(128) UTF8'],
                                ['COLUMN_NAME', 'VARCHAR(128) UTF8']
                            ]
                        );
                    }
                    return createEmptyRawResult(['DUMMY']);
                }
            };
            const mockCM = new MockConnectionManager(mockDriver);
            const provider = new ObjectTreeProvider(mockCM);

            // Navigate: root > System Schemas > SYS > EXA_ALL_COLUMNS
            const rootChildren = await provider.getChildren();
            const systemSchemasFolder = rootChildren.find(
                (c: any) => getLabelText(c) === 'System Schemas'
            );
            const systemSchemas = await provider.getChildren(systemSchemasFolder);
            const sysNode = systemSchemas.find((c: any) => getLabelText(c) === 'SYS');
            const tables = await provider.getChildren(sysNode);
            const table = tables.find((c: any) => getLabelText(c) === 'EXA_ALL_COLUMNS');

            const columns = await provider.getChildren(table);
            assert.strictEqual(columns.length, 3);

            // Columns should show name and type
            const firstLabel = getLabelText(columns[0]);
            assert.ok(
                firstLabel.includes('COLUMN_SCHEMA'),
                `First column label should contain COLUMN_SCHEMA, got: ${firstLabel}`
            );
        });
    });

    suite('Permission error — graceful fallback', () => {
        test('fetchSystemTables returns empty array on error', async () => {
            const mockDriver = {
                query: async (sql: string) => {
                    if (sql.includes('EXA_SCHEMAS')) {
                        return createRawResult(['SCHEMA_NAME'], [['MY_SCHEMA']]);
                    }
                    if (sql.includes('EXA_ALL_VIRTUAL_SCHEMAS')) {
                        return createEmptyRawResult(['SCHEMA_NAME']);
                    }
                    if (sql.includes('EXA_ALL_VIRTUAL_TABLES')) {
                        return createEmptyRawResult(['TABLE_SCHEMA', 'TABLE_NAME']);
                    }
                    if (sql.includes('EXA_SYSCAT') && sql.includes("'SYS'")) {
                        throw new Error('insufficient privileges');
                    }
                    return createEmptyRawResult(['DUMMY']);
                }
            };
            const mockCM = new MockConnectionManager(mockDriver);
            const provider = new ObjectTreeProvider(mockCM);

            // Navigate to SYS
            const rootChildren = await provider.getChildren();
            const systemSchemasFolder = rootChildren.find(
                (c: any) => getLabelText(c) === 'System Schemas'
            );
            const systemSchemas = await provider.getChildren(systemSchemasFolder);
            const sysNode = systemSchemas.find((c: any) => getLabelText(c) === 'SYS');

            // Should return empty array, not throw
            const tables = await provider.getChildren(sysNode);
            assert.strictEqual(tables.length, 0, 'Should return empty array on permission error');
        });

        test('fetchSystemTableColumns returns empty array on error', async () => {
            const mockDriver = {
                query: async (sql: string) => {
                    if (sql.includes('EXA_SCHEMAS')) {
                        return createRawResult(['SCHEMA_NAME'], [['MY_SCHEMA']]);
                    }
                    if (sql.includes('EXA_ALL_VIRTUAL_SCHEMAS')) {
                        return createEmptyRawResult(['SCHEMA_NAME']);
                    }
                    if (sql.includes('EXA_ALL_VIRTUAL_TABLES')) {
                        return createEmptyRawResult(['TABLE_SCHEMA', 'TABLE_NAME']);
                    }
                    if (sql.includes('EXA_SYSCAT') && sql.includes("'SYS'")) {
                        return createRawResult(['OBJECT_NAME'], [['EXA_ALL_COLUMNS']]);
                    }
                    if (sql.includes('DESCRIBE')) {
                        throw new Error('insufficient privileges');
                    }
                    return createEmptyRawResult(['DUMMY']);
                }
            };
            const mockCM = new MockConnectionManager(mockDriver);
            const provider = new ObjectTreeProvider(mockCM);

            // Navigate to SYS > EXA_ALL_COLUMNS
            const rootChildren = await provider.getChildren();
            const systemSchemasFolder = rootChildren.find(
                (c: any) => getLabelText(c) === 'System Schemas'
            );
            const systemSchemas = await provider.getChildren(systemSchemasFolder);
            const sysNode = systemSchemas.find((c: any) => getLabelText(c) === 'SYS');
            const tables = await provider.getChildren(sysNode);
            const table = tables[0];

            // Should return empty array, not throw
            const columns = await provider.getChildren(table);
            assert.strictEqual(columns.length, 0, 'Should return empty array on permission error');
        });
    });
});
