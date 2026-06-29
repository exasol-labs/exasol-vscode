import * as assert from 'assert';
import {
    computeGridHeight,
    HEADER_HEIGHT,
    ROW_HEIGHT,
    MAX_VISIBLE_ROWS,
    MAX_GRID_HEIGHT,
} from '../../webview/notebookGridLayout';

suite('computeGridHeight', () => {
    test('fits a small row count exactly without internal scroll', () => {
        const height = computeGridHeight(3);
        assert.strictEqual(height, HEADER_HEIGHT + 3 * ROW_HEIGHT + ROW_HEIGHT);
    });

    test('caps visible rows at MAX_VISIBLE_ROWS', () => {
        const many = computeGridHeight(1000);
        const atCap = computeGridHeight(MAX_VISIBLE_ROWS);
        assert.strictEqual(many, atCap);
    });

    test('never exceeds MAX_GRID_HEIGHT', () => {
        assert.ok(computeGridHeight(1000) <= MAX_GRID_HEIGHT);
    });

    test('zero rows still leaves room for the header', () => {
        const height = computeGridHeight(0);
        assert.ok(height >= HEADER_HEIGHT);
    });

    test('is monotonic up to the cap', () => {
        assert.ok(computeGridHeight(5) > computeGridHeight(4));
    });
});
