import * as vscode from 'vscode';
import { ConnectionManager, StoredConnection } from './connectionManager';
import { QueryExecutor, captureBaselineStatementIdentity } from './queryExecutor';
import { ResultsPanel } from './panels/resultsPanel';
import { getColumnsFromResult, getRowsFromResult, rawQuery, rawExecute, extractColumnMetadata, extractColumnName, escapeSqlString, escapeSqlIdentifier } from './utils';
import { isExecutionPlanEnabled } from './settings';

/** EXPLAIN VIRTUAL columns that are safe to show; PUSHDOWN_JSON is left out on purpose. */
const PUSHDOWN_SAFE_COLUMNS: ReadonlySet<string> = new Set(['PUSHDOWN_ID', 'PUSHDOWN_SQL', 'PUSHDOWN_INVOLVED_TABLES']);

export class ObjectActions {
    constructor(
        private connectionManager: ConnectionManager,
        private queryExecutor: QueryExecutor,
        private extensionUri: vscode.Uri
    ) {}

    async previewTableData(
        connection: StoredConnection,
        schemaName: string,
        tableName: string,
        limit: number = 100,
        showNotification: boolean = true
    ) {
        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Loading preview for ${schemaName}.${tableName}...`,
                    cancellable: false
                },
                async () => {
                    const query = `SELECT * FROM "${escapeSqlIdentifier(schemaName)}"."${escapeSqlIdentifier(tableName)}" LIMIT ${limit}`;
                    const queryResult = await this.connectionManager.executeWithRetry(async () => {
                        const driver = await this.connectionManager.getDriver(connection.id);
                        const shouldCapturePlanIdentity = isExecutionPlanEnabled()
                            && (this.connectionManager.isExecutionPlanAvailable?.(connection.id) ?? true);

                        const identity = shouldCapturePlanIdentity
                            ? await captureBaselineStatementIdentity(driver)
                            : {};
                        const startTime = Date.now();
                        const result = await rawQuery(driver, query);
                        const executionTime = Date.now() - startTime;

                        const columnsMeta = getColumnsFromResult(result);
                        const rows = getRowsFromResult(result);
                        const columns = columnsMeta.map(extractColumnName);
                        const columnMetadata = extractColumnMetadata(columnsMeta);

                        return {
                            columns,
                            columnMetadata,
                            rows,
                            rowCount: rows.length,
                            executionTime,
                            connectionId: connection.id,
                            ...identity
                        };
                    }, connection.id);

                    await ResultsPanel.show(queryResult, query);
                    if (showNotification) {
                        vscode.window.showInformationMessage(
                            `Preview: ${queryResult.rowCount} rows from ${schemaName}.${tableName}`
                        );
                    }
                }
            );
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to preview table: ${error}`);
        }
    }

    async showTableDDL(connection: StoredConnection, schemaName: string, tableName: string) {
        try {
            const rows = await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connection.id);
                const query = `
                    SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT, COLUMN_IS_NULLABLE, COLUMN_COMMENT
                    FROM SYS.EXA_ALL_COLUMNS
                    WHERE COLUMN_SCHEMA = '${escapeSqlString(schemaName)}'
                    AND COLUMN_TABLE = '${escapeSqlString(tableName)}'
                    AND (COLUMN_OBJECT_TYPE = 'TABLE' OR COLUMN_OBJECT_TYPE IS NULL)
                    ORDER BY COLUMN_ORDINAL_POSITION
                `;
                const result = await rawQuery(driver, query);
                return getRowsFromResult<{
                    COLUMN_NAME: string;
                    COLUMN_TYPE: string;
                    COLUMN_DEFAULT: string | null;
                    COLUMN_IS_NULLABLE: boolean | null;
                    COLUMN_COMMENT: string | null;
                }>(result);
            }, connection.id);

            if (rows.length === 0) {
                vscode.window.showErrorMessage(`Table definition not found for ${schemaName}.${tableName}`);
                return;
            }

            // Build DDL
            let ddl = `CREATE TABLE "${escapeSqlIdentifier(schemaName)}"."${escapeSqlIdentifier(tableName)}" (\n`;
            const columns = rows.map(row => {
                // Query is scoped to COLUMN_OBJECT_TYPE = 'TABLE' (or unset), where
                // COLUMN_IS_NULLABLE is never null.
                const nullable = row.COLUMN_IS_NULLABLE === false ? ' NOT NULL' : '';
                const defaultVal = row.COLUMN_DEFAULT ? ` DEFAULT ${row.COLUMN_DEFAULT}` : '';
                const comment = row.COLUMN_COMMENT ? ` -- ${row.COLUMN_COMMENT}` : '';
                return `    "${escapeSqlIdentifier(row.COLUMN_NAME)}" ${row.COLUMN_TYPE}${nullable}${defaultVal}${comment}`;
            });
            ddl += columns.join(',\n');
            ddl += '\n);';

            await openSqlDocument(ddl);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to get table DDL: ${error}`);
        }
    }

    async showViewDDL(connection: StoredConnection, schemaName: string, viewName: string) {
        try {
            const rows = await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connection.id);
                const query = `
                    SELECT VIEW_TEXT
                    FROM SYS.EXA_ALL_VIEWS
                    WHERE VIEW_SCHEMA = '${escapeSqlString(schemaName)}'
                    AND VIEW_NAME = '${escapeSqlString(viewName)}'
                `;
                const result = await rawQuery(driver, query);
                return getRowsFromResult(result);
            }, connection.id);

            if (rows.length > 0) {
                const viewText = rows[0].VIEW_TEXT;
                const ddl = `CREATE VIEW "${escapeSqlIdentifier(schemaName)}"."${escapeSqlIdentifier(viewName)}" AS\n${viewText}`;

                await openSqlDocument(ddl);
            } else {
                vscode.window.showWarningMessage(`View definition not found for ${schemaName}.${viewName}`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to get view DDL: ${error}`);
        }
    }

    async generateSelectStatement(connection: StoredConnection, schemaName: string, tableName: string) {
        try {
            const rows = await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connection.id);
                const query = `
                    SELECT COLUMN_NAME
                    FROM SYS.EXA_ALL_COLUMNS
                    WHERE COLUMN_SCHEMA = '${escapeSqlString(schemaName)}'
                    AND COLUMN_TABLE = '${escapeSqlString(tableName)}'
                    ORDER BY COLUMN_ORDINAL_POSITION
                `;
                const result = await rawQuery(driver, query);
                return getRowsFromResult<{ COLUMN_NAME: string }>(result);
            }, connection.id);

            const columns = rows.map(row => `    "${escapeSqlIdentifier(row.COLUMN_NAME)}"`).join(',\n');

            const selectStatement = `SELECT\n${columns}\nFROM "${escapeSqlIdentifier(schemaName)}"."${escapeSqlIdentifier(tableName)}"\nLIMIT 100;`;

            // Insert into active editor or create new one
            const editor = vscode.window.activeTextEditor;
            if (editor && (editor.document.languageId === 'sql' || editor.document.languageId === 'exasol-sql')) {
                const position = editor.selection.active;
                await editor.edit(editBuilder => {
                    editBuilder.insert(position, selectStatement);
                });
            } else {
                const doc = await vscode.workspace.openTextDocument({
                    content: selectStatement,
                    language: 'exasol-sql'
                });
                await vscode.window.showTextDocument(doc);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to generate SELECT statement: ${error}`);
        }
    }

    async openScriptSource(connection: StoredConnection, schemaName: string, scriptName: string) {
        try {
            const rows = await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connection.id);
                const query = `
                    SELECT SCRIPT_TEXT
                    FROM SYS.EXA_ALL_SCRIPTS
                    WHERE SCRIPT_SCHEMA = '${escapeSqlString(schemaName)}'
                    AND SCRIPT_NAME = '${escapeSqlString(scriptName)}'
                `;
                const result = await rawQuery(driver, query);
                return getRowsFromResult<{ SCRIPT_TEXT: string }>(result);
            }, connection.id);

            if (rows.length > 0) {
                await openSqlDocument(qualifyScriptText(rows[0].SCRIPT_TEXT, schemaName, scriptName));
            } else {
                vscode.window.showWarningMessage(`Script definition not found for ${schemaName}.${scriptName}`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to get script source: ${error}`);
        }
    }

    async openFunctionSource(connection: StoredConnection, schemaName: string, functionName: string) {
        try {
            const rows = await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connection.id);
                const query = `
                    SELECT FUNCTION_TEXT
                    FROM SYS.EXA_ALL_FUNCTIONS
                    WHERE FUNCTION_SCHEMA = '${escapeSqlString(schemaName)}'
                    AND FUNCTION_NAME = '${escapeSqlString(functionName)}'
                `;
                const result = await rawQuery(driver, query);
                return getRowsFromResult<{ FUNCTION_TEXT: string }>(result);
            }, connection.id);

            if (rows.length > 0) {
                await openSqlDocument(qualifyFunctionText(rows[0].FUNCTION_TEXT, schemaName, functionName));
            } else {
                vscode.window.showWarningMessage(`Function definition not found for ${schemaName}.${functionName}`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to get function source: ${error}`);
        }
    }

    async describeTable(connection: StoredConnection, schemaName: string, tableName: string) {
        try {
            const query = `
                    SELECT
                        COLUMN_NAME,
                        COLUMN_TYPE,
                        COLUMN_IS_NULLABLE,
                        COLUMN_DEFAULT,
                        COLUMN_COMMENT
                    FROM SYS.EXA_ALL_COLUMNS
                    WHERE COLUMN_SCHEMA = '${escapeSqlString(schemaName)}'
                    AND COLUMN_TABLE = '${escapeSqlString(tableName)}'
                    ORDER BY COLUMN_ORDINAL_POSITION
                `;
            const queryResult = await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connection.id);

                const startTime = Date.now();
                const result = await rawQuery(driver, query);
                const executionTime = Date.now() - startTime;

                const columnsMeta = getColumnsFromResult(result);
                const rows = getRowsFromResult(result);
                const columns = columnsMeta.map(extractColumnName);
                const columnMetadata = extractColumnMetadata(columnsMeta);

                return {
                    columns,
                    columnMetadata,
                    rows,
                    rowCount: rows.length,
                    executionTime
                };
            }, connection.id);

            ResultsPanel.show(queryResult, query);
            vscode.window.showInformationMessage(`Table structure: ${schemaName}.${tableName}`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to describe table: ${error}`);
        }
    }

    /** Returns true when the refresh succeeded, so the caller can reload the tree node. */
    async refreshVirtualSchema(connection: StoredConnection, schemaName: string, tableName?: string): Promise<boolean> {
        const target = tableName ? `${schemaName}.${tableName}` : schemaName;
        try {
            const tablesClause = tableName ? ` TABLES "${escapeSqlIdentifier(tableName)}"` : '';
            const query = `ALTER VIRTUAL SCHEMA "${escapeSqlIdentifier(schemaName)}" REFRESH${tablesClause}`;
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Refreshing virtual schema metadata for ${target}...`,
                    cancellable: false
                },
                () => this.connectionManager.executeWithRetry(async () => {
                    const driver = await this.connectionManager.getDriver(connection.id);
                    // Raw responses carry SQL errors as status, not as a throw.
                    getRowsFromResult(await rawExecute(driver, query));
                }, connection.id)
            );
            vscode.window.setStatusBarMessage(`Exasol: Refreshed virtual schema metadata for ${target}`, 3000);
            return true;
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to refresh virtual schema: ${error}`);
            return false;
        }
    }

    async explainPushdown(connection: StoredConnection, schemaName: string, tableName: string) {
        try {
            const query = `EXPLAIN VIRTUAL SELECT * FROM "${escapeSqlIdentifier(schemaName)}"."${escapeSqlIdentifier(tableName)}" LIMIT 10`;
            const queryResult = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Explaining pushdown for ${schemaName}.${tableName}...`,
                    cancellable: false
                },
                () => this.connectionManager.executeWithRetry(async () => {
                    const driver = await this.connectionManager.getDriver(connection.id);

                    const startTime = Date.now();
                    const result = await rawQuery(driver, query);
                    const executionTime = Date.now() - startTime;

                    // PUSHDOWN_JSON contains the virtual schema properties in clear text,
                    // credentials included, so only known safe columns reach the results panel.
                    const columnsMeta = getColumnsFromResult(result).filter(col => PUSHDOWN_SAFE_COLUMNS.has(col.name));
                    const rows = getRowsFromResult(result).map(row => Object.fromEntries(
                        Object.entries(row).filter(([key]) => PUSHDOWN_SAFE_COLUMNS.has(key))
                    ));
                    const columns = columnsMeta.map(extractColumnName);
                    const columnMetadata = extractColumnMetadata(columnsMeta);

                    return {
                        columns,
                        columnMetadata,
                        rows,
                        rowCount: rows.length,
                        executionTime
                    };
                }, connection.id)
            );

            ResultsPanel.show(queryResult, query);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to explain pushdown: ${error}`);
        }
    }
}

