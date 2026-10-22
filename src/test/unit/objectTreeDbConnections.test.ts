import * as assert from 'assert';
import type * as vscode from 'vscode';
import type { ConnectionManager } from '../../connectionManager';
import type { ObjectNode, ObjectTreeItem } from '../../providers/objectTreeProvider';
import { registerVscodeMock, registerExtensionMock } from '../helpers/vscodeMock';

registerVscodeMock();
registerExtensionMock();

const { ObjectTreeProvider, getQualifiedName } = require('../../providers/objectTreeProvider') as typeof import('../../providers/objectTreeProvider');

import { createRawResult, createEmptyRawResult, createRawErrorResult, MockConnectionManager } from '../helpers/mockConnectionManager';

function getLabelText(item: ObjectNode | undefined): string {
    if (!item || !item.label) { return ''; }
    return typeof item.label === 'string' ? item.label : item.label?.label ?? '';
}

function makeProvider(connectionRows: Array<[string, string | null, string | null]>, fail = false) {
    const queries: string[] = [];
    const mockCM = new MockConnectionManager({
        query: async (sql: string) => {
            queries.push(sql);
            if (sql.includes('EXA_ALL_CONNECTIONS')) {
                return fail
                    ? createRawErrorResult('42000', 'boom')
                    : createRawResult(['CONNECTION_NAME', 'CREATED', 'CONNECTION_COMMENT'], connectionRows);
            }
            if (sql.includes('EXA_SCHEMAS')) {
                return createRawResult(['SCHEMA_NAME'], [['MY_SCHEMA']]);
            }
            return createEmptyRawResult(['DUMMY']);
        }
    });
    return { provider: new ObjectTreeProvider(mockCM as unknown as ConnectionManager), queries };
}

async function getConnectionsFolder(provider: InstanceType<typeof ObjectTreeProvider>): Promise<ObjectTreeItem> {
    const root = await provider.getChildren();
    const folder = root.find(c => getLabelText(c) === 'Connections');
    assert.ok(folder, 'Connections folder missing');
    return folder as ObjectTreeItem;
}

suite('ObjectTreeProvider, Connections', () => {
    test('root shows Connections right before System Schemas and lists them only on expand', async () => {
        const { provider, queries } = makeProvider([
            ['BI_DATALAKE_S3', '2026-10-01 10:00:00.000', null],
            ['VS_TEST_CONN', '2026-10-22 09:00:00.000', 'test comment']
        ]);

        const root = await provider.getChildren();
        const labels = root.map(getLabelText);

        assert.deepStrictEqual(labels.slice(-2), ['Connections', 'System Schemas']);
        const folder = root[root.length - 2] as ObjectTreeItem;
        assert.strictEqual(folder.description, undefined);
        assert.strictEqual(folder.contextValue, 'db-connections-folder');
        assert.ok(!queries.some(q => q.includes('EXA_ALL_CONNECTIONS')), 'root refresh must not list connections');

        assert.strictEqual((await provider.getChildren(folder)).length, 2);
        const listing = queries.filter(q => q.includes('EXA_ALL_CONNECTIONS'));
        assert.strictEqual(listing.length, 1);
        assert.ok(listing[0].includes('CONNECTION_NAME, CREATED, CONNECTION_COMMENT'));
    });

    test('a failed listing gives an empty folder', async () => {
        const { provider } = makeProvider([], true);

        const folder = await getConnectionsFolder(provider);

        assert.deepStrictEqual(await provider.getChildren(folder), []);
    });

    test('one leaf node per connection with created and comment in the tooltip', async () => {
        const { provider } = makeProvider([
            ['BI_DATALAKE_S3', '2026-10-01 10:00:00.000', null],
            ['VS_TEST_CONN', '2026-10-22 09:00:00.000', 'test comment']
        ]);
        const folder = await getConnectionsFolder(provider);

        const nodes = await provider.getChildren(folder) as ObjectTreeItem[];

        assert.deepStrictEqual(nodes.map(getLabelText), ['BI_DATALAKE_S3', 'VS_TEST_CONN']);
        assert.strictEqual(nodes[0].contextValue, 'db-connection');
        assert.strictEqual(nodes[0].collapsibleState, 0);
        assert.strictEqual(nodes[0].tooltip, 'Created: 2026-10-01 10:00:00.000');
        assert.strictEqual(nodes[1].tooltip, 'Created: 2026-10-22 09:00:00.000\nComment: test comment');
        assert.strictEqual(nodes[1].description, undefined);
        assert.strictEqual(nodes[1].parent, folder);
        assert.strictEqual(provider.getParent(nodes[1]), folder);
    });

    test('copy name and drag give the quoted connection name', async () => {
        const { provider } = makeProvider([['VS_LOWER"Q', null, null]]);
        const folder = await getConnectionsFolder(provider);
        const [node] = await provider.getChildren(folder) as ObjectTreeItem[];

        assert.strictEqual(getQualifiedName(node), '"VS_LOWER""Q"');

        const store = new Map<string, { value?: unknown }>();
        const dataTransfer = { set: (mime: string, value: { value?: unknown }) => { store.set(mime, value); } };
        await provider.handleDrag([node], dataTransfer as unknown as vscode.DataTransfer, {} as vscode.CancellationToken);
        assert.strictEqual(store.get('text/plain')?.value, '"VS_LOWER""Q"');
        assert.strictEqual(node.tooltip, undefined);
    });
});
