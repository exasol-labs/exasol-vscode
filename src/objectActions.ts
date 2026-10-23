import * as vscode from 'vscode';
import { ConnectionManager, StoredConnection } from './connectionManager';
import { QueryExecutor, captureBaselineStatementIdentity } from './queryExecutor';
import { ResultsPanel } from './panels/resultsPanel';
import { getColumnsFromResult, getRowsFromResult, rawQuery, rawExecute, extractColumnMetadata, extractColumnName, escapeSqlString, escapeSqlIdentifier, columnsViewFor, SqlError, stripFinalSlashLine, stripCommentsPreservingStrings } from './utils';
import { formatError } from './connectionTypes';
import { isExecutionPlanEnabled } from './settings';

export class ObjectActions {
    constructor(
        private connectionManager: ConnectionManager,
        private queryExecutor: QueryExecutor,
        private extensionUri: vscode.Uri
    ) {}

    async previewTableData(
        connection: StoredConnection,
        schemaName: string,
        tableName: string,
        limit: number = 100,
        showNotification: boolean = true
    ) {
        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Loading preview for ${schemaName}.${tableName}...`,
                    cancellable: false
                },
                async () => {
                    const query = `SELECT * FROM "${escapeSqlIdentifier(schemaName)}"."${escapeSqlIdentifier(tableName)}" LIMIT ${limit}`;
                    const queryResult = await this.connectionManager.executeWithRetry(async () => {
                        const driver = await this.connectionManager.getDriver(connection.id);
                        const shouldCapturePlanIdentity = isExecutionPlanEnabled()
                            && (this.connectionManager.isExecutionPlanAvailable?.(connection.id) ?? true);

                        const identity = shouldCapturePlanIdentity
                            ? await captureBaselineStatementIdentity(driver)
                            : {};
                        const startTime = Date.now();
                        const result = await rawQuery(driver, query);
                        const executionTime = Date.now() - startTime;

                        const columnsMeta = getColumnsFromResult(result);
                        const rows = getRowsFromResult(result);
                        const columns = columnsMeta.map(extractColumnName);
                        const columnMetadata = extractColumnMetadata(columnsMeta);

                        return {
                            columns,
                            columnMetadata,
                            rows,
                            rowCount: rows.length,
                            executionTime,
                            connectionId: connection.id,
                            ...identity
                        };
                    }, connection.id);

                    await ResultsPanel.show(queryResult, query);
                    if (showNotification) {
                        vscode.window.showInformationMessage(
                            `Preview: ${queryResult.rowCount} rows from ${schemaName}.${tableName}`
                        );
                    }
                }
            );
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to preview table: ${error}`);
        }
    }

    async showTableDDL(connection: StoredConnection, schemaName: string, tableName: string) {
        try {
            const rows = await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connection.id);
                const query = `
                    SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT, COLUMN_IS_NULLABLE, COLUMN_COMMENT
                    FROM SYS.EXA_ALL_COLUMNS
                    WHERE COLUMN_SCHEMA = '${escapeSqlString(schemaName)}'
                    AND COLUMN_TABLE = '${escapeSqlString(tableName)}'
                    AND (COLUMN_OBJECT_TYPE = 'TABLE' OR COLUMN_OBJECT_TYPE IS NULL)
                    ORDER BY COLUMN_ORDINAL_POSITION
                `;
                const result = await rawQuery(driver, query);
                return getRowsFromResult<{
                    COLUMN_NAME: string;
                    COLUMN_TYPE: string;
                    COLUMN_DEFAULT: string | null;
                    COLUMN_IS_NULLABLE: boolean | null;
                    COLUMN_COMMENT: string | null;
                }>(result);
            }, connection.id);

            if (rows.length === 0) {
                showNoVisibleColumns(schemaName, tableName);
                return;
            }

            // Build DDL
            let ddl = `CREATE TABLE "${escapeSqlIdentifier(schemaName)}"."${escapeSqlIdentifier(tableName)}" (\n`;
            const columns = rows.map(row => {
                // Query is scoped to COLUMN_OBJECT_TYPE = 'TABLE' (or unset), where
                // COLUMN_IS_NULLABLE is never null.
                const nullable = row.COLUMN_IS_NULLABLE === false ? ' NOT NULL' : '';
                const defaultVal = row.COLUMN_DEFAULT ? ` DEFAULT ${row.COLUMN_DEFAULT}` : '';
                const comment = row.COLUMN_COMMENT ? ` -- ${row.COLUMN_COMMENT}` : '';
                return `    "${escapeSqlIdentifier(row.COLUMN_NAME)}" ${row.COLUMN_TYPE}${nullable}${defaultVal}${comment}`;
            });
            ddl += columns.join(',\n');
            ddl += '\n);';

            await openSqlDocument(ddl);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to get table DDL: ${formatError(error)}`);
        }
    }

    async showViewDDL(connection: StoredConnection, schemaName: string, viewName: string) {
        try {
            const rows = await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connection.id);
                const query = `
                    SELECT VIEW_TEXT
                    FROM SYS.EXA_ALL_VIEWS
                    WHERE VIEW_SCHEMA = '${escapeSqlString(schemaName)}'
                    AND VIEW_NAME = '${escapeSqlString(viewName)}'
                `;
                const result = await rawQuery(driver, query);
                return getRowsFromResult<{ VIEW_TEXT: string }>(result);
            }, connection.id);

            if (rows.length > 0) {
                await openSqlDocument(qualifyViewText(rows[0].VIEW_TEXT, schemaName, viewName));
            } else {
                vscode.window.showWarningMessage(
                    `No view visible for "${escapeSqlIdentifier(schemaName)}"."${escapeSqlIdentifier(viewName)}"`
                );
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to get view DDL: ${formatError(error)}`);
        }
    }

    async generateSelectStatement(connection: StoredConnection, schemaName: string, tableName: string) {
        try {
            const rows = await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connection.id);
                const query = `
                    SELECT COLUMN_NAME
                    FROM ${columnsViewFor(schemaName)}
                    WHERE COLUMN_SCHEMA = '${escapeSqlString(schemaName)}'
                    AND COLUMN_TABLE = '${escapeSqlString(tableName)}'
                    ORDER BY COLUMN_ORDINAL_POSITION
                `;
                const result = await rawQuery(driver, query);
                return getRowsFromResult<{ COLUMN_NAME: string }>(result);
            }, connection.id);

            if (rows.length === 0) {
                showNoVisibleColumns(schemaName, tableName);
                return;
            }

            const columns = rows.map(row => `    "${escapeSqlIdentifier(row.COLUMN_NAME)}"`).join(',\n');

            const selectStatement = `SELECT\n${columns}\nFROM "${escapeSqlIdentifier(schemaName)}"."${escapeSqlIdentifier(tableName)}"\nLIMIT 100;`;

            await openSqlDocument(selectStatement);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to generate SELECT statement: ${error}`);
        }
    }

    private async fetchScript(connection: StoredConnection, schemaName: string, scriptName: string) {
        const rows = await this.connectionManager.executeWithRetry(async () => {
            const driver = await this.connectionManager.getDriver(connection.id);
            const query = `
                SELECT SCRIPT_TEXT, SCRIPT_INPUT_TYPE
                FROM SYS.EXA_ALL_SCRIPTS
                WHERE SCRIPT_SCHEMA = '${escapeSqlString(schemaName)}'
                AND SCRIPT_NAME = '${escapeSqlString(scriptName)}'
            `;
            const result = await rawQuery(driver, query);
            return getRowsFromResult<{ SCRIPT_TEXT: string; SCRIPT_INPUT_TYPE: string | null }>(result);
        }, connection.id);
        if (rows.length === 0) {
            vscode.window.showWarningMessage(`Script definition not found for ${schemaName}.${scriptName}`);
        }
        return rows[0];
    }

    async openScriptSource(connection: StoredConnection, schemaName: string, scriptName: string) {
        try {
            const script = await this.fetchScript(connection, schemaName, scriptName);
            if (script) {
                await openSqlDocument(qualifyScriptText(script.SCRIPT_TEXT, schemaName, scriptName));
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to get script source: ${error}`);
        }
    }

    async generateScriptCall(connection: StoredConnection, schemaName: string, scriptName: string) {
        try {
            const script = await this.fetchScript(connection, schemaName, scriptName);
            if (script) {
                await openSqlDocument(buildScriptCall(script.SCRIPT_TEXT, schemaName, scriptName, script.SCRIPT_INPUT_TYPE));
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to generate script call: ${error}`);
        }
    }

    async openFunctionSource(connection: StoredConnection, schemaName: string, functionName: string) {
        try {
            const rows = await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connection.id);
                const query = `
                    SELECT FUNCTION_TEXT
                    FROM SYS.EXA_ALL_FUNCTIONS
                    WHERE FUNCTION_SCHEMA = '${escapeSqlString(schemaName)}'
                    AND FUNCTION_NAME = '${escapeSqlString(functionName)}'
                `;
                const result = await rawQuery(driver, query);
                return getRowsFromResult<{ FUNCTION_TEXT: string }>(result);
            }, connection.id);

            if (rows.length > 0) {
                await openSqlDocument(qualifyFunctionText(rows[0].FUNCTION_TEXT, schemaName, functionName));
            } else {
                vscode.window.showWarningMessage(`Function definition not found for ${schemaName}.${functionName}`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to get function source: ${error}`);
        }
    }

    async describeTable(connection: StoredConnection, schemaName: string, tableName: string) {
        try {
            const query = `
                    SELECT
                        COLUMN_NAME,
                        COLUMN_TYPE,
                        COLUMN_IS_NULLABLE,
                        COLUMN_DEFAULT,
                        COLUMN_COMMENT
                    FROM ${columnsViewFor(schemaName)}
                    WHERE COLUMN_SCHEMA = '${escapeSqlString(schemaName)}'
                    AND COLUMN_TABLE = '${escapeSqlString(tableName)}'
                    ORDER BY COLUMN_ORDINAL_POSITION
                `;
            const queryResult = await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connection.id);

                const startTime = Date.now();
                const result = await rawQuery(driver, query);
                const executionTime = Date.now() - startTime;

                const columnsMeta = getColumnsFromResult(result);
                const rows = getRowsFromResult(result);
                const columns = columnsMeta.map(extractColumnName);
                const columnMetadata = extractColumnMetadata(columnsMeta);

                return {
                    columns,
                    columnMetadata,
                    rows,
                    rowCount: rows.length,
                    executionTime
                };
            }, connection.id);

            if (queryResult.rowCount === 0) {
                showNoVisibleColumns(schemaName, tableName);
                return;
            }

            ResultsPanel.show(queryResult, query);
            vscode.window.showInformationMessage(`Table structure: ${schemaName}.${tableName}`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to describe table: ${error}`);
        }
    }

    /** Returns true when the refresh succeeded, so the caller can reload the tree node. */
    async refreshVirtualSchema(connection: StoredConnection, schemaName: string, tableName?: string): Promise<boolean> {
        const target = tableName ? `${schemaName}.${tableName}` : schemaName;
        try {
            const tablesClause = tableName ? ` TABLES "${escapeSqlIdentifier(tableName)}"` : '';
            const query = `ALTER VIRTUAL SCHEMA "${escapeSqlIdentifier(schemaName)}" REFRESH${tablesClause}`;
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Refreshing virtual schema metadata for ${target}...`,
                    cancellable: false
                },
                () => this.connectionManager.executeWithRetry(async () => {
                    const driver = await this.connectionManager.getDriver(connection.id);
                    // Raw responses carry SQL errors as status, not as a throw.
                    getRowsFromResult(await rawExecute(driver, query));
                }, connection.id)
            );
            vscode.window.setStatusBarMessage(`Exasol: Refreshed virtual schema metadata for ${target}`, 3000);
            return true;
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to refresh virtual schema: ${error}`);
            return false;
        }
    }

    async explainPushdown(connection: StoredConnection, schemaName: string, tableName: string) {
        try {
            const query = `EXPLAIN VIRTUAL SELECT * FROM "${escapeSqlIdentifier(schemaName)}"."${escapeSqlIdentifier(tableName)}" LIMIT 10`;
            const queryResult = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Explaining pushdown for ${schemaName}.${tableName}...`,
                    cancellable: false
                },
                () => this.connectionManager.executeWithRetry(async () => {
                    const driver = await this.connectionManager.getDriver(connection.id);

                    const startTime = Date.now();
                    const result = await rawQuery(driver, query);
                    const executionTime = Date.now() - startTime;

                    const columnsMeta = getColumnsFromResult(result);
                    const rows = getRowsFromResult(result);
                    const columns = columnsMeta.map(extractColumnName);
                    const columnMetadata = extractColumnMetadata(columnsMeta);

                    return {
                        columns,
                        columnMetadata,
                        rows,
                        rowCount: rows.length,
                        executionTime
                    };
                }, connection.id)
            );

            ResultsPanel.show(queryResult, query);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to explain pushdown: ${error}`);
        }
    }

    /**
     * Opens CREATE OR REPLACE CONNECTION for a connection. Address and user
     * come from EXA_DBA_CONNECTIONS; without access to it the statement keeps
     * placeholders and `comment` comes from the tree node.
     */
    async showConnectionDDL(connection: StoredConnection, connectionName: string, comment?: string) {
        try {
            const definition = await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connection.id);
                // SELECT *: PUBLIC_KEY and CLIENT_ID do not exist in older versions.
                const query = `
                    SELECT *
                    FROM SYS.EXA_DBA_CONNECTIONS
                    WHERE CONNECTION_NAME = '${escapeSqlString(connectionName)}'
                `;
                try {
                    const rows = getRowsFromResult<ConnectionDefinition>(await rawQuery(driver, query));
                    return rows.length > 0 ? rows[0] : null;
                } catch (error) {
                    if (error instanceof SqlError && error.sqlCode === INSUFFICIENT_PRIVILEGES) {
                        return undefined;
                    }
                    throw error;
                }
            }, connection.id);

            if (definition === null) {
                vscode.window.showWarningMessage(`Connection definition not found for ${connectionName}`);
                return;
            }
            await openSqlDocument(definition
                ? buildConnectionDDL(connectionName, definition.CONNECTION_COMMENT, definition)
                : buildConnectionDDL(connectionName, comment ?? null));
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to get connection DDL: ${error}`);
        }
    }

    /** Opens an IMPORT or EXPORT template for the connection in a new tab. */
    async generateTransfer(direction: TransferDirection, connectionName: string) {
        await openSqlDocument(buildTransferTemplate(direction, connectionName));
    }
}

