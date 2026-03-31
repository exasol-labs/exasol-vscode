import * as assert from 'assert';
import { escapeHtml } from '../../notebooks/notebookUtils';

suite('escapeHtml', () => {

    test('escapes ampersand', () => {
        assert.strictEqual(escapeHtml('a&b'), 'a&amp;b');
    });

    test('escapes less-than', () => {
        assert.strictEqual(escapeHtml('<script>'), '&lt;script&gt;');
    });

    test('escapes greater-than', () => {
        assert.strictEqual(escapeHtml('a>b'), 'a&gt;b');
    });

    test('escapes double quotes', () => {
        assert.strictEqual(escapeHtml('a"b'), 'a&quot;b');
    });

    test('escapes single quotes', () => {
        assert.strictEqual(escapeHtml("a'b"), 'a&#39;b');
    });

    test('escapes all characters in one string', () => {
        assert.strictEqual(
            escapeHtml(`<div class="x" data='y'>&`),
            '&lt;div class=&quot;x&quot; data=&#39;y&#39;&gt;&amp;'
        );
    });

    test('does not double-encode ampersands', () => {
        assert.strictEqual(escapeHtml('&amp;'), '&amp;amp;');
    });

    test('passes through safe strings unchanged', () => {
        assert.strictEqual(escapeHtml('hello world 123'), 'hello world 123');
    });

    test('handles empty string', () => {
        assert.strictEqual(escapeHtml(''), '');
    });
});
