// results-grid.js
// Data is injected via <script id="result-data" type="application/json"> element to prevent XSS.
// Per-render state is injected via <script id="render-state" type="application/json"> element.

(function () {
    'use strict';

    const vscode = acquireVsCodeApi();
    // Expose for inline scripts that run after this file loads (e.g. tab-bar handlers).
    // acquireVsCodeApi() may only be called once per webview; all other scripts must use
    // window.__vscode instead of calling acquireVsCodeApi() directly.
    window.__vscode = vscode;

    // Guard: if there is no result data island this script is being loaded on a non-grid
    // page (e.g. error view) solely to expose window.__vscode.  In that case stop here.
    if (!document.getElementById('result-data')) {
        return;
    }

    // Read query result data from JSON data island (XSS-safe; no inline JS interpolation)
    const data = JSON.parse(document.getElementById('result-data').textContent);

    // Read per-render state from JSON data island
    const renderState = JSON.parse(document.getElementById('render-state').textContent);
    const filterId = renderState.filterId;

    const filterInput = document.getElementById(filterId);
    const tbody = document.querySelector('#results tbody');
    const countEl = document.getElementById('count');

    let currentRows = data.rows;
    let sortColumn = renderState.initialSortColumn || null;
    let sortDirection = renderState.initialSortDirection || 'asc';

    const getColumnType = (columnName) => {
        const metadata = data.columnMetadata || [];
        const colMeta = metadata.find(col => col.name === columnName);
        if (!colMeta) return 'VARCHAR';
        let type = colMeta.type;
        if (colMeta.precision !== undefined && colMeta.scale !== undefined) {
            type += '(' + colMeta.precision + ',' + colMeta.scale + ')';
        } else if (colMeta.size !== undefined) {
            type += '(' + colMeta.size + ')';
        } else if (colMeta.precision !== undefined) {
            type += '(' + colMeta.precision + ')';
        }
        return type;
    };

    const showCellInspector = (columnName, value) => {
        vscode.postMessage({ command: 'cellSelected', column: columnName, value: value, type: getColumnType(columnName) });
    };

    let isSelecting = false;
    let selectionStart = null;
    let selectionEnd = null;

    const clearSelection = () => {
        document.querySelectorAll('td.selecting, td.selected').forEach(el => {
            el.classList.remove('selecting', 'selected');
        });
    };

    const highlightSelection = (startRow, startCol, endRow, endCol) => {
        const minRow = Math.min(startRow, endRow);
        const maxRow = Math.max(startRow, endRow);
        const minCol = Math.min(startCol, endCol);
        const maxCol = Math.max(startCol, endCol);
        document.querySelectorAll('td').forEach(td => {
            const row = parseInt(td.dataset.row);
            const col = parseInt(td.dataset.col);
            if (row >= minRow && row <= maxRow && col >= minCol && col <= maxCol) {
                td.classList.add('selecting');
            } else {
                td.classList.remove('selecting');
            }
        });
    };

    const getSelectedCellsData = () => {
        const selectedCells = Array.from(document.querySelectorAll('td.selecting, td.selected'));
        if (selectedCells.length === 0) return null;
        const cellsByRow = new Map();
        const columns = new Set();
        selectedCells.forEach(td => {
            if (td.classList.contains('row-number')) return;
            const row = parseInt(td.dataset.row);
            const col = parseInt(td.dataset.col);
            const colName = td.dataset.colname;
            const value = td.dataset.value || '';
            if (!cellsByRow.has(row)) cellsByRow.set(row, new Map());
            cellsByRow.get(row).set(col, { value, colName });
            columns.add(col);
        });
        return { cellsByRow, columns: Array.from(columns).sort((a, b) => a - b) };
    };

    const copyValues = (format, includeHeaders) => {
        const selectionData = getSelectedCellsData();
        if (!selectionData) return;
        const { cellsByRow, columns } = selectionData;
        const rows = Array.from(cellsByRow.keys()).sort((a, b) => a - b);
        let text = '';
        const separator = format === 'csv' ? ',' : String.fromCharCode(9);
        const lineSep = String.fromCharCode(10);
        if (includeHeaders) {
            const headers = columns.map(colIdx => {
                for (const row of cellsByRow.values()) {
                    const cell = row.get(colIdx);
                    if (cell && cell.colName) return cell.colName;
                }
                return '';
            });
            if (format === 'csv') {
                text += headers.map(h => h.includes(',') || h.includes('"') || h.includes(String.fromCharCode(10)) ? '"' + h.replace(/"/g, '""') + '"' : h).join(',') + lineSep;
            } else {
                text += headers.join(separator) + lineSep;
            }
        }
        rows.forEach(rowIdx => {
            const rowData = cellsByRow.get(rowIdx);
            const values = columns.map(colIdx => {
                const cell = rowData.get(colIdx);
                const value = cell ? cell.value : '';
                if (format === 'csv' && (value.includes(',') || value.includes('"') || value.includes(String.fromCharCode(10)))) {
                    return '"' + value.replace(/"/g, '""') + '"';
                }
                return value;
            });
            text += values.join(separator) + lineSep;
        });
        vscode.postMessage({ command: 'copy', text: text.trim() });
    };

    const truncateValue = (value, maxLength) => {
        const len = maxLength !== undefined ? maxLength : 200;
        const str = String(value);
        if (str.length <= len) return { display: str, isTruncated: false };
        return { display: str.substring(0, len) + '...', isTruncated: true };
    };

    const CHUNK_SIZE = 1000;
    let renderedRowCount = 0;
    let isRendering = false;

    const renderRows = (rows, startIdx, endIdx) => {
        const fragment = document.createDocumentFragment();
        for (let rowIdx = startIdx; rowIdx < endIdx && rowIdx < rows.length; rowIdx++) {
            const row = rows[rowIdx];
            const tr = document.createElement('tr');
            const rowNumTd = document.createElement('td');
            rowNumTd.className = 'row-number';
            rowNumTd.textContent = (rowIdx + 1).toString();
            tr.appendChild(rowNumTd);
            data.columns.forEach((col, colIdx) => {
                const td = document.createElement('td');
                const value = row[col];
                if (value === null || value === undefined) {
                    td.innerHTML = '<span class="null-value">(null)</span>';
                } else {
                    const fullValue = String(value);
                    const truncated = truncateValue(fullValue);
                    td.textContent = truncated.display;
                    if (truncated.isTruncated) { td.title = fullValue; td.classList.add('truncated'); }
                }
                td.dataset.row = rowIdx;
                td.dataset.col = colIdx;
                td.dataset.colname = col;
                td.dataset.value = value === null || value === undefined ? '' : String(value);
                td.addEventListener('mousedown', (e) => {
                    if (e.button !== 0) return;
                    const tc = document.getElementById('tableContainer');
                    if (tc) tc.focus();
                    isSelecting = true;
                    selectionStart = { row: rowIdx, col: colIdx };
                    selectionEnd = { row: rowIdx, col: colIdx };
                    clearSelection();
                    td.classList.add('selecting');
                    e.preventDefault();
                });
                td.addEventListener('mouseenter', () => {
                    if (isSelecting) {
                        selectionEnd = { row: rowIdx, col: colIdx };
                        clearSelection();
                        highlightSelection(selectionStart.row, selectionStart.col, selectionEnd.row, selectionEnd.col);
                    }
                });
                td.addEventListener('click', () => { showCellInspector(col, td.dataset.value); });
                tr.appendChild(td);
            });
            fragment.appendChild(tr);
        }
        tbody.appendChild(fragment);
        renderedRowCount = endIdx;
        updateCountDisplay(rows.length);
    };

    const updateCountDisplay = (totalRows) => {
        if (renderedRowCount < totalRows) {
            countEl.textContent = totalRows.toLocaleString() + ' rows (' + renderedRowCount.toLocaleString() + ' rendered)';
            countEl.style.color = 'var(--vscode-charts-orange)';
        } else {
            countEl.textContent = totalRows.toLocaleString() + ' rows';
            countEl.style.color = '';
        }
    };

    let scrollObserver = null;
    const setupScrollObserver = (rows) => {
        if (scrollObserver) scrollObserver.disconnect();
        const sentinel = document.createElement('tr');
        sentinel.id = 'scroll-sentinel';
        sentinel.style.height = '1px';
        tbody.appendChild(sentinel);
        scrollObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => { if (entry.isIntersecting && !isRendering) renderNextChunk(rows); });
        }, { root: document.querySelector('.table-container'), rootMargin: '200px' });
        scrollObserver.observe(sentinel);
    };

    const renderNextChunk = (rows) => {
        if (isRendering || renderedRowCount >= rows.length) return;
        isRendering = true;
        const endIdx = Math.min(renderedRowCount + CHUNK_SIZE, rows.length);
        requestAnimationFrame(() => {
            renderRows(rows, renderedRowCount, endIdx);
            isRendering = false;
            if (renderedRowCount < rows.length) setupScrollObserver(rows);
        });
    };

    const render = (rows) => {
        tbody.innerHTML = '';
        renderedRowCount = 0;
        isRendering = false;
        if (scrollObserver) { scrollObserver.disconnect(); scrollObserver = null; }
        const initialChunk = Math.min(CHUNK_SIZE, rows.length);
        renderRows(rows, 0, initialChunk);
        if (rows.length > initialChunk) setupScrollObserver(rows);
    };

    document.addEventListener('mouseup', () => {
        if (isSelecting) {
            isSelecting = false;
            document.querySelectorAll('td.selecting').forEach(td => { td.classList.remove('selecting'); td.classList.add('selected'); });
        }
    });

    document.addEventListener('keydown', (e) => {
        const target = e.target;
        if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
            if (target && target.tagName === 'INPUT') return;
            e.preventDefault(); e.stopPropagation();
            clearSelection();
            document.querySelectorAll('#results tbody td:not(.row-number)').forEach(td => td.classList.add('selected'));
            return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
            if (document.querySelectorAll('td.selecting, td.selected').length > 0) {
                e.preventDefault(); e.stopPropagation();
                copyValues('plain', false);
            }
        }
    });

    const contextMenu = document.getElementById('contextMenu');
    tbody.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (document.querySelectorAll('td.selecting, td.selected').length > 0) {
            contextMenu.style.display = 'block';
            contextMenu.style.left = e.pageX + 'px';
            contextMenu.style.top = e.pageY + 'px';
        }
    });
    document.addEventListener('click', () => { contextMenu.style.display = 'none'; });
    document.querySelectorAll('.context-menu-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            switch (item.dataset.action) {
                case 'copy': copyValues('plain', false); break;
                case 'copyWithHeaders': copyValues('plain', true); break;
                case 'copyAsCsv': copyValues('csv', false); break;
                case 'copyAsCsvWithHeaders': copyValues('csv', true); break;
            }
            contextMenu.style.display = 'none';
        });
    });

    const sortRows = (column) => {
        const newDirection = sortColumn === column && sortDirection === 'asc' ? 'desc' : 'asc';
        sortColumn = column;
        sortDirection = newDirection;
        const sorted = [...currentRows].sort((a, b) => {
            let aVal = a[column]; let bVal = b[column];
            if (aVal === null || aVal === undefined) aVal = '';
            if (bVal === null || bVal === undefined) bVal = '';
            const numericRe = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
            const isNumeric = (v) => typeof v === 'number' || (typeof v === 'string' && numericRe.test(v));
            const aNum = isNumeric(aVal) ? Number(aVal) : NaN;
            const bNum = isNumeric(bVal) ? Number(bVal) : NaN;
            if (!isNaN(aNum) && !isNaN(bNum)) return sortDirection === 'asc' ? aNum - bNum : bNum - aNum;
            const aStr = String(aVal).toLowerCase(); const bStr = String(bVal).toLowerCase();
            return sortDirection === 'asc' ? (aStr < bStr ? -1 : aStr > bStr ? 1 : 0) : (bStr < aStr ? -1 : bStr > aStr ? 1 : 0);
        });
        document.querySelectorAll('th').forEach(th => th.classList.remove('sorted-asc', 'sorted-desc'));
        const thIndex = data.columns.indexOf(column);
        const th = document.querySelectorAll('th')[thIndex + 1];
        th.classList.add('sorted-' + sortDirection);
        currentRows = sorted;
        render(sorted);
    };

    let isResizing = false; let currentTh = null; let currentCol = -1; let startX = 0; let startWidth = 0;
    document.querySelectorAll('th').forEach((th, idx) => { if (idx === 0) return; th.style.width = '150px'; th.style.minWidth = '80px'; });
    document.querySelectorAll('th .resizer').forEach((resizer, idx) => {
        resizer.addEventListener('mousedown', (e) => {
            e.stopPropagation(); isResizing = true; currentTh = resizer.parentElement;
            currentCol = idx; startX = e.pageX; startWidth = currentTh.offsetWidth;
            document.body.style.cursor = 'col-resize'; e.preventDefault();
        });
    });
    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const newWidth = Math.max(80, startWidth + (e.pageX - startX));
        currentTh.style.width = newWidth + 'px';
        document.querySelectorAll('#results tbody tr').forEach(row => {
            const cell = row.children[currentCol + 1];
            if (cell) cell.style.width = newWidth + 'px';
        });
    });
    document.addEventListener('mouseup', () => {
        if (isResizing) { isResizing = false; currentTh = null; currentCol = -1; document.body.style.cursor = ''; }
    });

    data.columns.forEach((col, idx) => {
        const th = document.querySelectorAll('th')[idx + 1];
        th.querySelector('span').addEventListener('click', (e) => { e.stopPropagation(); sortRows(col); });
    });

    filterInput && filterInput.addEventListener('input', () => {
        const term = filterInput.value.toLowerCase();
        currentRows = data.rows.filter(row => data.columns.some(col => (row[col] ?? '').toString().toLowerCase().includes(term)));
        render(currentRows);
    });

    // Expose render and sortRows globally for tab state restore (used inline in multi-tab HTML)
    window.__gridRender = render;
    window.__gridSortRows = sortRows;
    window.__gridGetSortColumn = () => sortColumn;
    window.__gridGetSortDirection = () => sortDirection;
    window.__gridGetCurrentRows = () => currentRows;

})();
