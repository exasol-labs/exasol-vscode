import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import { registerVscodeMock, registerExtensionMock } from '../helpers/vscodeMock';
import type { ObjectTreeItemType } from '../../providers/objectTreeTypes';

registerVscodeMock();
registerExtensionMock();

const { ObjectTreeItem, ObjectTreeProvider } = require('../../providers/objectTreeProvider') as typeof import('../../providers/objectTreeProvider');

import type { ExasolDriver } from '@exasol/exasol-driver-ts';
import type { StoredConnection } from '../../connectionManager';
import { createEmptyRawResult, createRawResult, createRawErrorResult, MockConnectionManager, TEST_CONNECTION, asConnectionManager } from '../helpers/mockConnectionManager';

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

const contributes = (JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')) as {
    contributes: {
        commands: Array<{ command: string; title: string }>;
        menus: { 'view/item/context': Array<{ command: string; when: string; group?: string }> };
    };
}).contributes;
const menus = contributes.menus['view/item/context'];
const titles = new Map(contributes.commands.map(entry => [entry.command, entry.title]));

function menuEntriesFor(contextValue: string): Array<{ command: string; when: string; group?: string }> {
    return menus.filter(entry => entry.when.includes('view == exasol.objects')
        && new RegExp(`viewItem == ${contextValue}(?![\\w-])`).test(entry.when));
}

function menuCommandsFor(contextValue: string): string[] {
    return menuEntriesFor(contextValue)
        .map(entry => `${entry.command}${entry.group?.startsWith('inline') ? ' (inline)' : ''}`);
}

function menuTitlesFor(contextValue: string): string[] {
    return menuEntriesFor(contextValue).map(entry => titles.get(entry.command) ?? entry.command);
}

