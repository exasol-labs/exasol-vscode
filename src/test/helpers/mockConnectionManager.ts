import type { ExasolDriver, SQLQueriesResponse, SQLResponse } from '@exasol/exasol-driver-ts';
import type { ConnectionManager, StoredConnection } from '../../connectionManager';

export const TEST_CONNECTION: StoredConnection = {
    id: 'conn-1',
    name: 'Test Connection',
    host: 'localhost',
    port: 8563,
    user: 'sys',
    password: 'secret'
};

type RawCell = string | number | boolean | null;

export function createRawResult(columns: string[], rows: RawCell[][]): SQLResponse<SQLQueriesResponse> {
    return {
        status: 'ok',
        exception: undefined,
        responseData: {
            numResults: 1,
            results: [
                {
                    resultType: 'resultSet',
                    resultSet: {
                        columns: columns.map(name => ({ name, dataType: { type: 'VARCHAR' } })),
                        numColumns: columns.length,
                        numRows: rows.length,
                        numRowsInMessage: rows.length,
                        data: columns.map((_, colIdx) => rows.map(row => row[colIdx]))
                    }
                }
            ]
        }
    };
}

/**
 * A raw-mode SQL-error response, exactly as the real driver hands one back
 * for responseType: 'raw': status: 'error' with NO throw (verified against
 * node_modules/@exasol/exasol-driver-ts: it only calls verifyNoError(), which
 * does the throwing, for the 'default' response type; 'raw' responses are
 * returned as-is). Only getRowsFromResult() (or an equivalent explicit
 * status check) surfaces this as a thrown error; a caller that discards a
 * raw response without checking it will not see this failure at all.
 */
export function createRawErrorResult(sqlCode: string, text: string): SQLResponse<SQLQueriesResponse> {
    return {
        status: 'error',
        exception: { sqlCode, text },
        responseData: { numResults: 0, results: [] }
    };
}

export function createEmptyRawResult(columns: string[]): SQLResponse<SQLQueriesResponse> {
    return {
        status: 'ok',
        exception: undefined,
        responseData: {
            numResults: 1,
            results: [
                {
                    resultType: 'resultSet',
                    resultSet: {
                        columns: columns.map(name => ({ name, dataType: { type: 'VARCHAR' } })),
                        numColumns: columns.length,
                        numRows: 0,
                        numRowsInMessage: 0,
                        data: columns.map(() => [])
                    }
                }
            ]
        }
    };
}

/**
 * Minimal driver double: every test in this suite only ever exercises `query`
 * and (occasionally) `execute`, the raw-mode fetch/flush methods. A full
 * ExasolDriver has private fields no object literal can satisfy structurally,
 * so the narrower shape below is what test files author, and it's cast to
 * ExasolDriver at the MockConnectionManager boundary instead.
 *
 * The trailing `responseType?: 'raw'` parameter mirrors production's raw-mode
 * call shape (rawQuery/rawExecute in utils/driver.ts always pass 'raw' as the
 * fourth argument); it is not enforced here, since the mock is cast to
 * ExasolDriver in MockConnectionManager.getDriver() anyway.
 */
export interface MockDriver {
    query: (sql: string, attributes?: unknown, getCancel?: unknown, responseType?: 'raw') => Promise<SQLResponse<SQLQueriesResponse>>;
    execute?: (sql: string, attributes?: unknown, getCancel?: unknown, responseType?: 'raw') => Promise<SQLResponse<SQLQueriesResponse>>;
}

export class MockConnectionManager {
    readonly driver: MockDriver;
    private readonly activeConn: StoredConnection;

    constructor(driver: MockDriver, connection: StoredConnection = TEST_CONNECTION) {
        this.driver = driver;
        this.activeConn = connection;
    }

    getConnections(): StoredConnection[] { return [this.activeConn]; }
    getActiveConnection(): StoredConnection | undefined { return this.activeConn; }

    async getDriver(): Promise<ExasolDriver> {
        // MockDriver only implements `query`; every test that reaches this point never
        // touches any other ExasolDriver member.
        return this.driver as unknown as ExasolDriver;
    }

    async executeWithRetry<T>(fn: () => Promise<T>): Promise<T> { return fn(); }
}

/**
 * Cast a MockConnectionManager to ConnectionManager for constructors and fetcher
 * functions that require the real class. MockConnectionManager is a deliberate
 * partial double (ConnectionManager has private fields no object literal can
 * satisfy structurally); a typed structural helper reproducing its surface would
 * be larger than the tests that use it.
 */
export function asConnectionManager(manager: MockConnectionManager): ConnectionManager {
    return manager as unknown as ConnectionManager;
}
