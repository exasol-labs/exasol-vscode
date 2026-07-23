import * as vscode from 'vscode';
import type { ExasolDriver } from '@exasol/exasol-driver-ts';
import { ConnectionManager } from './connectionManager';
import { getColumnsFromResult, getRowsFromResult, rawQuery, rawExecute, extractColumnMetadata, extractColumnName, ColumnMetadata, stripCommentsPreservingStrings, safeFetch } from './utils';
import { parseLocalCsvImport, resolveImportPath } from './localCsvImport';
import { getOutputChannel } from './extension';

export type { ColumnMetadata };

export interface QueryResult {
    columns: string[];
    columnMetadata: ColumnMetadata[];
    rows: any[];
    rowCount: number;
    executionTime: number;
    /**
     * SESSION_ID for this connection, and CURRENT_STATEMENT read *before* this
     * query ran (exact digit strings — see plan/planModel.ts for why not
     * `number`). Not the query's own STMT_ID: Exasol has no "id of the
     * statement that just ran" primitive, since CURRENT_STATEMENT returns the
     * id of whatever statement asks the question. planProvider.ts searches
     * forward from this baseline for the query's real STMT_ID. Undefined if
     * capture failed — the plan feature just won't be available for this
     * result, everything else about the query is unaffected.
     */
    sessionId?: string;
    baselineStmtId?: string;
    /**
     * Id of the connection this query actually ran on, captured at execution
     * time. The plan lookup must run against *this* connection/session, not
     * whichever connection happens to be active when the user later opens the
     * Plan tab (a profile is only visible from the session that produced it —
     * or, cross-session, only after propagation/flush). Undefined only for
     * code paths that never populate session/statement ids anyway.
     */
    connectionId?: string;
}

/**
 * Best-effort capture of the identifiers needed to look up this statement's
 * profile data later (see src/plan/planProvider.ts). Runs as a round-trip on
 * the same driver/session *before* the query, so planProvider can search
 * forward from a known point rather than guess how many implicit
 * COMMIT/ROLLBACK statements land between this query and the identity
 * capture. Never throws — a failure here should never fail the query itself.
 */
async function captureBaselineStatementIdentity(driver: ExasolDriver): Promise<{ sessionId?: string; baselineStmtId?: string }> {
    return safeFetch('Failed to capture baseline session/statement id for plan lookup', async () => {
        const result = await rawQuery(driver, 'SELECT CURRENT_SESSION AS SID, CURRENT_STATEMENT AS STID');
        const rows = getRowsFromResult(result);
        if (rows.length === 0) {
            return {};
        }
        return { sessionId: String(rows[0].SID), baselineStmtId: String(rows[0].STID) };
    }, {}, getOutputChannel());
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
        const queryTimeoutMs = config.get<number>('queryTimeout', 300) * 1000;

        // Clean the query - remove trailing semicolons and trim
        let finalQuery = query.trim().replace(/;+\s*$/, '').trim();

        // Intercept local CSV imports: raw SQL cannot stream a local file over the
        // WebSocket protocol, so route them through the driver's programmatic import.
        //
        // Cancelling the wrapper here only abandons this promise: it does NOT stop
        // the in-flight server-side load nor tear down the driver's import tunnel.
        // Stopping a streaming import cleanly needs a driver-side AbortSignal,
        // tracked in exasol/exasol-driver-ts#68.
        const localImport = parseLocalCsvImport(finalQuery);
        if (localImport) {
            // Unlike the SELECT/DDL branches, the import branch passes a timeout:
            // the cluster connects back to the driver's import tunnel, and an
            // asymmetric NAT/firewall can stall that handshake with no automatic
            // recovery, leaving the import hung indefinitely. The timeout rejects
            // a stalled import instead of hanging forever.
            return await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver();

                // Same identity capture as every other execution path below
                // (see captureBaselineStatementIdentity). A local CSV import
                // is still a real IMPORT statement from Exasol's own
                // perspective and still gets profiled — this branch just
                // predates the Plan feature and was never wired up to record
                // where to look the profile up afterward, unlike every other
                // statement type.
                const identity = await captureBaselineStatementIdentity(driver);
                const importStartTime = Date.now();

                const absPath = resolveImportPath(localImport.filePath);
                const rowCount = await driver.importFromCsvFile(localImport.table, absPath, localImport.options);

                const executionTime = Date.now() - importStartTime;

                return {
                    columns: [],
                    columnMetadata: [],
                    rows: [],
                    rowCount,
                    executionTime,
                    connectionId: activeConnection.id,
                    ...identity
                };
            }, undefined, { timeoutMs: queryTimeoutMs, ...(cancellationToken ? { cancellationToken } : {}) });
        }

        // Auto-add LIMIT to SELECT queries without explicit LIMIT
        if (finalQuery.toUpperCase().startsWith('SELECT') && !finalQuery.toUpperCase().includes('LIMIT')) {
            finalQuery += ` LIMIT ${maxRows}`;
        }

        // Use centralized retry logic from ConnectionManager
        return await this.connectionManager.executeWithRetry(async () => {
            const driver = await this.connectionManager.getDriver();

            // Captured before the query runs (see captureBaselineStatementIdentity
            // for why), on a fresh timer so this round-trip never inflates the
            // executionTime shown to the user.
            const identity = await captureBaselineStatementIdentity(driver);
            const queryStartTime = Date.now();

            // Classify the query to determine which driver method to use
            const isResultSet = this.isResultSetQuery(finalQuery);

            if (isResultSet) {
                // Result-set queries (SELECT, SHOW, DESCRIBE, etc.) - use query()
                // Use 'raw' response type to avoid a driver bug where error responses
                // (status:'error', responseData:undefined) crash on `responseData.numResults`
                // access. Our getColumnsFromResult/getRowsFromResult handle raw responses
                // correctly and surface proper SQL error messages.
                const result = await rawQuery(driver, finalQuery);

                const executionTime = Date.now() - queryStartTime;
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
                    connectionId: activeConnection.id,
                    ...identity
                };
            } else {
                // Non-result-set commands (CREATE, ALTER, DROP, RENAME, INSERT, etc.) - use execute()
                const rawExecuteResult = await rawExecute(driver, finalQuery);

                const executionTime = Date.now() - queryStartTime;
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
                    executionTime,
                    connectionId: activeConnection.id,
                    ...identity
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
