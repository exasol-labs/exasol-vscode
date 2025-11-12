import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { executeWithoutResult, getColumnsFromResult, getRowsFromResult } from './utils';

export interface ColumnMetadata {
    name: string;
    type: string;
    precision?: number;
    scale?: number;
    size?: number;
}

export interface QueryResult {
    columns: string[];
    columnMetadata: ColumnMetadata[];
    rows: any[];
    rowCount: number;
    executionTime: number;
}

export class QueryExecutor {
    private currentCancellationToken: vscode.CancellationTokenSource | undefined;

    constructor(private connectionManager: ConnectionManager) {}

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

    async execute(query: string, cancellationToken?: vscode.CancellationToken): Promise<QueryResult> {
        const activeConnection = this.connectionManager.getActiveConnection();
        if (!activeConnection) {
            throw new Error('No active connection. Please add a connection first.');
        }

        const config = vscode.workspace.getConfiguration('exasol');
        const maxRows = config.get<number>('maxResultRows', 10000);
        const timeout = config.get<number>('queryTimeout', 300);

        const startTime = Date.now();

        // Clean the query - remove trailing semicolons and trim
        let finalQuery = query.trim().replace(/;+\s*$/, '').trim();
        const isResultSet = this.isResultSetQuery(finalQuery);

        if (isResultSet && finalQuery.toUpperCase().startsWith('SELECT') && !finalQuery.toUpperCase().includes('LIMIT')) {
            finalQuery += ` LIMIT ${maxRows}`;
        }

        try {
            const driver = await this.connectionManager.getDriver();

            if (cancellationToken?.isCancellationRequested) {
                throw new Error('Query execution was cancelled');
            }

            if (isResultSet) {
                try {
                    const result = await driver.query(finalQuery);

                    if (cancellationToken?.isCancellationRequested) {
                        throw new Error('Query execution was cancelled');
                    }

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
                } catch (error) {
                    // If query() fails with "Invalid result type", the query might be a DDL/DML
                    // Try again with execute method
                    const errorMsg = error instanceof Error ? error.message : String(error);
                    if (errorMsg.includes('Invalid result type') || errorMsg.includes('E-EDJS-11')) {
                        // Fall through to execute method below
                    } else {
                        throw error;
                    }
                }
            }

            const rawExecuteResult = await executeWithoutResult(driver, finalQuery);

            if (cancellationToken?.isCancellationRequested) {
                throw new Error('Query execution was cancelled');
            }

            const executionTime = Date.now() - startTime;

            const columnsMeta = getColumnsFromResult(rawExecuteResult);
            const rows = getRowsFromResult(rawExecuteResult);
            const columns = columnsMeta.map((col: any) => col.name ?? col.COLUMN_NAME ?? col);
            const columnMetadata = this.extractColumnMetadata(columnsMeta);
            const affectedRows =
                rows.length > 0
                    ? rows.length
                    : rawExecuteResult?.responseData?.results?.[0]?.rowCount ?? 0;

            return {
                columns,
                columnMetadata,
                rows,
                rowCount: affectedRows,
                executionTime
            };
        } catch (error) {
            if (cancellationToken?.isCancellationRequested) {
                throw new Error('Query execution was cancelled by user');
            }

            // Check if it's a connection-related error that requires reconnection
            const errorMsg = error instanceof Error ? error.message : String(error);
            const isConnectionError =
                errorMsg.includes('E-EDJS-8') || // Pool exhaustion
                errorMsg.includes('pool reached its limit') ||
                errorMsg.includes('ECONNRESET') || // Connection reset
                errorMsg.includes('EPIPE') || // Broken pipe
                errorMsg.includes('ETIMEDOUT') || // Timeout
                errorMsg.includes('ENOTFOUND') || // Host not found
                errorMsg.includes('ECONNREFUSED') || // Connection refused
                errorMsg.includes('connection closed') ||
                errorMsg.includes('WebSocket') ||
                errorMsg.includes('socket hang up') ||
                errorMsg.toLowerCase().includes('timeout');

            if (isConnectionError) {
                // Reset the driver and retry once with proper method
                await this.connectionManager.resetDriver();
                try {
                    const driver = await this.connectionManager.getDriver();

                    // Use the same logic as main flow - try query first for result sets, fall back to execute
                    if (isResultSet) {
                        try {
                            const result = await driver.query(finalQuery);
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
                        } catch (queryError) {
                            // If query() fails, try execute
                            const queryErrorMsg = queryError instanceof Error ? queryError.message : String(queryError);
                            if (!queryErrorMsg.includes('Invalid result type') && !queryErrorMsg.includes('E-EDJS-11')) {
                                throw queryError;
                            }
                            // Fall through to execute
                        }
                    }

                    // Use execute for DDL/DML
                    const rawExecuteResult = await executeWithoutResult(driver, finalQuery);
                    const executionTime = Date.now() - startTime;

                    const columnsMeta = getColumnsFromResult(rawExecuteResult);
                    const rows = getRowsFromResult(rawExecuteResult);
                    const columns = columnsMeta.map((col: any) => col.name ?? col.COLUMN_NAME ?? col);
                    const columnMetadata = this.extractColumnMetadata(columnsMeta);
                    const affectedRows =
                        rows.length > 0
                            ? rows.length
                            : rawExecuteResult?.responseData?.results?.[0]?.rowCount ?? 0;

                    return {
                        columns,
                        columnMetadata,
                        rows,
                        rowCount: affectedRows,
                        executionTime
                    };
                } catch (retryError) {
                    throw new Error(`Query execution failed after retry: ${retryError}`);
                }
            }

            throw new Error(`Query execution failed: ${error}`);
        }
    }

