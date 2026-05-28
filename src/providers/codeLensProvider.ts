import * as vscode from 'vscode';
import { buildLineOffsets, offsetToLine, findStatementRanges } from '../utils';

export class ExasolCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

    public refresh(): void {
        this._onDidChangeCodeLenses.fire();
    }

    public provideCodeLenses(
        document: vscode.TextDocument,
        _token: vscode.CancellationToken
    ): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
        // Skip CodeLens in notebook cells; they have their own execute button
        if (document.uri.scheme === 'vscode-notebook-cell') {
            return [];
        }

        const text = document.getText();
        const stmtRanges = findStatementRanges(text);

        if (stmtRanges.length === 0) {
            return [];
        }

        const lineOffsets = buildLineOffsets(text);
        return stmtRanges.map(({ start, end }) => {
            const startLine = offsetToLine(lineOffsets, start);
            const endLine = offsetToLine(lineOffsets, end);

            // Display range: anchors the lens at the first code line of the
            // statement. Kept narrow (zero-width at startLine col 0) so the lens
            // sits cleanly above the SELECT/INSERT/... keyword.
            const displayRange = new vscode.Range(startLine, 0, startLine, 0);

            // Execution range: covers the FULL statement from the first code
            // line through and including the terminating semicolon. The display
            // range is intentionally NOT reused here; using it would truncate
            // the executed text and drop any content past the first line of
            // the statement (clauses, LIMIT, etc.).
            const execRange = new vscode.Range(startLine, 0, endLine, end - lineOffsets[endLine] + 1);

            return new vscode.CodeLens(displayRange, {
                title: '▶ Execute',
                command: 'exasol.executeStatement',
                arguments: [document, execRange]
            });
        });
    }

    public resolveCodeLens(
        codeLens: vscode.CodeLens,
        _token: vscode.CancellationToken
    ): vscode.CodeLens | Thenable<vscode.CodeLens> {
        return codeLens;
    }
}
