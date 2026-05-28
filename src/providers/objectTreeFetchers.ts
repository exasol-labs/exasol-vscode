import { ConnectionManager, StoredConnection, BACKGROUND_QUERY_TIMEOUT_MS } from '../connectionManager';
import { getOutputChannel } from '../extension';
import { getRowsFromResult, escapeSqlString, escapeSqlIdentifier, rawQuery, safeFetch } from '../utils';

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

export function parseRowCount(rowCount: unknown): number | undefined {
    if (rowCount === null || rowCount === undefined) {
        return undefined;
    }

    if (typeof rowCount === 'number') {
        return Number.isFinite(rowCount) ? rowCount : undefined;
    }

    const parsed = Number(rowCount);
    return Number.isFinite(parsed) ? parsed : undefined;
}

export function isColumnMissingError(error: unknown, columnOrTableName: string): boolean {
    const message = (error instanceof Error ? error.message : String(error ?? '')).toUpperCase();
    const searchTerm = columnOrTableName.toUpperCase();
    return message.includes(searchTerm) &&
        (message.includes('NOT FOUND') || message.includes('INVALID') || message.includes('OBJECT'));
}

export function isRawDataError(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error ?? '')).toUpperCase();
    return message.includes('NUMRESULTS') || error instanceof TypeError;
}

export function getRawResultOrThrow(result: any): any {
    if (!result) {
        throw new Error('Empty result set');
    }

    if (typeof result.status === 'string' && result.status !== 'ok') {
        const message = result.exception?.text || 'Unknown error';
        throw new Error(message);
    }

    if (!result.responseData || typeof result.responseData.numResults !== 'number') {
        throw new Error('Unexpected result format: missing numResults');
    }

    return result;
}

// ---------------------------------------------------------------------------
// Fetcher functions
// ---------------------------------------------------------------------------

export async function fetchSchemas(
    connectionManager: ConnectionManager,
    connection: StoredConnection
): Promise<Array<{ name: string; tableCount?: number; viewCount?: number }>> {
    const outputChannel = getOutputChannel();
    try {
        return await connectionManager.executeWithRetry(async () => {
            outputChannel?.appendLine(`   Getting driver for connection ID: ${connection.id}`);
            const driver = await connectionManager.getDriver(connection.id, 'background');
            outputChannel?.appendLine(`   Driver obtained, running schema query with object counts...`);

            // Try to get schema counts in a single query
            try {
                const result = await rawQuery(driver, `
                    SELECT
                        s.SCHEMA_NAME,
                        COALESCE(t.TABLE_COUNT, 0) AS TABLE_COUNT,
                        COALESCE(v.VIEW_COUNT, 0) AS VIEW_COUNT
                    FROM SYS.EXA_SCHEMAS s
                    LEFT JOIN (
                        SELECT TABLE_SCHEMA, COUNT(*) AS TABLE_COUNT
                        FROM SYS.EXA_ALL_TABLES
                        GROUP BY TABLE_SCHEMA
                    ) t ON s.SCHEMA_NAME = t.TABLE_SCHEMA
                    LEFT JOIN (
                        SELECT VIEW_SCHEMA, COUNT(*) AS VIEW_COUNT
                        FROM SYS.EXA_ALL_VIEWS
                        GROUP BY VIEW_SCHEMA
                    ) v ON s.SCHEMA_NAME = v.VIEW_SCHEMA
                    WHERE s.SCHEMA_NAME NOT IN ('SYS', 'EXA_STATISTICS')
                    ORDER BY s.SCHEMA_NAME
                `);
                const rows = getRowsFromResult(result);
                outputChannel?.appendLine(`   Schema query with counts returned ${rows.length} rows`);
                return rows.map((row: any) => ({
                    name: row.SCHEMA_NAME,
                    tableCount: parseRowCount(row.TABLE_COUNT),
                    viewCount: parseRowCount(row.VIEW_COUNT)
                }));
            } catch (error) {
                outputChannel?.appendLine(`   Failed to fetch counts with optimized query: ${error}`);
                outputChannel?.appendLine(`   Falling back to simple schema query without counts...`);

                // Fallback to simple query without counts
                const result = await rawQuery(driver, `
                    SELECT SCHEMA_NAME
                    FROM SYS.EXA_SCHEMAS
                    WHERE SCHEMA_NAME NOT IN ('SYS', 'EXA_STATISTICS')
                    ORDER BY SCHEMA_NAME
                `);
                const rows = getRowsFromResult(result);
                outputChannel?.appendLine(`   Schema query returned ${rows.length} rows`);
                return rows.map((row: any) => ({ name: row.SCHEMA_NAME }));
            }
        }, connection.id, { timeoutMs: BACKGROUND_QUERY_TIMEOUT_MS, role: 'background' });
    } catch (error) {
        outputChannel?.appendLine(`   Error fetching schemas: ${error}`);
        throw new Error(`Failed to fetch schemas: ${error}`);
    }
}

