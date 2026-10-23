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
const { findTableReferences } = require('../../utils/completionContext') as typeof import('../../utils/completionContext');

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

    suite('comma-joined tables', () => {
        test('FROM s.a x, s.b y', () => {
            const m = parseAliases('SELECT y. FROM s.a x, s.b y');
            assert.deepStrictEqual(m.get('X'), { schema: 'S', table: 'A' });
            assert.deepStrictEqual(m.get('Y'), { schema: 'S', table: 'B' });
        });

        test('AS, quoted and schema-qualified names', () => {
            const m = parseAliases('SELECT * FROM s.a AS x, "s"."b c" AS "y", t z');
            assert.deepStrictEqual(m.get('X'), { schema: 'S', table: 'A' });
            assert.deepStrictEqual(m.get('y'), { schema: 's', table: 'b c' });
            assert.deepStrictEqual(m.get('Z'), { table: 'T' });
        });

        test('a table after a JOIN and its ON condition', () => {
            const m = parseAliases('SELECT * FROM a x JOIN b y ON x.id = y.id, c z WHERE z.k IN (1, 2)');
            assert.deepStrictEqual(m.get('Z'), { table: 'C' });
        });

        test('commas outside the FROM list are not tables', () => {
            const m = parseAliases(
                'SELECT a, b c FROM t, u WHERE x IN (d, e f) GROUP BY g, h i ORDER BY j, k l;\n'
                + 'SELECT m, n o FROM v WHERE EXTRACT(DAY FROM d) = 1, p q'
            );
            assert.deepStrictEqual([...m.keys()], []);
        });

        test('a table without alias before a comma or a JOIN', () => {
            const m = parseAliases('SELECT * FROM a, b y JOIN c z ON 1 = 1');
            assert.deepStrictEqual(m.get('Y'), { table: 'B' });
            assert.deepStrictEqual(m.get('Z'), { table: 'C' });
            assert.deepStrictEqual(parseAliases('SELECT * FROM a JOIN b y ON 1 = 1').get('Y'), { table: 'B' });
        });

        test('a comma-joined table in a subquery', () => {
            const m = parseAliases('SELECT * FROM (SELECT 1 FROM a x, b y) d, c z');
            assert.deepStrictEqual(m.get('Y'), { table: 'B' });
            assert.deepStrictEqual(m.get('Z'), { table: 'C' });
        });
    });

    suite('FROM that does not start a FROM clause', () => {
        test('IS [NOT] DISTINCT FROM is a predicate', () => {
            assert.deepStrictEqual([...parseAliases('SELECT a IS DISTINCT FROM b, c d FROM t').keys()], []);
            const m = parseAliases('SELECT * FROM t x WHERE a IS NOT DISTINCT FROM b AND c = 1');
            assert.deepStrictEqual([...m.keys()], ['X']);
        });

        test('text in strings, quoted identifiers and comments is not SQL', () => {
            const m = parseAliases(
                "SELECT 'a, b FROM x y' AS \"from p q\" FROM t u -- FROM c d\n/* JOIN e f */ JOIN \"g\" h ON 1 = 1"
            );
            assert.deepStrictEqual([...m.entries()], [['U', { table: 'T' }], ['H', { table: 'g' }]]);
        });

        test('FROM inside the parentheses of a function', () => {
            const m = parseAliases(
                "SELECT SUBSTRING(x FROM 1 FOR 2), TRIM(LEADING 'a' FROM s) a, EXTRACT(YEAR FROM d) e,"
                + " POSITION(a IN b) p, OVERLAY(s PLACING r FROM 2 FOR 3) o FROM t u"
            );
            assert.deepStrictEqual([...m.entries()], [['U', { table: 'T' }]]);
            const sub = parseAliases('SELECT * FROM (SELECT SUBSTRING(x FROM 1 FOR 2) FROM a x) d, b y');
            assert.deepStrictEqual([...sub.entries()], [['X', { table: 'A' }], ['Y', { table: 'B' }]]);
        });

        test('VALUES is not a table', () => {
            assert.deepStrictEqual([...parseAliases('SELECT v. FROM VALUES (1, 2) AS v(a, b)').keys()], []);
            const m = parseAliases('SELECT * FROM VALUES (1, 2), (3, 4) v(a, b), t x');
            assert.deepStrictEqual([...m.entries()], [['X', { table: 'T' }]]);
        });

        test('FROM inside a longer word', () => {
            assert.deepStrictEqual([...parseAliases('SELECT xfrom t y, datefrom FROM u').keys()], []);
        });

        test('IMPORT FROM a file or a database', () => {
            const m = parseAliases(
                "IMPORT INTO t FROM LOCAL CSV FILE 'a.csv';\nIMPORT INTO t FROM EXA AT c TABLE s.x;\n"
                + "IMPORT INTO t FROM SCRIPT s.x WITH a = 'b'"
            );
            assert.deepStrictEqual([...m.keys()], []);
        });

        test('the FROM of IMPORT names no table', () => {
            const sql = "IMPORT INTO t FROM JDBC DRIVER = 'd' AT c STATEMENT 'SELECT * FROM a x';\n"
                + 'IMPORT INTO t FROM ORA AT c TABLE x;\nIMPORT INTO s.t (a, b) FROM EXA AT c TABLE s.x;\n'
                + "IMPORT INTO t FROM LOCAL CSV FILE 'a.csv';\nEXPORT t INTO CSV AT c FILE 'a.csv'";
            assert.deepStrictEqual(findTableReferences(sql), []);
            const after = parseAliases("IMPORT INTO t FROM JDBC DRIVER = 'd' AT c TABLE x; SELECT * FROM a y");
            assert.deepStrictEqual([...after.entries()], [['Y', { table: 'A' }]]);
            const sub = parseAliases(
                "SELECT * FROM (IMPORT INTO (i INT) FROM JDBC DRIVER = 'd' AT c TABLE x) y, b z;\n"
                + 'EXPORT (SELECT * FROM a x) INTO CSV AT c FILE \'a.csv\''
            );
            assert.deepStrictEqual([...sub.entries()], [['Z', { table: 'B' }], ['X', { table: 'A' }]]);
        });

        test('join keywords are not aliases', () => {
            for (const join of ['NATURAL JOIN', 'NATURAL LEFT OUTER JOIN', 'LEFT JOIN', 'RIGHT OUTER JOIN',
                'FULL JOIN', 'INNER JOIN', 'CROSS JOIN', 'JOIN']) {
                assert.deepStrictEqual(findTableReferences(`SELECT * FROM a ${join} b y`),
                    [{ table: 'A' }, { table: 'B', alias: 'Y' }], join);
            }
            assert.deepStrictEqual(findTableReferences('SELECT * FROM a JOIN b ON 1 = 1 JOIN c USING (k)'),
                [{ table: 'A' }, { table: 'B' }, { table: 'C' }]);
        });

        test('a long statement is parsed in linear time', () => {
            const text = 'SELECT ' + 'SUBSTRING(x FROM 1 FOR 2), a IS DISTINCT FROM b, '.repeat(20000)
                + "'FROM a b', 1 FROM " + 'a x, '.repeat(20000) + 't y';
            const started = performance.now();
            const m = parseAliases(text);
            const elapsed = performance.now() - started;
            assert.deepStrictEqual([...m.entries()], [['X', { table: 'A' }], ['Y', { table: 'T' }]]);
            assert.ok(elapsed < 500, `took ${elapsed.toFixed(0)} ms`);
        });
    });
});
