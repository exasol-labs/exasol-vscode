import * as assert from 'assert';
import * as vscode from 'vscode';
import { ConnectionManager } from '../connectionManager';
import { SessionManager } from '../sessionManager';
import { TEST_CONFIG } from './testConfig';
import { executeWithoutResult } from '../utils';

suite('SessionManager Test Suite', () => {
    let context: vscode.ExtensionContext;
    let connectionManager: ConnectionManager;
    let sessionManager: SessionManager;
    let connectionId: string;

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
        connectionId = await connectionManager.addConnection(TEST_CONFIG.connection);
        await connectionManager.setActiveConnection(connectionId);

        sessionManager = new SessionManager(connectionManager, context);

        // Setup test schema
        const driver = await connectionManager.getDriver();
        await executeWithoutResult(driver, `CREATE SCHEMA IF NOT EXISTS ${TEST_CONFIG.testSchema}`);
    });

    test('Should initialize with no schema', function() {
        const schema = sessionManager.getCurrentSchema();
        assert.strictEqual(schema, undefined, 'Initial schema should be undefined');
    });

    test('Should set active schema', async function() {
        this.timeout(30000);

        await sessionManager.setSchema(TEST_CONFIG.testSchema);

        const currentSchema = sessionManager.getCurrentSchema();
        assert.strictEqual(currentSchema, TEST_CONFIG.testSchema, 'Schema should be set');
    });

    test('Should get status bar text with connection', function() {
        const statusText = sessionManager.getStatusBarText();
        assert.ok(statusText.includes('Exasol:'), 'Status should include Exasol prefix');
        assert.ok(statusText.includes(TEST_CONFIG.connection.name), 'Status should include connection name');
    });

    test('Should get status bar text with connection and schema', async function() {
        this.timeout(30000);

        await sessionManager.setSchema(TEST_CONFIG.testSchema);

        const statusText = sessionManager.getStatusBarText();
        assert.ok(statusText.includes(TEST_CONFIG.connection.name), 'Status should include connection name');
        assert.ok(statusText.includes(TEST_CONFIG.testSchema), 'Status should include schema name');
        assert.ok(statusText.includes('Schema:'), 'Status should have Schema label');
    });

    test('Should refresh session from database', async function() {
        this.timeout(30000);

        // Set a schema
        await sessionManager.setSchema(TEST_CONFIG.testSchema);

        // Refresh should maintain the schema
        await sessionManager.refreshSession();

        const currentSchema = sessionManager.getCurrentSchema();
        assert.strictEqual(currentSchema, TEST_CONFIG.testSchema, 'Schema should be refreshed');
    });

    test('Should clear session', async function() {
        this.timeout(30000);

        // Set a schema first
        await sessionManager.setSchema(TEST_CONFIG.testSchema);
        assert.strictEqual(sessionManager.getCurrentSchema(), TEST_CONFIG.testSchema);

        // Clear it
        await sessionManager.clearSession();

        const currentSchema = sessionManager.getCurrentSchema();
        assert.strictEqual(currentSchema, undefined, 'Schema should be cleared');
    });

    test('Should persist session across instances', async function() {
        this.timeout(30000);

        // Set schema
        await sessionManager.setSchema(TEST_CONFIG.testSchema);

        // Create new session manager (simulates extension restart)
        const newSessionManager = new SessionManager(connectionManager, context);

        // Should load the saved schema
        const currentSchema = newSessionManager.getCurrentSchema();
        assert.strictEqual(currentSchema, TEST_CONFIG.testSchema, 'Schema should persist');
    });

    test('Should fire event when session changes', async function() {
        this.timeout(30000);

        let eventFired = false;
        const disposable = sessionManager.onDidChangeSession(() => {
            eventFired = true;
        });

        await sessionManager.setSchema(TEST_CONFIG.testSchema);

        assert.ok(eventFired, 'Event should fire when session changes');
        disposable.dispose();
    });

    test('Should handle error when no active connection', async function() {
        this.timeout(30000);

        const cm = new ConnectionManager(context);
        const sm = new SessionManager(cm, context);

        try {
            await sm.setSchema(TEST_CONFIG.testSchema);
            assert.fail('Should throw error when no active connection');
        } catch (error) {
            assert.ok(String(error).includes('No active connection'));
        }

        await cm.closeAll();
    });

    test('Should handle invalid schema name', async function() {
        this.timeout(30000);

        try {
            await sessionManager.setSchema('INVALID_SCHEMA_DOES_NOT_EXIST');
            assert.fail('Should throw error for invalid schema');
        } catch (error) {
            assert.ok(error, 'Should throw error for invalid schema');
        }
    });

    test('Should show "No connection" in status when no connection', function() {
        const cm = new ConnectionManager(context);
        const sm = new SessionManager(cm, context);

        const statusText = sm.getStatusBarText();
        assert.ok(statusText.includes('No connection'), 'Status should indicate no connection');
    });

    suiteTeardown(async function() {
        this.timeout(30000);
        const driver = await connectionManager.getDriver();
        await executeWithoutResult(driver, `DROP SCHEMA IF EXISTS ${TEST_CONFIG.testSchema} CASCADE`);
        await connectionManager.closeAll();
    });
});
