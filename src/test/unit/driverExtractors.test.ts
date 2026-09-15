import * as assert from 'assert';
import type { SQLQueriesResponse, SQLResponse } from '@exasol/exasol-driver-ts';
import { getColumnsFromResult, getRowsFromResult } from '../../utils';
import type { RawSqlResponse } from '../../utils';

suite('getRowsFromResult', () => {
    test('Should handle null/undefined result', () => {
        const rows1 = getRowsFromResult(null);
        const rows2 = getRowsFromResult(undefined);

        assert.strictEqual(rows1.length, 0, 'Null should return empty array');
        assert.strictEqual(rows2.length, 0, 'Undefined should return empty array');
    });

    test('Should handle raw response format', () => {
        const mockRawResult: SQLResponse<SQLQueriesResponse> = {
            status: 'ok',
            exception: undefined,
            responseData: {
                numResults: 1,
                results: [{
                    resultType: 'resultSet',
                    resultSet: {
                        numColumns: 2,
                        numRows: 2,
                        numRowsInMessage: 2,
                        columns: [
                            { name: 'ID', dataType: { type: 'INTEGER' } },
                            { name: 'NAME', dataType: { type: 'VARCHAR' } }
                        ],
                        data: [
                            [1, 2],
                            ['Test1', 'Test2']
                        ]
                    }
                }]
            }
        };

        const rows = getRowsFromResult(mockRawResult);
        assert.strictEqual(rows.length, 2);
        assert.strictEqual(rows[0].ID, 1);
        assert.strictEqual(rows[0].NAME, 'Test1');
        assert.strictEqual(rows[1].ID, 2);
        assert.strictEqual(rows[1].NAME, 'Test2');
    });

    test('throws on the real driver error shape', () => {
        // responseData is undefined on a real error response (verified live
        // against the docker Exasol instance); RawSqlResponse types that
        // honestly, so no cast is needed here.
        const mockErrorResult: RawSqlResponse = {
            status: 'error',
            responseData: undefined,
            exception: {
                sqlCode: '42000',
                text: 'Query failed'
            }
        };

        assert.throws(() => getRowsFromResult(mockErrorResult), /^Error: SQL Error \[42000\]: Query failed$/);
    });

    test('throws the fallback message when sqlCode and text are both empty', () => {
        const mockErrorResult: RawSqlResponse = {
            status: 'error',
            responseData: undefined,
            exception: {
                sqlCode: '',
                text: ''
            }
        };

        assert.throws(() => getRowsFromResult(mockErrorResult), /^Error: Query execution failed$/);
    });

    test('Should handle raw response with no results', () => {
        const mockEmptyResult: SQLResponse<SQLQueriesResponse> = {
            status: 'ok',
            exception: undefined,
            responseData: {
                numResults: 0,
                results: []
            }
        };

        const rows = getRowsFromResult(mockEmptyResult);
        assert.strictEqual(rows.length, 0);
    });

    test('Should handle raw response with non-resultSet type', () => {
        const mockResult: SQLResponse<SQLQueriesResponse> = {
            status: 'ok',
            exception: undefined,
            responseData: {
                numResults: 1,
                results: [{
                    resultType: 'rowCount'
                }]
            }
        };

        const rows = getRowsFromResult(mockResult);
        assert.strictEqual(rows.length, 0);
    });

    test('Should handle an empty columns array in the resultSet', () => {
        const mockResult: SQLResponse<SQLQueriesResponse> = {
            status: 'ok',
            exception: undefined,
            responseData: {
                numResults: 1,
                results: [{
                    resultType: 'resultSet',
                    resultSet: {
                        numColumns: 0,
                        numRows: 3,
                        numRowsInMessage: 3,
                        columns: [],
                        data: [[1, 2, 3]]
                    }
                }]
            }
        };

        const rows = getRowsFromResult(mockResult);
        // No columns to key the values by, so every row comes back empty.
        assert.deepStrictEqual(rows, [{}, {}, {}]);
    });

    test('Should key a row by COLUMN_N when a column has no name', () => {
        const mockResult: SQLResponse<SQLQueriesResponse> = {
            status: 'ok',
            exception: undefined,
            responseData: {
                numResults: 1,
                results: [{
                    resultType: 'resultSet',
                    resultSet: {
                        numColumns: 1,
                        numRows: 1,
                        numRowsInMessage: 1,
                        columns: [{ name: '', dataType: { type: 'VARCHAR' } }],
                        data: [['value']]
                    }
                }]
            }
        };

        const rows = getRowsFromResult(mockResult);
        assert.deepStrictEqual(rows, [{ COLUMN_1: 'value' }]);
    });

    test('Should handle empty data in resultSet', () => {
        const mockResult: SQLResponse<SQLQueriesResponse> = {
            status: 'ok',
            exception: undefined,
            responseData: {
                numResults: 1,
                results: [{
                    resultType: 'resultSet',
                    resultSet: {
                        numColumns: 1,
                        numRows: 0,
                        numRowsInMessage: 0,
                        columns: [{ name: 'ID', dataType: { type: 'INTEGER' } }],
                        data: []
                    }
                }]
            }
        };

        const rows = getRowsFromResult(mockResult);
        assert.strictEqual(rows.length, 0);
    });
});

suite('getColumnsFromResult', () => {
    test('Should handle null/undefined result', () => {
        const cols1 = getColumnsFromResult(null);
        const cols2 = getColumnsFromResult(undefined);

        assert.strictEqual(cols1.length, 0, 'Null should return empty array');
        assert.strictEqual(cols2.length, 0, 'Undefined should return empty array');
    });

    test('Should handle raw response format', () => {
        const mockRawResult: SQLResponse<SQLQueriesResponse> = {
            status: 'ok',
            exception: undefined,
            responseData: {
                numResults: 1,
                results: [{
                    resultType: 'resultSet',
                    resultSet: {
                        numColumns: 2,
                        numRows: 0,
                        numRowsInMessage: 0,
                        columns: [
                            { name: 'ID', dataType: { type: 'INTEGER' } },
                            { name: 'NAME', dataType: { type: 'VARCHAR' } }
                        ]
                    }
                }]
            }
        };

        const columns = getColumnsFromResult(mockRawResult);
        assert.strictEqual(columns.length, 2);
        assert.strictEqual(columns[0].name, 'ID');
        assert.strictEqual(columns[0].dataType.type, 'INTEGER');
        assert.strictEqual(columns[1].name, 'NAME');
        assert.strictEqual(columns[1].dataType.type, 'VARCHAR');
    });

    test('Should handle raw response with error status', () => {
        // The error branch returns before ever reading responseData, so
        // (unlike the dedicated real-shape test in the getRowsFromResult
        // suite above) this mock can stay honestly typed with no cast.
        const mockErrorResult: SQLResponse<SQLQueriesResponse> = {
            status: 'error',
            exception: {
                sqlCode: '42000',
                text: 'Column fetch failed'
            },
            responseData: {
                numResults: 0,
                results: []
            }
        };

        assert.throws(() => getColumnsFromResult(mockErrorResult), /^Error: SQL Error \[42000\]: Column fetch failed$/);
    });

    test('Should handle raw response with no columns', () => {
        const mockResult: SQLResponse<SQLQueriesResponse> = {
            status: 'ok',
            exception: undefined,
            responseData: {
                numResults: 1,
                results: [{
                    resultType: 'resultSet',
                    resultSet: {
                        numColumns: 0,
                        numRows: 0,
                        numRowsInMessage: 0,
                        columns: []
                    }
                }]
            }
        };

        const columns = getColumnsFromResult(mockResult);
        assert.strictEqual(columns.length, 0);
    });
});
