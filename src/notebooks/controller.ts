import * as vscode from 'vscode';
import { ConnectionManager } from '../connectionManager';
import { QueryExecutor, QueryResult } from '../queryExecutor';
import { getOutputChannel } from '../extension';
import { formatError } from '../connectionTypes';

export class ExasolNotebookController {
    private readonly controller: vscode.NotebookController;
    private executionOrder = 0;
    private interrupted = false;

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
        this.interrupted = false;
        for (const cell of cells) {
            if (this.interrupted) {
                break;
            }
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

            execution.replaceOutput([
                new vscode.NotebookCellOutput([this.renderResult(result)])
            ]);
            execution.end(true, Date.now());
        } catch (error) {
            const msg = formatError(error);
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
        this.interrupted = true;
    }

    private renderResult(result: QueryResult): vscode.NotebookCellOutputItem {
        const { columns, columnMetadata, rows, rowCount, executionTime } = result;

        // Non-result-set queries (CREATE, INSERT, etc.)
        if (columns.length === 0) {
            const html = `<div style="font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);padding:8px;">
                <span style="color:var(--vscode-testing-iconPassed);">&#10003;</span>
                Statement executed successfully. ${rowCount > 0 ? `${rowCount} row(s) affected.` : ''}
                <span style="color:var(--vscode-descriptionForeground);">(${executionTime}ms)</span>
            </div>`;
            return vscode.NotebookCellOutputItem.text(html, 'text/html');
        }

        // Result-set queries — hand the raw payload to the grid renderer (row count already
        // capped upstream by maxResultRows).
        return vscode.NotebookCellOutputItem.json(
            { columns, columnMetadata, rows, rowCount, executionTime },
            'application/x-exasol-grid+json'
        );
    }

}
