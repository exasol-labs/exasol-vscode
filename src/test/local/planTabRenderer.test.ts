import * as assert from 'assert';
import { JSDOM } from 'jsdom';
import { buildResultPlanTabBarHtml, buildResultPlanTabBarCss } from '../../panels/planTabRenderer';

function parseDom(html: string): Document {
    return new JSDOM(`<html><body>${html}</body></html>`).window.document;
}

suite('buildResultPlanTabBarHtml', () => {

    test('renders exactly two tabs: Results and Plan', () => {
        const doc = parseDom(buildResultPlanTabBarHtml('results', 'idle', 'n0nce'));
        const tabs = doc.querySelectorAll('.rv-tab');
        assert.strictEqual(tabs.length, 2);
        assert.strictEqual(tabs[0].querySelector('.rv-tab-label')!.textContent, 'Results');
        assert.strictEqual(tabs[1].querySelector('.rv-tab-label')!.textContent, 'Plan');
    });

    test('marks the Results tab active when activeView is results', () => {
        const doc = parseDom(buildResultPlanTabBarHtml('results', 'idle', 'n0nce'));
        const tabs = doc.querySelectorAll('.rv-tab');
        assert.ok(tabs[0].classList.contains('active'));
        assert.ok(!tabs[1].classList.contains('active'));
    });

    test('marks the Plan tab active when activeView is plan', () => {
        const doc = parseDom(buildResultPlanTabBarHtml('plan', 'ready', 'n0nce'));
        const tabs = doc.querySelectorAll('.rv-tab');
        assert.ok(!tabs[0].classList.contains('active'));
        assert.ok(tabs[1].classList.contains('active'));
    });

    test('shows a loading label while the plan is being fetched', () => {
        const doc = parseDom(buildResultPlanTabBarHtml('plan', 'loading', 'n0nce'));
        const planLabel = doc.querySelectorAll('.rv-tab-label')[1].textContent;
        assert.ok(planLabel!.includes('loading'));
    });

    test('applies the error class to the Plan tab when planStatus is error', () => {
        const doc = parseDom(buildResultPlanTabBarHtml('plan', 'error', 'n0nce'));
        const tabs = doc.querySelectorAll('.rv-tab');
        assert.ok(!tabs[0].classList.contains('error'));
        assert.ok(tabs[1].classList.contains('error'));
    });

    test('tabs carry the correct data-view attribute for click handling', () => {
        const doc = parseDom(buildResultPlanTabBarHtml('results', 'idle', 'n0nce'));
        const tabs = doc.querySelectorAll('.rv-tab');
        assert.strictEqual(tabs[0].getAttribute('data-view'), 'results');
        assert.strictEqual(tabs[1].getAttribute('data-view'), 'plan');
    });

    test('uses rv-tab / rv-tab-bar classes, never the unrelated tab/tab-bar classes', () => {
        // These must stay distinct from tabBarRenderer.ts's classes so
        // resultsGrid.tsx's generic .tab click handler never intercepts clicks
        // meant for this tab strip.
        const html = buildResultPlanTabBarHtml('results', 'idle', 'n0nce');
        const doc = parseDom(html);
        assert.strictEqual(doc.querySelectorAll('.tab').length, 0);
        assert.strictEqual(doc.querySelectorAll('.tab-bar').length, 0);
    });

    test('the inline script carries the provided nonce', () => {
        const html = buildResultPlanTabBarHtml('results', 'idle', 'abc123');
        assert.ok(html.includes('nonce="abc123"'));
    });
});

suite('buildResultPlanTabBarCss', () => {
    test('returns non-empty CSS with the expected selectors', () => {
        const css = buildResultPlanTabBarCss();
        assert.ok(css.includes('.rv-tab-bar'));
        assert.ok(css.includes('.rv-tab.active'));
        assert.ok(css.includes('.rv-tab.error'));
    });
});
