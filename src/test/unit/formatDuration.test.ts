import * as assert from 'assert';
import { formatDuration } from '../../utils';

suite('formatDuration', () => {
    test('sub-millisecond returns <1ms', () => {
        assert.strictEqual(formatDuration(0), '<1ms');
        assert.strictEqual(formatDuration(0.4), '<1ms');
    });

    test('milliseconds range (1–999ms)', () => {
        assert.strictEqual(formatDuration(1), '1ms');
        assert.strictEqual(formatDuration(45), '45ms');
        assert.strictEqual(formatDuration(999), '999ms');
    });

    test('fractional milliseconds round to integer', () => {
        assert.strictEqual(formatDuration(45.7), '46ms');
        assert.strictEqual(formatDuration(1.4), '1ms');
    });

    test('seconds range (1s–59.9s)', () => {
        assert.strictEqual(formatDuration(1000), '1.0s');
        assert.strictEqual(formatDuration(1234), '1.2s');
        assert.strictEqual(formatDuration(59999), '60.0s');
    });

    test('minutes range (>=60s)', () => {
        assert.strictEqual(formatDuration(60000), '1m 0s');
        assert.strictEqual(formatDuration(75000), '1m 15s');
        assert.strictEqual(formatDuration(125000), '2m 5s');
    });
});
