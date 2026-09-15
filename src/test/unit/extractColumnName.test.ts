import * as assert from 'assert';
import { extractColumnName } from '../../utils';

suite('extractColumnName', () => {

    test('returns col.name', () => {
        assert.strictEqual(
            extractColumnName({ name: 'USER_ID', dataType: { type: 'DECIMAL' } }),
            'USER_ID'
        );
    });
});
