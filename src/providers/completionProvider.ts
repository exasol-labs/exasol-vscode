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

        try {
            // Add SQL keywords
            items.push(...this.getKeywordCompletions());

            // Add SQL functions
            items.push(...this.getFunctionCompletions());

            // Add database objects (tables, views)
            const objects = await this.getDatabaseObjects(activeConnection.id);
            items.push(...this.getObjectCompletions(objects));

            // If we have a schema prefix (e.g., "schema."), suggest objects from that schema
            const schemaMatch = linePrefix.match(/(\w+)\.\s*$/);
            if (schemaMatch) {
                const schemaName = schemaMatch[1].toUpperCase();
                const schemaObjects = objects.filter(obj => obj.schema === schemaName);
                items.push(...this.getObjectCompletions(schemaObjects));
            }

            // If we have a table/view prefix (e.g., "table."), suggest columns
            const tableMatch = linePrefix.match(/(\w+)\.(\w+)\.\s*$/) || linePrefix.match(/(\w+)\.\s*$/);
            if (tableMatch && objects.length > 0) {
                const tableName = tableMatch[tableMatch.length - 1].toUpperCase();
                const obj = objects.find(o => o.name === tableName);
                if (obj && obj.columns) {
                    items.push(...this.getColumnCompletions(obj.columns));
                }
            }

            return items;
        } catch (error) {
            console.error('Error providing completions:', error);
            return items;
        }
    }

    private getKeywordCompletions(): vscode.CompletionItem[] {
        const keywords = [
            'SELECT', 'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER',
            'ON', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'IS', 'NULL',
            'ORDER', 'BY', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET',
            'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
            'CREATE', 'ALTER', 'DROP', 'TABLE', 'VIEW', 'INDEX', 'SCHEMA', 'DATABASE',
            'AS', 'DISTINCT', 'ALL', 'UNION', 'INTERSECT', 'EXCEPT',
            'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
            'CAST', 'CONVERT', 'COALESCE', 'NULLIF',
            'WITH', 'RECURSIVE', 'CTE',
            'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'UNIQUE', 'CHECK', 'DEFAULT',
            'CONSTRAINT', 'CASCADE', 'RESTRICT',
            'GRANT', 'REVOKE', 'TO', 'FROM',
            'COMMIT', 'ROLLBACK', 'SAVEPOINT',
            'TRUNCATE', 'ANALYZE', 'VACUUM'
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
            { name: 'COUNT', snippet: 'COUNT(${1:column})' },
            { name: 'SUM', snippet: 'SUM(${1:column})' },
            { name: 'AVG', snippet: 'AVG(${1:column})' },
            { name: 'MIN', snippet: 'MIN(${1:column})' },
            { name: 'MAX', snippet: 'MAX(${1:column})' },
            { name: 'STDDEV', snippet: 'STDDEV(${1:column})' },
            { name: 'VARIANCE', snippet: 'VARIANCE(${1:column})' },

            // String functions
            { name: 'CONCAT', snippet: 'CONCAT(${1:str1}, ${2:str2})' },
            { name: 'SUBSTRING', snippet: 'SUBSTRING(${1:str}, ${2:start}, ${3:length})' },
            { name: 'SUBSTR', snippet: 'SUBSTR(${1:str}, ${2:start}, ${3:length})' },
            { name: 'UPPER', snippet: 'UPPER(${1:str})' },
            { name: 'LOWER', snippet: 'LOWER(${1:str})' },
            { name: 'TRIM', snippet: 'TRIM(${1:str})' },
            { name: 'LTRIM', snippet: 'LTRIM(${1:str})' },
            { name: 'RTRIM', snippet: 'RTRIM(${1:str})' },
            { name: 'LENGTH', snippet: 'LENGTH(${1:str})' },
            { name: 'REPLACE', snippet: 'REPLACE(${1:str}, ${2:old}, ${3:new})' },

            // Date/Time functions
            { name: 'CURRENT_DATE', snippet: 'CURRENT_DATE' },
            { name: 'CURRENT_TIMESTAMP', snippet: 'CURRENT_TIMESTAMP' },
            { name: 'ADD_DAYS', snippet: 'ADD_DAYS(${1:date}, ${2:days})' },
            { name: 'ADD_MONTHS', snippet: 'ADD_MONTHS(${1:date}, ${2:months})' },
            { name: 'ADD_YEARS', snippet: 'ADD_YEARS(${1:date}, ${2:years})' },
            { name: 'EXTRACT', snippet: 'EXTRACT(${1:YEAR} FROM ${2:date})' },
            { name: 'DATE_TRUNC', snippet: 'DATE_TRUNC(${1:\'DAY\'}, ${2:timestamp})' },

            // Math functions
            { name: 'ABS', snippet: 'ABS(${1:number})' },
            { name: 'ROUND', snippet: 'ROUND(${1:number}, ${2:decimals})' },
            { name: 'FLOOR', snippet: 'FLOOR(${1:number})' },
            { name: 'CEIL', snippet: 'CEIL(${1:number})' },
            { name: 'SQRT', snippet: 'SQRT(${1:number})' },
            { name: 'POWER', snippet: 'POWER(${1:base}, ${2:exponent})' },

            // Window functions
            { name: 'ROW_NUMBER', snippet: 'ROW_NUMBER() OVER (${1:ORDER BY column})' },
            { name: 'RANK', snippet: 'RANK() OVER (${1:ORDER BY column})' },
            { name: 'DENSE_RANK', snippet: 'DENSE_RANK() OVER (${1:ORDER BY column})' },
            { name: 'LAG', snippet: 'LAG(${1:column}, ${2:offset}) OVER (${3:ORDER BY column})' },
            { name: 'LEAD', snippet: 'LEAD(${1:column}, ${2:offset}) OVER (${3:ORDER BY column})' },

            // Null handling
            { name: 'COALESCE', snippet: 'COALESCE(${1:value1}, ${2:value2})' },
            { name: 'NULLIF', snippet: 'NULLIF(${1:value1}, ${2:value2})' },
            { name: 'NVL', snippet: 'NVL(${1:value}, ${2:default})' }
        ];

        return functions.map(func => {
            const item = new vscode.CompletionItem(func.name, vscode.CompletionItemKind.Function);
            item.insertText = new vscode.SnippetString(func.snippet);
            item.detail = 'Exasol Function';
            item.sortText = `3_${func.name}`;
            return item;
        });
    }

    private getObjectCompletions(objects: DatabaseObject[]): vscode.CompletionItem[] {
        return objects.map(obj => {
            const kind = obj.type === 'table'
                ? vscode.CompletionItemKind.Class
                : vscode.CompletionItemKind.Interface;

            const item = new vscode.CompletionItem(obj.name, kind);
            item.detail = `${obj.type} in ${obj.schema}`;
            item.insertText = obj.name;
            item.sortText = `1_${obj.name}`;

            // Add documentation with column list if available
            if (obj.columns && obj.columns.length > 0) {
                item.documentation = new vscode.MarkdownString(
                    `**Columns:**\n${obj.columns.map(col => `- ${col}`).join('\n')}`
                );
            }

            return item;
        });
    }

    private getColumnCompletions(columns: string[]): vscode.CompletionItem[] {
        return columns.map(col => {
            const item = new vscode.CompletionItem(col, vscode.CompletionItemKind.Field);
            item.insertText = col;
            item.sortText = `0_${col}`;
            return item;
        });
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

                // Fetch columns for this object (with limit to avoid performance issues)
                try {
                    const columnsQuery = `
                        SELECT COLUMN_NAME
                        FROM SYS.EXA_ALL_COLUMNS
                        WHERE COLUMN_SCHEMA = '${row.SCHEMA_NAME}'
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
        } else {
            this.cache.clear();
            this.cacheExpiry.clear();
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