/** Exasol error code for a missing privilege, e.g. on EXA_DBA_CONNECTIONS. */
const INSUFFICIENT_PRIVILEGES = '42500';

/**
 * A row of EXA_DBA_CONNECTIONS; there is no password column. PUBLIC_KEY and
 * CLIENT_ID are missing in older versions.
 */
interface ConnectionDefinition {
    CONNECTION_STRING: string;
    USER_NAME: string | null;
    PUBLIC_KEY?: string | null;
    CLIENT_ID?: string | null;
    CONNECTION_COMMENT: string | null;
}

/**
 * CREATE OR REPLACE CONNECTION plus COMMENT ON CONNECTION. Without a
 * definition (EXA_DBA_CONNECTIONS not readable) address and user become
 * placeholders. The password is never readable, so it is always one.
 */
export function buildConnectionDDL(
    connectionName: string,
    comment: string | null,
    definition?: Omit<ConnectionDefinition, 'CONNECTION_COMMENT'>
): string {
    const name = `"${escapeSqlIdentifier(connectionName)}"`;
    const lines: string[] = [];
    if (!definition) {
        lines.push(
            '-- Address and user are readable only with the SELECT ANY DICTIONARY system privilege.',
            `CREATE OR REPLACE CONNECTION ${name}`,
            "    TO '<address>'",
            "    USER '<user>'",
            "    IDENTIFIED BY '<password>';"
        );
    } else {
        for (const column of ['PUBLIC_KEY', 'CLIENT_ID'] as const) {
            // Exasol stores an empty string as NULL, so a value is never ''.
            if (definition[column]) {
                lines.push(`-- Note: ${column} is set on this connection and is not part of this statement.`);
            }
        }
        lines.push(`CREATE OR REPLACE CONNECTION ${name}`, `    TO '${escapeSqlString(definition.CONNECTION_STRING)}'`);
        if (definition.USER_NAME !== null) {
            lines.push(`    USER '${escapeSqlString(definition.USER_NAME)}'`, "    IDENTIFIED BY '<password>'");
        }
        lines[lines.length - 1] += ';';
    }
    if (comment !== null) {
        lines.push(`COMMENT ON CONNECTION ${name} IS '${escapeSqlString(comment)}';`);
    }
    return lines.join('\n');
}

