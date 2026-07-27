import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';
import { registerVscodeMock, registerExtensionMock, vscodeMock } from '../helpers/vscodeMock';

// resultsPanel.ts now transitively imports planProvider.ts -> connectionManager.ts
// -> ./extension (for getOutputChannel), which in turn imports the full set of
// tree/completion/notebook providers. registerExtensionMock() swaps out
// ./extension with a lightweight fake before anything requires it, so that
// whole chain never has to actually load under this test's minimal vscode mock.
(vscodeMock as any).Uri = { ...(vscodeMock as any).Uri, joinPath: () => ({}) };
(vscodeMock as any).window = {
    registerWebviewViewProvider: () => ({ dispose: () => {} }),
    showSaveDialog: async () => undefined,
    showInformationMessage: () => {},
    showWarningMessage: () => {},
};
(vscodeMock as any).commands = {
    registerCommand: () => ({ dispose: () => {} }),
    executeCommand: () => {},
};
(vscodeMock as any).workspace = {
    getConfiguration: () => ({ get: () => undefined }),
    fs: { writeFile: async () => {} },
};
(vscodeMock as any).env = { clipboard: { writeText: async () => {} } };
(vscodeMock as any).CancellationTokenSource = class {};

registerVscodeMock();
registerExtensionMock();

// Now import source modules that transitively depend on vscode.
const { ResultsPanel } = require('../../panels/resultsPanel');
const { buildTabBarHtml, buildTabBarCss } = require('../../panels/tabBarRenderer');
const { TabManager } = require('../../panels/tabManager');

interface QueryResult {
    columns: string[];
    columnMetadata: { name: string; type: string }[];
    rows: Record<string, any>[];
    rowCount: number;
    executionTime: number;
}

function makeResult(columns: string[], rows: Record<string, any>[]): QueryResult {
    return {
        columns,
        columnMetadata: columns.map(name => ({ name, type: 'VARCHAR' })),
        rows,
        rowCount: rows.length,
        executionTime: 42,
    };
}

function parseDom(html: string): Document {
    const dom = new JSDOM(html);
    return dom.window.document;
}

// ──────────────────────────────────────────────
// Grid HTML structure (ResultsPanel.getGridHtmlStructure)
// ──────────────────────────────────────────────

suite('ResultsPanel.getGridHtmlStructure', () => {

    test('renders a grid-root mount point for the canvas grid', () => {
        const result = makeResult(['id', 'name', 'age'], [
            { id: 1, name: 'Alice', age: 30 },
        ]);
        const html = ResultsPanel.getGridHtmlStructure(result, 'filter-1', '');
        const doc = parseDom(`<html><body>${html}</body></html>`);

        const gridRoot = doc.getElementById('grid-root');
        assert.ok(gridRoot, 'expected #grid-root mount element');
    });

    test('does not render a server-side HTML table', () => {
        const result = makeResult(['col_a', 'col_b'], []);
        const html = ResultsPanel.getGridHtmlStructure(result, 'filter-1', '');
        const doc = parseDom(`<html><body>${html}</body></html>`);

        assert.strictEqual(doc.querySelector('table'), null, 'canvas grid must not emit a <table>');
        assert.strictEqual(doc.querySelector('th'), null, 'canvas grid must not emit <th> headers');
    });

    test('renders a filter input with the provided filterId', () => {
        const result = makeResult(['x'], [{ x: 1 }]);
        const html = ResultsPanel.getGridHtmlStructure(result, 'my-filter-id', '');
        const doc = parseDom(`<html><body>${html}</body></html>`);

        const filterInput = doc.getElementById('my-filter-id');
        assert.ok(filterInput, 'expected filter input element with matching id');
        assert.ok(
            (filterInput as any).getAttribute('placeholder')?.includes('Filter'),
            'expected filter placeholder text'
        );
    });

    test('renders an export button when exportButton HTML is provided', () => {
        const result = makeResult(['x'], [{ x: 1 }]);
        const html = ResultsPanel.getGridHtmlStructure(result, 'filter-1', '<button id="export">Export CSV</button>');
        const doc = parseDom(`<html><body>${html}</body></html>`);

        const exportBtn = doc.getElementById('export');
        assert.ok(exportBtn, 'expected export button');
        assert.ok(exportBtn!.textContent!.includes('Export'));
    });

    test('renders no export button when exportButton is empty string', () => {
        const result = makeResult(['x'], [{ x: 1 }]);
        const html = ResultsPanel.getGridHtmlStructure(result, 'filter-1', '');
        const doc = parseDom(`<html><body>${html}</body></html>`);

        const exportBtn = doc.getElementById('export');
        assert.strictEqual(exportBtn, null);
    });

    test('renders row count display', () => {
        const result = makeResult(['x'], [{ x: 1 }, { x: 2 }, { x: 3 }]);
        const html = ResultsPanel.getGridHtmlStructure(result, 'filter-1', '');
        const doc = parseDom(`<html><body>${html}</body></html>`);

        const countEl = doc.getElementById('count');
        assert.ok(countEl, 'expected count element');
        assert.ok(countEl!.textContent!.includes('3'), 'expected row count of 3');
    });
});

// ──────────────────────────────────────────────
// Tab bar rendering (buildTabBarHtml)
// ──────────────────────────────────────────────

