import * as vscode from 'vscode';
import { ConnectionManager } from '../connectionManager';
import { getRowsFromResult } from '../utils';

interface DatabaseObject {
    schema: string;
    name: string;
    type: 'table' | 'view';
    columns?: string[];
}

export class ExasolCompletionProvider implements vscode.CompletionItemProvider {
    private cache: Map<string, DatabaseObject[]> = new Map();
    private cacheExpiry: Map<string, number> = new Map();
    private schemasCache: Map<string, string[]> = new Map();
    private reservedKeywords: Set<string> = new Set();
    private reservedKeywordsLoaded = false;
    private readonly CACHE_TTL = 300000; // 5 minutes

    constructor(private connectionManager: ConnectionManager) {}

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[]> {
        const config = vscode.workspace.getConfiguration('exasol');
        if (!config.get<boolean>('autoComplete', true)) {
            return [];
        }

        const activeConnection = this.connectionManager.getActiveConnection();
        if (!activeConnection) {
            return [];
        }

        const items: vscode.CompletionItem[] = [];

        // Get the text before cursor
        const linePrefix = document.lineAt(position).text.substring(0, position.character);
        const wordRange = document.getWordRangeAtPosition(position);
        const word = wordRange ? document.getText(wordRange) : '';

        // Get the entire query text for alias detection
        const queryText = document.getText();

        try {
            // Load reserved keywords if not already loaded
            if (!this.reservedKeywordsLoaded) {
                await this.loadReservedKeywords(activeConnection.id);
            }

            // Add database objects (tables, views) - needed for alias resolution
            const objects = await this.getDatabaseObjects(activeConnection.id);

            // Parse aliases from the query
            const aliases = this.parseAliases(queryText);

            // Check for schema.table. pattern first (highest priority)
            const schemaTableMatch = linePrefix.match(/(\w+)\.(\w+)\.\s*$/);
            if (schemaTableMatch) {
                const schemaName = schemaTableMatch[1].toUpperCase();
                const tableName = schemaTableMatch[2].toUpperCase();
                const obj = objects.find(o => o.schema === schemaName && o.name === tableName);
                if (obj && obj.columns) {
                    return this.getColumnCompletions(obj.columns);
                }
            }

            // Check if we're completing after an alias or table name (e.g., "u." or "users.")
            const aliasMatch = linePrefix.match(/(\w+)\.\s*$/);
            if (aliasMatch) {
                const prefix = aliasMatch[1];
                const prefixUpper = prefix.toUpperCase();

                // Check if it's an alias - return ONLY columns for that table
                if (aliases.has(prefixUpper)) {
                    const tableName = aliases.get(prefixUpper)!;
                    const obj = objects.find(o => o.name === tableName.toUpperCase());
                    if (obj && obj.columns) {
                        return this.getColumnCompletions(obj.columns);
                    }
                }

                // Check if it's a schema prefix (e.g., "schema.")
                const schemaObjects = objects.filter(obj => obj.schema === prefixUpper);
                if (schemaObjects.length > 0) {
                    return this.getObjectCompletions(schemaObjects, true);
                }

                // Check if it's a table/view prefix (e.g., "table.")
                const obj = objects.find(o => o.name === prefixUpper);
                if (obj && obj.columns) {
                    return this.getColumnCompletions(obj.columns);
                }
            }

            // No specific context - provide all completions
            // Add SQL keywords
            items.push(...this.getKeywordCompletions());

            // Add SQL functions
            items.push(...this.getFunctionCompletions());

            // Add schemas
            const schemas = await this.getSchemas(activeConnection.id);
            items.push(...this.getSchemaCompletions(schemas));

            // Add database objects (tables, views)
            items.push(...this.getObjectCompletions(objects));

            return items;
        } catch (error) {
            console.error('Error providing completions:', error);
            return items;
        }
    }

