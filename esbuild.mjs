import * as esbuild from 'esbuild';
import * as path from 'node:path';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Bundles a .css module (resolving @import and inlining assets) and hands it back as a string.
// The notebook renderer injects this text into a <style> element; the glide barrel stylesheet is
// a tree of @import rules that the plain `text` loader would leave unresolved, so it is flattened
// here into a single self-contained sheet with no remote references.
const cssTextPlugin = {
    name: 'css-text',
    setup(build) {
        build.onLoad({ filter: /\.css$/ }, async args => {
            const result = await esbuild.build({
                entryPoints: [args.path],
                bundle: true,
                write: false,
                minify: production,
                conditions: ['import', 'style', 'default'],
                loader: { '.png': 'dataurl', '.svg': 'dataurl', '.gif': 'dataurl' },
                logLevel: 'silent',
            });
            return {
                contents: result.outputFiles[0].text,
                loader: 'text',
                watchFiles: [args.path],
                resolveDir: path.dirname(args.path),
            };
        });
    },
};

const extensionCtx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'es2022',
    outfile: 'out/extension.js',
    external: ['vscode'],
    sourcemap: !production,
    minify: production,
});

const webviewCtx = await esbuild.context({
    entryPoints: ['src/webview/resultsGrid.tsx'],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    outfile: 'media/results-grid-bundle.js',
    sourcemap: !production,
    minify: production,
    define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
    loader: { '.css': 'empty' },
});

const webviewCssCtx = await esbuild.context({
    entryPoints: ['src/webview/glideStyles.css'],
    bundle: true,
    outfile: 'media/results-grid-glide.css',
    sourcemap: !production,
    minify: production,
    conditions: ['import', 'style', 'default'],
    loader: { '.png': 'dataurl', '.svg': 'dataurl', '.gif': 'dataurl' },
});

const notebookRendererCtx = await esbuild.context({
    entryPoints: ['src/webview/notebookRenderer.tsx'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile: 'media/notebook-renderer.js',
    sourcemap: !production,
    minify: production,
    define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
    plugins: [cssTextPlugin],
});

const contexts = [extensionCtx, webviewCtx, webviewCssCtx, notebookRendererCtx];

if (watch) {
    await Promise.all(contexts.map(c => c.watch()));
    console.log('Watching...');
} else {
    await Promise.all(contexts.map(c => c.rebuild()));
    await Promise.all(contexts.map(c => c.dispose()));
}
