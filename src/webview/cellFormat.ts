/**
 * Pure, side-effect-free display formatters for the results grid.
 *
 * These shape only the on-screen text of a cell. Raw values must continue to flow untouched
 * through copy and export, so callers format for display while keeping the original value for
 * data. Every formatter falls back to the raw string when a value does not match its declared
 * type, and none of them throws.
 */
export type RawCellValue = string | number | boolean | null | undefined;

const PLAIN_NUMERIC_RE = /^-?\d+(?:\.\d+)?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/;
const URL_RE = /^https?:\/\/\S+$/;
const TRUE_TOKENS = new Set(['true', 't', '1', 'yes', 'y']);

const baseType = (type: string): string => type.trim().toUpperCase();

export const isDateType = (type: string): boolean => baseType(type).startsWith('DATE');

export const isTimestampType = (type: string): boolean => baseType(type).startsWith('TIMESTAMP');

export const isBooleanType = (type: string): boolean => baseType(type).startsWith('BOOL');

const groupIntegerPart = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export const formatNumericDisplay = (value: RawCellValue): string => {
    const raw = String(value);
    if (!PLAIN_NUMERIC_RE.test(raw)) {
        return raw;
    }
    const negative = raw.startsWith('-');
    const unsigned = negative ? raw.slice(1) : raw;
    const dot = unsigned.indexOf('.');
    const intPart = dot === -1 ? unsigned : unsigned.slice(0, dot);
    const fracPart = dot === -1 ? '' : unsigned.slice(dot);
    const grouped = groupIntegerPart(intPart) + fracPart;
    return negative ? `-${grouped}` : grouped;
};

export const formatDateDisplay = (value: RawCellValue, withTime: boolean): string => {
    const raw = String(value);
    const match = DATE_RE.exec(raw);
    if (!match) {
        return raw;
    }
    const [, year, month, day, hour, minute, second] = match;
    const datePart = `${year}-${month}-${day}`;
    if (withTime && hour !== undefined) {
        return `${datePart} ${hour}:${minute}:${second}`;
    }
    return datePart;
};

/**
 * Coerces a raw cell value to a boolean for checkmark rendering.
 *
 * Returns true for real boolean true or the truthy tokens t/true/1/y/yes (case-insensitive,
 * trimmed), false for any other defined value, and undefined for null/undefined so callers can
 * route those through the dedicated null branch.
 */
export const parseBoolean = (value: RawCellValue): boolean | undefined => {
    if (value === null || value === undefined) {
        return undefined;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    return TRUE_TOKENS.has(String(value).trim().toLowerCase());
};

/** Reports whether a raw cell value is a trimmed http or https URL with no embedded whitespace. */
export const isUrlValue = (value: RawCellValue): boolean =>
    typeof value === 'string' && URL_RE.test(value.trim());

export const MIN_ESTIMATED_COLUMN_WIDTH = 64;
export const MAX_ESTIMATED_COLUMN_WIDTH = 400;
const CHAR_PIXEL_WIDTH = 8;
const COLUMN_WIDTH_PADDING = 24;

/**
 * Estimates a column width in pixels from its header and a sample of displayed values.
 *
 * Picks the longest character count among the header and the supplied sample strings, scales by an
 * average glyph width, adds horizontal padding, and clamps the result to the estimated min/max so
 * short columns start tight and wide columns stay bounded.
 */
export const estimateColumnWidth = (headerText: string, sampleValues: readonly string[]): number => {
    let maxChars = headerText.length;
    for (const value of sampleValues) {
        if (value.length > maxChars) {
            maxChars = value.length;
        }
    }
    const estimated = Math.ceil(maxChars * CHAR_PIXEL_WIDTH) + COLUMN_WIDTH_PADDING;
    return Math.min(MAX_ESTIMATED_COLUMN_WIDTH, Math.max(MIN_ESTIMATED_COLUMN_WIDTH, estimated));
};
