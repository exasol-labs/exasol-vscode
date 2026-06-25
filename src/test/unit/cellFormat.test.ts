import * as assert from 'assert';
import {
    isDateType,
    isTimestampType,
    isBooleanType,
    formatNumericDisplay,
    formatDateDisplay,
    parseBoolean,
    isUrlValue,
    estimateColumnWidth,
    MIN_ESTIMATED_COLUMN_WIDTH,
    MAX_ESTIMATED_COLUMN_WIDTH,
} from '../../webview/cellFormat';

suite('cellFormat type predicates', () => {
    test('isDateType matches DATE only', () => {
        assert.strictEqual(isDateType('DATE'), true);
        assert.strictEqual(isDateType('date'), true);
        assert.strictEqual(isDateType('TIMESTAMP'), false);
        assert.strictEqual(isDateType('VARCHAR'), false);
    });

    test('isTimestampType matches TIMESTAMP variants', () => {
        assert.strictEqual(isTimestampType('TIMESTAMP'), true);
        assert.strictEqual(isTimestampType('TIMESTAMP WITH LOCAL TIME ZONE'), true);
        assert.strictEqual(isTimestampType('DATE'), false);
    });

    test('isBooleanType matches BOOLEAN', () => {
        assert.strictEqual(isBooleanType('BOOLEAN'), true);
        assert.strictEqual(isBooleanType('bool'), true);
        assert.strictEqual(isBooleanType('VARCHAR'), false);
    });
});

suite('formatNumericDisplay', () => {
    test('groups integer thousands', () => {
        assert.strictEqual(formatNumericDisplay(1234567), '1,234,567');
        assert.strictEqual(formatNumericDisplay('1234567'), '1,234,567');
    });

    test('preserves full decimal precision without rounding', () => {
        assert.strictEqual(formatNumericDisplay('1234567.8901234567'), '1,234,567.8901234567');
        assert.strictEqual(formatNumericDisplay('0.123456789012345678'), '0.123456789012345678');
    });

    test('handles negative numbers', () => {
        assert.strictEqual(formatNumericDisplay('-1234.5'), '-1,234.5');
        assert.strictEqual(formatNumericDisplay(-1000), '-1,000');
    });

    test('handles values below one thousand', () => {
        assert.strictEqual(formatNumericDisplay(7), '7');
        assert.strictEqual(formatNumericDisplay('42.50'), '42.50');
    });

    test('falls back to raw string for non-numeric input', () => {
        assert.strictEqual(formatNumericDisplay('N/A'), 'N/A');
        assert.strictEqual(formatNumericDisplay('1.2.3'), '1.2.3');
    });

    test('falls back to raw for scientific notation', () => {
        assert.strictEqual(formatNumericDisplay('1e10'), '1e10');
    });
});

suite('formatDateDisplay', () => {
    test('normalizes date-only value', () => {
        assert.strictEqual(formatDateDisplay('2024-01-05', false), '2024-01-05');
    });

    test('normalizes timestamp value', () => {
        assert.strictEqual(formatDateDisplay('2024-01-05 13:07:09', true), '2024-01-05 13:07:09');
    });

    test('truncates timestamp to date when column is DATE', () => {
        assert.strictEqual(formatDateDisplay('2024-01-05 13:07:09', false), '2024-01-05');
    });

    test('drops fractional seconds from timestamp display', () => {
        assert.strictEqual(formatDateDisplay('2024-01-05 13:07:09.123', true), '2024-01-05 13:07:09');
    });

    test('normalizes ISO T separator', () => {
        assert.strictEqual(formatDateDisplay('2024-01-05T13:07:09', true), '2024-01-05 13:07:09');
    });

    test('falls back to raw when unparseable', () => {
        assert.strictEqual(formatDateDisplay('not a date', true), 'not a date');
        assert.strictEqual(formatDateDisplay('05/01/2024', false), '05/01/2024');
    });
});

