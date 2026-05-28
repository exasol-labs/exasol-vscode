import * as assert from 'assert';
import { registerVscodeMock, registerExtensionMock, vscodeMock } from '../helpers/vscodeMock';

(vscodeMock as any).CompletionItemKind = {
    Interface: 7, Method: 1, Function: 2, Class: 6, Module: 8, Field: 4, Keyword: 13,
};
(vscodeMock as any).CompletionItem = class { constructor(public label: string, public kind?: number) {} };
(vscodeMock as any).MarkdownString = class { constructor(public value: string) {} };
(vscodeMock as any).SnippetString = class { constructor(public value: string) {} };

registerVscodeMock();
registerExtensionMock();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolvePrefixCompletions } = require('../../providers/completionProvider');

type AliasTarget = { schema?: string; table: string };
type DatabaseObject = {
    schema: string;
    name: string;
    type: 'table' | 'view' | 'script' | 'function' | 'virtual-table' | 'system-table';
};

function objs(): DatabaseObject[] {
    return [
        { schema: 'SCHEMA_A', name: 'TABLE_X', type: 'table' },
        { schema: 'SCHEMA_A', name: 'TABLE_C', type: 'table' },
        { schema: 'PUBLIC', name: 'ORDERS', type: 'view' },
    ];
}

suite('resolvePrefixCompletions', () => {
    test('alias resolves -> columns kind with normalised schema/table', () => {
        const aliases = new Map<string, AliasTarget>([['B', { schema: 'SCHEMA_A', table: 'TABLE_X' }]]);
        const r = resolvePrefixCompletions(objs(), aliases, 'b');
        assert.deepStrictEqual(r, { kind: 'columns', schema: 'SCHEMA_A', table: 'TABLE_X' });
    });

    test('alias parsed but table not in cache -> empty kind (regression: NO schema fallthrough)', () => {
        // Bug A reproduction: previously, when the column cache was poisoned (undefined),
        // the provider was tempted to fall through to the schema list. The resolver must
        // surface this as 'empty' so the provider returns [] instead of schemas.
        const aliases = new Map<string, AliasTarget>([['B', { schema: 'SCHEMA_A', table: 'GHOST_TABLE' }]]);
        const r = resolvePrefixCompletions(objs(), aliases, 'b');
        assert.deepStrictEqual(r, { kind: 'empty' });
    });

    test('bare schema prefix -> schemaObjects kind', () => {
        const r = resolvePrefixCompletions(objs(), new Map(), 'schema_a');
        assert.strictEqual(r.kind, 'schemaObjects');
        assert.strictEqual(r.objects.length, 2);
    });

    test('bare table name -> columns kind with that table schema/name', () => {
        const r = resolvePrefixCompletions(objs(), new Map(), 'orders');
        assert.deepStrictEqual(r, { kind: 'columns', schema: 'PUBLIC', table: 'ORDERS' });
    });

    test('unknown prefix -> none kind', () => {
        const r = resolvePrefixCompletions(objs(), new Map(), 'nope');
        assert.deepStrictEqual(r, { kind: 'none' });
    });

    test('alias with schema match disambiguates between identically named tables', () => {
        const objects: DatabaseObject[] = [
            { schema: 'A', name: 'T', type: 'table' },
            { schema: 'B', name: 'T', type: 'table' },
        ];
        const aliases = new Map<string, AliasTarget>([['X', { schema: 'B', table: 'T' }]]);
        const r = resolvePrefixCompletions(objects, aliases, 'x');
        assert.deepStrictEqual(r, { kind: 'columns', schema: 'B', table: 'T' });
    });
});
