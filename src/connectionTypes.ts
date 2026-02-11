/**
 * Pure types, error classes, and utility functions for connection management.
 * Kept separate from connectionManager.ts to allow unit testing without VS Code.
 */

export type TlsMode = 'off' | 'fingerprint' | 'full';

/**
 * Format an unknown error value into a readable string.
 * The Exasol driver sometimes rejects with plain objects (e.g. {text, sqlCode})
 * instead of Error instances.
 */
export function formatError(error: unknown): string {
    if (error instanceof Error) {
        // Some errors (e.g. from ws/Node.js net) have an empty message but a useful .code
        const code = (error as any).code;
        if (error.message && code) {
            return `${error.message} (${code})`;
        }
        if (error.message) {
            return error.message;
        }
        if (code) {
            return String(code);
        }
        // Last resort for Error instances with nothing useful
        return error.toString();
    }
    if (typeof error === 'string') {
        return error;
    }
    if (error && typeof error === 'object') {
        // Driver exception objects typically have a "text" field
        const obj = error as Record<string, unknown>;
        if (obj.text) {
            return String(obj.text);
        }
        return JSON.stringify(error);
    }
    return String(error);
}

export interface ExasolConnection {
    name: string;
    host: string;
    port: number;
    user: string;
    password: string;
    database?: string;
    schema?: string;
    tlsMode?: TlsMode;
    fingerprint?: string;
}

/**
 * Custom error thrown when a fingerprint-mode connection has no stored fingerprint.
 * Contains the server's fingerprint so the caller can prompt the user (TOFU).
 */
export class FingerprintRequiredError extends Error {
    constructor(public readonly serverFingerprint: string) {
        super(`Server fingerprint not yet accepted: ${serverFingerprint}`);
        this.name = 'FingerprintRequiredError';
    }
}

/**
 * Custom error thrown when the server's fingerprint doesn't match the stored one.
 */
export class FingerprintMismatchError extends Error {
    constructor(
        public readonly storedFingerprint: string,
        public readonly serverFingerprint: string
    ) {
        super(`Server certificate fingerprint has changed: stored=${storedFingerprint} server=${serverFingerprint}`);
        this.name = 'FingerprintMismatchError';
    }
}

/**
 * Normalize a fingerprint: strip colons/spaces, uppercase.
 */
export function normalizeFingerprint(fp: string): string {
    return fp.replace(/[:\s]/g, '').toUpperCase();
}

export interface StoredConnection extends ExasolConnection {
    id: string;
}

/**
 * Extract a FingerprintRequiredError or FingerprintMismatchError from a potentially wrapped error.
 * The TLS/WebSocket layer may wrap our custom errors.
 */
export function extractFingerprintError(error: unknown): FingerprintRequiredError | FingerprintMismatchError | null {
    if (error instanceof FingerprintRequiredError || error instanceof FingerprintMismatchError) {
        return error;
    }
    // Check if the error message contains our custom error markers
    const msg = error instanceof Error ? error.message : String(error);
    const tofuMatch = msg.match(/Server fingerprint not yet accepted: ([A-Fa-f0-9]{64})/);
    if (tofuMatch) {
        return new FingerprintRequiredError(tofuMatch[1].toUpperCase());
    }
    if (msg.includes('Server certificate fingerprint has changed')) {
        // Try to reconstruct from the cause chain first
        const cause = (error as any)?.cause;
        if (cause instanceof FingerprintMismatchError) {
            return cause;
        }
        // Parse fingerprints from the error message
        const mismatchMatch = msg.match(/stored=([A-Fa-f0-9]{64})\s+server=([A-Fa-f0-9]{64})/);
        if (mismatchMatch) {
            return new FingerprintMismatchError(mismatchMatch[1].toUpperCase(), mismatchMatch[2].toUpperCase());
        }
        // Last resort: fingerprints not recoverable
        return new FingerprintMismatchError('unknown', 'unknown');
    }
    return null;
}
