/**
 * WebView rendering utilities: nonce generation, HTML/JSON escaping, render context.
 */
import * as crypto from 'crypto';
import type * as vscode from 'vscode';

/**
 * Escape a string for safe embedding in HTML.
 * Used by WebView panel classes to prevent XSS from column names and query text.
 */
export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Generate a cryptographically-random nonce for Content-Security-Policy.
 * Used by WebView panel classes to allow specific inline scripts/styles.
 */
export function generateNonce(): string {
    return crypto.randomBytes(16).toString('base64');
}

/**
 * Escape JSON for safe embedding in <script type="application/json">.
 * The HTML parser treats the element as raw text, but </script> still
 * terminates the block, so we must escape it.  We also escape <!-- and
 * & to be safe with any future parser changes.
 */
export function escapeJsonForDataIsland(json: string): string {
    return json
        .replace(/&/g, '\\u0026')
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e');
}

/**
 * Shared render context for WebView panels.
 * Encapsulates per-render nonce, CSP string, media URI helper, and data island helper
 * so each panel method doesn't repeat the same boilerplate.
 */
export interface WebviewRenderContext {
    /** Freshly-generated cryptographic nonce for this render. */
    nonce: string;
    /** Full content for the CSP meta tag's content attribute. */
    csp: string;
    /** Return a webview-safe URI for a file under the extension's media/ directory. */
    mediaUri: (filename: string) => vscode.Uri;
    /**
     * Return a `<script type="application/json">` data island tag.
     * The value is JSON-serialised and XSS-escaped via escapeJsonForDataIsland.
     */
    dataIsland: (id: string, value: unknown) => string;
}

/**
 * Create a WebviewRenderContext for the given webview and extension URI.
 * Call once per HTML-building method; each call generates a fresh nonce.
 *
 * The caller must supply `vscode.Uri.joinPath` so this module does not need
 * to import vscode at runtime (avoids the dynamic require workaround).
 */
export function createWebviewRenderContext(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    joinPath: (base: vscode.Uri, ...pathSegments: string[]) => vscode.Uri
): WebviewRenderContext {
    const nonce = generateNonce();
    const src = webview.cspSource;
    const csp =
        `default-src 'none'; script-src 'nonce-${nonce}'; ` +
        `style-src ${src} 'nonce-${nonce}'; img-src ${src}; font-src ${src};`;
    return {
        nonce,
        csp,
        mediaUri: (filename: string) =>
            webview.asWebviewUri(joinPath(extensionUri, 'media', filename)),
        dataIsland: (id: string, value: unknown) =>
            `<script id="${id}" type="application/json" nonce="${nonce}">${escapeJsonForDataIsland(JSON.stringify(value))}</script>`
    };
}
