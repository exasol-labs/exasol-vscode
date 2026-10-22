import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import { registerVscodeMock, registerExtensionMock } from '../helpers/vscodeMock';
import type { ObjectTreeItemType } from '../../providers/objectTreeTypes';

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

suite('ObjectTreeProvider, script, function and system nodes', () => {

    test('UDF, adapter and other scripts get their own context values', () => {
        assert.strictEqual(makeScriptItem('UDF').contextValue, 'script-udf');
        assert.strictEqual(makeScriptItem('ADAPTER').contextValue, 'script-adapter');
        assert.strictEqual(makeScriptItem('SCRIPTING').contextValue, 'script');
    });

    test('no node of any type runs a command on click', () => {
        // A Record keyed by the type union fails to compile when a node type is added and not listed here.
        const allTypes: Record<ObjectTreeItemType, true> = {
            'schema': true, 'tables-folder': true, 'table': true, 'views-folder': true, 'view': true,
            'column': true, 'virtual-schemas-folder': true, 'virtual-schema': true, 'virtual-table': true,
            'udfs-folder': true, 'procedures-folder': true, 'adapters-folder': true, 'functions-folder': true,
            'script': true, 'function': true, 'constraints-folder': true, 'indices-folder': true,
            'constraint': true, 'index': true, 'system-schemas-folder': true, 'system-schema': true,
            'system-table': true, 'schema-group': true, 'db-connections-folder': true, 'db-connection': true
        };
        for (const type of Object.keys(allTypes) as ObjectTreeItemType[]) {
            for (const scriptType of type === 'script' ? ['UDF', 'ADAPTER', 'SCRIPTING'] : [undefined]) {
                const item = new ObjectTreeItem({
                    label: 'X',
                    id: `conn-1:VS_SRC:X:${type}`,
                    collapsibleState: 0,
                    type,
                    connection: TEST_CONNECTION,
                    schemaName: 'VS_SRC',
                    tableInfo: { name: 'X', rowCount: 1 },
                    columnInfo: { name: 'C', type: 'DECIMAL(18,0)', nullable: true },
                    scriptType,
                    scriptInfo: { name: 'X', language: 'PYTHON3', inputType: null, scriptType: scriptType ?? 'UDF' },
                    functionInfo: { name: 'X' },
                    dbConnectionInfo: { name: 'X' }
                });
                assert.strictEqual(item.command, undefined, `${type} ${scriptType ?? ''} has a click command`);
            }
        }
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

    test('every script and function node has Open Source in its context menu', () => {
        assert.deepStrictEqual(menuCommandsFor('script-udf'), [
            'exasol.openScriptSource', 'exasol.generateScriptCall', 'exasol.copyQualifiedName (inline)'
        ]);
        assert.deepStrictEqual(menuCommandsFor('script-adapter'), [
            'exasol.openScriptSource', 'exasol.copyQualifiedName (inline)'
        ]);
        assert.deepStrictEqual(menuCommandsFor('script'), ['exasol.openScriptSource']);
        assert.deepStrictEqual(menuCommandsFor('function'), ['exasol.openFunctionSource']);
    });

    test('tables and views have Describe and Show DDL in their context menus', () => {
        assert.deepStrictEqual(menuCommandsFor('table'), [
            'exasol.showTableDDL', 'exasol.previewTable', 'exasol.describeTable', 'exasol.generateSelect',
            'exasol.copyQualifiedName (inline)'
        ]);
        assert.deepStrictEqual(menuCommandsFor('view'), [
            'exasol.describeTable', 'exasol.showViewDDL', 'exasol.previewTable', 'exasol.generateSelect',
            'exasol.copyQualifiedName (inline)'
        ]);
    });

    test('system tables and system schemas have their context menus', () => {
        assert.deepStrictEqual(menuCommandsFor('system-table'), [
            'exasol.previewTable', 'exasol.describeTable', 'exasol.generateSelect', 'exasol.copyQualifiedName (inline)'
        ]);
        assert.deepStrictEqual(menuCommandsFor('system-schema'), ['exasol.copyQualifiedName (inline)']);
    });
});
