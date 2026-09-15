/**
 * Exasol driver wrappers, result extraction, and column metadata helpers.
 */
import type {
    ExasolDriver,
    ResultSet,
    SQLQueriesResponse,
    SQLQueryColumn,
    SQLQueryColumnType,
    SQLResponse
} from '@exasol/exasol-driver-ts';
import type * as vscode from 'vscode';

/**
 * One row of a query result, keyed by column name.
 * Exasol normalizes identifiers to uppercase, so keys are uppercase unless the
 * query aliased them with a quoted identifier. Values are `unknown` because the
 * shape depends on the query; callers that know their SELECT list should pass a
 * concrete row type to {@link getRowsFromResult}.
 */
export type SqlRow = Record<string, unknown>;

/**
 * Execute an async operation, logging any error to the given output channel and
 * returning the fallback value instead of propagating the exception.
 * Errors are never silently swallowed: every catch is appended to the channel.
 */
export async function safeFetch<T>(
    label: string,
    fn: () => Promise<T>,
    fallback: T,
    channel: vscode.OutputChannel | undefined
): Promise<T> {
    try {
        return await fn();
    } catch (error) {
        channel?.appendLine(`${label}: ${error}`);
        return fallback;
    }
}

/**
 * Run a query via the Exasol driver in 'raw' mode.
 * Always use these instead of calling driver.query()/driver.execute() directly,
 * because the driver's default (non-raw) mode crashes with
 * "Cannot read properties of undefined (reading 'numResults')" when the
 * database returns an error response (responseData is undefined).
 */
export function rawQuery(driver: ExasolDriver, sql: string): Promise<SQLResponse<SQLQueriesResponse>> {
    return driver.query(sql, undefined, undefined, 'raw');
}

export function rawExecute(driver: ExasolDriver, sql: string): Promise<SQLResponse<SQLQueriesResponse>> {
    return driver.execute(sql, undefined, undefined, 'raw');
}

/**
 * Type guard for raw Exasol driver responses (responseType: 'raw')
 */
function isRawResponse(result: unknown): result is SQLResponse<SQLQueriesResponse> {
    return typeof result === 'object' && result !== null && 'status' in result && 'responseData' in result;
}

/**
 * Throw a descriptive Error from a raw error response.
 */
export function throwSqlError(response: SQLResponse<SQLQueriesResponse>): never {
    const sqlCode = response.exception?.sqlCode;
    const text = response.exception?.text || 'Query execution failed';
    const message = sqlCode ? `SQL Error [${sqlCode}]: ${text}` : text;
    throw new Error(message);
}

/**
 * Convert a ResultSet returned by the Exasol driver into an array of row objects.
 */
function convertResultSetToRows(resultSet: ResultSet | undefined): SqlRow[] {
    if (!resultSet) {
        return [];
    }

    const columns: SQLQueryColumn[] = resultSet.columns || [];
    const columnData: Array<Array<string | number | boolean | null>> = resultSet.data || [];
    const rowCount = columnData[0]?.length ?? 0;

    const rows: SqlRow[] = [];
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
        const row: SqlRow = {};
        columns.forEach((column, columnIndex) => {
            const values = columnData[columnIndex] || [];
            const columnName = column.name || `COLUMN_${columnIndex + 1}`;
            row[columnName] = values[rowIndex] ?? null;
        });
        rows.push(row);
    }

    return rows;
}

/**
 * The QueryResult shape the driver returns outside 'raw' mode, plus the older
 * plain-property variant. Both are still accepted by the extractors below.
 */
interface QueryResultLike {
    getRows?: () => SqlRow[];
    getColumns?: () => SQLQueryColumn[];
    rows?: SqlRow[];
    columns?: SQLQueryColumn[];
}

/**
 * Extract rows from QueryResult or raw SQL response.
 * Handles both old (.rows property) and new (.getRows() method) API as well as raw responses.
 * Also handles empty results and errors.
 *
 * Pass a row type when the SELECT list is known, e.g.
 * `getRowsFromResult<{ SCHEMA_NAME: string }>(result)`. The cast is unchecked:
 * the database, not the compiler, decides the shape.
 */
export function getRowsFromResult<T = SqlRow>(result: unknown): T[] {
    if (!result) {
        return [];
    }

    const queryResult = result as QueryResultLike;
    if (typeof queryResult.getRows === 'function') {
        return queryResult.getRows() as T[];
    }

    if (isRawResponse(result)) {
        if (result.status === 'error') {
            throwSqlError(result);
        }

        const firstResult = result.responseData?.results?.[0];
        if (!firstResult || firstResult.resultType !== 'resultSet') {
            return [];
        }

        return convertResultSetToRows(firstResult.resultSet) as T[];
    }

    return (queryResult.rows ?? []) as T[];
}

/**
 * Extract columns from QueryResult or raw SQL response.
 * Handles both old (.columns property) and new (.getColumns() method) API as well as raw responses.
 * Also handles empty results and errors.
 */
export function getColumnsFromResult(result: unknown): SQLQueryColumn[] {
    if (!result) {
        return [];
    }

    const queryResult = result as QueryResultLike;
    if (typeof queryResult.getColumns === 'function') {
        return queryResult.getColumns();
    }

    if (isRawResponse(result)) {
        if (result.status === 'error') {
            throwSqlError(result);
        }

        const firstResult = result.responseData?.results?.[0];
        if (!firstResult || firstResult.resultType !== 'resultSet') {
            return [];
        }

        return firstResult.resultSet?.columns ?? [];
    }

    return queryResult.columns ?? [];
}

export function executeWithoutResult(
    driver: ExasolDriver,
    sql: string
): Promise<SQLResponse<SQLQueriesResponse>> {
    return rawQuery(driver, sql);
}

export interface ColumnMetadata {
    name: string;
    type: string;
    precision?: number;
    scale?: number;
    size?: number;
}

/**
 * Extract a display name from a column metadata object.
 * Handles both driver-returned objects (col.name) and system-table row objects (col.COLUMN_NAME),
 * with a final fallback to the raw value for primitive column names.
 */
export function extractColumnName(col: unknown): string {
    if (col !== null && typeof col === 'object') {
        const { name, COLUMN_NAME } = col as { name?: unknown; COLUMN_NAME?: unknown };
        if (name !== null && name !== undefined) {
            return String(name);
        }
        if (COLUMN_NAME !== null && COLUMN_NAME !== undefined) {
            return String(COLUMN_NAME);
        }
    }
    return String(col);
}

/**
 * Map an array of raw column metadata objects to the typed ColumnMetadata shape.
 * Shared by QueryExecutor and ObjectActions to avoid duplication.
 */
export function extractColumnMetadata(columnsMeta: readonly unknown[]): ColumnMetadata[] {
    return columnsMeta.map(col => {
        const name = extractColumnName(col);
        const dataType = (col as { dataType?: SQLQueryColumnType } | null | undefined)?.dataType;

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
