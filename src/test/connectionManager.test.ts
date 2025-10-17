import * as assert from 'assert';
import * as vscode from 'vscode';
import { ConnectionManager } from '../connectionManager';
import { TEST_CONFIG } from './testConfig';
import { getRowsFromResult } from '../utils';

suite('ConnectionManager Test Suite', () => {
    let context: vscode.ExtensionContext;
    let connectionManager: ConnectionManager;

    suiteSetup(async function() {
        this.timeout(60000);
        // Get extension context
        const ext = vscode.extensions.getExtension('exasol.exasol-vscode');
        if (!ext) {
            throw new Error('Extension not found');
        }
        if (!ext.isActive) {
            await ext.activate();
        }
        context = (ext.exports as any).context;
        connectionManager = new ConnectionManager(context);
    });

    test('Should add connection successfully', async function() {
        this.timeout(30000);

        const connectionId = await connectionManager.addConnection(TEST_CONFIG.connection);

        assert.ok(connectionId, 'Connection ID should be returned');
        assert.ok(connectionId.includes(TEST_CONFIG.connection.name), 'Connection ID should contain name');

        const connections = connectionManager.getConnections();
        assert.ok(connections.length > 0, 'Should have at least one connection');

        const addedConnection = connections.find(c => c.id === connectionId);
        assert.ok(addedConnection, 'Added connection should be found');
        assert.strictEqual(addedConnection?.name, TEST_CONFIG.connection.name);
        assert.strictEqual(addedConnection?.host, TEST_CONFIG.connection.host);
        assert.strictEqual(addedConnection?.user, TEST_CONFIG.connection.user);
    });

    test('Should get active connection', async function() {
        this.timeout(30000);

        const activeConnection = connectionManager.getActiveConnection();
        assert.ok(activeConnection, 'Should have an active connection');
        assert.strictEqual(activeConnection?.name, TEST_CONFIG.connection.name);
    });

    test('Should get driver for active connection', async function() {
        this.timeout(30000);

        const driver = await connectionManager.getDriver();
        assert.ok(driver, 'Should get driver');

        // Test driver with a simple query
        const result = await driver.query('SELECT 1 AS TEST_COL');
        const rows = getRowsFromResult(result);
        assert.strictEqual(rows.length, 1, 'Should return one row');
        assert.strictEqual(rows[0].TEST_COL, 1, 'Should return correct value');
    });

    test('Should test connection successfully', async function() {
        this.timeout(30000);

        // This should not throw
        await connectionManager.addConnection({
            name: 'Test Connection 2',
            host: 'localhost:8563',
            user: 'sys',
            password: 'exasol'
        });
    });

    test('Should fail with invalid credentials', async function() {
        this.timeout(30000);

        try {
            await connectionManager.addConnection({
                name: 'Invalid Connection',
                host: 'localhost:8563',
                user: 'invalid',
                password: 'invalid'
            });
            assert.fail('Should have thrown an error');
        } catch (error) {
            assert.ok(error, 'Should throw error for invalid credentials');
        }
    });

    test('Should store password securely', async function() {
        this.timeout(30000);

        const connections = connectionManager.getConnections();
        assert.ok(connections.length > 0, 'Should have connections');

        // Check that password is available in memory
        const conn = connections[0];
        assert.ok(conn.password, 'Password should be available');

        // Check that password is stored securely
        const storedPassword = await context.secrets.get(`exasol.password.${conn.id}`);
        assert.ok(storedPassword, 'Password should be in secure storage');
        assert.strictEqual(storedPassword, conn.password, 'Stored password should match');
    });

    test('Should set first connection as active on load', async function() {
        this.timeout(30000);

        const cm = new ConnectionManager(context);
        await new Promise(resolve => setTimeout(resolve, 50));
        const active = cm.getActiveConnection();
        assert.ok(active, 'Should activate first stored connection');
        await cm.closeAll();
    });

    suiteTeardown(async function() {
        this.timeout(30000);
        await connectionManager.closeAll();
    });
});
