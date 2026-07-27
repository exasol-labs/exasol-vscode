import * as assert from 'assert';
import { JSDOM } from 'jsdom';
import {
    buildPlanContentHtml,
    buildPlanContentCss,
    buildPlanErrorHtml,
    buildPlanLoadingHtml,
    buildPlanStatusCss
} from '../../plan/planWebview';
import { Plan, PlanNode, OperatorTraits } from '../../plan/planModel';

function parseDom(html: string): Document {
    return new JSDOM(`<html><body>${html}</body></html>`).window.document;
}

/** Actually executes the inline click-handling script, unlike parseDom()
 * above — needed to prove the popover's open/close/keyboard behavior at
 * runtime, not just that the right-looking script text is present. */
function buildInteractiveDom(plan: Plan): JSDOM {
    const html = buildPlanContentHtml(plan, 'n0nce');
    return new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { runScripts: 'dangerously' });
}

function click(dom: JSDOM, el: Element): void {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

function keydown(dom: JSDOM, el: Element, key: string): void {
    el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

function popoverFor(dom: JSDOM, node: Element): HTMLElement {
    return node.parentElement!.querySelector('[data-popover]') as HTMLElement;
}

/** JSDOM's real getBoundingClientRect() is always an all-zero rect (no
 * layout engine), which can't exercise "is there more room above or
 * below" branches at all — this stubs a concrete rect on one element so a
 * test can control exactly what positionPopover() sees. */
function stubRect(el: Element, rect: { top: number; bottom: number; left?: number; right?: number }): void {
    const left = rect.left ?? 0;
    const right = rect.right ?? left + 200;
    (el as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => ({
        top: rect.top, bottom: rect.bottom, left, right,
        width: right - left, height: rect.bottom - rect.top, x: left, y: rect.top,
        toJSON() { return this; }
    });
}

function stubOffsetHeight(el: Element, height: number): void {
    Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true });
}

/** Stubs the rect of a flow item's ring specifically (its actual visual
 * anchor), given the item is a .hstep or bare .hnode-wrap — matching what
 * layoutFlowRows()'s own ringCenterX() looks up. */
function stubRingCenter(item: Element, centerX: number): void {
    const ring = item.querySelector('.hnode-ring') ?? item;
    stubRect(ring, { top: 0, bottom: 46, left: centerX - 23, right: centerX + 23 });
}

const PASSTHROUGH_TRAITS: OperatorTraits = {
    producesRows: true, consumesRows: true, canSpill: true,
    movesDataOverNetwork: true, blocking: true, isSystemStep: false
};

function makeNode(overrides: Partial<PlanNode> = {}): PlanNode {
    return {
        id: '1',
        operatorType: 'JOIN',
        operatorLabel: 'JOIN',
        traits: PASSTHROUGH_TRAITS,
        objectSchema: undefined,
        objectName: undefined,
        partInfo: undefined,
        remarks: undefined,
        objectRows: undefined,
        rowsOut: 100,
        duration: 0.01,
        cpu: 50,
        net: undefined,
        tempDbRamPeak: undefined,
        hddWrite: undefined,
        hddRead: undefined,
        costPercent: 25,
        perNodeStats: undefined,
        perNodeDurationStats: undefined,
        warnings: [],
        children: [],
        ...overrides
    };
}

function makePlan(nodes: PlanNode[], overrides: Partial<Plan> = {}): Plan {
    return {
        sessionId: '1',
        stmtId: '1',
        queryText: 'SELECT 1',
        totalDuration: 0.04,
        nodes,
        edges: [],
        perNodeStatsAvailable: false,
        source: 'USER_SUMMARY',
        ...overrides
    };
}

suite('buildPlanContentHtml', () => {

    test('renders one node per plan node, in order', () => {
        const plan = makePlan([
            makeNode({ id: '1', operatorLabel: 'SCAN' }),
            makeNode({ id: '2', operatorLabel: 'JOIN' }),
            makeNode({ id: '3', operatorLabel: 'SORT' })
        ]);
        const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
        const names = Array.from(doc.querySelectorAll('.hnode-name')).map(el => el.textContent);
        assert.deepStrictEqual(names, ['SCAN', 'JOIN', 'SORT']);
    });

    test('the ring carries a title attribute naming the operator type, as a cheap hover legend (finding 5)', () => {
        const plan = makePlan([makeNode({ operatorType: 'GROUP_BY' })]);
        const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
        assert.strictEqual(doc.querySelector('.hnode-ring')!.getAttribute('title'), 'Group By');
    });

    test('the statement/total-time/operator-count summary lives only in the rail now, not the caption strip (finding 22, rail consolidation)', () => {
        // The caption strip used to repeat "Statement N · X ms total · N
        // operators" — the exact same numbers the Profile overview rail
        // already showed for Total time (and, after this change, Statement
        // and Operators too). The caption is now just the toolbar row: the
        // copy button, nothing else.
        const plan = makePlan([makeNode()], { stmtId: '39', totalDuration: 0.5 });
        const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));

        const caption = doc.querySelector('.plan-flow-caption')!;
        assert.ok(!caption.textContent!.includes('Statement 39'), 'the caption must no longer repeat the statement number');
        assert.ok(!/\btotal\b/.test(caption.textContent!), 'the caption must no longer repeat the total time');
        assert.ok(!/\boperator/.test(caption.textContent!), 'the caption must no longer repeat the operator count');
        assert.ok(caption.querySelector('[data-copy-plan]'), 'the copy-as-text button must still render, unchanged');

        // The explanatory title attribute (finding 22) migrated from the
        // caption onto the rail's own Statement row.
        const statementRow = Array.from(doc.querySelectorAll('.plan-side-row')).find(
            el => el.querySelector('span:first-child')!.textContent === 'Statement'
        );
        assert.ok(statementRow, 'expected a Statement row in the Profile overview rail');
        assert.strictEqual(statementRow!.getAttribute('title'), 'Serial number of the statement within its session');
        assert.strictEqual(statementRow!.querySelector('span:last-child')!.textContent, '39');
    });

    test('escapes a malicious operator label / object name / remarks / query text', () => {
        const evil = '<script>alert(1)</script>';
        const plan = makePlan(
            [makeNode({ operatorLabel: evil, objectSchema: evil, objectName: evil, remarks: evil })],
            { queryText: evil }
        );
        const html = buildPlanContentHtml(plan, 'n0nce');

        assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag must never appear');
        assert.ok(html.includes('&lt;script&gt;'), 'expected escaped angle brackets somewhere in output');
    });

    test('renders the query text in a <pre> block', () => {
        const plan = makePlan([makeNode()], { queryText: 'SELECT * FROM t' });
        const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
        const pre = doc.querySelector('.plan-sql');
        assert.ok(pre);
        assert.strictEqual(pre!.textContent, 'SELECT * FROM t');
    });

    test('omits the query block entirely when queryText is undefined', () => {
        const plan = makePlan([makeNode()], { queryText: undefined });
        const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
        assert.strictEqual(doc.querySelector('.plan-sql'), null);
    });

    suite('merged toolbar row (finding 1, round 7)', () => {
        test('with query text: the caption row hosts both the toggle (left) and the copy button (right)', () => {
            const plan = makePlan([makeNode()], { queryText: 'SELECT * FROM t' });
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            const caption = doc.querySelector('.plan-flow-caption')!;
            const toggle = caption.querySelector('[data-sql-toggle]');
            const copyBtn = caption.querySelector('[data-copy-plan]');
            assert.ok(toggle, 'expected the query-text toggle inside the merged row');
            assert.ok(copyBtn, 'expected the copy button inside the merged row');
            assert.strictEqual(toggle!.nextElementSibling, copyBtn, 'the toggle must precede the copy button in DOM order (left-to-right)');
        });

        test('without query text: the row renders with only the copy button, no toggle', () => {
            const plan = makePlan([makeNode()], { queryText: undefined });
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            const caption = doc.querySelector('.plan-flow-caption')!;
            assert.strictEqual(caption.querySelector('[data-sql-toggle]'), null);
            assert.ok(caption.querySelector('[data-copy-plan]'), 'the copy button must still render');
        });

        test('the copy button is kept flush right via margin-left: auto, not justify-content alone (works with or without the toggle)', () => {
            const css = buildPlanContentCss();
            assert.ok(
                /\.plan-copy-btn\s*\{[^}]*margin-left:\s*auto/.test(css),
                'expected .plan-copy-btn to claim its own leading space via margin-left: auto, robust whether or not the toggle sibling renders'
            );
            assert.ok(
                /\.plan-flow-caption\s*\{[^}]*justify-content:\s*space-between/.test(css),
                'expected justify-content: space-between restored now the row has two children again when the toggle renders'
            );
        });

        test('the query-text pre sits directly after the merged row, not nested inside it', () => {
            const plan = makePlan([makeNode()], { queryText: 'SELECT * FROM t' });
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            const caption = doc.querySelector('.plan-flow-caption')!;
            assert.strictEqual(caption.querySelector('.plan-sql'), null, '.plan-sql must not be nested inside the caption row');
            assert.strictEqual(caption.nextElementSibling!.className, 'plan-sql', '.plan-sql must directly follow the merged row');
        });
    });

    suite('collapsible query text', () => {
        test('the toggle is a real, keyboard-activatable button with aria-expanded', () => {
            const plan = makePlan([makeNode()], { queryText: 'SELECT * FROM t' });
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            const toggle = doc.querySelector('[data-sql-toggle]')!;
            assert.strictEqual(toggle.tagName, 'BUTTON');
            assert.strictEqual(toggle.getAttribute('aria-expanded'), 'false');
        });

        test('the query text is hidden by default, behind the toggle', () => {
            const plan = makePlan([makeNode()], { queryText: 'SELECT * FROM t' });
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            assert.ok(doc.querySelector('.plan-sql')!.hasAttribute('hidden'));
        });

        test('the stylesheet actually hides the query block\'s [hidden], not just sets the attribute', () => {
            const css = buildPlanContentCss();
            assert.ok(
                /\.plan-sql\[hidden\]\s*\{[^}]*display:\s*none/.test(css),
                'expected an explicit .plan-sql[hidden] { display: none } override in the stylesheet'
            );
        });

        test('the toggle script targets the query block specifically, not the whole document', () => {
            const plan = makePlan([makeNode()], { queryText: 'SELECT * FROM t' });
            const html = buildPlanContentHtml(plan, 'n0nce');
            assert.ok(html.includes('data-sql-toggle'));
            // The toggle now shares .plan-flow-caption with the Copy button
            // (the merged toolbar row, finding 1) so .plan-sql is no longer
            // its own nextElementSibling — it's the next sibling of the
            // whole caption row instead, reached via closest().
            assert.ok(html.includes('closest') && html.includes('nextElementSibling'), 'expected the toggle to reference the caption row\'s sibling, not query the whole document');
        });

        test('clicking the toggle reveals the query text, flips the label, and updates aria-expanded (real script execution)', () => {
            const plan = makePlan([makeNode()], { queryText: 'SELECT * FROM t' });
            const dom = buildInteractiveDom(plan);
            const toggle = dom.window.document.querySelector('[data-sql-toggle]')!;
            const sql = dom.window.document.querySelector('.plan-sql') as HTMLElement;
            assert.strictEqual(sql.hidden, true);
            assert.strictEqual(toggle.textContent, '▸ Query text');

            click(dom, toggle);
            assert.strictEqual(sql.hidden, false, 'clicking the toggle must reveal the query text');
            assert.strictEqual(toggle.textContent, '▾ Query text');
            assert.strictEqual(toggle.getAttribute('aria-expanded'), 'true');

            click(dom, toggle);
            assert.strictEqual(sql.hidden, true, 'clicking it again must hide the query text');
            assert.strictEqual(toggle.getAttribute('aria-expanded'), 'false');
        });
    });

    suite('cost ring', () => {
        // The ring's fill is carried as data-ring-pct/data-ring-color, NOT an
        // inline style="" attribute — the webview's CSP has no
        // 'unsafe-hashes'/'unsafe-inline' on style-src, and a style-src nonce
        // only covers nonce'd <style> elements, never inline style attributes,
        // so the browser would silently drop a style="" here. The value is
        // painted via the CSSOM instead, by the nonce'd <script> (verified by
        // the "real script execution" suite below, which checks the actually
        // computed background rather than any markup attribute).
        test('clamps a costPercent above 100 to a 100% ring fill', () => {
            const plan = makePlan([
                makeNode({ id: '1', costPercent: 250 }),
                makeNode({ id: '2', costPercent: 5 })
            ]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            const ring = doc.querySelectorAll('.hnode-ring')[0];
            assert.strictEqual(ring!.getAttribute('data-ring-pct'), '100');
            assert.strictEqual(ring!.hasAttribute('style'), false, 'the ring fill must not be a CSP-blocked inline style attribute');
        });

        test('clamps a negative costPercent to a 0% ring fill', () => {
            const plan = makePlan([
                makeNode({ id: '1', costPercent: -10 }),
                makeNode({ id: '2', costPercent: 5 })
            ]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            const ring = doc.querySelectorAll('.hnode-ring')[0];
            assert.strictEqual(ring!.getAttribute('data-ring-pct'), '0');
        });

        test('renders a 0% ring fill rather than crashing when costPercent is undefined', () => {
            const plan = makePlan([
                makeNode({ id: '1', costPercent: undefined }),
                makeNode({ id: '2', costPercent: 5 })
            ]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            const ring = doc.querySelectorAll('.hnode-ring')[0];
            assert.strictEqual(ring!.getAttribute('data-ring-pct'), '0');
        });

        test('the hot node\'s ring color is carried as data-ring-color, not an inline style', () => {
            const plan = makePlan([makeNode({ id: '1', costPercent: 50 })]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            const ring = doc.querySelector('.hnode-ring')!;
            assert.strictEqual(ring.getAttribute('data-ring-color'), '--vscode-charts-red');
        });
    });

    suite('the single highest-cost node', () => {
        test('gets the hnode-hot class and nothing else does', () => {
            const plan = makePlan([
                makeNode({ id: '1', operatorLabel: 'A', costPercent: 10 }),
                makeNode({ id: '2', operatorLabel: 'B', costPercent: 62 }),
                makeNode({ id: '3', operatorLabel: 'C', costPercent: 30 })
            ]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            const hotNodes = doc.querySelectorAll('.hnode-hot');
            assert.strictEqual(hotNodes.length, 1);
            assert.strictEqual(hotNodes[0].querySelector('.hnode-name')!.textContent, 'B');
        });

        test('no node is marked hot when every costPercent is undefined', () => {
            const plan = makePlan([
                makeNode({ id: '1', costPercent: undefined }),
                makeNode({ id: '2', costPercent: undefined })
            ]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            assert.strictEqual(doc.querySelectorAll('.hnode-hot').length, 0);
        });
    });

    suite('connectors between nodes', () => {
        test('labels the connector with the preceding node\'s real rowsOut', () => {
            const plan = makePlan([
                makeNode({ id: '1', rowsOut: 17200 }),
                makeNode({ id: '2', rowsOut: 500 })
            ]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            const label = doc.querySelector('.hconn-label');
            assert.ok(label);
            assert.ok(label!.textContent!.includes('17.2k'));
        });

        test('omits the connector label (but keeps the connector line) when rowsOut is undefined', () => {
            const plan = makePlan([
                makeNode({ id: '1', rowsOut: undefined }),
                makeNode({ id: '2', rowsOut: 500 })
            ]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            assert.strictEqual(doc.querySelector('.hconn-label'), null);
            assert.ok(doc.querySelector('.hconn'));
        });

        test('pluralizes "row" correctly: singular for exactly 1, plural otherwise (finding 6)', () => {
            // Prefixed with the default left-to-right arrow (finding 21) —
            // see the "direction arrows" suite below for the reversed-row case.
            const singular = parseDom(buildPlanContentHtml(
                makePlan([makeNode({ id: '1', rowsOut: 1 }), makeNode({ id: '2' })]), 'n0nce'
            ));
            assert.strictEqual(singular.querySelector('.hconn-label')!.textContent, '→ 1 row');

            const plural = parseDom(buildPlanContentHtml(
                makePlan([makeNode({ id: '1', rowsOut: 0 }), makeNode({ id: '2' })]), 'n0nce'
            ));
            assert.strictEqual(plural.querySelector('.hconn-label')!.textContent, '→ 0 rows');

            const many = parseDom(buildPlanContentHtml(
                makePlan([makeNode({ id: '1', rowsOut: 500 }), makeNode({ id: '2' })]), 'n0nce'
            ));
            assert.strictEqual(many.querySelector('.hconn-label')!.textContent, '→ 500 rows');
        });

        test('the connector pill carries a direction arrow (finding 21)', () => {
            const plan = makePlan([makeNode({ id: '1', rowsOut: 250 }), makeNode({ id: '2' })]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            assert.strictEqual(doc.querySelector('.hconn-label')!.textContent, '→ 250 rows');
        });

        test('renders exactly nodeCount - 1 connectors', () => {
            const plan = makePlan([makeNode({ id: '1' }), makeNode({ id: '2' }), makeNode({ id: '3' })]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            assert.strictEqual(doc.querySelectorAll('.hconn').length, 2);
        });

        test('groups each connector with its destination node in one .hstep, so the pair wraps together', () => {
            // If the flow wraps onto a new row, a bare connector left as a
            // standalone flex item could stay on the end of one row while
            // the node it points to wraps to the next — an arrow pointing at
            // nothing. Grouping them in one non-splitting flex item prevents
            // that.
            const plan = makePlan([makeNode({ id: '1' }), makeNode({ id: '2', operatorLabel: 'JOIN' })]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            const step = doc.querySelector('.hstep');
            assert.ok(step, 'expected the second node to be wrapped in .hstep together with its connector');
            assert.ok(step!.querySelector('.hconn'), '.hstep must contain the connector');
            assert.ok(step!.querySelector('.hnode'), '.hstep must contain the destination node');
            assert.strictEqual(step!.querySelector('.hnode-name')!.textContent, 'JOIN');
        });

        test('the first node is never wrapped in .hstep — it has no incoming connector', () => {
            const plan = makePlan([makeNode({ id: '1' })]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            assert.strictEqual(doc.querySelector('.hstep'), null);
            assert.ok(doc.querySelector('.hnode'));
        });
    });

    suite('node caption sub-line', () => {
        suite('middle truncation of a long object caption (finding 19)', () => {
            test('middle-truncates a long name, keeping the distinguishing tail rather than the leading half', () => {
                const plan = makePlan([makeNode({ objectSchema: 'SYS', objectName: 'EXA_SESSION_ROLES' })]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                const subs = Array.from(doc.querySelectorAll('.hnode-sub')).map(el => el.textContent);
                assert.ok(subs.includes('SYS.EXA_…ION_ROLES'), `expected the middle-truncated caption, got: ${JSON.stringify(subs)}`);
            });

            test('leaves a short name untouched', () => {
                const plan = makePlan([makeNode({ objectSchema: 'S', objectName: 'T' })]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                const subs = Array.from(doc.querySelectorAll('.hnode-sub')).map(el => el.textContent);
                assert.ok(subs.includes('S.T'));
            });

            test('the popover shows the full, untruncated object name', () => {
                const plan = makePlan([makeNode({ objectSchema: 'SYS', objectName: 'EXA_SESSION_ROLES' })]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                assert.ok(doc.querySelector('.plan-popover')!.textContent!.includes('SYS.EXA_SESSION_ROLES'));
            });

            test('does not truncate the duration sub-line, only the object caption', () => {
                const plan = makePlan([makeNode({ duration: 123.456, objectSchema: undefined, objectName: undefined })]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                const subs = Array.from(doc.querySelectorAll('.hnode-sub')).map(el => el.textContent);
                assert.ok(!subs.some(s => s && s.includes('…')), 'the duration line must never be middle-truncated');
            });
        });

        suite('temp-table dimming (finding 20)', () => {
            test('dims the object caption when partInfo mentions a TEMPORARY table', () => {
                const plan = makePlan([makeNode({
                    objectSchema: undefined, objectName: 'tmp_subselect3', partInfo: 'result of a JOIN on TEMPORARY table'
                })]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                const objectSub = Array.from(doc.querySelectorAll('.hnode-sub')).find(el => el.textContent === 'tmp_subselect3');
                assert.ok(objectSub, 'expected the object caption to render');
                assert.ok(objectSub!.classList.contains('hnode-sub-temp'));
            });

            test('the check is case-insensitive', () => {
                const plan = makePlan([makeNode({ objectName: 'tmp_x', partInfo: 'on temporary table' })]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                const objectSub = Array.from(doc.querySelectorAll('.hnode-sub')).find(el => el.textContent === 'tmp_x');
                assert.ok(objectSub!.classList.contains('hnode-sub-temp'));
            });

            test('does not dim a plain (non-temporary) object caption', () => {
                const plan = makePlan([makeNode({ objectName: 'REAL_TABLE', partInfo: 'a regular scan' })]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                const objectSub = Array.from(doc.querySelectorAll('.hnode-sub')).find(el => el.textContent === 'REAL_TABLE');
                assert.strictEqual(objectSub!.classList.contains('hnode-sub-temp'), false);
            });

            test('does not dim the duration sub-line even on a temp-table node', () => {
                const plan = makePlan([makeNode({ duration: 0.01, objectName: 'tmp_x', partInfo: 'on TEMPORARY table' })]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                const durationSub = Array.from(doc.querySelectorAll('.hnode-sub')).find(el => el.textContent === '10.0 ms');
                assert.ok(durationSub);
                assert.strictEqual(durationSub!.classList.contains('hnode-sub-temp'), false);
            });
        });
    });

    suite('nodes are real, accessible buttons', () => {
        test('each node is a real <button>, not a div with a click handler bolted on', () => {
            const plan = makePlan([makeNode()]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            assert.strictEqual(doc.querySelector('.hnode')!.tagName, 'BUTTON');
        });

        test('the popover is a sibling of the button, not nested inside it', () => {
            const plan = makePlan([makeNode()]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            const button = doc.querySelector('.hnode')!;
            assert.strictEqual(button.querySelector('[data-popover]'), null, 'the popover must not be a descendant of the button');
            assert.ok(button.parentElement!.querySelector('[data-popover]'), 'the popover must be a sibling in the same wrapper');
        });

        test('the aria-label names the operator, its type, cost share, and warning count', () => {
            const plan = makePlan([makeNode({
                operatorLabel: 'PIPE AGGREGATOR',
                operatorType: 'GROUP_BY',
                costPercent: 43,
                warnings: [{ type: 'SPILLED_TO_DISK', message: 'x', detail: {} }]
            })]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            const label = doc.querySelector('.hnode')!.getAttribute('aria-label')!;
            assert.ok(label.includes('PIPE AGGREGATOR'));
            assert.ok(label.toLowerCase().includes('group by'));
            assert.ok(label.includes('43%'));
            assert.ok(label.includes('1 warning'));
        });

        test('the aria-label omits the warning clause entirely when there are none', () => {
            const plan = makePlan([makeNode({ warnings: [] })]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            const label = doc.querySelector('.hnode')!.getAttribute('aria-label')!;
            assert.ok(!label.includes('warning'));
        });

        test('starts with aria-expanded="false" (popover not yet open)', () => {
            const plan = makePlan([makeNode()]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            assert.strictEqual(doc.querySelector('.hnode')!.getAttribute('aria-expanded'), 'false');
        });

        test('a malicious operator label cannot break out of the aria-label attribute', () => {
            const evil = '"><script>alert(1)</script>';
            const plan = makePlan([makeNode({ operatorLabel: evil })]);
            const html = buildPlanContentHtml(plan, 'n0nce');
            assert.ok(!html.includes('<script>alert(1)</script>'));
        });

        test('focusing a node and pressing Enter opens its popover, same as a click (real script execution)', () => {
            const plan = makePlan([makeNode({ id: '1' })]);
            const dom = buildInteractiveDom(plan);
            const node = dom.window.document.querySelector('.hnode')!;
            const pop = popoverFor(dom, node);
            assert.strictEqual(pop.hidden, true);

            keydown(dom, node, 'Enter');
            assert.strictEqual(pop.hidden, false, 'Enter must activate the node exactly like a click');
            assert.strictEqual(node.getAttribute('aria-expanded'), 'true');
        });

        test('pressing Space also opens it, and the keydown is prevented (so the panel does not scroll)', () => {
            const plan = makePlan([makeNode({ id: '1' })]);
            const dom = buildInteractiveDom(plan);
            const node = dom.window.document.querySelector('.hnode')!;
            const pop = popoverFor(dom, node);

            const event = new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
            node.dispatchEvent(event);
            assert.strictEqual(pop.hidden, false);
            assert.strictEqual(event.defaultPrevented, true, 'Space must be preventDefault-ed so it never also scrolls the panel');
        });

        test('an unrelated key (e.g. Tab) does not open the popover', () => {
            const plan = makePlan([makeNode({ id: '1' })]);
            const dom = buildInteractiveDom(plan);
            const node = dom.window.document.querySelector('.hnode')!;
            const pop = popoverFor(dom, node);

            keydown(dom, node, 'Tab');
            assert.strictEqual(pop.hidden, true);
        });
    });

    suite('hover peek title and arrow-key navigation (finding 9)', () => {
        test('the button carries a one-line title of duration, cost share, and warning count', () => {
            const plan = makePlan([makeNode({
                duration: 0.123, costPercent: 52,
                warnings: [
                    { type: 'SPILLED_TO_DISK', message: 'a', detail: {} },
                    { type: 'HIGH_SKEW', message: 'b', detail: {} }
                ]
            })]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            assert.strictEqual(doc.querySelector('.hnode')!.getAttribute('title'), '123 ms · 52% · 2 warnings');
        });

        test('omits whichever parts are undefined, joining only what is actually known', () => {
            const plan = makePlan([makeNode({ duration: undefined, costPercent: 52, warnings: [] })]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            assert.strictEqual(doc.querySelector('.hnode')!.getAttribute('title'), '52%');
        });

        test('omits the title attribute entirely when nothing is known at all', () => {
            const plan = makePlan([makeNode({ duration: undefined, costPercent: undefined, warnings: [] })]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            assert.strictEqual(doc.querySelector('.hnode')!.hasAttribute('title'), false);
        });

        test('the ring keeps its own operator-type title, distinct from the button\'s hover-peek title (finding 5 vs finding 9)', () => {
            const plan = makePlan([makeNode({ operatorType: 'JOIN', duration: 0.01, costPercent: 10 })]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            assert.strictEqual(doc.querySelector('.hnode-ring')!.getAttribute('title'), 'Join');
            assert.notStrictEqual(doc.querySelector('.hnode')!.getAttribute('title'), 'Join');
        });

        test('ArrowRight moves focus to the next node button in DOM order (real script execution)', () => {
            const plan = makePlan([
                makeNode({ id: '1' }), makeNode({ id: '2' }), makeNode({ id: '3' })
            ]);
            const dom = buildInteractiveDom(plan);
            const nodes = Array.from(dom.window.document.querySelectorAll('[data-node-toggle]')) as HTMLElement[];
            nodes[0].focus();
            assert.strictEqual(dom.window.document.activeElement, nodes[0]);

            keydown(dom, nodes[0], 'ArrowRight');
            assert.strictEqual(dom.window.document.activeElement, nodes[1], 'ArrowRight must move focus to the next node');
        });

        test('ArrowLeft moves focus to the previous node button', () => {
            const plan = makePlan([makeNode({ id: '1' }), makeNode({ id: '2' })]);
            const dom = buildInteractiveDom(plan);
            const nodes = Array.from(dom.window.document.querySelectorAll('[data-node-toggle]')) as HTMLElement[];
            nodes[1].focus();

            keydown(dom, nodes[1], 'ArrowLeft');
            assert.strictEqual(dom.window.document.activeElement, nodes[0]);
        });

        test('ArrowRight on the last node does nothing (no wraparound, no error)', () => {
            const plan = makePlan([makeNode({ id: '1' }), makeNode({ id: '2' })]);
            const dom = buildInteractiveDom(plan);
            const nodes = Array.from(dom.window.document.querySelectorAll('[data-node-toggle]')) as HTMLElement[];
            nodes[1].focus();

            keydown(dom, nodes[1], 'ArrowRight');
            assert.strictEqual(dom.window.document.activeElement, nodes[1], 'focus must stay put at the last node');
        });

        test('ArrowLeft on the first node does nothing', () => {
            const plan = makePlan([makeNode({ id: '1' }), makeNode({ id: '2' })]);
            const dom = buildInteractiveDom(plan);
            const nodes = Array.from(dom.window.document.querySelectorAll('[data-node-toggle]')) as HTMLElement[];
            nodes[0].focus();

            keydown(dom, nodes[0], 'ArrowLeft');
            assert.strictEqual(dom.window.document.activeElement, nodes[0]);
        });

        test('the arrow-key handler prevents default, so it never also scrolls the panel', () => {
            const plan = makePlan([makeNode({ id: '1' }), makeNode({ id: '2' })]);
            const dom = buildInteractiveDom(plan);
            const node = dom.window.document.querySelector('[data-node-toggle]')!;
            const event = new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
            node.dispatchEvent(event);
            assert.strictEqual(event.defaultPrevented, true);
        });
    });

    suite('warning badge', () => {
        test('shows the warning badge on a node with warnings', () => {
            const plan = makePlan([makeNode({
                warnings: [{ type: 'SPILLED_TO_DISK', message: 'spilled', detail: {} }]
            })]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            assert.ok(doc.querySelector('.hnode-warn'));
        });

        test('omits the warning badge on a node with no warnings', () => {
            const plan = makePlan([makeNode({ warnings: [] })]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            assert.strictEqual(doc.querySelector('.hnode-warn'), null);
        });

        test('the warning badge title lists a short label per warning, and is hidden from assistive tech (folded into the button\'s own aria-label instead)', () => {
            const plan = makePlan([makeNode({
                warnings: [
                    { type: 'SPILLED_TO_DISK', message: 'Wrote 10 MiB', detail: {} },
                    { type: 'LARGE_REDISTRIBUTION', message: 'Moved 500 MiB', detail: {} }
                ]
            })]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            const badge = doc.querySelector('.hnode-warn')!;
            assert.strictEqual(badge.getAttribute('title'), 'spilled to disk, large redistribution');
            assert.strictEqual(badge.getAttribute('aria-hidden'), 'true');
        });

        test('the popover lists the full (escaped) warning message for each warning', () => {
            const plan = makePlan([makeNode({
                warnings: [{ type: 'SPILLED_TO_DISK', message: 'Wrote 10 MiB <evil>', detail: {} }]
            })]);
            const html = buildPlanContentHtml(plan, 'n0nce');
            const doc = parseDom(html);
            assert.ok(doc.querySelector('.plan-popover')!.textContent!.includes('Wrote 10 MiB'));
            assert.ok(!html.includes('<evil>'));
        });
    });

    suite('the popover itself', () => {
        test('every node has a corresponding hidden popover', () => {
            const plan = makePlan([makeNode({ id: '7' })]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            const pop = doc.querySelector('.plan-popover');
            assert.ok(pop);
            assert.strictEqual(pop!.hasAttribute('hidden'), true);
        });

        test('the stylesheet actually hides [hidden], not just sets the attribute', () => {
            const css = buildPlanContentCss();
            assert.ok(
                /\.plan-popover\[hidden\]\s*\{[^}]*display:\s*none/.test(css),
                'expected an explicit .plan-popover[hidden] { display: none } override in the stylesheet'
            );
        });

        test('is titled with the operator (and object, when present)', () => {
            // A zero-width space follows the '.' between schema and object
            // (finding E, break opportunities) — invisible, but present in
            // textContent, so the exact string includes it.
            const withObject = parseDom(buildPlanContentHtml(
                makePlan([makeNode({ operatorLabel: 'PIPE SCAN', objectSchema: 'S', objectName: 'T' })]), 'n0nce'
            ));
            assert.strictEqual(withObject.querySelector('.plan-popover-title')!.textContent, 'PIPE SCAN — S.​T');

            const withoutObject = parseDom(buildPlanContentHtml(makePlan([makeNode({ operatorLabel: 'COMPILE', objectName: undefined })]), 'n0nce'));
            assert.strictEqual(withoutObject.querySelector('.plan-popover-title')!.textContent, 'COMPILE');
        });

        suite('title break opportunities (finding E)', () => {
            test('inserts a zero-width space after every "." and "_" so a long qualified name breaks at a natural boundary', () => {
                const plan = makePlan([makeNode({
                    operatorLabel: 'PIPE SCAN', objectSchema: 'SNAP_SALESFORCE', objectName: 'CONTRACT_DOCUMENTS'
                })]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                const title = doc.querySelector('.plan-popover-title')!.textContent;
                assert.strictEqual(title, 'PIPE SCAN — SNAP_​SALESFORCE.​CONTRACT_​DOCUMENTS');
            });

            test('a title with neither "." nor "_" is left untouched', () => {
                const plan = makePlan([makeNode({ operatorLabel: 'COMPILE', objectName: undefined })]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                assert.strictEqual(doc.querySelector('.plan-popover-title')!.textContent, 'COMPILE');
            });

            test('the break-opportunity character never breaks out of the escaped markup (applied after escapeHtml, not before)', () => {
                const evil = '"><script>alert(1)</script>';
                const plan = makePlan([makeNode({ operatorLabel: evil })]);
                const html = buildPlanContentHtml(plan, 'n0nce');
                assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag must never appear');
            });
        });

        test('lists key fields not shown on the node face', () => {
            const plan = makePlan([makeNode({ id: '42', cpu: 77.5 })]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            const detailText = doc.querySelector('.plan-popover')!.textContent!;
            assert.ok(detailText.includes('42'));
            assert.ok(detailText.includes('77.5'));
        });

        test('the per-node rows value is self-describing (min/max/avg/nodes labeled inline), matching the copy-as-text format', () => {
            const plan = makePlan([makeNode({ perNodeStats: { metric: 'rows', min: 100, max: 900, avg: 500, nodeCount: 4 } })]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            const detailText = doc.querySelector('.plan-popover')!.textContent!;
            assert.ok(detailText.includes('min 100 / max 900 / avg 500 / nodes 4'));
        });

        test('labels the share row "Duration share", not "Cost share" (finding 12)', () => {
            const plan = makePlan([makeNode({ costPercent: 33 })]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            const labels = Array.from(doc.querySelectorAll('.plan-detail-k')).map(el => el.textContent);
            assert.ok(labels.some(l => l && l.startsWith('Duration share')));
            assert.ok(!labels.includes('Cost share'));
        });

        suite('duration-share denominator suffix (finding B)', () => {
            test('a non-system node is labeled "Duration share (of query)"', () => {
                const plan = makePlan([makeNode({ costPercent: 45, traits: { ...PASSTHROUGH_TRAITS, isSystemStep: false } })]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                const labels = Array.from(doc.querySelectorAll('.plan-detail-k')).map(el => el.textContent);
                assert.ok(labels.includes('Duration share (of query)'));
            });

            test('a system-step node is labeled "Duration share (of total)"', () => {
                const plan = makePlan([makeNode({ costPercent: 31, traits: { ...PASSTHROUGH_TRAITS, isSystemStep: true } })]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                const labels = Array.from(doc.querySelectorAll('.plan-detail-k')).map(el => el.textContent);
                assert.ok(labels.includes('Duration share (of total)'));
                assert.ok(!labels.includes('Duration share (of query)'));
            });
        });

        test('labels CPU as "CPU (max node)" (finding 24)', () => {
            const plan = makePlan([makeNode({ cpu: 50 })]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            const labels = Array.from(doc.querySelectorAll('.plan-detail-k')).map(el => el.textContent);
            assert.ok(labels.includes('CPU (max node)'));
            assert.ok(!labels.includes('CPU'));
        });

        test('orders metrics first, then Part info/Remarks, then the remaining identity fields last (finding 17, finding D)', () => {
            // D: Part info/Remarks moved up to directly after the metrics
            // block (scan popovers carry filter columns in Remarks — worth
            // a glance without scrolling past Part id/Operator/Object/Traits
            // first).
            const plan = makePlan([makeNode({
                duration: 1, costPercent: 50, cpu: 50, rowsOut: 100,
                objectSchema: 'S', objectName: 'T', partInfo: 'info', remarks: 'remark'
            })]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            const labels = Array.from(doc.querySelectorAll('.plan-detail-k')).map(el => el.textContent);

            const indexOf = (label: string): number => labels.indexOf(label);
            assert.strictEqual(indexOf('Duration'), 0, 'Duration must be the first detail row');
            assert.ok(indexOf('Duration share (of query)') < indexOf('CPU (max node)'));
            assert.ok(indexOf('CPU (max node)') < indexOf('Rows out'));
            assert.ok(indexOf('Rows out') < indexOf('Part info'), 'metrics must all precede Part info/Remarks');
            assert.ok(indexOf('Part info') < indexOf('Remarks'));
            assert.ok(indexOf('Remarks') < indexOf('Part id'), 'Part info/Remarks must come before the remaining identity fields');
            assert.ok(indexOf('Part id') < indexOf('Object'));
            assert.ok(indexOf('Object') < indexOf('Traits'), 'Traits comes last');
        });

        suite('numeric metric rows always show a dash instead of vanishing (finding 23)', () => {
            test('Rows out shows "—" when undefined, rather than disappearing', () => {
                const plan = makePlan([makeNode({ rowsOut: undefined })]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                const row = Array.from(doc.querySelectorAll('.plan-detail-row')).find(
                    el => el.querySelector('.plan-detail-k')!.textContent === 'Rows out'
                );
                assert.ok(row, 'the Rows out row must still render when the value is undefined');
                assert.strictEqual(row!.querySelector('.plan-detail-v')!.textContent, '—');
            });

            test('CPU (max node) shows "—" when undefined', () => {
                const plan = makePlan([makeNode({ cpu: undefined })]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                const row = Array.from(doc.querySelectorAll('.plan-detail-row')).find(
                    el => el.querySelector('.plan-detail-k')!.textContent === 'CPU (max node)'
                );
                assert.ok(row);
                assert.strictEqual(row!.querySelector('.plan-detail-v')!.textContent, '—');
            });

            test('Temp DB RAM peak shows "—" when undefined', () => {
                const plan = makePlan([makeNode({ tempDbRamPeak: undefined })]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                const row = Array.from(doc.querySelectorAll('.plan-detail-row')).find(
                    el => el.querySelector('.plan-detail-k')!.textContent === 'Temp DB RAM peak'
                );
                assert.ok(row);
                assert.strictEqual(row!.querySelector('.plan-detail-v')!.textContent, '—');
            });

            test('identity/text fields (Object, Part info, Remarks) still omit entirely when absent — not numeric metrics', () => {
                const plan = makePlan([makeNode({ objectName: undefined, partInfo: undefined, remarks: undefined })]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                const labels = Array.from(doc.querySelectorAll('.plan-detail-k')).map(el => el.textContent);
                assert.ok(!labels.includes('Object'));
                assert.ok(!labels.includes('Part info'));
                assert.ok(!labels.includes('Remarks'));
            });
        });

        suite('scan selectivity (finding 3)', () => {
            test('shows "Scanned: N rows -> M (P%)" when both objectRows and rowsOut are defined', () => {
                const plan = makePlan([makeNode({ objectRows: 10000, rowsOut: 250 })]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                const row = Array.from(doc.querySelectorAll('.plan-detail-row')).find(
                    el => el.querySelector('.plan-detail-k')!.textContent === 'Scanned'
                );
                assert.ok(row);
                assert.strictEqual(row!.querySelector('.plan-detail-v')!.textContent, '10,000 rows → 250 (2.5%)');
            });

            test('omits the Scanned row when objectRows is undefined', () => {
                const plan = makePlan([makeNode({ objectRows: undefined, rowsOut: 250 })]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                const labels = Array.from(doc.querySelectorAll('.plan-detail-k')).map(el => el.textContent);
                assert.ok(!labels.includes('Scanned'));
            });

            test('omits the Scanned row when objectRows is zero (guards the division)', () => {
                const plan = makePlan([makeNode({ objectRows: 0, rowsOut: 0 })]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                const labels = Array.from(doc.querySelectorAll('.plan-detail-k')).map(el => el.textContent);
                assert.ok(!labels.includes('Scanned'));
            });

            test('shows the raw row counts but omits the percentage when rowsOut exceeds objectRows (inconsistent data, not >100% selectivity)', () => {
                const plan = makePlan([makeNode({ objectRows: 1594, rowsOut: 6314 })]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                const row = Array.from(doc.querySelectorAll('.plan-detail-row')).find(
                    el => el.querySelector('.plan-detail-k')!.textContent === 'Scanned'
                );
                assert.ok(row, 'the row counts must still be shown');
                const value = row!.querySelector('.plan-detail-v')!.textContent;
                assert.strictEqual(value, '1,594 rows → 6,314');
                assert.ok(!value!.includes('%'), 'must never render a >100% selectivity percentage');
            });
        });

        suite('HDD read (finding 7)', () => {
            test('shows "HDD read: N MiB/s" only when greater than zero', () => {
                const plan = makePlan([makeNode({ hddRead: 3.2 })]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                const row = Array.from(doc.querySelectorAll('.plan-detail-row')).find(
                    el => el.querySelector('.plan-detail-k')!.textContent === 'HDD read'
                );
                assert.ok(row);
                assert.strictEqual(row!.querySelector('.plan-detail-v')!.textContent, '3.2 MiB/s');
            });

            test('omits the row when HDD read is zero', () => {
                const plan = makePlan([makeNode({ hddRead: 0 })]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                const labels = Array.from(doc.querySelectorAll('.plan-detail-k')).map(el => el.textContent);
                assert.ok(!labels.includes('HDD read'));
            });

            test('omits the row when HDD read is undefined', () => {
                const plan = makePlan([makeNode({ hddRead: undefined })]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                const labels = Array.from(doc.querySelectorAll('.plan-detail-k')).map(el => el.textContent);
                assert.ok(!labels.includes('HDD read'));
            });
        });

        suite('per-node durations (finding 4)', () => {
            test('shows the min/max/avg/nodes breakdown when present', () => {
                const plan = makePlan([makeNode({
                    perNodeDurationStats: { metric: 'duration', min: 0.01, max: 0.34, avg: 0.12, nodeCount: 4 }
                })]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                const row = Array.from(doc.querySelectorAll('.plan-detail-row')).find(
                    el => el.querySelector('.plan-detail-k')!.textContent === 'Per-node durations'
                );
                assert.ok(row);
                assert.strictEqual(row!.querySelector('.plan-detail-v')!.textContent, 'min 10.0 ms / max 340 ms / avg 120 ms / nodes 4');
            });

            test('omits the row entirely when perNodeDurationStats is undefined (unlike per-node rows, which shows "not available")', () => {
                const plan = makePlan([makeNode({ perNodeDurationStats: undefined })]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                const labels = Array.from(doc.querySelectorAll('.plan-detail-k')).map(el => el.textContent);
                assert.ok(!labels.includes('Per-node durations'));
            });

            suite('1ms noise floor (finding C)', () => {
                test('shows the row when the slowest node is exactly at the 1ms floor', () => {
                    const plan = makePlan([makeNode({
                        perNodeDurationStats: { metric: 'duration', min: 0.0001, max: 0.001, avg: 0.0005, nodeCount: 4 }
                    })]);
                    const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                    const labels = Array.from(doc.querySelectorAll('.plan-detail-k')).map(el => el.textContent);
                    assert.ok(labels.includes('Per-node durations'), 'a 1ms max meets the floor and must render');
                });

                test('omits the row when the slowest node is just under the 1ms floor', () => {
                    const plan = makePlan([makeNode({
                        perNodeDurationStats: { metric: 'duration', min: 0.0001, max: 0.0009, avg: 0.0005, nodeCount: 4 }
                    })]);
                    const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                    const labels = Array.from(doc.querySelectorAll('.plan-detail-k')).map(el => el.textContent);
                    assert.ok(!labels.includes('Per-node durations'), 'a 0.9ms max is below the floor and must be treated as measurement noise');
                });

                test('per-node ROWS behavior is unaffected by the duration floor', () => {
                    const plan = makePlan([makeNode({
                        perNodeStats: { metric: 'rows', min: 1, max: 2, avg: 1.5, nodeCount: 4 },
                        perNodeDurationStats: { metric: 'duration', min: 0.0001, max: 0.0009, avg: 0.0005, nodeCount: 4 }
                    })]);
                    const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                    const labels = Array.from(doc.querySelectorAll('.plan-detail-k')).map(el => el.textContent);
                    assert.ok(labels.includes('Per-node rows'), 'the rows line must still render regardless of the duration floor');
                    assert.ok(!labels.includes('Per-node durations'));
                });
            });
        });

        test('a long "not available" per-node-rows value wraps at word boundaries, not mid-word', () => {
            // Regression test for a real screenshot: label-beside-value with
            // word-break: break-word chopped "not available" into
            // "not avai / labl / e" to fit a squeezed value column. The row
            // must now stack label above value with overflow-wrap instead.
            const css = buildPlanContentCss();
            assert.ok(
                /\.plan-detail-row\s*\{[^}]*flex-direction:\s*column/.test(css),
                'expected .plan-detail-row to stack label above value, not squeeze them side by side'
            );
            assert.ok(
                !/\.plan-detail-v\s*\{[^}]*word-break:\s*break-word/.test(css),
                'word-break: break-word chops words mid-character to fit a narrow column — overflow-wrap: break-word (word-boundary-first) is the fix, not this'
            );
        });

        test('the script carries the provided nonce', () => {
            const plan = makePlan([makeNode()]);
            const html = buildPlanContentHtml(plan, 'my-nonce-value');
            assert.ok(html.includes('nonce="my-nonce-value"'));
        });

        suite('per-node copy (finding 11)', () => {
            test('renders a copy button in the popover title row', () => {
                const plan = makePlan([makeNode({ id: '1' })]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                const btn = doc.querySelector('.plan-node-copy');
                assert.ok(btn, 'expected a per-node copy button');
                assert.strictEqual(btn!.tagName, 'BUTTON');
                assert.strictEqual(btn!.getAttribute('data-copy-node'), '1');
                assert.ok(doc.querySelector('.plan-popover-title-row')!.contains(btn));
            });

            test('the button does not leak into the popover title\'s own text content', () => {
                const plan = makePlan([makeNode({ operatorLabel: 'PIPE SCAN' })]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                assert.strictEqual(doc.querySelector('.plan-popover-title')!.textContent, 'PIPE SCAN');
            });

            test('embeds this node\'s exact operatorBlock() text in a hidden sibling textarea', () => {
                const plan = makePlan([makeNode({ id: '3', operatorLabel: 'PIPE SCAN', duration: 0.05, costPercent: 20 })]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                const textarea = doc.querySelector('.plan-node-copy-data') as HTMLTextAreaElement;
                assert.ok(textarea);
                assert.strictEqual(textarea.hasAttribute('hidden'), true);
                assert.ok(textarea.value.includes('PIPE SCAN [part 3]'));
                assert.ok(textarea.value.includes('Duration: 50.0 ms'));
            });

            test('a multi-node plan\'s per-node text matches the numbering of the full "Copy as text" export', () => {
                const plan = makePlan([
                    makeNode({ id: '1', operatorLabel: 'SCAN' }),
                    makeNode({ id: '2', operatorLabel: 'JOIN' })
                ]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                const textareas = Array.from(doc.querySelectorAll('.plan-node-copy-data')) as HTMLTextAreaElement[];
                assert.ok(textareas[0].value.startsWith('1. SCAN [part 1]'));
                assert.ok(textareas[1].value.startsWith('2. JOIN [part 2]'));
            });

            test('escapes a malicious value inside the embedded per-node textarea', () => {
                const evil = '</textarea><script>alert(1)</script>';
                const plan = makePlan([makeNode({ remarks: evil })]);
                const html = buildPlanContentHtml(plan, 'n0nce');
                assert.ok(!html.includes('</textarea><script>alert(1)</script>'), 'raw markup must never appear unescaped');
            });

            test('clicking the copy button posts a copyPlanText message with this node\'s text (real script execution)', () => {
                const plan = makePlan([
                    makeNode({ id: '1', operatorLabel: 'SCAN' }),
                    makeNode({ id: '2', operatorLabel: 'JOIN' })
                ]);
                const dom = buildInteractiveDom(plan);
                const doc = dom.window.document;
                const posted: Array<{ command: string; text: string }> = [];
                (dom.window as unknown as { __vscode: { postMessage: (m: { command: string; text: string }) => void } }).__vscode = {
                    postMessage: (m) => posted.push(m)
                };

                const node2Popover = doc.querySelector('.hnode[data-node-id="2"]')!.parentElement!.querySelector('[data-popover]')!;
                const copyBtn = node2Popover.querySelector('.plan-node-copy')!;
                click(dom, copyBtn);

                assert.strictEqual(posted.length, 1);
                assert.strictEqual(posted[0].command, 'copyPlanText');
                assert.ok(posted[0].text.startsWith('2. JOIN [part 2]'), `expected node 2's own block, got: ${posted[0].text}`);
            });

            test('clicking the copy button does not close the popover (stopPropagation)', () => {
                const plan = makePlan([makeNode({ id: '1' })]);
                const dom = buildInteractiveDom(plan);
                const doc = dom.window.document;
                const node = doc.querySelector('.hnode')!;
                const pop = popoverFor(dom, node);

                click(dom, node);
                assert.strictEqual(pop.hidden, false, 'precondition: popover open');

                const copyBtn = pop.querySelector('.plan-node-copy')!;
                click(dom, copyBtn);
                assert.strictEqual(pop.hidden, false, 'clicking the copy button must not close its own popover');
            });
        });
    });

    suite('popover open/close behavior (real script execution, not just text matching)', () => {
        test('clicking a node opens its popover', () => {
            const plan = makePlan([makeNode({ id: '1' }), makeNode({ id: '2' })]);
            const dom = buildInteractiveDom(plan);
            const node = dom.window.document.querySelectorAll('.hnode')[0];
            const pop = popoverFor(dom, node);
            assert.strictEqual(pop.hidden, true);

            click(dom, node);
            assert.strictEqual(pop.hidden, false);
        });

        test('clicking inside an open popover does not close it', () => {
            const plan = makePlan([makeNode({ id: '1' })]);
            const dom = buildInteractiveDom(plan);
            const node = dom.window.document.querySelector('.hnode')!;
            const pop = popoverFor(dom, node);

            click(dom, node);
            assert.strictEqual(pop.hidden, false, 'precondition: popover should be open');

            const innerRow = pop.querySelector('.plan-detail-row')!;
            click(dom, innerRow);
            assert.strictEqual(pop.hidden, false, 'a click inside the popover must not close it');
        });

        test('clicking outside any node closes an open popover', () => {
            const plan = makePlan([makeNode({ id: '1' })]);
            const dom = buildInteractiveDom(plan);
            const node = dom.window.document.querySelector('.hnode')!;
            const pop = popoverFor(dom, node);

            click(dom, node);
            assert.strictEqual(pop.hidden, false);

            click(dom, dom.window.document.body);
            assert.strictEqual(pop.hidden, true);
            assert.strictEqual(node.getAttribute('aria-expanded'), 'false');
        });

        test('pressing Escape closes an open popover', () => {
            const plan = makePlan([makeNode({ id: '1' })]);
            const dom = buildInteractiveDom(plan);
            const node = dom.window.document.querySelector('.hnode')!;
            const pop = popoverFor(dom, node);

            click(dom, node);
            assert.strictEqual(pop.hidden, false);

            keydown(dom, dom.window.document.body, 'Escape');
            assert.strictEqual(pop.hidden, true);
        });

        test('opening a second node\'s popover closes the first (accordion, not stacking)', () => {
            const plan = makePlan([makeNode({ id: '1' }), makeNode({ id: '2' })]);
            const dom = buildInteractiveDom(plan);
            const [nodeA, nodeB] = Array.from(dom.window.document.querySelectorAll('.hnode'));
            const popA = popoverFor(dom, nodeA);
            const popB = popoverFor(dom, nodeB);

            click(dom, nodeA);
            assert.strictEqual(popA.hidden, false);

            click(dom, nodeB);
            assert.strictEqual(popA.hidden, true, 'opening a second popover must close the first');
            assert.strictEqual(popB.hidden, false);
        });

        test('clicking an already-open node\'s own ring closes its popover again', () => {
            const plan = makePlan([makeNode({ id: '1' })]);
            const dom = buildInteractiveDom(plan);
            const node = dom.window.document.querySelector('.hnode')!;
            const pop = popoverFor(dom, node);

            click(dom, node);
            assert.strictEqual(pop.hidden, false);

            click(dom, node);
            assert.strictEqual(pop.hidden, true, 'clicking the same node again should toggle the popover closed');
        });
    });

    suite('popover positioning (flip-up when there is no room below)', () => {
        test('opening a popover actually runs the positioning function and mutates its style, not just text-matches the script source', () => {
            // JSDOM's getBoundingClientRect() always returns an all-zero rect
            // (no real layout engine), which deterministically drives
            // positionPopover() down its "too far left" horizontal branch —
            // so opening ANY popover here should reliably mutate
            // style.transform and set --arrow-shift, proving the function
            // actually runs.
            const plan = makePlan([makeNode({ id: '1' })]);
            const dom = buildInteractiveDom(plan);
            const node = dom.window.document.querySelector('.hnode')!;
            const pop = popoverFor(dom, node);

            assert.strictEqual(pop.style.transform, '');
            click(dom, node);
            assert.notStrictEqual(pop.style.transform, '', 'positionPopover() must actually run and set a transform on open');
            assert.ok(pop.style.getPropertyValue('--arrow-shift'), 'expected --arrow-shift to be set alongside the transform');

            click(dom, node);
            assert.strictEqual(pop.style.transform, '', 'closing the popover must reset the transform via resetPopover()');
        });

        test('the CSS defines a flip-up variant that opens above the node instead of below', () => {
            const css = buildPlanContentCss();
            assert.ok(
                /\.plan-popover\.flip-up\s*\{[^}]*bottom:\s*calc/.test(css),
                'expected .plan-popover.flip-up to anchor from the bottom (open upward) instead of the top'
            );
        });

        test('closing a flipped-up popover resets the flip-up class', () => {
            const plan = makePlan([makeNode({ id: '1' })]);
            const dom = buildInteractiveDom(plan);
            const node = dom.window.document.querySelector('.hnode')!;
            const pop = popoverFor(dom, node);

            // Force the flipped state directly (JSDOM's zero-height layout
            // never naturally triggers the "not enough room" branch), then
            // confirm the close path still clears it via resetPopover().
            pop.classList.add('flip-up');
            click(dom, node);
            click(dom, node);
            assert.strictEqual(pop.classList.contains('flip-up'), false);
        });

        // Regression coverage for a real bug caught against a real
        // screenshot: scrollArea.getBoundingClientRect() is relative to the
        // currently visible, scrolled slice of the flow, not the whole
        // thing — a node near the top of what's in view has just as little
        // room above it as below, so blindly flipping whenever "below
        // didn't fit" (the original rule) could flip a popover straight off
        // the top of the scroll container, clipped to a barely-visible
        // sliver. The fix compares both sides and only flips when doing so
        // actually helps.
        test('does not flip up merely because space below is tight — only when space above is actually greater', () => {
            const plan = makePlan([makeNode({ id: '1' })]);
            const dom = buildInteractiveDom(plan);
            const node = dom.window.document.querySelector('.hnode')!;
            const pop = popoverFor(dom, node);
            const scrollArea = dom.window.document.querySelector('.plan-flow-h')!;

            stubOffsetHeight(pop, 100);
            // Node near the top of the visible slice: only 10px above it,
            // but a healthy 570px below — below is clearly the better side,
            // even though the popover (100 + 16 gap) doesn't fully fit there.
            stubRect(node, { top: 10, bottom: 30 });
            stubRect(scrollArea, { top: 0, bottom: 600 });

            click(dom, node);
            assert.strictEqual(pop.classList.contains('flip-up'), false, 'space below (570px) is far larger than space above (10px); it must not flip');
        });

        test('flips up when space above is genuinely greater than space below', () => {
            const plan = makePlan([makeNode({ id: '1' })]);
            const dom = buildInteractiveDom(plan);
            const node = dom.window.document.querySelector('.hnode')!;
            const pop = popoverFor(dom, node);
            const scrollArea = dom.window.document.querySelector('.plan-flow-h')!;

            stubOffsetHeight(pop, 100);
            // Node near the bottom of the visible slice: plenty of room
            // above (90px), almost none below (5px) — flipping now helps.
            stubRect(node, { top: 90, bottom: 110 });
            stubRect(scrollArea, { top: 0, bottom: 115 });

            click(dom, node);
            assert.strictEqual(pop.classList.contains('flip-up'), true);
        });

        test('flips up when the popover fits fully above, even with an unremarkable margin over space below (finding 18)', () => {
            // popHeight(80) + gap(16) = 96 needed. spaceBelow (90) doesn't
            // quite fit (fitsBelow false); spaceAbove (120) fits outright
            // (fitsAbove true). Whenever a popover fits above but not below,
            // spaceAbove is necessarily also the numerically larger side
            // (see the comment above positionPopover for why those two legs
            // of the flip condition's disjunction can never actually
            // diverge) — this pins the fitsAbove-driven flip and confirms
            // it needs no height cap once it lands somewhere that fits.
            const plan = makePlan([makeNode({ id: '1' })]);
            const dom = buildInteractiveDom(plan);
            const node = dom.window.document.querySelector('.hnode')!;
            const pop = popoverFor(dom, node);
            const scrollArea = dom.window.document.querySelector('.plan-flow-h')!;

            stubOffsetHeight(pop, 80);
            stubRect(node, { top: 120, bottom: 140 });
            stubRect(scrollArea, { top: 0, bottom: 230 });

            click(dom, node);
            assert.strictEqual(pop.classList.contains('flip-up'), true);
            assert.strictEqual(pop.style.maxHeight, '', 'the popover fits fully above; no height cap should apply');
        });

        test('when neither side actually fits, the popover is capped to the room available on the side it opens on, with its own scrollbar, rather than left to be clipped by the container', () => {
            const plan = makePlan([makeNode({ id: '1' })]);
            const dom = buildInteractiveDom(plan);
            const node = dom.window.document.querySelector('.hnode')!;
            const pop = popoverFor(dom, node);
            const scrollArea = dom.window.document.querySelector('.plan-flow-h')!;

            stubOffsetHeight(pop, 200);
            // Space above (90px) is greater than space below (-15px, i.e.
            // the node is already partly below the visible area), so it
            // flips up — but 200px of popover still doesn't fit in 90px of
            // available room above.
            stubRect(node, { top: 90, bottom: 110 });
            stubRect(scrollArea, { top: 0, bottom: 95 });

            click(dom, node);
            assert.strictEqual(pop.classList.contains('flip-up'), true, 'precondition: this scenario should flip (90px above beats -15px below)');
            // Room available above is 90 - 16px gap = 74, then floored down
            // to a whole multiple of line-height (finding 15) — JSDOM has no
            // real stylesheet loaded, so getComputedStyle(pop).lineHeight
            // resolves to 'normal' here and the 16px fallback applies:
            // floor(74 / 16) * 16 = 64.
            assert.strictEqual(pop.style.maxHeight, '64px', 'expected the cap floored to a whole 16px line-height multiple, not the bare 74px available room');
            assert.strictEqual(pop.style.overflowY, 'auto', 'expected an internal scrollbar so the rest of the content stays reachable');
        });

        test('floors the height cap to a whole multiple of the popover\'s line-height, never landing mid-line (finding 15)', () => {
            // A real screenshot showed the popover's title row itself
            // half-clipped right above the scrollbar an unfloored cap
            // produced. Faking a real, non-'normal' computed line-height
            // isn't practical without loading the actual stylesheet into
            // JSDOM, so this exercises the documented 16px fallback path
            // instead of a custom line-height value — still enough to prove
            // the flooring itself actually runs, with numbers distinct from
            // the regression test above.
            const plan = makePlan([makeNode({ id: '1' })]);
            const dom = buildInteractiveDom(plan);
            const node = dom.window.document.querySelector('.hnode')!;
            const pop = popoverFor(dom, node);
            const scrollArea = dom.window.document.querySelector('.plan-flow-h')!;

            stubOffsetHeight(pop, 300);
            stubRect(node, { top: 100, bottom: 120 });
            stubRect(scrollArea, { top: 0, bottom: 110 });

            click(dom, node);
            assert.strictEqual(pop.classList.contains('flip-up'), true, 'precondition: 100px above must beat -10px below');
            // Available = 100 - 16 = 84; floor(84 / 16) * 16 = 80 — not 84,
            // proving the value was actually floored rather than passed
            // through.
            assert.strictEqual(pop.style.maxHeight, '80px');
        });

        test('does not cap the height when the popover already fits in the space it opens on', () => {
            const plan = makePlan([makeNode({ id: '1' })]);
            const dom = buildInteractiveDom(plan);
            const node = dom.window.document.querySelector('.hnode')!;
            const pop = popoverFor(dom, node);
            const scrollArea = dom.window.document.querySelector('.plan-flow-h')!;

            stubOffsetHeight(pop, 100);
            stubRect(node, { top: 10, bottom: 30 });
            stubRect(scrollArea, { top: 0, bottom: 600 });

            click(dom, node);
            assert.strictEqual(pop.style.maxHeight, '', 'plenty of room below (570px) for a 100px popover; no cap should be applied');
        });

        test('closing resets the height cap and scrollbar alongside the flip-up class', () => {
            const plan = makePlan([makeNode({ id: '1' })]);
            const dom = buildInteractiveDom(plan);
            const node = dom.window.document.querySelector('.hnode')!;
            const pop = popoverFor(dom, node);
            const scrollArea = dom.window.document.querySelector('.plan-flow-h')!;

            stubOffsetHeight(pop, 200);
            stubRect(node, { top: 90, bottom: 110 });
            stubRect(scrollArea, { top: 0, bottom: 95 });

            click(dom, node);
            assert.notStrictEqual(pop.style.maxHeight, '', 'precondition: this scenario should have capped the height');

            click(dom, node);
            assert.strictEqual(pop.style.maxHeight, '');
            assert.strictEqual(pop.style.overflowY, '');
        });
    });

    suite('snake/boustrophedon row wrap (real script execution)', () => {
        // JSDOM has no real layout engine, so offsetTop is always 0 for
        // every element by default — the initial script run therefore
        // always measures a single row (correctly: there's nothing to do
        // when nothing wrapped). To exercise the restructuring itself,
        // these tests stub offsetTop per item to simulate a real wrap, then
        // dispatch a 'resize' event — the same relayout the real script
        // runs on load also runs on resize, so this is the one hook these
        // tests need to trigger it deterministically.
        function flowItemsOf(dom: JSDOM): Element[] {
            return Array.from(dom.window.document.querySelectorAll('.hflow-track > .hnode-wrap, .hflow-track > .hstep'));
        }

        function stubRows(items: Element[], rowSizes: number[]): void {
            let idx = 0;
            rowSizes.forEach((size, rowIndex) => {
                for (let i = 0; i < size; i++) {
                    Object.defineProperty(items[idx], 'offsetTop', { value: rowIndex * 100, configurable: true });
                    idx += 1;
                }
            });
        }

        function resize(dom: JSDOM): void {
            dom.window.dispatchEvent(new dom.window.Event('resize'));
        }

        function fiveNodePlan(): Plan {
            return makePlan([
                makeNode({ id: '1', operatorLabel: 'A', rowsOut: 100 }),
                makeNode({ id: '2', operatorLabel: 'B', rowsOut: 200 }),
                makeNode({ id: '3', operatorLabel: 'C', rowsOut: 300 }),
                makeNode({ id: '4', operatorLabel: 'D', rowsOut: 400 }),
                makeNode({ id: '5', operatorLabel: 'E', rowsOut: 500 })
            ]);
        }

        test('leaves the flow exactly as rendered when everything measures on a single row', () => {
            const dom = buildInteractiveDom(fiveNodePlan());
            const track = dom.window.document.querySelector('.hflow-track')!;
            assert.strictEqual(track.querySelectorAll('.hflow-row').length, 0);
            assert.strictEqual(track.classList.contains('hflow-track-snaked'), false);
        });

        test('restructures into one .hflow-row per measured row once the flow wraps, reversing alternate rows', () => {
            const dom = buildInteractiveDom(fiveNodePlan());
            const track = dom.window.document.querySelector('.hflow-track')!;
            stubRows(flowItemsOf(dom), [2, 3]);
            resize(dom);

            assert.strictEqual(track.classList.contains('hflow-track-snaked'), true);
            const rows = track.querySelectorAll('.hflow-row');
            assert.strictEqual(rows.length, 2);
            assert.strictEqual(rows[0].classList.contains('hflow-row-reverse'), false, 'row 0 must read left-to-right, unchanged');
            assert.strictEqual(rows[1].classList.contains('hflow-row-reverse'), true, 'row 1 must be reversed');
        });

        test('keeps DOM order matching the real flow order even inside a reversed row (visual flip is CSS-only)', () => {
            const dom = buildInteractiveDom(fiveNodePlan());
            stubRows(flowItemsOf(dom), [2, 3]);
            resize(dom);

            const names = Array.from(dom.window.document.querySelectorAll('.hnode-name')).map(el => el.textContent);
            assert.deepStrictEqual(names, ['A', 'B', 'C', 'D', 'E'], 'tab/DOM order must stay in logical flow order; only CSS reverses the visual row');
        });

        test('inserts exactly one .hflow-drop between rows', () => {
            const dom = buildInteractiveDom(fiveNodePlan());
            const track = dom.window.document.querySelector('.hflow-track')!;
            stubRows(flowItemsOf(dom), [2, 3]);
            resize(dom);

            assert.strictEqual(track.querySelectorAll('.hflow-drop').length, 1, 'expected exactly rows.length - 1 drop connectors');
        });

        test('aligns the drop connector and the next row to where the previous row\'s last ring actually ended up, not to the track\'s edge', () => {
            // Regression test for a real bug (caught against a real
            // screenshot): the drop arrow and the next row's node both
            // landed visibly off-center from the ring they were meant to
            // continue from. Packing against the track's full width only
            // lines up by coincidence — a row's real content width is
            // whatever fit before it wrapped, essentially never exactly the
            // track's width. The fix measures the actual ring position and
            // aligns to that directly.
            const dom = buildInteractiveDom(fiveNodePlan());
            const doc = dom.window.document;
            const track = doc.querySelector('.hflow-track')!;
            stubRows(flowItemsOf(dom), [2, 3]);

            // The track itself sits at x=1000 in the viewport, to prove the
            // computation is relative to the track, not the raw viewport.
            stubRect(track, { top: 0, bottom: 1000, left: 1000, right: 2000 });
            const nodeB = doc.querySelector('.hnode[data-node-id="2"]')!.closest('.hstep')!;
            const nodeC = doc.querySelector('.hnode[data-node-id="3"]')!.closest('.hstep')!;
            stubRingCenter(nodeB, 1400); // B is row 0's last item; its ring sits at x=1400 in the viewport (400 relative to the track)
            stubRingCenter(nodeC, 1050); // C is row 1's first item; its unshifted ring sits at x=1050 (50 relative to the track)

            resize(dom);

            const dropConn = track.querySelector('.hflow-drop-connector') as HTMLElement;
            assert.strictEqual(dropConn.style.marginLeft, '400px', 'expected the drop connector centered under B\'s ring, 400px from the track\'s own left edge');

            const rowEl = track.querySelectorAll('.hflow-row')[1] as HTMLElement;
            assert.strictEqual(rowEl.style.left, '350px', 'expected row 1 shifted by exactly the gap between C\'s unshifted position (50) and B\'s ring (400)');
        });

        test('shifts a wrapped row via position:relative + left, never via transform (transform would trap a popover\'s z-index inside the row\'s own stacking context)', () => {
            // Regression test for a real bug (caught against real
            // screenshots): a popover opened on an earlier row painted
            // BELOW the content of later rows. `transform` creates a new
            // stacking context on the row it's applied to, so the
            // popover's z-index only ever won within that row's own
            // context — later sibling rows (also stacking contexts,
            // painted later in DOM order) drew over it regardless of
            // z-index. `position: relative` + `left` moves a row
            // identically without creating a stacking context, so a
            // popover's z-index is free to compete at the track level
            // against every row, not just its own.
            const dom = buildInteractiveDom(fiveNodePlan());
            const doc = dom.window.document;
            const track = doc.querySelector('.hflow-track')!;
            stubRows(flowItemsOf(dom), [2, 3]);

            stubRect(track, { top: 0, bottom: 1000, left: 1000, right: 2000 });
            const nodeB = doc.querySelector('.hnode[data-node-id="2"]')!.closest('.hstep')!;
            const nodeC = doc.querySelector('.hnode[data-node-id="3"]')!.closest('.hstep')!;
            stubRingCenter(nodeB, 1400);
            stubRingCenter(nodeC, 1050);

            resize(dom);

            const rows = Array.from(track.querySelectorAll('.hflow-row')) as HTMLElement[];
            rows.forEach(row => {
                assert.strictEqual(row.style.transform, '', 'no .hflow-row may carry a transform: it would create a stacking context that traps the popover z-index inside that row');
            });
            assert.strictEqual(rows[0].style.position, '', 'row 0 is never shifted, so it gets no inline position either');
            assert.strictEqual(rows[1].style.position, 'relative', 'the shifted row must use position:relative, not a transform, to move without creating a stacking context');
            assert.strictEqual(rows[1].style.left, '350px');
        });

        test('hides (not removes) the original connector for the node that now starts a new row, and carries its rows-out label onto the drop connector', () => {
            const dom = buildInteractiveDom(fiveNodePlan());
            const doc = dom.window.document;
            stubRows(flowItemsOf(dom), [2, 3]);
            resize(dom);

            const nodeC = doc.querySelector('.hnode[data-node-id="3"]')!;
            const stepC = nodeC.closest('.hstep')!;
            const originalConn = stepC.querySelector('.hconn')!;
            assert.strictEqual(originalConn.classList.contains('hconn-hidden'), true);
            assert.ok(doc.contains(originalConn), 'the original connector must be hidden, not removed, so a later relayout can restore it');

            const drop = doc.querySelector('.hflow-drop')!;
            const dropLabel = drop.querySelector('.hconn-label')!;
            assert.ok(dropLabel.textContent!.includes('200'), 'expected the drop connector to carry over node B\'s rowsOut label');
        });

        test('does not touch the connector between two nodes on the same row', () => {
            const dom = buildInteractiveDom(fiveNodePlan());
            const doc = dom.window.document;
            stubRows(flowItemsOf(dom), [2, 3]);
            resize(dom);

            const nodeB = doc.querySelector('.hnode[data-node-id="2"]')!;
            const stepB = nodeB.closest('.hstep')!;
            assert.strictEqual(stepB.querySelector('.hconn')!.classList.contains('hconn-hidden'), false);
        });

        test('a node moved into a reversed row is still a working popover trigger (event listeners survive the move)', () => {
            const dom = buildInteractiveDom(fiveNodePlan());
            const doc = dom.window.document;
            stubRows(flowItemsOf(dom), [2, 3]);
            resize(dom);

            const nodeD = doc.querySelector('.hnode[data-node-id="4"]')!;
            const pop = popoverFor(dom, nodeD);
            assert.strictEqual(pop.hidden, true);

            click(dom, nodeD);
            assert.strictEqual(pop.hidden, false, 'a node relocated into a reversed row must still open its popover on click');
        });

        test('relaying out again on a later resize starts fresh, rather than layering onto the previous split', () => {
            const dom = buildInteractiveDom(fiveNodePlan());
            const track = dom.window.document.querySelector('.hflow-track')!;
            const items = flowItemsOf(dom);

            stubRows(items, [2, 3]);
            resize(dom);
            assert.strictEqual(track.querySelectorAll('.hflow-row').length, 2, 'precondition: first resize produced two rows');

            items.forEach(item => Object.defineProperty(item, 'offsetTop', { value: 0, configurable: true }));
            resize(dom);

            assert.strictEqual(track.querySelectorAll('.hflow-row').length, 0, 'a resize that now fits everything on one row must revert to the flat structure');
            assert.strictEqual(track.querySelectorAll('.hflow-drop').length, 0);
            assert.strictEqual(track.querySelectorAll('.hconn-hidden').length, 0, 'no connector should be left stuck hidden after reverting to one row');
            assert.strictEqual(track.classList.contains('hflow-track-snaked'), false);
        });

        test('the CSS defines the reversed-row and drop-connector rules', () => {
            const css = buildPlanContentCss();
            assert.ok(
                /\.hflow-row-reverse\s*\{[^}]*flex-direction:\s*row-reverse/.test(css),
                'expected .hflow-row-reverse to reverse the row\'s own flex direction'
            );
            assert.ok(
                /\.hflow-row-reverse\s+\.hstep\s*\{[^}]*flex-direction:\s*row-reverse/.test(css),
                'expected each .hstep inside a reversed row to also flip internally, or its connector lands on the wrong side of its node'
            );
            assert.ok(css.includes('.hflow-drop'), 'expected drop-connector styling for the row-to-row transition');
        });

        test('a reversed row does not pair row-reverse with justify-content: flex-end', () => {
            // Regression test for a real bug (caught via a real screenshot):
            // row-reverse swaps which physical edge "main-end" refers to, so
            // justify-content: flex-end under row-reverse packs content
            // against the LEFT edge, not the right — sending the reversed
            // row straight back to the far-left position this feature exists
            // to fix. The default (flex-start) is what actually packs a
            // row-reverse container's content flush right.
            const css = buildPlanContentCss();
            assert.ok(
                !/\.hflow-row-reverse\s*\{[^}]*justify-content:\s*flex-end/.test(css),
                'row-reverse already redefines "end" as the left edge — an explicit justify-content: flex-end here undoes the reversal'
            );
        });

        test('the connector-hidden override has enough specificity to actually beat .hconn\'s own display rule', () => {
            // Regression test for a real bug: a bare .hconn-hidden { display:
            // none } ties in specificity with .hconn { display: flex }
            // (both single-class selectors), so which one wins depends on
            // source order rather than intent — and in the shipped
            // stylesheet .hconn's rule happened to come later, silently
            // defeating the hide and leaving a stale connector on screen
            // right next to the row it no longer connects to anything on.
            const css = buildPlanContentCss();
            assert.ok(
                /\.hconn\.hconn-hidden\s*\{[^}]*display:\s*none/.test(css),
                'expected the two-class .hconn.hconn-hidden selector, which beats .hconn\'s own display rule regardless of source order'
            );
        });

        suite('connector pill direction arrows (finding 21)', () => {
            test('an unreversed row keeps the default left-to-right arrow', () => {
                const dom = buildInteractiveDom(fiveNodePlan());
                const doc = dom.window.document;
                stubRows(flowItemsOf(dom), [2, 3]);
                resize(dom);

                const stepB = doc.querySelector('.hnode[data-node-id="2"]')!.closest('.hstep')!;
                assert.strictEqual(stepB.querySelector('.hconn-label')!.textContent, '→ 100 rows', 'row 0 is never reversed, so its connector keeps the default arrow');
            });

            test('a reversed row\'s connectors flip to the right-to-left arrow, count text unchanged', () => {
                const dom = buildInteractiveDom(fiveNodePlan());
                const doc = dom.window.document;
                stubRows(flowItemsOf(dom), [2, 3]);
                resize(dom);

                const stepD = doc.querySelector('.hnode[data-node-id="4"]')!.closest('.hstep')!;
                const stepE = doc.querySelector('.hnode[data-node-id="5"]')!.closest('.hstep')!;
                assert.strictEqual(stepD.querySelector('.hconn-label')!.textContent, '← 300 rows', 'row 1 is reversed, so its connectors must read right-to-left');
                assert.strictEqual(stepE.querySelector('.hconn-label')!.textContent, '← 400 rows');
            });

            test('the vertical drop connector between rows reads "down", not the carried-over horizontal arrow', () => {
                const dom = buildInteractiveDom(fiveNodePlan());
                const doc = dom.window.document;
                stubRows(flowItemsOf(dom), [2, 3]);
                resize(dom);

                const dropLabel = doc.querySelector('.hflow-drop .hconn-label')!;
                assert.strictEqual(dropLabel.textContent, '↓ 200 rows');
            });

            test('reverting to a single row (resetFlowRows) restores every connector to the default arrow', () => {
                const dom = buildInteractiveDom(fiveNodePlan());
                const doc = dom.window.document;
                const items = flowItemsOf(dom);

                stubRows(items, [2, 3]);
                resize(dom);
                const stepDBefore = doc.querySelector('.hnode[data-node-id="4"]')!.closest('.hstep')!;
                assert.strictEqual(stepDBefore.querySelector('.hconn-label')!.textContent, '← 300 rows', 'precondition: row 1 was reversed and flipped');

                items.forEach(item => Object.defineProperty(item, 'offsetTop', { value: 0, configurable: true }));
                resize(dom);

                const allLabels = Array.from(doc.querySelectorAll('.hconn-label')).map(el => el.textContent);
                assert.ok(allLabels.every(t => t!.startsWith('→ ')), `expected every connector reset to the default arrow, got: ${JSON.stringify(allLabels)}`);
            });
        });
    });

    suite('warnings summary (side rail)', () => {
        test('renders one item per warning across the whole plan, not per node', () => {
            const plan = makePlan([
                makeNode({ id: '1', warnings: [
                    { type: 'SPILLED_TO_DISK', message: 'a', detail: {} },
                    { type: 'HIGH_SKEW', message: 'b', detail: {} }
                ] }),
                makeNode({ id: '2', warnings: [{ type: 'LARGE_REDISTRIBUTION', message: 'c', detail: {} }] })
            ]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            assert.strictEqual(doc.querySelectorAll('.plan-warning-item').length, 3);
            assert.ok(doc.querySelector('.plan-side-warnings')!.textContent!.includes('Warnings (3)'));
        });

        test('omits the warnings card entirely when no node has any warning', () => {
            const plan = makePlan([makeNode({ warnings: [] }), makeNode({ id: '2', warnings: [] })]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            assert.strictEqual(doc.querySelector('.plan-side-warnings'), null);
        });

        test('each item names the operator, its part id, and the full warning message', () => {
            const plan = makePlan([makeNode({
                id: '9', operatorLabel: 'PIPE AGGREGATOR',
                warnings: [{ type: 'SPILLED_TO_DISK', message: 'Wrote 12.5 MiB to disk during execution', detail: {} }]
            })]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            const item = doc.querySelector('.plan-warning-item')!;
            assert.ok(item.textContent!.includes('PIPE AGGREGATOR'));
            assert.ok(item.textContent!.includes('part 9'));
            assert.ok(item.textContent!.includes('Wrote 12.5 MiB to disk during execution'));
        });

        test('each item is a real, keyboard-activatable button', () => {
            const plan = makePlan([makeNode({ warnings: [{ type: 'SPILLED_TO_DISK', message: 'x', detail: {} }] })]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            assert.strictEqual(doc.querySelector('.plan-warning-item')!.tagName, 'BUTTON');
        });

        test('clicking a warning item opens the popover for the node it came from (real script execution)', () => {
            const plan = makePlan([
                makeNode({ id: '1', warnings: [] }),
                makeNode({ id: '2', warnings: [{ type: 'SPILLED_TO_DISK', message: 'x', detail: {} }] })
            ]);
            const dom = buildInteractiveDom(plan);
            const warningItem = dom.window.document.querySelector('.plan-warning-item')!;
            const node2 = dom.window.document.querySelector('.hnode[data-node-id="2"]')!;
            const pop2 = popoverFor(dom, node2);
            assert.strictEqual(pop2.hidden, true);

            click(dom, warningItem);
            assert.strictEqual(pop2.hidden, false, 'clicking the warning item must open node 2\'s popover, whose warning it is');
        });

        test('pressing Enter on a warning item also opens its node\'s popover', () => {
            const plan = makePlan([makeNode({ id: '1', warnings: [{ type: 'SPILLED_TO_DISK', message: 'x', detail: {} }] })]);
            const dom = buildInteractiveDom(plan);
            const warningItem = dom.window.document.querySelector('.plan-warning-item')!;
            const node = dom.window.document.querySelector('.hnode')!;
            const pop = popoverFor(dom, node);

            keydown(dom, warningItem, 'Enter');
            assert.strictEqual(pop.hidden, false);
        });

        suite('jump highlight (finding 8)', () => {
            test('clicking a warning item adds a transient highlight class to the node it jumps to', () => {
                const plan = makePlan([
                    makeNode({ id: '1', warnings: [] }),
                    makeNode({ id: '2', warnings: [{ type: 'SPILLED_TO_DISK', message: 'x', detail: {} }] })
                ]);
                const dom = buildInteractiveDom(plan);
                const warningItem = dom.window.document.querySelector('.plan-warning-item')!;
                const node2 = dom.window.document.querySelector('.hnode[data-node-id="2"]')!;
                assert.strictEqual(node2.classList.contains('hnode-jumped'), false, 'precondition: not highlighted yet');

                click(dom, warningItem);
                assert.strictEqual(node2.classList.contains('hnode-jumped'), true, 'the jumped-to node must carry the transient highlight class');
            });

            test('a second jump moves the highlight instead of stacking it on more than one node', () => {
                const plan = makePlan([
                    makeNode({ id: '1', warnings: [{ type: 'SPILLED_TO_DISK', message: 'a', detail: {} }] }),
                    makeNode({ id: '2', warnings: [{ type: 'SPILLED_TO_DISK', message: 'b', detail: {} }] })
                ]);
                const dom = buildInteractiveDom(plan);
                const items = Array.from(dom.window.document.querySelectorAll('.plan-warning-item'));
                const node1 = dom.window.document.querySelector('.hnode[data-node-id="1"]')!;
                const node2 = dom.window.document.querySelector('.hnode[data-node-id="2"]')!;

                click(dom, items[0]);
                assert.strictEqual(node1.classList.contains('hnode-jumped'), true);

                click(dom, items[1]);
                assert.strictEqual(node1.classList.contains('hnode-jumped'), false, 'only one node may carry the highlight at a time');
                assert.strictEqual(node2.classList.contains('hnode-jumped'), true);
            });

            // Regression test for the pending-timer bug: jumpHighlight() used
            // to start a new 1600ms removal timer on every jump without
            // clearing the previous one, so jumping to the SAME node twice in
            // quick succession let the FIRST jump's timer fire later and
            // erase the highlight the second jump had just (re-)applied. No
            // sinon/fake-timer setup exists anywhere in this codebase (no
            // "sinon" dependency, no other test fakes timers), so this
            // asserts only the timing-free half of the bug — the class is
            // still present immediately after the second jump — rather than
            // advancing a clock to prove the stale timer no longer fires.
            test('jumping to the same node twice leaves the class present immediately after the second jump', () => {
                const plan = makePlan([
                    makeNode({ id: '1', warnings: [{ type: 'SPILLED_TO_DISK', message: 'a', detail: {} }] })
                ]);
                const dom = buildInteractiveDom(plan);
                const warningItem = dom.window.document.querySelector('.plan-warning-item')!;
                const node = dom.window.document.querySelector('.hnode[data-node-id="1"]')!;

                click(dom, warningItem);
                assert.strictEqual(node.classList.contains('hnode-jumped'), true, 'precondition: first jump highlights the node');

                click(dom, warningItem);
                assert.strictEqual(node.classList.contains('hnode-jumped'), true, 'the second jump to the same node must still leave it highlighted');
            });
        });

        suite('severity sort (finding 16)', () => {
            test('orders spill first, then redistribution, then duration skew, then row skew — noise-y skew ranked below a genuinely large one', () => {
                const plan = makePlan([
                    // Deliberately built out of the expected order, and with
                    // a "noisy" skew (huge ratio, trivial row count) ranked
                    // alongside a genuinely large one, mirroring the real
                    // screenshot in the roast doc (four 0-1-row noise
                    // warnings burying two real ones).
                    makeNode({ id: 'skewSmall', warnings: [
                        { type: 'HIGH_SKEW', message: 'skewSmall', detail: { min: 0, max: 10, avg: 2, nodeCount: 4, ratio: 5 } }
                    ] }),
                    makeNode({ id: 'durSkew', warnings: [
                        { type: 'HIGH_DURATION_SKEW', message: 'durSkew', detail: { minSeconds: 0, maxSeconds: 5, avgSeconds: 1, nodeCount: 4, ratio: 2 } }
                    ] }),
                    makeNode({ id: 'spill', warnings: [
                        { type: 'SPILLED_TO_DISK', message: 'spill', detail: { hddWriteMiB: 10 } }
                    ] }),
                    makeNode({ id: 'skewBig', warnings: [
                        { type: 'HIGH_SKEW', message: 'skewBig', detail: { min: 0, max: 2000, avg: 1000, nodeCount: 4, ratio: 0.1 } }
                    ] }),
                    makeNode({ id: 'redistribution', warnings: [
                        { type: 'LARGE_REDISTRIBUTION', message: 'redistribution', detail: { netMiB: 500, costPercent: 30, thresholdPercent: 20 } }
                    ] })
                ]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                const order = Array.from(doc.querySelectorAll('.plan-warning-item')).map(el => el.getAttribute('data-jump-to'));
                assert.deepStrictEqual(order, ['spill', 'redistribution', 'durSkew', 'skewBig', 'skewSmall']);
            });

            test('keeps plan (node) order for warnings that tie on both priority and impact', () => {
                const plan = makePlan([
                    makeNode({ id: 'first', warnings: [{ type: 'ROW_ESTIMATE_MISMATCH', message: 'x', detail: {} }] }),
                    makeNode({ id: 'second', warnings: [{ type: 'ROW_ESTIMATE_MISMATCH', message: 'y', detail: {} }] })
                ]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                const order = Array.from(doc.querySelectorAll('.plan-warning-item')).map(el => el.getAttribute('data-jump-to'));
                assert.deepStrictEqual(order, ['first', 'second'], 'ties must not be shuffled from their original plan order');
            });
        });
    });

    suite('CSP-safe dynamic styling (real script execution, not just markup attributes)', () => {
        // Regression coverage for a real bug: the ring/bar/legend colors used
        // to be plain style="" attributes. The webview's CSP has no
        // 'unsafe-inline'/'unsafe-hashes' on style-src, and a style-src nonce
        // only covers nonce'd <style> ELEMENTS — never inline style
        // ATTRIBUTES — so the browser silently dropped them. Values now travel
        // as data-* attributes and get painted by the nonce'd script via the
        // CSSOM, which these tests actually execute and observe.
        test('paints the ring background from data-ring-pct/data-ring-color', () => {
            const plan = makePlan([makeNode({ id: '1', costPercent: 40 })]);
            const dom = buildInteractiveDom(plan);
            const ring = dom.window.document.querySelector('.hnode-ring') as HTMLElement;
            assert.ok(
                ring.style.background.includes('conic-gradient') && ring.style.background.includes('40%'),
                `expected the ring's computed background to be a conic-gradient reflecting 40%, got: ${ring.style.background}`
            );
        });

        test('paints each category-bar segment\'s width and color', () => {
            const plan = makePlan([makeNode({ id: '1', operatorType: 'SCAN', duration: 4 })], { totalDuration: 4 });
            const dom = buildInteractiveDom(plan);
            const segment = dom.window.document.querySelector('.hcat-bar span') as HTMLElement;
            assert.strictEqual(segment.style.width, '100%');
            assert.ok(segment.style.backgroundColor.includes('--vscode-charts-blue'));
        });

        test('paints the legend swatch color', () => {
            const plan = makePlan([makeNode({ id: '1', operatorType: 'SCAN', duration: 4 })], { totalDuration: 4 });
            const dom = buildInteractiveDom(plan);
            const swatch = dom.window.document.querySelector('.hcat-legend i') as HTMLElement;
            assert.ok(swatch.style.backgroundColor.includes('--vscode-charts-blue'));
        });
    });

    suite('time by category', () => {
        test('renders one bar segment per operatorType present, proportioned by its share of totalDuration', () => {
            const plan = makePlan([
                makeNode({ id: '1', operatorType: 'SCAN', duration: 3 }),
                makeNode({ id: '2', operatorType: 'JOIN', duration: 1 })
            ], { totalDuration: 4 });
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            assert.strictEqual(doc.querySelectorAll('.hcat-bar span').length, 2);
        });

        test('carries each segment\'s width/color as data attributes, not a CSP-blocked inline style', () => {
            const plan = makePlan([makeNode({ id: '1', operatorType: 'SCAN', duration: 4 })], { totalDuration: 4 });
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            const segment = doc.querySelector('.hcat-bar span')!;
            assert.strictEqual(segment.getAttribute('data-width'), '100');
            assert.strictEqual(segment.getAttribute('data-color-var'), '--vscode-charts-blue');
            assert.strictEqual(segment.hasAttribute('style'), false);

            const swatch = doc.querySelector('.hcat-legend i')!;
            assert.strictEqual(swatch.getAttribute('data-color-var'), '--vscode-charts-blue');
            assert.strictEqual(swatch.hasAttribute('style'), false);
        });

        test('shows "not available" instead of a bar when totalDuration is zero', () => {
            const plan = makePlan([makeNode({ duration: undefined })], { totalDuration: 0 });
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            assert.ok(doc.querySelector('.hcat-empty'));
            assert.strictEqual(doc.querySelector('.hcat-bar'), null);
        });

        test('lists each category with its percent share in the legend', () => {
            const plan = makePlan([
                makeNode({ id: '1', operatorType: 'SCAN', duration: 3 }),
                makeNode({ id: '2', operatorType: 'JOIN', duration: 1 })
            ], { totalDuration: 4 });
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            const legendText = doc.querySelector('.hcat-legend')!.textContent!;
            assert.ok(legendText.includes('Scan'));
            assert.ok(legendText.includes('75%'));
            assert.ok(legendText.includes('Join'));
            assert.ok(legendText.includes('25%'));
        });

        suite('absolute duration in the legend', () => {
            test('each row shows label, absolute duration, and percent as three separate spans', () => {
                // Mirrors the concrete example: a 188ms Group By step that is
                // 81% of a 232ms total.
                const plan = makePlan([
                    makeNode({ id: '1', operatorType: 'GROUP_BY', duration: 0.188 }),
                    makeNode({ id: '2', operatorType: 'SCAN', duration: 0.044 })
                ], { totalDuration: 0.232 });
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                const rows = Array.from(doc.querySelectorAll('.hcat-legend > div'));

                const groupByRow = rows.find(r => r.textContent!.includes('Group By'))!;
                const groupBySpans = Array.from(groupByRow.querySelectorAll('span'));
                assert.strictEqual(groupBySpans.length, 3, 'expected label, duration, and percent as three spans');
                assert.ok(groupBySpans[0].textContent!.includes('Group By'));
                assert.strictEqual(groupBySpans[1].textContent, '188 ms');
                assert.strictEqual(groupBySpans[2].textContent, '81%');

                const scanRow = rows.find(r => r.textContent!.includes('Scan'))!;
                const scanSpans = Array.from(scanRow.querySelectorAll('span'));
                assert.strictEqual(scanSpans[1].textContent, '44.0 ms');
                assert.strictEqual(scanSpans[2].textContent, '19%');
            });

            test('the flex layout keeps duration/percent fixed-width and right-aligned, with the label taking the remaining space', () => {
                const css = buildPlanContentCss();
                assert.ok(
                    /\.hcat-legend div\s*\{[^}]*display:\s*flex/.test(css),
                    'expected .hcat-legend div to stay a flex row'
                );
                assert.ok(
                    /\.hcat-legend div span:first-child\s*\{[^}]*flex:\s*1/.test(css),
                    'expected the label span to grow and fill the remaining space'
                );
                assert.ok(
                    /\.hcat-legend div span:not\(:first-child\)\s*\{[^}]*flex:\s*none/.test(css),
                    'expected duration/percent to stay fixed-width, not stretch'
                );
            });
        });

        test('the heading says the breakdown is of total, since it always includes system-step time (finding B)', () => {
            const plan = makePlan([makeNode({ id: '1', operatorType: 'SCAN', duration: 4 })], { totalDuration: 4 });
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            const heading = Array.from(doc.querySelectorAll('.plan-side-card h4')).find(h => h.textContent && h.textContent.includes('Time by category'));
            assert.ok(heading, 'expected the "Time by category" heading to render');
            assert.ok(heading!.textContent!.includes('(of total)'), `expected the "(of total)" suffix, got: ${heading!.textContent}`);
        });
    });

    suite('side rail', () => {
        test('labels DETAILS as per-node detail', () => {
            const plan = makePlan([makeNode()], { source: 'DETAILS' });
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            assert.ok(doc.querySelector('.plan-side')!.textContent!.includes('per-node detail'));
        });

        suite('Session/Statement rows (only on-screen place both ids appear)', () => {
            function rowValue(doc: Document, label: string): string | null | undefined {
                const row = Array.from(doc.querySelectorAll('.plan-side-row')).find(
                    el => el.querySelector('span:first-child')!.textContent === label
                );
                return row?.querySelector('span:last-child')!.textContent;
            }

            test('renders the exact session and statement id digit strings, above Source', () => {
                // A session id past Number.MAX_SAFE_INTEGER (2^53 - 1 =
                // 9,007,199,254,740,991) pins the no-rounding guarantee
                // end-to-end: Plan.sessionId/stmtId are kept as exact digit
                // strings for exactly this reason (see planModel.ts) — a
                // real DECIMAL(20,0) SESSION_ID routinely exceeds it, and
                // rendering `Number(sessionId)` anywhere in this path would
                // silently corrupt the value a user needs to paste verbatim
                // into a SESSION_ID = ... filter.
                const plan = makePlan([makeNode()], { sessionId: '17714852875571234567', stmtId: '42' });
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                assert.strictEqual(rowValue(doc, 'Session'), '17714852875571234567');
                assert.strictEqual(rowValue(doc, 'Statement'), '42');

                const labels = Array.from(doc.querySelectorAll('.plan-side-row')).map(
                    el => el.querySelector('span:first-child')!.textContent
                );
                assert.ok(labels.indexOf('Session') < labels.indexOf('Source'), 'Session must render above Source');
                assert.ok(labels.indexOf('Statement') < labels.indexOf('Source'), 'Statement must render above Source');
            });

            test('escapes a malicious session/statement id the same as every other field', () => {
                const evil = '<script>alert(1)</script>';
                const plan = makePlan([makeNode()], { sessionId: evil, stmtId: evil });
                const html = buildPlanContentHtml(plan, 'n0nce');
                assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag must never appear');
            });

            test('the value column can wrap/break instead of clipping a full 20-digit session id', () => {
                const css = buildPlanContentCss();
                assert.ok(
                    /\.plan-side-row\s*\{[^}]*flex-wrap:\s*wrap/.test(css),
                    'expected .plan-side-row to allow wrapping onto its own line for a long value'
                );
                assert.ok(
                    /\.plan-side-row\s+span:last-child\s*\{[^}]*overflow-wrap:\s*break-word/.test(css),
                    'expected the value span to allow breaking a long, unbroken digit string as a last resort'
                );
            });
        });

        suite('Operators row (rail consolidation)', () => {
            function rowValue(doc: Document, label: string): string | null | undefined {
                const row = Array.from(doc.querySelectorAll('.plan-side-row')).find(
                    el => el.querySelector('span:first-child')!.textContent === label
                );
                return row?.querySelector('span:last-child')!.textContent;
            }

            test('shows the operator count with the same singular/plural handling the old caption used', () => {
                const singular = parseDom(buildPlanContentHtml(makePlan([makeNode({ id: '1' })]), 'n0nce'));
                assert.strictEqual(rowValue(singular, 'Operators'), '1 operator');

                const plural = parseDom(buildPlanContentHtml(makePlan([makeNode({ id: '1' }), makeNode({ id: '2' })]), 'n0nce'));
                assert.strictEqual(rowValue(plural, 'Operators'), '2 operators');

                const empty = parseDom(buildPlanContentHtml(makePlan([]), 'n0nce'));
                assert.strictEqual(rowValue(empty, 'Operators'), '0 operators');
            });
        });

        test('renders the Profile overview rows in order: Session, Statement, Total time, Operators, Nodes observed, Source', () => {
            // Session/Statement lead — together they're the composite key
            // copied into a EXA_*_PROFILE_LAST_DAY / EXA_SQL_LAST_DAY
            // cross-check, Session first as the wider key and matching those
            // views' own column order. Facts about the plan follow; Source
            // (a provenance caveat, not a fact about the query) comes last.
            const plan = makePlan([makeNode()], {
                sessionId: '123', stmtId: '39', totalDuration: 0.5,
                source: 'DETAILS'
            });
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            const card = Array.from(doc.querySelectorAll('.plan-side-card')).find(
                c => c.querySelector('h4')!.textContent === 'Profile overview'
            )!;
            const labels = Array.from(card.querySelectorAll('.plan-side-row')).map(
                el => el.querySelector('span:first-child')!.textContent
            );
            assert.deepStrictEqual(labels, ['Session', 'Statement', 'Total time', 'Operators', 'Nodes observed', 'Source']);
        });

        suite('badge legend card (finding 2, round 7)', () => {
            const EXPECTED_PAIRS: Array<[string, string]> = [
                ['S', 'Scan'], ['J', 'Join'], ['G', 'Group By'], ['O', 'Sort'],
                ['N', 'Network'], ['D', 'DML'], ['‖', 'Sync'], ['⚙', 'System'], ['⋯', 'Other']
            ];

            test('renders all 9 operator types, in a fixed order, each with its correct glyph/label pair', () => {
                // Same data every node already renders on its own ring (see
                // OPERATOR_BADGE/OPERATOR_TYPE_LABEL in planFormat.ts) — no
                // new data, just all nine listed in one place.
                const doc = parseDom(buildPlanContentHtml(makePlan([makeNode()]), 'n0nce'));
                const legendCard = Array.from(doc.querySelectorAll('.plan-side-card')).find(
                    c => c.querySelector('h4')!.textContent === 'Legend'
                )!;
                assert.ok(legendCard, 'expected a "Legend" card in the rail');

                const items = Array.from(legendCard.querySelectorAll('.plan-legend-item'));
                assert.strictEqual(items.length, 9);

                const pairs = items.map(item => {
                    const spans = Array.from(item.querySelectorAll('span'));
                    return [spans[0].textContent, spans[1].textContent];
                });
                assert.deepStrictEqual(pairs, EXPECTED_PAIRS);
            });

            test('the Legend card is the last card in the rail', () => {
                const doc = parseDom(buildPlanContentHtml(makePlan([makeNode()]), 'n0nce'));
                const cards = Array.from(doc.querySelectorAll('.plan-side > .plan-side-card'));
                const headings = cards.map(c => c.querySelector('h4')!.textContent);
                assert.strictEqual(headings[headings.length - 1], 'Legend');
            });
        });

        test('labels DBA_SUMMARY distinctly from USER_SUMMARY', () => {
            const dba = parseDom(buildPlanContentHtml(makePlan([makeNode()], { source: 'DBA_SUMMARY' }), 'n0nce'));
            const user = parseDom(buildPlanContentHtml(makePlan([makeNode()], { source: 'USER_SUMMARY' }), 'n0nce'));
            assert.ok(dba.querySelector('.plan-side')!.textContent!.includes('DBA'));
            assert.ok(!user.querySelector('.plan-side')!.textContent!.includes('DBA'));
        });

        test('shows "not available" for node count when no per-node stats exist anywhere', () => {
            const plan = makePlan([makeNode({ perNodeStats: undefined })]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            assert.ok(doc.querySelector('.plan-side')!.textContent!.includes('not available'));
        });

        test('shows the max observed node count when per-node stats exist', () => {
            const plan = makePlan([
                makeNode({ id: '1', perNodeStats: { metric: 'rows', min: 1, max: 1, avg: 1, nodeCount: 4 } }),
                makeNode({ id: '2', perNodeStats: { metric: 'rows', min: 1, max: 1, avg: 1, nodeCount: 2 } })
            ]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            const values = Array.from(doc.querySelectorAll('.plan-side-row span:last-child')).map(el => el.textContent);
            assert.ok(values.includes('4'));
        });

        test('holds only plan-level summary cards — no per-node detail card duplicating the popover', () => {
            const plan = makePlan([makeNode({ warnings: [{ type: 'SPILLED_TO_DISK', message: 'x', detail: {} }] })]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            assert.strictEqual(doc.querySelector('.plan-detail-block'), null);
            assert.strictEqual(doc.querySelector('.plan-detail-card'), null);
        });

        suite('PROFILE-not-enabled hint', () => {
            test('shows an educational hint when no node has a defined CPU or Net', () => {
                const plan = makePlan([
                    makeNode({ id: '1', cpu: undefined, net: undefined }),
                    makeNode({ id: '2', cpu: undefined, net: undefined })
                ]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                const hint = doc.querySelector('.plan-side-hint');
                assert.ok(hint);
                assert.ok(hint!.textContent!.includes('Reconnect with'));
            });

            test('omits the hint when at least one node has a defined CPU or Net', () => {
                const plan = makePlan([
                    makeNode({ id: '1', cpu: undefined, net: undefined }),
                    makeNode({ id: '2', cpu: 12.5, net: undefined })
                ]);
                const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
                assert.strictEqual(doc.querySelector('.plan-side-hint'), null);
            });
        });
    });

    suite('copy as text', () => {
        test('renders a copy button and a hidden textarea carrying the plan text summary', () => {
            const plan = makePlan([makeNode({ operatorLabel: 'PIPE SCAN' })]);
            const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
            assert.ok(doc.querySelector('[data-copy-plan]'), 'expected a copy-as-text button');
            const textarea = doc.querySelector('#plan-text-data') as HTMLTextAreaElement;
            assert.ok(textarea);
            assert.strictEqual(textarea.hasAttribute('hidden'), true);
            assert.ok(textarea.value.includes('PIPE SCAN'), 'expected the embedded text to include the rendered operator');
        });

        test('escapes a malicious query/operator value inside the embedded textarea', () => {
            const evil = '</textarea><script>alert(1)</script>';
            const plan = makePlan([makeNode({ operatorLabel: evil })]);
            const html = buildPlanContentHtml(plan, 'n0nce');
            assert.ok(!html.includes('</textarea><script>'), 'raw markup must never appear unescaped inside the textarea');
        });

        test('the copy button posts a copyPlanText message with the textarea contents', () => {
            const plan = makePlan([makeNode()]);
            const html = buildPlanContentHtml(plan, 'n0nce');
            assert.ok(html.includes('data-copy-plan'));
            assert.ok(html.includes("command: 'copyPlanText'"), 'expected the click handler to post the copyPlanText command');
            assert.ok(html.includes('plan-text-data'), 'expected the handler to read from the embedded textarea');
        });
    });

    test('renders an empty-state message rather than an empty flow when there are no nodes', () => {
        const plan = makePlan([]);
        const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
        assert.ok(doc.querySelector('.plan-empty'));
        assert.strictEqual(doc.querySelectorAll('.hnode').length, 0);
    });

    test('dims system-step nodes (e.g. COMPILE) but does not hide them', () => {
        const plan = makePlan([makeNode({
            operatorType: 'SYSTEM',
            operatorLabel: 'COMPILE',
            traits: { ...PASSTHROUGH_TRAITS, isSystemStep: true }
        })]);
        const doc = parseDom(buildPlanContentHtml(plan, 'n0nce'));
        assert.ok(doc.querySelector('.hnode.hnode-system'));
    });
});

suite('buildPlanErrorHtml', () => {
    test('escapes the error message', () => {
        const html = buildPlanErrorHtml({ message: '<img src=x onerror=alert(1)>' });
        assert.ok(!html.includes('<img src=x'));
        assert.ok(html.includes('&lt;img'));
    });

    test('renders a status title', () => {
        const doc = parseDom(buildPlanErrorHtml({ message: 'boom' }));
        assert.ok(doc.querySelector('.plan-status-title'));
        assert.ok(doc.querySelector('.plan-status-message')!.textContent!.includes('boom'));
    });

    test('renders a retry button when requested', () => {
        const doc = parseDom(buildPlanErrorHtml({ message: 'boom', canRetry: true }));
        assert.strictEqual(doc.querySelector('[data-plan-retry]')!.textContent, 'Retry');
    });
});

suite('buildPlanLoadingHtml', () => {
    test('renders a non-empty loading indicator', () => {
        const doc = parseDom(buildPlanLoadingHtml());
        assert.ok(doc.querySelector('.plan-status-title'));
    });
});

suite('CSS builders', () => {
    test('buildPlanContentCss returns non-empty CSS with expected selectors', () => {
        const css = buildPlanContentCss();
        assert.ok(css.includes('.hnode'));
        assert.ok(css.includes('.hconn'));
        assert.ok(css.includes('.plan-popover'));
        assert.ok(css.includes('.plan-side'));
        assert.ok(css.includes('.hcat-bar'));
        assert.ok(css.includes('.plan-warning-item'));
    });

    test('the flow track wraps onto additional rows instead of forcing a long horizontal scroll', () => {
        const css = buildPlanContentCss();
        assert.ok(
            /\.hflow-track\s*\{[^}]*flex-wrap:\s*wrap/.test(css),
            'expected .hflow-track to wrap, not rely solely on horizontal scroll'
        );
    });

    test('interactive elements have a visible :focus-visible outline for keyboard users', () => {
        const css = buildPlanContentCss();
        assert.ok(/\.hnode:focus-visible\s*\{[^}]*outline/.test(css));
        assert.ok(/\.plan-warning-item:focus-visible\s*\{[^}]*outline/.test(css));
    });

    test('defines the transient jump-highlight ring (finding 8)', () => {
        const css = buildPlanContentCss();
        assert.ok(
            /\.hnode-jumped\s+\.hnode-ring\s*\{[^}]*outline:/.test(css),
            'expected .hnode-jumped .hnode-ring to carry an outline'
        );
    });

    test('defines the temp-object dimming rule (finding 20)', () => {
        const css = buildPlanContentCss();
        assert.ok(
            /\.hnode-sub-temp\s*\{[^}]*opacity:/.test(css),
            'expected .hnode-sub-temp to dim the caption'
        );
    });

    test('the popover is 280px wide, not the old 220px (finding E)', () => {
        const css = buildPlanContentCss();
        assert.ok(
            /\.plan-popover\s*\{[^}]*width:\s*280px/.test(css),
            'expected .plan-popover to be widened to 280px'
        );
        assert.ok(!/\.plan-popover\s*\{[^}]*width:\s*220px/.test(css));
    });

    test('the popover title row keeps a fixed gap: flex layout with the copy button pinned to flex: none (finding E)', () => {
        const css = buildPlanContentCss();
        assert.ok(
            /\.plan-popover-title-row\s*\{[^}]*display:\s*flex[^}]*gap:/.test(css),
            'expected .plan-popover-title-row to be a flex container with a gap'
        );
        assert.ok(
            /\.plan-node-copy\s*\{[^}]*flex:\s*none/.test(css),
            'expected the copy button to be flex: none so it never shrinks/stretches with a long title'
        );
    });

    test('buildPlanStatusCss returns non-empty CSS', () => {
        const css = buildPlanStatusCss();
        assert.ok(css.includes('.plan-status-container'));
    });

    test('the retry button has a visible :focus-visible outline, same as every other interactive control in this feature', () => {
        const css = buildPlanStatusCss();
        assert.ok(/\.plan-retry-btn:focus-visible\s*\{[^}]*outline/.test(css));
    });
});