    private parseAliases(queryText: string): Map<string, string> {
        const aliases = new Map<string, string>();

        // Pattern to match: FROM/JOIN table_name [AS] alias
        // Handles: FROM, INNER JOIN, LEFT JOIN, RIGHT JOIN, FULL JOIN, CROSS JOIN, etc.
        // Examples:
        //   "FROM users u"
        //   "FROM users AS u"
        //   "INNER JOIN orders o"
        //   "LEFT OUTER JOIN products p"
        //   "FROM schema.table t"
        //   "JOIN \"Table\" AS t"

        // Match FROM/JOIN patterns with optional schema and optional AS keyword
        const tableAliasPattern = /(?:from|(?:(?:inner|left|right|full|cross)\s+)?(?:outer\s+)?join)\s+(?:(\w+)\.)?(?:")?(\w+)(?:")?\s+(?:as\s+)?(\w+)(?=\s|,|$|where|join|order|group|limit|;)/gi;

        let match;
        while ((match = tableAliasPattern.exec(queryText)) !== null) {
            const schema = match[1]; // Optional schema
            const table = match[2];  // Table name
            const alias = match[3];  // Alias

            // Store alias -> table mapping (uppercase for case-insensitive lookup)
            // Only if alias is different from table name
            if (alias && table && alias.toUpperCase() !== table.toUpperCase()) {
                // Don't add if alias is a SQL keyword (to avoid false matches)
                const aliasUpper = alias.toUpperCase();
                if (!['ON', 'WHERE', 'ORDER', 'GROUP', 'HAVING', 'LIMIT', 'UNION', 'INTERSECT', 'EXCEPT'].includes(aliasUpper)) {
                    aliases.set(aliasUpper, table);
                }
            }
        }

        return aliases;
    }

    private async loadReservedKeywords(connectionId: string): Promise<void> {
        try {
            const driver = await this.connectionManager.getDriver(connectionId);
            const result = await this.safeQuery(driver, 'SELECT keyword FROM sys.exa_sql_keywords WHERE reserved');
            const rows = getRowsFromResult(result);
            this.reservedKeywords = new Set(rows.map((r: any) => r.KEYWORD.toUpperCase()));
            this.reservedKeywordsLoaded = true;
        } catch (error) {
            console.error('Failed to load reserved keywords:', error);
            // Fallback to common reserved keywords
            this.reservedKeywords = new Set([
                'SELECT', 'FROM', 'WHERE', 'JOIN', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER',
                'TABLE', 'VIEW', 'INDEX', 'SCHEMA', 'DATABASE', 'AS', 'ON', 'AND', 'OR', 'NOT', 'IN', 'EXISTS'
            ]);
            this.reservedKeywordsLoaded = true;
        }
    }

    private quoteIdentifier(identifier: string): string {
        const upperIdent = identifier.toUpperCase();
        // Only quote if it's a reserved keyword
        if (this.reservedKeywords.has(upperIdent)) {
            return `"${identifier.toLowerCase()}"`;
        }
        return identifier.toLowerCase();
    }

