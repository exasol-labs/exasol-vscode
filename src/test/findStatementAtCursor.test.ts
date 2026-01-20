import * as assert from 'assert';
import { findStatementAtCursor } from '../utils';

suite('findStatementAtCursor', () => {
    test('should find first statement in multi-statement file', () => {
        const documentText = `SELECT * FROM table1;

SELECT * FROM table2;

SELECT * FROM table3;`;

        const result = findStatementAtCursor(documentText, 0);
        assert.ok(result);
        assert.strictEqual(result.text, 'SELECT * FROM table1;');
        assert.strictEqual(result.range.start, 0);
        assert.strictEqual(result.range.end, 0);
    });

    test('should find second statement in multi-statement file', () => {
        const documentText = `SELECT * FROM table1;

SELECT * FROM table2;

SELECT * FROM table3;`;

        const result = findStatementAtCursor(documentText, 2);
        assert.ok(result);
        assert.strictEqual(result.text, 'SELECT * FROM table2;');
        assert.strictEqual(result.range.start, 2);
        assert.strictEqual(result.range.end, 2);
    });

    test('should find third statement in multi-statement file', () => {
        const documentText = `SELECT * FROM table1;

SELECT * FROM table2;

SELECT * FROM table3;`;

        const result = findStatementAtCursor(documentText, 4);
        assert.ok(result);
        assert.strictEqual(result.text, 'SELECT * FROM table3;');
        assert.strictEqual(result.range.start, 4);
        assert.strictEqual(result.range.end, 4);
    });

    test('should find multi-line statement', () => {
        const documentText = `SELECT
    column1,
    column2
FROM table1
WHERE condition = 1;

SELECT * FROM table2;`;

        const result = findStatementAtCursor(documentText, 2);
        assert.ok(result);
        assert.strictEqual(result.text.trim(), 'SELECT\n    column1,\n    column2\nFROM table1\nWHERE condition = 1;');
        assert.strictEqual(result.range.start, 0);
        assert.strictEqual(result.range.end, 4);
    });

    test('should find statement when cursor is on any line of multi-line statement', () => {
        const documentText = `SELECT
    column1,
    column2
FROM table1
WHERE condition = 1;`;

        // Test cursor on each line
        for (let line = 0; line <= 4; line++) {
            const result = findStatementAtCursor(documentText, line);
            assert.ok(result, `Should find statement at line ${line}`);
            assert.strictEqual(result.range.start, 0);
            assert.strictEqual(result.range.end, 4);
        }
    });

    test('should skip comments and empty lines', () => {
        const documentText = `-- This is a comment
SELECT * FROM table1;

-- Another comment

SELECT * FROM table2;`;

        const result = findStatementAtCursor(documentText, 1);
        assert.ok(result);
        assert.strictEqual(result.text, 'SELECT * FROM table1;');
    });

    test('should handle statement without trailing semicolon', () => {
        const documentText = `SELECT * FROM table1`;

        const result = findStatementAtCursor(documentText, 0);
        assert.ok(result);
        assert.strictEqual(result.text, 'SELECT * FROM table1');
        assert.strictEqual(result.range.start, 0);
        assert.strictEqual(result.range.end, 0);
    });

    test('should return undefined when cursor is on comment line', () => {
        const documentText = `-- This is a comment
SELECT * FROM table1;`;

        const result = findStatementAtCursor(documentText, 0);
        assert.strictEqual(result, undefined);
    });

    test('should return undefined when cursor is on empty line between statements', () => {
        const documentText = `SELECT * FROM table1;

SELECT * FROM table2;`;

        const result = findStatementAtCursor(documentText, 1);
        assert.strictEqual(result, undefined);
    });

    test('should handle complex multi-statement file with mixed content', () => {
        const documentText = `-- Header comment
SELECT col1, col2
FROM table1
WHERE id > 10;

-- Second query comment
INSERT INTO table2
VALUES (1, 2, 3);

-- Final query
UPDATE table3
SET status = 'active'
WHERE user_id = 5`;

        // First statement (lines 1-3)
        let result = findStatementAtCursor(documentText, 2);
        assert.ok(result);
        assert.ok(result.text.includes('SELECT col1, col2'));

        // Second statement (lines 6-7)
        result = findStatementAtCursor(documentText, 7);
        assert.ok(result);
        assert.ok(result.text.includes('INSERT INTO table2'));

        // Third statement (lines 10-12)
        result = findStatementAtCursor(documentText, 11);
        assert.ok(result);
        assert.ok(result.text.includes('UPDATE table3'));
    });

    test('should not terminate statement on semicolon in inline comment', () => {
        const documentText = `SELECT * FROM table1 WHERE id = 1 -- This is a test;
AND name = 'test';

SELECT * FROM table2;`;

        // First statement should include both lines (not terminated by semicolon in comment)
        const result = findStatementAtCursor(documentText, 0);
        assert.ok(result);
        assert.ok(result.text.includes('WHERE id = 1'));
        assert.ok(result.text.includes('AND name'));
        assert.strictEqual(result.range.start, 0);
        assert.strictEqual(result.range.end, 1);
    });

    test('should not terminate statement on semicolon with trailing spaces in comment', () => {
        const documentText = `SELECT * FROM table1 WHERE id = 1 -- Comment;   
AND name = 'test';`;

        const result = findStatementAtCursor(documentText, 0);
        assert.ok(result);
        assert.ok(result.text.includes('WHERE id = 1'));
        assert.ok(result.text.includes('AND name'));
        assert.strictEqual(result.range.start, 0);
        assert.strictEqual(result.range.end, 1);
    });

    test('should handle multiple inline comments with semicolons', () => {
        const documentText = `SELECT -- comment1;
    column1, -- comment2;
    column2
FROM table1; -- final comment;

SELECT * FROM table2;`;

        // First statement (lines 0-3)
        const result1 = findStatementAtCursor(documentText, 1);
        assert.ok(result1);
        assert.ok(result1.text.includes('column1'));
        assert.ok(result1.text.includes('FROM table1;'));
        assert.strictEqual(result1.range.start, 0);
        assert.strictEqual(result1.range.end, 3);

        // Second statement
        const result2 = findStatementAtCursor(documentText, 5);
        assert.ok(result2);
        assert.ok(result2.text.includes('table2'));
    });

    test('should properly detect statement end with real semicolon followed by comment', () => {
        const documentText = `SELECT * FROM table1; -- This is the end
SELECT * FROM table2;`;

        // First statement should end at line 0
        const result1 = findStatementAtCursor(documentText, 0);
        assert.ok(result1);
        assert.ok(result1.text.includes('table1'));
        assert.ok(result1.text.includes('-- This is the end'));
        assert.strictEqual(result1.range.start, 0);
        assert.strictEqual(result1.range.end, 0);

        // Second statement should be separate
        const result2 = findStatementAtCursor(documentText, 1);
        assert.ok(result2);
        assert.ok(result2.text.includes('table2'));
        assert.strictEqual(result2.range.start, 1);
    });

    test('should not terminate statement on semicolon in multi-line comment', () => {
        const documentText = `SELECT * FROM table1 /* comment
with semicolon; inside */ WHERE id = 1;

SELECT * FROM table2;`;

        // First statement should include the multi-line comment and WHERE clause
        const result1 = findStatementAtCursor(documentText, 0);
        assert.ok(result1);
        assert.ok(result1.text.includes('/* comment'));
        assert.ok(result1.text.includes('WHERE id = 1;'));
        assert.strictEqual(result1.range.start, 0);
        assert.strictEqual(result1.range.end, 1);
    });

    test('should handle inline multi-line comment with semicolon', () => {
        const documentText = `SELECT * FROM table1 /* comment; */ WHERE id = 1;

SELECT * FROM table2;`;

        const result1 = findStatementAtCursor(documentText, 0);
        assert.ok(result1);
        assert.ok(result1.text.includes('/* comment; */'));
        assert.ok(result1.text.includes('WHERE id = 1;'));
    });

    test('should handle mixed single-line and multi-line comments', () => {
        const documentText = `SELECT * FROM table1 /* block comment; */ WHERE id = 1 -- line comment;
AND name = 'test';`;

        const result = findStatementAtCursor(documentText, 0);
        assert.ok(result);
        assert.ok(result.text.includes('/* block comment; */'));
        assert.ok(result.text.includes('-- line comment;'));
        assert.ok(result.text.includes('AND name'));
        assert.strictEqual(result.range.start, 0);
        assert.strictEqual(result.range.end, 1);
    });
});
