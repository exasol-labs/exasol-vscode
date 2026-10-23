import * as assert from 'assert';
import type { DatabaseObject, AliasTarget } from '../../providers/completionProvider';
import { registerVscodeMock, registerExtensionMock, vscodeMock } from '../helpers/vscodeMock';
import { applyCompletionVscodeMock } from '../helpers/completionMocks';

// Mocks must be applied BEFORE registerVscodeMock(); see the load-order note
// at the top of completionMocks.ts.
applyCompletionVscodeMock(vscodeMock);

registerVscodeMock();
registerExtensionMock();

// completionProvider.ts imports `vscode` at module scope, so it must stay a
// deferred require() issued AFTER the mocks above are registered. A static
// import would resolve 'vscode' before require.cache is patched.
const { parseAliases, resolvePrefixCompletions } = require('../../providers/completionProvider') as typeof import('../../providers/completionProvider');

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
        if (r.kind !== 'schemaObjects') { throw new Error('unreachable'); }
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
    test('a quoted alias target matches only the object with that exact name', () => {
        const objects: DatabaseObject[] = [
            { schema: 'S', name: 'T', type: 'table' },
            { schema: 'S', name: 't', type: 'table' },
        ];
        const quoted = new Map<string, AliasTarget>([['X', { schema: 'S', table: 't' }]]);
        assert.deepStrictEqual(resolvePrefixCompletions(objects, quoted, 'x'), { kind: 'columns', schema: 'S', table: 't' });
        const unquoted = new Map<string, AliasTarget>([['X', { schema: 'S', table: 'T' }]]);
        assert.deepStrictEqual(resolvePrefixCompletions(objects, unquoted, 'x'), { kind: 'columns', schema: 'S', table: 'T' });
    });

    test('a quoted prefix is compared as written', () => {
        const objects: DatabaseObject[] = [
            { schema: 'S', name: 'T', type: 'table' },
            { schema: 'S', name: 'lower v', type: 'table' },
        ];
        assert.deepStrictEqual(resolvePrefixCompletions(objects, new Map(), '"lower v"'), { kind: 'columns', schema: 'S', table: 'lower v' });
        assert.deepStrictEqual(resolvePrefixCompletions(objects, new Map(), '"t"'), { kind: 'none' });
        assert.strictEqual(resolvePrefixCompletions(objects, new Map(), '"S"').kind, 'schemaObjects');
    });

    test('alias of the second comma-joined table resolves to its columns', () => {
        const objects: DatabaseObject[] = [
            { schema: 'S', name: 'A', type: 'table' },
            { schema: 'S', name: 'B', type: 'table' },
            { schema: 's', name: 'b c', type: 'table' }
        ];
        const r = resolvePrefixCompletions(objects, parseAliases('SELECT y. FROM s.a x, s.b y'), 'y');
        assert.deepStrictEqual(r, { kind: 'columns', schema: 'S', table: 'B' });
        const quoted = resolvePrefixCompletions(objects, parseAliases('SELECT "y". FROM s.a AS x, "s"."b c" AS "y"'), '"y"');
        assert.deepStrictEqual(quoted, { kind: 'columns', schema: 's', table: 'b c' });
    });
});
