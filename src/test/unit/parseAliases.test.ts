import * as assert from 'assert';
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
const { parseAliases } = require('../../providers/completionProvider') as typeof import('../../providers/completionProvider');

suite('parseAliases', () => {
    test('unquoted: FROM users u', () => {
        const m = parseAliases('SELECT * FROM users u');
        assert.deepStrictEqual(m.get('U'), { table: 'USERS' });
    });

    test('unquoted with AS: FROM users AS u', () => {
        const m = parseAliases('SELECT * FROM users AS u');
        assert.deepStrictEqual(m.get('U'), { table: 'USERS' });
    });

    test('INNER JOIN orders o', () => {
        const m = parseAliases('SELECT * FROM a x INNER JOIN orders o ON x.id = o.id');
        assert.deepStrictEqual(m.get('O'), { table: 'ORDERS' });
        assert.deepStrictEqual(m.get('X'), { table: 'A' });
    });

    test('LEFT OUTER JOIN products p', () => {
        const m = parseAliases('SELECT * FROM a x LEFT OUTER JOIN products p ON x.id = p.id');
        assert.deepStrictEqual(m.get('P'), { table: 'PRODUCTS' });
    });

    test('schema-qualified unquoted: FROM schema.table t', () => {
        const m = parseAliases('SELECT * FROM myschema.mytable t');
        assert.deepStrictEqual(m.get('T'), { schema: 'MYSCHEMA', table: 'MYTABLE' });
    });

    test('quoted table only: JOIN "Table" AS t', () => {
        const m = parseAliases('SELECT * FROM a x JOIN "Table" AS t ON x.id = t.id');
        assert.deepStrictEqual(m.get('T'), { table: 'Table' });
    });

    test('quoted schema and quoted table: FROM "SCHEMA_A"."TABLE_X" AS b', () => {
        const m = parseAliases('SELECT * FROM "SCHEMA_A"."TABLE_X" AS b WHERE 1=1');
        assert.deepStrictEqual(m.get('B'), { schema: 'SCHEMA_A', table: 'TABLE_X' });
    });

    test('quoted schema, unquoted table', () => {
        const m = parseAliases('SELECT * FROM "SCHEMA_A".table_x b');
        assert.deepStrictEqual(m.get('B'), { schema: 'SCHEMA_A', table: 'TABLE_X' });
    });

    test('unquoted schema, quoted table', () => {
        const m = parseAliases('SELECT * FROM schema_a."TABLE_X" b');
        assert.deepStrictEqual(m.get('B'), { schema: 'SCHEMA_A', table: 'TABLE_X' });
    });

    test('skips SQL keywords as aliases (no alias case)', () => {
        const m = parseAliases('SELECT * FROM users WHERE id = 1');
        assert.strictEqual(m.has('WHERE'), false);
        assert.strictEqual(m.size, 0);
    });

    test('skips ON after JOIN without alias', () => {
        const m = parseAliases('SELECT * FROM a x JOIN orders ON x.id = orders.id');
        assert.strictEqual(m.has('ON'), false);
    });

    test('case-insensitive keywords (lowercase from/join)', () => {
        const m = parseAliases('select * from users u inner join orders o on u.id = o.uid');
        assert.deepStrictEqual(m.get('U'), { table: 'USERS' });
        assert.deepStrictEqual(m.get('O'), { table: 'ORDERS' });
    });

    test('multiple FROM/JOIN entries with mixed quoting', () => {
        const sql = `
            SELECT *
            FROM "S1"."T1" a
            JOIN s2.t2 b ON a.id = b.id
            LEFT JOIN "T3" c ON b.id = c.id
        `;
        const m = parseAliases(sql);
        assert.deepStrictEqual(m.get('A'), { schema: 'S1', table: 'T1' });
        assert.deepStrictEqual(m.get('B'), { schema: 'S2', table: 'T2' });
        assert.deepStrictEqual(m.get('C'), { table: 'T3' });
    });

    test('ignores alias identical to table name', () => {
        const m = parseAliases('SELECT * FROM users users');
        assert.strictEqual(m.has('USERS'), false);
    });

    test('exact bug-report query: quoted schema.table with as alias then comments', () => {
        const sql = `select * from "SCHEMA_A"."TABLE_X" as b
where 1=1
    --b.col_a = '90'
    --and b.col_d = '2025'
    and b.
limit 100;`;
        const m = parseAliases(sql);
        assert.deepStrictEqual(m.get('B'), { schema: 'SCHEMA_A', table: 'TABLE_X' });
    });

    test('screenshot layout: active b.column line appears BEFORE the commented-out b.column lines', () => {
        // Verbatim from the second bug-report screenshot. The active reference
        // ("and b.") sits between the FROM clause and a block of commented-out
        // predicates that also contain b.<col> patterns. The regex must still
        // resolve `b` to the table from the FROM line, not be confused by the
        // commented references below it.
        const sql = `select * from "SCHEMA_A"."TABLE_X" as b
where 1=1
    and b.
    --b.col_a = '90'
    --and b.col_d = '2025'
limit 100;`;
        const m = parseAliases(sql);
        assert.deepStrictEqual(m.get('B'), { schema: 'SCHEMA_A', table: 'TABLE_X' });
        // Sanity: only the FROM-declared alias is in the map; commented lines
        // must not introduce phantom entries.
        assert.strictEqual(m.size, 1, `expected only B alias; got: ${JSON.stringify([...m.entries()])}`);
    });
    test('quoted names keep their case and unescape doubled quotes; unquoted ones are uppercased', () => {
        const m = parseAliases('SELECT * FROM s."t" a JOIN s.t b ON 1=1 JOIN "My ""S"""."x y" c ON 1=1');
        assert.deepStrictEqual(m.get('A'), { schema: 'S', table: 't' });
        assert.deepStrictEqual(m.get('B'), { schema: 'S', table: 'T' });
        assert.deepStrictEqual(m.get('C'), { schema: 'My "S"', table: 'x y' });
    });

    test('an alias equal to a quoted lowercase table name is kept', () => {
        const m = parseAliases('SELECT * FROM "users" users');
        assert.deepStrictEqual(m.get('USERS'), { table: 'users' });
    });

    test('quoted aliases, with and without AS', () => {
        const m = parseAliases('SELECT * FROM s.t AS "x" JOIN s.u "My T" ON 1=1 JOIN s.v AS w ON 1=1');
        assert.deepStrictEqual(m.get('x'), { schema: 'S', table: 'T' });
        assert.deepStrictEqual(m.get('My T'), { schema: 'S', table: 'U' });
        assert.deepStrictEqual(m.get('W'), { schema: 'S', table: 'V' });
        assert.strictEqual(m.has('AS'), false);
    });
});