export async function fetchTables(
    connectionManager: ConnectionManager,
    connection: StoredConnection,
    schemaName: string
): Promise<Array<{ name: string; rowCount?: number }>> {
    const outputChannel = getOutputChannel();
    try {
        return await connectionManager.executeWithRetry(async () => {
            const driver = await connectionManager.getDriver(connection.id, 'background');
            const attempts: Array<{
                description: string;
                sql: string;
                map: (rows: any[]) => Array<{ name: string; rowCount?: number }>;
                isRecoverable: (error: unknown) => boolean;
            }> = [
                {
                    description: 'tables with row counts from EXA_ALL_TABLES',
                    sql: `
                        SELECT
                            TABLE_NAME,
                            TABLE_ROW_COUNT
                        FROM SYS.EXA_ALL_TABLES
                        WHERE TABLE_SCHEMA = '${escapeSqlString(schemaName)}'
                        ORDER BY TABLE_NAME
                    `,
                    map: rows => rows.map((row: any) => ({
                        name: row.TABLE_NAME,
                        rowCount: parseRowCount(row.TABLE_ROW_COUNT)
                    })),
                    isRecoverable: error =>
                        isColumnMissingError(error, 'TABLE_ROW_COUNT') ||
                        isColumnMissingError(error, 'EXA_ALL_TABLES')
                },
                {
                    description: 'tables without row counts from EXA_ALL_TABLES',
                    sql: `
                        SELECT TABLE_NAME
                        FROM SYS.EXA_ALL_TABLES
                        WHERE TABLE_SCHEMA = '${escapeSqlString(schemaName)}'
                        ORDER BY TABLE_NAME
                    `,
                    map: rows => rows.map((row: any) => ({
                        name: row.TABLE_NAME
                    })),
                    isRecoverable: error =>
                        isColumnMissingError(error, 'EXA_ALL_TABLES') ||
                        isColumnMissingError(error, 'TABLE_NAME')
                },
                {
                    description: 'tables from EXA_ALL_OBJECTS',
                    sql: `
                        SELECT OBJECT_NAME AS TABLE_NAME
                        FROM SYS.EXA_ALL_OBJECTS
                        WHERE OBJECT_SCHEMA = '${escapeSqlString(schemaName)}'
                        AND OBJECT_TYPE = 'TABLE'
                        ORDER BY OBJECT_NAME
                    `,
                    map: rows => rows.map((row: any) => ({
                        name: row.TABLE_NAME ?? row.OBJECT_NAME
                    })),
                    isRecoverable: error =>
                        isColumnMissingError(error, 'EXA_ALL_OBJECTS') ||
                        isColumnMissingError(error, 'OBJECT_TYPE')
                },
                {
                    description: 'tables from EXA_ALL_COLUMNS fallback',
                    sql: `
                        SELECT DISTINCT COLUMN_TABLE AS TABLE_NAME
                        FROM SYS.EXA_ALL_COLUMNS
                        WHERE COLUMN_SCHEMA = '${escapeSqlString(schemaName)}'
                        AND (COLUMN_OBJECT_TYPE = 'TABLE' OR COLUMN_OBJECT_TYPE IS NULL)
                        ORDER BY COLUMN_TABLE
                    `,
                    map: rows => rows.map((row: any) => ({
                        name: row.TABLE_NAME ?? row.COLUMN_TABLE
                    })),
                    isRecoverable: () => false
                }
            ];

            let lastError: unknown = undefined;

            for (const attempt of attempts) {
                outputChannel?.appendLine(`   Running tables query (${attempt.description}) for '${schemaName}'`);
                try {
                    const result = await rawQuery(driver, attempt.sql);
                    const rows = getRowsFromResult(result);
                    outputChannel?.appendLine(`   ${attempt.description} returned ${rows.length} rows`);
                    return attempt.map(rows);
                } catch (error) {
                    lastError = error;
                    if (attempt.isRecoverable(error)) {
                        outputChannel?.appendLine(
                            `   Tables query failed due to missing metadata (${error}). Trying fallback...`
                        );
                        continue;
                    }

                    throw error;
                }
            }

            throw lastError ?? new Error('Unknown error fetching tables');
        }, connection.id, { timeoutMs: BACKGROUND_QUERY_TIMEOUT_MS, role: 'background' });
    } catch (error) {
        outputChannel?.appendLine(`   Error in fetchTables: ${error}`);
        throw new Error(`Failed to fetch tables: ${error}`);
    }
}

