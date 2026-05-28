import * as assert from 'assert';
import { splitIntoStatements, findStatementEnds, stripCommentsPreservingStrings, buildLineOffsets, offsetToLine } from '../../utils';

suite('splitIntoStatements: string literal awareness', () => {
    test('semicolon inside string literal is not a statement boundary', () => {
        const statements = splitIntoStatements("INSERT INTO t VALUES ('a;b');");
        assert.strictEqual(statements.length, 1, 'should produce exactly 1 statement');
        assert.ok(statements[0].includes("'a;b'"), 'statement should contain the string literal');
    });

    test('two statements each containing a semicolon in a string', () => {
        const statements = splitIntoStatements("SELECT 'a;b'; SELECT 'c;d';");
        assert.strictEqual(statements.length, 2, 'should produce exactly 2 statements');
        assert.ok(statements[0].includes("'a;b'"));
        assert.ok(statements[1].includes("'c;d'"));
    });

    test('string that looks like a comment is not stripped', () => {
        const statements = splitIntoStatements("SELECT '--not a comment';");
        assert.strictEqual(statements.length, 1);
        assert.ok(statements[0].includes("'--not a comment'"), 'string content must not be stripped');
    });

    test('escaped single quote (doubled) stays in the string', () => {
        const statements = splitIntoStatements("SELECT 'O''Brien';");
        assert.strictEqual(statements.length, 1, 'escaped quote must not split the string into 2');
        assert.ok(statements[0].includes("'O''Brien'"));
    });

    test('block comment that starts before any SQL is stripped cleanly', () => {
        const statements = splitIntoStatements('/* /*nested*/ */ SELECT 1;');
        assert.strictEqual(statements.length, 1);
        assert.ok(statements[0].includes('SELECT 1'));
    });

    test('INSERT with semicolon in string followed by another statement', () => {
        const text = "INSERT INTO t VALUES ('hello;world');\nSELECT * FROM t;";
        const statements = splitIntoStatements(text);
        assert.strictEqual(statements.length, 2);
        assert.ok(statements[0].includes("'hello;world'"), 'first statement keeps string literal');
        assert.ok(statements[1].includes('SELECT * FROM t'), 'second statement is separate');
    });

    test('string containing block comment markers is not treated as a comment', () => {
        const statements = splitIntoStatements("SELECT '/* not a comment */' AS x;");
        assert.strictEqual(statements.length, 1);
        assert.ok(statements[0].includes("'/* not a comment */'"));
    });

    test('multiple semicolons inside a single string literal', () => {
        const statements = splitIntoStatements("SELECT 'a;b;c;d';");
        assert.strictEqual(statements.length, 1);
        assert.ok(statements[0].includes("'a;b;c;d'"));
    });
});

suite('findStatementEnds: string literal awareness', () => {
    test('returns empty array for empty string', () => {
        assert.deepStrictEqual(findStatementEnds(''), []);
    });

    test('finds single top-level semicolon', () => {
        const ends = findStatementEnds('SELECT 1;');
        assert.strictEqual(ends.length, 1);
        assert.strictEqual(ends[0], 8);
    });

    test('ignores semicolon inside string literal', () => {
        const ends = findStatementEnds("INSERT INTO t VALUES ('a;b');");
        // Only the final ';' at position 27 should be found
        assert.strictEqual(ends.length, 1);
    });

    test('ignores semicolon inside line comment', () => {
        const ends = findStatementEnds('SELECT 1 -- comment;\nWHERE 1=1;');
        // Only the ';' at the end of the WHERE clause
        assert.strictEqual(ends.length, 1);
    });

    test('ignores semicolon inside block comment', () => {
        const ends = findStatementEnds('SELECT 1 /* comment; */ WHERE 1=1;');
        assert.strictEqual(ends.length, 1);
    });

    test('handles escaped single quote inside string', () => {
        const ends = findStatementEnds("SELECT 'O''Brien';");
        assert.strictEqual(ends.length, 1);
    });

    test('finds two top-level semicolons', () => {
        const ends = findStatementEnds('SELECT 1; SELECT 2;');
        assert.strictEqual(ends.length, 2);
    });
});

suite('stripCommentsPreservingStrings', () => {
    test('returns plain SQL unchanged', () => {
        const sql = 'SELECT 1';
        assert.strictEqual(stripCommentsPreservingStrings(sql), sql);
    });

    test('strips single-line comment', () => {
        const result = stripCommentsPreservingStrings('SELECT 1 -- comment\nFROM t');
        assert.ok(!result.includes('-- comment'), 'comment should be removed');
        assert.ok(result.includes('SELECT 1'), 'SQL before comment preserved');
        assert.ok(result.includes('FROM t'), 'SQL after comment preserved');
    });

    test('strips block comment', () => {
        const result = stripCommentsPreservingStrings('SELECT /* comment */ 1');
        assert.ok(!result.includes('/* comment */'), 'block comment should be removed');
        assert.ok(result.includes('SELECT'), 'SELECT keyword preserved');
    });

    test('preserves string literal that looks like a comment', () => {
        const result = stripCommentsPreservingStrings("SELECT '--not a comment' AS x");
        assert.ok(result.includes("'--not a comment'"), 'string literal must be preserved');
    });

    test('preserves string literal containing block comment markers', () => {
        const result = stripCommentsPreservingStrings("SELECT '/* not a comment */' AS x");
        assert.ok(result.includes("'/* not a comment */'"), 'string literal must be preserved');
    });

    test('preserves escaped single quotes inside string', () => {
        const result = stripCommentsPreservingStrings("SELECT 'O''Brien'");
        assert.ok(result.includes("'O''Brien'"), 'escaped quotes must be preserved');
    });

    test('strips comment but keeps string with same characters', () => {
        const result = stripCommentsPreservingStrings("SELECT '--' -- this is a comment\nFROM t");
        assert.ok(result.includes("'--'"), 'string literal preserved');
        assert.ok(!result.includes('this is a comment'), 'comment stripped');
    });
});

// ---------------------------------------------------------------------------
// buildLineOffsets and offsetToLine: now exported from utils
// ---------------------------------------------------------------------------

suite('buildLineOffsets', () => {
    test('single line has offset [0]', () => {
        const offsets = buildLineOffsets('SELECT 1;');
        assert.deepStrictEqual(offsets, [0]);
    });

    test('two lines have correct offsets', () => {
        const offsets = buildLineOffsets('SELECT 1;\nSELECT 2;');
        assert.deepStrictEqual(offsets, [0, 10]);
    });

    test('empty string has offset [0]', () => {
        const offsets = buildLineOffsets('');
        assert.deepStrictEqual(offsets, [0]);
    });

    test('three lines', () => {
        const offsets = buildLineOffsets('ab\ncd\nef');
        assert.deepStrictEqual(offsets, [0, 3, 6]);
    });
});

suite('offsetToLine', () => {
    const offsets = [0, 10, 20, 30];

    test('offset 0 is line 0', () => {
        assert.strictEqual(offsetToLine(offsets, 0), 0);
    });

    test('offset 9 is still line 0', () => {
        assert.strictEqual(offsetToLine(offsets, 9), 0);
    });

    test('offset 10 is line 1', () => {
        assert.strictEqual(offsetToLine(offsets, 10), 1);
    });

    test('offset 29 is line 2', () => {
        assert.strictEqual(offsetToLine(offsets, 29), 2);
    });

    test('offset 30 is line 3', () => {
        assert.strictEqual(offsetToLine(offsets, 30), 3);
    });
});