type TransferDirection = 'IMPORT' | 'EXPORT';

/**
 * IMPORT or EXPORT through a connection: a CSV file statement plus the other
 * documented sources (IMPORT) or destinations (EXPORT) as commented
 * alternatives. EXPORT writes CSV and FBV files only, no Parquet. Names are
 * placeholder identifiers, so every variant parses as written.
 */
export function buildTransferTemplate(direction: TransferDirection, connectionName: string): string {
    const at = `AT "${escapeSqlIdentifier(connectionName)}"`;
    const [clause, statement] = direction === 'IMPORT' ? ['FROM', "'<SELECT ...>'"] : ['INTO', "'<INSERT ... VALUES (?, ?)>'"];
    const files = direction === 'IMPORT' ? ['FBV', 'PARQUET'] : ['FBV'];
    const alternatives = [
        ...files.map(format => `${clause} ${format} ${at} FILE '<path/file.${format.toLowerCase()}>'`),
        ...['EXA', 'ORA', 'JDBC'].flatMap(type => [
            `${clause} ${type} ${at} TABLE remote_schema.remote_table`,
            `${clause} ${type} ${at} STATEMENT ${statement}`
        ])
    ];
    return [
        direction === 'IMPORT' ? 'IMPORT INTO my_schema.my_table' : 'EXPORT my_schema.my_table',
        `${clause} CSV ${at} FILE '<path/file.csv>';`,
        `-- Other ${direction === 'IMPORT' ? 'sources' : 'destinations'}, replace the ${clause} line:`,
        ...alternatives.map(line => `-- ${line};`)
    ].join('\n');
}

