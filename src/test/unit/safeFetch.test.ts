import * as assert from 'assert';
import { safeFetch } from '../../utils';

suite('safeFetch', () => {

    test('returns fn result when fn resolves', async () => {
        const result = await safeFetch('label', async () => 42, 0, undefined);
        assert.strictEqual(result, 42);
    });

    test('returns fallback when fn throws', async () => {
        const result = await safeFetch('label', async () => { throw new Error('boom'); }, 'default', undefined);
        assert.strictEqual(result, 'default');
    });

    test('logs to channel when fn throws', async () => {
        const lines: string[] = [];
        const channel = { appendLine: (line: string) => lines.push(line) } as any;

        await safeFetch('myLabel', async () => { throw new Error('bad'); }, null, channel);

        assert.strictEqual(lines.length, 1);
        assert.ok(lines[0].includes('myLabel'), `expected log to contain label, got: ${lines[0]}`);
        assert.ok(lines[0].includes('bad'), `expected log to contain error, got: ${lines[0]}`);
    });

    test('tolerates undefined channel when fn throws (no crash)', async () => {
        const result = await safeFetch('lbl', async () => { throw new Error('oops'); }, 99, undefined);
        assert.strictEqual(result, 99);
    });

    test('does not call appendLine when fn succeeds', async () => {
        const lines: string[] = [];
        const channel = { appendLine: (line: string) => lines.push(line) } as any;

        await safeFetch('lbl', async () => 'ok', '', channel);

        assert.strictEqual(lines.length, 0);
    });

    test('works with array fallback type', async () => {
        const result = await safeFetch('lbl', async () => { throw new Error('x'); }, [] as string[], undefined);
        assert.deepStrictEqual(result, []);
    });

    test('passes through resolved value even when channel is provided', async () => {
        const lines: string[] = [];
        const channel = { appendLine: (line: string) => lines.push(line) } as any;

        const result = await safeFetch('lbl', async () => 'hello', 'fallback', channel);

        assert.strictEqual(result, 'hello');
        assert.strictEqual(lines.length, 0);
    });
});
