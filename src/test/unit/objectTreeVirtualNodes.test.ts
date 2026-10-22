import * as assert from 'assert';
import type * as vscode from 'vscode';
import { registerVscodeMock, registerExtensionMock } from '../helpers/vscodeMock';

registerVscodeMock();
registerExtensionMock();

const { ObjectTreeItem, ObjectTreeProvider, getQualifiedName } = require('../../providers/objectTreeProvider') as typeof import('../../providers/objectTreeProvider');

import { createRawResult, createEmptyRawResult, MockConnectionManager, TEST_CONNECTION, asConnectionManager } from '../helpers/mockConnectionManager';
import type { ObjectNode } from '../../providers/objectTreeProvider';

function makeVirtualSchemaItem(): InstanceType<typeof ObjectTreeItem> {
    return new ObjectTreeItem({
        label: 'VS_PY',
        id: 'conn-1:VS_PY:virtual-schema',
        collapsibleState: 1,
        type: 'virtual-schema',
        connection: TEST_CONNECTION,
        schemaName: 'VS_PY'
    });
}

function makeVirtualTableItem(): InstanceType<typeof ObjectTreeItem> {
    return new ObjectTreeItem({
        label: 'T',
        id: 'conn-1:VS_PY:T:virtual-table',
        collapsibleState: 1,
        type: 'virtual-table',
        connection: TEST_CONNECTION,
        schemaName: 'VS_PY',
        tableInfo: { name: 'T' }
    });
}

suite('ObjectTreeProvider, virtual schema nodes', () => {

    test('clicking a virtual table opens it like a table', () => {
        const item = makeVirtualTableItem();

        assert.strictEqual(item.command?.command, 'exasol.openObject');
        assert.deepStrictEqual(item.command?.arguments, [item]);
    });

    test('dragging virtual schema and virtual table nodes gives quoted qualified names', async () => {
        const provider = new ObjectTreeProvider(asConnectionManager(new MockConnectionManager({
            query: async () => createEmptyRawResult(['DUMMY'])
        })));
        const dragText = async (item: ObjectNode): Promise<unknown> => {
            const store = new Map<string, { value?: unknown }>();
            const dataTransfer = { set: (mime: string, value: { value?: unknown }) => { store.set(mime, value); } };
            await provider.handleDrag([item], dataTransfer as unknown as vscode.DataTransfer, {} as vscode.CancellationToken);
            return store.get('text/plain')?.value;
        };

        assert.strictEqual(await dragText(makeVirtualSchemaItem()), '"VS_PY"');
        assert.strictEqual(await dragText(makeVirtualTableItem()), '"VS_PY"."T"');
        const quotedTable = new ObjectTreeItem({
            label: 'my"table',
            id: 'conn-1:my"schema:my"table:table',
            collapsibleState: 1,
            type: 'table',
            connection: TEST_CONNECTION,
            schemaName: 'my"schema',
            tableInfo: { name: 'my"table' }
        });
        assert.strictEqual(await dragText(quotedTable), '"my""schema"."my""table"');
    });

    test('a full refresh rebuilds the virtual schema node with the new last refresh and the same id', async () => {
        let lastRefresh = '2026-10-22 09:21:31.488000';
        const provider = new ObjectTreeProvider(asConnectionManager(new MockConnectionManager({
            query: async (sql: string) => {
                if (sql.includes('EXA_ALL_VIRTUAL_SCHEMAS')) {
                    return createRawResult(
                        ['SCHEMA_NAME', 'ADAPTER_SCRIPT_SCHEMA', 'ADAPTER_SCRIPT_NAME', 'LAST_REFRESH', 'LAST_REFRESH_BY'],
                        [['VS_PY', 'VS_SRC', 'PYADAPTER', lastRefresh, 'SYS']]
                    );
                }
                return createEmptyRawResult(['SCHEMA_NAME']);
            }
        })));
        const findVirtualSchema = async () => {
            const roots = await provider.getChildren();
            const node = roots.find(n => n instanceof ObjectTreeItem && n.type === 'virtual-schema');
            assert.ok(node, 'virtual schema node must be listed');
            return node;
        };
        const fired: unknown[] = [];
        provider.onDidChangeTreeData(arg => fired.push(arg));

        const before = await findVirtualSchema();
        lastRefresh = '2026-10-22 09:33:27.191000';
        provider.refresh();
        const after = await findVirtualSchema();

        assert.deepStrictEqual(fired, [undefined], 'refresh must reload from the root');
        assert.strictEqual(after.id, before.id, 'a stable id keeps the expansion state');
        assert.ok(String(before.tooltip).includes('09:21:31'));
        assert.ok(String(after.tooltip).includes('Last refresh: 2026-10-22 09:33:27.191000'));
    });

    test('virtual table columns carry the nullability from EXA_ALL_COLUMNS', async () => {
        const provider = new ObjectTreeProvider(asConnectionManager(new MockConnectionManager({
            query: async (sql: string) => {
                assert.ok(sql.includes('COLUMN_IS_NULLABLE'), 'nullability must be read');
                return createRawResult(
                    ['COLUMN_NAME', 'COLUMN_TYPE', 'COLUMN_IS_NULLABLE'],
                    [['ID', 'DECIMAL(18,0)', false], ['NAME', 'VARCHAR(50) UTF8', true], ['NOTE', 'VARCHAR(10) UTF8', null]]
                );
            }
        })));

        const children = await provider.getChildren(makeVirtualTableItem());

        const columns = children.map(child => {
            assert.ok(child instanceof ObjectTreeItem);
            return child;
        });
        assert.deepStrictEqual(columns.map(c => c.columnInfo?.nullable), [false, true, null]);
        assert.deepStrictEqual(columns.map(c => c.tooltip), [
            'ID: DECIMAL(18,0)',
            'NAME: VARCHAR(50) UTF8 (nullable)',
            'NOTE: VARCHAR(10) UTF8'
        ]);
    });
});

suite('getQualifiedName', () => {

    test('quotes and escapes schema, table, view and column names for every node type', () => {
        const tableInfo = { name: 'a"b' };
        const columnInfo = { name: 'c"d', type: 'INTEGER', nullable: null };

        assert.strictEqual(getQualifiedName({ type: 'schema', schemaName: 's"x' }), '"s""x"');
        assert.strictEqual(getQualifiedName({ type: 'virtual-schema', schemaName: 's"x' }), '"s""x"');
        assert.strictEqual(getQualifiedName({ type: 'table', schemaName: 's"x', tableInfo }), '"s""x"."a""b"');
        assert.strictEqual(getQualifiedName({ type: 'view', schemaName: 's"x', tableInfo }), '"s""x"."a""b"');
        assert.strictEqual(getQualifiedName({ type: 'virtual-table', schemaName: 's"x', tableInfo }), '"s""x"."a""b"');
        assert.strictEqual(getQualifiedName({ type: 'column', schemaName: 's"x', columnInfo }), '"c""d"');
    });

    test('returns undefined for other node types and for missing names', () => {
        assert.strictEqual(getQualifiedName({ type: 'tables-folder', schemaName: 'S' }), undefined);
        assert.strictEqual(getQualifiedName({ type: 'schema' }), undefined);
        assert.strictEqual(getQualifiedName({ type: 'table', schemaName: 'S' }), undefined);
        assert.strictEqual(getQualifiedName({ type: 'column' }), undefined);
    });
});