    setCancellationToken(token: vscode.CancellationTokenSource) {
        this.currentCancellationToken = token;
    }

    cancelCurrentQuery() {
        if (this.currentCancellationToken) {
            this.currentCancellationToken.cancel();
            this.currentCancellationToken = undefined;
        }
    }

    async executeAndFetch(query: string, limit?: number): Promise<QueryResult> {
        const config = vscode.workspace.getConfiguration('exasol');
        const maxRows = limit || config.get<number>('maxResultRows', 10000);

        const startTime = Date.now();

        try {
            const driver = await this.connectionManager.getDriver();
            const result = await driver.query(query);
            const executionTime = Date.now() - startTime;

            const columnsMeta = getColumnsFromResult(result);
            const rows = getRowsFromResult(result).slice(0, maxRows);
            const columnMetadata = this.extractColumnMetadata(columnsMeta);

            return {
                columns: columnsMeta.map((col: any) => col.name ?? col.COLUMN_NAME ?? col),
                columnMetadata,
                rows,
                rowCount: rows.length,
                executionTime
            };
        } catch (error) {
            // Check if it's a connection-related error that requires reconnection
            const errorMsg = error instanceof Error ? error.message : String(error);
            const isConnectionError =
                errorMsg.includes('E-EDJS-8') || // Pool exhaustion
                errorMsg.includes('pool reached its limit') ||
                errorMsg.includes('ECONNRESET') || // Connection reset
                errorMsg.includes('EPIPE') || // Broken pipe
                errorMsg.includes('ETIMEDOUT') || // Timeout
                errorMsg.includes('ENOTFOUND') || // Host not found
                errorMsg.includes('ECONNREFUSED') || // Connection refused
                errorMsg.includes('connection closed') ||
                errorMsg.includes('WebSocket') ||
                errorMsg.includes('socket hang up') ||
                errorMsg.toLowerCase().includes('timeout');

            if (isConnectionError) {
                // Reset the driver and retry once
                await this.connectionManager.resetDriver();
                try {
                    const driver = await this.connectionManager.getDriver();
                    const result = await driver.query(query);
                    const executionTime = Date.now() - startTime;

                    const columnsMeta = getColumnsFromResult(result);
                    const rows = getRowsFromResult(result).slice(0, maxRows);
                    const columnMetadata = this.extractColumnMetadata(columnsMeta);

                    return {
                        columns: columnsMeta.map((col: any) => col.name ?? col.COLUMN_NAME ?? col),
                        columnMetadata,
                        rows,
                        rowCount: rows.length,
                        executionTime
                    };
                } catch (retryError) {
                    throw new Error(`Query execution failed after retry: ${retryError}`);
                }
            }

            throw new Error(`Query execution failed: ${error}`);
        }
    }

    private isResultSetQuery(query: string): boolean {
        const cleaned = query
            .trim()
            .replace(/^;+/, '')
            .replace(/^\(+/, '')
            .replace(/--.*$/gm, '') // Remove single-line comments
            .replace(/\/\*[\s\S]*?\*\//g, ''); // Remove multi-line comments

        const firstWordMatch = cleaned.match(/^([a-zA-Z]+)/);
        if (!firstWordMatch) {
            return true;
        }

        const firstWord = firstWordMatch[1].toUpperCase();

        // Commands that return result sets (use query method)
        const resultSetCommands = new Set([
            'SELECT',
            'WITH',
            'SHOW',
            'DESCRIBE',
            'DESC',
            'EXPLAIN',
            'FETCH',
            'VALUES',
            'TABLE'
        ]);

        // Commands that don't return result sets (use execute method)
        const executeCommands = new Set([
            'CREATE',
            'ALTER',
            'DROP',
            'INSERT',
            'UPDATE',
            'DELETE',
            'TRUNCATE',
            'MERGE',
            'IMPORT',
            'EXPORT',
            'GRANT',
            'REVOKE',
            'COMMIT',
            'ROLLBACK',
            'SET'
        ]);

        // If it's explicitly an execute command, return false
        if (executeCommands.has(firstWord)) {
            return false;
        }

        // If it's explicitly a result set command, return true
        if (resultSetCommands.has(firstWord)) {
            return true;
        }

        // Default to true for unknown commands
        return true;
    }
}
