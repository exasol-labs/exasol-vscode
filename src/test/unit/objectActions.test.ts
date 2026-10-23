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
        setStatusBarMessage: (msg: string, timeout: number) => { dispose: () => void };
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
        setStatusBarMessage: () => ({ dispose: () => {} }),
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
const { ObjectActions, refreshVirtualSchemaAndReload, qualifyScriptText, qualifyFunctionText, qualifyViewText, buildScriptCall, buildConnectionDDL, buildTransferTemplate } = require('../../objectActions') as typeof import('../../objectActions');
const { ResultsPanel } = require('../../panels/resultsPanel') as typeof import('../../panels/resultsPanel');

import { splitIntoStatements } from '../../utils';
import { createRawResult, createEmptyRawResult, createRawErrorResult, MockConnectionManager, TEST_CONNECTION, asConnectionManager, type MockDriver } from '../helpers/mockConnectionManager';

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

suite('ObjectActions virtual schema actions', () => {

    let savedWindow: ObjectActionsVscodeMock['window'];
    let savedWorkspace: ObjectActionsVscodeMock['workspace'];
    let errorMessages: string[];

    setup(() => {
        savedWindow = extendedVscodeMock.window;
        savedWorkspace = extendedVscodeMock.workspace;
        errorMessages = [];
        extendedVscodeMock.window = {
            ...buildWindowMock(),
            showErrorMessage: (msg: string) => {
                errorMessages.push(msg);
                return Promise.resolve(undefined);
            },
        };
        extendedVscodeMock.workspace = buildWorkspaceMock();
    });

    teardown(() => {
        extendedVscodeMock.window = savedWindow;
        extendedVscodeMock.workspace = savedWorkspace;
    });

    /** ObjectActions whose driver records every SQL string and answers with `respond`. */
    function makeObjectActions(respond: (sql: string) => ReturnType<MockDriver['query']>): {
        oa: InstanceType<typeof ObjectActions>;
        capturedSql: string[];
    } {
        const capturedSql: string[] = [];
        const handler = (sql: string) => {
            capturedSql.push(sql);
            return respond(sql);
        };
        const mockCM = new MockConnectionManager({ query: handler, execute: handler });
        // ObjectActions never reads queryExecutor or extensionUri; same rationale as above.
        const mockQE = {} as unknown as QueryExecutor;
        const mockUri = { fsPath: '/mock' } as unknown as vscode.Uri;
        return { oa: new ObjectActions(asConnectionManager(mockCM), mockQE, mockUri), capturedSql };
    }

    async function explainAndCapture(
        oa: InstanceType<typeof ObjectActions>,
        schemaName: string,
        tableName: string
    ): Promise<{ result: QueryResult; query: string }> {
        let captured: { result: QueryResult; query: string } | undefined;
        const originalShow = ResultsPanel.show;
        ResultsPanel.show = (result: QueryResult, query: string) => { captured = { result, query }; };
        try {
            await oa.explainPushdown(TEST_CONNECTION, schemaName, tableName);
        } finally {
            ResultsPanel.show = originalShow;
        }
        assert.ok(captured, 'ResultsPanel.show must have been called');
        return captured;
    }

    test('explainPushdown runs plain EXPLAIN VIRTUAL with escaped identifiers', async () => {
        const { oa, capturedSql } = makeObjectActions(async () =>
            createRawResult(['PUSHDOWN_ID', 'PUSHDOWN_SQL'], [[1, 'SELECT 1']]));

        const { query } = await explainAndCapture(oa, 'a"b', 'T');

        assert.strictEqual(capturedSql.length, 1);
        assert.strictEqual(capturedSql[0], 'EXPLAIN VIRTUAL SELECT * FROM "a""b"."T" LIMIT 10');
        assert.strictEqual(query, capturedSql[0]);
    });

    test('explainPushdown passes every returned column and row to the results panel unchanged', async () => {
        const columnNames = ['PUSHDOWN_ID', 'PUSHDOWN_SQL', 'PUSHDOWN_JSON', 'PUSHDOWN_INVOLVED_TABLES', 'PUSHDOWN_EXTRA'];
        const pushdownJson = '{"schemaMetadataInfo":{"properties":{"CONNECTION_NAME":"MY_CONN"}}}';
        const { oa } = makeObjectActions(async () => createRawResult(
            columnNames,
            [[1, 'SELECT * FROM T', pushdownJson, 'T', 'extra-value']]
        ));

        const { result } = await explainAndCapture(oa, 'VS', 'T');

        assert.deepStrictEqual(result.columns, columnNames);
        assert.deepStrictEqual(result.columnMetadata?.map(col => col.name), columnNames);
        assert.strictEqual(result.rowCount, 1);
        assert.deepStrictEqual(result.rows[0], {
            PUSHDOWN_ID: 1,
            PUSHDOWN_SQL: 'SELECT * FROM T',
            PUSHDOWN_JSON: pushdownJson,
            PUSHDOWN_INVOLVED_TABLES: 'T',
            PUSHDOWN_EXTRA: 'extra-value',
        });
    });

    test('explainPushdown shows the database error text', async () => {
        const { oa } = makeObjectActions(async () => createRawErrorResult('42000', 'object VS.T not found'));

        await oa.explainPushdown(TEST_CONNECTION, 'VS', 'T');

        assert.strictEqual(errorMessages.length, 1);
        assert.ok(errorMessages[0].startsWith('Failed to explain pushdown: '));
        assert.ok(errorMessages[0].includes('object VS.T not found'));
    });

    test('refreshVirtualSchema refreshes the whole schema with an escaped identifier', async () => {
        const { oa, capturedSql } = makeObjectActions(async () => createEmptyRawResult([]));

        const ok = await oa.refreshVirtualSchema(TEST_CONNECTION, 'a"b');

        assert.strictEqual(ok, true);
        assert.deepStrictEqual(capturedSql, ['ALTER VIRTUAL SCHEMA "a""b" REFRESH']);
        assert.strictEqual(errorMessages.length, 0);
    });

    /**
     * Replaces withProgress with one that records each title and reports
     * whether a task is running, so a test can check that its SQL runs
     * while the progress notification is shown.
     */
    function trackProgress(): { titles: string[]; isInside: () => boolean } {
        const titles: string[] = [];
        let inside = false;
        extendedVscodeMock.window = {
            ...extendedVscodeMock.window,
            withProgress: async (opts, task) => {
                titles.push((opts as vscode.ProgressOptions).title ?? '');
                inside = true;
                try {
                    return await task();
                } finally {
                    inside = false;
                }
            },
        };
        return { titles, isInside: () => inside };
    }

    test('explainPushdown runs inside a progress notification', async () => {
        const progress = trackProgress();
        let queriesInsideProgress = 0;
        const { oa } = makeObjectActions(async () => {
            if (progress.isInside()) {
                queriesInsideProgress++;
            }
            return createRawResult(['PUSHDOWN_ID', 'PUSHDOWN_SQL'], [[1, 'SELECT 1']]);
        });

        await explainAndCapture(oa, 'VS', 'T');

        assert.deepStrictEqual(progress.titles, ['Explaining pushdown for VS.T...']);
        assert.strictEqual(queriesInsideProgress, 1, 'EXPLAIN VIRTUAL must run while the progress is shown');
    });

    test('refreshVirtualSchema runs inside a progress notification', async () => {
        const progress = trackProgress();
        let queriesInsideProgress = 0;
        const { oa } = makeObjectActions(async () => {
            if (progress.isInside()) {
                queriesInsideProgress++;
            }
            return createEmptyRawResult([]);
        });

        const ok = await oa.refreshVirtualSchema(TEST_CONNECTION, 'VS', 'T');

        assert.strictEqual(ok, true);
        assert.deepStrictEqual(progress.titles, ['Refreshing virtual schema metadata for VS.T...']);
        assert.strictEqual(queriesInsideProgress, 1, 'the refresh statement must run while the progress is shown');
    });

    test('refreshVirtualSchema refreshes a single table with escaped identifiers', async () => {
        const { oa, capturedSql } = makeObjectActions(async () => createEmptyRawResult([]));

        const ok = await oa.refreshVirtualSchema(TEST_CONNECTION, 'VS', 't"x');

        assert.strictEqual(ok, true);
        assert.deepStrictEqual(capturedSql, ['ALTER VIRTUAL SCHEMA "VS" REFRESH TABLES "t""x"']);
    });

    test('refreshVirtualSchema passes the database error text through unchanged', async () => {
        const text = 'insufficient privileges for altering virtual schema VS';
        const { oa } = makeObjectActions(async () => createRawErrorResult('42500', text));

        const ok = await oa.refreshVirtualSchema(TEST_CONNECTION, 'VS');

        assert.strictEqual(ok, false);
        assert.deepStrictEqual(errorMessages, [`Failed to refresh virtual schema: Error: SQL Error [42500]: ${text}`]);
    });

    /** Runs refreshVirtualSchemaAndReload and records the cache clears and tree refreshes it causes. */
    async function refreshAndRecord(
        oa: InstanceType<typeof ObjectActions>,
        tableName?: string
    ): Promise<{ clearedConnections: string[]; treeRefreshes: number }> {
        const clearedConnections: string[] = [];
        let treeRefreshes = 0;
        await refreshVirtualSchemaAndReload(
            {
                objectActions: oa,
                completionProvider: { clearCache: (connectionId: string) => { clearedConnections.push(connectionId); } },
                objectTreeProvider: { refresh: () => { treeRefreshes++; } },
            },
            TEST_CONNECTION,
            'VS',
            tableName
        );
        return { clearedConnections, treeRefreshes };
    }

    test('refreshVirtualSchemaAndReload clears the completion cache and reloads the tree on success', async () => {
        const { oa, capturedSql } = makeObjectActions(async () => createEmptyRawResult([]));

        const { clearedConnections, treeRefreshes } = await refreshAndRecord(oa, 'T');

        assert.deepStrictEqual(capturedSql, ['ALTER VIRTUAL SCHEMA "VS" REFRESH TABLES "T"']);
        assert.deepStrictEqual(clearedConnections, [TEST_CONNECTION.id]);
        assert.strictEqual(treeRefreshes, 1);
    });

    test('refreshVirtualSchemaAndReload keeps the completion cache and the tree when the refresh fails', async () => {
        const { oa } = makeObjectActions(async () => createRawErrorResult('42500', 'insufficient privileges'));

        const { clearedConnections, treeRefreshes } = await refreshAndRecord(oa);

        assert.deepStrictEqual(clearedConnections, []);
        assert.strictEqual(treeRefreshes, 0);
        assert.strictEqual(errorMessages.length, 1);
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

suite('qualifyScriptText', () => {
    // SCRIPT_TEXT values as the database stores them (docker, 2026-10-22).
    const shapes: Array<[string, string, string]> = [
        ['PYVER', 'CREATE PYTHON3 SCALAR SCRIPT "PYVER" () RETURNS VARCHAR(200) UTF8 AS\nimport sys\ndef run(ctx):\n    return sys.version\n',
            'CREATE OR REPLACE PYTHON3 SCALAR SCRIPT "VS_SRC"."PYVER" () RETURNS VARCHAR(200) UTF8 AS\nimport sys\ndef run(ctx):\n    return sys.version\n\n/'],
        ['PYSET', 'CREATE PYTHON3 SET SCRIPT "PYSET" ("a" DECIMAL(18,0), "b" VARCHAR(10) UTF8) EMITS ("X" DECIMAL(18,0), "Y" VARCHAR(10) UTF8) AS\ndef run(ctx):\n    pass\n',
            'CREATE OR REPLACE PYTHON3 SET SCRIPT "VS_SRC"."PYSET" ("a" DECIMAL(18,0), "b" VARCHAR(10) UTF8) EMITS ("X" DECIMAL(18,0), "Y" VARCHAR(10) UTF8) AS\ndef run(ctx):\n    pass\n\n/'],
        ['PYDYN', 'CREATE PYTHON3 SCALAR SCRIPT "PYDYN" (...) RETURNS VARCHAR(100) UTF8 AS\ndef run(ctx):\n    return \'x\'\n',
            'CREATE OR REPLACE PYTHON3 SCALAR SCRIPT "VS_SRC"."PYDYN" (...) RETURNS VARCHAR(100) UTF8 AS\ndef run(ctx):\n    return \'x\'\n\n/'],
        ['PYEMITDYN', 'CREATE PYTHON3 SCALAR SCRIPT "PYEMITDYN" ("v" VARCHAR(10) UTF8) EMITS (...) AS\ndef run(ctx):\n    ctx.emit(\'x\')\n',
            'CREATE OR REPLACE PYTHON3 SCALAR SCRIPT "VS_SRC"."PYEMITDYN" ("v" VARCHAR(10) UTF8) EMITS (...) AS\ndef run(ctx):\n    ctx.emit(\'x\')\n\n/'],
        ['ADAPTER', 'CREATE LUA  ADAPTER SCRIPT "ADAPTER" AS\nfunction adapter_call(request)\nend\n',
            'CREATE OR REPLACE LUA  ADAPTER SCRIPT "VS_SRC"."ADAPTER" AS\nfunction adapter_call(request)\nend\n\n/'],
        ['LUASCR', 'CREATE LUA SCRIPT "LUASCR" (a,b) RETURNS TABLE AS\nlocal x = 1;\n  exit({{a}}, "v int")',
            'CREATE OR REPLACE LUA SCRIPT "VS_SRC"."LUASCR" (a,b) RETURNS TABLE AS\nlocal x = 1;\n  exit({{a}}, "v int")\n/'],
    ];

    for (const [name, text, expected] of shapes) {
        test(`qualifies the ${name} header and keeps the body`, () => {
            const result = qualifyScriptText(text, 'VS_SRC', name);
            assert.strictEqual(result, expected);
            assert.ok(result.endsWith(`${text.slice(text.indexOf(' AS\n'))}\n/`), 'body must be unchanged');
        });
    }

    test('escapes double quotes in schema and script names', () => {
        const text = 'CREATE PYTHON3 SCALAR SCRIPT "my ""odd"" udf" ("lo" VARCHAR(10) UTF8) RETURNS VARCHAR(30) UTF8 AS\nSCRIPT "x"\n';
        assert.strictEqual(
            qualifyScriptText(text, 's"x', 'my "odd" udf'),
            'CREATE OR REPLACE PYTHON3 SCALAR SCRIPT "s""x"."my ""odd"" udf" ("lo" VARCHAR(10) UTF8) RETURNS VARCHAR(30) UTF8 AS\nSCRIPT "x"\n\n/'
        );
    });

    test('the splitter reads the result as one statement with the body unchanged', () => {
        for (const [name, text, expected] of shapes) {
            assert.deepStrictEqual(splitIntoStatements(qualifyScriptText(text, 'VS_SRC', name)), [expected.slice(0, -2)]);
        }
    });

    test('a / line stored at the end of the text is not doubled', () => {
        assert.strictEqual(
            qualifyScriptText('CREATE LUA SCRIPT "L" AS\nexit()\n/\n', 'S', 'L'),
            'CREATE OR REPLACE LUA SCRIPT "S"."L" AS\nexit()\n/'
        );
    });

    test('returns text with an unexpected header unchanged', () => {
        assert.strictEqual(qualifyScriptText('something else', 'S', 'N'), 'something else');
    });
});

suite('qualifyFunctionText', () => {
    test('replaces an unquoted qualified name', () => {
        assert.strictEqual(
            qualifyFunctionText('FUNCTION VS_SRC.F1(p DECIMAL) RETURN DECIMAL IS BEGIN RETURN p; END;', 'VS_SRC', 'F1'),
            'CREATE OR REPLACE FUNCTION "VS_SRC"."F1"(p DECIMAL) RETURN DECIMAL IS BEGIN RETURN p; END;\n/'
        );
    });

    test('adds the schema to a name written without it', () => {
        assert.strictEqual(
            qualifyFunctionText('function "fn lower" (p decimal) return decimal is\nbegin\n  return p;\nend "fn lower";', 'VS_SRC', 'fn lower'),
            'CREATE OR REPLACE function "VS_SRC"."fn lower" (p decimal) return decimal is\nbegin\n  return p;\nend "fn lower";\n/'
        );
    });

    test('replaces a quoted qualified name and escapes double quotes', () => {
        assert.strictEqual(
            qualifyFunctionText('FUNCTION "a""b"."f" (p decimal) return decimal is begin return p; end;', 'a"b', 'f'),
            'CREATE OR REPLACE FUNCTION "a""b"."f" (p decimal) return decimal is begin return p; end;\n/'
        );
    });

    test('the splitter reads the result as one statement', () => {
        const text = 'FUNCTION VS_SRC.F3 (s VARCHAR(10)) RETURN VARCHAR(20)\nIS\n  r VARCHAR(20);\nBEGIN\n  r := s || \';\';\n  RETURN r;\nEND F3;';
        assert.deepStrictEqual(
            splitIntoStatements(`${qualifyFunctionText(text, 'VS_SRC', 'F3')}\nSELECT 1;`),
            [`CREATE OR REPLACE FUNCTION "VS_SRC"."F3"${text.slice('FUNCTION VS_SRC.F3'.length)}`, 'SELECT 1;']
        );
    });

    test('replaces a qualified name with spaces around the dot', () => {
        // Stored verbatim this way (docker, 2026-10-22).
        assert.strictEqual(
            qualifyFunctionText('FUNCTION VS_GK . CF3 () RETURN DECIMAL IS BEGIN RETURN 1; END CF3;', 'VS_GK', 'CF3'),
            'CREATE OR REPLACE FUNCTION "VS_GK"."CF3" () RETURN DECIMAL IS BEGIN RETURN 1; END CF3;\n/'
        );
    });

    test('a / line stored at the end of the text is not doubled', () => {
        for (const stored of ['\n/', '\n/\n', '\r\n  /  ']) {
            assert.strictEqual(
                qualifyFunctionText(`FUNCTION F (p DECIMAL) RETURN DECIMAL IS BEGIN RETURN p; END f;${stored}`, 'S', 'F'),
                'CREATE OR REPLACE FUNCTION "S"."F" (p DECIMAL) RETURN DECIMAL IS BEGIN RETURN p; END f;\n/'
            );
        }
        assert.strictEqual(qualifyFunctionText('something else\n/', 'S', 'N'), 'CREATE OR REPLACE something else\n/');
    });

    test('keeps a comment that touches the name', () => {
        // Stored verbatim this way (docker, 2026-10-22).
        assert.strictEqual(
            qualifyFunctionText('FUNCTION VS_SRC.F/*c*/(p DECIMAL) RETURN DECIMAL IS BEGIN RETURN p; END F;', 'VS_SRC', 'F'),
            'CREATE OR REPLACE FUNCTION "VS_SRC"."F"/*c*/(p DECIMAL) RETURN DECIMAL IS BEGIN RETURN p; END F;\n/'
        );
        assert.strictEqual(
            qualifyFunctionText('FUNCTION VS_SRC.F_CMT--x\n(p DECIMAL) RETURN DECIMAL IS BEGIN RETURN p; END F_CMT;', 'VS_SRC', 'F_CMT'),
            'CREATE OR REPLACE FUNCTION "VS_SRC"."F_CMT"--x\n(p DECIMAL) RETURN DECIMAL IS BEGIN RETURN p; END F_CMT;\n/'
        );
    });

    test('replaces the whole name when comments surround the dot', () => {
        // Stored verbatim this way (docker, 2026-10-23).
        for (const stored of ['S/*c*/.F', 'S --c\n.F', 'S./*c*/F', 'S/*a*/./*b*/F']) {
            assert.strictEqual(
                qualifyFunctionText(`FUNCTION ${stored}(x NUMBER) RETURN NUMBER IS BEGIN RETURN x; END F;`, 'S', 'F'),
                'CREATE OR REPLACE FUNCTION "S"."F"(x NUMBER) RETURN NUMBER IS BEGIN RETURN x; END F;\n/',
                stored
            );
        }
    });

    test('comments with stars around the dot', () => {
        for (const stored of ['S/***/.F', 'S/* * */.F', 'S/**a**/.F']) {
            assert.strictEqual(
                qualifyFunctionText(`FUNCTION ${stored}(x NUMBER) RETURN NUMBER IS BEGIN RETURN x; END F;`, 'S', 'F'),
                'CREATE OR REPLACE FUNCTION "S"."F"(x NUMBER) RETURN NUMBER IS BEGIN RETURN x; END F;\n/',
                stored
            );
        }
    });

    test('an unqualified name followed by many spaces is matched in linear time', () => {
        const gap = ' '.repeat(40);
        for (const rest of [`${gap}(x NUMBER)`, `${gap}\n    (x NUMBER)`]) {
            const started = Date.now();
            const ddl = qualifyFunctionText(`FUNCTION F${rest} RETURN NUMBER IS BEGIN RETURN x; END F;`, 'S', 'F');
            assert.ok(Date.now() - started < 50, `took ${Date.now() - started} ms`);
            assert.strictEqual(ddl, `CREATE OR REPLACE FUNCTION "S"."F"${rest} RETURN NUMBER IS BEGIN RETURN x; END F;\n/`);
        }
    });

    test('a trailing line comment does not hide the / line', () => {
        const ddl = qualifyFunctionText('FUNCTION S.F (p DECIMAL) RETURN DECIMAL IS BEGIN RETURN p; END F; -- note', 'S', 'F');
        assert.strictEqual(splitIntoStatements(`${ddl}\nSELECT 2;`).length, 2);
    });

    test('only prefixes text with an unexpected header', () => {
        assert.strictEqual(qualifyFunctionText('something else', 'S', 'N'), 'CREATE OR REPLACE something else\n/');
    });
});

suite('ObjectActions script and function source', () => {
    let savedWindow: ObjectActionsVscodeMock['window'];
    let savedWorkspace: ObjectActionsVscodeMock['workspace'];
    let opened: string[];
    let warnings: string[];
    let errors: string[];

    setup(() => {
        savedWindow = extendedVscodeMock.window;
        savedWorkspace = extendedVscodeMock.workspace;
        opened = [];
        warnings = [];
        errors = [];
        extendedVscodeMock.window = {
            ...buildWindowMock(),
            showWarningMessage: (msg: string) => { warnings.push(msg); return Promise.resolve(undefined); },
            showErrorMessage: (msg: string) => { errors.push(msg); return Promise.resolve(undefined); },
        };
        extendedVscodeMock.workspace = {
            ...buildWorkspaceMock(),
            openTextDocument: (opts: unknown) => {
                opened.push((opts as { content: string }).content);
                return Promise.resolve({ languageId: 'exasol-sql' });
            },
        };
    });

    teardown(() => {
        extendedVscodeMock.window = savedWindow;
        extendedVscodeMock.workspace = savedWorkspace;
    });

    function makeObjectActions(respond: (sql: string) => ReturnType<MockDriver['query']>): {
        oa: InstanceType<typeof ObjectActions>;
        capturedSql: string[];
    } {
        const capturedSql: string[] = [];
        const mockCM = new MockConnectionManager({ query: (sql: string) => { capturedSql.push(sql); return respond(sql); } });
        // ObjectActions never reads queryExecutor or extensionUri; same rationale as above.
        const mockQE = {} as unknown as QueryExecutor;
        const mockUri = { fsPath: '/mock' } as unknown as vscode.Uri;
        return { oa: new ObjectActions(asConnectionManager(mockCM), mockQE, mockUri), capturedSql };
    }

    test('openScriptSource reads SCRIPT_TEXT with escaped names and opens the qualified text', async () => {
        const { oa, capturedSql } = makeObjectActions(async () =>
            createRawResult(['SCRIPT_TEXT'], [['CREATE PYTHON3 SCALAR SCRIPT "O\'B" () RETURNS INT AS\nx']]));

        await oa.openScriptSource(TEST_CONNECTION, "S'X", "O'B");

        assert.ok(capturedSql[0].includes("SCRIPT_SCHEMA = 'S''X'"));
        assert.ok(capturedSql[0].includes("SCRIPT_NAME = 'O''B'"));
        assert.deepStrictEqual(opened, ['CREATE OR REPLACE PYTHON3 SCALAR SCRIPT "S\'X"."O\'B" () RETURNS INT AS\nx\n/']);
    });

    test('openScriptSource warns when the script is gone', async () => {
        const { oa } = makeObjectActions(async () => createEmptyRawResult(['SCRIPT_TEXT']));

        await oa.openScriptSource(TEST_CONNECTION, 'S', 'N');

        assert.deepStrictEqual(opened, []);
        assert.deepStrictEqual(warnings, ['Script definition not found for S.N']);
    });

    test('openFunctionSource reads FUNCTION_TEXT and opens the qualified text', async () => {
        const { oa, capturedSql } = makeObjectActions(async () =>
            createRawResult(['FUNCTION_TEXT'], [['FUNCTION F1(p DECIMAL) RETURN DECIMAL IS BEGIN RETURN p; END;']]));

        await oa.openFunctionSource(TEST_CONNECTION, 'S', 'F1');

        assert.ok(capturedSql[0].includes('FROM SYS.EXA_ALL_FUNCTIONS'));
        assert.deepStrictEqual(opened, ['CREATE OR REPLACE FUNCTION "S"."F1"(p DECIMAL) RETURN DECIMAL IS BEGIN RETURN p; END;\n/']);
    });

    test('openFunctionSource shows the database error text', async () => {
        const { oa } = makeObjectActions(async () => createRawErrorResult('42000', 'insufficient privileges'));

        await oa.openFunctionSource(TEST_CONNECTION, 'S', 'F1');

        assert.strictEqual(errors.length, 1);
        assert.ok(errors[0].startsWith('Failed to get function source: '));
        assert.ok(errors[0].includes('insufficient privileges'));
    });
});

suite('buildScriptCall', () => {
    const call = (header: string, inputType: string | null = 'SCALAR', name = 'F') =>
        buildScriptCall(`${header} AS\ndef run(ctx):\n    return 1\n`, 'VS_SRC', name, inputType);

    test('no parameters', () => {
        assert.strictEqual(call('CREATE PYTHON3 SCALAR SCRIPT "F" () RETURNS VARCHAR(200) UTF8'), 'SELECT "VS_SRC"."F"();');
    });

    test('parameters become column placeholders; types with commas stay out', () => {
        assert.strictEqual(
            call('CREATE PYTHON3 SET SCRIPT "F" ("a" DECIMAL(18,0), "b" VARCHAR(10) UTF8) EMITS ("X" DECIMAL(18,0), "Y" VARCHAR(10) UTF8)', 'SET'),
            'SELECT "VS_SRC"."F"("a", "b")\nFROM <table>;'
        );
    });

    test('scalar script with parameters also gets the FROM placeholder', () => {
        assert.strictEqual(
            call('CREATE PYTHON3 SCALAR SCRIPT "F" ("v" VARCHAR(10) UTF8) RETURNS VARCHAR(10) UTF8'),
            'SELECT "VS_SRC"."F"("v")\nFROM <table>;'
        );
    });

    test('dynamic output gets an EMITS placeholder', () => {
        // Without EMITS or default_output_columns() the call fails (docker, 2026-10-23).
        const emits = 'EMITS (<column> <type>) /* remove when the script defines default_output_columns() */';
        assert.strictEqual(
            call('CREATE PYTHON3 SCALAR SCRIPT "F" ("v" VARCHAR(10) UTF8) EMITS (...)'),
            `SELECT "VS_SRC"."F"("v") ${emits}\nFROM <table>;`
        );
        assert.strictEqual(
            call('CREATE PYTHON3 SET SCRIPT "F" (...) EMITS (...)', 'SET'),
            `SELECT "VS_SRC"."F"(/* arguments */) ${emits}\nFROM <table>;`
        );
        assert.strictEqual(
            call('CREATE PYTHON3 SCALAR SCRIPT "F" () EMITS (...)'),
            `SELECT "VS_SRC"."F"() ${emits};`
        );
    });

    test('dynamic parameters get a comment placeholder', () => {
        assert.strictEqual(
            call('CREATE PYTHON3 SCALAR SCRIPT "F" (...) RETURNS VARCHAR(100) UTF8'),
            'SELECT "VS_SRC"."F"(/* arguments */)\nFROM <table>;'
        );
    });

    test('quoted names with double quotes, commas and parentheses are kept as written', () => {
        assert.strictEqual(
            call('CREATE PYTHON3 SCALAR SCRIPT "my ""odd"" udf" ("lo" VARCHAR(10) UTF8, "Q""t" DECIMAL(5,2), "a,(b" INT) RETURNS INT', 'SCALAR', 'my "odd" udf'),
            'SELECT "VS_SRC"."my ""odd"" udf"("lo", "Q""t", "a,(b")\nFROM <table>;'
        );
    });

    test('falls back to a comment placeholder when the parameters cannot be read', () => {
        for (const header of [
            'something else',
            'CREATE PYTHON3 SCALAR SCRIPT "F" RETURNS INT',
            'CREATE PYTHON3 SCALAR SCRIPT "F" (a INT) RETURNS INT',
            'CREATE PYTHON3 SCALAR SCRIPT "F" ("a" INT',
        ]) {
            assert.strictEqual(call(header), 'SELECT "VS_SRC"."F"(/* arguments */);', header);
        }
    });

    test('dynamic output gets the EMITS placeholder also when the parameters cannot be read', () => {
        const emits = 'EMITS (<column> <type>) /* remove when the script defines default_output_columns() */';
        assert.strictEqual(
            call('CREATE PYTHON3 SET SCRIPT "F" (a INT) EMITS (...)', 'SET'),
            `SELECT "VS_SRC"."F"(/* arguments */) ${emits};`
        );
    });
});

suite('ObjectActions.generateScriptCall', () => {
    let savedWindow: ObjectActionsVscodeMock['window'];
    let savedWorkspace: ObjectActionsVscodeMock['workspace'];
    let opened: string[];

    setup(() => {
        savedWindow = extendedVscodeMock.window;
        savedWorkspace = extendedVscodeMock.workspace;
        opened = [];
        extendedVscodeMock.window = buildWindowMock();
        extendedVscodeMock.workspace = {
            ...buildWorkspaceMock(),
            openTextDocument: (opts: unknown) => {
                opened.push((opts as { content: string }).content);
                return Promise.resolve({ languageId: 'exasol-sql' });
            },
        };
    });

    teardown(() => {
        extendedVscodeMock.window = savedWindow;
        extendedVscodeMock.workspace = savedWorkspace;
    });

    function makeObjectActions(rows: RawRows): InstanceType<typeof ObjectActions> {
        const mockCM = new MockConnectionManager({ query: async () => createRawResult(['SCRIPT_TEXT', 'SCRIPT_INPUT_TYPE'], rows) });
        // ObjectActions never reads queryExecutor or extensionUri; same rationale as above.
        const mockQE = {} as unknown as QueryExecutor;
        const mockUri = { fsPath: '/mock' } as unknown as vscode.Uri;
        return new ObjectActions(asConnectionManager(mockCM), mockQE, mockUri);
    }

    function activeSqlEditor(inserted: string[]): ObjectActionsVscodeMock['window']['activeTextEditor'] {
        return {
            document: { languageId: 'exasol-sql' },
            selection: { active: 'cursor' },
            edit: async (cb: (builder: { insert: (pos: unknown, text: string) => void }) => void) => {
                cb({ insert: (_pos, text) => inserted.push(text) });
                return true;
            },
        } as ObjectActionsVscodeMock['window']['activeTextEditor'];
    }

    test('opens the call in a new document when no SQL editor is active', async () => {
        const oa = makeObjectActions([['CREATE PYTHON3 SET SCRIPT "PYSETR" ("v" DECIMAL(18,0)) RETURNS DECIMAL(18,0) AS\nx', 'SET']]);

        await oa.generateScriptCall(TEST_CONNECTION, 'VS_SRC', 'PYSETR');

        assert.deepStrictEqual(opened, ['SELECT "VS_SRC"."PYSETR"("v")\nFROM <table>;']);
    });

    test('opens the call in a new document, never in the active SQL editor', async () => {
        const inserted: string[] = [];
        extendedVscodeMock.window = { ...buildWindowMock(), activeTextEditor: activeSqlEditor(inserted) };
        const oa = makeObjectActions([['CREATE PYTHON3 SCALAR SCRIPT "PYVER" () RETURNS VARCHAR(200) UTF8 AS\nx', 'SCALAR']]);

        await oa.generateScriptCall(TEST_CONNECTION, 'VS_SRC', 'PYVER');

        assert.deepStrictEqual(opened, ['SELECT "VS_SRC"."PYVER"();']);
        assert.deepStrictEqual(inserted, []);
    });

    test('Generate SELECT opens a new document, never the active SQL editor', async () => {
        const inserted: string[] = [];
        extendedVscodeMock.window = { ...buildWindowMock(), activeTextEditor: activeSqlEditor(inserted) };
        const mockCM = new MockConnectionManager({ query: async () => createRawResult(['COLUMN_NAME'], [['ID'], ['NAME']]) });
        const oa = new ObjectActions(asConnectionManager(mockCM), {} as unknown as QueryExecutor, { fsPath: '/mock' } as unknown as vscode.Uri);

        await oa.generateSelectStatement(TEST_CONNECTION, 'MY_SCHEMA', 'MY_TABLE');

        assert.deepStrictEqual(opened, ['SELECT\n    "ID",\n    "NAME"\nFROM "MY_SCHEMA"."MY_TABLE"\nLIMIT 100;']);
        assert.deepStrictEqual(inserted, []);
    });
});

suite('ObjectActions on system tables', () => {
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

    async function columnsViewUsed(action: 'describeTable' | 'generateSelectStatement', schemaName: string): Promise<string> {
        const { oa, capturedSql } = makeObjectActionsCapturingSql();
        const originalShow = ResultsPanel.show;
        ResultsPanel.show = () => {};
        try {
            await oa[action](TEST_CONNECTION, schemaName, 'EXA_ALL_TABLES');
        } finally {
            ResultsPanel.show = originalShow;
        }
        const view = /FROM (SYS\.EXA_\w+_COLUMNS)/.exec(capturedSql[0])?.[1];
        assert.ok(view, `no columns view in: ${capturedSql[0]}`);
        return view;
    }

    for (const action of ['describeTable', 'generateSelectStatement'] as const) {
        test(`${action} reads SYS and EXA_STATISTICS columns from EXA_SYS_COLUMNS`, async () => {
            assert.strictEqual(await columnsViewUsed(action, 'SYS'), 'SYS.EXA_SYS_COLUMNS');
            assert.strictEqual(await columnsViewUsed(action, 'EXA_STATISTICS'), 'SYS.EXA_SYS_COLUMNS');
        });

        test(`${action} keeps EXA_ALL_COLUMNS for other schemas`, async () => {
            assert.strictEqual(await columnsViewUsed(action, 'MY_SCHEMA'), 'SYS.EXA_ALL_COLUMNS');
            assert.strictEqual(await columnsViewUsed(action, 'sys'), 'SYS.EXA_ALL_COLUMNS');
        });
    }
});

suite('buildConnectionDDL', () => {
    const full = {
        CONNECTION_STRING: 'https://example-bucket.s3.eu-west-1.amazonaws.com',
        USER_NAME: 'key_id',
        PUBLIC_KEY: null,
        CLIENT_ID: null
    };

    test('full definition with user and comment', () => {
        assert.strictEqual(
            buildConnectionDDL('VS_TEST_CONN', 'test comment', full),
            'CREATE OR REPLACE CONNECTION "VS_TEST_CONN"\n'
            + "    TO 'https://example-bucket.s3.eu-west-1.amazonaws.com'\n"
            + "    USER 'key_id'\n"
            + "    IDENTIFIED BY '<password>';\n"
            + 'COMMENT ON CONNECTION "VS_TEST_CONN" IS \'test comment\';'
        );
    });

    test('no user and no comment', () => {
        assert.strictEqual(
            buildConnectionDDL('C', null, { ...full, CONNECTION_STRING: 'jdbc:mysql://h/db', USER_NAME: null }),
            "CREATE OR REPLACE CONNECTION \"C\"\n    TO 'jdbc:mysql://h/db';"
        );
    });

    test('quotes in string, user, comment and name are escaped', () => {
        assert.strictEqual(
            buildConnectionDDL('VS_LOWER"Q', "it's", { ...full, CONNECTION_STRING: "a'b", USER_NAME: "o'u" }),
            'CREATE OR REPLACE CONNECTION "VS_LOWER""Q"\n'
            + "    TO 'a''b'\n"
            + "    USER 'o''u'\n"
            + "    IDENTIFIED BY '<password>';\n"
            + 'COMMENT ON CONNECTION "VS_LOWER""Q" IS \'it\'\'s\';'
        );
    });

    test('PUBLIC_KEY and CLIENT_ID get a note line each', () => {
        const ddl = buildConnectionDDL('C', null, { ...full, PUBLIC_KEY: 'k', CLIENT_ID: 'id' });
        const lines = ddl.split('\n');
        assert.ok(lines[0].startsWith('-- Note: PUBLIC_KEY '), lines[0]);
        assert.ok(lines[1].startsWith('-- Note: CLIENT_ID '), lines[1]);
        assert.strictEqual(lines[2], 'CREATE OR REPLACE CONNECTION "C"');
        assert.ok(!ddl.includes("'k'") && !ddl.includes("'id'"));
    });

    test('without a definition address and user are placeholders', () => {
        assert.strictEqual(
            buildConnectionDDL('C', "x'y"),
            '-- Address and user are readable only with the SELECT ANY DICTIONARY system privilege.\n'
            + 'CREATE OR REPLACE CONNECTION "C"\n'
            + "    TO '<address>'\n"
            + "    USER '<user>'\n"
            + "    IDENTIFIED BY '<password>';\n"
            + 'COMMENT ON CONNECTION "C" IS \'x\'\'y\';'
        );
    });
});

suite('ObjectActions.showConnectionDDL', () => {
    let savedWindow: ObjectActionsVscodeMock['window'];
    let savedWorkspace: ObjectActionsVscodeMock['workspace'];
    let opened: string[];
    let warnings: string[];
    let errors: string[];

    setup(() => {
        savedWindow = extendedVscodeMock.window;
        savedWorkspace = extendedVscodeMock.workspace;
        opened = [];
        warnings = [];
        errors = [];
        extendedVscodeMock.window = {
            ...buildWindowMock(),
            showWarningMessage: (msg: string) => { warnings.push(msg); return Promise.resolve(undefined); },
            showErrorMessage: (msg: string) => { errors.push(msg); return Promise.resolve(undefined); },
        };
        extendedVscodeMock.workspace = {
            ...buildWorkspaceMock(),
            openTextDocument: (opts: unknown) => {
                opened.push((opts as { content: string }).content);
                return Promise.resolve({ languageId: 'exasol-sql' });
            },
        };
    });

    teardown(() => {
        extendedVscodeMock.window = savedWindow;
        extendedVscodeMock.workspace = savedWorkspace;
    });

    function makeObjectActions(respond: ReturnType<MockDriver['query']>): { oa: InstanceType<typeof ObjectActions>; capturedSql: string[] } {
        const capturedSql: string[] = [];
        const mockCM = new MockConnectionManager({ query: (sql: string) => { capturedSql.push(sql); return respond; } });
        // ObjectActions never reads queryExecutor or extensionUri; same rationale as above.
        const mockQE = {} as unknown as QueryExecutor;
        const mockUri = { fsPath: '/mock' } as unknown as vscode.Uri;
        return { oa: new ObjectActions(asConnectionManager(mockCM), mockQE, mockUri), capturedSql };
    }

    test('reads EXA_DBA_CONNECTIONS with the escaped name and opens the full DDL', async () => {
        const { oa, capturedSql } = makeObjectActions(Promise.resolve(createRawResult(
            ['CONNECTION_STRING', 'USER_NAME', 'PUBLIC_KEY', 'CLIENT_ID', 'CONNECTION_COMMENT'],
            [['https://x', 'key_id', null, null, 'db comment']]
        )));

        await oa.showConnectionDDL(TEST_CONNECTION, "O'C", 'tree comment');

        assert.match(capturedSql[0], /SELECT \*\s+FROM SYS\.EXA_DBA_CONNECTIONS/);
        assert.ok(capturedSql[0].includes("CONNECTION_NAME = 'O''C'"));
        assert.deepStrictEqual(opened, [buildConnectionDDL("O'C", 'db comment', {
            CONNECTION_STRING: 'https://x', USER_NAME: 'key_id', PUBLIC_KEY: null, CLIENT_ID: null
        })]);
    });

    test('a version without PUBLIC_KEY and CLIENT_ID columns still gives the full DDL', async () => {
        const { oa } = makeObjectActions(Promise.resolve(createRawResult(
            ['CONNECTION_NAME', 'CONNECTION_STRING', 'USER_NAME', 'CREATED', 'CONNECTION_COMMENT'],
            [['C', 'https://x', 'key_id', '2026-10-22 09:00:00.000', null]]
        )));

        await oa.showConnectionDDL(TEST_CONNECTION, 'C', 'tree comment');

        assert.deepStrictEqual(errors, []);
        assert.deepStrictEqual(opened, [
            'CREATE OR REPLACE CONNECTION "C"\n'
            + "    TO 'https://x'\n"
            + "    USER 'key_id'\n"
            + "    IDENTIFIED BY '<password>';"
        ]);
    });

    test('insufficient privileges falls back to the template with the tree comment', async () => {
        const { oa } = makeObjectActions(Promise.resolve(
            createRawErrorResult('42500', 'insufficient privileges for accessing view EXA_DBA_CONNECTIONS')));

        await oa.showConnectionDDL(TEST_CONNECTION, 'C', 'tree comment');

        assert.deepStrictEqual(opened, [buildConnectionDDL('C', 'tree comment')]);
        assert.deepStrictEqual(errors, []);
    });

    test('other SQL errors are shown, not hidden behind the template', async () => {
        const { oa } = makeObjectActions(Promise.resolve(createRawErrorResult('42000', 'syntax error')));

        await oa.showConnectionDDL(TEST_CONNECTION, 'C');

        assert.deepStrictEqual(opened, []);
        assert.strictEqual(errors.length, 1);
        assert.ok(errors[0].startsWith('Failed to get connection DDL: '));
    });

    test('a dropped connection gives a warning', async () => {
        const { oa } = makeObjectActions(Promise.resolve(createEmptyRawResult(
            ['CONNECTION_STRING', 'USER_NAME', 'PUBLIC_KEY', 'CLIENT_ID', 'CONNECTION_COMMENT'])));

        await oa.showConnectionDDL(TEST_CONNECTION, 'C');

        assert.deepStrictEqual(opened, []);
        assert.deepStrictEqual(warnings, ['Connection definition not found for C']);
    });
});

suite('buildTransferTemplate', () => {
    test('IMPORT: CSV statement with the other documented sources as comments', () => {
        assert.strictEqual(buildTransferTemplate('IMPORT', 'C'), [
            'IMPORT INTO my_schema.my_table',
            'FROM CSV AT "C" FILE \'<path/file.csv>\';',
            '-- Other sources, replace the FROM line:',
            '-- FROM FBV AT "C" FILE \'<path/file.fbv>\';',
            '-- FROM PARQUET AT "C" FILE \'<path/file.parquet>\';',
            '-- FROM EXA AT "C" TABLE remote_schema.remote_table;',
            '-- FROM EXA AT "C" STATEMENT \'<SELECT ...>\';',
            '-- FROM ORA AT "C" TABLE remote_schema.remote_table;',
            '-- FROM ORA AT "C" STATEMENT \'<SELECT ...>\';',
            '-- FROM JDBC AT "C" TABLE remote_schema.remote_table;',
            '-- FROM JDBC AT "C" STATEMENT \'<SELECT ...>\';'
        ].join('\n'));
    });

    test('EXPORT: CSV statement with the other documented destinations as comments, without PARQUET', () => {
        assert.strictEqual(buildTransferTemplate('EXPORT', 'C'), [
            'EXPORT my_schema.my_table',
            'INTO CSV AT "C" FILE \'<path/file.csv>\';',
            '-- Other destinations, replace the INTO line:',
            '-- INTO FBV AT "C" FILE \'<path/file.fbv>\';',
            '-- INTO EXA AT "C" TABLE remote_schema.remote_table;',
            '-- INTO EXA AT "C" STATEMENT \'<INSERT ... VALUES (?, ?)>\';',
            '-- INTO ORA AT "C" TABLE remote_schema.remote_table;',
            '-- INTO ORA AT "C" STATEMENT \'<INSERT ... VALUES (?, ?)>\';',
            '-- INTO JDBC AT "C" TABLE remote_schema.remote_table;',
            '-- INTO JDBC AT "C" STATEMENT \'<INSERT ... VALUES (?, ?)>\';'
        ].join('\n'));
    });

    test('the connection name is a quoted identifier on every line', () => {
        const lines = buildTransferTemplate('IMPORT', 'VS_LOWER"Q').split('\n').filter(line => line.includes(' AT '));
        assert.strictEqual(lines.length, 9);
        assert.ok(lines.every(line => line.includes('AT "VS_LOWER""Q" ')), lines.join('\n'));
    });

    test('the splitter reads the template as the one active statement', () => {
        assert.deepStrictEqual(splitIntoStatements(buildTransferTemplate('EXPORT', 'C')),
            ['EXPORT my_schema.my_table\nINTO CSV AT "C" FILE \'<path/file.csv>\';']);
    });
});

suite('ObjectActions.generateTransfer', () => {
    let savedWindow: ObjectActionsVscodeMock['window'];
    let savedWorkspace: ObjectActionsVscodeMock['workspace'];
    let opened: string[];

    setup(() => {
        savedWindow = extendedVscodeMock.window;
        savedWorkspace = extendedVscodeMock.workspace;
        opened = [];
        extendedVscodeMock.window = buildWindowMock();
        extendedVscodeMock.workspace = {
            ...buildWorkspaceMock(),
            openTextDocument: (opts: unknown) => {
                opened.push((opts as { content: string }).content);
                return Promise.resolve({ languageId: 'exasol-sql' });
            },
        };
    });

    teardown(() => {
        extendedVscodeMock.window = savedWindow;
        extendedVscodeMock.workspace = savedWorkspace;
    });

    test('opens the template in a new document without running SQL', async () => {
        const { oa, capturedSql } = makeObjectActionsCapturingSql();

        await oa.generateTransfer('IMPORT', 'C');
        await oa.generateTransfer('EXPORT', 'C');

        assert.deepStrictEqual(opened, [buildTransferTemplate('IMPORT', 'C'), buildTransferTemplate('EXPORT', 'C')]);
        assert.deepStrictEqual(capturedSql, []);
    });
});

suite('qualifyViewText', () => {
    // VIEW_TEXT holds the whole statement as written, trailing comments included (docker, 2026-10-22).
    const cases: Array<[string, string, string]> = [
        ['CREATE VIEW VS_SRC.PERM_V AS SELECT ID, NAME FROM VS_SRC.PERM_T WHERE ID > 1', 'PERM_V',
            'CREATE OR REPLACE VIEW "VS_SRC"."PERM_V" AS SELECT ID, NAME FROM VS_SRC.PERM_T WHERE ID > 1\n;'],
        ['CREATE OR REPLACE VIEW V_PLAIN AS SELECT 1 AS A', 'V_PLAIN',
            'CREATE OR REPLACE VIEW "VS_SRC"."V_PLAIN" AS SELECT 1 AS A\n;'],
        ['create or replace view v_lower as select 9 as g', 'V_LOWER',
            'CREATE OR REPLACE view "VS_SRC"."V_LOWER" as select 9 as g\n;'],
        ['CREATE OR REPLACE VIEW "VS_SRC"."v Quoted" AS SELECT 3 AS C', 'v Quoted',
            'CREATE OR REPLACE VIEW "VS_SRC"."v Quoted" AS SELECT 3 AS C\n;'],
        ['CREATE OR REPLACE VIEW "VS_SRC" . "V_SPACED" (X, Y) AS SELECT 4, 5', 'V_SPACED',
            'CREATE OR REPLACE VIEW "VS_SRC"."V_SPACED" (X, Y) AS SELECT 4, 5\n;'],
        ['CREATE OR REPLACE FORCE VIEW V_FORCE AS SELECT 6 AS D', 'V_FORCE',
            'CREATE OR REPLACE FORCE VIEW "VS_SRC"."V_FORCE" AS SELECT 6 AS D\n;'],
        ['CREATE OR REPLACE VIEW\n  V_NEWLINE\nAS\nSELECT 10 AS H', 'V_NEWLINE',
            'CREATE OR REPLACE VIEW\n  "VS_SRC"."V_NEWLINE"\nAS\nSELECT 10 AS H\n;'],
        ['/* lead */ CREATE OR REPLACE VIEW VS_SRC.V_LEADCMT AS SELECT 11 AS I', 'V_LEADCMT',
            '/* lead */ CREATE OR REPLACE VIEW "VS_SRC"."V_LEADCMT" AS SELECT 11 AS I\n;'],
        ['CREATE OR REPLACE VIEW VS_SRC.V_SEMI AS SELECT 12 AS J;', 'V_SEMI',
            'CREATE OR REPLACE VIEW "VS_SRC"."V_SEMI" AS SELECT 12 AS J;'],
        ['CREATE OR REPLACE VIEW VS_SRC.V_TRAIL AS SELECT 1 AS A -- trailing note', 'V_TRAIL',
            'CREATE OR REPLACE VIEW "VS_SRC"."V_TRAIL" AS SELECT 1 AS A -- trailing note\n;'],
        ['CREATE OR REPLACE VIEW VS_SRC.V_BLK AS SELECT 1 AS A /* blk */', 'V_BLK',
            'CREATE OR REPLACE VIEW "VS_SRC"."V_BLK" AS SELECT 1 AS A /* blk */\n;'],
        ['CREATE OR REPLACE VIEW VS_SRC.V_SEMICMT AS SELECT 1 AS A; -- c', 'V_SEMICMT',
            'CREATE OR REPLACE VIEW "VS_SRC"."V_SEMICMT" AS SELECT 1 AS A; -- c'],
        ['CREATE VIEW VS_SRC.V/*c*/AS SELECT 1 AS A', 'V',
            'CREATE OR REPLACE VIEW "VS_SRC"."V"/*c*/AS SELECT 1 AS A\n;'],
        ['CREATE VIEW VS_SRC.V_CMT--x\nAS SELECT 2 AS B', 'V_CMT',
            'CREATE OR REPLACE VIEW "VS_SRC"."V_CMT"--x\nAS SELECT 2 AS B\n;'],
        ['CREATE VIEW VS_SRC/*c*/.V_DOT AS SELECT 1 AS X', 'V_DOT',
            'CREATE OR REPLACE VIEW "VS_SRC"."V_DOT" AS SELECT 1 AS X\n;'],
        ['CREATE VIEW VS_SRC --c\n. /*d*/ V_DOT AS SELECT 1 AS X', 'V_DOT',
            'CREATE OR REPLACE VIEW "VS_SRC"."V_DOT" AS SELECT 1 AS X\n;'],
        ["CREATE VIEW VS_SRC.V_STR AS SELECT '--' AS S", 'V_STR',
            `CREATE OR REPLACE VIEW "VS_SRC"."V_STR" AS SELECT '--' AS S\n;`],
        ['CREATE VIEW VS_SRC.V_QID AS SELECT 1 AS "a--b";', 'V_QID',
            'CREATE OR REPLACE VIEW "VS_SRC"."V_QID" AS SELECT 1 AS "a--b";'],
        ['CREATE VIEW VS_SRC.V_QID AS SELECT 1 AS "a/*b"', 'V_QID',
            'CREATE OR REPLACE VIEW "VS_SRC"."V_QID" AS SELECT 1 AS "a/*b"\n;'],
    ];
    for (const [stored, name, expected] of cases) {
        test(`qualifies ${JSON.stringify(stored.slice(0, 60))}`, () => {
            assert.strictEqual(qualifyViewText(stored, 'VS_SRC', name), expected);
        });
    }

    test('escapes double quotes in schema and view names', () => {
        assert.strictEqual(
            qualifyViewText('CREATE VIEW "a""b"."v""w" AS SELECT 1 x', 'a"b', 'v"w'),
            'CREATE OR REPLACE VIEW "a""b"."v""w" AS SELECT 1 x\n;'
        );
    });

    test('the splitter reads the result as one statement', () => {
        const ddl = qualifyViewText("CREATE VIEW S.V AS SELECT 'a;b' AS X", 'S', 'V');
        assert.deepStrictEqual(splitIntoStatements(`${ddl}\nSELECT 1;`), [ddl, 'SELECT 1;']);
    });

    for (const stored of [
        'CREATE VIEW S.V AS SELECT 1 AS A -- trailing note',
        'CREATE VIEW S.V AS SELECT 1 AS A /* blk */',
        'CREATE VIEW S.V AS SELECT 1 AS A; -- c',
    ]) {
        test(`the splitter ends ${JSON.stringify(stored.slice(32))} before the next statement`, () => {
            assert.strictEqual(splitIntoStatements(`${qualifyViewText(stored, 'S', 'V')}\nSELECT 2;`).length, 2);
        });
    }

    test('an unqualified name followed by many spaces is matched in linear time', () => {
        const gap = ' '.repeat(40);
        for (const rest of [`${gap}AS SELECT 1 X;`, `${gap}\n    AS SELECT 1 X;`]) {
            const started = Date.now();
            const ddl = qualifyViewText(`CREATE VIEW V${rest}`, 'S', 'V');
            assert.ok(Date.now() - started < 50, `took ${Date.now() - started} ms`);
            assert.strictEqual(ddl, `CREATE OR REPLACE VIEW "S"."V"${rest}`);
        }
    });

    test('text with an unexpected header only gets the semicolon', () => {
        assert.strictEqual(qualifyViewText('SELECT 1', 'S', 'V'), 'SELECT 1\n;');
    });
});

suite('ObjectActions with no visible columns', () => {
    let savedWindow: ObjectActionsVscodeMock['window'];
    let savedWorkspace: ObjectActionsVscodeMock['workspace'];
    let opened: string[];
    let warnings: string[];
    let shown: number;
    let originalShow: typeof ResultsPanel.show;

    setup(() => {
        savedWindow = extendedVscodeMock.window;
        savedWorkspace = extendedVscodeMock.workspace;
        opened = [];
        warnings = [];
        shown = 0;
        originalShow = ResultsPanel.show;
        ResultsPanel.show = async () => { shown++; };
        extendedVscodeMock.window = {
            ...buildWindowMock(),
            showWarningMessage: (msg: string) => { warnings.push(msg); return Promise.resolve(undefined); },
        };
        extendedVscodeMock.workspace = {
            ...buildWorkspaceMock(),
            openTextDocument: (opts: unknown) => {
                opened.push((opts as { content: string }).content);
                return Promise.resolve({ languageId: 'exasol-sql' });
            },
        };
    });

    teardown(() => {
        ResultsPanel.show = originalShow;
        extendedVscodeMock.window = savedWindow;
        extendedVscodeMock.workspace = savedWorkspace;
    });

    function makeObjectActions(columns: string[]): InstanceType<typeof ObjectActions> {
        const mockCM = new MockConnectionManager({ query: async () => createEmptyRawResult(columns) });
        // ObjectActions never reads queryExecutor or extensionUri; same rationale as above.
        return new ObjectActions(asConnectionManager(mockCM), {} as unknown as QueryExecutor, { fsPath: '/mock' } as unknown as vscode.Uri);
    }

    test('Describe Table warns and opens no panel', async () => {
        const oa = makeObjectActions(['COLUMN_NAME', 'COLUMN_TYPE', 'COLUMN_IS_NULLABLE', 'COLUMN_DEFAULT', 'COLUMN_COMMENT']);

        await oa.describeTable(TEST_CONNECTION, 'VS_PY', 'T');

        assert.strictEqual(shown, 0);
        assert.deepStrictEqual(warnings, ['No columns visible for "VS_PY"."T"']);
    });

    test('Generate SELECT warns and opens no document', async () => {
        const oa = makeObjectActions(['COLUMN_NAME']);

        await oa.generateSelectStatement(TEST_CONNECTION, 'VS_PY', 'T');

        assert.deepStrictEqual(opened, []);
        assert.deepStrictEqual(warnings, ['No columns visible for "VS_PY"."T"']);
    });

    test('Show Table DDL warns and opens no document', async () => {
        const oa = makeObjectActions(['COLUMN_NAME', 'COLUMN_TYPE', 'COLUMN_DEFAULT', 'COLUMN_IS_NULLABLE', 'COLUMN_COMMENT']);

        await oa.showTableDDL(TEST_CONNECTION, 'VS_PY', 'T');

        assert.deepStrictEqual(opened, []);
        assert.deepStrictEqual(warnings, ['No columns visible for "VS_PY"."T"']);
    });

    test('Show View DDL warns with the quoted name when no view is visible', async () => {
        const oa = makeObjectActions(['VIEW_TEXT']);

        await oa.showViewDDL(TEST_CONNECTION, 'a"b', 'V');

        assert.deepStrictEqual(opened, []);
        assert.deepStrictEqual(warnings, ['No view visible for "a""b"."V"']);
    });

    test('Show Table DDL and Show View DDL show the database error text', async () => {
        const errors: string[] = [];
        extendedVscodeMock.window = {
            ...extendedVscodeMock.window,
            showErrorMessage: (msg: string) => { errors.push(msg); return Promise.resolve(undefined); },
        };
        const mockCM = new MockConnectionManager({ query: async () => { throw { text: 'insufficient privileges', sqlCode: '42500' }; } });
        const oa = new ObjectActions(asConnectionManager(mockCM), {} as unknown as QueryExecutor, { fsPath: '/mock' } as unknown as vscode.Uri);

        await oa.showTableDDL(TEST_CONNECTION, 'S', 'T');
        await oa.showViewDDL(TEST_CONNECTION, 'S', 'V');

        assert.deepStrictEqual(errors, [
            'Failed to get table DDL: insufficient privileges',
            'Failed to get view DDL: insufficient privileges'
        ]);
    });

    test('Show View DDL opens VIEW_TEXT once, as CREATE OR REPLACE with the qualified name', async () => {
        const mockCM = new MockConnectionManager({ query: async () => createRawResult(['VIEW_TEXT'], [['CREATE VIEW VS_SRC.PERM_V AS SELECT ID FROM VS_SRC.PERM_T']]) });
        const oa = new ObjectActions(asConnectionManager(mockCM), {} as unknown as QueryExecutor, { fsPath: '/mock' } as unknown as vscode.Uri);

        await oa.showViewDDL(TEST_CONNECTION, 'VS_SRC', 'PERM_V');

        assert.deepStrictEqual(opened, ['CREATE OR REPLACE VIEW "VS_SRC"."PERM_V" AS SELECT ID FROM VS_SRC.PERM_T\n;']);
    });
});
