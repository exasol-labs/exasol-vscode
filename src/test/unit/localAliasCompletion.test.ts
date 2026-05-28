import * as assert from 'assert';
import {
    parseSelectListAliases,
    extractSelectListText,
    parseEnclosingSelectListAliases,
    findEnclosingSelectListText
} from '../../utils/selectAliases';
import { findStatementAtCursor } from '../../utils';

function names(stmt: string): string[] {
    return parseSelectListAliases(stmt).map(a => a.name);
}

suite('parseSelectListAliases', () => {
    test('screenshot fixture: mix of AS alias and bare column.dot references', () => {
        const stmt = `select
  c.date_id,
  c.email,
  coalesce(e.display_name, c.user_name) as user_name,
  e.department,
  e.site,
  f.stream,
  c.usage_type,
  c.usage_units,
  c.usage_credits,
  c.usage_quantity
from schema_b.table_y as c
left join schema_c.table_z as e on c.email = e.email
left join schema_c.table_w as f on e.table_z_id = f.table_z_id
where local.`;
        assert.deepStrictEqual(names(stmt), [
            'date_id', 'email', 'user_name', 'department', 'site',
            'stream', 'usage_type', 'usage_units', 'usage_credits', 'usage_quantity'
        ]);
    });

    test('explicit AS alias', () => {
        assert.deepStrictEqual(names('SELECT ABS(x) AS x FROM t WHERE local.'), ['x']);
    });

    test('bare column without table qualifier', () => {
        assert.deepStrictEqual(names('SELECT email FROM users WHERE local.'), ['email']);
    });

    test('SELECT * returns no aliases', () => {
        assert.deepStrictEqual(names('SELECT * FROM t WHERE local.'), []);
    });

    test('table.* skipped, sibling aliases kept', () => {
        assert.deepStrictEqual(
            names('SELECT t.*, x AS y FROM t WHERE local.'),
            ['y']
        );
    });

    test('nested subquery aliases do not leak into outer list', () => {
        const stmt = `SELECT
            outer_col,
            (SELECT max(inner_col) AS leaked FROM other) AS sub_total
          FROM t
          WHERE local.`;
        assert.deepStrictEqual(names(stmt), ['outer_col', 'sub_total']);
    });

    test('quoted alias keeps unescaped name and marks quoted=true', () => {
        const aliases = parseSelectListAliases('SELECT x AS "User Name" FROM t WHERE local.');
        assert.strictEqual(aliases.length, 1);
        assert.strictEqual(aliases[0].name, 'User Name');
        assert.strictEqual(aliases[0].quoted, true);
    });

    test('embedded double-quote escape: "He said ""hi"""', () => {
        const aliases = parseSelectListAliases('SELECT x AS "He said ""hi""" FROM t WHERE local.');
        assert.strictEqual(aliases.length, 1);
        assert.strictEqual(aliases[0].name, 'He said "hi"');
        assert.strictEqual(aliases[0].quoted, true);
    });

    test('no FROM clause: SELECT 1 AS one', () => {
        assert.deepStrictEqual(names('SELECT 1 AS one'), ['one']);
    });

    test('expression without AS is skipped (false-positive guard)', () => {
        // `coalesce(a, b)` has no alias; do NOT promote `b` as alias.
        assert.deepStrictEqual(names('SELECT coalesce(a, b), c.id FROM t'), ['id']);
    });

    test('CASE expression without AS is skipped', () => {
        assert.deepStrictEqual(
            names("SELECT CASE WHEN x > 0 THEN 'a' ELSE 'b' END, id FROM t"),
            ['id']
        );
    });

    test('comments inside SELECT list do not break parsing', () => {
        const stmt = `SELECT
            a AS first,        -- inline note
            /* skip me */ b AS second,
            c.id
          FROM t`;
        assert.deepStrictEqual(names(stmt), ['first', 'second', 'id']);
    });

    test('strings containing commas/keywords do not split items', () => {
        const stmt = `SELECT 'a, b FROM nowhere' AS s, x FROM t`;
        assert.deepStrictEqual(names(stmt), ['s', 'x']);
    });

    test('case-insensitive AS keyword', () => {
        assert.deepStrictEqual(names('SELECT 1 as one, 2 As two, 3 AS three FROM t'), ['one', 'two', 'three']);
    });

    test('trailing comma / mid-edit does not crash; returns parseable entries', () => {
        const stmt = `SELECT a AS first, b AS second, FROM t WHERE local.`;
        // The empty trailing item is skipped; surviving aliases must come through.
        const got = names(stmt);
        assert.ok(got.includes('first'));
        assert.ok(got.includes('second'));
    });

    test('duplicate aliases de-duplicated (first occurrence kept)', () => {
        assert.deepStrictEqual(
            names('SELECT a AS x, b AS x FROM t'),
            ['x']
        );
    });

    test('no SELECT keyword returns empty', () => {
        assert.deepStrictEqual(names('DELETE FROM t WHERE id = 1'), []);
    });

    test('extractSelectListText returns text between SELECT and FROM', () => {
        const list = extractSelectListText('SELECT a, b, c FROM t');
        assert.ok(list);
        assert.strictEqual(list!.trim(), 'a, b, c');
    });

    test('extractSelectListText handles missing FROM', () => {
        const list = extractSelectListText('SELECT 1 AS one');
        assert.ok(list);
        assert.strictEqual(list!.trim(), '1 AS one');
    });
});

