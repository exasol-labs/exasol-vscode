import * as vscode from 'vscode';
import { format } from 'sql-formatter';

export class FormattingProvider
    implements vscode.DocumentFormattingEditProvider, vscode.DocumentRangeFormattingEditProvider {

    provideDocumentFormattingEdits(
        document: vscode.TextDocument,
        options: vscode.FormattingOptions,
        _token: vscode.CancellationToken
    ): vscode.TextEdit[] {
        const text = document.getText();
        if (!text || !text.trim()) {
            return [];
        }

        const lastLine = document.lineCount - 1;
        const lastChar = document.lineAt(lastLine).text.length;
        const fullRange = new vscode.Range(
            new vscode.Position(0, 0),
            new vscode.Position(lastLine, lastChar)
        );

        const formatted = this.format(text, options);
        return [vscode.TextEdit.replace(fullRange, formatted)];
    }

    provideDocumentRangeFormattingEdits(
        document: vscode.TextDocument,
        range: vscode.Range,
        options: vscode.FormattingOptions,
        _token: vscode.CancellationToken
    ): vscode.TextEdit[] {
        const text = document.getText(range);
        if (!text || !text.trim()) {
            return [];
        }

        const formatted = this.format(text, options);
        return [vscode.TextEdit.replace(range, formatted)];
    }

    /** Format SQL text using sql-formatter with workspace settings and editor fallbacks. */
    public format(text: string, options?: vscode.FormattingOptions): string {
        const config = vscode.workspace.getConfiguration('exasol.formatter');

        const tabWidth = config.get<number>('tabWidth') ?? options?.tabSize ?? 2;
        const useTabs = config.get<boolean>('useTabs') ?? (options ? !options.insertSpaces : false);

        return format(text, {
            language: 'sql',
            keywordCase: config.get<'upper' | 'lower' | 'preserve'>('keywordCase') ?? 'upper',
            indentStyle: config.get<'standard' | 'tabularLeft' | 'tabularRight'>('indentStyle') ?? 'standard',
            tabWidth,
            useTabs,
            linesBetweenQueries: config.get<number>('linesBetweenQueries') ?? 2,
        });
    }
}
