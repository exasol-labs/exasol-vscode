import * as assert from 'assert';
import { extractColumnMetadata } from '../../utils';

suite('extractColumnMetadata', () => {

    test('maps a column with full dataType object', () => {
        const input = [{ name: 'AGE', dataType: { type: 'DECIMAL', precision: 10, scale: 2 } }];
        const result = extractColumnMetadata(input);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, 'AGE');
        assert.strictEqual(result[0].type, 'DECIMAL');
        assert.strictEqual(result[0].precision, 10);
        assert.strictEqual(result[0].scale, 2);
    });

    test('maps a column with dataType including size', () => {
        const input = [{ name: 'LABEL', dataType: { type: 'VARCHAR', size: 255 } }];
        const result = extractColumnMetadata(input);
        assert.strictEqual(result[0].type, 'VARCHAR');
        assert.strictEqual(result[0].size, 255);
    });

    test('maps multiple columns in order', () => {
        const input = [
            { name: 'ID', dataType: { type: 'INTEGER' } },
            { name: 'NAME', dataType: { type: 'VARCHAR', size: 100 } },
            { name: 'STATUS', dataType: { type: 'VARCHAR' } }
        ];
        const result = extractColumnMetadata(input);
        assert.strictEqual(result.length, 3);
        assert.strictEqual(result[0].name, 'ID');
        assert.strictEqual(result[0].type, 'INTEGER');
        assert.strictEqual(result[1].name, 'NAME');
        assert.strictEqual(result[1].size, 100);
        assert.strictEqual(result[2].name, 'STATUS');
        assert.strictEqual(result[2].type, 'VARCHAR');
    });

    test('handles empty input array', () => {
        const result = extractColumnMetadata([]);
        assert.deepStrictEqual(result, []);
    });
});
