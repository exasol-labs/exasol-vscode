import * as assert from 'assert';
import {
    normalizeFingerprint,
    formatError,
    FingerprintRequiredError,
    FingerprintMismatchError,
    extractFingerprintError
} from '../../connectionTypes';

suite('normalizeFingerprint', () => {
    test('strips colons', () => {
        assert.strictEqual(
            normalizeFingerprint('AB:CD:EF:01:23:45'),
            'ABCDEF012345'
        );
    });

    test('strips spaces', () => {
        assert.strictEqual(
            normalizeFingerprint('AB CD EF 01'),
            'ABCDEF01'
        );
    });

    test('uppercases lowercase hex', () => {
        assert.strictEqual(
            normalizeFingerprint('abcdef0123456789'),
            'ABCDEF0123456789'
        );
    });

    test('handles already-normalized input', () => {
        const fp = 'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789';
        assert.strictEqual(normalizeFingerprint(fp), fp);
    });

    test('handles mixed colons, spaces, and case', () => {
        assert.strictEqual(
            normalizeFingerprint('aB:cD eF:01'),
            'ABCDEF01'
        );
    });

    test('returns empty string for empty input', () => {
        assert.strictEqual(normalizeFingerprint(''), '');
    });
});

suite('formatError', () => {
    test('extracts message from Error instances', () => {
        assert.strictEqual(formatError(new Error('something broke')), 'something broke');
    });

    test('includes error code when both message and code are present', () => {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:9999');
        (err as any).code = 'ECONNREFUSED';
        assert.strictEqual(
            formatError(err),
            'connect ECONNREFUSED 127.0.0.1:9999 (ECONNREFUSED)'
        );
    });

    test('falls back to code when message is empty', () => {
        const err = new Error('');
        (err as any).code = 'ECONNREFUSED';
        assert.strictEqual(formatError(err), 'ECONNREFUSED');
    });

    test('uses toString for Error with no message and no code', () => {
        const err = new Error('');
        assert.strictEqual(formatError(err), 'Error');
    });

    test('returns strings as-is', () => {
        assert.strictEqual(formatError('plain string error'), 'plain string error');
    });

    test('extracts text field from driver exception objects', () => {
        assert.strictEqual(
            formatError({ text: 'Connection exception - authentication failed.', sqlCode: '08004' }),
            'Connection exception - authentication failed.'
        );
    });

    test('JSON-serializes objects without text field', () => {
        assert.strictEqual(
            formatError({ code: 42, detail: 'unknown' }),
            '{"code":42,"detail":"unknown"}'
        );
    });

    test('handles null', () => {
        assert.strictEqual(formatError(null), 'null');
    });

    test('handles undefined', () => {
        assert.strictEqual(formatError(undefined), 'undefined');
    });

    test('handles numbers', () => {
        assert.strictEqual(formatError(42), '42');
    });
});

suite('FingerprintRequiredError', () => {
    test('stores server fingerprint', () => {
        const fp = 'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789';
        const err = new FingerprintRequiredError(fp);
        assert.strictEqual(err.serverFingerprint, fp);
        assert.strictEqual(err.name, 'FingerprintRequiredError');
        assert.ok(err.message.includes(fp));
    });

    test('is instanceof Error', () => {
        const err = new FingerprintRequiredError('AABB');
        assert.ok(err instanceof Error);
        assert.ok(err instanceof FingerprintRequiredError);
    });
});

suite('FingerprintMismatchError', () => {
    test('stores both fingerprints', () => {
        const stored = 'AAAA0000AAAA0000AAAA0000AAAA0000AAAA0000AAAA0000AAAA0000AAAA0000';
        const server = 'BBBB1111BBBB1111BBBB1111BBBB1111BBBB1111BBBB1111BBBB1111BBBB1111';
        const err = new FingerprintMismatchError(stored, server);
        assert.strictEqual(err.storedFingerprint, stored);
        assert.strictEqual(err.serverFingerprint, server);
        assert.strictEqual(err.name, 'FingerprintMismatchError');
    });

    test('is instanceof Error', () => {
        const err = new FingerprintMismatchError('old', 'new');
        assert.ok(err instanceof Error);
        assert.ok(err instanceof FingerprintMismatchError);
    });
});

suite('extractFingerprintError', () => {
    const SAMPLE_FP = 'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789';
    const OTHER_FP = '1111111111111111111111111111111111111111111111111111111111111111';

    test('returns FingerprintRequiredError directly', () => {
        const original = new FingerprintRequiredError(SAMPLE_FP);
        const result = extractFingerprintError(original);
        assert.ok(result instanceof FingerprintRequiredError);
        assert.strictEqual((result as FingerprintRequiredError).serverFingerprint, SAMPLE_FP);
    });

    test('returns FingerprintMismatchError directly', () => {
        const original = new FingerprintMismatchError(SAMPLE_FP, OTHER_FP);
        const result = extractFingerprintError(original);
        assert.ok(result instanceof FingerprintMismatchError);
        assert.strictEqual((result as FingerprintMismatchError).storedFingerprint, SAMPLE_FP);
        assert.strictEqual((result as FingerprintMismatchError).serverFingerprint, OTHER_FP);
    });

    test('extracts TOFU error from wrapped error message', () => {
        const wrapped = new Error(`WebSocket error: Server fingerprint not yet accepted: ${SAMPLE_FP}`);
        const result = extractFingerprintError(wrapped);
        assert.ok(result instanceof FingerprintRequiredError);
        assert.strictEqual((result as FingerprintRequiredError).serverFingerprint, SAMPLE_FP);
    });

    test('extracts mismatch error from wrapped error message', () => {
        const wrapped = new Error(
            `Connection failed: Server certificate fingerprint has changed: stored=${SAMPLE_FP} server=${OTHER_FP}`
        );
        const result = extractFingerprintError(wrapped);
        assert.ok(result instanceof FingerprintMismatchError);
        assert.strictEqual((result as FingerprintMismatchError).storedFingerprint, SAMPLE_FP);
        assert.strictEqual((result as FingerprintMismatchError).serverFingerprint, OTHER_FP);
    });

    test('extracts mismatch error from cause chain', () => {
        const cause = new FingerprintMismatchError(SAMPLE_FP, OTHER_FP);
        const wrapped = new Error('Server certificate fingerprint has changed');
        (wrapped as any).cause = cause;
        const result = extractFingerprintError(wrapped);
        assert.ok(result instanceof FingerprintMismatchError);
        assert.strictEqual((result as FingerprintMismatchError).storedFingerprint, SAMPLE_FP);
        assert.strictEqual((result as FingerprintMismatchError).serverFingerprint, OTHER_FP);
    });

    test('returns null for unrelated errors', () => {
        assert.strictEqual(extractFingerprintError(new Error('ECONNRESET')), null);
        assert.strictEqual(extractFingerprintError(new Error('timeout')), null);
        assert.strictEqual(extractFingerprintError('string error'), null);
    });

    test('returns null for null/undefined', () => {
        assert.strictEqual(extractFingerprintError(null), null);
        assert.strictEqual(extractFingerprintError(undefined), null);
    });

    test('falls back to unknown fingerprints when message has no parseable fingerprints', () => {
        const wrapped = new Error('Server certificate fingerprint has changed but no details');
        const result = extractFingerprintError(wrapped);
        assert.ok(result instanceof FingerprintMismatchError);
        assert.strictEqual((result as FingerprintMismatchError).storedFingerprint, 'unknown');
        assert.strictEqual((result as FingerprintMismatchError).serverFingerprint, 'unknown');
    });
});
