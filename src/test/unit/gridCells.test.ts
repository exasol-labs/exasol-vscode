import * as assert from 'assert';
import {
    isNumericColumn,
    getColumnBaseType,
    compareRows,
    buildDisplayCell,
    type GridColumnMetadata,
    type GridRowValue,
} from '../../webview/gridCells';

const meta = (overrides: Partial<GridColumnMetadata> & { name: string; type: string }): GridColumnMetadata => ({
    ...overrides,
});

const NUMERIC_META: GridColumnMetadata[] = [meta({ name: 'AMOUNT', type: 'DECIMAL' })];
const DATE_META: GridColumnMetadata[] = [meta({ name: 'D', type: 'DATE' })];
const TS_META: GridColumnMetadata[] = [meta({ name: 'TS', type: 'TIMESTAMP' })];
const BOOL_META: GridColumnMetadata[] = [meta({ name: 'FLAG', type: 'BOOLEAN' })];
const TEXT_META: GridColumnMetadata[] = [meta({ name: 'NAME', type: 'VARCHAR' })];

suite('gridCells column type detection', () => {
    test('isNumericColumn matches numeric SQL types', () => {
        assert.strictEqual(isNumericColumn('AMOUNT', NUMERIC_META), true);
        assert.strictEqual(isNumericColumn('NAME', TEXT_META), false);
    });

    test('isNumericColumn is false for unknown column', () => {
        assert.strictEqual(isNumericColumn('MISSING', NUMERIC_META), false);
    });

    test('getColumnBaseType returns raw type or empty', () => {
        assert.strictEqual(getColumnBaseType('D', DATE_META), 'DATE');
        assert.strictEqual(getColumnBaseType('MISSING', DATE_META), '');
    });
});

suite('gridCells compareRows', () => {
    test('sorts numerically when both values are numeric', () => {
        const rows: GridRowValue[] = [{ N: '10' }, { N: '2' }, { N: '1' }];
        const sorted = [...rows].sort((a, b) => compareRows(a, b, 'N', 'asc'));
        assert.deepStrictEqual(sorted.map(r => r.N), ['1', '2', '10']);
    });

    test('sorts descending', () => {
        const rows: GridRowValue[] = [{ N: '1' }, { N: '10' }, { N: '2' }];
        const sorted = [...rows].sort((a, b) => compareRows(a, b, 'N', 'desc'));
        assert.deepStrictEqual(sorted.map(r => r.N), ['10', '2', '1']);
    });

    test('sorts text case-insensitively', () => {
        const rows: GridRowValue[] = [{ S: 'banana' }, { S: 'Apple' }, { S: 'cherry' }];
        const sorted = [...rows].sort((a, b) => compareRows(a, b, 'S', 'asc'));
        assert.deepStrictEqual(sorted.map(r => r.S), ['Apple', 'banana', 'cherry']);
    });

    test('treats null/undefined as empty string', () => {
        const rows: GridRowValue[] = [{ S: 'b' }, { S: null }, { S: 'a' }];
        const sorted = [...rows].sort((a, b) => compareRows(a, b, 'S', 'asc'));
        assert.deepStrictEqual(sorted.map(r => r.S), [null, 'a', 'b']);
    });
});

suite('gridCells buildDisplayCell raw-copy fidelity', () => {
    test('null renders dimmed empty-copy text cell', () => {
        const cell = buildDisplayCell(null, 'NAME', TEXT_META, '#999');
        assert.strictEqual(cell.kind, 'text');
        if (cell.kind === 'text') {
            assert.strictEqual(cell.copyData, '');
            assert.strictEqual(cell.allowOverlay, false);
        }
    });

    test('numeric cell copies the raw unformatted string, displays grouped', () => {
        const cell = buildDisplayCell('1234567.8901234567', 'AMOUNT', NUMERIC_META, '#999');
        assert.strictEqual(cell.kind, 'number');
        if (cell.kind === 'number') {
            assert.strictEqual(cell.displayData, '1,234,567.8901234567');
            assert.strictEqual(cell.copyData, '1234567.8901234567');
            assert.strictEqual(cell.contentAlign, 'left');
        }
    });

    test('timestamp cell copies the raw value, not the formatted display', () => {
        const cell = buildDisplayCell('2024-01-02 03:04:05.123', 'TS', TS_META, '#999');
        assert.strictEqual(cell.kind, 'text');
        if (cell.kind === 'text') {
            assert.strictEqual(cell.displayData, '2024-01-02 03:04:05');
            assert.strictEqual(cell.copyData, '2024-01-02 03:04:05.123');
            assert.strictEqual(cell.data, '2024-01-02 03:04:05.123');
        }
    });

    test('date cell drops time in display but copies raw', () => {
        const cell = buildDisplayCell('2024-01-02 03:04:05', 'D', DATE_META, '#999');
        assert.strictEqual(cell.kind, 'text');
        if (cell.kind === 'text') {
            assert.strictEqual(cell.displayData, '2024-01-02');
            assert.strictEqual(cell.copyData, '2024-01-02 03:04:05');
        }
    });

    test('boolean cell renders readonly check', () => {
        const cell = buildDisplayCell('true', 'FLAG', BOOL_META, '#999');
        assert.strictEqual(cell.kind, 'boolean');
        if (cell.kind === 'boolean') {
            assert.strictEqual(cell.data, true);
            assert.strictEqual(cell.readonly, true);
        }
    });

    test('plain text cell keeps data and copyData identical to raw', () => {
        const cell = buildDisplayCell('hello', 'NAME', TEXT_META, '#999');
        assert.strictEqual(cell.kind, 'text');
        if (cell.kind === 'text') {
            assert.strictEqual(cell.data, 'hello');
            assert.strictEqual(cell.copyData, 'hello');
            assert.strictEqual(cell.allowOverlay, true);
        }
    });

    test('numeric column with non-numeric value falls back to text', () => {
        const cell = buildDisplayCell('N/A', 'AMOUNT', NUMERIC_META, '#999');
        assert.strictEqual(cell.kind, 'text');
    });
});
