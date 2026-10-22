import * as assert from 'assert';
import type * as vscode from 'vscode';
// createRawResult/mockConnectionManager imports no vscode (only a type-only
// import, fully erased at compile time), so a static import is safe here.
import { createRawResult, TEST_CONNECTION } from '../helpers/mockConnectionManager';
import { registerVscodeMock, registerExtensionMock, vscodeMock } from '../helpers/vscodeMock';
import {
    applyCompletionVscodeMock,
    asConnectionManager,
    makeDocument,
    makeDriver,
    makePosition,
} from '../helpers/completionMocks';

// Mocks must be applied BEFORE registerVscodeMock(); see the load-order note
// at the top of completionMocks.ts.
const { CompletionItemKind } = applyCompletionVscodeMock(vscodeMock);

registerVscodeMock();
registerExtensionMock();

// completionProvider.ts imports `vscode` at module scope, so it must stay a
// deferred require() issued AFTER the mocks above are registered.
const { ExasolCompletionProvider } = require('../../providers/completionProvider') as typeof import('../../providers/completionProvider');

/** Stored names that cover every quoting case. */
const NAMES = ['ID', 'id', 'SELECT', 'lower v', 'MixedCase', 'a"b', '1X', 'PLAIN_COL'];

/** Expected [label, insertText, filterText] per stored name in NAMES. */
const EXPECTED: [string, string, string][] = [
    ['id', 'id', 'id'],
    ['"id"', '"id"', 'id'],
    ['"SELECT"', '"SELECT"', 'SELECT'],
    ['"lower v"', '"lower v"', 'lower v'],
    ['"MixedCase"', '"MixedCase"', 'MixedCase'],
    ['"a""b"', '"a""b"', 'a"b'],
    ['"1X"', '"1X"', '1X'],
    ['plain_col', 'plain_col', 'plain_col'],
];

function makeProvider(): InstanceType<typeof ExasolCompletionProvider> {
    const driver = makeDriver((sql: string) => {
        if (sql.includes('exa_sql_keywords')) {
            return createRawResult(['KEYWORD'], [['SELECT'], ['FROM']]);
        }
        if (sql.includes('EXA_ALL_TABLES')) {
            return createRawResult(
                ['TABLE_SCHEMA', 'TABLE_NAME', 'OBJECT_TYPE'],
                [['S', 'T', 'table'], ...NAMES.map(n => ['lower s', n, 'table'])]
            );
        }
        if (sql.includes('EXA_SCHEMAS')) {
            return createRawResult(['SCHEMA_NAME'], NAMES.map(n => [n]));
        }
        if (sql.includes('COLUMN_TABLE =')) {
            return createRawResult(['COLUMN_NAME'], NAMES.map(n => [n]));
        }
        return createRawResult(['TABLE_SCHEMA', 'TABLE_NAME'], []);
    });
    return new ExasolCompletionProvider(asConnectionManager({
        getActiveConnection: () => TEST_CONNECTION,
        getDriver: async () => driver,
        executeWithRetry: async <T>(fn: () => Promise<T>) => fn(),
    }));
}

/** Complete at the `|` marker. */
async function complete(sqlWithCursor: string): Promise<vscode.CompletionItem[]> {
    const linesBefore = sqlWithCursor.slice(0, sqlWithCursor.indexOf('|')).split('\n');
    const sql = sqlWithCursor.replace('|', '');
    const position = makePosition(linesBefore.length - 1, linesBefore[linesBefore.length - 1].length);
    return makeProvider().provideCompletionItems(
        makeDocument(sql), position, {} as vscode.CancellationToken, {} as vscode.CompletionContext
    );
}

/** [label, insertText, filterText] of each item. */
function texts(items: vscode.CompletionItem[]): [string, string, string][] {
    return items.map(i => [String(i.label), String(i.insertText), String(i.filterText)]);
}

function ofKind(items: vscode.CompletionItem[], kind: number): [string, string, string][] {
    return texts(items.filter(i => i.kind === kind));
}

