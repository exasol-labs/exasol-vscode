/**
 * Canvas-based results grid for the Exasol query results panel.
 *
 * Reads the result-data, render-state, saved-tab-state and query-stats JSON data islands
 * emitted by ResultsPanel and renders a glide DataEditor. Replicates the sorting, filtering,
 * cell selection and copy behaviour of the previous DOM table, adds column freezing (pin),
 * and docks a query-info panel (cell inspector + query statistics) at the grid's right edge.
 */
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import {
    DataEditor,
    GridCellKind,
    CompactSelection,
    type DataEditorRef,
    type GridCell,
    type GridColumn,
    type GridSelection,
    type Item,
    type Rectangle,
    type Theme,
    type CellClickedEventArgs,
    type HeaderClickedEventArgs,
    type GridMouseEventArgs,
} from '@glideapps/glide-data-grid';
import {
    isDateType,
    isTimestampType,
    isBooleanType,
    formatNumericDisplay,
    formatDateDisplay,
    parseBoolean,
    isUrlValue,
    estimateColumnWidth,
    MIN_ESTIMATED_COLUMN_WIDTH,
    MAX_ESTIMATED_COLUMN_WIDTH,
} from './cellFormat';
import {
    getQueryPreview,
    formatTime,
    formatTimestamp,
    calculateThroughput,
    calculateAvgRowTime,
} from './queryStatsFormat';

type CellValue = string | number | boolean | null | undefined;
type ResultRow = Record<string, CellValue>;

interface ColumnMetadata {
    name: string;
    type: string;
    precision?: number;
    scale?: number;
    size?: number;
}

interface ResultData {
    columns: string[];
    columnMetadata: ColumnMetadata[];
    rows: ResultRow[];
}

interface RenderState {
    filterId: string;
    initialSortColumn: string | null;
    initialSortDirection: 'asc' | 'desc';
}

interface SavedTabState {
    sortColumn: string | null;
    sortDirection: 'asc' | 'desc' | null;
    filterText: string;
    scrollPosition: number;
}

interface QueryStats {
    query: string;
    executionTime: number;
    rowCount: number;
    columnCount: number;
    timestamp: string;
}

interface SelectedCell {
    column: string;
    type: string;
    value: CellValue;
}

interface VsCodeApi {
    postMessage(message: unknown): void;
}

declare global {
    interface Window {
        __vscode?: VsCodeApi;
        acquireVsCodeApi?: () => VsCodeApi;
    }
}

const DEFAULT_COLUMN_WIDTH = 150;
const QUERY_INFO_DEFAULT_WIDTH = 240;
const QUERY_INFO_MIN_WIDTH = 160;
const QUERY_INFO_MAX_WIDTH = 600;
const NULL_DISPLAY = '(null)';
const NUMERIC_TYPE_RE = /^(DECIMAL|NUMERIC|NUMBER|INT|INTEGER|BIGINT|SMALLINT|TINYINT|DOUBLE|FLOAT|REAL)/i;

const acquireVsCode = (): VsCodeApi => {
    if (window.__vscode) {
        return window.__vscode;
    }
    const api = window.acquireVsCodeApi!();
    window.__vscode = api;
    return api;
};

const readIsland = <T,>(id: string): T | null => {
    const el = document.getElementById(id);
    if (!el || !el.textContent) {
        return null;
    }
    return JSON.parse(el.textContent) as T;
};

const cssVar = (name: string, fallback: string): string => {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
};

