import * as assert from 'assert';
import { registerVscodeMock, registerExtensionMock } from '../helpers/vscodeMock';

registerVscodeMock();
registerExtensionMock();

const { fetchTables, fetchViews } = require('../../providers/objectTreeFetchers') as typeof import('../../providers/objectTreeFetchers');

import { createRawResult, MockConnectionManager, TEST_CONNECTION, asConnectionManager } from '../helpers/mockConnectionManager';
import type { MockDriver } from '../helpers/mockConnectionManager';

/**
 * EXA_ALL_OBJECTS has no OBJECT_SCHEMA column; the schema of an object is
 * ROOT_NAME with ROOT_TYPE = 'SCHEMA' (verified live on Exasol). The tables
 * and views fallbacks must filter on ROOT_NAME, and a missing ROOT_NAME must
 * fall through to the EXA_ALL_COLUMNS attempt.
 */
suite('EXA_ALL_OBJECTS fallback, schema filter', () => {

    function createDriver(
        queries: string[],
        firstErrorTable: string,
        firstErrorText: string,
        resultColumn: string,
        objectsErrorText = 'object ROOT_NAME not found [line 4, column 31]'
    ): MockDriver {
        return {
            query: async (sql: string) => {
                queries.push(sql);
                if (sql.includes(firstErrorTable)) {
                    throw new Error(firstErrorText);
                }
                if (sql.includes('EXA_ALL_OBJECTS')) {
                    throw new Error(objectsErrorText);
                }
                if (sql.includes('EXA_ALL_COLUMNS')) {
                    return createRawResult([resultColumn], [['FROM_COLUMNS']]);
                }
                throw new Error(`Unexpected query: ${sql}`);
            }
        };
    }

    test('fetchTables filters EXA_ALL_OBJECTS on ROOT_NAME and continues when it is missing', async () => {
        const queries: string[] = [];
        const mockCM = new MockConnectionManager(
            createDriver(queries, 'EXA_ALL_TABLES', 'object EXA_ALL_TABLES not found', 'TABLE_NAME')
        );

        const tables = await fetchTables(asConnectionManager(mockCM), TEST_CONNECTION, 'MY_SCHEMA');

        assert.deepStrictEqual(tables.map(t => t.name), ['FROM_COLUMNS']);
        const objectQuery = queries.find(sql => sql.includes('EXA_ALL_OBJECTS'));
        assert.ok(objectQuery, 'EXA_ALL_OBJECTS attempt must run');
        assert.ok(objectQuery.includes("ROOT_NAME = 'MY_SCHEMA'"), 'must filter on ROOT_NAME');
        assert.ok(objectQuery.includes("ROOT_TYPE = 'SCHEMA'"), 'must restrict ROOT_TYPE to SCHEMA');
        assert.ok(!objectQuery.includes('OBJECT_SCHEMA'), 'OBJECT_SCHEMA does not exist in EXA_ALL_OBJECTS');
        assert.ok(queries[queries.length - 1].includes('EXA_ALL_COLUMNS'), 'chain must continue to EXA_ALL_COLUMNS');
    });

    test('fetchViews filters EXA_ALL_OBJECTS on ROOT_NAME and continues when it is missing', async () => {
        const queries: string[] = [];
        const mockCM = new MockConnectionManager(
            createDriver(queries, 'EXA_ALL_VIEWS', 'object VIEW_SCHEMA not found', 'VIEW_NAME')
        );

        const views = await fetchViews(asConnectionManager(mockCM), TEST_CONNECTION, 'MY_SCHEMA');

        assert.deepStrictEqual(views.map(v => v.name), ['FROM_COLUMNS']);
        const objectQuery = queries.find(sql => sql.includes('EXA_ALL_OBJECTS'));
        assert.ok(objectQuery, 'EXA_ALL_OBJECTS attempt must run');
        assert.ok(objectQuery.includes("ROOT_NAME = 'MY_SCHEMA'"), 'must filter on ROOT_NAME');
        assert.ok(objectQuery.includes("ROOT_TYPE = 'SCHEMA'"), 'must restrict ROOT_TYPE to SCHEMA');
        assert.ok(!objectQuery.includes('OBJECT_SCHEMA'), 'OBJECT_SCHEMA does not exist in EXA_ALL_OBJECTS');
        assert.ok(queries[queries.length - 1].includes('EXA_ALL_COLUMNS'), 'chain must continue to EXA_ALL_COLUMNS');
    });

    test('fetchTables continues to EXA_ALL_COLUMNS when OBJECT_IS_VIRTUAL is missing', async () => {
        const queries: string[] = [];
        const mockCM = new MockConnectionManager(
            createDriver(
                queries,
                'EXA_ALL_TABLES',
                'object EXA_ALL_TABLES not found',
                'TABLE_NAME',
                'object OBJECT_IS_VIRTUAL not found [line 6, column 29]'
            )
        );

        const tables = await fetchTables(asConnectionManager(mockCM), TEST_CONNECTION, 'MY_SCHEMA');

        assert.deepStrictEqual(tables.map(t => t.name), ['FROM_COLUMNS']);
        assert.ok(queries.some(sql => sql.includes('OBJECT_IS_VIRTUAL = FALSE')), 'EXA_ALL_OBJECTS attempt must run');
        assert.ok(queries[queries.length - 1].includes('EXA_ALL_COLUMNS'), 'chain must continue to EXA_ALL_COLUMNS');
    });
});