suite('ExasolCompletionProvider - quoting of stored names', () => {
    test('columns after a table alias', async () => {
        const items = await complete('SELECT x.| FROM s.t x');
        assert.deepStrictEqual(ofKind(items, CompletionItemKind.Field), EXPECTED);
    });

    test('columns of the FROM tables after SELECT', async () => {
        const items = await complete('SELECT | FROM s.t');
        assert.deepStrictEqual(texts(items.filter(i => i.detail === 'Column')), EXPECTED);
    });

    test('objects after a schema prefix', async () => {
        const items = await complete('SELECT * FROM "lower s".|');
        assert.deepStrictEqual(ofKind(items, CompletionItemKind.Class), EXPECTED);
        assert.strictEqual(items[0].detail, 'table in "lower s"');
    });

    test('objects and schemas after FROM', async () => {
        const items = await complete('SELECT * FROM |');
        const objects = items.filter(i => i.kind === CompletionItemKind.Class && i.detail === 'table in "lower s"');
        assert.deepStrictEqual(texts(objects), EXPECTED);
        // Schemas come back sorted, plus SYS and EXA_STATISTICS.
        const schemas = items.filter(i => i.kind === CompletionItemKind.Module && !['sys', 'exa_statistics'].includes(String(i.insertText)));
        assert.deepStrictEqual(texts(schemas).sort(), [...EXPECTED].sort());
        // Sorting uses the name without quotes, so quoted names do not all sort first.
        for (const item of [...objects, ...schemas]) {
            assert.ok(String(item.sortText).endsWith(`_${item.filterText}`), String(item.sortText));
        }
    });

    test('SELECT-list aliases after LOCAL.', async () => {
        const items = await complete('SELECT 1 AS id, 2 AS "id", 3 AS "SELECT", 4 AS "lower v", 5 AS plain_col FROM t WHERE local.|');
        assert.deepStrictEqual(texts(items), [
            ['id', 'id', 'id'],
            ['"id"', '"id"', 'id'],
            ['"SELECT"', '"SELECT"', 'SELECT'],
            ['"lower v"', '"lower v"', 'lower v'],
            ['plain_col', 'plain_col', 'plain_col'],
        ]);
    });

    test('CTE columns', async () => {
        const items = await complete('WITH c AS (SELECT 1 AS id, 2 AS "id", 3 AS "SELECT", 4 AS MixedCase, 5 AS "MixedCase") SELECT c.| FROM c');
        assert.deepStrictEqual(texts(items), [
            ['id', 'id', 'id'],
            ['"id"', '"id"', 'id'],
            ['"SELECT"', '"SELECT"', 'SELECT'],
            ['mixedcase', 'mixedcase', 'mixedcase'],
            ['"MixedCase"', '"MixedCase"', 'MixedCase'],
        ]);
    });

    test('CTE columns without AS', async () => {
        const items = await complete('WITH c AS (SELECT 1 a, x b FROM t) SELECT c.| FROM c');
        assert.deepStrictEqual(texts(items), [
            ['a', 'a', 'a'],
            ['b', 'b', 'b'],
        ]);
    });

    test('CTE explicit column list', async () => {
        const items = await complete('WITH c (id, "id", "a""b") AS (SELECT 1, 2, 3) SELECT c.| FROM c');
        assert.deepStrictEqual(texts(items), [
            ['id', 'id', 'id'],
            ['"id"', '"id"', 'id'],
            ['"a""b"', '"a""b"', 'a"b'],
        ]);
    });
});

/** Start and end character of the item's range, or undefined without a range. */
function rangeOf(item: vscode.CompletionItem): [number, number] | undefined {
    const range = item.range as vscode.Range | undefined;
    return range ? [range.start.character, range.end.character] : undefined;
}

/**
 * After an opening `"` only names are listed, each quoted with its exact
 * case, also a regular name: `ID` becomes `"ID"`, because the user started
 * a quoted identifier. Keywords and functions are dropped. The range starts
 * at the opening quote and covers a closing quote right after the cursor, and
 * the filter text includes the quotes, so `"i` matches `"id"`.
 */
