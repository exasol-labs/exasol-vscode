import * as assert from 'assert';
import { extractColumnName } from '../../utils';

suite('extractColumnName', () => {

    test('returns col.name when present', () => {
        assert.strictEqual(extractColumnName({ name: 'USER_ID' }), 'USER_ID');
    });

    test('falls back to col.COLUMN_NAME when name is absent', () => {
        assert.strictEqual(extractColumnName({ COLUMN_NAME: 'SCHEMA_NAME' }), 'SCHEMA_NAME');
    });

    test('falls back to col itself when both name and COLUMN_NAME are missing', () => {
        assert.strictEqual(extractColumnName('RAW_STRING'), 'RAW_STRING');
    });

    test('prefers col.name over col.COLUMN_NAME when both exist', () => {
        assert.strictEqual(extractColumnName({ name: 'driver_name', COLUMN_NAME: 'system_name' }), 'driver_name');
    });

    test('falls back to COLUMN_NAME when name is undefined', () => {
        assert.strictEqual(extractColumnName({ name: undefined, COLUMN_NAME: 'FALLBACK' }), 'FALLBACK');
    });

    test('falls back to COLUMN_NAME when name is null', () => {
        assert.strictEqual(extractColumnName({ name: null, COLUMN_NAME: 'FALLBACK_NULL' }), 'FALLBACK_NULL');
    });

    test('handles empty string for COLUMN_NAME fallback', () => {
        // name is undefined -> falls back to COLUMN_NAME which is '' -> returns ''
        assert.strictEqual(extractColumnName({ COLUMN_NAME: '' }), '');
    });
});