async function openSqlDocument(content: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({ content, language: 'exasol-sql' });
    await vscode.window.showTextDocument(doc);
}

/** A quoted identifier, with "" standing for one double quote inside it. */
const QUOTED_IDENTIFIER = '"(?:[^"]|"")*"';

/**
 * Turns SCRIPT_TEXT into a statement that recreates the script in its own
 * schema. The database stores the header as `CREATE <...> SCRIPT "NAME"`,
 * without schema and without OR REPLACE, so running it unchanged would create
 * the script in the current schema. Only the header changes; the body is kept
 * byte for byte. Text with an unexpected header is returned unchanged.
 */
export function qualifyScriptText(scriptText: string, schemaName: string, scriptName: string): string {
    const header = new RegExp(`^CREATE\\s+([^"]*?\\bSCRIPT\\s+)${QUOTED_IDENTIFIER}`, 'i').exec(scriptText);
    if (!header) {
        return scriptText;
    }
    const name = `"${escapeSqlIdentifier(schemaName)}"."${escapeSqlIdentifier(scriptName)}"`;
    return `CREATE OR REPLACE ${header[1]}${name}${scriptText.slice(header[0].length)}`;
}

/**
 * Turns FUNCTION_TEXT into a statement that recreates the function in its own
 * schema. The database stores the text as written after `CREATE [OR REPLACE]`,
 * so the name may lack the schema; it is replaced by the quoted qualified name.
 */
