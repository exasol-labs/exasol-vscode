import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import { registerVscodeMock, registerExtensionMock } from '../helpers/vscodeMock';

registerVscodeMock();
registerExtensionMock();

const { ObjectTreeItem, ObjectTreeProvider } = require('../../providers/objectTreeProvider') as typeof import('../../providers/objectTreeProvider');

import { createEmptyRawResult, MockConnectionManager, TEST_CONNECTION, asConnectionManager } from '../helpers/mockConnectionManager';

function makeScriptItem(scriptType: string, name = 'S1'): InstanceType<typeof ObjectTreeItem> {
    return new ObjectTreeItem({
        label: name,
        id: `conn-1:VS_SRC:${name}:script`,
        collapsibleState: 0,
        type: 'script',
        connection: TEST_CONNECTION,
        schemaName: 'VS_SRC',
        scriptType,
        scriptInfo: { name, language: 'PYTHON3', inputType: scriptType === 'UDF' ? 'SCALAR' : null, scriptType }
    });
}

const menus = (JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')) as {
    contributes: { menus: { 'view/item/context': Array<{ command: string; when: string; group?: string }> } };
}).contributes.menus['view/item/context'];

function menuCommandsFor(contextValue: string): string[] {
    return menus
        .filter(entry => entry.when.includes('view == exasol.objects')
            && new RegExp(`viewItem == ${contextValue}(?![\\w-])`).test(entry.when))
        .map(entry => `${entry.command}${entry.group?.startsWith('inline') ? ' (inline)' : ''}`);
}

suite('ObjectTreeProvider, script and function nodes', () => {

    test('UDF, adapter and other scripts get their own context values', () => {
        assert.strictEqual(makeScriptItem('UDF').contextValue, 'script-udf');
        assert.strictEqual(makeScriptItem('ADAPTER').contextValue, 'script-adapter');
        assert.strictEqual(makeScriptItem('SCRIPTING').contextValue, 'script');
    });

    test('clicking any script opens its source', () => {
        for (const scriptType of ['UDF', 'ADAPTER', 'SCRIPTING']) {
            const item = makeScriptItem(scriptType);
            assert.strictEqual(item.command?.command, 'exasol.openScriptSource');
            assert.deepStrictEqual(item.command?.arguments, [item]);
        }
    });

    test('clicking a function opens its source', () => {
        const item = new ObjectTreeItem({
            label: 'F1',
            id: 'conn-1:VS_SRC:F1:function',
            collapsibleState: 0,
            type: 'function',
            connection: TEST_CONNECTION,
            schemaName: 'VS_SRC',
            functionInfo: { name: 'F1' }
        });
        assert.strictEqual(item.command?.command, 'exasol.openFunctionSource');
        assert.deepStrictEqual(item.command?.arguments, [item]);
    });

    test('dragging a script gives its quoted qualified name', async () => {
        const provider = new ObjectTreeProvider(asConnectionManager(new MockConnectionManager({
            query: async () => createEmptyRawResult(['DUMMY'])
        })));
        const store = new Map<string, { value?: unknown }>();
        const dataTransfer = { set: (mime: string, value: { value?: unknown }) => { store.set(mime, value); } };

        await provider.handleDrag([makeScriptItem('UDF', 'my"udf')], dataTransfer as unknown as vscode.DataTransfer, {} as vscode.CancellationToken);

        assert.strictEqual(store.get('text/plain')?.value, '"VS_SRC"."my""udf"');
    });

    test('UDF and adapter nodes have their context menus; other scripts and functions have none', () => {
        assert.deepStrictEqual(menuCommandsFor('script-udf'), [
            'exasol.openScriptSource', 'exasol.generateScriptCall', 'exasol.copyQualifiedName (inline)'
        ]);
        assert.deepStrictEqual(menuCommandsFor('script-adapter'), [
            'exasol.openScriptSource', 'exasol.copyQualifiedName (inline)'
        ]);
        assert.deepStrictEqual(menuCommandsFor('script'), []);
        assert.deepStrictEqual(menuCommandsFor('function'), []);
    });
});
