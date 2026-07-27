import * as assert from 'assert';
import { JSDOM } from 'jsdom';
import { registerVscodeMock, registerExtensionMock, vscodeMock } from '../helpers/vscodeMock';

(vscodeMock as any).Uri = { ...(vscodeMock as any).Uri, joinPath: () => ({}) };
(vscodeMock as any).window = {
    registerWebviewViewProvider: () => ({ dispose: () => {} }),
    showInformationMessage: () => {},
    showWarningMessage: () => {},
    showErrorMessage: () => {}
};
(vscodeMock as any).commands = { registerCommand: () => ({ dispose: () => {} }) };
(vscodeMock as any).workspace = { getConfiguration: () => ({ get: () => undefined }) };
(vscodeMock as any).env = { clipboard: { writeText: async () => {} } };

registerVscodeMock();
registerExtensionMock();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ResultsPanel } = require('../../panels/resultsPanel');

import { createEmptyRawResult, createRawResult } from '../helpers/mockConnectionManager';

function parseDom(html: string): Document {
    return new JSDOM(`<html><body>${html}</body></html>`).window.document;
}

const DETAILS_COLUMNS = ['SESSION_ID', 'STMT_ID', 'PART_ID', 'IPROC', 'PART_NAME', 'OUT_ROWS', 'DURATION', 'SQL_TEXT'];

function detailsRow(sessionId: string, stmtId: string, partName = 'PIPE SCAN'): any[] {
    return [sessionId, stmtId, 10, 0, partName, 1000, 0.5, 'SELECT 1'];
}

/**
 * Builds a fake webview view whose .webview.html assignments are captured,
 * and whose onDidReceiveMessage handler can be driven directly — the same
 * approach production code drives via postMessage from the browser side.
 */
function makeFakeWebviewView() {
    let html = '';
    let htmlSetCount = 0;
    let handler: ((message: any) => void | Promise<void>) | undefined;
    const webview: any = {
        set html(value: string) { html = value; htmlSetCount++; },
        get html() { return html; },
        onDidReceiveMessage: (fn: any) => { handler = fn; return { dispose() {} }; },
        asWebviewUri: (uri: any) => uri,
        cspSource: 'vscode-resource:'
    };
    const view: any = { webview, show: () => {} };
    return {
        view,
        getHtml: () => html,
        getHtmlSetCount: () => htmlSetCount,
        send: async (message: any) => { await handler!(message); }
    };
}

/**
 * Builds a fake ConnectionManager wired to a scriptable fake driver.
 * `queryImpl` drives rawQuery() (the tier-fetch attempts); rawExecute() (the
 * FLUSH STATISTICS call planProvider issues first) always succeeds here —
 * flush-failure handling has its own dedicated test in planProvider.test.ts.
 */
function makeFakeConnectionManager(queryImpl: (sql: string) => any) {
    const fakeDriver = {
        execute: async () => createEmptyRawResult([]),
        query: async (sql: string) => queryImpl(sql)
    };
    return {
        getActiveConnection: () => ({ id: 'conn-1', name: 'Test' }),
        getConnection: (id: string) => ({ id, name: 'Test' }),
        isExecutionPlanAvailable: () => true,
        getDriver: async () => fakeDriver,
        executeWithRetry: async (fn: () => Promise<any>) => fn()
    };
}

function makeResultsPanel(queryImpl: (sql: string) => any) {
    const connectionManager = makeFakeConnectionManager(queryImpl);
    const fakeContext: any = { extensionUri: {}, subscriptions: [] };
    const provider = ResultsPanel.register(fakeContext, connectionManager);
    const fakeView = makeFakeWebviewView();
    provider.resolveWebviewView(fakeView.view);
    return { provider, fakeView };
}

function makeQueryResult(overrides: Partial<any> = {}) {
    return {
        columns: ['X'],
        columnMetadata: [{ name: 'X', type: 'DECIMAL' }],
        rows: [{ X: 1 }],
        rowCount: 1,
        executionTime: 5,
        sessionId: '42',
        baselineStmtId: '16',
        connectionId: 'conn-1',
        ...overrides
    };
}