export async function fetchViews(
    connectionManager: ConnectionManager,
    connection: StoredConnection,
    schemaName: string
): Promise<Array<{ name: string }>> {
    const outputChannel = getOutputChannel();
    try {
        return await connectionManager.executeWithRetry(async () => {
            outputChannel?.appendLine(`   Running views query for schema '${schemaName}'`);
            const driver = await connectionManager.getDriver(connection.id, 'background');

            const attempts: Array<{
                description: string;
                sql: string;
                map: (rows: any[]) => Array<{ name: string }>;
                recoverable: (error: unknown) => boolean;
            }> = [
                {
                    description: 'views from EXA_ALL_VIEWS',
                    sql: `
                        SELECT TABLE_NAME AS VIEW_NAME
                        FROM SYS.EXA_ALL_VIEWS
                        WHERE VIEW_SCHEMA = '${escapeSqlString(schemaName)}'
                        ORDER BY TABLE_NAME
                    `,
                    map: rows => rows.map((row: any) => ({ name: row.VIEW_NAME ?? row.TABLE_NAME })),
                    recoverable: error =>
                        isColumnMissingError(error, 'TABLE_NAME') ||
                        isColumnMissingError(error, 'VIEW_SCHEMA') ||
                        isRawDataError(error)
                },
                {
                    description: 'views from EXA_ALL_OBJECTS',
                    sql: `
                        SELECT
                            OBJECT_NAME AS VIEW_NAME
                        FROM SYS.EXA_ALL_OBJECTS
                        WHERE OBJECT_SCHEMA = '${escapeSqlString(schemaName)}'
                        AND OBJECT_TYPE = 'VIEW'
                        ORDER BY OBJECT_NAME
                    `,
                    map: rows => rows.map((row: any) => ({ name: row.VIEW_NAME ?? row.OBJECT_NAME })),
                    recoverable: error =>
                        isColumnMissingError(error, 'OBJECT_NAME') ||
                        isColumnMissingError(error, 'OBJECT_SCHEMA') ||
                        isColumnMissingError(error, 'OBJECT_TYPE') ||
                        isRawDataError(error)
                },
                {
                    description: 'views from EXA_ALL_COLUMNS',
                    sql: `
                        SELECT DISTINCT
                            COLUMN_TABLE AS VIEW_NAME
                        FROM SYS.EXA_ALL_COLUMNS
                        WHERE COLUMN_SCHEMA = '${escapeSqlString(schemaName)}'
                        AND (
                            COLUMN_OBJECT_TYPE IS NULL OR
                            COLUMN_OBJECT_TYPE = 'VIEW' OR
                            COLUMN_OBJECT_TYPE = 'VIRTUAL TABLE'
                        )
                        ORDER BY COLUMN_TABLE
                    `,
                    map: rows => rows.map((row: any) => ({ name: row.VIEW_NAME ?? row.COLUMN_TABLE })),
                    recoverable: () => false
                }
            ];

            let lastError: unknown = undefined;

            for (const attempt of attempts) {
                outputChannel?.appendLine(`   Running views query (${attempt.description}) for schema '${schemaName}'`);
                try {
                    const rawResult = await rawQuery(driver, attempt.sql);
                    const validated = getRawResultOrThrow(rawResult);
                    const rows = getRowsFromResult(validated);
                    outputChannel?.appendLine(`   ${attempt.description} returned ${rows.length} rows`);
                    return attempt.map(rows);
                } catch (error) {
                    lastError = error;
                    if (attempt.recoverable(error)) {
                        outputChannel?.appendLine(
                            `   Views query failed (${error}). Trying next fallback...`
                        );
                        continue;
                    }

                    throw error;
                }
            }

            throw lastError ?? new Error('Unknown error fetching views');
        }, connection.id, { timeoutMs: BACKGROUND_QUERY_TIMEOUT_MS, role: 'background' });
    } catch (error) {
        outputChannel?.appendLine(`   Error in fetchViews: ${error}`);
        outputChannel?.appendLine(`   Error stack: ${(error as Error).stack}`);
        throw new Error(`Failed to fetch views: ${error}`);
    }
}