const buildTheme = (): Partial<Theme> => {
    const background = cssVar('--vscode-editor-background', '#1e1e1e');
    const foreground = cssVar('--vscode-foreground', '#cccccc');
    const border = cssVar('--vscode-panel-border', 'rgba(128,128,128,0.35)');
    const selection = cssVar('--vscode-editor-selectionBackground', 'rgba(38,79,120,0.4)');
    const accent = cssVar('--vscode-focusBorder', '#007fd4');
    const headerBackground = cssVar('--vscode-sideBarSectionHeader-background', background);
    const fontFamily = cssVar('--vscode-editor-font-family', 'monospace');
    const fontSize = cssVar('--vscode-editor-font-size', '13px');
    const description = cssVar('--vscode-descriptionForeground', '#999999');

    return {
        accentColor: accent,
        accentFg: foreground,
        accentLight: selection,
        textDark: foreground,
        textMedium: foreground,
        textLight: description,
        textBubble: foreground,
        bgIconHeader: headerBackground,
        fgIconHeader: foreground,
        textHeader: foreground,
        textHeaderSelected: foreground,
        bgCell: background,
        bgCellMedium: background,
        bgHeader: headerBackground,
        bgHeaderHasFocus: headerBackground,
        bgHeaderHovered: cssVar('--vscode-list-hoverBackground', headerBackground),
        borderColor: border,
        horizontalBorderColor: border,
        drilldownBorder: border,
        baseFontStyle: fontSize,
        headerFontStyle: `600 ${fontSize}`,
        fontFamily,
        editorFontSize: fontSize,
    };
};

const getColumnType = (columnName: string, metadata: ColumnMetadata[]): string => {
    const colMeta = metadata.find(col => col.name === columnName);
    if (!colMeta) {
        return 'VARCHAR';
    }
    let type = colMeta.type;
    if (colMeta.precision !== undefined && colMeta.scale !== undefined) {
        type += `(${colMeta.precision},${colMeta.scale})`;
    } else if (colMeta.size !== undefined) {
        type += `(${colMeta.size})`;
    } else if (colMeta.precision !== undefined) {
        type += `(${colMeta.precision})`;
    }
    return type;
};

const isNumericColumn = (columnName: string, metadata: ColumnMetadata[]): boolean => {
    const colMeta = metadata.find(col => col.name === columnName);
    return colMeta !== undefined && NUMERIC_TYPE_RE.test(colMeta.type);
};

const getColumnBaseType = (columnName: string, metadata: ColumnMetadata[]): string =>
    metadata.find(col => col.name === columnName)?.type ?? '';

const cellDisplayString = (value: CellValue, columnName: string, metadata: ColumnMetadata[]): string => {
    if (value === null || value === undefined) {
        return NULL_DISPLAY;
    }
    if (isNumericColumn(columnName, metadata) && !isNaN(Number(value))) {
        return formatNumericDisplay(value);
    }
    const baseType = getColumnBaseType(columnName, metadata);
    if (isTimestampType(baseType)) {
        return formatDateDisplay(value, true);
    }
    if (isDateType(baseType)) {
        return formatDateDisplay(value, false);
    }
    return String(value);
};

const WIDTH_SAMPLE_ROW_LIMIT = 200;

const cellTextForFilter = (value: CellValue): string =>
    value === null || value === undefined ? '' : String(value);

const VALUE_NUMERIC_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

const isNumericValue = (value: CellValue): boolean =>
    typeof value === 'number' || (typeof value === 'string' && VALUE_NUMERIC_RE.test(value));

