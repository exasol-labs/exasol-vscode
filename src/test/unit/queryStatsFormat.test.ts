import * as assert from 'assert';
import {
    getQueryPreview,
    formatTime,
    formatTimestamp,
    calculateThroughput,
    calculateAvgRowTime,
} from '../../webview/queryStatsFormat';

suite('getQueryPreview', () => {
    test('collapses whitespace and trims', () => {
        assert.strictEqual(getQueryPreview('  SELECT   *\n FROM t  '), 'SELECT * FROM t');
    });

    test('truncates to 300 chars with ellipsis', () => {
        const long = 'a'.repeat(400);
        const preview = getQueryPreview(long);
        assert.strictEqual(preview.length, 303);
        assert.ok(preview.endsWith('...'));
        assert.strictEqual(preview, 'a'.repeat(300) + '...');
    });

    test('keeps a mid-length query untruncated', () => {
        const exact = 'a'.repeat(300);
        assert.strictEqual(getQueryPreview(exact), exact);
    });
});

suite('formatTime', () => {
    test('renders sub-second as milliseconds', () => {
        assert.strictEqual(formatTime(0), '0ms');
        assert.strictEqual(formatTime(999), '999ms');
    });

    test('renders seconds with two decimals below a minute', () => {
        assert.strictEqual(formatTime(1000), '1.00s');
        assert.strictEqual(formatTime(1500), '1.50s');
    });

    test('renders minutes and seconds at or above a minute', () => {
        assert.strictEqual(formatTime(60000), '1m 0s');
        assert.strictEqual(formatTime(90000), '1m 30s');
    });
});

suite('formatTimestamp', () => {
    test('renders the local wall-clock time as HH:mm:ss in 24-hour form', () => {
        const local = new Date(2024, 0, 5, 13, 7, 9);
        assert.strictEqual(formatTimestamp(local.toISOString()), '13:07:09');
    });

    test('renders single-digit hours zero-padded', () => {
        const local = new Date(2024, 0, 5, 9, 3, 4);
        assert.strictEqual(formatTimestamp(local.toISOString()), '09:03:04');
    });

    test('falls back to empty string for an unparseable input', () => {
        assert.strictEqual(formatTimestamp('not a date'), '');
    });
});

suite('calculateThroughput', () => {
    test('returns N/A when execution time is zero', () => {
        assert.strictEqual(calculateThroughput(0, 1000), 'N/A');
    });

    test('returns N/A when row count is zero', () => {
        assert.strictEqual(calculateThroughput(500, 0), 'N/A');
    });

    test('renders sub-one rate', () => {
        assert.strictEqual(calculateThroughput(2000, 1), '< 1 row/s');
    });

    test('renders whole rows per second', () => {
        assert.strictEqual(calculateThroughput(1000, 500), '500 row/s');
    });

    test('renders thousands of rows per second with one decimal', () => {
        assert.strictEqual(calculateThroughput(1000, 5000), '5.0K row/s');
    });
});

suite('calculateAvgRowTime', () => {
    test('returns N/A when row count is zero', () => {
        assert.strictEqual(calculateAvgRowTime(500, 0), 'N/A');
    });

    test('renders sub-hundredth as a threshold', () => {
        assert.strictEqual(calculateAvgRowTime(1, 1000), '< 0.01ms');
    });

    test('renders sub-millisecond with two decimals', () => {
        assert.strictEqual(calculateAvgRowTime(5, 10), '0.50ms');
    });

    test('renders one decimal at or above a millisecond', () => {
        assert.strictEqual(calculateAvgRowTime(100, 10), '10.0ms');
    });
});
