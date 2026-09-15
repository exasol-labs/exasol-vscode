/**
 * Exasol driver wrappers, result extraction, and column metadata helpers.
 */
import type {
    ExasolDriver,
    ResultSet,
    SQLQueriesResponse,
    SQLQueryColumn,
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
 * The driver's own `SQLResponse<SQLQueriesResponse>` type declares
 * `responseData` required, but a real error response from the server has it
 * `undefined` (verified live). This is the honest type for a raw response as
 * actually received, and the one getRowsFromResult/getColumnsFromResult
 * accept; `rawQuery`/`rawExecute` keep the driver's own (narrower) return
 * type, which is assignable to this one.
 */
export type RawSqlResponse = Omit<SQLResponse<SQLQueriesResponse>, 'responseData'> & {
    responseData?: SQLQueriesResponse;
};

/**
 * Throw a descriptive Error from a raw error response.
 */
export function throwSqlError(response: RawSqlResponse): never {
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
 * Extract rows from a raw Exasol SQL response.
 * Handles empty results and errors.
 *
 * The driver builds this object with a fixed set of keys rather than a
 * verbatim JSON.parse, so `status`, `exception` and `responseData` are always
 * own properties of `result`, even when `undefined` (verified live). No
 * runtime shape guard is needed beyond the `!result` check.
 *
 * Pass a row type when the SELECT list is known, e.g.
 * `getRowsFromResult<{ SCHEMA_NAME: string }>(result)`. The cast is unchecked:
 * the database, not the compiler, decides the shape.
 */
export function getRowsFromResult<T = SqlRow>(
    result: RawSqlResponse | null | undefined
): T[] {
    if (!result) {
        return [];
    }

    if (result.status === 'error') {
        throwSqlError(result);
    }

    const firstResult = result.responseData?.results?.[0];
    if (!firstResult || firstResult.resultType !== 'resultSet') {
        return [];
    }

    return convertResultSetToRows(firstResult.resultSet) as T[];
}

/**
 * Extract columns from a raw Exasol SQL response.
 * Handles empty results and errors.
 */
export function getColumnsFromResult(
    result: RawSqlResponse | null | undefined
): SQLQueryColumn[] {
    if (!result) {
        return [];
    }

    if (result.status === 'error') {
        throwSqlError(result);
    }

    const firstResult = result.responseData?.results?.[0];
    if (!firstResult || firstResult.resultType !== 'resultSet') {
        return [];
    }

    return firstResult.resultSet?.columns ?? [];
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
 * Extract the display name from a driver column metadata object.
 */
export function extractColumnName(col: SQLQueryColumn): string {
    return col.name;
}

/**
 * Map an array of driver column metadata objects to the typed ColumnMetadata shape.
 * Shared by QueryExecutor and ObjectActions to avoid duplication.
 */
export function extractColumnMetadata(columnsMeta: readonly SQLQueryColumn[]): ColumnMetadata[] {
    return columnsMeta.map(col => ({
        name: extractColumnName(col),
        type: col.dataType.type,
        precision: col.dataType.precision,
        scale: col.dataType.scale,
        size: col.dataType.size
    }));
}