export async function fetchColumns(
    connectionManager: ConnectionManager,
    connection: StoredConnection,
    schemaName: string,
    tableName: string
): Promise<Array<{ name: string; type: string; nullable: boolean }>> {
    try {
        return await connectionManager.executeWithRetry(async () => {
            const driver = await connectionManager.getDriver(connection.id, 'background');
            const result = await rawQuery(driver, `
                SELECT
                    COLUMN_NAME,
                    COLUMN_TYPE,
                    COLUMN_IS_NULLABLE
                FROM SYS.EXA_ALL_COLUMNS
                WHERE COLUMN_SCHEMA = '${escapeSqlString(schemaName)}'
                AND COLUMN_TABLE = '${escapeSqlString(tableName)}'
                ORDER BY COLUMN_ORDINAL_POSITION
            `);
            const rows = getRowsFromResult(result);
            return rows.map((row: any) => ({
                name: row.COLUMN_NAME,
                type: row.COLUMN_TYPE,
                nullable: row.COLUMN_IS_NULLABLE
            }));
        }, connection.id, { timeoutMs: BACKGROUND_QUERY_TIMEOUT_MS, role: 'background' });
    } catch (error) {
        throw new Error(`Failed to fetch columns: ${error}`);
    }
}

export async function fetchScriptCounts(
    connectionManager: ConnectionManager,
    connection: StoredConnection,
    schemaName: string
): Promise<Map<string, number>> {
    const outputChannel = getOutputChannel();
    try {
        return await connectionManager.executeWithRetry(async () => {
            const driver = await connectionManager.getDriver(connection.id, 'background');
            const result = await rawQuery(driver, `
                SELECT SCRIPT_TYPE, COUNT(*) AS SCRIPT_COUNT
                FROM SYS.EXA_ALL_SCRIPTS
                WHERE SCRIPT_SCHEMA = '${escapeSqlString(schemaName)}'
                GROUP BY SCRIPT_TYPE
            `);
            const rows = getRowsFromResult(result);
            const counts = new Map<string, number>();
            for (const row of rows) {
                const scriptType = row.SCRIPT_TYPE as string;
                const count = parseRowCount(row.SCRIPT_COUNT) ?? 0;
                if (scriptType && count > 0) {
                    counts.set(scriptType, count);
                }
            }
            return counts;
        }, connection.id, { role: 'background' });
    } catch (error) {
        outputChannel?.appendLine(`Failed to fetch script counts for '${schemaName}': ${error}`);
        return new Map();
    }
}

export async function fetchFunctionCount(
    connectionManager: ConnectionManager,
    connection: StoredConnection,
    schemaName: string
): Promise<number> {
    const outputChannel = getOutputChannel();
    try {
        return await connectionManager.executeWithRetry(async () => {
            const driver = await connectionManager.getDriver(connection.id, 'background');
            const result = await rawQuery(driver, `
                SELECT COUNT(*) AS FUNCTION_COUNT
                FROM SYS.EXA_ALL_FUNCTIONS
                WHERE FUNCTION_SCHEMA = '${escapeSqlString(schemaName)}'
            `);
            const rows = getRowsFromResult(result);
            return parseRowCount(rows[0]?.FUNCTION_COUNT) ?? 0;
        }, connection.id, { role: 'background' });
    } catch (error) {
        outputChannel?.appendLine(`Failed to fetch function count for '${schemaName}': ${error}`);
        return 0;
    }
}

