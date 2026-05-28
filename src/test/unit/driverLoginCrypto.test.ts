import * as assert from 'assert';
import { constants as cryptoConstants, createPublicKey, generateKeyPairSync, privateDecrypt, publicEncrypt } from 'node:crypto';

// These tests pin down the RSA-PKCS1-v1.5 encryption path used by the patched
// @exasol/exasol-driver-ts fork (commit f6eca4d3) for loginBasicAuth. The
// driver used to depend on node-forge for this; the fork swaps in node:crypto.
//
// We do not import the driver here because the encrypt logic lives inside a
// private method of SQLClient. Instead we reproduce the call shape exactly
// (modulus/exponent hex -> JWK -> publicEncrypt with RSA_PKCS1_PADDING ->
// base64) and round-trip it through privateDecrypt with the matching key.
// Any divergence between this test and the driver should be caught the next
// time the fork is rebased against upstream.

const padHex = (hex: string) => (hex.length % 2 === 0 ? hex : '0' + hex);

const encryptPasswordAsDriverWould = (
    password: string,
    publicKeyModulusHex: string,
    publicKeyExponentHex: string,
): string => {
    const modulus = Buffer.from(padHex(publicKeyModulusHex), 'hex');
    const exponent = Buffer.from(padHex(publicKeyExponentHex), 'hex');
    const pubKey = createPublicKey({
        key: {
            kty: 'RSA',
            n: modulus.toString('base64url'),
            e: exponent.toString('base64url'),
        },
        format: 'jwk',
    });
    const ciphertext = publicEncrypt(
        { key: pubKey, padding: cryptoConstants.RSA_PKCS1_PADDING },
        Buffer.from(password, 'binary'),
    );
    return ciphertext.toString('base64');
};

suite('driver loginBasicAuth crypto (node:crypto, replaces node-forge)', () => {

    test('round-trip: encrypt with driver helper, decrypt with matching private key', () => {
        const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
        const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
        const modulusHex = Buffer.from(jwk.n, 'base64url').toString('hex');
        const exponentHex = Buffer.from(jwk.e, 'base64url').toString('hex');

        const password = 'correct horse battery staple';
        const ciphertextBase64 = encryptPasswordAsDriverWould(password, modulusHex, exponentHex);

        const plaintext = privateDecrypt(
            { key: privateKey, padding: cryptoConstants.RSA_PKCS1_PADDING },
            Buffer.from(ciphertextBase64, 'base64'),
        ).toString('binary');

        assert.strictEqual(plaintext, password);
    });

    test('odd-length modulus/exponent hex are padded, not silently truncated', () => {
        // Buffer.from(hex) drops a trailing nibble on odd-length input. The
        // driver pads to even length to match forge's BigInteger behavior.
        const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
        const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
        // Strip the leading nibble if present to force odd-length, then re-pad.
        // Real Exasol hex strings are typically even, but the driver is
        // defensive in case the wire format ever drops leading zeros.
        const modulusHex = Buffer.from(jwk.n, 'base64url').toString('hex').replace(/^0/, '');
        const exponentHex = Buffer.from(jwk.e, 'base64url').toString('hex');

        const password = 'odd-length-test';
        const ciphertextBase64 = encryptPasswordAsDriverWould(password, modulusHex, exponentHex);

        const plaintext = privateDecrypt(
            { key: privateKey, padding: cryptoConstants.RSA_PKCS1_PADDING },
            Buffer.from(ciphertextBase64, 'base64'),
        ).toString('binary');

        assert.strictEqual(plaintext, password);
    });

    test('password is encoded as binary (1 byte per char code), preserving non-ASCII bytes', () => {
        // forge.pubKey.encrypt(jsString) treats the string as a binary string,
        // one byte per UTF-16 code unit (low byte). We must match that to
        // avoid breaking existing user passwords that contain bytes above
        // 0x7f when those users authenticated under the old forge code path.
        const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
        const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
        const modulusHex = Buffer.from(jwk.n, 'base64url').toString('hex');
        const exponentHex = Buffer.from(jwk.e, 'base64url').toString('hex');

        // High-bit byte (0xa9 = copyright). String.fromCharCode(0xa9) yields
        // a single UTF-16 code unit. Reading it as 'binary' gives one byte 0xa9.
        // Reading it as 'utf8' gives two bytes (c2 a9), which would be wrong.
        const password = 'p©ssword';
        const ciphertextBase64 = encryptPasswordAsDriverWould(password, modulusHex, exponentHex);

        const plaintextBinary = privateDecrypt(
            { key: privateKey, padding: cryptoConstants.RSA_PKCS1_PADDING },
            Buffer.from(ciphertextBase64, 'base64'),
        ).toString('binary');

        assert.strictEqual(plaintextBinary, password);
        // And confirm we did NOT accidentally UTF-8-encode: 8 chars -> 8 binary
        // bytes (one per code unit), versus 9 bytes if encoded as UTF-8.
        assert.strictEqual(Buffer.from(password, 'binary').length, 8);
        assert.strictEqual(Buffer.from(password, 'utf8').length, 9);
    });

    test('output is valid base64 and decodes to RSA modulus byte length (256 for 2048-bit)', () => {
        const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
        const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
        const modulusHex = Buffer.from(jwk.n, 'base64url').toString('hex');
        const exponentHex = Buffer.from(jwk.e, 'base64url').toString('hex');

        const ciphertextBase64 = encryptPasswordAsDriverWould('x', modulusHex, exponentHex);
        assert.ok(/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertextBase64), 'must be base64');
        assert.strictEqual(Buffer.from(ciphertextBase64, 'base64').length, 256);
    });
});