function showNoVisibleColumns(schemaName: string, tableName: string): void {
    vscode.window.showWarningMessage(
        `No columns visible for "${escapeSqlIdentifier(schemaName)}"."${escapeSqlIdentifier(tableName)}"`
    );
}

async function openSqlDocument(content: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({ content, language: 'exasol-sql' });
    await vscode.window.showTextDocument(doc);
}

/** A quoted identifier, with "" standing for one double quote inside it. */
const QUOTED_IDENTIFIER = '"(?:[^"]|"")*"';

/**
 * One part of an object name: quoted, or unquoted up to a space, dot, quote,
 * parenthesis, semicolon or comment start (unquoted identifiers contain none
 * of these, and a comment may touch the name).
 */
const NAME_PART = `(?:${QUOTED_IDENTIFIER}|[^\\s."(/;-]+)`;

/**
 * Whitespace, block comments and line comments, any number of them. Each
 * alternative starts with a different character and matches one whitespace
 * character at a time, so a failed match backtracks in linear time.
 */
const GAP = '(?:\\s|/\\*(?:[^*]|\\*(?!/))*\\*/|--[^\\n]*\\n)*';

/** An object name with an optional schema; comments may surround the dot. */
const OBJECT_NAME = `${NAME_PART}(?:${GAP}\\.${GAP}${NAME_PART})?`;