export async function fetchScripts(
    connectionManager: ConnectionManager,
    connection: StoredConnection,
    schemaName: string,
    scriptType: string
): Promise<Array<{ name: string; language: string; inputType: string | null; scriptType: string }>> {
    return safeFetch(`Failed to fetch scripts (${scriptType}) for '${schemaName}'`, () =>
        connectionManager.executeWithRetry(async () => {
            const driver = await connectionManager.getDriver(connection.id, 'background');
            const result = await rawQuery(driver, `
                SELECT
                    SCRIPT_NAME,
                    SCRIPT_LANGUAGE,
                    SCRIPT_INPUT_TYPE,
                    SCRIPT_TYPE
                FROM SYS.EXA_ALL_SCRIPTS
                WHERE SCRIPT_SCHEMA = '${escapeSqlString(schemaName)}'
                AND SCRIPT_TYPE = '${escapeSqlString(scriptType)}'
                ORDER BY SCRIPT_NAME
            `);
            const rows = getRowsFromResult(result);
            return rows.map((row: any) => ({
                name: row.SCRIPT_NAME,
                language: row.SCRIPT_LANGUAGE,
                inputType: row.SCRIPT_INPUT_TYPE ?? null,
                scriptType: row.SCRIPT_TYPE
            }));
        }, connection.id, { role: 'background' }),
    [], getOutputChannel());
}

export async function fetchFunctions(
    connectionManager: ConnectionManager,
    connection: StoredConnection,
    schemaName: string
): Promise<Array<{ name: string }>> {
    return safeFetch(`Failed to fetch functions for '${schemaName}'`, () =>
        connectionManager.executeWithRetry(async () => {
            const driver = await connectionManager.getDriver(connection.id, 'background');
            const result = await rawQuery(driver, `
                SELECT FUNCTION_NAME
                FROM SYS.EXA_ALL_FUNCTIONS
                WHERE FUNCTION_SCHEMA = '${escapeSqlString(schemaName)}'
                ORDER BY FUNCTION_NAME
            `);
            const rows = getRowsFromResult(result);
            return rows.map((row: any) => ({
                name: row.FUNCTION_NAME
            }));
        }, connection.id, { role: 'background' }),
    [], getOutputChannel());
}

export async function fetchConstraintCount(
    connectionManager: ConnectionManager,
    connection: StoredConnection,
    schemaName: string,
    tableName: string
): Promise<number> {
    const outputChannel = getOutputChannel();
    try {
        return await connectionManager.executeWithRetry(async () => {
            const driver = await connectionManager.getDriver(connection.id, 'background');
            const result = await rawQuery(driver, `
                SELECT COUNT(*) AS CONSTRAINT_COUNT
                FROM SYS.EXA_ALL_CONSTRAINTS
                WHERE CONSTRAINT_SCHEMA = '${escapeSqlString(schemaName)}'
                AND CONSTRAINT_TABLE = '${escapeSqlString(tableName)}'
            `);
            const rows = getRowsFromResult(result);
            return parseRowCount(rows[0]?.CONSTRAINT_COUNT) ?? 0;
        }, connection.id, { role: 'background' });
    } catch (error) {
        outputChannel?.appendLine(`Failed to fetch constraint count for '${schemaName}'.'${tableName}': ${error}`);
        return 0;
    }
}

export async function fetchIndexCount(
    connectionManager: ConnectionManager,
    connection: StoredConnection,
    schemaName: string,
    tableName: string
): Promise<number> {
    const outputChannel = getOutputChannel();
    try {
        return await connectionManager.executeWithRetry(async () => {
            const driver = await connectionManager.getDriver(connection.id, 'background');
            const result = await rawQuery(driver, `
                SELECT COUNT(*) AS INDEX_COUNT
                FROM SYS.EXA_ALL_INDICES
                WHERE INDEX_SCHEMA = '${escapeSqlString(schemaName)}'
                AND INDEX_TABLE = '${escapeSqlString(tableName)}'
            `);
            const rows = getRowsFromResult(result);
            return parseRowCount(rows[0]?.INDEX_COUNT) ?? 0;
        }, connection.id, { role: 'background' });
    } catch (error) {
        outputChannel?.appendLine(`Failed to fetch index count for '${schemaName}'.'${tableName}': ${error}`);
        return 0;
    }
}

