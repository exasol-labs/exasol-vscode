import * as assert from 'assert';
import { generateNonce } from '../../utils';

suite('generateNonce', () => {

    test('two consecutive calls produce different strings', () => {
        const a = generateNonce();
        const b = generateNonce();
        assert.notStrictEqual(a, b, 'consecutive nonces must differ');
    });

    test('length is consistent with base64 encoding of 16 bytes (22-24 chars)', () => {
        const nonce = generateNonce();
        // base64(16 bytes) = ceil(16/3)*4 = 24 characters (with possible = padding)
        assert.ok(
            nonce.length >= 22 && nonce.length <= 24,
            `expected nonce length 22-24 for 16-byte base64, got ${nonce.length}`
        );
    });

    test('contains only valid base64 characters', () => {
        const nonce = generateNonce();
        assert.ok(
            /^[A-Za-z0-9+/=]+$/.test(nonce),
            `nonce contains non-base64 chars: ${nonce}`
        );
    });

    test('five calls produce five distinct values', () => {
        const nonces = new Set([
            generateNonce(), generateNonce(), generateNonce(), generateNonce(), generateNonce()
        ]);
        assert.strictEqual(nonces.size, 5, 'all five nonces should be unique');
    });
});