/** `CREATE <language> [SCALAR|SET|ADAPTER] SCRIPT "NAME"`, as stored in SCRIPT_TEXT. */
const SCRIPT_HEADER = new RegExp(`^CREATE\\s+([^"]*?\\bSCRIPT\\s+)${QUOTED_IDENTIFIER}`, 'i');
const QUOTED_NAME_START = new RegExp(`^${QUOTED_IDENTIFIER}`);

/**
 * Turns SCRIPT_TEXT into a statement that recreates the script in its own
 * schema. The database stores the header as `CREATE <...> SCRIPT "NAME"`,
 * without schema and without OR REPLACE, so running it unchanged would create
 * the script in the current schema. Only the header changes; the body is kept
 * byte for byte. A `/` line closes the statement, as the body may contain
 * semicolons. Text with an unexpected header is returned unchanged.
 */
export function qualifyScriptText(scriptText: string, schemaName: string, scriptName: string): string {
    const header = SCRIPT_HEADER.exec(scriptText);
    if (!header) {
        return scriptText;
    }
    const name = `"${escapeSqlIdentifier(schemaName)}"."${escapeSqlIdentifier(scriptName)}"`;
    return `CREATE OR REPLACE ${header[1]}${name}${stripFinalSlashLine(scriptText.slice(header[0].length))}\n/`;
}

