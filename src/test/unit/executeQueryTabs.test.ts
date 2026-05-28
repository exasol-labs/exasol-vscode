import * as assert from 'assert';
import { QueryResult } from '../../queryExecutor';
import { TabResultCollector } from '../../execution/tabResultCollector';

function makeResult(rowCount: number = 1): QueryResult {
    return {
        columns: ['col1'],
        columnMetadata: [{ name: 'col1', type: 'VARCHAR' }],
        rows: Array.from({ length: rowCount }, (_, i) => [i]),
        rowCount,
        executionTime: 10
    };
}

function makeDdlResult(): QueryResult {
    return {
        columns: [],
        columnMetadata: [],
        rows: [],
        rowCount: 0,
        executionTime: 5
    };
}

suite('TabResultCollector', () => {

    suite('collecting successful results', () => {
        test('adds sequential result labels starting at 1', () => {
            const collector = new TabResultCollector();
            collector.addResult(makeResult(5));
            collector.addResult(makeResult(3));
            collector.addResult(makeResult(1));

            const tabs = collector.getTabs();
            assert.strictEqual(tabs.length, 3);
            assert.strictEqual(tabs[0].label, 'Result 1');
            assert.strictEqual(tabs[1].label, 'Result 2');
            assert.strictEqual(tabs[2].label, 'Result 3');
        });

        test('stores the query result on each tab', () => {
            const collector = new TabResultCollector();
            const result = makeResult(5);
            collector.addResult(result);

            const tabs = collector.getTabs();
            assert.strictEqual(tabs[0].result, result);
            assert.strictEqual(tabs[0].error, undefined);
        });
    });

    suite('collecting errors', () => {
        test('adds error tab with error message', () => {
            const collector = new TabResultCollector();
            collector.addResult(makeResult());
            collector.addError('syntax error at line 1');
            collector.addResult(makeResult());

            const tabs = collector.getTabs();
            assert.strictEqual(tabs.length, 3);
            assert.strictEqual(tabs[1].label, 'Result 2');
            assert.strictEqual(tabs[1].error, 'syntax error at line 1');
            assert.strictEqual(tabs[1].result, undefined);
        });

        test('error tabs are interspersed correctly with results', () => {
            const collector = new TabResultCollector();
            collector.addError('error 1');
            collector.addResult(makeResult());
            collector.addError('error 2');

            const tabs = collector.getTabs();
            assert.strictEqual(tabs.length, 3);
            assert.strictEqual(tabs[0].error, 'error 1');
            assert.ok(tabs[1].result);
            assert.strictEqual(tabs[2].error, 'error 2');
        });
    });

    suite('single statement does not warrant tab bar', () => {
        test('single result produces count of 1', () => {
            const collector = new TabResultCollector();
            collector.addResult(makeResult(10));

            assert.strictEqual(collector.getTabs().length, 1);
        });
    });

    suite('new collector replaces previous results', () => {
        test('creating a new collector starts with empty tabs', () => {
            const first = new TabResultCollector();
            first.addResult(makeResult());
            first.addResult(makeResult());
            assert.strictEqual(first.getTabs().length, 2);

            const second = new TabResultCollector();
            assert.strictEqual(second.getTabs().length, 0);
            assert.strictEqual(second.hasResults(), false);
        });

        test('new collector labels restart at 1', () => {
            const first = new TabResultCollector();
            first.addResult(makeResult());
            first.addResult(makeResult());

            const second = new TabResultCollector();
            second.addResult(makeResult());

            assert.strictEqual(second.getTabs()[0].label, 'Result 1');
        });
    });

    suite('mixed result types', () => {
        test('DDL result with no columns alongside SELECT results', () => {
            const collector = new TabResultCollector();
            collector.addResult(makeDdlResult());
            collector.addResult(makeResult(5));
            collector.addResult(makeDdlResult());

            const tabs = collector.getTabs();
            assert.strictEqual(tabs.length, 3);
            assert.strictEqual(tabs[0].result!.columns.length, 0);
            assert.strictEqual(tabs[0].result!.rowCount, 0);
            assert.strictEqual(tabs[1].result!.columns.length, 1);
            assert.strictEqual(tabs[1].result!.rowCount, 5);
            assert.strictEqual(tabs[2].result!.columns.length, 0);
        });

        test('DDL results interleaved with errors', () => {
            const collector = new TabResultCollector();
            collector.addResult(makeDdlResult());
            collector.addError('table not found');
            collector.addResult(makeResult(3));

            const tabs = collector.getTabs();
            assert.strictEqual(tabs.length, 3);
            assert.strictEqual(tabs[0].label, 'Result 1');
            assert.ok(tabs[0].result);
            assert.strictEqual(tabs[1].label, 'Result 2');
            assert.strictEqual(tabs[1].error, 'table not found');
            assert.strictEqual(tabs[2].label, 'Result 3');
            assert.ok(tabs[2].result);
            assert.strictEqual(tabs[2].result!.rowCount, 3);
        });
    });

    suite('empty collector', () => {
        test('returns empty array when nothing collected', () => {
            const collector = new TabResultCollector();
            assert.strictEqual(collector.getTabs().length, 0);
        });

        test('hasResults is false when empty', () => {
            const collector = new TabResultCollector();
            assert.strictEqual(collector.hasResults(), false);
        });

        test('hasResults is true after adding a result', () => {
            const collector = new TabResultCollector();
            collector.addResult(makeResult());
            assert.strictEqual(collector.hasResults(), true);
        });

        test('hasResults is true after adding an error', () => {
            const collector = new TabResultCollector();
            collector.addError('some error');
            assert.strictEqual(collector.hasResults(), true);
        });
    });
});
