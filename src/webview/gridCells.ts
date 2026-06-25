/**
 * Pure, DOM-free cell helpers shared by the notebook result renderer.
 *
 * Builds type-aware glide cells whose on-screen text is formatted (grouped numbers, trimmed
 * dates) while the clipboard payload stays raw. Sorting and column-type detection mirror the
 * results panel so both surfaces order and classify values identically.
 */
import { GridCellKind, type GridCell } from '@glideapps/glide-data-grid';
import {
    isDateType,
    isTimestampType,
    isBooleanType,
    formatNumericDisplay,
    formatDateDisplay,
    parseBoolean,
    type RawCellValue,
} from './cellFormat';

export type GridRowValue = Record<string, RawCellValue>;

export interface GridColumnMetadata {
    name: string;
    type: string;
    precision?: number;
    scale?: number;
    size?: number;
}

const NUMERIC_TYPE_RE = /^(DECIMAL|NUMERIC|NUMBER|INT|INTEGER|BIGINT|SMALLINT|TINYINT|DOUBLE|FLOAT|REAL)/i;
const VALUE_NUMERIC_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

export const NULL_DISPLAY = '(null)';

export const getColumnBaseType = (columnName: string, metadata: readonly GridColumnMetadata[]): string =>
    metadata.find(col => col.name === columnName)?.type ?? '';

export const isNumericColumn = (columnName: string, metadata: readonly GridColumnMetadata[]): boolean => {
    const colMeta = metadata.find(col => col.name === columnName);
    return colMeta !== undefined && NUMERIC_TYPE_RE.test(colMeta.type);
};

const isNumericValue = (value: RawCellValue): boolean =>
    typeof value === 'number' || (typeof value === 'string' && VALUE_NUMERIC_RE.test(value));

export const compareRows = (
    a: GridRowValue,
    b: GridRowValue,
    column: string,
    direction: 'asc' | 'desc'
): number => {
    let aVal: RawCellValue = a[column];
    let bVal: RawCellValue = b[column];
    if (aVal === null || aVal === undefined) {
        aVal = '';
    }
    if (bVal === null || bVal === undefined) {
        bVal = '';
    }
    const aNum = isNumericValue(aVal) ? Number(aVal) : NaN;
    const bNum = isNumericValue(bVal) ? Number(bVal) : NaN;
    if (!isNaN(aNum) && !isNaN(bNum)) {
        return direction === 'asc' ? aNum - bNum : bNum - aNum;
    }
    const aStr = String(aVal).toLowerCase();
    const bStr = String(bVal).toLowerCase();
    if (direction === 'asc') {
        return aStr < bStr ? -1 : aStr > bStr ? 1 : 0;
    }
    return bStr < aStr ? -1 : bStr > aStr ? 1 : 0;
};

const rawString = (value: RawCellValue): string =>
    value === null || value === undefined ? '' : String(value);

/**
 * Builds a readonly glide cell for one result value.
 *
 * Display text is type-formatted, but every cell carries `copyData` set to the unmodified raw
 * value so glide's built-in copy reproduces the source data rather than the formatted text.
 */
export const buildDisplayCell = (
    value: RawCellValue,
    columnName: string,
    metadata: readonly GridColumnMetadata[],
    nullTextColor: string
): GridCell => {
    if (value === null || value === undefined) {
        return {
            kind: GridCellKind.Text,
            data: '',
            displayData: NULL_DISPLAY,
            copyData: '',
            allowOverlay: false,
            readonly: true,
            themeOverride: { textDark: nullTextColor },
        };
    }

    const raw = rawString(value);

    if (isNumericColumn(columnName, metadata)) {
        const num = Number(value);
        if (!isNaN(num)) {
            return {
                kind: GridCellKind.Number,
                data: num,
                displayData: formatNumericDisplay(value),
                copyData: raw,
                contentAlign: 'left',
                allowOverlay: false,
                readonly: true,
            };
        }
    }

    const baseType = getColumnBaseType(columnName, metadata);

    if (isBooleanType(baseType)) {
        const parsed = parseBoolean(value);
        if (parsed !== undefined) {
            return {
                kind: GridCellKind.Boolean,
                data: parsed,
                copyData: raw,
                readonly: true,
                allowOverlay: false,
            };
        }
    }

    let display: string;
    if (isTimestampType(baseType)) {
        display = formatDateDisplay(value, true);
    } else if (isDateType(baseType)) {
        display = formatDateDisplay(value, false);
    } else {
        display = raw;
    }

    return {
        kind: GridCellKind.Text,
        data: raw,
        displayData: display,
        copyData: raw,
        allowOverlay: true,
        readonly: true,
    };
};