export async function fetchConstraints(
    connectionManager: ConnectionManager,
    connection: StoredConnection,
    schemaName: string,
    tableName: string
): Promise<Array<{ name: string; type: string }>> {
    return safeFetch(`Failed to fetch constraints for '${schemaName}'.'${tableName}'`, () =>
        connectionManager.executeWithRetry(async () => {
            const driver = await connectionManager.getDriver(connection.id, 'background');
            const result = await rawQuery(driver, `
                SELECT CONSTRAINT_NAME, CONSTRAINT_TYPE
                FROM SYS.EXA_ALL_CONSTRAINTS
                WHERE CONSTRAINT_SCHEMA = '${escapeSqlString(schemaName)}'
                AND CONSTRAINT_TABLE = '${escapeSqlString(tableName)}'
                ORDER BY CONSTRAINT_NAME
            `);
            const rows = getRowsFromResult(result);
            return rows.map((row: any) => ({
                name: row.CONSTRAINT_NAME,
                type: row.CONSTRAINT_TYPE
            }));
        }, connection.id, { role: 'background' }),
    [], getOutputChannel());
}

export async function fetchConstraintColumns(
    connectionManager: ConnectionManager,
    connection: StoredConnection,
    schemaName: string,
    tableName: string,
    constraintName: string
): Promise<Array<{ name: string }>> {
    return safeFetch(`Failed to fetch constraint columns for '${constraintName}'`, () =>
        connectionManager.executeWithRetry(async () => {
            const driver = await connectionManager.getDriver(connection.id, 'background');
            const result = await rawQuery(driver, `
                SELECT COLUMN_NAME, ORDINAL_POSITION
                FROM SYS.EXA_ALL_CONSTRAINT_COLUMNS
                WHERE CONSTRAINT_SCHEMA = '${escapeSqlString(schemaName)}'
                AND CONSTRAINT_TABLE = '${escapeSqlString(tableName)}'
                AND CONSTRAINT_NAME = '${escapeSqlString(constraintName)}'
                ORDER BY ORDINAL_POSITION
            `);
            const rows = getRowsFromResult(result);
            return rows.map((row: any) => ({
                name: row.COLUMN_NAME
            }));
        }, connection.id, { role: 'background' }),
    [], getOutputChannel());
}

export async function fetchIndices(
    connectionManager: ConnectionManager,
    connection: StoredConnection,
    schemaName: string,
    tableName: string
): Promise<Array<{ name: string; columns: string }>> {
    return safeFetch(`Failed to fetch indices for '${schemaName}'.'${tableName}'`, () =>
        connectionManager.executeWithRetry(async () => {
            const driver = await connectionManager.getDriver(connection.id, 'background');
            const result = await rawQuery(driver, `
                SELECT INDEX_NAME, INDEX_TYPE, INDEX_COLUMNS
                FROM SYS.EXA_ALL_INDICES
                WHERE INDEX_SCHEMA = '${escapeSqlString(schemaName)}'
                AND INDEX_TABLE = '${escapeSqlString(tableName)}'
                ORDER BY INDEX_NAME
            `);
            const rows = getRowsFromResult(result);
            return rows.map((row: any) => ({
                name: row.INDEX_NAME ?? row.INDEX_TYPE ?? 'INDEX',
                columns: row.INDEX_COLUMNS ?? ''
            }));
        }, connection.id, { role: 'background' }),
    [], getOutputChannel());
}

export async function fetchVirtualSchemas(
    connectionManager: ConnectionManager,
    connection: StoredConnection
): Promise<Array<{ name: string; adapterName?: string; lastRefresh?: string; lastRefreshBy?: string }>> {
    return safeFetch('Failed to fetch virtual schemas', () =>
        connectionManager.executeWithRetry(async () => {
            const driver = await connectionManager.getDriver(connection.id, 'background');
            const result = await rawQuery(driver, `
                SELECT
                    SCHEMA_NAME,
                    ADAPTER_SCRIPT_SCHEMA,
                    ADAPTER_SCRIPT_NAME,
                    LAST_REFRESH,
                    LAST_REFRESH_BY
                FROM SYS.EXA_ALL_VIRTUAL_SCHEMAS
                ORDER BY SCHEMA_NAME
            `);
            const rows = getRowsFromResult(result);
            return rows.map((row: any) => ({
                name: row.SCHEMA_NAME,
                adapterName: row.ADAPTER_SCRIPT_NAME ?? undefined,
                lastRefresh: row.LAST_REFRESH ?? undefined,
                lastRefreshBy: row.LAST_REFRESH_BY ?? undefined
            }));
        }, connection.id, { role: 'background' }),
    [], getOutputChannel());
}

