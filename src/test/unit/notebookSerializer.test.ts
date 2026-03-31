import * as assert from 'assert';
import { parseExabookCells } from '../../notebooks/notebookUtils';

suite('parseExabookCells', () => {

    test('parses valid cells', () => {
        const input = JSON.stringify([
            { kind: 1, language: 'markdown', value: '# Title' },
            { kind: 2, language: 'exasol-sql', value: 'SELECT 1' },
        ]);
        const { cells, warnings } = parseExabookCells(input);
        assert.strictEqual(warnings.length, 0);
        assert.strictEqual(cells.length, 2);
        assert.deepStrictEqual(cells[0], { kind: 1, value: '# Title', language: 'markdown' });
        assert.deepStrictEqual(cells[1], { kind: 2, value: 'SELECT 1', language: 'exasol-sql' });
    });

    test('empty string yields empty notebook', () => {
        const { cells, warnings } = parseExabookCells('');
        assert.strictEqual(cells.length, 0);
        assert.strictEqual(warnings.length, 0);
    });

    test('whitespace-only string yields empty notebook', () => {
        const { cells, warnings } = parseExabookCells('   \n  ');
        assert.strictEqual(cells.length, 0);
        assert.strictEqual(warnings.length, 0);
    });

    test('malformed JSON returns warning and empty cells', () => {
        const { cells, warnings } = parseExabookCells('not json{{{');
        assert.strictEqual(cells.length, 0);
        assert.strictEqual(warnings.length, 1);
        assert.ok(warnings[0].includes('Failed to parse'));
    });

    test('non-array JSON returns warning and empty cells', () => {
        const { cells, warnings } = parseExabookCells('{"kind": 2, "value": "SELECT 1"}');
        assert.strictEqual(cells.length, 0);
        assert.strictEqual(warnings.length, 1);
        assert.ok(warnings[0].includes('expected an array'));
    });

    test('null elements in array are filtered out', () => {
        const input = JSON.stringify([
            null,
            { kind: 2, language: 'sql', value: 'SELECT 1' },
            undefined,
        ]);
        const { cells, warnings } = parseExabookCells(input);
        assert.strictEqual(warnings.length, 0);
        assert.strictEqual(cells.length, 1);
        assert.strictEqual(cells[0].value, 'SELECT 1');
    });

    test('cells with missing value are filtered out', () => {
        const input = JSON.stringify([
            { kind: 2, language: 'sql' },
            { kind: 2, language: 'sql', value: 'SELECT 1' },
        ]);
        const { cells, warnings } = parseExabookCells(input);
        assert.strictEqual(cells.length, 1);
        assert.strictEqual(cells[0].value, 'SELECT 1');
    });

    test('cells with non-string value are filtered out', () => {
        const input = JSON.stringify([
            { kind: 2, language: 'sql', value: 42 },
            { kind: 2, language: 'sql', value: 'SELECT 1' },
        ]);
        const { cells, warnings } = parseExabookCells(input);
        assert.strictEqual(cells.length, 1);
    });

    test('primitive elements in array are filtered out', () => {
        const input = JSON.stringify([42, 'hello', true, { kind: 2, value: 'SELECT 1' }]);
        const { cells, warnings } = parseExabookCells(input);
        assert.strictEqual(cells.length, 1);
    });

    test('missing language defaults to exasol-sql', () => {
        const input = JSON.stringify([{ kind: 2, value: 'SELECT 1' }]);
        const { cells } = parseExabookCells(input);
        assert.strictEqual(cells[0].language, 'exasol-sql');
    });

    test('non-string language defaults to exasol-sql', () => {
        const input = JSON.stringify([{ kind: 2, value: 'SELECT 1', language: 99 }]);
        const { cells } = parseExabookCells(input);
        assert.strictEqual(cells[0].language, 'exasol-sql');
    });

    test('kind 1 maps to markup, anything else maps to code', () => {
        const input = JSON.stringify([
            { kind: 1, value: 'text' },
            { kind: 2, value: 'code' },
            { kind: 0, value: 'also code' },
            { kind: 99, value: 'still code' },
        ]);
        const { cells } = parseExabookCells(input);
        assert.strictEqual(cells[0].kind, 1);
        assert.strictEqual(cells[1].kind, 2);
        assert.strictEqual(cells[2].kind, 2);
        assert.strictEqual(cells[3].kind, 2);
    });

    test('empty value string is preserved', () => {
        const input = JSON.stringify([{ kind: 2, value: '' }]);
        const { cells } = parseExabookCells(input);
        assert.strictEqual(cells.length, 1);
        assert.strictEqual(cells[0].value, '');
    });
});