suite('parseBoolean', () => {
    test('returns true for real boolean true', () => {
        assert.strictEqual(parseBoolean(true), true);
    });

    test('returns false for real boolean false', () => {
        assert.strictEqual(parseBoolean(false), false);
    });

    test('parses truthy string and numeric tokens case-insensitively', () => {
        for (const token of ['t', 'true', 'TRUE', 'True', '1', 'y', 'yes', 'YES']) {
            assert.strictEqual(parseBoolean(token), true, `expected ${token} to parse true`);
        }
        assert.strictEqual(parseBoolean(1), true);
    });

    test('treats any other value as false', () => {
        for (const token of ['f', 'false', '0', 'n', 'no', 'anything', '']) {
            assert.strictEqual(parseBoolean(token), false, `expected ${token} to parse false`);
        }
        assert.strictEqual(parseBoolean(0), false);
        assert.strictEqual(parseBoolean(2), false);
    });

    test('trims surrounding whitespace before matching', () => {
        assert.strictEqual(parseBoolean('  true  '), true);
        assert.strictEqual(parseBoolean('\tyes\n'), true);
    });

    test('returns undefined for null and undefined', () => {
        assert.strictEqual(parseBoolean(null), undefined);
        assert.strictEqual(parseBoolean(undefined), undefined);
    });
});

suite('isUrlValue', () => {
    test('detects http and https urls', () => {
        assert.strictEqual(isUrlValue('http://example.com'), true);
        assert.strictEqual(isUrlValue('https://example.com/path?q=1'), true);
    });

    test('trims surrounding whitespace before matching', () => {
        assert.strictEqual(isUrlValue('  https://example.com  '), true);
    });

    test('rejects non-http schemes and bare text', () => {
        assert.strictEqual(isUrlValue('ftp://example.com'), false);
        assert.strictEqual(isUrlValue('file:///etc/passwd'), false);
        assert.strictEqual(isUrlValue('vscode://extension'), false);
        assert.strictEqual(isUrlValue('javascript:alert(1)'), false);
        assert.strictEqual(isUrlValue('example.com'), false);
        assert.strictEqual(isUrlValue('not a url'), false);
    });

    test('rejects urls containing whitespace', () => {
        assert.strictEqual(isUrlValue('https://example.com path'), false);
    });

    test('rejects non-string values', () => {
        assert.strictEqual(isUrlValue(42), false);
        assert.strictEqual(isUrlValue(true), false);
        assert.strictEqual(isUrlValue(null), false);
        assert.strictEqual(isUrlValue(undefined), false);
    });
});

suite('estimateColumnWidth', () => {
    test('sizes to the longest of header and sample values', () => {
        const longest = '0123456789';
        const width = estimateColumnWidth('id', ['1', '22', longest]);
        assert.strictEqual(width, Math.ceil(longest.length * 8) + 24);
    });

    test('uses the header when it is the longest token', () => {
        const width = estimateColumnWidth('customer_name', ['a', 'bb']);
        assert.strictEqual(width, Math.ceil('customer_name'.length * 8) + 24);
    });

    test('clamps narrow content up to the minimum', () => {
        assert.strictEqual(estimateColumnWidth('x', ['y']), MIN_ESTIMATED_COLUMN_WIDTH);
    });

    test('clamps wide content down to the maximum', () => {
        assert.strictEqual(estimateColumnWidth('h', ['z'.repeat(1000)]), MAX_ESTIMATED_COLUMN_WIDTH);
    });

    test('handles a column with no sample values using the header alone', () => {
        const width = estimateColumnWidth('description', []);
        assert.strictEqual(width, Math.ceil('description'.length * 8) + 24);
    });

    test('exposes the clamp bounds as 64 and 400', () => {
        assert.strictEqual(MIN_ESTIMATED_COLUMN_WIDTH, 64);
        assert.strictEqual(MAX_ESTIMATED_COLUMN_WIDTH, 400);
    });
});