suite('buildTabBarHtml', () => {

    test('renders correct number of tab elements', () => {
        const tabs = [
            { label: 'Result 1', result: makeResult(['a'], []) },
            { label: 'Result 2', result: makeResult(['b'], []) },
            { label: 'Result 3', result: makeResult(['c'], []) },
        ];
        const html = buildTabBarHtml(tabs, 0);
        const doc = parseDom(`<html><body>${html}</body></html>`);

        const tabEls = doc.querySelectorAll('.tab');
        assert.strictEqual(tabEls.length, 3);
    });

    test('active tab has .active class', () => {
        const tabs = [
            { label: 'Result 1', result: makeResult(['a'], []) },
            { label: 'Result 2', result: makeResult(['b'], []) },
        ];
        const html = buildTabBarHtml(tabs, 1);
        const doc = parseDom(`<html><body>${html}</body></html>`);

        const tabEls = doc.querySelectorAll('.tab');
        assert.ok(!tabEls[0].classList.contains('active'), 'first tab should not be active');
        assert.ok(tabEls[1].classList.contains('active'), 'second tab should be active');
    });

    test('error tab has .error class', () => {
        const tabs = [
            { label: 'Result 1', result: makeResult(['a'], []) },
            { label: 'Result 2', error: 'something went wrong' },
        ];
        const html = buildTabBarHtml(tabs, 0);
        const doc = parseDom(`<html><body>${html}</body></html>`);

        const tabEls = doc.querySelectorAll('.tab');
        assert.ok(!tabEls[0].classList.contains('error'), 'first tab should not have error class');
        assert.ok(tabEls[1].classList.contains('error'), 'second tab should have error class');
    });

    test('tab elements have correct data-index attributes', () => {
        const tabs = [
            { label: 'Result 1', result: makeResult(['a'], []) },
            { label: 'Result 2', result: makeResult(['b'], []) },
            { label: 'Result 3', result: makeResult(['c'], []) },
        ];
        const html = buildTabBarHtml(tabs, 0);
        const doc = parseDom(`<html><body>${html}</body></html>`);

        const tabEls = doc.querySelectorAll('.tab');
        assert.strictEqual(tabEls[0].getAttribute('data-index'), '0');
        assert.strictEqual(tabEls[1].getAttribute('data-index'), '1');
        assert.strictEqual(tabEls[2].getAttribute('data-index'), '2');
    });

    test('tab labels show "Result 1", "Result 2" format', () => {
        const tabs = [
            { label: 'Result 1', result: makeResult(['a'], []) },
            { label: 'Result 2', result: makeResult(['b'], []) },
        ];
        const html = buildTabBarHtml(tabs, 0);
        const doc = parseDom(`<html><body>${html}</body></html>`);

        const labels = doc.querySelectorAll('.tab-label');
        assert.strictEqual(labels[0].textContent, 'Result 1');
        assert.strictEqual(labels[1].textContent, 'Result 2');
    });

    test('escapes HTML in tab labels', () => {
        const tabs = [
            { label: '<script>alert("xss")</script>', result: makeResult(['a'], []) },
        ];
        const html = buildTabBarHtml(tabs, 0);
        // The raw HTML should not contain unescaped script tags
        assert.ok(!html.includes('<script>alert'));
        assert.ok(html.includes('&lt;script&gt;'));
    });
});

// ──────────────────────────────────────────────
// TabManager.shouldShowTabBar
// ──────────────────────────────────────────────

suite('TabManager.shouldShowTabBar', () => {

    test('returns false for a single tab', () => {
        const manager = new TabManager();
        manager.setTabs([{ label: 'Result 1', result: makeResult(['a'], []) }]);
        assert.strictEqual(manager.shouldShowTabBar(), false);
    });

    test('returns true for multiple tabs', () => {
        const manager = new TabManager();
        manager.setTabs([
            { label: 'Result 1', result: makeResult(['a'], []) },
            { label: 'Result 2', result: makeResult(['b'], []) },
        ]);
        assert.strictEqual(manager.shouldShowTabBar(), true);
    });
});

// ──────────────────────────────────────────────
// Media asset files (results-grid.css / grid bundle)
// ──────────────────────────────────────────────

const mediaDir = path.resolve(__dirname, '..', '..', '..', 'media');

suite('media/results-grid.css', () => {

    test('exists and contains expected chrome selectors', () => {
        const cssPath = path.join(mediaDir, 'results-grid.css');
        assert.ok(fs.existsSync(cssPath), 'media/results-grid.css must exist');
        const css = fs.readFileSync(cssPath, 'utf8');
        assert.ok(css.length > 0, 'CSS should be non-empty');
        assert.ok(css.includes('.header'), 'expected .header selector');
        assert.ok(css.includes('.grid-root'), 'expected .grid-root selector');
        assert.ok(css.includes('.grid-context-menu'), 'expected .grid-context-menu selector');
        assert.ok(css.includes('#count'), 'expected #count selector');
    });
});

suite('media/results-grid-bundle.js', () => {

    test('the legacy vanilla grid script is removed', () => {
        const legacyPath = path.join(mediaDir, 'results-grid.js');
        assert.ok(!fs.existsSync(legacyPath), 'media/results-grid.js must no longer exist');
    });
});

// ──────────────────────────────────────────────
// Tab bar CSS (buildTabBarCss)
// ──────────────────────────────────────────────

suite('buildTabBarCss', () => {

    test('returns non-empty string with tab-bar selectors', () => {
        const css: string = buildTabBarCss();
        assert.ok(css.length > 0, 'CSS should be non-empty');
        assert.ok(css.includes('.tab-bar'), 'expected .tab-bar selector');
        assert.ok(css.includes('.tab.active'), 'expected .tab.active selector');
        assert.ok(css.includes('.tab.error'), 'expected .tab.error selector');
    });
});
