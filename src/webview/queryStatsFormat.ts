/**
 * Pure, side-effect-free formatters for the results grid's query-statistics panel.
 *
 * No DOM or React imports: these shape only the displayed text and are unit-testable in
 * isolation. They mirror the formatting the standalone Query Info view used to perform.
 */
const QUERY_PREVIEW_MAX_LENGTH = 300;

export const getQueryPreview = (query: string): string => {
    const cleaned = query.replace(/\s+/g, ' ').trim();
    if (cleaned.length <= QUERY_PREVIEW_MAX_LENGTH) {
        return cleaned;
    }
    return cleaned.substring(0, QUERY_PREVIEW_MAX_LENGTH) + '...';
};

export const formatTime = (ms: number): string => {
    if (ms < 1000) {
        return `${ms}ms`;
    }
    const seconds = ms / 1000;
    if (seconds < 60) {
        return `${seconds.toFixed(2)}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = (seconds % 60).toFixed(0);
    return `${minutes}m ${remainingSeconds}s`;
};

export const formatTimestamp = (isoTimestamp: string): string => {
    const date = new Date(isoTimestamp);
    if (isNaN(date.getTime())) {
        return '';
    }
    return date.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
};

export const calculateThroughput = (executionTime: number, rowCount: number): string => {
    if (executionTime === 0 || rowCount === 0) {
        return 'N/A';
    }
    const rowsPerSecond = (rowCount / executionTime) * 1000;
    if (rowsPerSecond < 1) {
        return '< 1 row/s';
    }
    if (rowsPerSecond >= 1000) {
        return `${(rowsPerSecond / 1000).toFixed(1)}K row/s`;
    }
    return `${Math.round(rowsPerSecond)} row/s`;
};

export const calculateAvgRowTime = (executionTime: number, rowCount: number): string => {
    if (rowCount === 0) {
        return 'N/A';
    }
    const msPerRow = executionTime / rowCount;
    if (msPerRow < 0.01) {
        return '< 0.01ms';
    }
    if (msPerRow < 1) {
        return `${msPerRow.toFixed(2)}ms`;
    }
    return `${msPerRow.toFixed(1)}ms`;
};