const compareRows = (a: ResultRow, b: ResultRow, column: string, direction: 'asc' | 'desc'): number => {
    let aVal: CellValue = a[column];
    let bVal: CellValue = b[column];
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

const csvQuote = (value: string): string =>
    value.includes(',') || value.includes('"') || value.includes('\n')
        ? `"${value.replace(/"/g, '""')}"`
        : value;

interface ContextMenuState {
    x: number;
    y: number;
}

interface HeaderMenuState {
    x: number;
    y: number;
    colIndex: number;
}

const COPY_ACTIONS: { label: string; format: 'plain' | 'csv'; headers: boolean }[] = [
    { label: 'Copy', format: 'plain', headers: false },
    { label: 'Copy with Headers', format: 'plain', headers: true },
    { label: 'Copy as CSV', format: 'csv', headers: false },
    { label: 'Copy as CSV with Headers', format: 'csv', headers: true },
];

const CopyMenuItems: React.FC<{
    onCopy: (format: 'plain' | 'csv', includeHeaders: boolean) => void;
    onSelect: () => void;
}> = ({ onCopy, onSelect }) => (
    <>
        {COPY_ACTIONS.map(action => (
            <li
                key={action.label}
                className="grid-context-menu-item"
                onClick={() => {
                    onCopy(action.format, action.headers);
                    onSelect();
                }}
            >
                {action.label}
            </li>
        ))}
    </>
);

const usePortal = (): HTMLElement | null => {
    const [portal, setPortal] = React.useState<HTMLElement | null>(null);
    React.useEffect(() => {
        const el = document.createElement('div');
        el.id = 'portal';
        el.style.cssText = 'position:fixed;left:0;top:0;z-index:9999';
        document.body.appendChild(el);
        setPortal(el);
        return () => {
            document.body.removeChild(el);
        };
    }, []);
    return portal;
};

const useTheme = (): Partial<Theme> => {
    const [theme, setTheme] = React.useState<Partial<Theme>>(() => buildTheme());
    React.useEffect(() => {
        const observer = new MutationObserver(() => setTheme(buildTheme()));
        observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
        return () => observer.disconnect();
    }, []);
    return theme;
};

const useContainerSize = (ref: React.RefObject<HTMLDivElement | null>): { width: number; height: number } => {
    const [size, setSize] = React.useState({ width: 0, height: 0 });
    React.useEffect(() => {
        const node = ref.current;
        if (!node) {
            return;
        }
        const observer = new ResizeObserver(entries => {
            const rect = entries[0].contentRect;
            setSize({ width: rect.width, height: rect.height });
        });
        observer.observe(node);
        return () => observer.disconnect();
    }, [ref]);
    return size;
};

interface StatsPanelProps {
    stats: QueryStats;
    selectedCell: SelectedCell | null;
    collapsed: boolean;
    onToggle: () => void;
    vscode: VsCodeApi;
}

const StatRow: React.FC<{ label: string; value: string; valueClass?: string; title?: string }> = ({
    label,
    value,
    valueClass,
    title,
}) => (
    <div className="stat-item">
        <span className="stat-label">{label}</span>
        <span className={valueClass ? `stat-value ${valueClass}` : 'stat-value'} title={title}>
            {value}
        </span>
    </div>
);

const CellInspector: React.FC<{ selectedCell: SelectedCell | null; vscode: VsCodeApi }> = ({
    selectedCell,
    vscode,
}) => {
    if (!selectedCell) {
        return <div className="inspector-placeholder">Click a cell to inspect its value</div>;
    }
    const { column, type, value } = selectedCell;
    const isNull = value === null || value === undefined || value === '';
    const isUrl = isUrlValue(value);
    const onCopy = (event: React.MouseEvent) => {
        event.stopPropagation();
        if (isNull) {
            return;
        }
        vscode.postMessage({ command: 'copy', text: String(value) });
    };
    const onOpen = (event: React.MouseEvent) => {
        event.stopPropagation();
        vscode.postMessage({ command: 'openExternal', url: String(value).trim() });
    };
    return (
        <>
            <div className="inspector-header">
                <span className="inspector-column">{column}</span>
                <span className="inspector-type">{type}</span>
            </div>
            <div className="inspector-value">
                {isNull ? <span className="inspector-null">(null)</span> : String(value)}
            </div>
            {!isNull && (
                <div className="inspector-actions">
                    <button
                        className="inspector-copy"
                        onClick={onCopy}
                        title="Copy cell value"
                        aria-label="Copy cell value"
                    >
                        Copy
                    </button>
                    {isUrl && (
                        <button
                            className="inspector-open"
                            onClick={onOpen}
                            title="Open URL in browser"
                            aria-label="Open URL in browser"
                        >
                            Open URL
                        </button>
                    )}
                </div>
            )}
        </>
    );
};

const StatsPanel: React.FC<StatsPanelProps> = ({ stats, selectedCell, collapsed, onToggle, vscode }) => {
    const [widthPx, setWidthPx] = React.useState(QUERY_INFO_DEFAULT_WIDTH);
    const detachRef = React.useRef<(() => void) | null>(null);

    React.useEffect(() => () => detachRef.current?.(), []);

    const onResizeStart = React.useCallback(
        (event: React.MouseEvent) => {
            event.preventDefault();
            const startX = event.clientX;
            const startWidth = widthPx;
            const onMove = (moveEvent: MouseEvent) => {
                const newWidth = startWidth + (startX - moveEvent.clientX);
                setWidthPx(Math.min(QUERY_INFO_MAX_WIDTH, Math.max(QUERY_INFO_MIN_WIDTH, newWidth)));
            };
            const detach = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', detach);
                detachRef.current = null;
            };
            detachRef.current = detach;
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', detach);
        },
        [widthPx]
    );

    return (
    <div
        className={collapsed ? 'query-info collapsed' : 'query-info'}
        style={{ width: collapsed ? undefined : widthPx }}
    >
        {!collapsed && (
            <div
                className="query-info-resizer"
                onMouseDown={onResizeStart}
                title="Drag to resize"
                aria-hidden="true"
            />
        )}
        <button
            className="query-info-toggle"
            onClick={onToggle}
            title={collapsed ? 'Show query info' : 'Hide query info'}
            aria-label={collapsed ? 'Show query info' : 'Hide query info'}
        >
            {collapsed ? '◀' : '▶'}
        </button>
        {!collapsed && (
            <div className="query-info-body">
                <div className="section-header">Cell Value</div>
                <div className="cell-inspector">
                    <CellInspector selectedCell={selectedCell} vscode={vscode} />
                </div>

                <div className="section-header">Query Statistics</div>
                <div className="stat-group">
                    <StatRow label="Time" value={formatTime(stats.executionTime)} valueClass="highlight" />
                    <StatRow label="Rows" value={stats.rowCount.toLocaleString()} valueClass="success" />
                    <StatRow label="Cols" value={String(stats.columnCount)} />
                </div>

                <div className="stat-group">
                    <StatRow label="Throughput" value={calculateThroughput(stats.executionTime, stats.rowCount)} />
                    <StatRow label="Avg/Row" value={calculateAvgRowTime(stats.executionTime, stats.rowCount)} />
                </div>

                {stats.query && (
                    <div className="stat-group">
                        <div className="stat-label query-label">Query</div>
                        <div className="query-preview" title={stats.query}>
                            {getQueryPreview(stats.query)}
                        </div>
                    </div>
                )}

                <div className="timestamp">{formatTimestamp(stats.timestamp)}</div>
            </div>
        )}
    </div>
    );
};

