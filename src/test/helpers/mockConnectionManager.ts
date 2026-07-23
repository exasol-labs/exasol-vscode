import type { StoredConnection } from '../../connectionManager';

export const TEST_CONNECTION: StoredConnection = {
    id: 'conn-1',
    name: 'Test Connection',
    host: 'localhost',
    port: 8563,
    user: 'sys',
    password: 'secret'
};

export function createRawResult(columns: string[], rows: any[][]): any {
    return {
        status: 'ok',
        responseData: {
            numResults: 1,
            results: [
                {
                    resultType: 'resultSet',
                    resultSet: {
                        columns: columns.map(name => ({ name })),
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
 * for responseType: 'raw' — status: 'error' with NO throw (verified against
 * node_modules/@exasol/exasol-driver-ts: it only calls verifyNoError(), which
 * does the throwing, for the 'default' response type; 'raw' responses are
 * returned as-is). Only getRowsFromResult() (or an equivalent explicit
 * status check) surfaces this as a thrown error — a caller that discards a
 * raw response without checking it will not see this failure at all.
 */
export function createRawErrorResult(sqlCode: string, text: string): any {
    return {
        status: 'error',
        responseData: {},
        exception: { sqlCode, text }
    };
}

export function createEmptyRawResult(columns: string[]): any {
    return {
        status: 'ok',
        responseData: {
            numResults: 1,
            results: [
                {
                    resultType: 'resultSet',
                    resultSet: {
                        columns: columns.map(name => ({ name })),
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

export class MockConnectionManager {
    driver: any;
    private activeConn: StoredConnection | null;

    constructor(driver: any, connection: StoredConnection = TEST_CONNECTION) {
        this.driver = driver;
        this.activeConn = connection;
    }

    getConnections(): StoredConnection[] { return [this.activeConn!]; }
    getActiveConnection(): StoredConnection | null { return this.activeConn; }
    async getDriver(): Promise<any> { return this.driver; }
    async executeWithRetry<T>(fn: () => Promise<T>): Promise<T> { return fn(); }
}
