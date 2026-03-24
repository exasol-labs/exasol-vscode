import * as vscode from 'vscode';
import { ConnectionManager } from '../connectionManager';
import { QueryExecutor, QueryResult } from '../queryExecutor';
import { getOutputChannel } from '../extension';

export class ExasolNotebookController {
    private readonly controller: vscode.NotebookController;
    private executionOrder = 0;

    constructor(
        private connectionManager: ConnectionManager,
        private queryExecutor: QueryExecutor
    ) {
        this.controller = vscode.notebooks.createNotebookController(
            'exasol-sql-controller',
            'exasol-sql-notebook',
            'Exasol SQL'
        );

        this.controller.supportedLanguages = ['exasol-sql', 'sql'];
        this.controller.supportsExecutionOrder = true;
        this.controller.executeHandler = this.executeCells.bind(this);
        this.controller.interruptHandler = this.interrupt.bind(this);
    }

    dispose(): void {
        this.controller.dispose();
    }

    private async executeCells(cells: vscode.NotebookCell[]): Promise<void> {
        for (const cell of cells) {
            await this.executeCell(cell);
        }
    }

    private async executeCell(cell: vscode.NotebookCell): Promise<void> {
        const execution = this.controller.createNotebookCellExecution(cell);
        execution.executionOrder = ++this.executionOrder;
        execution.start(Date.now());

        const sql = cell.document.getText().trim();
        if (!sql) {
            execution.replaceOutput([
                new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text('Empty cell — nothing to execute.', 'text/plain')
                ])
            ]);
            execution.end(undefined, Date.now());
            return;
        }

        const activeConnection = this.connectionManager.getActiveConnection();
        if (!activeConnection) {
            execution.replaceOutput([
                new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.stderr('No active Exasol connection. Select a connection first.')
                ])
            ]);
            execution.end(false, Date.now());
            return;
        }

        const output = getOutputChannel();
        const cancellationTokenSource = new vscode.CancellationTokenSource();
        execution.token.onCancellationRequested(() => {
            cancellationTokenSource.cancel();
        });

        try {
            const result = await this.queryExecutor.execute(sql, cancellationTokenSource.token);
            const html = this.renderResult(result, sql);

            execution.replaceOutput([
                new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text(html, 'text/html'),
                ])
            ]);
            execution.end(true, Date.now());
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            output.appendLine(`Notebook cell error: ${msg}`);
            execution.replaceOutput([
                new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.stderr(msg)
                ])
            ]);
            execution.end(false, Date.now());
        } finally {
            cancellationTokenSource.dispose();
        }
    }

    private interrupt(): void {
        // Cancellation is handled per-cell via execution.token
    }

    private renderResult(result: QueryResult, sql: string): string {
        const { columns, rows, rowCount, executionTime } = result;

        // Non-result-set queries (CREATE, INSERT, etc.)
        if (columns.length === 0) {
            return `<div style="font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);padding:8px;">
                <span style="color:var(--vscode-testing-iconPassed);">&#10003;</span>
                Statement executed successfully. ${rowCount > 0 ? `${rowCount} row(s) affected.` : ''}
                <span style="color:var(--vscode-descriptionForeground);">(${executionTime}ms)</span>
            </div>`;
        }

        // Result-set queries — render HTML table
        const maxDisplay = 500;
        const truncated = rows.length > maxDisplay;
        const displayRows = truncated ? rows.slice(0, maxDisplay) : rows;

        let html = `<style>
            .exasol-nb-table { border-collapse:collapse; font-family:var(--vscode-editor-font-family); font-size:var(--vscode-editor-font-size); }
            .exasol-nb-table th { background:var(--vscode-editor-selectionBackground); color:var(--vscode-editor-foreground); padding:4px 8px; text-align:left; border:1px solid var(--vscode-panel-border); position:sticky; top:0; }
            .exasol-nb-table td { padding:4px 8px; border:1px solid var(--vscode-panel-border); color:var(--vscode-editor-foreground); text-align:left; white-space:nowrap; max-width:300px; overflow:hidden; text-overflow:ellipsis; }
            .exasol-nb-table tr:nth-child(even) { background:var(--vscode-list-hoverBackground); }
            .exasol-nb-table td.null-val { color:var(--vscode-descriptionForeground); font-style:italic; }
            .exasol-nb-meta { font-family:var(--vscode-editor-font-family); font-size:var(--vscode-editor-font-size); color:var(--vscode-descriptionForeground); padding:4px 0; }
        </style>`;

        html += `<div class="exasol-nb-meta">${rows.length} row(s) — ${executionTime}ms${truncated ? ` (showing first ${maxDisplay})` : ''}</div>`;
        html += '<table class="exasol-nb-table"><thead><tr>';

        for (const col of columns) {
            html += `<th>${this.escapeHtml(col)}</th>`;
        }
        html += '</tr></thead><tbody>';

        for (const row of displayRows) {
            html += '<tr>';
            for (const col of columns) {
                const val = row[col];
                if (val === null || val === undefined) {
                    html += '<td class="null-val">NULL</td>';
                } else {
                    html += `<td>${this.escapeHtml(String(val))}</td>`;
                }
            }
            html += '</tr>';
        }

        html += '</tbody></table>';
        return html;
    }

    private escapeHtml(s: string): string {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
}