interface GridProps {
    data: ResultData;
    renderState: RenderState;
    savedTabState: SavedTabState | null;
    queryStats: QueryStats | null;
    vscode: VsCodeApi;
}

const ResultsGrid: React.FC<GridProps> = ({ data, renderState, savedTabState, queryStats, vscode }) => {
    const { columns: columnNames, columnMetadata } = data;
    const portal = usePortal();
    const theme = useTheme();
    const containerRef = React.useRef<HTMLDivElement>(null);
    const { width, height } = useContainerSize(containerRef);
    const gridRef = React.useRef<DataEditorRef>(null);

    const [filterText, setFilterText] = React.useState(savedTabState?.filterText ?? '');
    const [sortColumn, setSortColumn] = React.useState<string | null>(
        savedTabState?.sortColumn ?? renderState.initialSortColumn ?? null
    );
    const [sortDirection, setSortDirection] = React.useState<'asc' | 'desc'>(
        savedTabState?.sortDirection ?? renderState.initialSortDirection ?? 'asc'
    );
    const [columnWidths, setColumnWidths] = React.useState<Record<string, number>>({});
    const [columnOrder, setColumnOrder] = React.useState<string[]>(() => [...columnNames]);
    const [freezeColumns, setFreezeColumns] = React.useState(0);
    const [hoverRow, setHoverRow] = React.useState<number | undefined>(undefined);
    const [selection, setSelection] = React.useState<GridSelection>({
        current: undefined,
        rows: CompactSelection.empty(),
        columns: CompactSelection.empty(),
    });
    const [contextMenu, setContextMenu] = React.useState<ContextMenuState | null>(null);
    const [headerMenu, setHeaderMenu] = React.useState<HeaderMenuState | null>(null);
    const [topRow, setTopRow] = React.useState(0);
    const [selectedCell, setSelectedCell] = React.useState<SelectedCell | null>(null);
    const [statsCollapsed, setStatsCollapsed] = React.useState(false);

    const rows = React.useMemo<ResultRow[]>(() => {
        const term = filterText.toLowerCase();
        const filtered = term
            ? data.rows.filter(row =>
                  columnNames.some(col => cellTextForFilter(row[col]).toLowerCase().includes(term))
              )
            : data.rows;
        if (!sortColumn) {
            return filtered;
        }
        return [...filtered].sort((a, b) => compareRows(a, b, sortColumn, sortDirection));
    }, [data.rows, columnNames, filterText, sortColumn, sortDirection]);

    const orderedColumnNames = React.useMemo<string[]>(() => {
        const known = new Set(columnNames);
        const ordered = columnOrder.filter(name => known.has(name));
        const seen = new Set(ordered);
        for (const name of columnNames) {
            if (!seen.has(name)) {
                ordered.push(name);
            }
        }
        return ordered;
    }, [columnNames, columnOrder]);

    const estimatedColumnWidths = React.useMemo<Record<string, number>>(() => {
        const sample = data.rows.slice(0, WIDTH_SAMPLE_ROW_LIMIT);
        const widths: Record<string, number> = {};
        for (const name of orderedColumnNames) {
            const samples = sample.map(row => cellDisplayString(row[name], name, columnMetadata));
            widths[name] = estimateColumnWidth(name, samples);
        }
        return widths;
    }, [data.rows, orderedColumnNames, columnMetadata]);

    const columns = React.useMemo<GridColumn[]>(
        () =>
            orderedColumnNames.map(name => {
                const sorted = name === sortColumn;
                return {
                    title: sorted ? `${name} ${sortDirection === 'asc' ? '▲' : '▼'}` : name,
                    id: name,
                    width: columnWidths[name] ?? estimatedColumnWidths[name] ?? DEFAULT_COLUMN_WIDTH,
                    hasMenu: false,
                };
            }),
        [orderedColumnNames, columnWidths, estimatedColumnWidths, sortColumn, sortDirection]
    );

    const nullTextColor = React.useMemo(
        () => cssVar('--vscode-descriptionForeground', theme.textLight ?? '#999999'),
        [theme]
    );

    const getCellContent = React.useCallback(
        (cell: Item): GridCell => {
            const [col, row] = cell;
            const columnName = orderedColumnNames[col];
            const value = rows[row]?.[columnName];
            if (value === null || value === undefined) {
                return {
                    kind: GridCellKind.Text,
                    data: NULL_DISPLAY,
                    displayData: NULL_DISPLAY,
                    allowOverlay: false,
                    themeOverride: { textDark: nullTextColor },
                };
            }
            const baseType = getColumnBaseType(columnName, columnMetadata);
            if (isNumericColumn(columnName, columnMetadata)) {
                const num = Number(value);
                if (!isNaN(num)) {
                    return {
                        kind: GridCellKind.Number,
                        data: num,
                        displayData: formatNumericDisplay(value),
                        contentAlign: 'left',
                        allowOverlay: false,
                        readonly: true,
                    };
                }
            }
            if (isBooleanType(baseType)) {
                const parsed = parseBoolean(value);
                if (parsed !== undefined) {
                    return {
                        kind: GridCellKind.Boolean,
                        data: parsed,
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
                display = String(value);
            }
            return {
                kind: GridCellKind.Text,
                data: display,
                displayData: display,
                allowOverlay: true,
                readonly: true,
            };
        },
        [rows, orderedColumnNames, columnMetadata, nullTextColor]
    );

    const getCellsForSelection = React.useCallback(
        (rect: Rectangle): readonly (readonly GridCell[])[] => {
            const result: GridCell[][] = [];
            for (let row = rect.y; row < rect.y + rect.height; row++) {
                const rowCells: GridCell[] = [];
                for (let col = rect.x; col < rect.x + rect.width; col++) {
                    rowCells.push(getCellContent([col, row]));
                }
                result.push(rowCells);
            }
            return result;
        },
        [getCellContent]
    );

    const onColumnResize = React.useCallback((column: GridColumn, newSize: number) => {
        if (!column.id) {
            return;
        }
        const clampedWidth = Math.min(
            MAX_ESTIMATED_COLUMN_WIDTH,
            Math.max(MIN_ESTIMATED_COLUMN_WIDTH, newSize)
        );
        setColumnWidths(prev => ({ ...prev, [column.id as string]: clampedWidth }));
    }, []);

    const onHeaderClicked = React.useCallback(
        (colIndex: number) => {
            const columnName = orderedColumnNames[colIndex];
            setSortDirection(prev => (sortColumn === columnName && prev === 'asc' ? 'desc' : 'asc'));
            setSortColumn(columnName);
        },
        [orderedColumnNames, sortColumn]
    );

    const onColumnMoved = React.useCallback(
        (startIndex: number, endIndex: number) => {
            if (
                startIndex < 0 ||
                startIndex >= orderedColumnNames.length ||
                endIndex < 0 ||
                endIndex >= orderedColumnNames.length ||
                startIndex === endIndex
            ) {
                return;
            }
            const next = [...orderedColumnNames];
            const [moved] = next.splice(startIndex, 1);
            next.splice(endIndex, 0, moved);
            setColumnOrder(next);
        },
        [orderedColumnNames]
    );

    const onHeaderContextMenu = React.useCallback((colIndex: number, event: HeaderClickedEventArgs) => {
        event.preventDefault();
        setContextMenu(null);
        setHeaderMenu({
            x: event.bounds.x + event.localEventX,
            y: event.bounds.y + event.localEventY,
            colIndex,
        });
    }, []);

    const onCellClicked = React.useCallback(
        (cell: Item) => {
            const [col, row] = cell;
            const columnName = orderedColumnNames[col];
            const value = rows[row]?.[columnName];
            setSelectedCell({
                column: columnName,
                type: getColumnType(columnName, columnMetadata),
                value,
            });
        },
        [orderedColumnNames, columnMetadata, rows]
    );

    const copySelection = React.useCallback(
        (format: 'plain' | 'csv', includeHeaders: boolean) => {
            const separator = format === 'csv' ? ',' : '\t';
            const lines: string[] = [];
            const range = selection.current?.range;
            let selectedColumns: string[];
            let rowIndices: number[];
            if (range) {
                selectedColumns = orderedColumnNames.slice(range.x, range.x + range.width);
                rowIndices = [];
                for (let row = range.y; row < range.y + range.height; row++) {
                    rowIndices.push(row);
                }
            } else {
                const selectedColumnIndices = selection.columns.toArray();
                const selectedRowIndices = selection.rows.toArray();
                if (selectedColumnIndices.length === 0 && selectedRowIndices.length === 0) {
                    return;
                }
                selectedColumns =
                    selectedColumnIndices.length > 0
                        ? selectedColumnIndices.map(col => orderedColumnNames[col])
                        : orderedColumnNames;
                rowIndices =
                    selectedRowIndices.length > 0
                        ? selectedRowIndices
                        : rows.map((_, idx) => idx);
            }
            if (includeHeaders) {
                lines.push(
                    selectedColumns
                        .map(name => (format === 'csv' ? csvQuote(name) : name))
                        .join(separator)
                );
            }
            for (const row of rowIndices) {
                const values = selectedColumns.map(name => {
                    const raw = rows[row]?.[name];
                    const value = raw === null || raw === undefined ? '' : String(raw);
                    return format === 'csv' ? csvQuote(value) : value;
                });
                lines.push(values.join(separator));
            }
            vscode.postMessage({ command: 'copy', text: lines.join('\n').trim() });
        },
        [selection, orderedColumnNames, rows, vscode]
    );

    const onCellContextMenu = React.useCallback((cell: Item, event: CellClickedEventArgs) => {
        event.preventDefault();
        if (!selection.current?.range) {
            const [col, row] = cell;
            setSelection({
                current: {
                    cell,
                    range: { x: col, y: row, width: 1, height: 1 },
                    rangeStack: [],
                },
                rows: CompactSelection.empty(),
                columns: CompactSelection.empty(),
            });
        }
        setHeaderMenu(null);
        setContextMenu({
            x: event.bounds.x + event.localEventX,
            y: event.bounds.y + event.localEventY,
        });
    }, [selection]);

    React.useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const hasSelection =
                selection.current?.range !== undefined ||
                selection.rows.length > 0 ||
                selection.columns.length > 0;
            if ((e.ctrlKey || e.metaKey) && e.key === 'c' && hasSelection) {
                e.preventDefault();
                copySelection('plain', false);
            }
            if (e.key === 'Escape') {
                setContextMenu(null);
                setHeaderMenu(null);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [copySelection, selection]);

    const menuOpen = contextMenu !== null || headerMenu !== null;

    React.useEffect(() => {
        if (!menuOpen) return;
        const handleClick = () => {
            setContextMenu(null);
            setHeaderMenu(null);
        };
        const id = window.setTimeout(() => window.addEventListener('click', handleClick), 0);
        return () => {
            window.clearTimeout(id);
            window.removeEventListener('click', handleClick);
        };
    }, [menuOpen]);

    const currentStateRef = React.useRef<SavedTabState>({
        sortColumn,
        sortDirection,
        filterText,
        scrollPosition: topRow,
    });
    currentStateRef.current = { sortColumn, sortDirection, filterText, scrollPosition: topRow };

    React.useEffect(() => {
        const filterInput = document.getElementById(renderState.filterId) as HTMLInputElement | null;
        if (filterInput) {
            filterInput.value = filterText;
            const onInput = () => setFilterText(filterInput.value);
            filterInput.addEventListener('input', onInput);
            return () => filterInput.removeEventListener('input', onInput);
        }
    }, [renderState.filterId]);

    React.useEffect(() => {
        const countEl = document.getElementById('count');
        if (countEl) {
            countEl.textContent = `${rows.length.toLocaleString()} rows`;
        }
    }, [rows.length]);

    React.useEffect(() => {
        const exportBtn = document.getElementById('export');
        if (!exportBtn) {
            return;
        }
        const onExport = () => vscode.postMessage({ command: 'export' });
        exportBtn.addEventListener('click', onExport);
        return () => exportBtn.removeEventListener('click', onExport);
    }, [vscode]);

    React.useEffect(() => {
        const postSwitch = (index: number) =>
            vscode.postMessage({ command: 'switchTab', index, currentState: currentStateRef.current });
        const tabHandlers: { el: Element; fn: (e: Event) => void }[] = [];
        document.querySelectorAll('.tab-close').forEach(btn => {
            const fn = (e: Event) => {
                e.stopPropagation();
                vscode.postMessage({
                    command: 'closeTab',
                    index: parseInt((btn as HTMLElement).dataset.index ?? '0', 10),
                });
            };
            btn.addEventListener('click', fn);
            tabHandlers.push({ el: btn, fn });
        });
        document.querySelectorAll('.tab').forEach(tab => {
            const fn = () => postSwitch(parseInt((tab as HTMLElement).dataset.index ?? '0', 10));
            tab.addEventListener('click', fn);
            tabHandlers.push({ el: tab, fn });
        });
        return () => tabHandlers.forEach(({ el, fn }) => el.removeEventListener('click', fn));
    }, [vscode]);

    React.useEffect(() => {
        if (savedTabState?.scrollPosition && gridRef.current) {
            gridRef.current.scrollTo(0, savedTabState.scrollPosition, 'vertical');
        }
    }, [savedTabState]);

    const onItemHovered = React.useCallback((args: GridMouseEventArgs) => {
        const next = args.kind === 'cell' ? args.location[1] : undefined;
        setHoverRow(prev => (prev === next ? prev : next));
    }, []);

    const hoverBackground = React.useMemo(
        () => cssVar('--vscode-list-hoverBackground', 'rgba(128,128,128,0.12)'),
        [theme]
    );

    const getRowThemeOverride = React.useCallback(
        (row: number): Partial<Theme> | undefined =>
            row === hoverRow ? { bgCell: hoverBackground, bgCellMedium: hoverBackground } : undefined,
        [hoverRow, hoverBackground]
    );

    const onVisibleRegionChanged = React.useCallback((range: Rectangle) => {
        setTopRow(range.y);
    }, []);

    return (
        <div ref={containerRef} className="grid-canvas-host">
            {width > 0 && height > 0 && (
                <DataEditor
                    ref={gridRef}
                    columns={columns}
                    rows={rows.length}
                    getCellContent={getCellContent}
                    getCellsForSelection={getCellsForSelection}
                    rowMarkers="number"
                    freezeColumns={freezeColumns}
                    minColumnWidth={MIN_ESTIMATED_COLUMN_WIDTH}
                    maxColumnWidth={MAX_ESTIMATED_COLUMN_WIDTH}
                    width={width}
                    height={height}
                    theme={theme}
                    smoothScrollX={true}
                    smoothScrollY={true}
                    gridSelection={selection}
                    onGridSelectionChange={setSelection}
                    rangeSelect="multi-rect"
                    onColumnResize={onColumnResize}
                    onColumnMoved={onColumnMoved}
                    onHeaderClicked={onHeaderClicked}
                    onHeaderContextMenu={onHeaderContextMenu}
                    onCellClicked={onCellClicked}
                    onCellContextMenu={onCellContextMenu}
                    onItemHovered={onItemHovered}
                    getRowThemeOverride={getRowThemeOverride}
                    onVisibleRegionChanged={onVisibleRegionChanged}
                    keybindings={{ copy: false, paste: false }}
                    rightElement={
                        queryStats ? (
                            <StatsPanel
                                stats={queryStats}
                                selectedCell={selectedCell}
                                collapsed={statsCollapsed}
                                onToggle={() => setStatsCollapsed(prev => !prev)}
                                vscode={vscode}
                            />
                        ) : undefined
                    }
                    rightElementProps={{ sticky: true }}
                />
            )}
            {contextMenu && (
                <ul
                    className="grid-context-menu"
                    style={{ left: contextMenu.x, top: contextMenu.y }}
                    onClick={e => e.stopPropagation()}
                >
                    <CopyMenuItems onCopy={copySelection} onSelect={() => setContextMenu(null)} />
                </ul>
            )}
            {headerMenu && (
                <ul
                    className="grid-context-menu"
                    style={{ left: headerMenu.x, top: headerMenu.y }}
                    onClick={e => e.stopPropagation()}
                >
                    <CopyMenuItems onCopy={copySelection} onSelect={() => setHeaderMenu(null)} />
                    <li className="grid-context-menu-divider" role="separator" />
                    {freezeColumns < headerMenu.colIndex + 1 && (
                        <li
                            className="grid-context-menu-item"
                            onClick={() => {
                                setFreezeColumns(headerMenu.colIndex + 1);
                                setHeaderMenu(null);
                            }}
                        >
                            Freeze columns up to here
                        </li>
                    )}
                    {freezeColumns > 0 && (
                        <li
                            className="grid-context-menu-item"
                            onClick={() => {
                                setFreezeColumns(0);
                                setHeaderMenu(null);
                            }}
                        >
                            Unfreeze all columns
                        </li>
                    )}
                </ul>
            )}
            {portal && createPortal(<div />, portal)}
        </div>
    );
};

const mount = (): void => {
    const root = document.getElementById('grid-root');
    const data = readIsland<ResultData>('result-data');
    if (!root || !data) {
        return;
    }
    const renderState = readIsland<RenderState>('render-state') ?? {
        filterId: '',
        initialSortColumn: null,
        initialSortDirection: 'asc',
    };
    const savedTabState = readIsland<SavedTabState>('saved-tab-state');
    const queryStats = readIsland<QueryStats>('query-stats');
    const vscode = acquireVsCode();
    createRoot(root).render(
        <ResultsGrid
            data={data}
            renderState={renderState}
            savedTabState={savedTabState}
            queryStats={queryStats}
            vscode={vscode}
        />
    );
};

acquireVsCode();
const wireTabsOnly = (): void => {
    if (document.getElementById('grid-root')) {
        return;
    }
    const vscode = window.__vscode!;
    document.querySelectorAll('.tab-close').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            vscode.postMessage({
                command: 'closeTab',
                index: parseInt((btn as HTMLElement).dataset.index ?? '0', 10),
            });
        });
    });
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            vscode.postMessage({
                command: 'switchTab',
                index: parseInt((tab as HTMLElement).dataset.index ?? '0', 10),
            });
        });
    });
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        mount();
        wireTabsOnly();
    });
} else {
    mount();
    wireTabsOnly();
}
