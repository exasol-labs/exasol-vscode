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

        // Auto-add LIMIT to SELECT queries without explicit LIMIT
        if (finalQuery.toUpperCase().startsWith('SELECT') && !finalQuery.toUpperCase().includes('LIMIT')) {
            finalQuery += ` LIMIT ${maxRows}`;
        }

        // Use centralized retry logic from ConnectionManager
        return await this.connectionManager.executeWithRetry(async () => {
            const driver = await this.connectionManager.getDriver();

            if (cancellationToken?.isCancellationRequested) {
                throw new Error('Query execution was cancelled');
            }

            // Classify the query to determine which driver method to use
            const isResultSet = this.isResultSetQuery(finalQuery);

            if (isResultSet) {
                // Result-set queries (SELECT, SHOW, DESCRIBE, etc.) - use query()
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
            } else {
                // Non-result-set commands (CREATE, ALTER, DROP, RENAME, INSERT, etc.) - use execute()
                const rawExecuteResult = await driver.execute(finalQuery, undefined, undefined, 'raw');

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
            }
        });
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

        // Use centralized retry logic from ConnectionManager
        return await this.connectionManager.executeWithRetry(async () => {
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
        });
    }

    private isResultSetQuery(query: string): boolean {
        const cleaned = query
            .trim()
            .replace(/^;+/, '')
            .replace(/^\(+/, '')
            .replace(/--.*$/gm, '') // Remove single-line comments
            .replace(/\/\*[\s\S]*?\*\//g, ''); // Remove multi-line comments

        // Special case: SELECT INTO creates a table (DDL with side effects)
        // Match pattern: SELECT ... INTO table_name ...
        if (/^SELECT\s+.*\s+INTO\s+/i.test(cleaned)) {
            return false; // Use execute() method
        }

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
            // DDL
            'CREATE',
            'ALTER',
            'DROP',
            'RENAME',
            'COMMENT',
            // DML
            'INSERT',
            'UPDATE',
            'DELETE',
            'TRUNCATE',
            'MERGE',
            'IMPORT',
            'EXPORT',
            // DCL
            'GRANT',
            'REVOKE',
            // Transaction Control
            'COMMIT',
            'ROLLBACK',
            // Session & System Management
            'SET',
            'EXECUTE',      // EXECUTE SCRIPT
            'KILL',         // KILL session/query
            'OPEN',         // OPEN SCHEMA
            'CLOSE',        // CLOSE SCHEMA
            'CONSUMER',     // CONSUMER GROUP
            'IMPERSONATE',  // IMPERSONATE user
            // Maintenance & Performance
            'RECOMPRESS',
            'REORGANIZE',
            'FLUSH',        // FLUSH STATISTICS
            'PRELOAD'
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
