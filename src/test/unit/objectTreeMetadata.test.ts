import * as assert from 'assert';
import type { ConnectionManager } from '../../connectionManager';
import type { ObjectNode } from '../../providers/objectTreeProvider';
import { registerVscodeMock, registerExtensionMock } from '../helpers/vscodeMock';
import { createRawResult, createEmptyRawResult, MockConnectionManager, TEST_CONNECTION, asConnectionManager } from '../helpers/mockConnectionManager';

registerVscodeMock();
registerExtensionMock();

const { ObjectTreeProvider, ObjectTreeItem } = require('../../providers/objectTreeProvider') as typeof import('../../providers/objectTreeProvider');
const { fetchIndices, fetchViews } = require('../../providers/objectTreeFetchers') as typeof import('../../providers/objectTreeFetchers');

function labelOf(node: ObjectNode): string {
    return typeof node.label === 'string' ? node.label : node.label?.label ?? '';
}

suite('Object tree metadata queries', () => {
    test('fetchIndices reads columns that exist in EXA_ALL_INDICES', async () => {
        const queries: string[] = [];
        // EXA_ALL_INDICES has no INDEX_NAME and no INDEX_COLUMNS (verified live).
        const manager = new MockConnectionManager({
            query: async (sql: string) => {
                queries.push(sql);
                if (/INDEX_NAME|INDEX_COLUMNS/.test(sql)) {
                    throw new Error('object INDEX_NAME not found');
                }
                return createRawResult(['INDEX_OBJECT_ID', 'INDEX_TYPE', 'REMARKS'], [[1, 'LOCAL', 'LOCAL INDEX (NAME)'], [2, 'GLOBAL', null]]);
            }
        });

        const indices = await fetchIndices(asConnectionManager(manager), TEST_CONNECTION, 'S', 'T');

        assert.deepStrictEqual(indices, [
            { objectId: '1', description: 'LOCAL INDEX (NAME)' },
            { objectId: '2', description: 'GLOBAL INDEX' }
        ]);
        assert.match(queries[0], /SELECT INDEX_OBJECT_ID, INDEX_TYPE, REMARKS\s+FROM SYS\.EXA_ALL_INDICES/);
    });

    test('fetchViews reads VIEW_NAME from EXA_ALL_VIEWS in the first attempt', async () => {
        const queries: string[] = [];
        // EXA_ALL_VIEWS has VIEW_NAME, not TABLE_NAME.
        const manager = new MockConnectionManager({
            query: async (sql: string) => {
                queries.push(sql);
                if (sql.includes('TABLE_NAME')) {
                    throw new Error('object TABLE_NAME not found');
                }
                return createRawResult(['VIEW_NAME'], [['V1']]);
            }
        });

        const views = await fetchViews(asConnectionManager(manager), TEST_CONNECTION, 'S');

        assert.deepStrictEqual(views, [{ name: 'V1' }]);
        assert.strictEqual(queries.length, 1);
        assert.ok(queries[0].includes('FROM SYS.EXA_ALL_VIEWS'));
    });
});

suite('Object tree labels', () => {
    test('a schema without visible tables or views has no description', () => {
        const schema = new ObjectTreeItem({
            label: 'S', id: 'c:S', collapsibleState: 1, type: 'schema',
            connection: TEST_CONNECTION, schemaName: 'S', tableCount: 0, viewCount: 0
        });
        assert.strictEqual(schema.description, undefined);
    });

    test('a schema with visible tables lists the counts', () => {
        const schema = new ObjectTreeItem({
            label: 'S', id: 'c:S', collapsibleState: 1, type: 'schema',
            connection: TEST_CONNECTION, schemaName: 'S', tableCount: 2, viewCount: 1
        });
        assert.strictEqual(schema.description, '2 tables, 1 view');
    });

    test('the root shows a message when no schemas are visible', async () => {
        const manager = new MockConnectionManager({
            query: async () => createEmptyRawResult(['SCHEMA_NAME', 'TABLE_COUNT', 'VIEW_COUNT'])
        });
        const provider = new ObjectTreeProvider(manager as unknown as ConnectionManager);

        const root = await provider.getChildren();

        assert.deepStrictEqual(root.map(labelOf), [
            'No schemas', 'Virtual Schemas', 'Connections', 'System Schemas'
        ]);
        assert.strictEqual(root[0].contextValue, 'info');
    });

    test('the root shows no message when schemas are visible', async () => {
        const manager = new MockConnectionManager({
            query: async () => createRawResult(['SCHEMA_NAME', 'TABLE_COUNT', 'VIEW_COUNT'], [['S', 0, 0]])
        });
        const provider = new ObjectTreeProvider(manager as unknown as ConnectionManager);

        const root = await provider.getChildren();

        assert.deepStrictEqual(root.map(labelOf), ['S', 'Virtual Schemas', 'Connections', 'System Schemas']);
    });

    test('index nodes show REMARKS and have one id per index', async () => {
        const manager = new MockConnectionManager({
            query: async (sql: string) => {
                if (sql.includes('EXA_ALL_INDICES')) {
                    return createRawResult(['INDEX_OBJECT_ID', 'INDEX_TYPE', 'REMARKS'], [[7, 'LOCAL', 'LOCAL INDEX (NAME)'], [8, 'GLOBAL', 'GLOBAL INDEX (ID)']]);
                }
                return createEmptyRawResult(['DUMMY']);
            }
        });
        const provider = new ObjectTreeProvider(manager as unknown as ConnectionManager);
        const folder = new ObjectTreeItem({
            label: 'Indices', id: 'c:S:T:indices', collapsibleState: 1, type: 'indices-folder',
            connection: TEST_CONNECTION, schemaName: 'S', tableInfo: { name: 'T' }
        });

        const indices = await provider.getChildren(folder);

        assert.deepStrictEqual(indices.map(labelOf), ['LOCAL INDEX (NAME)', 'GLOBAL INDEX (ID)']);
        assert.deepStrictEqual(indices.map(i => i.id), [`${TEST_CONNECTION.id}:S:T:7:index`, `${TEST_CONNECTION.id}:S:T:8:index`]);
    });
});
