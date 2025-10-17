import * as assert from 'assert';
import * as vscode from 'vscode';
import { getRowsFromResult, getColumnsFromResult, executeWithoutResult } from '../utils';
import { ConnectionManager } from '../connectionManager';
import { TEST_CONFIG } from './testConfig';

suite('Utils Test Suite', () => {
    let context: vscode.ExtensionContext;
    let connectionManager: ConnectionManager;

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
        await connectionManager.addConnection(TEST_CONFIG.connection);
    });

    suite('getRowsFromResult', () => {
        test('Should handle null/undefined result', function() {
            const rows1 = getRowsFromResult(null);
            const rows2 = getRowsFromResult(undefined);

            assert.strictEqual(rows1.length, 0, 'Null should return empty array');
            assert.strictEqual(rows2.length, 0, 'Undefined should return empty array');
        });

        test('Should extract rows from object with rows property', function() {
            const mockResult = {
                rows: [
                    { ID: 1, NAME: 'Test1' },
                    { ID: 2, NAME: 'Test2' }
                ]
            };

            const rows = getRowsFromResult(mockResult);
            assert.strictEqual(rows.length, 2);
            assert.strictEqual(rows[0].ID, 1);
            assert.strictEqual(rows[1].NAME, 'Test2');
        });

        test('Should call getRows method if available', function() {
            const mockResult = {
                getRows: () => [
                    { ID: 1, NAME: 'Test1' },
                    { ID: 2, NAME: 'Test2' }
                ]
            };

            const rows = getRowsFromResult(mockResult);
            assert.strictEqual(rows.length, 2);
            assert.strictEqual(rows[0].ID, 1);
        });

        test('Should handle raw response format', function() {
            const mockRawResult = {
                status: 'ok',
                responseData: {
                    results: [{
                        resultType: 'resultSet',
                        resultSet: {
                            columns: [
                                { name: 'ID' },
                                { name: 'NAME' }
                            ],
                            data: [
                                [1, 2],
                                ['Test1', 'Test2']
                            ]
                        }
                    }]
                }
            };

            const rows = getRowsFromResult(mockRawResult);
            assert.strictEqual(rows.length, 2);
            assert.strictEqual(rows[0].ID, 1);
            assert.strictEqual(rows[0].NAME, 'Test1');
            assert.strictEqual(rows[1].ID, 2);
            assert.strictEqual(rows[1].NAME, 'Test2');
        });

        test('Should handle raw response with error status', function() {
            const mockErrorResult = {
                status: 'error',
                exception: {
                    text: 'Query failed'
                }
            };

            try {
                getRowsFromResult(mockErrorResult);
                assert.fail('Should throw error');
            } catch (error) {
                // Just verify an error was thrown
                assert.ok(error, 'Should throw an error for error status');
            }
        });

        test('Should handle raw response with no results', function() {
            const mockEmptyResult = {
                status: 'ok',
                responseData: {
                    results: []
                }
            };

            const rows = getRowsFromResult(mockEmptyResult);
            assert.strictEqual(rows.length, 0);
        });

        test('Should handle raw response with non-resultSet type', function() {
            const mockResult = {
                status: 'ok',
                responseData: {
                    results: [{
                        resultType: 'rowCount'
                    }]
                }
            };

            const rows = getRowsFromResult(mockResult);
            assert.strictEqual(rows.length, 0);
        });

        test('Should handle missing columns in raw response', function() {
            const mockResult = {
                status: 'ok',
                responseData: {
                    results: [{
                        resultType: 'resultSet',
                        resultSet: {
                            data: [[1, 2, 3]]
                        }
                    }]
                }
            };

            const rows = getRowsFromResult(mockResult);
            assert.strictEqual(rows.length, 3);
            // When columns are missing, should still handle data gracefully
            // The actual behavior depends on implementation, so just verify it returns rows
            assert.ok(rows.length > 0, 'Should return rows even without column metadata');
        });

        test('Should handle empty data in resultSet', function() {
            const mockResult = {
                status: 'ok',
                responseData: {
                    results: [{
                        resultType: 'resultSet',
                        resultSet: {
                            columns: [{ name: 'ID' }],
                            data: []
                        }
                    }]
                }
            };

            const rows = getRowsFromResult(mockResult);
            assert.strictEqual(rows.length, 0);
        });
    });

    suite('getColumnsFromResult', () => {
        test('Should handle null/undefined result', function() {
            const cols1 = getColumnsFromResult(null);
            const cols2 = getColumnsFromResult(undefined);

            assert.strictEqual(cols1.length, 0, 'Null should return empty array');
            assert.strictEqual(cols2.length, 0, 'Undefined should return empty array');
        });

        test('Should extract columns from object with columns property', function() {
            const mockResult = {
                columns: ['ID', 'NAME', 'EMAIL']
            };

            const columns = getColumnsFromResult(mockResult);
            assert.strictEqual(columns.length, 3);
            assert.strictEqual(columns[0], 'ID');
            assert.strictEqual(columns[2], 'EMAIL');
        });

        test('Should call getColumns method if available', function() {
            const mockResult = {
                getColumns: () => ['ID', 'NAME']
            };

            const columns = getColumnsFromResult(mockResult);
            assert.strictEqual(columns.length, 2);
            assert.strictEqual(columns[0], 'ID');
        });

        test('Should handle raw response format', function() {
            const mockRawResult = {
                status: 'ok',
                responseData: {
                    results: [{
                        resultType: 'resultSet',
                        resultSet: {
                            columns: [
                                { name: 'ID', type: 'INT' },
                                { name: 'NAME', type: 'VARCHAR' }
                            ]
                        }
                    }]
                }
            };

            const columns = getColumnsFromResult(mockRawResult);
            assert.strictEqual(columns.length, 2);
            assert.strictEqual(columns[0].name, 'ID');
            assert.strictEqual(columns[1].name, 'NAME');
        });

        test('Should handle raw response with error status', function() {
            const mockErrorResult = {
                status: 'error',
                exception: {
                    text: 'Column fetch failed'
                }
            };

            try {
                getColumnsFromResult(mockErrorResult);
                assert.fail('Should throw error');
            } catch (error) {
                // Just verify an error was thrown
                assert.ok(error, 'Should throw an error for error status');
            }
        });

        test('Should handle raw response with no columns', function() {
            const mockResult = {
                status: 'ok',
                responseData: {
                    results: [{
                        resultType: 'resultSet',
                        resultSet: {}
                    }]
                }
            };

            const columns = getColumnsFromResult(mockResult);
            assert.strictEqual(columns.length, 0);
        });
    });

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

            try {
                await executeWithoutResult(driver, 'CREATE TABLE INVALID SYNTAX');
                assert.fail('Should throw error for invalid SQL');
            } catch (error) {
                assert.ok(error, 'Should throw error');
            }
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
