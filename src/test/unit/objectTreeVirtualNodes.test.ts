import * as assert from 'assert';
import type * as vscode from 'vscode';
import { registerVscodeMock, registerExtensionMock } from '../helpers/vscodeMock';

registerVscodeMock();
registerExtensionMock();

const { ObjectTreeItem, ObjectTreeProvider } = require('../../providers/objectTreeProvider') as typeof import('../../providers/objectTreeProvider');

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
});
