import * as assert from 'assert';
import type * as vscode from 'vscode';
import { registerVscodeMock, registerExtensionMock, vscodeMock } from '../helpers/vscodeMock';
import type { QueryExecutor, QueryResult } from '../../queryExecutor';

/**
 * The slice of the vscode API ObjectActions actually calls: `window` (progress
 * reporting, message boxes, opening the active editor), `workspace` (opening
 * an untitled document, reading configuration), and the one ProgressLocation
 * value previewTableData references. vscodeMock only declares the members
 * objectTreeProvider.ts/etc need, so this test grows it with these members at
 * module top-level, the same pattern queryExecutorStatementIdentity.test.ts
 * and objectSearch.test.ts use.
 */
interface ObjectActionsVscodeMock {
    ProgressLocation: { Notification: number };
    window: {
        showInformationMessage: (msg: string) => Promise<undefined>;
        showErrorMessage: (msg: string) => Promise<undefined>;
        showWarningMessage: (msg: string) => Promise<undefined>;
        showTextDocument: (doc: unknown) => Promise<undefined>;
        withProgress: <T>(options: unknown, task: () => Promise<T>) => Promise<T>;
        activeTextEditor: { document: { languageId: string } } | undefined;
    };
    workspace: {
        openTextDocument: (opts: unknown) => Promise<{ languageId: string }>;
        getConfiguration: () => { get: (key: string, fallback?: unknown) => unknown };
    };
}

const extendedVscodeMock = vscodeMock as unknown as ObjectActionsVscodeMock;

/** Builds the `window` shape ObjectActions needs; shared by the module-load-time
 * guard below and by every suite's setup() so there is one place to keep them in sync. */
function buildWindowMock(): ObjectActionsVscodeMock['window'] {
    return {
        showInformationMessage: () => Promise.resolve(undefined),
        showErrorMessage: () => Promise.resolve(undefined),
        showWarningMessage: () => Promise.resolve(undefined),
        showTextDocument: () => Promise.resolve(undefined),
        withProgress: (_opts, task) => task(),
        activeTextEditor: undefined,
    };
}

/** Builds the `workspace` shape ObjectActions needs; same sharing rationale as buildWindowMock. */
function buildWorkspaceMock(): ObjectActionsVscodeMock['workspace'] {
    return {
        openTextDocument: () => Promise.resolve({ languageId: 'exasol-sql' }),
        getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }),
    };
}

// vscodeMock is a process-wide singleton shared by every test file in the same
// mocha run. __importStar only wires a *live* getter for a key that already
// exists on vscodeMock at the moment require('../../objectActions') below
// runs; a key added later (e.g. by setup()) would never be seen by
// objectActions's already-captured `vscode` binding. `window` and
// `ProgressLocation` are not part of vscodeMock's own base shape (unlike
// `workspace`, which the shared helper always declares), so this file must
// guarantee they exist before requiring objectActions. Unlike the old
// unconditional assignment here, this only installs a placeholder when the
// key is missing: if another suite (e.g. objectSearch.test.ts, which also
// installs `window` at its own module load time) already claimed `window`
// first, depending on file load order, this leaves that shape alone rather
// than clobbering it for the whole collection phase; every test in this
// file still gets the real, correct shape from setup() below regardless.
if (!('window' in vscodeMock)) {
    extendedVscodeMock.window = buildWindowMock();
}
if (!('ProgressLocation' in vscodeMock)) {
    extendedVscodeMock.ProgressLocation = { Notification: 15 };
}

registerVscodeMock();
registerExtensionMock();

// Load ObjectActions/ResultsPanel after the vscode mock is configured: a deferred
// require() is necessary here since import statements resolve 'vscode' at their
// original textual position, and the module under test must see the mock above
// rather than the real 'vscode' module (which does not exist outside the
// extension host).
const { ObjectActions } = require('../../objectActions') as typeof import('../../objectActions');
const { ResultsPanel } = require('../../panels/resultsPanel') as typeof import('../../panels/resultsPanel');

import { createRawResult, createEmptyRawResult, MockConnectionManager, TEST_CONNECTION, asConnectionManager, type MockDriver } from '../helpers/mockConnectionManager';

/** The rows shape createRawResult accepts, derived rather than re-declared
 * since mockConnectionManager.ts keeps its RawCell type private. */
type RawRows = Parameters<typeof createRawResult>[1];

/**
 * Build an ObjectActions instance whose driver records each SQL string passed to
 * driver.query() and returns a valid empty result.
 */
function makeObjectActionsCapturingSql(): {
    oa: InstanceType<typeof ObjectActions>;
    capturedSql: string[];
} {
    const capturedSql: string[] = [];

    const mockDriver: MockDriver = {
        query: async (sql: string) => {
            capturedSql.push(sql);
            // A structurally valid empty result so rawQuery/getRowsFromResult work.
            return createEmptyRawResult([]);
        }
    };

    const mockCM = new MockConnectionManager(mockDriver);
    // ObjectActions never reads queryExecutor or extensionUri (see src/objectActions.ts);
    // these tests only exercise SQL-building and driver interaction, so both are
    // deliberate empty partial doubles.
    const mockQE = {} as unknown as QueryExecutor;
    const mockUri = { fsPath: '/mock' } as unknown as vscode.Uri;

    return { oa: new ObjectActions(asConnectionManager(mockCM), mockQE, mockUri), capturedSql };
}

