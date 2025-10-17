import * as assert from 'assert';
import * as vscode from 'vscode';
import { ConnectionManager } from '../connectionManager';
import { ConnectionTreeProvider } from '../providers/connectionTreeProvider';
import { ObjectTreeProvider } from '../providers/objectTreeProvider';
import { TEST_CONFIG } from './testConfig';
import { executeWithoutResult } from '../utils';

suite('Object Browser Test Suite', () => {
    let context: vscode.ExtensionContext;
    let connectionManager: ConnectionManager;
    let connectionTreeProvider: ConnectionTreeProvider;
    let objectTreeProvider: ObjectTreeProvider;
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

        connectionTreeProvider = new ConnectionTreeProvider(connectionManager);
        objectTreeProvider = new ObjectTreeProvider(connectionManager);
        await connectionManager.setActiveConnection(connectionId);

        // Setup test schema and objects
        const driver = await connectionManager.getDriver();

        // Create schema
        await executeWithoutResult(driver, `CREATE SCHEMA IF NOT EXISTS ${TEST_CONFIG.testSchema}`);

        // Create table
        await executeWithoutResult(driver, `
            CREATE OR REPLACE TABLE ${TEST_CONFIG.testSchema}.${TEST_CONFIG.testTable} (
                ID INT,
                NAME VARCHAR(100),
                CREATED_DATE DATE
            )
        `);

        // Insert test data
        await executeWithoutResult(driver, `
            INSERT INTO ${TEST_CONFIG.testSchema}.${TEST_CONFIG.testTable}
            VALUES (1, 'Test1', '2024-01-01'), (2, 'Test2', '2024-01-02')
        `);

        // Create view
        await executeWithoutResult(driver, `
            CREATE OR REPLACE VIEW ${TEST_CONFIG.testSchema}.${TEST_CONFIG.testView} AS
            SELECT ID, NAME FROM ${TEST_CONFIG.testSchema}.${TEST_CONFIG.testTable}
        `);
    });

    test('Should list all connections', async function() {
        this.timeout(30000);

        const connections = await connectionTreeProvider.getChildren();

        assert.ok(connections, 'Should return connections');
        assert.ok(connections.length > 0, 'Should have at least one connection');

        const testConn = connections.find(c => c.connection.id === connectionId);
        assert.ok(testConn, 'Should find test connection');
        assert.strictEqual(testConn?.connection.name, TEST_CONFIG.connection.name);
        assert.ok(testConn?.isActive, 'Test connection should be active');
    });

    test('Should list schemas for connection', async function() {
        this.timeout(30000);

        // Now getChildren() returns schemas directly (no connection node)
        const schemas = await objectTreeProvider.getChildren();

        assert.ok(schemas, 'Should return schemas');
        assert.ok(schemas.length > 0, 'Should have at least one schema');

        const testSchema = schemas.find(s => getLabelText(s) === TEST_CONFIG.testSchema);
        assert.ok(testSchema, `Should find ${TEST_CONFIG.testSchema} schema`);
    });

    test('Should list tables and views in schema', async function() {
        this.timeout(30000);

        const schemas = await objectTreeProvider.getChildren();
        const testSchema = schemas.find(s => getLabelText(s) === TEST_CONFIG.testSchema);

        const folders = await objectTreeProvider.getChildren(testSchema);

        assert.ok(folders, 'Should return folders');
        assert.strictEqual(folders.length, 2, 'Should have Tables and Views folders');

        const tablesFolder = folders.find(f => getLabelText(f) === 'Tables');
        const viewsFolder = folders.find(f => getLabelText(f) === 'Views');

        assert.ok(tablesFolder, 'Should have Tables folder');
        assert.ok(viewsFolder, 'Should have Views folder');

        // Check tables
        const tables = await objectTreeProvider.getChildren(tablesFolder);
        assert.ok(tables.length > 0, 'Should have tables');

        const testTable = tables.find(t => getLabelText(t) === TEST_CONFIG.testTable);
        assert.ok(testTable, `Should find ${TEST_CONFIG.testTable} table`);
        if (typeof testTable.description === 'string') {
            assert.ok(testTable.description.toLowerCase().includes('rows'), 'Description should mention rows when available');
        }

        // Check views
        const views = await objectTreeProvider.getChildren(viewsFolder);
        assert.ok(views.length > 0, 'Should have views');

        const testView = views.find(v => getLabelText(v) === TEST_CONFIG.testView);
        assert.ok(testView, `Should find ${TEST_CONFIG.testView} view`);
    });

    test('Should list columns for table', async function() {
        this.timeout(30000);

        const schemas = await objectTreeProvider.getChildren();
        const testSchema = schemas.find(s => getLabelText(s) === TEST_CONFIG.testSchema);
        const folders = await objectTreeProvider.getChildren(testSchema);
        const tablesFolder = folders.find(f => getLabelText(f) === 'Tables');
        const tables = await objectTreeProvider.getChildren(tablesFolder);
        const testTable = tables.find(t => getLabelText(t) === TEST_CONFIG.testTable);

        const columns = await objectTreeProvider.getChildren(testTable);

        assert.ok(columns, 'Should return columns');
        assert.strictEqual(columns.length, 3, 'Should have 3 columns');

        const idColumn = columns.find(c => getLabelText(c).includes('ID'));
        assert.ok(idColumn, 'Should find ID column');
        assert.ok(getLabelText(idColumn).includes('('), 'Column label should include type');
    });

    test('Should filter system schemas', async function() {
        this.timeout(30000);

        const schemas = await objectTreeProvider.getChildren();

        const systemSchemas = schemas.filter(s => {
            const label = getLabelText(s);
            return label === 'SYS' || label === 'EXA_STATISTICS';
        }
        );

        assert.strictEqual(systemSchemas.length, 0, 'Should filter out system schemas');
    });

    suiteTeardown(async function() {
        this.timeout(30000);

        // Cleanup
        const driver = await connectionManager.getDriver();
        await executeWithoutResult(driver, `DROP SCHEMA IF EXISTS ${TEST_CONFIG.testSchema} CASCADE`);
        await connectionManager.closeAll();
    });
});

function getLabelText(item: vscode.TreeItem | undefined): string {
    if (!item || !item.label) {
        return '';
    }

    return typeof item.label === 'string' ? item.label : item.label?.label ?? '';
}
