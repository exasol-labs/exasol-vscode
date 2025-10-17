import * as assert from 'assert';
import * as vscode from 'vscode';
import { QueryHistoryProvider } from '../providers/queryHistoryProvider';

suite('QueryHistoryProvider Test Suite', () => {
    let context: vscode.ExtensionContext;
    let provider: QueryHistoryProvider;

    suiteSetup(async function() {
        this.timeout(60000);
        const ext = vscode.extensions.getExtension('exasol.exasol-vscode');
        if (!ext) {
            throw new Error('Extension not found');
        }
        if (!ext.isActive) {
            await ext.activate();
        }
        context = (ext.exports as any).context;
    });

    setup(function() {
        // Clear any existing history
        context.globalState.update('exasol.queryHistory', undefined);
        provider = new QueryHistoryProvider(context);
    });

    test('Should initialize with empty history', async function() {
        const children = await provider.getChildren();
        assert.strictEqual(children.length, 0, 'Should start with empty history');
    });

    test('Should add query to history', async function() {
        provider.addQuery('SELECT 1', 1);

        const children = await provider.getChildren();
        assert.strictEqual(children.length, 1, 'Should have one query in history');
        assert.ok(children[0].query.includes('SELECT 1'), 'Should store the query text');
    });

    test('Should add multiple queries to history', async function() {
        provider.addQuery('SELECT 1', 1);
        provider.addQuery('SELECT 2', 2);
        provider.addQuery('SELECT 3', 3);

        const children = await provider.getChildren();
        assert.strictEqual(children.length, 3, 'Should have three queries in history');
    });

    test('Should show most recent query first', async function() {
        provider.addQuery('SELECT 1', 1);
        provider.addQuery('SELECT 2', 2);

        const children = await provider.getChildren();
        assert.ok(children[0].query.includes('SELECT 2'), 'Most recent query should be first');
        assert.ok(children[1].query.includes('SELECT 1'), 'Older query should be second');
    });

    test('Should store query row count', async function() {
        provider.addQuery('SELECT 1', 42);

        const children = await provider.getChildren();
        assert.strictEqual(children[0].description, '42 rows', 'Should show row count');
    });

    test('Should store query error', async function() {
        provider.addQuery('SELECT * FROM INVALID', 0, 'Table not found');

        const children = await provider.getChildren();
        assert.strictEqual(children[0].description, 'Error', 'Should show error status');
        assert.ok(children[0].hasError, 'Should mark as error');
    });

    test('Should truncate long queries in label', async function() {
        const longQuery = 'SELECT ' + 'A,'.repeat(100) + ' FROM TABLE';
        provider.addQuery(longQuery, 1);

        const children = await provider.getChildren();
        assert.ok(children[0].label.length < longQuery.length, 'Label should be truncated');
        assert.ok(children[0].label.includes('...'), 'Label should show ellipsis');
        assert.strictEqual(children[0].query, longQuery.trim(), 'Full query should be stored in tooltip');
    });

    test('Should respect max history size', async function() {
        // Add more than default max (1000)
        for (let i = 0; i < 1100; i++) {
            provider.addQuery(`SELECT ${i}`, i);
        }

        const children = await provider.getChildren();
        assert.strictEqual(children.length, 1000, 'Should respect max history size of 1000');
    });

    test('Should clear history', async function() {
        provider.addQuery('SELECT 1', 1);
        provider.addQuery('SELECT 2', 2);

        let children = await provider.getChildren();
        assert.ok(children.length > 0, 'Should have queries before clear');

        provider.clearHistory();

        children = await provider.getChildren();
        assert.strictEqual(children.length, 0, 'Should have no queries after clear');
    });

    test('Should persist history across instances', async function() {
        provider.addQuery('SELECT 1', 1);
        provider.addQuery('SELECT 2', 2);

        // Create new provider (simulates extension restart)
        const newProvider = new QueryHistoryProvider(context);
        const children = await newProvider.getChildren();

        assert.strictEqual(children.length, 2, 'History should persist');
        assert.ok(children[0].query.includes('SELECT 2'), 'Should load queries in correct order');
    });

    test('Should trim whitespace from queries', async function() {
        provider.addQuery('  SELECT 1  \n\n  ', 1);

        const children = await provider.getChildren();
        assert.strictEqual(children[0].query, 'SELECT 1', 'Should trim whitespace');
    });

    test('Should have correct tree item properties', async function() {
        provider.addQuery('SELECT 1', 1);

        const children = await provider.getChildren();
        const item = provider.getTreeItem(children[0]);

        assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.None, 'Should not be collapsible');
        assert.strictEqual(item.contextValue, 'queryHistoryItem', 'Should have correct context value');
        assert.ok(item.command, 'Should have command');
        assert.strictEqual(item.command?.command, 'exasol.openQueryFromHistory', 'Should have correct command');
    });

    test('Should show success icon for successful queries', async function() {
        provider.addQuery('SELECT 1', 1);

        const children = await provider.getChildren();
        const item = provider.getTreeItem(children[0]);

        assert.ok(item.iconPath, 'Should have icon');
        assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'pass', 'Should show pass icon');
    });

    test('Should show error icon for failed queries', async function() {
        provider.addQuery('SELECT * FROM INVALID', 0, 'Error');

        const children = await provider.getChildren();
        const item = provider.getTreeItem(children[0]);

        assert.ok(item.iconPath, 'Should have icon');
        assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'error', 'Should show error icon');
    });

    test('Should format timestamp in label', async function() {
        provider.addQuery('SELECT 1', 1);

        const children = await provider.getChildren();
        // Label should start with time like "10:30:45"
        assert.ok(/^\d{1,2}:\d{2}:\d{2}/.test(children[0].label), 'Label should start with timestamp');
    });

    test('Should use query as tooltip', async function() {
        const query = 'SELECT * FROM TABLE WHERE ID = 1';
        provider.addQuery(query, 1);

        const children = await provider.getChildren();
        const item = provider.getTreeItem(children[0]);

        assert.strictEqual(item.tooltip, query, 'Tooltip should show full query');
    });

    test('Should handle empty query gracefully', async function() {
        provider.addQuery('', 0);

        const children = await provider.getChildren();
        assert.strictEqual(children.length, 1, 'Should add empty query');
        assert.strictEqual(children[0].query, '', 'Should store empty string');
    });

    teardown(function() {
        // Clean up
        context.globalState.update('exasol.queryHistory', undefined);
    });
});