export async function fetchVirtualTables(
    connectionManager: ConnectionManager,
    connection: StoredConnection,
    virtualSchemaName: string
): Promise<Array<{ name: string }>> {
    return safeFetch(`Failed to fetch virtual tables for '${virtualSchemaName}'`, () =>
        connectionManager.executeWithRetry(async () => {
            const driver = await connectionManager.getDriver(connection.id, 'background');
            const result = await rawQuery(driver, `
                SELECT TABLE_NAME
                FROM SYS.EXA_ALL_VIRTUAL_TABLES
                WHERE TABLE_SCHEMA = '${escapeSqlString(virtualSchemaName)}'
                ORDER BY TABLE_NAME
            `);
            const rows = getRowsFromResult(result);
            return rows.map((row: any) => ({
                name: row.TABLE_NAME
            }));
        }, connection.id, { role: 'background' }),
    [], getOutputChannel());
}

export async function fetchVirtualColumns(
    connectionManager: ConnectionManager,
    connection: StoredConnection,
    virtualSchemaName: string,
    tableName: string
): Promise<Array<{ name: string; type: string }>> {
    return safeFetch(`Failed to fetch virtual columns for '${virtualSchemaName}'.'${tableName}'`, () =>
        connectionManager.executeWithRetry(async () => {
            const driver = await connectionManager.getDriver(connection.id, 'background');
            const result = await rawQuery(driver, `
                SELECT COLUMN_NAME, COLUMN_TYPE
                FROM SYS.EXA_ALL_VIRTUAL_COLUMNS
                WHERE COLUMN_SCHEMA = '${escapeSqlString(virtualSchemaName)}'
                AND COLUMN_TABLE = '${escapeSqlString(tableName)}'
                ORDER BY COLUMN_ORDINAL_POSITION
            `);
            const rows = getRowsFromResult(result);
            return rows.map((row: any) => ({
                name: row.COLUMN_NAME,
                type: row.COLUMN_TYPE
            }));
        }, connection.id, { role: 'background' }),
    [], getOutputChannel());
}

export async function fetchSystemTables(
    connectionManager: ConnectionManager,
    connection: StoredConnection,
    schemaName: string
): Promise<Array<{ name: string }>> {
    return safeFetch(`Failed to fetch system tables for '${schemaName}'`, () =>
        connectionManager.executeWithRetry(async () => {
            const driver = await connectionManager.getDriver(connection.id, 'background');
            const result = await rawQuery(driver, `
                SELECT OBJECT_NAME
                FROM SYS.EXA_SYSCAT
                WHERE SCHEMA_NAME = '${escapeSqlString(schemaName)}'
                ORDER BY OBJECT_NAME
            `);
            const rows = getRowsFromResult(result);
            return rows.map((row: any) => ({
                name: row.OBJECT_NAME
            }));
        }, connection.id, { role: 'background' }),
    [], getOutputChannel());
}

export async function fetchSystemTableColumns(
    connectionManager: ConnectionManager,
    connection: StoredConnection,
    schemaName: string,
    tableName: string
): Promise<Array<{ name: string; type: string }>> {
    return safeFetch(`Failed to fetch system table columns for '${schemaName}'.'${tableName}'`, () =>
        connectionManager.executeWithRetry(async () => {
            const driver = await connectionManager.getDriver(connection.id, 'background');
            const result = await rawQuery(driver, `
                DESCRIBE "${escapeSqlIdentifier(schemaName)}"."${escapeSqlIdentifier(tableName)}"
            `);
            const rows = getRowsFromResult(result);
            return rows.map((row: any) => ({
                name: row.COLUMN_NAME,
                type: row.SQL_TYPE ?? 'UNKNOWN'
            }));
        }, connection.id, { role: 'background' }),
    [], getOutputChannel());
}
