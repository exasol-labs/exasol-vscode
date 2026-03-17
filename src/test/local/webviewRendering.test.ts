import * as assert from 'assert';
import { JSDOM } from 'jsdom';

// Mock vscode module before any source imports that depend on it.
const NodeModule = require('module');
const originalResolveFilename = NodeModule._resolveFilename;
NodeModule._resolveFilename = function (request: string, ...args: any[]) {
    if (request === 'vscode') {
        return 'vscode';
    }
    return originalResolveFilename.call(this, request, ...args);
};

const vscodeMock = {
    Uri: { joinPath: () => ({}) },
    window: {
        registerWebviewViewProvider: () => ({ dispose: () => {} }),
        showSaveDialog: async () => undefined,
        showInformationMessage: () => {},
        showWarningMessage: () => {},
    },
    commands: {
        registerCommand: () => ({ dispose: () => {} }),
        executeCommand: () => {},
    },
    workspace: {
        getConfiguration: () => ({
            get: () => undefined,
        }),
        fs: { writeFile: async () => {} },
    },
    env: { clipboard: { writeText: async () => {} } },
    CancellationTokenSource: class {},
};

require.cache['vscode'] = {
    id: 'vscode',
    filename: 'vscode',
    loaded: true,
    exports: vscodeMock,
    paths: [],
    children: [],
    path: '',
    require: require,
    isPreloading: false,
} as any;

// Now import source modules that transitively depend on vscode.
const { getResultHtml, ResultsPanel } = require('../../panels/resultsPanel');
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
// Single result rendering (getResultHtml)
// ──────────────────────────────────────────────

suite('getResultHtml', () => {

    test('renders column headers for a result with columns', () => {
        const result = makeResult(['id', 'name', 'age'], [
            { id: 1, name: 'Alice', age: 30 },
        ]);
        const html = getResultHtml(result, { title: 'Test', showExport: true });
        const doc = parseDom(html);

        const headers = Array.from(doc.querySelectorAll('th span'))
            .map((el: any) => el.textContent);
        assert.deepStrictEqual(headers, ['id', 'name', 'age']);
    });

    test('renders correct number of column headers including row-number header', () => {
        const result = makeResult(['col_a', 'col_b'], []);
        const html = getResultHtml(result, { title: 'Test', showExport: false });
        const doc = parseDom(html);

        const allTh = doc.querySelectorAll('th');
        // row-number header (#) + 2 data columns
        assert.strictEqual(allTh.length, 3);
        assert.ok(allTh[0].classList.contains('row-number-header'));
    });

    test('renders success message for DDL/DML result with no columns', () => {
        const result: QueryResult = {
            columns: [],
            columnMetadata: [],
            rows: [],
            rowCount: 5,
            executionTime: 100,
        };
        const html = getResultHtml(result, { title: 'Test', showExport: false });
        const doc = parseDom(html);

        const successTitle = doc.querySelector('.success-title');
        assert.ok(successTitle, 'expected success title element');
        assert.ok(
            successTitle!.textContent!.includes('successfully'),
            'expected success message text'
        );

        const rowsAffected = doc.querySelector('.detail-value');
        assert.ok(rowsAffected, 'expected rows affected display');
        assert.ok(rowsAffected!.textContent!.includes('5'));
    });

    test('renders a filter input', () => {
        const result = makeResult(['x'], [{ x: 1 }]);
        const html = getResultHtml(result, { title: 'Test', showExport: true });
        const doc = parseDom(html);

        const filterInput = doc.querySelector('input[type="text"]');
        assert.ok(filterInput, 'expected filter input element');
        assert.ok(
            (filterInput as any).getAttribute('placeholder')?.includes('Filter'),
            'expected filter placeholder text'
        );
    });

    test('renders an export button when showExport is true', () => {
        const result = makeResult(['x'], [{ x: 1 }]);
        const html = getResultHtml(result, { title: 'Test', showExport: true });
        const doc = parseDom(html);

        const exportBtn = doc.getElementById('export');
        assert.ok(exportBtn, 'expected export button');
        assert.ok(exportBtn!.textContent!.includes('Export'));
    });

    test('does not render export button when showExport is false', () => {
        const result = makeResult(['x'], [{ x: 1 }]);
        const html = getResultHtml(result, { title: 'Test', showExport: false });
        const doc = parseDom(html);

        const exportBtn = doc.getElementById('export');
        assert.strictEqual(exportBtn, null);
    });

    test('renders row count display', () => {
        const result = makeResult(['x'], [{ x: 1 }, { x: 2 }, { x: 3 }]);
        const html = getResultHtml(result, { title: 'Test', showExport: true });
        const doc = parseDom(html);

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
// Shared CSS/JS static methods
// ──────────────────────────────────────────────

suite('ResultsPanel static methods', () => {

    test('getSharedGridCss returns non-empty string with expected selectors', () => {
        const css: string = ResultsPanel.getSharedGridCss();
        assert.ok(css.length > 0, 'CSS should be non-empty');
        assert.ok(css.includes('.table-container'), 'expected .table-container selector');
        assert.ok(css.includes('.null-value'), 'expected .null-value selector');
        assert.ok(css.includes('.context-menu'), 'expected .context-menu selector');
        assert.ok(css.includes('th'), 'expected th selector');
        assert.ok(css.includes('td'), 'expected td selector');
    });

    test('getSharedGridScript returns non-empty string with expected function names', () => {
        const dataJson = JSON.stringify({ columns: ['x'], columnMetadata: [], rows: [] });
        const script: string = ResultsPanel.getSharedGridScript(dataJson, 'filter-1', 'null', "'asc'");
        assert.ok(script.length > 0, 'script should be non-empty');
        assert.ok(script.includes('sortRows'), 'expected sortRows function');
        assert.ok(script.includes('render'), 'expected render function');
        assert.ok(script.includes('filterInput'), 'expected filterInput reference');
        assert.ok(script.includes('copyValues'), 'expected copyValues function');
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