    private getKeywordCompletions(): vscode.CompletionItem[] {
        const keywords = [
            'select', 'from', 'where', 'join', 'inner', 'left', 'right', 'full', 'outer',
            'on', 'and', 'or', 'not', 'in', 'exists', 'between', 'like', 'is', 'null',
            'order', 'by', 'group', 'having', 'limit', 'offset',
            'insert', 'into', 'values', 'update', 'set', 'delete',
            'create', 'alter', 'drop', 'table', 'view', 'index', 'schema', 'database',
            'as', 'distinct', 'all', 'union', 'intersect', 'except',
            'case', 'when', 'then', 'else', 'end',
            'cast', 'convert', 'coalesce', 'nullif',
            'with', 'recursive', 'cte',
            'primary', 'key', 'foreign', 'references', 'unique', 'check', 'default',
            'constraint', 'cascade', 'restrict',
            'grant', 'revoke', 'to',
            'commit', 'rollback', 'savepoint',
            'truncate', 'analyze', 'vacuum'
        ];

        return keywords.map(keyword => {
            const item = new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword);
            item.insertText = keyword;
            item.sortText = `2_${keyword}`;
            return item;
        });
    }

    private getFunctionCompletions(): vscode.CompletionItem[] {
        const functions = [
            // Aggregate functions
            { name: 'count', snippet: 'count(${1:column})' },
            { name: 'sum', snippet: 'sum(${1:column})' },
            { name: 'avg', snippet: 'avg(${1:column})' },
            { name: 'min', snippet: 'min(${1:column})' },
            { name: 'max', snippet: 'max(${1:column})' },
            { name: 'stddev', snippet: 'stddev(${1:column})' },
            { name: 'variance', snippet: 'variance(${1:column})' },

            // String functions
            { name: 'concat', snippet: 'concat(${1:str1}, ${2:str2})' },
            { name: 'substring', snippet: 'substring(${1:str}, ${2:start}, ${3:length})' },
            { name: 'substr', snippet: 'substr(${1:str}, ${2:start}, ${3:length})' },
            { name: 'upper', snippet: 'upper(${1:str})' },
            { name: 'lower', snippet: 'lower(${1:str})' },
            { name: 'trim', snippet: 'trim(${1:str})' },
            { name: 'ltrim', snippet: 'ltrim(${1:str})' },
            { name: 'rtrim', snippet: 'rtrim(${1:str})' },
            { name: 'length', snippet: 'length(${1:str})' },
            { name: 'replace', snippet: 'replace(${1:str}, ${2:old}, ${3:new})' },

            // Date/Time functions
            { name: 'current_date', snippet: 'current_date' },
            { name: 'current_timestamp', snippet: 'current_timestamp' },
            { name: 'add_days', snippet: 'add_days(${1:date}, ${2:days})' },
            { name: 'add_months', snippet: 'add_months(${1:date}, ${2:months})' },
            { name: 'add_years', snippet: 'add_years(${1:date}, ${2:years})' },
            { name: 'extract', snippet: 'extract(${1:year} from ${2:date})' },
            { name: 'date_trunc', snippet: 'date_trunc(${1:\'day\'}, ${2:timestamp})' },

            // Math functions
            { name: 'abs', snippet: 'abs(${1:number})' },
            { name: 'round', snippet: 'round(${1:number}, ${2:decimals})' },
            { name: 'floor', snippet: 'floor(${1:number})' },
            { name: 'ceil', snippet: 'ceil(${1:number})' },
            { name: 'sqrt', snippet: 'sqrt(${1:number})' },
            { name: 'power', snippet: 'power(${1:base}, ${2:exponent})' },

            // Window functions
            { name: 'row_number', snippet: 'row_number() over (${1:order by column})' },
            { name: 'rank', snippet: 'rank() over (${1:order by column})' },
            { name: 'dense_rank', snippet: 'dense_rank() over (${1:order by column})' },
            { name: 'lag', snippet: 'lag(${1:column}, ${2:offset}) over (${3:order by column})' },
            { name: 'lead', snippet: 'lead(${1:column}, ${2:offset}) over (${3:order by column})' },

            // Null handling
            { name: 'coalesce', snippet: 'coalesce(${1:value1}, ${2:value2})' },
            { name: 'nullif', snippet: 'nullif(${1:value1}, ${2:value2})' },
            { name: 'nvl', snippet: 'nvl(${1:value}, ${2:default})' }
        ];

        return functions.map(func => {
            const item = new vscode.CompletionItem(func.name, vscode.CompletionItemKind.Function);
            item.insertText = new vscode.SnippetString(func.snippet);
            item.detail = 'Exasol Function';
            item.sortText = `3_${func.name}`;
            return item;
        });
    }

    private getSchemaCompletions(schemas: string[]): vscode.CompletionItem[] {
        return schemas.map(schema => {
            const item = new vscode.CompletionItem(schema.toLowerCase(), vscode.CompletionItemKind.Module);
            item.detail = 'Schema';
            item.insertText = this.quoteIdentifier(schema);
            item.sortText = `0_${schema.toLowerCase()}`;
            return item;
        });
    }

    private getObjectCompletions(objects: DatabaseObject[], skipQuoting = false): vscode.CompletionItem[] {
        return objects.map(obj => {
            const kind = obj.type === 'table'
                ? vscode.CompletionItemKind.Class
                : vscode.CompletionItemKind.Interface;

            const displayName = obj.name.toLowerCase();
            const item = new vscode.CompletionItem(displayName, kind);
            item.detail = `${obj.type} in ${obj.schema.toLowerCase()}`;
            item.insertText = skipQuoting ? displayName : this.quoteIdentifier(obj.name);
            item.sortText = `1_${displayName}`;

            // Add documentation with column list if available
            if (obj.columns && obj.columns.length > 0) {
                item.documentation = new vscode.MarkdownString(
                    `**Columns:**\n${obj.columns.map(col => `- ${col.toLowerCase()}`).join('\n')}`
                );
            }

            return item;
        });
    }

    private getColumnCompletions(columns: string[]): vscode.CompletionItem[] {
        return columns.map(col => {
            const displayName = col.toLowerCase();
            const item = new vscode.CompletionItem(displayName, vscode.CompletionItemKind.Field);
            item.insertText = this.quoteIdentifier(col);
            item.sortText = `0_${displayName}`;
            return item;
        });
    }

    private async getSchemas(connectionId: string): Promise<string[]> {
        // Check cache
        const cached = this.schemasCache.get(connectionId);
        if (cached) {
            return cached;
        }

        try {
            const driver = await this.connectionManager.getDriver(connectionId);
            const schemasQuery = `
                SELECT SCHEMA_NAME
                FROM SYS.EXA_SCHEMAS
                WHERE SCHEMA_NAME NOT IN ('SYS', 'EXA_STATISTICS')
                ORDER BY SCHEMA_NAME
            `;
            const result = await this.safeQuery(driver, schemasQuery);
            const rows = getRowsFromResult(result);
            const schemas = rows.map((r: any) => r.SCHEMA_NAME);

            // Cache schemas
            this.schemasCache.set(connectionId, schemas);
            return schemas;
        } catch (error) {
            console.error('Failed to fetch schemas:', error);
            return [];
        }
    }

    private async getDatabaseObjects(connectionId: string): Promise<DatabaseObject[]> {
        // Check cache
        const cached = this.cache.get(connectionId);
        const expiry = this.cacheExpiry.get(connectionId);

        if (cached && expiry && Date.now() < expiry) {
            return cached;
        }

        try {
            const driver = await this.connectionManager.getDriver(connectionId);

            // Fetch tables and views with their schemas
            const tablesQuery = `
                SELECT
                    TABLE_SCHEMA,
                    TABLE_NAME,
                    'table' AS OBJECT_TYPE
                FROM SYS.EXA_ALL_TABLES
                WHERE TABLE_SCHEMA NOT IN ('SYS', 'EXA_STATISTICS')
                UNION ALL
                SELECT
                    VIEW_SCHEMA AS TABLE_SCHEMA,
                    VIEW_NAME AS TABLE_NAME,
                    'view' AS OBJECT_TYPE
                FROM SYS.EXA_ALL_VIEWS
                WHERE VIEW_SCHEMA NOT IN ('SYS', 'EXA_STATISTICS')
                ORDER BY 1, 2
            `;

            const result = await this.safeQuery(driver, tablesQuery);
            const tableRows = getRowsFromResult(result);
            const objects: DatabaseObject[] = [];

            for (const row of tableRows) {
                const obj: DatabaseObject = {
                    schema: row.TABLE_SCHEMA,
                    name: row.TABLE_NAME,
                    type: row.OBJECT_TYPE === 'view' ? 'view' : 'table'
                };

                // Fetch columns for this object
                try {
                    const columnsQuery = `
                        SELECT COLUMN_NAME
                        FROM SYS.EXA_ALL_COLUMNS
                        WHERE COLUMN_SCHEMA = '${row.TABLE_SCHEMA}'
                        AND COLUMN_TABLE = '${row.TABLE_NAME}'
                        ORDER BY COLUMN_ORDINAL_POSITION
                    `;
                    const colResult = await this.safeQuery(driver, columnsQuery);
                    const columnRows = getRowsFromResult(colResult);
                    obj.columns = columnRows.map((r: any) => r.COLUMN_NAME);
                } catch (error) {
                    console.error(`Failed to fetch columns for ${row.TABLE_NAME}:`, error);
                }

                objects.push(obj);
            }

            // Update cache
            this.cache.set(connectionId, objects);
            this.cacheExpiry.set(connectionId, Date.now() + this.CACHE_TTL);

            return objects;
        } catch (error) {
            console.error('Failed to fetch database objects:', error);
            return [];
        }
    }

    public clearCache(connectionId?: string) {
        if (connectionId) {
            this.cache.delete(connectionId);
            this.cacheExpiry.delete(connectionId);
            this.schemasCache.delete(connectionId);
        } else {
            this.cache.clear();
            this.cacheExpiry.clear();
            this.schemasCache.clear();
            this.reservedKeywords.clear();
            this.reservedKeywordsLoaded = false;
        }
    }

    private async safeQuery(driver: any, sql: string): Promise<any> {
        try {
            return await driver.query(sql);
        } catch (error) {
            const message = (error instanceof Error ? error.message : String(error ?? '')).toUpperCase();
            if (message.includes('INVALID RESULT TYPE') || message.includes('MALFORMED RESULT')) {
                return await driver.query(sql, undefined, undefined, 'raw');
            }
            throw error;
        }
    }
}
