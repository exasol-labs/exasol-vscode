import * as assert from 'assert';
import { registerVscodeMock, registerExtensionMock, vscodeMock } from '../helpers/vscodeMock';

// Set up all vscode mock properties needed by ObjectActions at module load time,
// BEFORE requiring objectActions. This ensures the properties exist on vscodeMock
// when __importStar is called inside objectActions, creating live getters that
// reflect subsequent changes made in setup/teardown.
(vscodeMock as any).ProgressLocation = { Notification: 15 };
(vscodeMock as any).window = {
    showInformationMessage: () => Promise.resolve(undefined),
    showErrorMessage: () => Promise.resolve(undefined),
    showWarningMessage: () => Promise.resolve(undefined),
    showTextDocument: () => Promise.resolve(undefined),
    withProgress: (_opts: any, task: () => Promise<any>) => task(),
    activeTextEditor: null,
};
(vscodeMock as any).workspace = {
    openTextDocument: (_opts: any) => Promise.resolve({ languageId: 'exasol-sql' }),
};

registerVscodeMock();
registerExtensionMock();

// Load ObjectActions after the vscode mock is configured.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ObjectActions } = require('../../objectActions');

import { createRawResult, createEmptyRawResult, MockConnectionManager, TEST_CONNECTION } from '../helpers/mockConnectionManager';

/**
 * Build an ObjectActions instance whose driver records each SQL string passed to
 * driver.query() and returns a valid empty result.
 */
function makeObjectActionsCapturingSql(): {
    oa: any;
    capturedSql: string[];
} {
    const capturedSql: string[] = [];

    const mockDriver = {
        query: async (sql: string, ..._rest: any[]) => {
            capturedSql.push(sql);
            // Return a structurally valid empty result so rawQuery/getRowsFromResult work.
            return {
                status: 'ok',
                responseData: {
                    numResults: 1,
                    results: [{
                        resultType: 'resultSet',
                        resultSet: {
                            columns: [],
                            numColumns: 0,
                            numRows: 0,
                            data: []
                        }
                    }]
                }
            };
        }
    };

    const mockCM = new MockConnectionManager(mockDriver);
    const mockQE = {};
    const mockUri = { fsPath: '/mock' };

    return { oa: new ObjectActions(mockCM, mockQE, mockUri), capturedSql };
}

