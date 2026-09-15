import * as assert from 'assert';
import type * as vscode from 'vscode';
import { registerVscodeMock, registerExtensionMock } from '../helpers/vscodeMock';

registerVscodeMock();
registerExtensionMock();

const { ObjectTreeItem } = require('../../providers/objectTreeProvider') as typeof import('../../providers/objectTreeProvider');
const { fetchColumns } = require('../../providers/objectTreeFetchers') as typeof import('../../providers/objectTreeFetchers');

import { createRawResult, MockConnectionManager, TEST_CONNECTION, asConnectionManager } from '../helpers/mockConnectionManager';
import type { MockDriver } from '../helpers/mockConnectionManager';

/**
 * Regression coverage for EXA_ALL_COLUMNS.COLUMN_IS_NULLABLE: a boolean for
 * table columns, and SQL NULL (mapped to `null`) for every view column
 * (verified live on Exasol). Both fetchColumns and the ObjectTreeItem tooltip
 * must keep `null` distinct from `false`, never coalescing it to either
 * boolean.
 */
suite('Column nullability, null-safe mapping', () => {

    test('fetchColumns passes COLUMN_IS_NULLABLE through as true, false, null', async () => {
        const mockDriver: MockDriver = {
            query: async (sql: string) => {
                if (sql.includes('EXA_ALL_COLUMNS')) {
                    return createRawResult(
                        ['COLUMN_NAME', 'COLUMN_TYPE', 'COLUMN_IS_NULLABLE'],
                        [
                            ['NULLABLE_COL', 'VARCHAR(10)', true],
                            ['NOT_NULLABLE_COL', 'VARCHAR(10)', false],
                            ['VIEW_COL', 'VARCHAR(10)', null]
                        ]
                    );
                }
                throw new Error(`Unexpected query: ${sql}`);
            }
        };
        const mockCM = new MockConnectionManager(mockDriver);

        const columns = await fetchColumns(asConnectionManager(mockCM), TEST_CONNECTION, 'MY_SCHEMA', 'MY_TABLE');

        assert.strictEqual(columns.length, 3);
        assert.strictEqual(columns[0].nullable, true, 'boolean true must pass through unchanged');
        assert.strictEqual(columns[1].nullable, false, 'boolean false must pass through unchanged, not coalesced to true');
        assert.strictEqual(columns[2].nullable, null, 'SQL NULL (view column) must pass through as null, not coalesced to true or false');
    });

    test('ObjectTreeItem tooltip reflects nullable true, false, null exactly', () => {
        const makeColumnItem = (nullable: boolean | null) => new ObjectTreeItem({
            label: 'MY_COL',
            id: `column-${String(nullable)}`,
            collapsibleState: 0 as vscode.TreeItemCollapsibleState,
            type: 'column',
            columnInfo: { name: 'MY_COL', type: 'VARCHAR(10)', nullable }
        });

        const nullableItem = makeColumnItem(true);
        const notNullableItem = makeColumnItem(false);
        const viewColumnItem = makeColumnItem(null);

        assert.strictEqual(nullableItem.tooltip, 'MY_COL: VARCHAR(10) (nullable)');
        assert.strictEqual(notNullableItem.tooltip, 'MY_COL: VARCHAR(10)');
        assert.strictEqual(viewColumnItem.tooltip, 'MY_COL: VARCHAR(10)', 'null nullability (view column) must not render "(nullable)"');
    });
});
