/**
 * Notebook output renderer for Exasol SQL result sets.
 *
 * Mounts a lean, read-only glide DataEditor into each cell output. Reuses the shared pure cell,
 * sort, theme and layout helpers so type-aware display and raw clipboard copy stay consistent
 * with the results panel without depending on it.
 */
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
    DataEditor,
    CompactSelection,
    type DataEditorRef,
    type GridCell,
    type GridColumn,
    type GridSelection,
    type Item,
    type Rectangle,
    type Theme,
    type GridMouseEventArgs,
} from '@glideapps/glide-data-grid';
import glideCss from './glideStyles.css';
import {
    buildDisplayCell,
    compareRows,
    type GridColumnMetadata,
    type GridRowValue,
} from './gridCells';
import { buildGridTheme, cssVar } from './gridTheme';
import {
    computeGridHeight,
    HEADER_HEIGHT,
    ROW_HEIGHT,
} from './notebookGridLayout';

interface OutputItem {
    readonly id: string;
    json(): GridOutputData;
}

interface RendererContext {
    readonly postMessage?: (message: unknown) => void;
}

interface RendererApi {
    renderOutputItem(outputItem: OutputItem, element: HTMLElement): void;
    disposeOutputItem?(id?: string): void;
}

type ActivationFunction = (context: RendererContext) => RendererApi;

interface GridOutputData {
    columns: string[];
    columnMetadata: GridColumnMetadata[];
    rows: GridRowValue[];
    rowCount: number;
    executionTime: number;
}

const DEFAULT_COLUMN_WIDTH = 150;
const MIN_COLUMN_WIDTH = 64;
const MAX_COLUMN_WIDTH = 400;
const STYLE_ELEMENT_ID = 'exasol-glide-style';

// glide-data-grid mounts its cell overlay editor into `document.getElementById("portal")`. The id
// is fixed inside glide and only one overlay is ever open per document, so a single shared portal
// serves every grid in the output; refcounting keeps it alive while any grid is mounted.
const PORTAL_ELEMENT_ID = 'portal';

const ensureGlideStyles = (): void => {
    if (document.getElementById(STYLE_ELEMENT_ID)) {
        return;
    }
    const style = document.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    style.textContent = glideCss;
    document.head.appendChild(style);
};

let portalRefCount = 0;

const acquirePortal = (): void => {
    portalRefCount += 1;
    if (document.getElementById(PORTAL_ELEMENT_ID)) {
        return;
    }
    const portal = document.createElement('div');
    portal.id = PORTAL_ELEMENT_ID;
    portal.style.position = 'fixed';
    portal.style.left = '0';
    portal.style.top = '0';
    portal.style.zIndex = '9999';
    document.body.appendChild(portal);
};

const releasePortal = (): void => {
    if (portalRefCount > 0) {
        portalRefCount -= 1;
    }
    if (portalRefCount > 0) {
        return;
    }
    document.getElementById(PORTAL_ELEMENT_ID)?.remove();
};

const useContainerWidth = (ref: React.RefObject<HTMLDivElement | null>): number => {
    const [width, setWidth] = React.useState(0);
    React.useEffect(() => {
        const node = ref.current;
        if (!node) {
            return;
        }
        const observer = new ResizeObserver(entries => {
            const next = entries[0].contentRect.width;
            setWidth(prev => (prev === next ? prev : next));
        });
        observer.observe(node);
        return () => observer.disconnect();
    }, [ref]);
    return width;
};

const useTheme = (): Partial<Theme> => {
    const [theme, setTheme] = React.useState<Partial<Theme>>(() => buildGridTheme());
    React.useEffect(() => {
        const observer = new MutationObserver(() => setTheme(buildGridTheme()));
        observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
        return () => observer.disconnect();
    }, []);
    return theme;
};

