import * as assert from 'assert';
import { escapeJsonForDataIsland } from '../../utils';

suite('escapeJsonForDataIsland', () => {

    test('converts < to \\u003c', () => {
        assert.strictEqual(escapeJsonForDataIsland('<'), '\\u003c');
    });

    test('converts > to \\u003e', () => {
        assert.strictEqual(escapeJsonForDataIsland('>'), '\\u003e');
    });

    test('converts & to \\u0026', () => {
        assert.strictEqual(escapeJsonForDataIsland('&'), '\\u0026');
    });

    test('converts all three characters in a single string', () => {
        const result = escapeJsonForDataIsland('<b>a&b</b>');
        assert.strictEqual(result, '\\u003cb\\u003ea\\u0026b\\u003c/b\\u003e');
    });

    test('passes through safe characters unchanged', () => {
        assert.strictEqual(escapeJsonForDataIsland('hello world 123'), 'hello world 123');
    });

    test('handles empty string', () => {
        assert.strictEqual(escapeJsonForDataIsland(''), '');
    });

    test('round-trip: JSON.parse recovers the original value', () => {
        const original = { key: 'value with <angle> & "quotes"' };
        const jsonStr = JSON.stringify(original);
        const escaped = escapeJsonForDataIsland(jsonStr);
        const parsed = JSON.parse(escaped);
        assert.deepStrictEqual(parsed, original);
    });

    test('XSS attack: </script> closing tag produces no literal </script> in escaped output', () => {
        const attack = '</script><script>alert(1)</script>';
        const escaped = escapeJsonForDataIsland(attack);
        assert.ok(
            !escaped.includes('</script>'),
            `escaped output must not contain literal </script>: ${escaped}`
        );
    });

    test('attack string embedded in data island cannot break out of JSON context', () => {
        const attack = { payload: '</script><script>alert(1)</script>' };
        const escaped = escapeJsonForDataIsland(JSON.stringify(attack));
        assert.ok(
            !escaped.includes('</script>'),
            `escaped JSON must not contain literal </script>: ${escaped}`
        );
        // Parsing back must recover original value
        const parsed = JSON.parse(escaped);
        assert.deepStrictEqual(parsed, attack);
    });

    test('replaces multiple occurrences of each character', () => {
        const input = '<<>>&&&';
        const result = escapeJsonForDataIsland(input);
        assert.strictEqual(result, '\\u003c\\u003c\\u003e\\u003e\\u0026\\u0026\\u0026');
    });
});