export function qualifyFunctionText(functionText: string, schemaName: string, functionName: string): string {
    const part = `(?:${QUOTED_IDENTIFIER}|[^\\s."(]+)`;
    const header = new RegExp(`^(FUNCTION\\s+)${part}(?:\\.${part})?`, 'i').exec(functionText);
    if (!header) {
        return `CREATE OR REPLACE ${functionText}`;
    }
    const name = `"${escapeSqlIdentifier(schemaName)}"."${escapeSqlIdentifier(functionName)}"`;
    return `CREATE OR REPLACE ${header[1]}${name}${functionText.slice(header[0].length)}`;
}

/** What refreshVirtualSchemaAndReload needs from the extension's providers. */
interface VirtualSchemaRefreshTargets {
    objectActions: Pick<ObjectActions, 'refreshVirtualSchema'>;
    completionProvider: { clearCache(connectionId: string): void };
    objectTreeProvider: { refresh(): void };
}

/**
 * Runs Refresh Metadata for a virtual schema, or for one virtual table when
 * `tableName` is given. Only a successful refresh clears the connection's
 * completion cache and reloads the Objects view.
 */
export async function refreshVirtualSchemaAndReload(
    targets: VirtualSchemaRefreshTargets,
    connection: StoredConnection,
    schemaName: string,
    tableName?: string
): Promise<void> {
    if (await targets.objectActions.refreshVirtualSchema(connection, schemaName, tableName)) {
        targets.completionProvider.clearCache(connection.id);
        // Both refresh forms update the schema's LAST_REFRESH, which the
        // root-level node shows in its tooltip. Stable node ids keep the
        // expansion state, so expanded nodes reload their children.
        targets.objectTreeProvider.refresh();
    }
}
