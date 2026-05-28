import * as assert from 'assert';
import { escapeSqlString, escapeSqlIdentifier } from '../../utils';

suite('escapeSqlIdentifier', () => {
    test('returns the same string when no double quotes present', () => {
        assert.strictEqual(escapeSqlIdentifier('MY_SCHEMA'), 'MY_SCHEMA');
    });

    test('doubles a double quote in the middle of the identifier', () => {
        assert.strictEqual(escapeSqlIdentifier('MY"SCHEMA'), 'MY""SCHEMA');
    });

    test('doubles multiple double quotes', () => {
        assert.strictEqual(escapeSqlIdentifier('"weird"name"'), '""weird""name""');
    });

    test('handles empty string', () => {
        assert.strictEqual(escapeSqlIdentifier(''), '');
    });

    test('produces correct DESCRIBE query when schema or table name contains double quote', () => {
        const schemaName = 'MY"SCHEMA';
        const tableName = 'MY"TABLE';
        const sql = `DESCRIBE "${escapeSqlIdentifier(schemaName)}"."${escapeSqlIdentifier(tableName)}"`;
        assert.strictEqual(sql, 'DESCRIBE "MY""SCHEMA"."MY""TABLE"');
    });

    test('DESCRIBE query with normal identifiers is unchanged', () => {
        const schemaName = 'MY_SCHEMA';
        const tableName = 'MY_TABLE';
        const sql = `DESCRIBE "${escapeSqlIdentifier(schemaName)}"."${escapeSqlIdentifier(tableName)}"`;
        assert.strictEqual(sql, 'DESCRIBE "MY_SCHEMA"."MY_TABLE"');
    });

    test('single quotes in identifier are left unchanged (not SQL string context)', () => {
        assert.strictEqual(escapeSqlIdentifier("O'Brien"), "O'Brien");
    });
});

suite('escapeSqlString', () => {
    test('returns the same string when no single quotes present', () => {
        assert.strictEqual(escapeSqlString('SCHEMA_NAME'), 'SCHEMA_NAME');
    });

    test('doubles a single quote in the middle of the string', () => {
        assert.strictEqual(escapeSqlString("O'Brien"), "O''Brien");
    });

    test('doubles multiple single quotes', () => {
        assert.strictEqual(escapeSqlString("it's a 'test'"), "it''s a ''test''");
    });

    test('handles empty string', () => {
        assert.strictEqual(escapeSqlString(''), '');
    });

    test('handles string that is just a single quote', () => {
        assert.strictEqual(escapeSqlString("'"), "''");
    });

    test('handles consecutive single quotes', () => {
        assert.strictEqual(escapeSqlString("''"), "''''");
    });
});
