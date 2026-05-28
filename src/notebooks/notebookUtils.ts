export interface RawNotebookCell {
    kind: number; // 1 = Markup, 2 = Code
    language: string;
    value: string;
}

export interface ParseResult {
    cells: RawNotebookCell[];
    warnings: string[];
}

/** Parse raw .exabook JSON text into validated cell objects. */
export function parseExabookCells(text: string): ParseResult {
    const warnings: string[] = [];
    let raw: unknown;

    try {
        raw = text.trim() ? JSON.parse(text) : [];
    } catch {
        warnings.push('Failed to parse .exabook file — opening as empty notebook.');
        return { cells: [], warnings };
    }

    if (!Array.isArray(raw)) {
        warnings.push('Invalid .exabook format — expected an array of cells.');
        return { cells: [], warnings };
    }

    const cells = raw
        .filter((cell: unknown): cell is Record<string, unknown> =>
            cell !== null && typeof cell === 'object' && typeof (cell as Record<string, unknown>).value === 'string'
        )
        .map(cell => ({
            kind: cell.kind === 1 ? 1 : 2,
            value: cell.value as string,
            language: typeof cell.language === 'string' ? cell.language : 'exasol-sql',
        }));

    return { cells, warnings };
}

