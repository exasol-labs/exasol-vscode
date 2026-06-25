import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

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

const contexts = [extensionCtx, webviewCtx, webviewCssCtx];

if (watch) {
    await Promise.all(contexts.map(c => c.watch()));
    console.log('Watching...');
} else {
    await Promise.all(contexts.map(c => c.rebuild()));
    await Promise.all(contexts.map(c => c.dispose()));
}