suite('LOCAL.<alias>: current-statement scoping', () => {
    test('cursor in statement 2 of multi-statement file: only stmt 2 aliases parsed', () => {
        const doc = `SELECT one AS a FROM t1;

SELECT two AS b, three AS c FROM t2;`;
        // Cursor on line 2 (the "SELECT two..." line)
        const stmt = findStatementAtCursor(doc, 2);
        assert.ok(stmt);
        assert.deepStrictEqual(names(stmt!.text), ['b', 'c']);
    });

    test('cursor in statement 1: only stmt 1 aliases parsed', () => {
        const doc = `SELECT one AS a FROM t1;

SELECT two AS b FROM t2;`;
        const stmt = findStatementAtCursor(doc, 0);
        assert.ok(stmt);
        assert.deepStrictEqual(names(stmt!.text), ['a']);
    });
});

function encNames(stmt: string, cursor: number): string[] {
    return parseEnclosingSelectListAliases(stmt, cursor).map(a => a.name);
}

suite('parseEnclosingSelectListAliases', () => {
    test('bug-report fixture: cursor inside CTE body reads INNER SELECT list', () => {
        const stmt = `WITH test AS (
  SELECT b.col_a AS m1, b.col_b FROM SCHEMA_A.TABLE_X AS b
  WHERE
    b.col_a = '90'
    AND local.HERE
)
SELECT * FROM test AS t
LIMIT 100;`;
        const cursor = stmt.indexOf('HERE');
        assert.ok(cursor > 0);
        assert.deepStrictEqual(encNames(stmt, cursor), ['m1', 'col_b']);
    });

    test('subquery in FROM: cursor inside subquery reads its own SELECT list', () => {
        const stmt = `SELECT * FROM (
  SELECT a AS aa, b AS bb FROM t WHERE local.HERE
) AS s`;
        const cursor = stmt.indexOf('HERE');
        assert.deepStrictEqual(encNames(stmt, cursor), ['aa', 'bb']);
    });

    test('nested CTE-in-CTE: cursor in inner CTE reads innermost SELECT', () => {
        const stmt = `WITH outer_cte AS (
  WITH inner_cte AS (
    SELECT x AS xx, y AS yy FROM t WHERE local.HERE
  )
  SELECT * FROM inner_cte
)
SELECT * FROM outer_cte;`;
        const cursor = stmt.indexOf('HERE');
        assert.deepStrictEqual(encNames(stmt, cursor), ['xx', 'yy']);
    });

    test('cursor in outer SELECT (after CTE close paren) reads outer list', () => {
        const stmt = `WITH test AS (
  SELECT b.col_a AS m1, b.col_b FROM SCHEMA_A.TABLE_X AS b
)
SELECT t.col_a AS oh FROM test AS t WHERE local.HERE
LIMIT 100;`;
        const cursor = stmt.indexOf('HERE');
        assert.deepStrictEqual(encNames(stmt, cursor), ['oh']);
    });

    test('cursor before any SELECT returns empty', () => {
        const stmt = `WITH HERE test AS (SELECT 1 AS a FROM dual) SELECT * FROM test`;
        const cursor = stmt.indexOf('HERE');
        assert.deepStrictEqual(encNames(stmt, cursor), []);
    });

    test('findEnclosingSelectListText returns inner list text', () => {
        const stmt = `WITH test AS (
  SELECT b.col_a AS m1, b.col_b FROM SCHEMA_A.TABLE_X AS b
  WHERE local.HERE
) SELECT * FROM test`;
        const cursor = stmt.indexOf('HERE');
        const list = findEnclosingSelectListText(stmt, cursor);
        assert.ok(list);
        assert.match(list!, /m1/);
        assert.match(list!, /col_b/);
        // Outer SELECT list (`*`) must NOT be returned.
        assert.doesNotMatch(list!.trim(), /^\*$/);
    });
});
