import * as vscode from 'vscode';

interface RawNotebookCell {
    kind: number; // 1 = Markup, 2 = Code
    language: string;
    value: string;
}

export class ExasolNotebookSerializer implements vscode.NotebookSerializer {

    deserializeNotebook(content: Uint8Array, _token: vscode.CancellationToken): vscode.NotebookData {
        const text = new TextDecoder().decode(content);
        let raw: RawNotebookCell[];

        try {
            raw = text.trim() ? JSON.parse(text) : [];
        } catch {
            vscode.window.showWarningMessage('Failed to parse .exabook file — opening as empty notebook.');
            raw = [];
        }

        if (!Array.isArray(raw)) {
            vscode.window.showWarningMessage('Invalid .exabook format — expected an array of cells.');
            raw = [];
        }

        const cells = raw
            .filter(cell => cell != null && typeof cell.value === 'string')
            .map(cell => new vscode.NotebookCellData(
                cell.kind === 1 ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code,
                cell.value,
                typeof cell.language === 'string' ? cell.language : 'exasol-sql'
            ));

        return new vscode.NotebookData(cells);
    }

    serializeNotebook(data: vscode.NotebookData, _token: vscode.CancellationToken): Uint8Array {
        const raw: RawNotebookCell[] = data.cells.map(cell => ({
            kind: cell.kind === vscode.NotebookCellKind.Markup ? 1 : 2,
            language: cell.languageId,
            value: cell.value
        }));

        return new TextEncoder().encode(JSON.stringify(raw, null, 2));
    }
}