suite('ExasolCompletionProvider - completion after an opening quote', () => {
    const QUOTED_COLUMNS: [string, string, string][] = [
        ['"ID"', '"ID"', '"ID"'],
        ['"id"', '"id"', '"id"'],
        ['"SELECT"', '"SELECT"', '"SELECT"'],
        ['"lower v"', '"lower v"', '"lower v"'],
        ['"MixedCase"', '"MixedCase"', '"MixedCase"'],
        ['"a""b"', '"a""b"', '"a""b"'],
        ['"1X"', '"1X"', '"1X"'],
        ['"PLAIN_COL"', '"PLAIN_COL"', '"PLAIN_COL"'],
    ];

    function assertOnlyQuotedNames(items: vscode.CompletionItem[], range: [number, number]): void {
        assert.ok(items.length > 0);
        for (const item of items) {
            assert.ok(String(item.insertText).startsWith('"'), String(item.insertText));
            assert.deepStrictEqual(rangeOf(item), range, String(item.label));
            assert.ok(item.kind !== CompletionItemKind.Keyword && item.kind !== CompletionItemKind.Function, String(item.label));
        }
    }

    test('typed word after the quote', async () => {
        const items = await complete('SELECT "i| FROM s.t');
        assert.deepStrictEqual(texts(items.filter(i => i.detail === 'Column')), QUOTED_COLUMNS);
        assertOnlyQuotedNames(items, [7, 9]);
    });

    test('only the quote, with an auto-closed quote after the cursor', async () => {
        const items = await complete('SELECT "|" FROM s.t');
        assert.deepStrictEqual(texts(items.filter(i => i.detail === 'Column')), QUOTED_COLUMNS);
        assertOnlyQuotedNames(items, [7, 9]);
    });

    test('word and auto-closed quote after the cursor are replaced', async () => {
        const items = await complete('SELECT "i|d" FROM s.t');
        assertOnlyQuotedNames(items, [7, 11]);
    });

    test('only the quote at the end of the line', async () => {
        const items = await complete('SELECT "|');
        const objects = items.filter(i => i.kind === CompletionItemKind.Class && i.detail === 'table in "lower s"');
        assert.deepStrictEqual(texts(objects), QUOTED_COLUMNS);
        assertOnlyQuotedNames(items, [7, 8]);
    });

    test('after an alias and a dot', async () => {
        const items = await complete('SELECT x."i|" FROM s.t x');
        assert.deepStrictEqual(texts(items), QUOTED_COLUMNS);
        assertOnlyQuotedNames(items, [9, 12]);
    });

    test('unquoted typing is unchanged', async () => {
        const items = await complete('SELECT i| FROM s.t');
        assert.deepStrictEqual(texts(items.filter(i => i.detail === 'Column')), EXPECTED);
        assert.ok(items.every(i => rangeOf(i) === undefined));
        assert.ok(items.some(i => i.kind === CompletionItemKind.Keyword));
    });

    test('an escaped quote does not open a new identifier', async () => {
        assertOnlyQuotedNames(await complete('SELECT "a""|'), [7, 11]);
        assertOnlyQuotedNames(await complete('SELECT "a""b|'), [7, 12]);
    });

    test('a space inside the quoted identifier', async () => {
        assertOnlyQuotedNames(await complete('SELECT "lower v|'), [7, 15]);
    });

    test('a string from an earlier line is closed before the quote', async () => {
        assertOnlyQuotedNames(await complete(`SELECT 'a\nb', "|`), [4, 5]);
    });

    test('a closing quote or a quote in a string does not start a quoted identifier', async () => {
        for (const sql of [
            'SELECT "id"| FROM s.t', `SELECT x FROM s.t WHERE x = 'a"|`, 'SELECT 1 -- "|',
            'SELECT /* "| */ 1', `SELECT 'a\nb "|'`, 'SELECT "a\nb|',
        ]) {
            const items = await complete(sql);
            assert.ok(items.every(i => rangeOf(i) === undefined), sql);
        }
    });
});