/**
 * Turns FUNCTION_TEXT into a statement that recreates the function in its own
 * schema. The database stores the text as written after `CREATE [OR REPLACE]`,
 * so the name may lack the schema, and `SCHEMA . NAME` keeps the spaces and
 * comments around the dot; it is replaced by the quoted qualified name. A `/` line closes the statement, as
 * for scripts.
 */
export function qualifyFunctionText(functionText: string, schemaName: string, functionName: string): string {
    // A client that sent the `/` line along with the statement leaves it in FUNCTION_TEXT.
    const text = stripFinalSlashLine(functionText);
    const header = new RegExp(`^(FUNCTION\\s+)${OBJECT_NAME}`, 'i').exec(text);
    if (!header) {
        return `CREATE OR REPLACE ${text}\n/`;
    }
    const name = `"${escapeSqlIdentifier(schemaName)}"."${escapeSqlIdentifier(functionName)}"`;
    return `CREATE OR REPLACE ${header[1]}${name}${text.slice(header[0].length)}\n/`;
}

/** Leading comments, `CREATE [OR REPLACE] [FORCE] VIEW` and the name, which may lack the schema. */
const VIEW_HEADER = new RegExp(
    `^(${GAP})CREATE\\s+(?:OR\\s+REPLACE\\s+)?((?:FORCE\\s+)?VIEW\\s+)${OBJECT_NAME}`,
    'i'
);

/**
 * Turns VIEW_TEXT into a statement that recreates the view in its own schema.
 * The database stores the whole statement as written, so OR REPLACE may be
 * missing and the name may lack the schema. The header becomes
 * `CREATE OR REPLACE [FORCE] VIEW "SCHEMA"."NAME"`; leading comments and the
 * rest are kept. The text may end with a comment, so an unterminated
 * statement gets the `;` on a line of its own. Text with an unexpected header
 * is only given the `;`.
 */
export function qualifyViewText(viewText: string, schemaName: string, viewName: string): string {
    const terminated = /;\s*$/.test(stripCommentsPreservingStrings(viewText)) ? viewText : `${viewText}\n;`;
    const header = VIEW_HEADER.exec(terminated);
    if (!header) {
        return terminated;
    }
    const name = `"${escapeSqlIdentifier(schemaName)}"."${escapeSqlIdentifier(viewName)}"`;
    return `${header[1]}CREATE OR REPLACE ${header[2]}${name}${terminated.slice(header[0].length)}`;
}

/**
 * The quoted parameter names of a UDF, read from the parameter list after
 * the name in SCRIPT_TEXT: 'dynamic' for `(...)`, undefined names when a
 * parameter name is not quoted. Types such as DECIMAL(18,0) contain commas, so
 * the list is split on commas outside parentheses and quoted names only. `end`
 * is the index after the closing parenthesis. Undefined when there is no
 * complete parameter list.
 */
