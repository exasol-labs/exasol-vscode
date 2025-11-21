import * as vscode from 'vscode';
import { ConnectionManager, StoredConnection } from './connectionManager';
import { QueryExecutor, QueryResult, ColumnMetadata } from './queryExecutor';
import { ResultsPanel } from './panels/resultsPanel';
import { getColumnsFromResult, getRowsFromResult } from './utils';

export class ObjectActions {
    constructor(
        private connectionManager: ConnectionManager,
        private queryExecutor: QueryExecutor,
        private extensionUri: vscode.Uri
    ) {}

    private async executeWithRetry<T>(fn: () => Promise<T>, connectionId: string): Promise<T> {
        try {
            return await fn();
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            if (errorMsg.includes('E-EDJS-8') || errorMsg.includes('pool reached its limit')) {
                // Reset driver and retry once
                await this.connectionManager.resetDriver(connectionId);
                // Wait a bit for the pool to stabilize
                await new Promise(resolve => setTimeout(resolve, 100));
                return await fn();
            }
            throw error;
        }
    }

    private extractColumnMetadata(columnsMeta: any[]): ColumnMetadata[] {
        return columnsMeta.map((col: any) => {
            const name = col.name ?? col.COLUMN_NAME ?? col;
            const dataType = col.dataType;

            if (dataType && typeof dataType === 'object') {
                return {
                    name,
                    type: dataType.type || 'VARCHAR',
                    precision: dataType.precision,
                    scale: dataType.scale,
                    size: dataType.size
                };
            }

            // Fallback for columns without dataType info
            return {
                name,
                type: 'VARCHAR'
            };
        });
    }

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
                    const queryResult = await this.executeWithRetry(async () => {
                        const query = `SELECT * FROM "${schemaName}"."${tableName}" LIMIT ${limit}`;
                        const driver = await this.connectionManager.getDriver(connection.id);

                        const startTime = Date.now();
                        const result = await driver.query(query);
                        const executionTime = Date.now() - startTime;

                        const columnsMeta = getColumnsFromResult(result);
                        const rows = getRowsFromResult(result);
                        const columns = columnsMeta.map((col: any) => col.name ?? col.COLUMN_NAME ?? col);
                        const columnMetadata = this.extractColumnMetadata(columnsMeta);

                        return {
                            columns,
                            columnMetadata,
                            rows,
                            rowCount: rows.length,
                            executionTime
                        };
                    }, connection.id);

                    await ResultsPanel.show(queryResult);
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
            const driver = await this.connectionManager.getDriver(connection.id);

            // Get table DDL using Exasol system tables
            const query = `
                SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT, COLUMN_IS_NULLABLE, COLUMN_COMMENT
                FROM SYS.EXA_ALL_COLUMNS
                WHERE COLUMN_SCHEMA = '${schemaName}'
                AND COLUMN_TABLE = '${tableName}'
                ORDER BY COLUMN_ORDINAL_POSITION
            `;

            const result = await driver.query(query);
            const rows = getRowsFromResult(result);

            // Build DDL
            let ddl = `CREATE TABLE "${schemaName}"."${tableName}" (\n`;
            const columns = rows.map((row: any, idx: number) => {
                const nullable = row.COLUMN_IS_NULLABLE ? '' : ' NOT NULL';
                const defaultVal = row.COLUMN_DEFAULT ? ` DEFAULT ${row.COLUMN_DEFAULT}` : '';
                const comment = row.COLUMN_COMMENT ? ` -- ${row.COLUMN_COMMENT}` : '';
                return `    "${row.COLUMN_NAME}" ${row.COLUMN_TYPE}${nullable}${defaultVal}${comment}`;
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
            const driver = await this.connectionManager.getDriver(connection.id);

            // Get view definition
            const query = `
                SELECT VIEW_TEXT
                FROM SYS.EXA_ALL_VIEWS
                WHERE VIEW_SCHEMA = '${schemaName}'
                AND VIEW_NAME = '${viewName}'
            `;

            const result = await driver.query(query);

            const rows = getRowsFromResult(result);

            if (rows.length > 0) {
                const viewText = rows[0].VIEW_TEXT;
                const ddl = `CREATE VIEW "${schemaName}"."${viewName}" AS\n${viewText}`;

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

    async generateSelectStatement(connection: StoredConnection, schemaName: string, tableName: string, type: 'table' | 'view') {
        try {
            const driver = await this.connectionManager.getDriver(connection.id);

            // Get columns
            const query = `
                SELECT COLUMN_NAME
                FROM SYS.EXA_ALL_COLUMNS
                WHERE COLUMN_SCHEMA = '${schemaName}'
                AND COLUMN_TABLE = '${tableName}'
                ORDER BY COLUMN_ORDINAL_POSITION
            `;

            const result = await driver.query(query);
            const rows = getRowsFromResult(result);
            const columnNames = Array.from(new Set(rows.map((row: any) => row.COLUMN_NAME)));
            const columns = columnNames.map((name: string) => `    "${name}"`).join(',\n');

            const selectStatement = `SELECT\n${columns}\nFROM "${schemaName}"."${tableName}"\nLIMIT 100;`;

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
            const queryResult = await this.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connection.id);

                const query = `
                    SELECT
                        COLUMN_NAME,
                        COLUMN_TYPE,
                        COLUMN_IS_NULLABLE,
                        COLUMN_DEFAULT,
                        COLUMN_COMMENT
                    FROM SYS.EXA_ALL_COLUMNS
                    WHERE COLUMN_SCHEMA = '${schemaName}'
                    AND COLUMN_TABLE = '${tableName}'
                    ORDER BY COLUMN_ORDINAL_POSITION
                `;

                const startTime = Date.now();
                const result = await driver.query(query);
                const executionTime = Date.now() - startTime;

                const columnsMeta = getColumnsFromResult(result);
                const rows = getRowsFromResult(result);
                const columns = columnsMeta.map((col: any) => col.name ?? col.COLUMN_NAME ?? col);
                const columnMetadata = this.extractColumnMetadata(columnsMeta);

                return {
                    columns,
                    columnMetadata,
                    rows,
                    rowCount: rows.length,
                    executionTime
                };
            }, connection.id);

            ResultsPanel.show(queryResult);
            vscode.window.showInformationMessage(`Table structure: ${schemaName}.${tableName}`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to describe table: ${error}`);
        }
    }
}
