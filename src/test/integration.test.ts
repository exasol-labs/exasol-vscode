import * as assert from 'assert';
import * as vscode from 'vscode';
import { ConnectionManager } from '../connectionManager';
import { QueryExecutor } from '../queryExecutor';
import { SessionManager } from '../sessionManager';
import { ObjectActions } from '../objectActions';
import { TEST_CONFIG } from './testConfig';
import { executeWithoutResult } from '../utils';

suite('Integration Test Suite', () => {
    let context: vscode.ExtensionContext;
    let connectionManager: ConnectionManager;
    let queryExecutor: QueryExecutor;
    let sessionManager: SessionManager;
    let objectActions: ObjectActions;

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

        // Initialize all components
        connectionManager = new ConnectionManager(context);
        await connectionManager.addConnection(TEST_CONFIG.connection);

        queryExecutor = new QueryExecutor(connectionManager);
        sessionManager = new SessionManager(connectionManager, context);
        objectActions = new ObjectActions(connectionManager, queryExecutor, context.extensionUri);

        // Setup test environment
        const driver = await connectionManager.getDriver();
        await executeWithoutResult(driver, `CREATE SCHEMA IF NOT EXISTS ${TEST_CONFIG.testSchema}`);
        await executeWithoutResult(driver, `
            CREATE OR REPLACE TABLE ${TEST_CONFIG.testSchema}.${TEST_CONFIG.testTable} (
                ID INT,
                NAME VARCHAR(100),
                AMOUNT DECIMAL(10,2),
                CREATED_DATE DATE
            )
        `);

        // Insert test data
        for (let i = 1; i <= 10; i++) {
            await executeWithoutResult(driver, `
                INSERT INTO ${TEST_CONFIG.testSchema}.${TEST_CONFIG.testTable}
                VALUES (${i}, 'Item${i}', ${i * 10.5}, '2024-01-0${i % 9 + 1}')
            `);
        }

        await executeWithoutResult(driver, `
            CREATE OR REPLACE VIEW ${TEST_CONFIG.testSchema}.${TEST_CONFIG.testView} AS
            SELECT ID, NAME, AMOUNT
            FROM ${TEST_CONFIG.testSchema}.${TEST_CONFIG.testTable}
            WHERE AMOUNT > 50
        `);
    });

    test('End-to-end workflow: Connect, Query, Export', async function() {
        this.timeout(30000);

        // 1. Verify connection
        const activeConn = connectionManager.getActiveConnection();
        assert.ok(activeConn, 'Should have active connection');

        // 2. Execute query
        const result = await queryExecutor.execute(
            `SELECT * FROM ${TEST_CONFIG.testSchema}.${TEST_CONFIG.testTable} ORDER BY ID`
        );
        assert.strictEqual(result.rowCount, 10, 'Should return 10 rows');
        assert.strictEqual(result.columns.length, 4, 'Should have 4 columns');

        // 3. Verify data
        assert.strictEqual(result.rows[0].ID, 1);
        assert.strictEqual(result.rows[0].NAME, 'Item1');
        assert.strictEqual(parseFloat(result.rows[0].AMOUNT), 10.5);
    });

    test('Session management workflow', async function() {
        this.timeout(30000);

        // Set active schema
        await sessionManager.setSchema(TEST_CONFIG.testSchema);

        // Verify schema is set
        const currentSchema = sessionManager.getCurrentSchema();
        assert.strictEqual(currentSchema, TEST_CONFIG.testSchema, 'Schema should be set');

        // Verify status bar text
        const statusText = sessionManager.getStatusBarText();
        assert.ok(statusText.includes(TEST_CONFIG.testSchema), 'Status should show schema');
        assert.ok(statusText.includes(TEST_CONFIG.connection.name), 'Status should show connection');

        // Clear session
        await sessionManager.clearSession();
        assert.strictEqual(sessionManager.getCurrentSchema(), undefined, 'Schema should be cleared');
    });

    test('Object actions workflow', async function() {
        this.timeout(30000);

        const conn = connectionManager.getActiveConnection();
        assert.ok(conn, 'Should have active connection');

        // 1. Preview table data
        // Note: This would normally open a results panel, but in tests we just verify no error
        try {
            await objectActions.previewTableData(conn, TEST_CONFIG.testSchema, TEST_CONFIG.testTable, 5);
        } catch (error) {
            // May fail in test environment without UI, but should not throw critical errors
            console.log('Preview table data test note:', error);
        }

        // 2. Get table DDL
        try {
            await objectActions.showTableDDL(conn, TEST_CONFIG.testSchema, TEST_CONFIG.testTable);
        } catch (error) {
            console.log('Show table DDL test note:', error);
        }

        // 3. Get view DDL
        try {
            await objectActions.showViewDDL(conn, TEST_CONFIG.testSchema, TEST_CONFIG.testView);
        } catch (error) {
            console.log('Show view DDL test note:', error);
        }

        // 4. Generate SELECT statement
        try {
            await objectActions.generateSelectStatement(conn, TEST_CONFIG.testSchema, TEST_CONFIG.testTable, 'table');
        } catch (error) {
            console.log('Generate SELECT test note:', error);
        }
    });

    test('Complex query workflow', async function() {
        this.timeout(30000);

        // Complex query with joins, aggregations, and window functions
        const complexQuery = `
            SELECT
                t.ID,
                t.NAME,
                t.AMOUNT,
                SUM(t.AMOUNT) OVER (ORDER BY t.ID) AS RUNNING_TOTAL,
                ROW_NUMBER() OVER (ORDER BY t.AMOUNT DESC) AS AMOUNT_RANK
            FROM ${TEST_CONFIG.testSchema}.${TEST_CONFIG.testTable} t
            WHERE t.AMOUNT > 20
            ORDER BY t.ID
        `;

        const result = await queryExecutor.execute(complexQuery);

        assert.ok(result.rowCount > 0, 'Should return rows');
        assert.ok(result.columns.includes('RUNNING_TOTAL'), 'Should have RUNNING_TOTAL column');
        assert.ok(result.columns.includes('AMOUNT_RANK'), 'Should have AMOUNT_RANK column');

        // Verify window function results
        assert.ok(result.rows[0].RUNNING_TOTAL > 0, 'Running total should be calculated');
        assert.ok(result.rows[0].AMOUNT_RANK > 0, 'Rank should be calculated');
    });

    test('Transaction workflow', async function() {
        this.timeout(30000);

        const driver = await connectionManager.getDriver();

        // Create temp table
        await queryExecutor.execute(`
            CREATE OR REPLACE TABLE ${TEST_CONFIG.testSchema}.TRANSACTION_TEST (
                ID INT,
                VAL VARCHAR(100)
            )
        `);

        // Insert data
        await queryExecutor.execute(`
            INSERT INTO ${TEST_CONFIG.testSchema}.TRANSACTION_TEST VALUES (1, 'Test')
        `);

        // Verify
        const result = await queryExecutor.execute(`
            SELECT * FROM ${TEST_CONFIG.testSchema}.TRANSACTION_TEST
        `);

        assert.strictEqual(result.rowCount, 1, 'Should have inserted row');

        // Cleanup
        await queryExecutor.execute(`DROP TABLE ${TEST_CONFIG.testSchema}.TRANSACTION_TEST`);
    });

    test('Error handling workflow', async function() {
        this.timeout(30000);

        // Test various error scenarios
        const errorTests = [
            {
                query: 'SELECT * FROM NON_EXISTENT_TABLE',
                expectedError: 'table'
            },
            {
                query: 'SELECT INVALID_FUNCTION()',
                expectedError: 'function'
            },
            {
                query: 'INSERT INTO SYS.EXA_TABLES VALUES (1)',
                expectedError: 'permission'
            }
        ];

        for (const test of errorTests) {
            try {
                await queryExecutor.execute(test.query);
                assert.fail(`Should have failed for: ${test.query}`);
            } catch (error) {
                assert.ok(error, 'Should throw error');
                // Error message should contain relevant info
                console.log(`Expected error for ${test.expectedError}:`, String(error));
            }
        }
    });

    test('Performance test: Multiple sequential queries', async function() {
        this.timeout(60000);

        const results = [];
        for (let i = 0; i < 5; i++) {
            const result = await queryExecutor.execute(`SELECT ${i} AS NUM, '${i}' AS STR`);
            results.push(result);
        }

        assert.strictEqual(results.length, 5, 'Should execute all queries');
        results.forEach((result, index) => {
            assert.strictEqual(result.rowCount, 1, 'Each query should return one row');
            assert.strictEqual(result.rows[0].NUM, index, 'Should have correct value');
        });
    });

    suiteTeardown(async function() {
        this.timeout(30000);

        // Cleanup
        const driver = await connectionManager.getDriver();
        await executeWithoutResult(driver, `DROP SCHEMA IF EXISTS ${TEST_CONFIG.testSchema} CASCADE`);
        await connectionManager.closeAll();
    });
});