suite('ResultsPanel plan tab', () => {

    test('a fresh single-statement result shows the Results tab active with no Plan tab fetch yet', () => {
        const { fakeView } = makeResultsPanel(() => createEmptyRawResult(DETAILS_COLUMNS));
        ResultsPanel.show(makeQueryResult());
        const doc = parseDom(fakeView.getHtml());
        const tabs = doc.querySelectorAll('.rv-tab');
        assert.strictEqual(tabs.length, 2);
        assert.ok(tabs[0].classList.contains('active'));
        assert.strictEqual(doc.querySelector('#grid-root') !== null, true);
    });

    test('clicking the Plan tab fetches and renders a real plan end-to-end', async () => {
        const { fakeView } = makeResultsPanel(sql =>
            sql.includes('$EXA_PROFILE_DETAILS_LAST_DAY')
                ? createRawResult(DETAILS_COLUMNS, [detailsRow('42', '16')])
                : createEmptyRawResult(DETAILS_COLUMNS)
        );
        ResultsPanel.show(makeQueryResult());

        await fakeView.send({ command: 'switchResultView', view: 'plan' });

        const doc = parseDom(fakeView.getHtml());
        assert.ok(doc.querySelector('.rv-tab.active')!.textContent!.includes('Plan'));
        assert.ok(doc.querySelector('.hnode'), 'expected a rendered plan operator node');
        assert.ok(doc.body.textContent!.includes('PIPE SCAN'));
    });

    test('switching back to Results after viewing the plan restores the grid', async () => {
        const { fakeView } = makeResultsPanel(sql =>
            sql.includes('$EXA_PROFILE_DETAILS_LAST_DAY')
                ? createRawResult(DETAILS_COLUMNS, [detailsRow('42', '16')])
                : createEmptyRawResult(DETAILS_COLUMNS)
        );
        ResultsPanel.show(makeQueryResult());

        await fakeView.send({ command: 'switchResultView', view: 'plan' });
        await fakeView.send({ command: 'switchResultView', view: 'results' });

        const doc = parseDom(fakeView.getHtml());
        assert.ok(doc.querySelector('.rv-tab.active')!.textContent!.includes('Results'));
        assert.ok(doc.querySelector('#grid-root'));
        assert.strictEqual(doc.querySelector('.hnode'), null);
    });

    test('a query with no captured session/stmt id never shows a Plan tab, and a stray switch to it does not fetch', async () => {
        // isPlanAvailableForResult gates both tab rendering and this
        // switchResultView guard, so a stray 'plan' message for such a
        // result is redirected back to Results before requestPlan() (whose
        // own "no session/statement id" message stays as a backstop for
        // callers that reach it some other way) ever runs.
        let queryCallCount = 0;
        const { fakeView } = makeResultsPanel(() => { queryCallCount++; return createEmptyRawResult(DETAILS_COLUMNS); });
        ResultsPanel.show(makeQueryResult({ sessionId: undefined, baselineStmtId: undefined }));

        await fakeView.send({ command: 'switchResultView', view: 'plan' });

        assert.strictEqual(queryCallCount, 0, 'must not attempt a plan fetch without ids');
        const doc = parseDom(fakeView.getHtml());
        const tabs = Array.from(doc.querySelectorAll('.rv-tab')).map(tab => tab.textContent);
        assert.deepStrictEqual(tabs, ['Results']);
        assert.ok(doc.querySelector('.rv-tab.active')!.textContent!.includes('Results'));
    });

    test('a fetch failure surfaces the underlying error message, not a crash', async () => {
        // Every tier denied by privilege fails fast with a dedicated message
        // (see planProvider.test.ts) rather than exhausting the retry budget.
        const { fakeView } = makeResultsPanel(() => {
            throw new Error('insufficient privileges for accessing view');
        });
        ResultsPanel.show(makeQueryResult());

        await fakeView.send({ command: 'switchResultView', view: 'plan' });

        const doc = parseDom(fakeView.getHtml());
        assert.ok(doc.querySelector('.rv-tab.error'), 'Plan tab should show the error state');
        assert.ok(doc.querySelector('.plan-status-message')!.textContent!.includes("doesn't have permission"));
        assert.ok(doc.querySelector('[data-plan-retry]'), 'Plan errors should offer a retry path');
    });

    test('clicking the rendered Retry button actually posts switchResultView, not just tab re-clicks', async () => {
        // Regression: the tab-bar's own inline script used to bind the click
        // handler via querySelectorAll('[data-plan-retry]') at parse time,
        // before this button (rendered later, inside .plan-view) existed in
        // the document — matching nothing. Executing the real rendered
        // document's scripts and dispatching a real click is the only way to
        // catch that; asserting the button's presence and posting the
        // message directly (as the other tests here do) cannot.
        const { fakeView } = makeResultsPanel(() => {
            throw new Error('insufficient privileges for accessing view');
        });
        ResultsPanel.show(makeQueryResult());
        await fakeView.send({ command: 'switchResultView', view: 'plan' });

        const html = fakeView.getHtml();
        assert.ok(html.includes('data-plan-retry'), 'expected the plan error body to render a retry button');

        // Stub acquireVsCodeApi before any of the document's own scripts run,
        // the same way VS Code injects it into a real webview.
        const stubbedHtml = html.replace('<head>', `<head><script>
            window.__posted = [];
            window.acquireVsCodeApi = function () {
                return { postMessage: function (message) { window.__posted.push(message); } };
            };
        </script>`);

        const dom = new JSDOM(stubbedHtml, { runScripts: 'dangerously' });
        const button = dom.window.document.querySelector('[data-plan-retry]');
        assert.ok(button, 'expected the retry button in the fully rendered document');

        button!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

        // The posted message is an object from the JSDOM window's own realm,
        // so compare fields directly rather than via deepStrictEqual (which
        // treats cross-realm objects as unequal despite identical shape).
        const posted = (dom.window as any).__posted;
        assert.strictEqual(posted.length, 1, 'expected exactly one postMessage call');
        assert.strictEqual(posted[0].command, 'switchResultView');
        assert.strictEqual(posted[0].view, 'plan');
    });

    test('clicking the Plan tab again after an error retries the fetch', async () => {
        let fetchCount = 0;
        const { fakeView } = makeResultsPanel(sql => {
            if (sql.includes('$EXA_PROFILE_DETAILS_LAST_DAY')) {
                fetchCount++;
                if (fetchCount === 1) {
                    throw new Error('temporary VPN failure');
                }
                return createRawResult(DETAILS_COLUMNS, [detailsRow('42', '16')]);
            }
            return createEmptyRawResult(DETAILS_COLUMNS);
        });
        ResultsPanel.show(makeQueryResult());

        await fakeView.send({ command: 'switchResultView', view: 'plan' });
        assert.ok(parseDom(fakeView.getHtml()).body.textContent!.includes('temporary VPN failure'));

        await fakeView.send({ command: 'switchResultView', view: 'plan' });

        const doc = parseDom(fakeView.getHtml());
        assert.strictEqual(fetchCount, 2, 'the error state must be retryable');
        assert.ok(doc.querySelector('.hnode'), 'expected the retried plan to render');
    });

    test('re-clicking an already-fetched Plan tab does not re-issue the fetch', async () => {
        let fetchCount = 0;
        const { fakeView } = makeResultsPanel(sql => {
            if (sql.includes('$EXA_PROFILE_DETAILS_LAST_DAY')) {
                fetchCount++;
                return createRawResult(DETAILS_COLUMNS, [detailsRow('42', '16')]);
            }
            return createEmptyRawResult(DETAILS_COLUMNS);
        });
        ResultsPanel.show(makeQueryResult());

        await fakeView.send({ command: 'switchResultView', view: 'plan' });
        await fakeView.send({ command: 'switchResultView', view: 'results' });
        await fakeView.send({ command: 'switchResultView', view: 'plan' });

        assert.strictEqual(fetchCount, 1, 'the plan should be cached after the first fetch');
    });

    test('running a new query resets the plan tab back to Results/idle', async () => {
        const { fakeView } = makeResultsPanel(sql =>
            sql.includes('$EXA_PROFILE_DETAILS_LAST_DAY')
                ? createRawResult(DETAILS_COLUMNS, [detailsRow('42', '16')])
                : createEmptyRawResult(DETAILS_COLUMNS)
        );
        ResultsPanel.show(makeQueryResult());
        await fakeView.send({ command: 'switchResultView', view: 'plan' });

        // A second query completes — this must reset the sub-tab and any
        // stale plan state, even though it's a brand-new QueryResult.
        ResultsPanel.show(makeQueryResult({ sessionId: '99', baselineStmtId: '1' }));

        const doc = parseDom(fakeView.getHtml());
        assert.ok(doc.querySelector('.rv-tab.active')!.textContent!.includes('Results'));
        assert.strictEqual(doc.querySelector('.hnode'), null);
    });

    test('a DDL/DML result with no columns still shows the Results | Plan tab strip, with a success summary in Results', () => {
        // Exasol profiles any statement that runs through the SQL engine —
        // IMPORT/EXPORT/INSERT/UPDATE/etc. included — and queryExecutor.ts
        // already captures the session/statement id needed to look that
        // profile up regardless of whether the statement returned columns.
        // There's no reason to hide the Plan tab just because there's no
        // grid to show next to it.
        const { fakeView } = makeResultsPanel(() => createEmptyRawResult(DETAILS_COLUMNS));
        ResultsPanel.show(makeQueryResult({ columns: [], rows: [], rowCount: 3, executionTime: 12 }));

        const doc = parseDom(fakeView.getHtml());
        const tabs = doc.querySelectorAll('.rv-tab');
        assert.strictEqual(tabs.length, 2, 'expected the Results | Plan tab strip even without a result set');
        assert.ok(tabs[0].classList.contains('active'));
        assert.strictEqual(doc.querySelector('#grid-root'), null, 'no result set means no grid to render');
        assert.ok(doc.querySelector('.success-container'), 'expected the success summary in place of a grid');
        assert.ok(doc.body.textContent!.includes('3'), 'expected the rows-affected count to show');
    });

    test('clicking the Plan tab for a no-columns (DDL/DML) result fetches and renders a real plan, same as a SELECT', async () => {
        const { fakeView } = makeResultsPanel(sql =>
            sql.includes('$EXA_PROFILE_DETAILS_LAST_DAY')
                ? createRawResult(DETAILS_COLUMNS, [detailsRow('42', '16')])
                : createEmptyRawResult(DETAILS_COLUMNS)
        );
        ResultsPanel.show(makeQueryResult({ columns: [], rows: [], rowCount: 1 }));

        await fakeView.send({ command: 'switchResultView', view: 'plan' });

        const doc = parseDom(fakeView.getHtml());
        assert.ok(doc.querySelector('.rv-tab.active')!.textContent!.includes('Plan'));
        assert.ok(doc.querySelector('.hnode'), 'expected a rendered plan operator node, exactly as for a SELECT');
    });

    test('a copyPlanText message writes the given text to the clipboard and confirms it', async () => {
        const { fakeView } = makeResultsPanel(sql =>
            sql.includes('$EXA_PROFILE_DETAILS_LAST_DAY')
                ? createRawResult(DETAILS_COLUMNS, [detailsRow('42', '16')])
                : createEmptyRawResult(DETAILS_COLUMNS)
        );
        ResultsPanel.show(makeQueryResult());
        await fakeView.send({ command: 'switchResultView', view: 'plan' });

        let copiedText: string | undefined;
        let infoMessage: string | undefined;
        (vscodeMock as any).env.clipboard.writeText = async (text: string) => { copiedText = text; };
        (vscodeMock as any).window.showInformationMessage = (msg: string) => { infoMessage = msg; };

        await fakeView.send({ command: 'copyPlanText', text: 'Execution plan — session 42, statement 16' });

        assert.strictEqual(copiedText, 'Execution plan — session 42, statement 16');
        assert.ok(infoMessage?.includes('copied to clipboard'));
    });

    test('fetches the plan against the connection the query ran on, not whichever is active now', async () => {
        // Regression: the user runs a query on connection A, switches the active
        // connection to B, then opens the Plan tab. The profile must be looked
        // up on A (whose session produced it) — looking it up on B would query
        // the wrong session/server and silently return "no profiling data".
        const driverConnIds: string[] = [];
        const connections: Record<string, any> = {
            'conn-ran': { id: 'conn-ran', name: 'Ran-On' },
            'conn-active': { id: 'conn-active', name: 'Now-Active' }
        };
        const fakeDriver = {
            execute: async () => createEmptyRawResult([]),
            query: async (sql: string) =>
                sql.includes('$EXA_PROFILE_DETAILS_LAST_DAY')
                    ? createRawResult(DETAILS_COLUMNS, [detailsRow('42', '16')])
                    : createEmptyRawResult(DETAILS_COLUMNS)
        };
        const connectionManager: any = {
            getActiveConnection: () => connections['conn-active'],
            getConnection: (id: string) => connections[id],
            getDriver: async (id: string) => { driverConnIds.push(id); return fakeDriver; },
            executeWithRetry: async (fn: () => Promise<any>) => fn()
        };
        const fakeContext: any = { extensionUri: {}, subscriptions: [] };
        const provider = ResultsPanel.register(fakeContext, connectionManager);
        const fakeView = makeFakeWebviewView();
        provider.resolveWebviewView(fakeView.view);

        ResultsPanel.show(makeQueryResult({ connectionId: 'conn-ran' }));
        await fakeView.send({ command: 'switchResultView', view: 'plan' });

        assert.ok(driverConnIds.length > 0, 'the plan fetch must open a driver');
        assert.ok(
            // Explicit `: boolean` return type — without it, TS treats this
            // arrow as a type-predicate overload of .every() and narrows
            // driverConnIds to `"conn-ran"[]` for the rest of the scope,
            // which then makes the very next assertion's 'conn-active'
            // argument a type error.
            driverConnIds.every((id): boolean => id === 'conn-ran'),
            `every driver call must target the originating connection; saw ${JSON.stringify(driverConnIds)}`
        );
        assert.ok(!driverConnIds.includes('conn-active'), 'must never fetch against the now-active connection');
    });

    test('a plan fetch resolving after the user switched back to Results does not rebuild the grid', async () => {
        let releaseFetch!: () => void;
        const fetchGate = new Promise<void>(resolve => { releaseFetch = resolve; });
        const { fakeView } = makeResultsPanel(async sql => {
            if (sql.includes('$EXA_PROFILE_DETAILS_LAST_DAY')) {
                await fetchGate;
                return createRawResult(DETAILS_COLUMNS, [detailsRow('42', '16')]);
            }
            return createEmptyRawResult(DETAILS_COLUMNS);
        });
        ResultsPanel.show(makeQueryResult());

        const firstPlanRequest = fakeView.send({ command: 'switchResultView', view: 'plan' });
        await new Promise(resolve => setTimeout(resolve, 0));
        await fakeView.send({ command: 'switchResultView', view: 'results' });
        const htmlSetsBeforeResolve = fakeView.getHtmlSetCount();

        releaseFetch();
        await firstPlanRequest;

        assert.strictEqual(
            fakeView.getHtmlSetCount(),
            htmlSetsBeforeResolve,
            'fetch completion must not re-render while Results is active'
        );
        const doc = parseDom(fakeView.getHtml());
        assert.ok(doc.querySelector('.rv-tab.active')!.textContent!.includes('Results'));
        assert.ok(doc.querySelector('#grid-root'));

        await fakeView.send({ command: 'switchResultView', view: 'plan' });
        assert.ok(parseDom(fakeView.getHtml()).querySelector('.hnode'), 'cached plan should render on the next natural switch');
    });

    test('hides the Plan tab when execution plan profiling is unavailable for the result connection', () => {
        const connectionManager: any = {
            getActiveConnection: () => ({ id: 'conn-1', name: 'Test' }),
            getConnection: (id: string) => ({ id, name: 'Test' }),
            isExecutionPlanAvailable: () => false,
            getDriver: async () => { throw new Error('must not fetch'); },
            executeWithRetry: async (fn: () => Promise<any>) => fn()
        };
        const fakeContext: any = { extensionUri: {}, subscriptions: [] };
        const provider = ResultsPanel.register(fakeContext, connectionManager);
        const fakeView = makeFakeWebviewView();
        provider.resolveWebviewView(fakeView.view);

        ResultsPanel.show(makeQueryResult());

        const doc = parseDom(fakeView.getHtml());
        const tabs = Array.from(doc.querySelectorAll('.rv-tab')).map(tab => tab.textContent);
        assert.deepStrictEqual(tabs, ['Results']);
    });

    test('hides the Plan tab for a result with no captured session/statement id (as produced by describe table)', () => {
        // objectActions.ts's describeTable builds its result directly,
        // without ever capturing sessionId/baselineStmtId — it's a metadata
        // lookup, not a profiled statement. Such results must render only Results.
        const { fakeView } = makeResultsPanel(() => createEmptyRawResult(DETAILS_COLUMNS));
        ResultsPanel.show(makeQueryResult({ sessionId: undefined, baselineStmtId: undefined, connectionId: undefined }));

        const doc = parseDom(fakeView.getHtml());
        const tabs = Array.from(doc.querySelectorAll('.rv-tab')).map(tab => tab.textContent);
        assert.deepStrictEqual(tabs, ['Results']);
    });

    test('a plan fetch that resolves after a newer query has run does not overwrite the newer query\'s view', async () => {
        let releaseFirstFetch!: () => void;
        const firstFetchGate = new Promise<void>(resolve => { releaseFirstFetch = resolve; });
        let call = 0;

        const { fakeView } = makeResultsPanel(async sql => {
            if (!sql.includes('$EXA_PROFILE_DETAILS_LAST_DAY')) {
                return createEmptyRawResult(DETAILS_COLUMNS);
            }
            call++;
            if (call === 1) {
                await firstFetchGate; // held open until released below
                return createRawResult(DETAILS_COLUMNS, [detailsRow('42', '16', 'STALE_SCAN')]);
            }
            return createRawResult(DETAILS_COLUMNS, [detailsRow('99', '1', 'FRESH_SCAN')]);
        });

        ResultsPanel.show(makeQueryResult({ sessionId: '42', baselineStmtId: '16' }));
        const firstPlanRequest = fakeView.send({ command: 'switchResultView', view: 'plan' });

        // A second query completes while the first plan fetch is still pending.
        ResultsPanel.show(makeQueryResult({ sessionId: '99', baselineStmtId: '1' }));

        releaseFirstFetch();
        await firstPlanRequest;

        const docAfterStaleResolves = parseDom(fakeView.getHtml());
        assert.ok(
            docAfterStaleResolves.querySelector('.rv-tab.active')!.textContent!.includes('Results'),
            'the stale fetch must not flip the view back to Plan for the new query'
        );
        assert.strictEqual(
            docAfterStaleResolves.querySelector('.hnode'), null,
            'must not render the old query\'s plan under the new result'
        );

        // The real test of the guard: without it, planViewState would already
        // be 'ready' (with the stale session-42 plan) at this point, and this
        // click would show STALE_SCAN immediately instead of fetching fresh.
        await fakeView.send({ command: 'switchResultView', view: 'plan' });

        const docAfterFreshClick = parseDom(fakeView.getHtml());
        assert.strictEqual(call, 2, 'the guard must force a real second fetch, not reuse the discarded stale result');
        assert.ok(docAfterFreshClick.body.textContent!.includes('FRESH_SCAN'));
        assert.ok(!docAfterFreshClick.body.textContent!.includes('STALE_SCAN'));
    });
});
