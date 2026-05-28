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
const { parseAliases } = require('../../providers/completionProvider');

suite('parseAliases', () => {
    test('unquoted: FROM users u', () => {
        const m = parseAliases('SELECT * FROM users u');
        assert.deepStrictEqual(m.get('U'), { table: 'users' });
    });

    test('unquoted with AS: FROM users AS u', () => {
        const m = parseAliases('SELECT * FROM users AS u');
        assert.deepStrictEqual(m.get('U'), { table: 'users' });
    });

    test('INNER JOIN orders o', () => {
        const m = parseAliases('SELECT * FROM a x INNER JOIN orders o ON x.id = o.id');
        assert.deepStrictEqual(m.get('O'), { table: 'orders' });
        assert.deepStrictEqual(m.get('X'), { table: 'a' });
    });

    test('LEFT OUTER JOIN products p', () => {
        const m = parseAliases('SELECT * FROM a x LEFT OUTER JOIN products p ON x.id = p.id');
        assert.deepStrictEqual(m.get('P'), { table: 'products' });
    });

    test('schema-qualified unquoted: FROM schema.table t', () => {
        const m = parseAliases('SELECT * FROM myschema.mytable t');
        assert.deepStrictEqual(m.get('T'), { schema: 'myschema', table: 'mytable' });
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
        assert.deepStrictEqual(m.get('B'), { schema: 'SCHEMA_A', table: 'table_x' });
    });

    test('unquoted schema, quoted table', () => {
        const m = parseAliases('SELECT * FROM schema_a."TABLE_X" b');
        assert.deepStrictEqual(m.get('B'), { schema: 'schema_a', table: 'TABLE_X' });
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
        assert.deepStrictEqual(m.get('U'), { table: 'users' });
        assert.deepStrictEqual(m.get('O'), { table: 'orders' });
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
        assert.deepStrictEqual(m.get('B'), { schema: 's2', table: 't2' });
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
});
