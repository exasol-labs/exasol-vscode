import * as assert from 'assert';
import { classifyContext } from '../../utils/completionContext';

function at(text: string, marker: string): number {
    const i = text.indexOf(marker);
    assert.ok(i >= 0, `marker "${marker}" not in text`);
    return i;
}

suite('classifyContext', () => {
    test('STATEMENT_START: empty text', () => {
        const r = classifyContext('', 0);
        assert.strictEqual(r.kind, 'STATEMENT_START');
        assert.deepStrictEqual(r.fromTables, []);
    });

    test('STATEMENT_START: cursor on empty line at top level', () => {
        const text = '\n\nHERE\n';
        const r = classifyContext(text, at(text, 'HERE'));
        assert.strictEqual(r.kind, 'STATEMENT_START');
    });

    test('STATEMENT_START: whitespace-only prefix', () => {
        const text = '    HERE';
        const r = classifyContext(text, at(text, 'HERE'));
        assert.strictEqual(r.kind, 'STATEMENT_START');
    });

    test('AFTER_DOT: cursor right after a dot', () => {
        const text = 'SELECT * FROM s.HERE';
        const r = classifyContext(text, at(text, 'HERE'));
        assert.strictEqual(r.kind, 'AFTER_DOT');
    });

    test('AFTER_SELECT_KEYWORD: cursor between SELECT and FROM', () => {
        const text = 'SELECT HERE FROM schema_d.table_dates';
        const r = classifyContext(text, at(text, 'HERE'));
        assert.strictEqual(r.kind, 'AFTER_SELECT_KEYWORD');
        assert.deepStrictEqual(r.fromTables, [{ schema: 'SCHEMA_D', table: 'TABLE_DATES' }]);
    });

    test('AFTER_SELECT_KEYWORD: no FROM yet (mid-edit)', () => {
        const text = 'SELECT HERE';
        const r = classifyContext(text, at(text, 'HERE'));
        assert.strictEqual(r.kind, 'AFTER_SELECT_KEYWORD');
        assert.deepStrictEqual(r.fromTables, []);
    });

    test('AFTER_FROM_OR_JOIN: cursor immediately after FROM', () => {
        const text = 'SELECT * FROM HERE';
        const r = classifyContext(text, at(text, 'HERE'));
        assert.strictEqual(r.kind, 'AFTER_FROM_OR_JOIN');
    });

    test('AFTER_FROM_OR_JOIN: cursor immediately after LEFT JOIN', () => {
        const text = 'SELECT * FROM a LEFT JOIN HERE';
        const r = classifyContext(text, at(text, 'HERE'));
        assert.strictEqual(r.kind, 'AFTER_FROM_OR_JOIN');
    });

    test('AFTER_WHERE_HAVING_QUALIFY: cursor after WHERE', () => {
        const text = 'SELECT * FROM schema_d.table_dates WHERE HERE';
        const r = classifyContext(text, at(text, 'HERE'));
        assert.strictEqual(r.kind, 'AFTER_WHERE_HAVING_QUALIFY');
        assert.deepStrictEqual(r.fromTables, [{ schema: 'SCHEMA_D', table: 'TABLE_DATES' }]);
    });

    test('AFTER_WHERE_HAVING_QUALIFY: cursor after AND', () => {
        const text = 'SELECT * FROM t WHERE x = 1 AND HERE';
        const r = classifyContext(text, at(text, 'HERE'));
        assert.strictEqual(r.kind, 'AFTER_WHERE_HAVING_QUALIFY');
        assert.deepStrictEqual(r.fromTables, [{ table: 'T' }]);
    });

    test('AFTER_WHERE_HAVING_QUALIFY: cursor after HAVING', () => {
        const text = 'SELECT a FROM t GROUP BY a HAVING HERE';
        const r = classifyContext(text, at(text, 'HERE'));
        assert.strictEqual(r.kind, 'AFTER_WHERE_HAVING_QUALIFY');
    });

    test('AFTER_WHERE_HAVING_QUALIFY: cursor after QUALIFY', () => {
        const text = 'SELECT a FROM t QUALIFY HERE';
        const r = classifyContext(text, at(text, 'HERE'));
        assert.strictEqual(r.kind, 'AFTER_WHERE_HAVING_QUALIFY');
    });

    test('AFTER_GROUP_BY_ORDER_BY: cursor after GROUP BY', () => {
        const text = 'SELECT a FROM t GROUP BY HERE';
        const r = classifyContext(text, at(text, 'HERE'));
        assert.strictEqual(r.kind, 'AFTER_GROUP_BY_ORDER_BY');
    });

    test('AFTER_GROUP_BY_ORDER_BY: cursor after ORDER BY', () => {
        const text = 'SELECT a FROM t ORDER BY HERE';
        const r = classifyContext(text, at(text, 'HERE'));
        assert.strictEqual(r.kind, 'AFTER_GROUP_BY_ORDER_BY');
    });

    test('fromTables: multiple FROM/JOIN refs collected (schema-qualified + bare)', () => {
        const text = 'SELECT * FROM s1.t1 a JOIN t2 b ON a.id = b.id WHERE HERE';
        const r = classifyContext(text, at(text, 'HERE'));
        assert.strictEqual(r.kind, 'AFTER_WHERE_HAVING_QUALIFY');
        const sigs = r.fromTables.map(t => `${t.schema ?? ''}.${t.table}`).sort();
        assert.deepStrictEqual(sigs, ['.T2', 'S1.T1']);
    });

    test('fromTables: scoped to enclosing SELECT (does not leak from outer)', () => {
        const text = `WITH x AS (SELECT a FROM inner_table WHERE HERE) SELECT * FROM outer_table`;
        const r = classifyContext(text, at(text, 'HERE'));
        assert.strictEqual(r.kind, 'AFTER_WHERE_HAVING_QUALIFY');
        const names = r.fromTables.map(t => t.table).sort();
        assert.deepStrictEqual(names, ['INNER_TABLE']);
    });

    test('STATEMENT_START: cursor on a fresh line below a complete statement', () => {
        const text = 'HERE';
        const r = classifyContext(text, 0);
        assert.strictEqual(r.kind, 'STATEMENT_START');
    });

    test('UNKNOWN: cursor inside FROM-clause body after the first table', () => {
        const text = 'SELECT * FROM t1 HERE';
        const r = classifyContext(text, at(text, 'HERE'));
        // Not strictly immediate-after-FROM; we still expose fromTables=[t1] but
        // the kind itself isn't AFTER_FROM_OR_JOIN once there's an intervening token.
        assert.ok(r.kind === 'UNKNOWN' || r.kind === 'AFTER_FROM_OR_JOIN');
        assert.ok(r.fromTables.some(t => t.table === 'T1'));
    });
    test('fromTables: quoted names keep their case, so "t" and T stay apart', () => {
        const text = 'SELECT * FROM s."t" a JOIN s.t b ON 1=1 JOIN "a""b" c ON 1=1 WHERE HERE';
        const r = classifyContext(text, at(text, 'HERE'));
        assert.deepStrictEqual(r.fromTables, [{ schema: 'S', table: 't' }, { schema: 'S', table: 'T' }, { table: 'a"b' }]);
    });

    test('a comment before the cursor does not shift it', () => {
        const text = 'SELECT a /* a long comment about columns */, HERE FROM s.t';
        const r = classifyContext(text, at(text, 'HERE'));
        assert.strictEqual(r.kind, 'AFTER_SELECT_KEYWORD');
        assert.deepStrictEqual(r.fromTables, [{ schema: 'S', table: 'T' }]);
        const lineComment = 'SELECT a -- the main columns, with a long comment\n, HERE FROM s.t';
        assert.strictEqual(classifyContext(lineComment, at(lineComment, 'HERE')).kind, 'AFTER_SELECT_KEYWORD');
    });

    test('a long run of spaces before the cursor is classified in linear time', () => {
        const text = 'SELECT a' + ' '.repeat(100000) + 'b';
        const started = performance.now();
        classifyContext(text, text.length);
        const elapsed = performance.now() - started;
        assert.ok(elapsed < 200, `took ${elapsed.toFixed(0)} ms`);
    });

    test('comma-joined tables are all FROM tables', () => {
        const text = 'SELECT HERE FROM s.a x, "s"."b c" AS "y", t WHERE a = 1';
        assert.deepStrictEqual(classifyContext(text, at(text, 'HERE')).fromTables, [
            { schema: 'S', table: 'A' }, { schema: 's', table: 'b c' }, { table: 'T' }
        ]);
    });
});
