import * as assert from 'assert';
import * as vscode from 'vscode';
import { executeWithoutResult } from '../utils';
import { ConnectionManager } from '../connectionManager';
import type { activate } from '../extension';
import { TEST_CONFIG } from './testConfig';

suite('Utils Test Suite', () => {
    let context: vscode.ExtensionContext;
    let connectionManager: ConnectionManager;

    suiteSetup(async function() {
        this.timeout(60000);
        const ext = vscode.extensions.getExtension<ReturnType<typeof activate>>('exasol.exasol-vscode');
        if (!ext) {
            throw new Error('Extension not found');
        }
        if (!ext.isActive) {
            await ext.activate();
        }
        context = ext.exports.context;
        connectionManager = new ConnectionManager(context);
        await connectionManager.addConnection(TEST_CONFIG.connection);
    });

    // getRowsFromResult / getColumnsFromResult are pure functions with no
    // driver dependency; their tests live in
    // src/test/unit/driverExtractors.test.ts so they actually run under
    // `npm run test:unit` (this file imports vscode and lives outside the
    // src/test/unit/** glob, so mocha never executes it there).

    suite('executeWithoutResult', () => {
        test('Should execute DDL statement', async function() {
            this.timeout(30000);

            const driver = await connectionManager.getDriver();
            const result = await executeWithoutResult(driver, `
                CREATE SCHEMA IF NOT EXISTS ${TEST_CONFIG.testSchema}
            `);

            assert.ok(result, 'Should return result');
            assert.strictEqual(result.status, 'ok', 'Status should be ok');
        });

        test('Should execute CREATE TABLE statement', async function() {
            this.timeout(30000);

            const driver = await connectionManager.getDriver();

            // First ensure schema exists
            await executeWithoutResult(driver, `CREATE SCHEMA IF NOT EXISTS ${TEST_CONFIG.testSchema}`);

            // Create table
            const result = await executeWithoutResult(driver, `
                CREATE OR REPLACE TABLE ${TEST_CONFIG.testSchema}.UTILS_TEST (
                    ID INT,
                    NAME VARCHAR(100)
                )
            `);

            assert.ok(result, 'Should return result');
            assert.strictEqual(result.status, 'ok', 'Status should be ok');

            // Cleanup
            await executeWithoutResult(driver, `DROP TABLE ${TEST_CONFIG.testSchema}.UTILS_TEST`);
        });

        test('Should execute INSERT statement', async function() {
            this.timeout(30000);

            const driver = await connectionManager.getDriver();

            // Setup
            await executeWithoutResult(driver, `CREATE SCHEMA IF NOT EXISTS ${TEST_CONFIG.testSchema}`);
            await executeWithoutResult(driver, `
                CREATE OR REPLACE TABLE ${TEST_CONFIG.testSchema}.UTILS_TEST (
                    ID INT
                )
            `);

            // Insert
            const result = await executeWithoutResult(driver, `
                INSERT INTO ${TEST_CONFIG.testSchema}.UTILS_TEST VALUES (1)
            `);

            assert.ok(result, 'Should return result');
            assert.strictEqual(result.status, 'ok', 'Status should be ok');

            // Cleanup
            await executeWithoutResult(driver, `DROP TABLE ${TEST_CONFIG.testSchema}.UTILS_TEST`);
        });

        test('Should execute UPDATE statement', async function() {
            this.timeout(30000);

            const driver = await connectionManager.getDriver();

            // Setup
            await executeWithoutResult(driver, `CREATE SCHEMA IF NOT EXISTS ${TEST_CONFIG.testSchema}`);
            await executeWithoutResult(driver, `
                CREATE OR REPLACE TABLE ${TEST_CONFIG.testSchema}.UTILS_TEST (
                    ID INT,
                    VAL VARCHAR(100)
                )
            `);
            await executeWithoutResult(driver, `INSERT INTO ${TEST_CONFIG.testSchema}.UTILS_TEST VALUES (1, 'Old')`);

            // Update
            const result = await executeWithoutResult(driver, `
                UPDATE ${TEST_CONFIG.testSchema}.UTILS_TEST SET VAL = 'New' WHERE ID = 1
            `);

            assert.ok(result, 'Should return result');
            assert.strictEqual(result.status, 'ok', 'Status should be ok');

            // Cleanup
            await executeWithoutResult(driver, `DROP TABLE ${TEST_CONFIG.testSchema}.UTILS_TEST`);
        });

        test('Should execute DELETE statement', async function() {
            this.timeout(30000);

            const driver = await connectionManager.getDriver();

            // Setup
            await executeWithoutResult(driver, `CREATE SCHEMA IF NOT EXISTS ${TEST_CONFIG.testSchema}`);
            await executeWithoutResult(driver, `
                CREATE OR REPLACE TABLE ${TEST_CONFIG.testSchema}.UTILS_TEST (ID INT)
            `);
            await executeWithoutResult(driver, `INSERT INTO ${TEST_CONFIG.testSchema}.UTILS_TEST VALUES (1)`);

            // Delete
            const result = await executeWithoutResult(driver, `
                DELETE FROM ${TEST_CONFIG.testSchema}.UTILS_TEST WHERE ID = 1
            `);

            assert.ok(result, 'Should return result');
            assert.strictEqual(result.status, 'ok', 'Status should be ok');

            // Cleanup
            await executeWithoutResult(driver, `DROP TABLE ${TEST_CONFIG.testSchema}.UTILS_TEST`);
        });

        test('Should handle execution errors', async function() {
            this.timeout(30000);

            const driver = await connectionManager.getDriver();

            await assert.rejects(
                executeWithoutResult(driver, 'CREATE TABLE INVALID SYNTAX')
            );
        });

        test('Should fallback to execute method when needed', async function() {
            this.timeout(30000);

            const driver = await connectionManager.getDriver();

            // TRUNCATE is an example that might require fallback
            await executeWithoutResult(driver, `CREATE SCHEMA IF NOT EXISTS ${TEST_CONFIG.testSchema}`);
            await executeWithoutResult(driver, `
                CREATE OR REPLACE TABLE ${TEST_CONFIG.testSchema}.UTILS_TEST (ID INT)
            `);

            const result = await executeWithoutResult(driver, `
                TRUNCATE TABLE ${TEST_CONFIG.testSchema}.UTILS_TEST
            `);

            assert.ok(result, 'Should handle fallback execution');

            // Cleanup
            await executeWithoutResult(driver, `DROP TABLE ${TEST_CONFIG.testSchema}.UTILS_TEST`);
        });
    });

    suiteTeardown(async function() {
        this.timeout(30000);
        const driver = await connectionManager.getDriver();
        await executeWithoutResult(driver, `DROP SCHEMA IF EXISTS ${TEST_CONFIG.testSchema} CASCADE`);
        await connectionManager.closeAll();
    });
});