suite('ObjectTreeProvider, script, function and system nodes', () => {

    test('UDF, adapter and other scripts get their own context values', () => {
        assert.strictEqual(makeScriptItem('UDF').contextValue, 'script-udf');
        assert.strictEqual(makeScriptItem('ADAPTER').contextValue, 'script-adapter');
        assert.strictEqual(makeScriptItem('SCRIPTING').contextValue, 'script');
        assert.strictEqual(makeScriptItem('PREPROCESSOR').contextValue, 'script-preprocessor');
    });

    test('no node of any type runs a command on click', () => {
        // A Record keyed by the type union fails to compile when a node type is added and not listed here.
        const allTypes: Record<ObjectTreeItemType, true> = {
            'schema': true, 'tables-folder': true, 'table': true, 'views-folder': true, 'view': true,
            'column': true, 'virtual-schemas-folder': true, 'virtual-schema': true, 'virtual-table': true,
            'udfs-folder': true, 'procedures-folder': true, 'adapters-folder': true, 'preprocessors-folder': true, 'functions-folder': true,
            'script': true, 'function': true, 'constraints-folder': true, 'indices-folder': true,
            'constraint': true, 'index': true, 'system-schemas-folder': true, 'system-schema': true,
            'system-table': true, 'schema-group': true, 'db-connections-folder': true, 'db-connection': true
        };
        for (const type of Object.keys(allTypes) as ObjectTreeItemType[]) {
            for (const scriptType of type === 'script' ? ['UDF', 'ADAPTER', 'SCRIPTING', 'PREPROCESSOR'] : [undefined]) {
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

    test('every script and function node has Show DDL in its context menu', () => {
        assert.deepStrictEqual(menuCommandsFor('script-udf'), [
            'exasol.openScriptSource', 'exasol.generateScriptCall', 'exasol.copyQualifiedName (inline)'
        ]);
        assert.deepStrictEqual(menuCommandsFor('script-adapter'), [
            'exasol.openScriptSource', 'exasol.copyQualifiedName (inline)'
        ]);
        assert.deepStrictEqual(menuCommandsFor('script-preprocessor'), [
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

    test('context menu items have the same name for the same action on every object type', () => {
        assert.deepStrictEqual(menuTitlesFor('table'), [
            'Show DDL', 'Preview Data (100 rows)', 'Describe', 'Generate SELECT', 'Copy Name'
        ]);
        assert.deepStrictEqual(menuTitlesFor('view'), [
            'Describe', 'Show DDL', 'Preview Data (100 rows)', 'Generate SELECT', 'Copy Name'
        ]);
        assert.deepStrictEqual(menuTitlesFor('virtual-table'), [
            'Preview Data (100 rows)', 'Describe', 'Generate SELECT', 'Refresh Metadata', 'Explain Pushdown', 'Copy Name'
        ]);
        assert.deepStrictEqual(menuTitlesFor('script-udf'), ['Show DDL', 'Generate Call', 'Copy Name']);
        assert.deepStrictEqual(menuTitlesFor('function'), ['Show DDL']);
        assert.deepStrictEqual(menuTitlesFor('db-connection'), [
            'Show DDL', 'Generate IMPORT', 'Generate EXPORT', 'Copy Name'
        ]);
    });

    test('no object type has two context menu items with the same name', () => {
        const contextValues = new Set(menus
            .filter(entry => entry.when.includes('view == exasol.objects'))
            .flatMap(entry => [...entry.when.matchAll(/viewItem == ([\w-]+)/g)].map(match => match[1])));
        for (const contextValue of contextValues) {
            const names = menuTitlesFor(contextValue);
            assert.strictEqual(new Set(names).size, names.length, `${contextValue}: ${names.join(', ')}`);
        }
    });

    test('system tables and system schemas have their context menus', () => {
        assert.deepStrictEqual(menuCommandsFor('system-table'), [
            'exasol.previewTable', 'exasol.describeTable', 'exasol.generateSelect', 'exasol.copyQualifiedName (inline)'
        ]);
        assert.deepStrictEqual(menuCommandsFor('system-schema'), ['exasol.copyQualifiedName (inline)']);
    });
});

/**
 * Records the driver role of each query, as the tree reads scripts and the
 * parameter on different sessions. `userSession` says whether a user driver
 * is open; `whileQueued` runs before a user-role operation, as another query
 * would while it waits for the user session.
 */
class RoleRecordingConnectionManager extends MockConnectionManager {
    readonly roles: string[] = [];
    userRetries = 0;
    userSession = true;
    activeConnection: StoredConnection | undefined = TEST_CONNECTION;
    whileQueued: (() => void) | undefined;

    getActiveConnection(): StoredConnection | undefined { return this.activeConnection; }

    hasDriver(_connectionId: string, role: string): boolean {
        return role !== 'user' || this.userSession;
    }

    async getDriver(_connectionId?: string, role = 'user'): Promise<ExasolDriver> {
        this.roles.push(role);
        return super.getDriver();
    }

    async executeWithRetry<T>(fn: () => Promise<T>, _connectionId?: string, options?: { role?: string }): Promise<T> {
        if ((options?.role ?? 'user') === 'user') {
            this.userRetries++;
            this.whileQueued?.();
        }
        return fn();
    }
}

type ParameterAnswer = [string | null, string | null] | 'error';

// SCRIPT_TYPE and the parameter values as Exasol returns them (docker, 2026-10-23):
// unquoted names in uppercase, other names quoted, always schema-qualified.
function makePreprocessorProvider(parameter: ParameterAnswer, scripts: Array<[string, string]> = [['VS_PP', 'MY_PP'], ['VS_PP', 'OTHER_PP']]) {
    const queries: string[] = [];
    const manager = new RoleRecordingConnectionManager({
        query: async (sql: string) => {
            queries.push(sql);
            if (sql.includes('EXA_PARAMETERS')) {
                return parameter === 'error'
                    ? createRawErrorResult('42000', 'boom')
                    : createRawResult(['SESSION_VALUE', 'SYSTEM_VALUE'], [parameter]);
            }
            if (sql.includes('GROUP BY SCRIPT_TYPE')) {
                return createRawResult(['SCRIPT_TYPE', 'SCRIPT_COUNT'], [['PREPROCESSOR', scripts.length]]);
            }
            if (sql.includes("SCRIPT_TYPE = 'PREPROCESSOR'")) {
                return createRawResult(
                    ['SCRIPT_NAME', 'SCRIPT_LANGUAGE', 'SCRIPT_INPUT_TYPE', 'SCRIPT_TYPE'],
                    scripts.map(([, name]) => [name, 'LUA', null, 'PREPROCESSOR'])
                );
            }
            return createEmptyRawResult(['DUMMY']);
        }
    });
    const provider = new ObjectTreeProvider(asConnectionManager(manager));
    const changed: unknown[] = [];
    provider.onDidChangeTreeData(node => { changed.push(node); });
    return { provider, manager, queries, changed };
}

function makeSchemaItem(schemaName: string): InstanceType<typeof ObjectTreeItem> {
    return new ObjectTreeItem({
        label: schemaName, id: `conn-1:${schemaName}`, collapsibleState: 1, type: 'schema',
        connection: TEST_CONNECTION, schemaName
    });
}

/** Expands the schema and its Preprocessors folder, then lets the marker read finish. */
async function expandPreprocessors(provider: InstanceType<typeof ObjectTreeProvider>, schemaName = 'VS_PP') {
    const schemaChildren = await provider.getChildren(makeSchemaItem(schemaName)) as Array<InstanceType<typeof ObjectTreeItem>>;
    const folder = schemaChildren.find(child => child.type === 'preprocessors-folder');
    assert.ok(folder, 'Preprocessors folder missing');
    const nodes = await provider.getChildren(folder) as Array<InstanceType<typeof ObjectTreeItem>>;
    await new Promise(resolve => setImmediate(resolve));
    return { folder, nodes };
}

suite('ObjectTreeProvider, Preprocessors folder', () => {
    test('a schema with preprocessor scripts gets a Preprocessors folder with their count', async () => {
        const { provider } = makePreprocessorProvider([null, null]);

        const { folder, nodes } = await expandPreprocessors(provider);

        assert.strictEqual(folder.label, 'Preprocessors');
        assert.strictEqual(folder.id, 'conn-1:VS_PP:preprocessors-folder');
        assert.strictEqual(folder.description, '2');
        assert.strictEqual(folder.contextValue, 'preprocessors-folder');
        assert.deepStrictEqual(nodes.map(node => node.label), ['MY_PP', 'OTHER_PP']);
        assert.strictEqual(nodes[0].contextValue, 'script-preprocessor');
        assert.strictEqual((nodes[0].iconPath as { id?: string }).id, 'filter');
        assert.strictEqual(nodes[0].description, 'LUA');
        assert.strictEqual(nodes[0].parent, folder);
    });

    test('a schema without preprocessor scripts has no Preprocessors folder', async () => {
        const provider = new ObjectTreeProvider(asConnectionManager(new MockConnectionManager({
            query: async (sql: string) => sql.includes('GROUP BY SCRIPT_TYPE')
                ? createRawResult(['SCRIPT_TYPE', 'SCRIPT_COUNT'], [['UDF', 1]])
                : createEmptyRawResult(['DUMMY'])
        })));

        const children = await provider.getChildren(makeSchemaItem('VS_PP')) as Array<InstanceType<typeof ObjectTreeItem>>;

        assert.deepStrictEqual(children.map(child => child.type), ['tables-folder', 'views-folder', 'udfs-folder']);
    });

    test('the session value marks its script "active", read on the user session only on expand', async () => {
        const { provider, manager, queries, changed } = makePreprocessorProvider(['VS_PP.MY_PP', null]);

        await provider.getChildren(makeSchemaItem('VS_PP'));
        assert.ok(!queries.some(q => q.includes('EXA_PARAMETERS')), 'the schema expand must not read the parameter');
        const { nodes } = await expandPreprocessors(provider);

        assert.strictEqual(nodes[0].description, 'LUA, active');
        assert.strictEqual(nodes[0].tooltip, 'SQL_PREPROCESSOR_SCRIPT\nSession value: VS_PP.MY_PP\nSystem value: NULL');
        assert.strictEqual(nodes[1].description, 'LUA');
        assert.deepStrictEqual(changed, [nodes[0]]);
        const parameterQueries = queries.filter(q => q.includes('EXA_PARAMETERS'));
        assert.strictEqual(parameterQueries.length, 1);
        assert.match(parameterQueries[0], /SELECT SESSION_VALUE, SYSTEM_VALUE\s+FROM SYS\.EXA_PARAMETERS\s+WHERE PARAMETER_NAME = 'SQL_PREPROCESSOR_SCRIPT'/);
        assert.strictEqual(manager.roles[manager.roles.length - 1], 'user');
        assert.ok(manager.roles.slice(0, -1).every(role => role === 'background'), 'scripts are read on the background session');
    });

    test('only the system value naming a script gives "system value"', async () => {
        const { provider } = makePreprocessorProvider(['VS_PP.OTHER_PP', 'VS_PP.MY_PP']);

        const { nodes } = await expandPreprocessors(provider);

        assert.strictEqual(nodes[0].description, 'LUA, system value');
        assert.strictEqual(nodes[0].tooltip, 'SQL_PREPROCESSOR_SCRIPT\nSession value: VS_PP.OTHER_PP\nSystem value: VS_PP.MY_PP');
        assert.strictEqual(nodes[1].description, 'LUA, active');
    });

    test('quoted names in the parameter match the stored names', async () => {
        const { provider } = makePreprocessorProvider(['"vs_pp_lower"."a.b""c"', null], [['vs_pp_lower', 'a.b"c'], ['vs_pp_lower', 'A']]);

        const { nodes } = await expandPreprocessors(provider, 'vs_pp_lower');

        assert.strictEqual(nodes[0].description, 'LUA, active');
        assert.strictEqual(nodes[1].description, 'LUA');
    });

    test('a script of the same name in another schema is not marked', async () => {
        const { provider, changed } = makePreprocessorProvider(['OTHER_SCHEMA.MY_PP', 'OTHER_SCHEMA.MY_PP']);

        const { nodes } = await expandPreprocessors(provider);

        assert.deepStrictEqual(nodes.map(node => node.description), ['LUA', 'LUA']);
        assert.deepStrictEqual(changed, []);
    });

    test('a failed parameter read leaves the scripts unmarked', async () => {
        const { provider, changed } = makePreprocessorProvider('error');

        const { nodes } = await expandPreprocessors(provider);

        assert.deepStrictEqual(nodes.map(node => node.description), ['LUA', 'LUA']);
        assert.strictEqual(nodes[0].tooltip, undefined);
        assert.deepStrictEqual(changed, []);
    });

    test('without an open user session the marker is skipped and no session is opened', async () => {
        const { provider, manager, queries, changed } = makePreprocessorProvider(['VS_PP.MY_PP', null]);
        manager.userSession = false;

        const { nodes } = await expandPreprocessors(provider);

        assert.deepStrictEqual(nodes.map(node => node.description), ['LUA', 'LUA']);
        assert.ok(!queries.some(q => q.includes('EXA_PARAMETERS')));
        assert.ok(!manager.roles.includes('user'), 'no user driver may be requested');
        assert.strictEqual(manager.userRetries, 0, 'the read may not wait for the user session');
        assert.deepStrictEqual(changed, []);
    });

    test('a marker read queued while the active connection changed is skipped', async () => {
        const { provider, manager, queries, changed } = makePreprocessorProvider(['VS_PP.MY_PP', null]);
        manager.whileQueued = () => { manager.activeConnection = { ...TEST_CONNECTION, id: 'conn-2', name: 'Other' }; };

        const { nodes } = await expandPreprocessors(provider);

        assert.deepStrictEqual(nodes.map(node => node.description), ['LUA', 'LUA']);
        assert.ok(!queries.some(q => q.includes('EXA_PARAMETERS')));
        assert.ok(!manager.roles.includes('user'), 'no user driver may be requested for the old connection');
        assert.strictEqual(manager.userRetries, 1, 'the read waits once, then sees the switch');
        assert.deepStrictEqual(changed, []);
    });

    test('dragging a preprocessor gives its quoted qualified name', async () => {
        const { provider } = makePreprocessorProvider([null, null]);
        const { nodes } = await expandPreprocessors(provider);
        const store = new Map<string, { value?: unknown }>();
        const dataTransfer = { set: (mime: string, value: { value?: unknown }) => { store.set(mime, value); } };

        await provider.handleDrag([nodes[0]], dataTransfer as unknown as vscode.DataTransfer, {} as vscode.CancellationToken);

        assert.strictEqual(store.get('text/plain')?.value, '"VS_PP"."MY_PP"');
    });
});
