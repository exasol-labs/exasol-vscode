import * as vscode from 'vscode';
import { parseExabookCells } from './notebookUtils';

export class ExasolNotebookSerializer implements vscode.NotebookSerializer {

    deserializeNotebook(content: Uint8Array, _token: vscode.CancellationToken): vscode.NotebookData {
        const { cells, warnings } = parseExabookCells(new TextDecoder().decode(content));

        for (const w of warnings) {
            vscode.window.showWarningMessage(w);
        }

        const notebookCells = cells.map(cell => new vscode.NotebookCellData(
            cell.kind === 1 ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code,
            cell.value,
            cell.language,
        ));

        return new vscode.NotebookData(notebookCells);
    }

    serializeNotebook(data: vscode.NotebookData, _token: vscode.CancellationToken): Uint8Array {
        const raw = data.cells.map(cell => ({
            kind: cell.kind === vscode.NotebookCellKind.Markup ? 1 : 2,
            language: cell.languageId,
            value: cell.value
        }));

        return new TextEncoder().encode(JSON.stringify(raw, null, 2));
    }
}
