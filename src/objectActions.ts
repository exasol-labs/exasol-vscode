import * as vscode from 'vscode';
import { ConnectionManager, StoredConnection } from './connectionManager';
import { QueryExecutor } from './queryExecutor';
import { ResultsPanel } from './panels/resultsPanel';
import { QueryStatsPanel } from './panels/queryStatsPanel';
import { getColumnsFromResult, getRowsFromResult, rawQuery, extractColumnMetadata, extractColumnName, escapeSqlString, escapeSqlIdentifier } from './utils';

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

                    await ResultsPanel.show(queryResult);
                    QueryStatsPanel.updateStats(query, queryResult);
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
                    ORDER BY COLUMN_ORDINAL_POSITION
                `;
                const result = await rawQuery(driver, query);
                return getRowsFromResult(result);
            }, connection.id);

            // Build DDL
            let ddl = `CREATE TABLE "${escapeSqlIdentifier(schemaName)}"."${escapeSqlIdentifier(tableName)}" (\n`;
            const columns = rows.map((row: any) => {
                const nullable = row.COLUMN_IS_NULLABLE ? '' : ' NOT NULL';
                const defaultVal = row.COLUMN_DEFAULT ? ` DEFAULT ${row.COLUMN_DEFAULT}` : '';
                const comment = row.COLUMN_COMMENT ? ` -- ${row.COLUMN_COMMENT}` : '';
                return `    "${escapeSqlIdentifier(row.COLUMN_NAME)}" ${row.COLUMN_TYPE}${nullable}${defaultVal}${comment}`;
            });
            ddl += columns.join(',\n');
            ddl += '\n);';

            // Show in new editor
            const doc = await vscode.workspace.openTextDocument({
                content: ddl,
                language: 'exasol-sql'
            });
            await vscode.window.showTextDocument(doc);
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

                // Show in new editor
                const doc = await vscode.workspace.openTextDocument({
                    content: ddl,
                    language: 'exasol-sql'
                });
                await vscode.window.showTextDocument(doc);
            } else {
                vscode.window.showWarningMessage(`View definition not found for ${schemaName}.${viewName}`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to get view DDL: ${error}`);
        }
    }

    async generateSelectStatement(connection: StoredConnection, schemaName: string, tableName: string, _type: 'table' | 'view') {
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
                return getRowsFromResult(result);
            }, connection.id);

            const columns = rows.map((row: any) => `    "${escapeSqlIdentifier(row.COLUMN_NAME)}"`).join(',\n');

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

            ResultsPanel.show(queryResult);
            QueryStatsPanel.updateStats(query, queryResult);
            vscode.window.showInformationMessage(`Table structure: ${schemaName}.${tableName}`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to describe table: ${error}`);
        }
    }
}
