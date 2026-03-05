/**
 * CSV utility functions for Exasol extension.
 * Provides CSV header parsing and preview data extraction for file import.
 */
import * as fs from 'fs';
import * as readline from 'readline';

function parseCsvLine(line: string, separator: string): string[] {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;
    let i = 0;

    while (i < line.length) {
        const char = line[i];

        if (inQuotes) {
            if (char === '"') {
                // Check for escaped quote ""
                if (i + 1 < line.length && line[i + 1] === '"') {
                    current += '"';
                    i += 2;
                    continue;
                } else {
                    // End of quoted field
                    inQuotes = false;
                    i++;
                    continue;
                }
            } else {
                current += char;
                i++;
            }
        } else {
            if (char === '"' && current.trim() === '') {
                // Start of quoted field (only if we haven't accumulated non-whitespace content)
                inQuotes = true;
                current = '';
                i++;
            } else if (line.substring(i, i + separator.length) === separator) {
                // Field separator found
                fields.push(current.trim());
                current = '';
                i += separator.length;
            } else {
                current += char;
                i++;
            }
        }
    }

    // Push the last field
    fields.push(current.trim());

    return fields;
}

/**
 * Read the first line of a CSV file and parse column names.
 *
 * Uses `fs.createReadStream` and `readline` to efficiently read only the first
 * line without loading the entire file into memory.
 *
 * @param filePath Absolute path to the CSV file
 * @param separator Column separator character (default: ',')
 * @returns Array of column name strings parsed from the header row
 * @throws Error if the file is empty, has no header, or cannot be read
 */
export async function parseCsvHeader(filePath: string, separator: string = ','): Promise<string[]> {
    // Verify file exists before opening a stream to give a clear error
    await fs.promises.access(filePath, fs.constants.R_OK);

    return new Promise<string[]>((resolve, reject) => {
        let settled = false;

        function settle(fn: () => void): void {
            if (!settled) {
                settled = true;
                fn();
            }
        }

        const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });

        stream.on('error', (err: NodeJS.ErrnoException) => {
            rl.close();
            settle(() => reject(err));
        });

        const rl = readline.createInterface({
            input: stream,
            crlfDelay: Infinity
        });

        let headerFound = false;

        rl.on('line', (line: string) => {
            headerFound = true;
            rl.close();
            stream.destroy();

            const trimmedLine = line.trim();
            if (!trimmedLine) {
                settle(() => reject(new Error('CSV file is empty or has no header: first line is blank')));
                return;
            }

            const columns = parseCsvLine(trimmedLine, separator);

            if (columns.length === 0 || (columns.length === 1 && columns[0] === '')) {
                settle(() => reject(new Error('CSV file is empty or has no header: no column names found')));
                return;
            }

            settle(() => resolve(columns));
        });

        rl.on('close', () => {
            if (!headerFound) {
                settle(() => reject(new Error('CSV file is empty or has no header')));
            }
        });
    });
}

export interface CsvPreviewData {
    columns: string[];
    rows: string[][];
}

export async function parseCsvPreview(filePath: string, separator: string = ',', maxRows: number = 10): Promise<CsvPreviewData> {
    // Verify file exists before opening a stream to give a clear error
    await fs.promises.access(filePath, fs.constants.R_OK);

    return new Promise<CsvPreviewData>((resolve, reject) => {
        let settled = false;

        function settle(fn: () => void): void {
            if (!settled) {
                settled = true;
                fn();
            }
        }

        const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });

        stream.on('error', (err: NodeJS.ErrnoException) => {
            rl.close();
            settle(() => reject(err));
        });

        const rl = readline.createInterface({
            input: stream,
            crlfDelay: Infinity
        });

        let columns: string[] = [];
        const rows: string[][] = [];
        let lineIndex = 0;

        rl.on('line', (line: string) => {
            const trimmedLine = line.trim();

            if (lineIndex === 0) {
                // First line is the header
                if (!trimmedLine) {
                    rl.close();
                    stream.destroy();
                    settle(() => reject(new Error('CSV file is empty or has no header: first line is blank')));
                    return;
                }

                columns = parseCsvLine(trimmedLine, separator);

                if (columns.length === 0 || (columns.length === 1 && columns[0] === '')) {
                    rl.close();
                    stream.destroy();
                    settle(() => reject(new Error('CSV file is empty or has no header: no column names found')));
                    return;
                }
            } else {
                // Data rows
                if (trimmedLine) {
                    rows.push(parseCsvLine(trimmedLine, separator));
                }

                if (rows.length >= maxRows) {
                    rl.close();
                    stream.destroy();
                    settle(() => resolve({ columns, rows }));
                    return;
                }
            }

            lineIndex++;
        });

        rl.on('close', () => {
            if (lineIndex === 0) {
                settle(() => reject(new Error('CSV file is empty or has no header')));
            } else {
                settle(() => resolve({ columns, rows }));
            }
        });
    });
}