suite('ObjectActions SQL injection escaping', () => {

    let savedWindow: any;
    let savedWorkspace: any;

    setup(() => {
        // Save the mock state in case another suite has overwritten vscodeMock.window
        // (e.g. objectSearch.test.ts sets its own version at module-top-level).
        savedWindow = (vscodeMock as any).window;
        savedWorkspace = (vscodeMock as any).workspace;

        // Install the full window/workspace mock required by ObjectActions.
        (vscodeMock as any).window = {
            showInformationMessage: () => Promise.resolve(undefined),
            showErrorMessage: () => Promise.resolve(undefined),
            showWarningMessage: () => Promise.resolve(undefined),
            showTextDocument: () => Promise.resolve(undefined),
            withProgress: (_opts: any, task: () => Promise<any>) => task(),
            activeTextEditor: null,
        };
        (vscodeMock as any).workspace = {
            openTextDocument: (_opts: any) => Promise.resolve({ languageId: 'exasol-sql' }),
        };
    });

    teardown(() => {
        // Restore the previous mock state so we don't interfere with other suites.
        (vscodeMock as any).window = savedWindow;
        (vscodeMock as any).workspace = savedWorkspace;
    });

    // ---- showTableDDL: single-quoted WHERE clauses ----

    test('showTableDDL escapes single quote in schemaName', async () => {
        const { oa, capturedSql } = makeObjectActionsCapturingSql();

        await oa.showTableDDL(TEST_CONNECTION, "O'Brien", 'MY_TABLE');

        assert.ok(capturedSql.length > 0, 'Driver should have been called');
        const sql = capturedSql[0];
        assert.ok(
            sql.includes("'O''Brien'"),
            `Schema name with single quote must be doubled in WHERE clause. Got: ${sql}`
        );
        assert.ok(
            !sql.includes("'O'Brien'"),
            'Unescaped single quote must not appear in WHERE clause'
        );
    });

    test('showTableDDL escapes SQL injection attempt in schemaName', async () => {
        const { oa, capturedSql } = makeObjectActionsCapturingSql();

        await oa.showTableDDL(TEST_CONNECTION, "'; DROP TABLE USERS; --", 'MY_TABLE');

        assert.ok(capturedSql.length > 0, 'Driver should have been called');
        const sql = capturedSql[0];
        // The opening single quote is doubled, keeping the injection value inside the string literal.
        assert.ok(
            sql.includes("''; DROP TABLE USERS; --'"),
            `Injection attempt single quote must be doubled and value must stay inside the literal. Got: ${sql}`
        );
    });

    test('showTableDDL escapes single quote in tableName', async () => {
        const { oa, capturedSql } = makeObjectActionsCapturingSql();

        await oa.showTableDDL(TEST_CONNECTION, 'MY_SCHEMA', "O'Brien");

        assert.ok(capturedSql.length > 0, 'Driver should have been called');
        const sql = capturedSql[0];
        assert.ok(
            sql.includes("'O''Brien'"),
            `Table name with single quote must be doubled in WHERE clause. Got: ${sql}`
        );
    });

    // ---- showViewDDL: single-quoted WHERE clauses ----

    test('showViewDDL escapes single quote in schemaName', async () => {
        const { oa, capturedSql } = makeObjectActionsCapturingSql();

        await oa.showViewDDL(TEST_CONNECTION, "O'Brien", 'MY_VIEW');

        assert.ok(capturedSql.length > 0, 'Driver should have been called');
        const sql = capturedSql[0];
        assert.ok(
            sql.includes("'O''Brien'"),
            `Schema name with single quote must be doubled in WHERE clause. Got: ${sql}`
        );
    });

    test('showViewDDL escapes single quote in viewName', async () => {
        const { oa, capturedSql } = makeObjectActionsCapturingSql();

        await oa.showViewDDL(TEST_CONNECTION, 'MY_SCHEMA', "O'Brien");

        assert.ok(capturedSql.length > 0, 'Driver should have been called');
        const sql = capturedSql[0];
        assert.ok(
            sql.includes("'O''Brien'"),
            `View name with single quote must be doubled in WHERE clause. Got: ${sql}`
        );
    });

    // ---- generateSelectStatement: single-quoted WHERE clauses ----

    test('generateSelectStatement escapes single quote in schemaName', async () => {
        const { oa, capturedSql } = makeObjectActionsCapturingSql();

        await oa.generateSelectStatement(TEST_CONNECTION, "O'Brien", 'MY_TABLE', 'table');

        assert.ok(capturedSql.length > 0, 'Driver should have been called');
        const sql = capturedSql[0];
        assert.ok(
            sql.includes("'O''Brien'"),
            `Schema name with single quote must be doubled in WHERE clause. Got: ${sql}`
        );
    });

    test('generateSelectStatement escapes SQL injection attempt in tableName', async () => {
        const { oa, capturedSql } = makeObjectActionsCapturingSql();

        await oa.generateSelectStatement(TEST_CONNECTION, 'MY_SCHEMA', "'; DROP TABLE USERS; --", 'table');

        assert.ok(capturedSql.length > 0, 'Driver should have been called');
        const sql = capturedSql[0];
        // The opening single quote is doubled, keeping the injection value inside the string literal.
        assert.ok(
            sql.includes("''; DROP TABLE USERS; --'"),
            `Injection attempt single quote must be doubled and value must stay inside the literal. Got: ${sql}`
        );
    });

    // ---- describeTable: single-quoted WHERE clauses ----

    test('describeTable escapes single quote in schemaName', async () => {
        const { oa, capturedSql } = makeObjectActionsCapturingSql();

        await oa.describeTable(TEST_CONNECTION, "O'Brien", 'MY_TABLE');

        assert.ok(capturedSql.length > 0, 'Driver should have been called');
        const sql = capturedSql[0];
        assert.ok(
            sql.includes("'O''Brien'"),
            `Schema name with single quote must be doubled in WHERE clause. Got: ${sql}`
        );
    });

    test('describeTable escapes SQL injection attempt in tableName', async () => {
        const { oa, capturedSql } = makeObjectActionsCapturingSql();

        await oa.describeTable(TEST_CONNECTION, 'MY_SCHEMA', "'; DROP TABLE USERS; --");

        assert.ok(capturedSql.length > 0, 'Driver should have been called');
        const sql = capturedSql[0];
        // The opening single quote is doubled, keeping the injection value inside the string literal.
        assert.ok(
            sql.includes("''; DROP TABLE USERS; --'"),
            `Injection attempt single quote must be doubled and value must stay inside the literal. Got: ${sql}`
        );
    });

    // ---- previewTableData: double-quoted identifier escaping ----

    test('previewTableData escapes double quote in schemaName identifier', async () => {
        const { oa, capturedSql } = makeObjectActionsCapturingSql();

        await oa.previewTableData(TEST_CONNECTION, 'SCHEMA"WITH"QUOTES', 'MY_TABLE', 100, false);

        assert.ok(capturedSql.length > 0, 'Driver should have been called');
        const sql = capturedSql[0];
        assert.ok(
            sql.includes('"SCHEMA""WITH""QUOTES"'),
            `Double quotes in identifier must be doubled. Got: ${sql}`
        );
    });
});

suite('escapeSqlIdentifier', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { escapeSqlIdentifier } = require('../../utils');

    test('returns same string when no double quotes present', () => {
        assert.strictEqual(escapeSqlIdentifier('SCHEMA_NAME'), 'SCHEMA_NAME');
    });

    test('doubles a double quote in the middle of the string', () => {
        assert.strictEqual(escapeSqlIdentifier('SCH"EMA'), 'SCH""EMA');
    });

    test('doubles multiple double quotes', () => {
        assert.strictEqual(escapeSqlIdentifier('"a"b"'), '""a""b""');
    });

    test('handles empty string', () => {
        assert.strictEqual(escapeSqlIdentifier(''), '');
    });
});
