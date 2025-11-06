/**
 * Utility functions for Exasol extension
 */
import type { ExasolDriver, SQLQueriesResponse, SQLQueryColumn, SQLResponse } from '@exasol/exasol-driver-ts';

/**
 * Type guard for raw Exasol driver responses (responseType: 'raw')
 */
function isRawResponse(result: unknown): result is SQLResponse<SQLQueriesResponse> {
    return typeof result === 'object' && result !== null && 'status' in result && 'responseData' in result;
}

/**
 * Convert a ResultSet returned by the Exasol driver into an array of row objects.
 */
function convertResultSetToRows(resultSet: any): Record<string, unknown>[] {
    if (!resultSet) {
        return [];
    }

    const columns: SQLQueryColumn[] = resultSet.columns || [];
    const columnData: Array<Array<string | number | boolean | null>> = resultSet.data || [];
    const rowCount = columnData[0]?.length ?? 0;

    const rows: Record<string, unknown>[] = [];
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
        const row: Record<string, unknown> = {};
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
 * Extract rows from QueryResult or raw SQL response.
 * Handles both old (.rows property) and new (.getRows() method) API as well as raw responses.
 * Also handles empty results and errors.
 */
export function getRowsFromResult(result: any): any[] {
    if (!result) {
        return [];
    }

    try {
        if (typeof result.getRows === 'function') {
            return result.getRows();
        }

        if (isRawResponse(result)) {
            if (result.status === 'error') {
                const message = result.exception?.text || 'Query execution failed';
                throw new Error(message);
            }

            const firstResult = result.responseData?.results?.[0];
            if (!firstResult || firstResult.resultType !== 'resultSet') {
                return [];
            }

            return convertResultSetToRows(firstResult.resultSet);
        }

        return result.rows || [];
    } catch (error) {
        // If extraction fails, surface the error so callers can handle/fallback appropriately
        throw error;
    }
}

/**
 * Extract columns from QueryResult or raw SQL response.
 * Handles both old (.columns property) and new (.getColumns() method) API as well as raw responses.
 * Also handles empty results and errors.
 */
export function getColumnsFromResult(result: any): any[] {
    if (!result) {
        return [];
    }

    try {
        if (typeof result.getColumns === 'function') {
            return result.getColumns();
        }

        if (isRawResponse(result)) {
            if (result.status === 'error') {
                const message = result.exception?.text || 'Query execution failed';
                throw new Error(message);
            }

            const firstResult = result.responseData?.results?.[0];
            if (!firstResult || firstResult.resultType !== 'resultSet') {
                return [];
            }

            return firstResult.resultSet?.columns || [];
        }

        return result.columns || [];
    } catch (error) {
        throw error;
    }
}

function isNonResultMetadataError(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error ?? '')).toUpperCase();
    return message.includes('NUMRESULTS') || message.includes('INVALID RESULT TYPE') || message.includes('E-EDJS-11');
}

export async function executeWithoutResult(
    driver: ExasolDriver,
    sql: string
): Promise<SQLResponse<SQLQueriesResponse>> {
    try {
        return await driver.query(sql, undefined, undefined, 'raw');
    } catch (error) {
        if (isNonResultMetadataError(error)) {
            return await driver.execute(sql, undefined, undefined, 'raw');
        }
        throw error;
    }
}

/**
 * Find the SQL statement at the given cursor position in a document.
 * Uses the same logic as CodeLens provider to detect statement boundaries (semicolons).
 * Returns the statement text and its range, or undefined if no statement found.
 */
export function findStatementAtCursor(
    documentText: string,
    cursorLine: number
): { text: string; range: { start: number; end: number } } | undefined {
    const lines = documentText.split('\n');

    // Find all statement boundaries
    const statements: Array<{ start: number; end: number; text: string }> = [];
    let currentStatementStart: number | null = null;
    let statementLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // Skip empty lines and comments
        if (!line || line.startsWith('--')) {
            continue;
        }

        // If we haven't started a statement yet, start one
        if (currentStatementStart === null) {
            currentStatementStart = i;
            statementLines = [lines[i]];
        } else {
            statementLines.push(lines[i]);
        }

        // Check if this line ends with a semicolon (end of statement)
        if (line.endsWith(';')) {
            // Save this statement
            if (currentStatementStart !== null && statementLines.length > 0) {
                const statementText = statementLines.join('\n');
                statements.push({
                    start: currentStatementStart,
                    end: i,
                    text: statementText
                });
            }

            // Reset for next statement
            currentStatementStart = null;
            statementLines = [];
        }
    }

    // Handle the case where there's a statement without a semicolon at the end
    if (currentStatementStart !== null && statementLines.length > 0) {
        const statementText = statementLines.join('\n');
        statements.push({
            start: currentStatementStart,
            end: lines.length - 1,
            text: statementText
        });
    }

    // Find which statement the cursor is in
    for (const statement of statements) {
        if (cursorLine >= statement.start && cursorLine <= statement.end) {
            return {
                text: statement.text,
                range: { start: statement.start, end: statement.end }
            };
        }
    }

    return undefined;
}
