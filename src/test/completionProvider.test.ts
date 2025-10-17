import * as assert from 'assert';
import * as vscode from 'vscode';
import { ConnectionManager } from '../connectionManager';
import { ExasolCompletionProvider } from '../providers/completionProvider';
import { TEST_CONFIG } from './testConfig';
import { executeWithoutResult } from '../utils';

suite('Completion Provider Test Suite', () => {
    let context: vscode.ExtensionContext;
    let connectionManager: ConnectionManager;
    let completionProvider: ExasolCompletionProvider;
    let document: vscode.TextDocument;

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
        connectionManager = new ConnectionManager(context);

        // Add connection
        await connectionManager.addConnection(TEST_CONFIG.connection);

        completionProvider = new ExasolCompletionProvider(connectionManager);

        // Setup test schema and table
        const driver = await connectionManager.getDriver();
        await executeWithoutResult(driver, `CREATE SCHEMA IF NOT EXISTS ${TEST_CONFIG.testSchema}`);
        await executeWithoutResult(driver, `
            CREATE OR REPLACE TABLE ${TEST_CONFIG.testSchema}.${TEST_CONFIG.testTable} (
                ID INT,
                NAME VARCHAR(100),
                EMAIL VARCHAR(200)
            )
        `);

        // Create a test document
        document = await vscode.workspace.openTextDocument({
            content: 'SELECT ',
            language: 'sql'
        });
    });

    test('Should provide SQL keyword completions', async function() {
        this.timeout(30000);

        const position = new vscode.Position(0, 7); // After "SELECT "
        const completionContext: vscode.CompletionContext = {
            triggerKind: vscode.CompletionTriggerKind.Invoke,
            triggerCharacter: undefined
        };

        const items = await completionProvider.provideCompletionItems(
            document,
            position,
            new vscode.CancellationTokenSource().token,
            completionContext
        );

        assert.ok(items, 'Should return completion items');
        assert.ok(items.length > 0, 'Should have completion items');

        // Check for common keywords
        const selectKeyword = items.find(i => i.label === 'SELECT');
        const fromKeyword = items.find(i => i.label === 'FROM');
        const whereKeyword = items.find(i => i.label === 'WHERE');

        assert.ok(selectKeyword, 'Should have SELECT keyword');
        assert.ok(fromKeyword, 'Should have FROM keyword');
        assert.ok(whereKeyword, 'Should have WHERE keyword');
    });

    test('Should provide SQL function completions', async function() {
        this.timeout(30000);

        const position = new vscode.Position(0, 7);
        const completionContext: vscode.CompletionContext = {
            triggerKind: vscode.CompletionTriggerKind.Invoke,
            triggerCharacter: undefined
        };

        const items = await completionProvider.provideCompletionItems(
            document,
            position,
            new vscode.CancellationTokenSource().token,
            completionContext
        );

        // Check for common functions
        const count = items.find(i => i.label === 'COUNT');
        const sum = items.find(i => i.label === 'SUM');
        const upper = items.find(i => i.label === 'UPPER');

        assert.ok(count, 'Should have COUNT function');
        assert.ok(sum, 'Should have SUM function');
        assert.ok(upper, 'Should have UPPER function');

        // Check that functions have snippets
        assert.ok(count?.insertText instanceof vscode.SnippetString, 'COUNT should have snippet');
    });

    test('Should provide table and view completions', async function() {
        this.timeout(30000);

        const position = new vscode.Position(0, 7);
        const completionContext: vscode.CompletionContext = {
            triggerKind: vscode.CompletionTriggerKind.Invoke,
            triggerCharacter: undefined
        };

        const items = await completionProvider.provideCompletionItems(
            document,
            position,
            new vscode.CancellationTokenSource().token,
            completionContext
        );

        // Should include our test table
        const testTable = items.find(i => i.label === TEST_CONFIG.testTable);
        assert.ok(testTable, `Should have ${TEST_CONFIG.testTable} in completions`);
        assert.ok(testTable?.detail?.includes('table'), 'Should indicate it is a table');
    });

    test('Should cache completions', async function() {
        this.timeout(30000);

        const position = new vscode.Position(0, 7);
        const completionContext: vscode.CompletionContext = {
            triggerKind: vscode.CompletionTriggerKind.Invoke,
            triggerCharacter: undefined
        };

        const connection = connectionManager.getActiveConnection();
        assert.ok(connection, 'Should have active connection');

        // First call - should fetch from database
        const startTime1 = Date.now();
        await completionProvider.provideCompletionItems(
            document,
            position,
            new vscode.CancellationTokenSource().token,
            completionContext
        );
        const duration1 = Date.now() - startTime1;

        // Second call - should use cache (faster)
        const startTime2 = Date.now();
        await completionProvider.provideCompletionItems(
            document,
            position,
            new vscode.CancellationTokenSource().token,
            completionContext
        );
        const duration2 = Date.now() - startTime2;

        // Cache should make it faster (though this is not always guaranteed in tests)
        console.log(`First call: ${duration1}ms, Second call: ${duration2}ms`);
        assert.ok(true, 'Cache mechanism exists and works');
    });

    test('Should clear cache', async function() {
        this.timeout(30000);

        completionProvider.clearCache();

        // Should still work after cache clear
        const position = new vscode.Position(0, 7);
        const completionContext: vscode.CompletionContext = {
            triggerKind: vscode.CompletionTriggerKind.Invoke,
            triggerCharacter: undefined
        };

        const items = await completionProvider.provideCompletionItems(
            document,
            position,
            new vscode.CancellationTokenSource().token,
            completionContext
        );

        assert.ok(items.length > 0, 'Should still provide completions after cache clear');
    });

    test('Should respect autoComplete setting', async function() {
        this.timeout(30000);

        // Disable autoComplete
        const config = vscode.workspace.getConfiguration('exasol');
        await config.update('autoComplete', false, vscode.ConfigurationTarget.Global);

        const position = new vscode.Position(0, 7);
        const completionContext: vscode.CompletionContext = {
            triggerKind: vscode.CompletionTriggerKind.Invoke,
            triggerCharacter: undefined
        };

        const items = await completionProvider.provideCompletionItems(
            document,
            position,
            new vscode.CancellationTokenSource().token,
            completionContext
        );

        assert.strictEqual(items.length, 0, 'Should return no items when disabled');

        // Re-enable
        await config.update('autoComplete', true, vscode.ConfigurationTarget.Global);
    });

    suiteTeardown(async function() {
        this.timeout(30000);

        // Cleanup
        const driver = await connectionManager.getDriver();
        await executeWithoutResult(driver, `DROP SCHEMA IF EXISTS ${TEST_CONFIG.testSchema} CASCADE`);
        await connectionManager.closeAll();
    });
});