suite('ObjectActions SQL injection escaping', () => {

    let savedWindow: ObjectActionsVscodeMock['window'];
    let savedWorkspace: ObjectActionsVscodeMock['workspace'];

    setup(() => {
        // Save the mock state in case another suite has overwritten vscodeMock.window
        // (e.g. objectSearch.test.ts sets its own version at module-top-level), and
        // install the full window/workspace mock required by ObjectActions before
        // every test, so this suite's tests never depend on file load order.
        savedWindow = extendedVscodeMock.window;
        savedWorkspace = extendedVscodeMock.workspace;
        extendedVscodeMock.window = buildWindowMock();
        extendedVscodeMock.workspace = buildWorkspaceMock();
    });

    teardown(() => {
        // Restore the previous mock state so we don't interfere with other suites.
        extendedVscodeMock.window = savedWindow;
        extendedVscodeMock.workspace = savedWorkspace;
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

        await oa.generateSelectStatement(TEST_CONNECTION, "O'Brien", 'MY_TABLE');

        assert.ok(capturedSql.length > 0, 'Driver should have been called');
        const sql = capturedSql[0];
        assert.ok(
            sql.includes("'O''Brien'"),
            `Schema name with single quote must be doubled in WHERE clause. Got: ${sql}`
        );
    });

    test('generateSelectStatement escapes SQL injection attempt in tableName', async () => {
        const { oa, capturedSql } = makeObjectActionsCapturingSql();

        await oa.generateSelectStatement(TEST_CONNECTION, 'MY_SCHEMA', "'; DROP TABLE USERS; --");

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
        // The baseline identity-capture query (CURRENT_SESSION/CURRENT_STATEMENT)
        // now runs before the preview query itself, so the preview's own SQL is
        // the last call rather than necessarily the first.
        const sql = capturedSql[capturedSql.length - 1];
        assert.ok(
            sql.includes('"SCHEMA""WITH""QUOTES"'),
            `Double quotes in identifier must be doubled. Got: ${sql}`
        );
    });
});

suite('ObjectActions.previewTableData: baseline statement identity capture', () => {

    let savedWindow: ObjectActionsVscodeMock['window'];
    let savedWorkspace: ObjectActionsVscodeMock['workspace'];

    setup(() => {
        savedWindow = extendedVscodeMock.window;
        savedWorkspace = extendedVscodeMock.workspace;
        extendedVscodeMock.window = buildWindowMock();
        extendedVscodeMock.workspace = buildWorkspaceMock();
    });

    teardown(() => {
        extendedVscodeMock.window = savedWindow;
        extendedVscodeMock.workspace = savedWorkspace;
    });

    /**
     * Builds an ObjectActions instance whose fake driver returns `identityRows`
     * (or throws, if 'throw') for the baseline SESSION_ID/STMT_ID capture query,
     * and a plain one-row result for the preview query itself.
     */
    function makeObjectActionsForIdentity(identityRows: RawRows | 'throw'): { oa: InstanceType<typeof ObjectActions> } {
        const mockDriver: MockDriver = {
            query: async (sql: string) => {
                if (sql.includes('CURRENT_SESSION')) {
                    if (identityRows === 'throw') {
                        throw new Error('simulated identity capture failure');
                    }
                    return createRawResult(['SID', 'STID'], identityRows);
                }
                return createRawResult(['COL'], [[1]]);
            }
        };
        const mockCM = new MockConnectionManager(mockDriver);
        // ObjectActions never reads queryExecutor or extensionUri; deliberate
        // empty/partial doubles, same rationale as makeObjectActionsCapturingSql above.
        const mockQE = {} as unknown as QueryExecutor;
        const mockUri = { fsPath: '/mock' } as unknown as vscode.Uri;
        return { oa: new ObjectActions(asConnectionManager(mockCM), mockQE, mockUri) };
    }

    /**
     * Runs previewTableData with ResultsPanel.show stubbed to capture the
     * QueryResult it was handed, since previewTableData does not return it directly.
     */
    async function previewAndCapture(oa: InstanceType<typeof ObjectActions>): Promise<QueryResult> {
        let captured: QueryResult | undefined;
        const originalShow = ResultsPanel.show;
        ResultsPanel.show = (result: QueryResult) => { captured = result; };
        try {
            await oa.previewTableData(TEST_CONNECTION, 'MY_SCHEMA', 'MY_TABLE', 100, false);
        } finally {
            ResultsPanel.show = originalShow;
        }
        assert.ok(captured, 'ResultsPanel.show must have been called');
        return captured;
    }

    test('carries sessionId/baselineStmtId/connectionId when capture succeeds', async () => {
        const { oa } = makeObjectActionsForIdentity([[42, 7]]);

        const result = await previewAndCapture(oa);

        assert.strictEqual(result.sessionId, '42');
        assert.strictEqual(result.baselineStmtId, '7');
        assert.strictEqual(result.connectionId, TEST_CONNECTION.id, 'must record which connection actually ran the preview query');
    });

    test('omits sessionId/baselineStmtId (without throwing) when identity capture fails', async () => {
        const { oa } = makeObjectActionsForIdentity('throw');

        const result = await previewAndCapture(oa);

        assert.strictEqual(result.sessionId, undefined);
        assert.strictEqual(result.baselineStmtId, undefined);
        assert.strictEqual(result.rowCount, 1, 'the preview query itself must still succeed');
    });
});

suite('escapeSqlIdentifier', () => {
    const { escapeSqlIdentifier } = require('../../utils') as typeof import('../../utils');

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
