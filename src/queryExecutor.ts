import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { getColumnsFromResult, getRowsFromResult, rawQuery, rawExecute, extractColumnMetadata, extractColumnName, ColumnMetadata, stripCommentsPreservingStrings } from './utils';

export type { ColumnMetadata };

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

    async execute(query: string, cancellationToken?: vscode.CancellationToken): Promise<QueryResult> {
        const activeConnection = this.connectionManager.getActiveConnection();
        if (!activeConnection) {
            throw new Error('No active connection. Please add a connection first.');
        }

        const config = vscode.workspace.getConfiguration('exasol');
        const maxRows = config.get<number>('maxResultRows', 10000);
        const _timeout = config.get<number>('queryTimeout', 300);

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

            // Classify the query to determine which driver method to use
            const isResultSet = this.isResultSetQuery(finalQuery);

            if (isResultSet) {
                // Result-set queries (SELECT, SHOW, DESCRIBE, etc.) - use query()
                // Use 'raw' response type to avoid a driver bug where error responses
                // (status:'error', responseData:undefined) crash on `responseData.numResults`
                // access. Our getColumnsFromResult/getRowsFromResult handle raw responses
                // correctly and surface proper SQL error messages.
                const result = await rawQuery(driver, finalQuery);

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
            } else {
                // Non-result-set commands (CREATE, ALTER, DROP, RENAME, INSERT, etc.) - use execute()
                const rawExecuteResult = await rawExecute(driver, finalQuery);

                const executionTime = Date.now() - startTime;
                const columnsMeta = getColumnsFromResult(rawExecuteResult);
                const rows = getRowsFromResult(rawExecuteResult);
                const columns = columnsMeta.map(extractColumnName);
                const columnMetadata = extractColumnMetadata(columnsMeta);
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
        }, undefined, cancellationToken ? { cancellationToken } : undefined);
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
            const result = await rawQuery(driver, query);
            const executionTime = Date.now() - startTime;

            const columnsMeta = getColumnsFromResult(result);
            const rows = getRowsFromResult(result).slice(0, maxRows);
            const columnMetadata = extractColumnMetadata(columnsMeta);

            return {
                columns: columnsMeta.map(extractColumnName),
                columnMetadata,
                rows,
                rowCount: rows.length,
                executionTime
            };
        });
    }

    private isResultSetQuery(query: string): boolean {
        const cleaned = stripCommentsPreservingStrings(query)
            .trim()
            .replace(/^;+/, '')
            .replace(/^\(+/, '');

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

        // Commands that don't return result sets (use execute method).
        // Everything else (SELECT, WITH, SHOW, DESCRIBE, DESC, EXPLAIN, FETCH, VALUES, TABLE, unknown)
        // is treated as a result-set query.
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

        // Execute commands return false; result-set commands and unknowns return true
        return !executeCommands.has(firstWord);
    }
}
