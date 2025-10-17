import * as assert from 'assert';
import * as vscode from 'vscode';
import { ConnectionManager } from '../connectionManager';
import { QueryExecutor } from '../queryExecutor';
import { TEST_CONFIG } from './testConfig';
import { executeWithoutResult } from '../utils';

suite('QueryExecutor Test Suite', () => {
    let context: vscode.ExtensionContext;
    let connectionManager: ConnectionManager;
    let queryExecutor: QueryExecutor;

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

        queryExecutor = new QueryExecutor(connectionManager);

        const driver = await connectionManager.getDriver();
        await executeWithoutResult(driver, `CREATE SCHEMA IF NOT EXISTS ${TEST_CONFIG.testSchema}`);
    });

    test('Should execute simple SELECT query', async function() {
        this.timeout(30000);

        const result = await queryExecutor.execute('SELECT 1 AS COL1, 2 AS COL2');

        assert.ok(result, 'Should return result');
        assert.ok(result.columns, 'Should have columns');
        assert.strictEqual(result.columns.length, 2, 'Should have 2 columns');
        assert.strictEqual(result.columns[0], 'COL1');
        assert.strictEqual(result.columns[1], 'COL2');
        assert.strictEqual(result.rowCount, 1, 'Should return 1 row');
        assert.ok(result.executionTime >= 0, 'Should have execution time');
    });

    test('Should auto-add LIMIT to SELECT queries', async function() {
        this.timeout(30000);

        // Create a test table with more rows than the limit
        const driver = await connectionManager.getDriver();
        await executeWithoutResult(driver, `
            CREATE OR REPLACE TABLE ${TEST_CONFIG.testSchema}.LIMIT_TEST (
                ID INT
            )
        `);

        // Insert many rows
        for (let i = 0; i < 100; i++) {
            await executeWithoutResult(driver, `INSERT INTO ${TEST_CONFIG.testSchema}.LIMIT_TEST VALUES (${i})`);
        }

        // Query without LIMIT
        const result = await queryExecutor.execute(`SELECT * FROM ${TEST_CONFIG.testSchema}.LIMIT_TEST`);

        // Should be limited by default (10000)
        assert.ok(result.rowCount <= 10000, 'Should respect max rows limit');

        // Cleanup
        await executeWithoutResult(driver, `DROP TABLE ${TEST_CONFIG.testSchema}.LIMIT_TEST`);
    });

    test('Should handle query with cancellation token', async function() {
        this.timeout(30000);

        const cancellationTokenSource = new vscode.CancellationTokenSource();

        const result = await queryExecutor.execute(
            'SELECT 1 AS TEST',
            cancellationTokenSource.token
        );

        assert.ok(result, 'Should execute successfully with cancellation token');
        assert.strictEqual(result.rowCount, 1);

        cancellationTokenSource.dispose();
    });

    test('Should handle query errors gracefully', async function() {
        this.timeout(30000);

        try {
            await queryExecutor.execute('SELECT * FROM NON_EXISTENT_TABLE');
            assert.fail('Should have thrown an error');
        } catch (error) {
            assert.ok(error, 'Should throw error for invalid query');
            assert.ok(String(error).includes('failed'), 'Error message should indicate failure');
        }
    });

    test('Should report error when no active connection', async function() {
        this.timeout(30000);

        const cm = new ConnectionManager(context);
        const qe = new QueryExecutor(cm);
        try {
            await qe.execute('SELECT 1');
            assert.fail('Should fail without connection');
        } catch (error) {
            assert.ok(String(error).includes('No active connection'), 'Should report missing connection');
        }
    });

    test('Should execute DDL statements', async function() {
        this.timeout(30000);

        const result = await queryExecutor.execute(`
            CREATE OR REPLACE TABLE ${TEST_CONFIG.testSchema}.DDL_TEST (
                ID INT,
                NAME VARCHAR(100)
            )
        `);

        assert.ok(result, 'Should execute DDL');

        // Cleanup
        const driver = await connectionManager.getDriver();
        await executeWithoutResult(driver, `DROP TABLE ${TEST_CONFIG.testSchema}.DDL_TEST`);
    });

    test('Should execute INSERT/UPDATE/DELETE', async function() {
        this.timeout(30000);

        // Create table
        await queryExecutor.execute(`
            CREATE OR REPLACE TABLE ${TEST_CONFIG.testSchema}.DML_TEST (
                ID INT,
                VAL VARCHAR(100)
            )
        `);

        // Insert
        const insertResult = await queryExecutor.execute(
            `INSERT INTO ${TEST_CONFIG.testSchema}.DML_TEST VALUES (1, 'Test')`
        );
        assert.ok(insertResult, 'Should execute INSERT');

        // Update
        const updateResult = await queryExecutor.execute(
            `UPDATE ${TEST_CONFIG.testSchema}.DML_TEST SET VAL = 'Updated' WHERE ID = 1`
        );
        assert.ok(updateResult, 'Should execute UPDATE');

        // Verify
        const selectResult = await queryExecutor.execute(
            `SELECT * FROM ${TEST_CONFIG.testSchema}.DML_TEST WHERE ID = 1`
        );
        assert.strictEqual(selectResult.rowCount, 1);
        assert.strictEqual(selectResult.rows[0].VAL, 'Updated');

        // Delete
        const deleteResult = await queryExecutor.execute(
            `DELETE FROM ${TEST_CONFIG.testSchema}.DML_TEST WHERE ID = 1`
        );
        assert.ok(deleteResult, 'Should execute DELETE');

        // Cleanup
        await queryExecutor.execute(`DROP TABLE ${TEST_CONFIG.testSchema}.DML_TEST`);
    });

    suiteTeardown(async function() {
        this.timeout(30000);
        await connectionManager.closeAll();
    });
});