function parseScriptParameters(scriptText: string): { names: string[] | 'dynamic' | undefined; end: number } | undefined {
    const header = SCRIPT_HEADER.exec(scriptText);
    const open = header ? /^\s*\(/.exec(scriptText.slice(header[0].length)) : null;
    if (!header || !open) {
        return undefined;
    }
    const parts: string[] = [];
    let depth = 0;
    let quoted = false;
    let start = header[0].length + open[0].length;
    for (let i = start; i < scriptText.length; i++) {
        const ch = scriptText[i];
        if (ch === '"') {
            quoted = !quoted;
        } else if (quoted) {
            continue;
        } else if (ch === '(') {
            depth++;
        } else if (ch === ',' && depth === 0) {
            parts.push(scriptText.slice(start, i).trim());
            start = i + 1;
        } else if (ch === ')' && depth > 0) {
            depth--;
        } else if (ch === ')') {
            parts.push(scriptText.slice(start, i).trim());
            const end = i + 1;
            if (parts.length === 1 && parts[0] === '') {
                return { names: [], end };
            }
            if (parts.length === 1 && parts[0] === '...') {
                return { names: 'dynamic', end };
            }
            const names = parts.map(part => QUOTED_NAME_START.exec(part)?.[0]);
            return { names: names.every((name): name is string => name !== undefined) ? names : undefined, end };
        }
    }
    return undefined;
}

/** `EMITS (...)` right after the parameter list, as SCRIPT_TEXT stores it. */
const DYNAMIC_OUTPUT = /^\s*EMITS\s*\(\s*\.\.\.\s*\)/i;

/**
 * A SELECT that calls the UDF, with its parameter names as column
 * placeholders and a FROM placeholder when the call takes input rows.
 * Dynamic or unreadable parameter lists get a comment placeholder, and an
 * unreadable list no FROM placeholder. Dynamic output (`EMITS (...)`) gets an
 * EMITS placeholder, also when the parameters cannot be read: the call fails without it
 * unless the script defines default_output_columns(), which the stored header
 * does not show.
 */
export function buildScriptCall(scriptText: string, schemaName: string, scriptName: string, inputType: string | null): string {
    const name = `"${escapeSqlIdentifier(schemaName)}"."${escapeSqlIdentifier(scriptName)}"`;
    const parameters = parseScriptParameters(scriptText);
    if (parameters === undefined) {
        return `SELECT ${name}(/* arguments */);`;
    }
    const emits = DYNAMIC_OUTPUT.test(scriptText.slice(parameters.end))
        ? ' EMITS (<column> <type>) /* remove when the script defines default_output_columns() */'
        : '';
    if (parameters.names === undefined) {
        return `SELECT ${name}(/* arguments */)${emits};`;
    }
    const args = parameters.names === 'dynamic' ? '/* arguments */' : parameters.names.join(', ');
    const from = args || inputType === 'SET' ? '\nFROM <table>' : '';
    return `SELECT ${name}(${args})${emits}${from};`;
}

/** What refreshVirtualSchemaAndReload needs from the extension's providers. */
interface VirtualSchemaRefreshTargets {
    objectActions: Pick<ObjectActions, 'refreshVirtualSchema'>;
    completionProvider: { clearCache(connectionId: string): void };
    objectTreeProvider: { refresh(): void };
}

/**
 * Runs Refresh Metadata for a virtual schema, or for one virtual table when
 * `tableName` is given. Only a successful refresh clears the connection's
 * completion cache and reloads the Objects view.
 */
export async function refreshVirtualSchemaAndReload(
    targets: VirtualSchemaRefreshTargets,
    connection: StoredConnection,
    schemaName: string,
    tableName?: string
): Promise<void> {
    if (await targets.objectActions.refreshVirtualSchema(connection, schemaName, tableName)) {
        targets.completionProvider.clearCache(connection.id);
        // Both refresh forms update the schema's LAST_REFRESH, which the
        // virtual schema node shows in its tooltip. Stable node ids keep the
        // expansion state, so expanded nodes reload their children.
        targets.objectTreeProvider.refresh();
    }
}
