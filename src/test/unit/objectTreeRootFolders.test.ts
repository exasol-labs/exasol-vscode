import * as assert from 'assert';
import { registerVscodeMock, registerExtensionMock } from '../helpers/vscodeMock';

registerVscodeMock();
registerExtensionMock();

const { ObjectTreeProvider } = require('../../providers/objectTreeProvider') as typeof import('../../providers/objectTreeProvider');

import type { SQLQueriesResponse, SQLResponse } from '@exasol/exasol-driver-ts';
import type { ObjectNode } from '../../providers/objectTreeProvider';
import { createRawResult, createRawErrorResult, createEmptyRawResult, MockConnectionManager, asConnectionManager } from '../helpers/mockConnectionManager';

function labelOf(node: ObjectNode): string {
    return typeof node.label === 'string' ? node.label : node.label?.label ?? '';
}

/** The root with one schema, or none, and the given answer to the folder count query. */
async function rootLabels(
    countResult: SQLResponse<SQLQueriesResponse>,
    schemaRows: string[][] = [['MY_SCHEMA']]
): Promise<{ labels: string[]; ids: Array<string | undefined>; countQueries: string[] }> {
    const countQueries: string[] = [];
    const provider = new ObjectTreeProvider(asConnectionManager(new MockConnectionManager({
        query: async (sql: string) => {
            if (sql.includes('VIRTUAL_SCHEMA_COUNT')) {
                countQueries.push(sql);
                return countResult;
            }
            if (sql.includes('EXA_SCHEMAS')) {
                return createRawResult(['SCHEMA_NAME'], schemaRows);
            }
            return createEmptyRawResult(['DUMMY']);
        }
    })));
    const roots = await provider.getChildren();
    return { labels: roots.map(labelOf), ids: roots.map(node => node.id), countQueries };
}

function counts(virtualSchemas: number, connections: number): SQLResponse<SQLQueriesResponse> {
    return createRawResult(['VIRTUAL_SCHEMA_COUNT', 'CONNECTION_COUNT'], [[virtualSchemas, connections]]);
}

suite('ObjectTreeProvider, empty root folders', () => {
    test('Virtual Schemas and Connections are hidden when they have no entries', async () => {
        const { labels } = await rootLabels(counts(0, 0));

        assert.deepStrictEqual(labels, ['MY_SCHEMA', 'System Schemas']);
    });

    test('each folder is shown when it has entries, with its usual id', async () => {
        assert.deepStrictEqual((await rootLabels(counts(2, 0))).labels, ['MY_SCHEMA', 'Virtual Schemas', 'System Schemas']);
        assert.deepStrictEqual((await rootLabels(counts(0, 4))).labels, ['MY_SCHEMA', 'Connections', 'System Schemas']);

        const { labels, ids } = await rootLabels(counts(2, 4));
        assert.deepStrictEqual(labels, ['MY_SCHEMA', 'Virtual Schemas', 'Connections', 'System Schemas']);
        assert.deepStrictEqual(ids.slice(1), [
            'conn-1:virtual-schemas-folder', 'conn-1:db-connections-folder', 'conn-1:system-schemas-folder'
        ]);
    });

    test('both folders are shown when the count query fails', async () => {
        const { labels } = await rootLabels(createRawErrorResult('42000', 'insufficient privileges'));

        assert.deepStrictEqual(labels, ['MY_SCHEMA', 'Virtual Schemas', 'Connections', 'System Schemas']);
    });

    test('one query counts both folders without listing them', async () => {
        const { countQueries } = await rootLabels(counts(1, 1));

        assert.strictEqual(countQueries.length, 1);
        assert.match(countQueries[0], /\(SELECT COUNT\(\*\) FROM SYS\.EXA_ALL_VIRTUAL_SCHEMAS\) AS VIRTUAL_SCHEMA_COUNT/);
        assert.match(countQueries[0], /\(SELECT COUNT\(\*\) FROM SYS\.EXA_ALL_CONNECTIONS\) AS CONNECTION_COUNT/);
    });

    test('without schemas the root keeps the "No schemas" message', async () => {
        const { labels } = await rootLabels(counts(0, 0), []);

        assert.deepStrictEqual(labels, ['No schemas', 'System Schemas']);
    });
});
