import * as vscode from 'vscode';

export class ExasolCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

    constructor() {}

    public refresh(): void {
        this._onDidChangeCodeLenses.fire();
    }

    public provideCodeLenses(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
        const codeLenses: vscode.CodeLens[] = [];
        const text = document.getText();
        const lines = text.split('\n');

        let currentStatementStart: number | null = null;
        let statementBuffer = '';

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // Skip empty lines and comments
            if (!line || line.startsWith('--')) {
                continue;
            }

            // If we haven't started a statement yet, start one
            if (currentStatementStart === null) {
                currentStatementStart = i;
                statementBuffer = line;
            } else {
                statementBuffer += ' ' + line;
            }

            // Check if this line ends with a semicolon (end of statement)
            if (line.endsWith(';')) {
                // Create a CodeLens for this statement
                if (currentStatementStart !== null && statementBuffer.trim().length > 0) {
                    const range = new vscode.Range(currentStatementStart, 0, i, lines[i].length);
                    const codeLens = new vscode.CodeLens(range, {
                        title: '▶ Execute',
                        command: 'exasol.executeStatement',
                        arguments: [document, range]
                    });
                    codeLenses.push(codeLens);
                }

                // Reset for next statement
                currentStatementStart = null;
                statementBuffer = '';
            }
        }

        // Handle the case where there's a statement without a semicolon at the end
        if (currentStatementStart !== null && statementBuffer.trim().length > 0) {
            const lastLine = lines.length - 1;
            const range = new vscode.Range(currentStatementStart, 0, lastLine, lines[lastLine].length);
            const codeLens = new vscode.CodeLens(range, {
                title: '▶ Execute',
                command: 'exasol.executeStatement',
                arguments: [document, range]
            });
            codeLenses.push(codeLens);
        }

        return codeLenses;
    }

    public resolveCodeLens(
        codeLens: vscode.CodeLens,
        token: vscode.CancellationToken
    ): vscode.CodeLens | Thenable<vscode.CodeLens> {
        return codeLens;
    }
}
