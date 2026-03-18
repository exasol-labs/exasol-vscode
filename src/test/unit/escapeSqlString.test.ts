import * as assert from 'assert';
import { escapeSqlString } from '../../utils';

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
