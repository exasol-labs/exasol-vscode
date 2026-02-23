import * as assert from 'assert';
import { splitIntoStatements } from '../../utils';

suite('splitIntoStatements', () => {
    test('should split simple multiple statements', () => {
        const text = `SELECT * FROM table1;
SELECT * FROM table2;
SELECT * FROM table3;`;

        const statements = splitIntoStatements(text);
        assert.strictEqual(statements.length, 3);
        assert.ok(statements[0].includes('table1'));
        assert.ok(statements[1].includes('table2'));
        assert.ok(statements[2].includes('table3'));
    });

    test('should handle multi-line statements', () => {
        const text = `SELECT
    column1,
    column2
FROM table1
WHERE condition = 1;

SELECT * FROM table2;`;

        const statements = splitIntoStatements(text);
        assert.strictEqual(statements.length, 2);
        assert.ok(statements[0].includes('column1'));
        assert.ok(statements[0].includes('column2'));
        assert.ok(statements[0].includes('FROM table1'));
        assert.ok(statements[1].includes('table2'));
    });

    test('should skip pure comment lines', () => {
        const text = `-- This is a comment
SELECT * FROM table1;

-- Another comment

SELECT * FROM table2;`;

        const statements = splitIntoStatements(text);
        assert.strictEqual(statements.length, 2);
        assert.ok(statements[0].includes('table1'));
        assert.ok(statements[1].includes('table2'));
    });

    test('should handle statement without trailing semicolon', () => {
        const text = `SELECT * FROM table1;
SELECT * FROM table2`;

        const statements = splitIntoStatements(text);
        assert.strictEqual(statements.length, 2);
        assert.ok(statements[0].includes('table1'));
        assert.ok(statements[1].includes('table2'));
    });

    test('should handle empty lines between statements', () => {
        const text = `SELECT * FROM table1;


SELECT * FROM table2;`;

        const statements = splitIntoStatements(text);
        assert.strictEqual(statements.length, 2);
    });

    test('should not terminate statement on semicolon in inline comment', () => {
        const text = `SELECT * FROM table1 WHERE id = 1 -- This is a test;
AND name = 'test';

SELECT * FROM table2;`;

        const statements = splitIntoStatements(text);
        assert.strictEqual(statements.length, 2);
        
        // First statement should include both lines
        assert.ok(statements[0].includes('WHERE id = 1'));
        assert.ok(statements[0].includes('AND name'));
        assert.ok(statements[0].includes('-- This is a test;'));
        
        // Second statement should be separate
        assert.ok(statements[1].includes('table2'));
    });

    test('should not terminate statement on semicolon with trailing spaces in comment', () => {
        const text = `SELECT * FROM table1 WHERE id = 1 -- Comment;   
AND name = 'test';

SELECT * FROM table2;`;

        const statements = splitIntoStatements(text);
        assert.strictEqual(statements.length, 2);
        
        // First statement should include both lines
        assert.ok(statements[0].includes('WHERE id = 1'));
        assert.ok(statements[0].includes('AND name'));
    });

    test('should handle multiple inline comments with semicolons', () => {
        const text = `SELECT -- comment1;
    column1, -- comment2;
    column2
FROM table1; -- final comment;

SELECT * FROM table2;`;

        const statements = splitIntoStatements(text);
        assert.strictEqual(statements.length, 2);
        
        // First statement should include all lines up to real semicolon
        assert.ok(statements[0].includes('column1'));
        assert.ok(statements[0].includes('column2'));
        assert.ok(statements[0].includes('FROM table1;'));
        
        // Second statement should be separate
        assert.ok(statements[1].includes('table2'));
    });

    test('should properly detect statement end with real semicolon followed by comment', () => {
        const text = `SELECT * FROM table1; -- This is the end
SELECT * FROM table2;`;

        const statements = splitIntoStatements(text);
        assert.strictEqual(statements.length, 2);
        
        // First statement should include the comment
        assert.ok(statements[0].includes('table1'));
        assert.ok(statements[0].includes('-- This is the end'));
        
        // Second statement should be on its own
        assert.ok(statements[1].includes('table2'));
    });

    test('should handle complex real-world scenario', () => {
        const text = `-- Create table
CREATE TABLE test_table (
    id INT, -- primary key;
    name VARCHAR(100), -- user name;
    status VARCHAR(20) -- active/inactive;
); -- end of CREATE TABLE;

-- Insert data
INSERT INTO test_table VALUES (1, 'John', 'active'); -- first record;

-- Query data
SELECT * FROM test_table WHERE status = 'active'; -- get active users;`;

        const statements = splitIntoStatements(text);
        assert.strictEqual(statements.length, 3);
        
        // CREATE TABLE statement
        assert.ok(statements[0].includes('CREATE TABLE'));
        assert.ok(statements[0].includes('primary key;'));
        assert.ok(statements[0].includes('user name;'));
        
        // INSERT statement
        assert.ok(statements[1].includes('INSERT INTO'));
        assert.ok(statements[1].includes('first record;'));
        
        // SELECT statement
        assert.ok(statements[2].includes('SELECT * FROM'));
        assert.ok(statements[2].includes('get active users;'));
    });

    test('should handle empty text', () => {
        const statements = splitIntoStatements('');
        assert.strictEqual(statements.length, 0);
    });

    test('should handle only comments', () => {
        const text = `-- Comment 1
-- Comment 2
-- Comment 3`;

        const statements = splitIntoStatements(text);
        assert.strictEqual(statements.length, 0);
    });

    test('should handle only whitespace', () => {
        const text = `   
        
    `;

        const statements = splitIntoStatements(text);
        assert.strictEqual(statements.length, 0);
    });

    test('should handle statement with only semicolon', () => {
        const text = `;`;

        const statements = splitIntoStatements(text);
        assert.strictEqual(statements.length, 0);
    });

    test('should preserve inline comments in statements', () => {
        const text = `SELECT 
    id, -- user ID
    name -- user name
FROM users;`;

        const statements = splitIntoStatements(text);
        assert.strictEqual(statements.length, 1);
        assert.ok(statements[0].includes('-- user ID'));
        assert.ok(statements[0].includes('-- user name'));
    });

    test('should handle consecutive semicolons in comments', () => {
        const text = `SELECT * FROM table1 WHERE id = 1 -- test;;; more;;;
AND name = 'test';

SELECT * FROM table2;`;

        const statements = splitIntoStatements(text);
        assert.strictEqual(statements.length, 2);
        
        // First statement should include the line with multiple semicolons in comment
        assert.ok(statements[0].includes('test;;; more;;;'));
        assert.ok(statements[0].includes('AND name'));
    });

    test('should not terminate statement on semicolon in multi-line comment', () => {
        const text = `SELECT * FROM table1 /* comment
with semicolon; inside */ WHERE id = 1;

SELECT * FROM table2;`;

        const statements = splitIntoStatements(text);
        assert.strictEqual(statements.length, 2);
        
        // First statement should include the multi-line comment and WHERE clause
        assert.ok(statements[0].includes('/* comment'));
        assert.ok(statements[0].includes('WHERE id = 1;'));
    });

    test('should handle inline multi-line comment with semicolon', () => {
        const text = `SELECT * FROM table1 /* comment; */ WHERE id = 1;

SELECT * FROM table2;`;

        const statements = splitIntoStatements(text);
        assert.strictEqual(statements.length, 2);
        
        // First statement should include the inline comment
        assert.ok(statements[0].includes('/* comment; */'));
        assert.ok(statements[0].includes('WHERE id = 1;'));
    });

    test('should handle multiple multi-line comments with semicolons', () => {
        const text = `SELECT /* comment1; */
    column1, /* comment2; with more; */
    column2
FROM table1;

SELECT * FROM table2;`;

        const statements = splitIntoStatements(text);
        assert.strictEqual(statements.length, 2);
        
        // First statement should include all comments
        assert.ok(statements[0].includes('/* comment1; */'));
        assert.ok(statements[0].includes('/* comment2; with more; */'));
        assert.ok(statements[0].includes('FROM table1;'));
    });

    test('should handle mixed single-line and multi-line comments', () => {
        const text = `SELECT * FROM table1 /* block comment; */ WHERE id = 1 -- line comment;
AND name = 'test';

SELECT * FROM table2;`;

        const statements = splitIntoStatements(text);
        assert.strictEqual(statements.length, 2);
        
        // First statement should include both comments and AND clause
        assert.ok(statements[0].includes('/* block comment; */'));
        assert.ok(statements[0].includes('-- line comment;'));
        assert.ok(statements[0].includes('AND name'));
    });
});