const NotebookGrid: React.FC<{ data: GridOutputData }> = ({ data }) => {
    const { columns: columnNames, columnMetadata, rowCount, executionTime } = data;
    const theme = useTheme();
    const containerRef = React.useRef<HTMLDivElement>(null);
    const width = useContainerWidth(containerRef);
    const gridRef = React.useRef<DataEditorRef>(null);

    const [sortColumn, setSortColumn] = React.useState<string | null>(null);
    const [sortDirection, setSortDirection] = React.useState<'asc' | 'desc'>('asc');
    const [columnWidths, setColumnWidths] = React.useState<Record<string, number>>({});
    const [columnOrder, setColumnOrder] = React.useState<string[]>(() => [...columnNames]);
    const [hoverRow, setHoverRow] = React.useState<number | undefined>(undefined);
    const [selection, setSelection] = React.useState<GridSelection>({
        current: undefined,
        rows: CompactSelection.empty(),
        columns: CompactSelection.empty(),
    });

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

    const rows = React.useMemo<GridRowValue[]>(() => {
        if (!sortColumn) {
            return data.rows;
        }
        return [...data.rows].sort((a, b) => compareRows(a, b, sortColumn, sortDirection));
    }, [data.rows, sortColumn, sortDirection]);

    const columns = React.useMemo<GridColumn[]>(
        () =>
            orderedColumnNames.map(name => {
                const sorted = name === sortColumn;
                return {
                    title: sorted ? `${name} ${sortDirection === 'asc' ? '▲' : '▼'}` : name,
                    id: name,
                    width: columnWidths[name] ?? DEFAULT_COLUMN_WIDTH,
                };
            }),
        [orderedColumnNames, columnWidths, sortColumn, sortDirection]
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
            return buildDisplayCell(value, columnName, columnMetadata, nullTextColor);
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
        const clamped = Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, newSize));
        setColumnWidths(prev => ({ ...prev, [column.id as string]: clamped }));
    }, []);

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

    const onHeaderClicked = React.useCallback(
        (colIndex: number) => {
            const columnName = orderedColumnNames[colIndex];
            setSortDirection(prev => (sortColumn === columnName && prev === 'asc' ? 'desc' : 'asc'));
            setSortColumn(columnName);
        },
        [orderedColumnNames, sortColumn]
    );

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

    const height = computeGridHeight(rows.length);

    const metaColor = React.useMemo(
        () => cssVar('--vscode-descriptionForeground', '#999999'),
        [theme]
    );
    const meta = `${rowCount.toLocaleString()} row(s) — ${executionTime}ms`;

    return (
        <div ref={containerRef} className="exasol-notebook-grid" style={{ width: '100%' }}>
            <div
                className="exasol-notebook-meta"
                style={{ color: metaColor, fontSize: '0.9em', padding: '2px 0 4px' }}
            >
                {meta}
            </div>
            {width > 0 && (
                <DataEditor
                    ref={gridRef}
                    columns={columns}
                    rows={rows.length}
                    getCellContent={getCellContent}
                    getCellsForSelection={getCellsForSelection}
                    rowMarkers="number"
                    headerHeight={HEADER_HEIGHT}
                    rowHeight={ROW_HEIGHT}
                    minColumnWidth={MIN_COLUMN_WIDTH}
                    maxColumnWidth={MAX_COLUMN_WIDTH}
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
                    onItemHovered={onItemHovered}
                    getRowThemeOverride={getRowThemeOverride}
                    keybindings={{ copy: true }}
                />
            )}
        </div>
    );
};

export const activate: ActivationFunction = (_context: RendererContext): RendererApi => {
    ensureGlideStyles();
    const roots = new Map<string, { element: HTMLElement; root: Root }>();

    return {
        renderOutputItem(outputItem: OutputItem, element: HTMLElement): void {
            const data = outputItem.json();
            const existing = roots.get(outputItem.id);
            const reusable = existing !== undefined && existing.element === element;
            const root = reusable ? existing.root : createRoot(element);
            if (existing && !reusable) {
                existing.root.unmount();
            }
            if (!reusable) {
                acquirePortal();
            }
            if (existing && !reusable) {
                releasePortal();
            }
            roots.set(outputItem.id, { element, root });
            root.render(<NotebookGrid data={data} />);
        },
        disposeOutputItem(id?: string): void {
            if (id === undefined) {
                for (const { root } of roots.values()) {
                    root.unmount();
                    releasePortal();
                }
                roots.clear();
                return;
            }
            const entry = roots.get(id);
            if (entry) {
                entry.root.unmount();
                roots.delete(id);
                releasePortal();
            }
        },
    };
};
