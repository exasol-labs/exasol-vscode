import * as assert from 'assert';
import type * as vscode from 'vscode';
import { createWebviewRenderContext } from '../../utils';

/**
 * Minimal stubs for vscode.Webview and vscode.Uri (no vscode runtime needed
 * because createWebviewRenderContext receives joinPath as a plain argument).
 */
function makeWebviewStub(cspSource: string): vscode.Webview {
    return {
        cspSource,
        asWebviewUri: (uri: vscode.Uri) => uri,
    } as unknown as vscode.Webview;
}

function makeUriStub(path: string): vscode.Uri {
    return { path } as unknown as vscode.Uri;
}

function joinPathStub(base: vscode.Uri, ...segments: string[]): vscode.Uri {
    return { path: [base.path, ...segments].join('/') } as unknown as vscode.Uri;
}

suite('createWebviewRenderContext', () => {
    test('returns object with nonce, csp, mediaUri, dataIsland properties', () => {
        const webview = makeWebviewStub('https://example.com');
        const extensionUri = makeUriStub('/ext');
        const ctx = createWebviewRenderContext(webview, extensionUri, joinPathStub);
        assert.ok(typeof ctx.nonce === 'string');
        assert.ok(typeof ctx.csp === 'string');
        assert.ok(typeof ctx.mediaUri === 'function');
        assert.ok(typeof ctx.dataIsland === 'function');
    });

    test('csp string contains the nonce in nonce-<value> form', () => {
        const webview = makeWebviewStub('https://example.com');
        const extensionUri = makeUriStub('/ext');
        const ctx = createWebviewRenderContext(webview, extensionUri, joinPathStub);
        assert.ok(ctx.csp.includes(`'nonce-${ctx.nonce}'`));
    });

    test('dataIsland returns a valid script data island tag', () => {
        const webview = makeWebviewStub('https://example.com');
        const extensionUri = makeUriStub('/ext');
        const ctx = createWebviewRenderContext(webview, extensionUri, joinPathStub);
        const tag = ctx.dataIsland('my-data', { foo: 1 });
        assert.ok(tag.includes('type="application/json"'));
        assert.ok(tag.includes(`nonce="${ctx.nonce}"`));
        assert.ok(tag.includes('id="my-data"'));
    });

    test('dataIsland value is XSS-escaped (no literal </script> in output)', () => {
        const webview = makeWebviewStub('https://example.com');
        const extensionUri = makeUriStub('/ext');
        const ctx = createWebviewRenderContext(webview, extensionUri, joinPathStub);
        const attack = { x: '</script><script>alert(1)</script>' };
        const tag = ctx.dataIsland('x', attack);
        assert.ok(!tag.includes('</script><script>'));
    });

    test('dataIsland value round-trips via JSON.parse', () => {
        const webview = makeWebviewStub('https://example.com');
        const extensionUri = makeUriStub('/ext');
        const ctx = createWebviewRenderContext(webview, extensionUri, joinPathStub);
        const value = { a: 1, b: 'hello', c: [1, 2, 3] };
        const tag = ctx.dataIsland('d', value);
        // Extract JSON between script tags
        const match = tag.match(/<script[^>]*>([\s\S]*?)<\/script>/);
        assert.ok(match);
        // Reverse the XSS escaping to recover valid JSON
        const escaped = match![1];
        const json = escaped
            .replace(/\\u003c/g, '<')
            .replace(/\\u003e/g, '>')
            .replace(/\\u0026/g, '&');
        assert.deepStrictEqual(JSON.parse(json), value);
    });

    test('two successive calls produce different nonces', () => {
        const webview = makeWebviewStub('https://example.com');
        const extensionUri = makeUriStub('/ext');
        const ctx1 = createWebviewRenderContext(webview, extensionUri, joinPathStub);
        const ctx2 = createWebviewRenderContext(webview, extensionUri, joinPathStub);
        assert.notStrictEqual(ctx1.nonce, ctx2.nonce);
    });

    test('mediaUri calls joinPath and asWebviewUri with correct segments', () => {
        const cspSource = 'https://file.example.com';
        const calls: Array<[vscode.Uri, ...string[]]> = [];
        const webview = {
            cspSource,
            asWebviewUri: (uri: vscode.Uri) => ({ webviewUri: uri }) as unknown as vscode.Uri,
        } as unknown as vscode.Webview;
        const extensionUri = makeUriStub('/ext');
        const trackedJoinPath = (base: vscode.Uri, ...segments: string[]) => {
            calls.push([base, ...segments]);
            return joinPathStub(base, ...segments);
        };
        const ctx = createWebviewRenderContext(webview, extensionUri, trackedJoinPath);
        ctx.mediaUri('main.js');
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0][0].path, '/ext');
        assert.strictEqual(calls[0][1], 'media');
        assert.strictEqual(calls[0][2], 'main.js');
    });
});
