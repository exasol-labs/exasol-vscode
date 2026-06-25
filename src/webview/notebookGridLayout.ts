/**
 * Pure layout math for the notebook result grid.
 *
 * Notebook outputs must stay compact: the grid shows a bounded number of rows inline and lets
 * glide scroll the rest internally, so a large result never produces a runaway output cell.
 */
export const HEADER_HEIGHT = 28;
export const ROW_HEIGHT = 28;
export const MAX_VISIBLE_ROWS = 20;
export const MAX_GRID_HEIGHT = 560;

/**
 * Returns the pixel height for the grid given a row count.
 *
 * Sizes to the header plus up to MAX_VISIBLE_ROWS data rows and a trailing row of breathing room,
 * then clamps to MAX_GRID_HEIGHT. Rows beyond the cap scroll inside glide.
 */
export const computeGridHeight = (rowCount: number): number => {
    const visibleRows = Math.min(Math.max(rowCount, 0), MAX_VISIBLE_ROWS);
    const height = HEADER_HEIGHT + visibleRows * ROW_HEIGHT + ROW_HEIGHT;
    return Math.min(height, MAX_GRID_HEIGHT);
};
