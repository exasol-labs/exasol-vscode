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
});
