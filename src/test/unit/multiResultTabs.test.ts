import * as assert from 'assert';
import { TabManager, TabResult, TabState } from '../../panels/tabManager';
import { QueryResult } from '../../queryExecutor';

function makeQueryResult(columns: string[] = ['col1'], rows: any[][] = [[1]]): QueryResult {
    return {
        columns,
        columnMetadata: columns.map(name => ({ name, type: 'VARCHAR' })),
        rows,
        rowCount: rows.length,
        executionTime: 10
    };
}

function makeTab(index: number, opts?: { error?: string }): TabResult {
    const label = `Result ${index}`;
    if (opts?.error) {
        return { label, error: opts.error };
    }
    return { label, result: makeQueryResult() };
}

suite('TabManager', () => {

    suite('label generation', () => {
        test('tabs are labeled "Result 1", "Result 2", etc.', () => {
            const manager = new TabManager();
            const tabs: TabResult[] = [
                makeTab(1),
                makeTab(2),
                makeTab(3)
            ];
            manager.setTabs(tabs);

            const stored = manager.getTabs();
            assert.strictEqual(stored[0].label, 'Result 1');
            assert.strictEqual(stored[1].label, 'Result 2');
            assert.strictEqual(stored[2].label, 'Result 3');
        });
    });

    suite('active tab management', () => {
        test('first tab is selected by default after setTabs', () => {
            const manager = new TabManager();
            manager.setTabs([makeTab(1), makeTab(2)]);

            const active = manager.getActiveTab();
            assert.ok(active);
            assert.strictEqual(active.label, 'Result 1');
            assert.strictEqual(manager.getActiveIndex(), 0);
        });

        test('switchTab changes the active tab', () => {
            const manager = new TabManager();
            manager.setTabs([makeTab(1), makeTab(2), makeTab(3)]);

            manager.switchTab(2);
            const active = manager.getActiveTab();
            assert.ok(active);
            assert.strictEqual(active.label, 'Result 3');
            assert.strictEqual(manager.getActiveIndex(), 2);
        });

        test('switchTab to out-of-range index does not change active tab', () => {
            const manager = new TabManager();
            manager.setTabs([makeTab(1), makeTab(2)]);

            manager.switchTab(5);
            assert.strictEqual(manager.getActiveIndex(), 0);

            manager.switchTab(-1);
            assert.strictEqual(manager.getActiveIndex(), 0);
        });

        test('getActiveTab returns undefined when no tabs are set', () => {
            const manager = new TabManager();
            const active = manager.getActiveTab();
            assert.strictEqual(active, undefined);
        });
    });

    suite('tab bar visibility', () => {
        test('single result produces no tab bar', () => {
            const manager = new TabManager();
            manager.setTabs([makeTab(1)]);

            assert.strictEqual(manager.shouldShowTabBar(), false);
        });

        test('multiple results show tab bar', () => {
            const manager = new TabManager();
            manager.setTabs([makeTab(1), makeTab(2)]);

            assert.strictEqual(manager.shouldShowTabBar(), true);
        });

        test('no tabs means no tab bar', () => {
            const manager = new TabManager();
            assert.strictEqual(manager.shouldShowTabBar(), false);
        });
    });

    suite('new execution replaces all existing tabs', () => {
        test('setTabs replaces previous tabs entirely', () => {
            const manager = new TabManager();
            manager.setTabs([makeTab(1), makeTab(2), makeTab(3)]);
            assert.strictEqual(manager.getTabs().length, 3);

            manager.setTabs([makeTab(1)]);
            assert.strictEqual(manager.getTabs().length, 1);
            assert.strictEqual(manager.getTabs()[0].label, 'Result 1');
        });

        test('setTabs resets active index to 0', () => {
            const manager = new TabManager();
            manager.setTabs([makeTab(1), makeTab(2), makeTab(3)]);
            manager.switchTab(2);
            assert.strictEqual(manager.getActiveIndex(), 2);

            manager.setTabs([makeTab(1), makeTab(2)]);
            assert.strictEqual(manager.getActiveIndex(), 0);
        });
    });

    suite('removeTab', () => {
        test('removes a tab by index', () => {
            const manager = new TabManager();
            manager.setTabs([makeTab(1), makeTab(2), makeTab(3)]);
            manager.removeTab(1);

            assert.strictEqual(manager.getTabs().length, 2);
            assert.strictEqual(manager.getTabs()[0].label, 'Result 1');
            assert.strictEqual(manager.getTabs()[1].label, 'Result 3');
        });

        test('adjusts active index when removing tab before it', () => {
            const manager = new TabManager();
            manager.setTabs([makeTab(1), makeTab(2), makeTab(3)]);
            manager.switchTab(2);
            manager.removeTab(0);

            assert.strictEqual(manager.getActiveIndex(), 1);
            assert.strictEqual(manager.getActiveTab()?.label, 'Result 3');
        });

        test('clamps active index when removing the last tab', () => {
            const manager = new TabManager();
            manager.setTabs([makeTab(1), makeTab(2)]);
            manager.switchTab(1);
            manager.removeTab(1);

            assert.strictEqual(manager.getActiveIndex(), 0);
            assert.strictEqual(manager.getActiveTab()?.label, 'Result 1');
        });

        test('removing the only tab leaves empty state', () => {
            const manager = new TabManager();
            manager.setTabs([makeTab(1)]);
            manager.removeTab(0);

            assert.strictEqual(manager.getTabs().length, 0);
            assert.strictEqual(manager.shouldShowTabBar(), false);
        });
    });

    suite('clearTabs', () => {
        test('clearTabs removes all tabs', () => {
            const manager = new TabManager();
            manager.setTabs([makeTab(1), makeTab(2)]);
            manager.clearTabs();

            assert.strictEqual(manager.getTabs().length, 0);
            assert.strictEqual(manager.getActiveTab(), undefined);
            assert.strictEqual(manager.shouldShowTabBar(), false);
        });
    });

    suite('error tab', () => {
        test('error tab has error property set and no result', () => {
            const manager = new TabManager();
            const errorTab: TabResult = { label: 'Result 2', error: 'syntax error at line 1' };
            manager.setTabs([makeTab(1), errorTab, makeTab(3)]);

            manager.switchTab(1);
            const active = manager.getActiveTab();
            assert.ok(active);
            assert.strictEqual(active.error, 'syntax error at line 1');
            assert.strictEqual(active.result, undefined);
        });

        test('non-error tab has result property and no error', () => {
            const manager = new TabManager();
            manager.setTabs([makeTab(1)]);

            const active = manager.getActiveTab();
            assert.ok(active);
            assert.ok(active.result);
            assert.strictEqual(active.error, undefined);
        });
    });

    suite('per-tab state tracking', () => {
        test('each tab starts with default state', () => {
            const manager = new TabManager();
            manager.setTabs([makeTab(1), makeTab(2)]);

            const state = manager.getTabState(0);
            assert.strictEqual(state.sortColumn, null);
            assert.strictEqual(state.sortDirection, null);
            assert.strictEqual(state.filterText, '');
            assert.strictEqual(state.scrollPosition, 0);
        });

        test('updateTabState persists sort/filter/scroll independently per tab', () => {
            const manager = new TabManager();
            manager.setTabs([makeTab(1), makeTab(2)]);

            manager.updateTabState(0, { sortColumn: 'col1', sortDirection: 'asc' });
            manager.updateTabState(1, { filterText: 'search term', scrollPosition: 150 });

            const state0 = manager.getTabState(0);
            assert.strictEqual(state0.sortColumn, 'col1');
            assert.strictEqual(state0.sortDirection, 'asc');
            assert.strictEqual(state0.filterText, '');
            assert.strictEqual(state0.scrollPosition, 0);

            const state1 = manager.getTabState(1);
            assert.strictEqual(state1.sortColumn, null);
            assert.strictEqual(state1.sortDirection, null);
            assert.strictEqual(state1.filterText, 'search term');
            assert.strictEqual(state1.scrollPosition, 150);
        });

        test('tab state is preserved when switching between tabs', () => {
            const manager = new TabManager();
            manager.setTabs([makeTab(1), makeTab(2)]);

            manager.updateTabState(0, { sortColumn: 'id', sortDirection: 'desc' });
            manager.switchTab(1);
            manager.updateTabState(1, { filterText: 'active' });
            manager.switchTab(0);

            const state0 = manager.getTabState(0);
            assert.strictEqual(state0.sortColumn, 'id');
            assert.strictEqual(state0.sortDirection, 'desc');
        });

        test('setTabs resets all tab states', () => {
            const manager = new TabManager();
            manager.setTabs([makeTab(1)]);
            manager.updateTabState(0, { sortColumn: 'col1', sortDirection: 'asc' });

            manager.setTabs([makeTab(1), makeTab(2)]);
            const state0 = manager.getTabState(0);
            assert.strictEqual(state0.sortColumn, null);
            assert.strictEqual(state0.sortDirection, null);
        });
    });
});
