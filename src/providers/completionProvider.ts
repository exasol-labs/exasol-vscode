import * as vscode from 'vscode';
import { ConnectionManager, BACKGROUND_QUERY_TIMEOUT_MS } from '../connectionManager';
import { getOutputChannel } from '../extension';
import {
    escapeSqlString,
    findStatementAtCursor,
    getRowsFromResult,
    offsetAtLineCharacter,
    parseCtes,
    parseEnclosingSelectListAliases,
    rawQuery,
    safeFetch
} from '../utils';
import type { CteDefinition, SelectAlias } from '../utils';
import { classifyContext } from '../utils/completionContext';
import type { CompletionContext, ContextKind } from '../utils/completionContext';

export interface DatabaseObject {
    schema: string;
    name: string;
    type: 'table' | 'view' | 'script' | 'function' | 'virtual-table' | 'system-table';
}

export interface AliasTarget {
    schema?: string;
    table: string;
}

/**
 * Pure resolver for "prefix." completions used by both the live provider and tests.
 * Given the parsed objects + aliases + the unqualified prefix token left of the dot,
 * returns one of:
 *   { kind: 'columns', schema, table }   -> caller fetches columns and shows them
 *   { kind: 'schemaObjects', objects }   -> caller renders schema-scoped objects
 *   { kind: 'none' }                     -> caller falls back to default suggestions
 *   { kind: 'empty' }                    -> alias parsed but lookup failed; return []
 */
export type PrefixResolution =
    | { kind: 'columns'; schema: string; table: string }
    | { kind: 'schemaObjects'; objects: DatabaseObject[] }
    | { kind: 'none' }
    | { kind: 'empty' };

export function resolvePrefixCompletions(
    objects: DatabaseObject[],
    aliases: Map<string, AliasTarget>,
    prefix: string
): PrefixResolution {
    const prefixUpper = prefix.toUpperCase();

    if (aliases.has(prefixUpper)) {
        const target = aliases.get(prefixUpper)!;
        const tableUpper = target.table.toUpperCase();
        const schemaUpper = target.schema?.toUpperCase();
        const obj = objects.find(o =>
            o.name === tableUpper && (!schemaUpper || o.schema === schemaUpper)
        );
        if (obj) {
            return { kind: 'columns', schema: obj.schema, table: obj.name };
        }
        return { kind: 'empty' };
    }

    const schemaObjects = objects.filter(obj => obj.schema === prefixUpper);
    if (schemaObjects.length > 0) {
        return { kind: 'schemaObjects', objects: schemaObjects };
    }

    const obj = objects.find(o => o.name === prefixUpper);
    if (obj) {
        return { kind: 'columns', schema: obj.schema, table: obj.name };
    }

    return { kind: 'none' };
}

// Exported for unit testing. Handles every combination of quoted/unquoted
// schema and table in FROM/JOIN clauses: schema.table, "schema".table,
// schema."table", "schema"."table". Captures contain the unquoted identifier
// text only; callers must compare case-insensitively (Exasol normalises to upper).
export function parseAliases(queryText: string): Map<string, AliasTarget> {
    const aliases = new Map<string, AliasTarget>();

    const ident = '(?:"([^"]+)"|(\\w+))';
    const tableAliasPattern = new RegExp(
        `(?:from|(?:(?:inner|left|right|full|cross)\\s+)?(?:outer\\s+)?join)\\s+` +
        `(?:${ident}\\s*\\.\\s*)?${ident}\\s+(?:as\\s+)?(\\w+)\\b`,
        'gi'
    );

    const STOP = new Set(['ON', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS',
        'OUTER', 'ORDER', 'GROUP', 'HAVING', 'LIMIT', 'UNION', 'INTERSECT', 'EXCEPT']);

    let match: RegExpExecArray | null;
    while ((match = tableAliasPattern.exec(queryText)) !== null) {
        const schema = match[1] ?? match[2];
        const table = match[3] ?? match[4];
        const alias = match[5];
        if (!table || !alias) { continue; }
        const aliasUpper = alias.toUpperCase();
        if (STOP.has(aliasUpper)) { continue; }
        if (aliasUpper === table.toUpperCase()) { continue; }
        aliases.set(aliasUpper, schema ? { schema, table } : { table });
    }

    return aliases;
}

export class ExasolCompletionProvider implements vscode.CompletionItemProvider {
    private cache: Map<string, DatabaseObject[]> = new Map();
    private cacheExpiry: Map<string, number> = new Map();
    private schemasCache: Map<string, string[]> = new Map();
    private schemasExpiry: Map<string, number> = new Map();
    /** Per-table column cache keyed by `${connectionId}|${SCHEMA}.${TABLE}` (upper). */
    private readonly columnsCache: Map<string, string[]> = new Map();
    private readonly columnsExpiry: Map<string, number> = new Map();
    /** Soft cap on per-table column cache entries; oldest-by-expiry evicted on overflow. */
    private readonly COLUMNS_CACHE_MAX = 500;
    private reservedKeywords: Set<string> = new Set();
    private reservedKeywordsLoaded = false;
    private readonly CACHE_TTL = 300000; // 5 minutes

    constructor(private connectionManager: ConnectionManager) {}

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.CompletionContext
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
        const _word = wordRange ? document.getText(wordRange) : '';

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
            const aliases = parseAliases(queryText);

            // Parse CTEs from the CURRENT statement only (CTEs are statement-scoped).
            const currentStmt = findStatementAtCursor(queryText, position.line);
            const ctes: CteDefinition[] = currentStmt ? parseCtes(currentStmt.text) : [];
            const cteByUpper = new Map<string, CteDefinition>();
            for (const c of ctes) { cteByUpper.set(c.name.toUpperCase(), c); }

            const log = getOutputChannel();

            // LOCAL.<alias> pattern (Exasol-specific): inside WHERE/HAVING/QUALIFY/
            // GROUP BY, `LOCAL.foo` references an alias from the SELECT list of
            // the SELECT that lexically encloses the cursor (which inside a CTE
            // body is the CTE's inner SELECT, not the outer one).
            const localMatch = linePrefix.match(/\blocal\.\s*$/i);
            if (localMatch) {
                const stmt = findStatementAtCursor(queryText, position.line);
                let aliasesList: SelectAlias[] = [];
                if (stmt) {
                    const docOff = offsetAtLineCharacter(queryText, position.line, position.character);
                    const cursorInStmt = Math.max(0, docOff - stmt.startOffset);
                    aliasesList = parseEnclosingSelectListAliases(stmt.text, cursorInStmt);
                }
                if (aliasesList.length === 0) {
                    log?.appendLine(`[completion] LOCAL.: no parseable enclosing SELECT-list aliases; returning empty`);
                    return [];
                }
                log?.appendLine(`[completion] LOCAL. -> ${aliasesList.length} alias(es)`);
                return this.getLocalAliasCompletions(aliasesList);
            }

            // schema.table. pattern (highest priority): two qualified identifiers.
            const schemaTableMatch = linePrefix.match(/(\w+)\.(\w+)\.\s*$/);
            if (schemaTableMatch) {
                const schemaName = schemaTableMatch[1].toUpperCase();
                const tableName = schemaTableMatch[2].toUpperCase();
                const obj = objects.find(o => o.schema === schemaName && o.name === tableName);
                if (obj) {
                    const cols = await this.getColumnsForTable(activeConnection.id, obj.schema, obj.name);
                    if (cols) {
                        return this.getColumnCompletions(cols);
                    }
                    log?.appendLine(`[completion] ${schemaName}.${tableName}: column fetch failed; returning empty`);
                    return [];
                }
            }

            // Single-identifier prefix: alias, schema, or bare table name.
            const aliasMatch = linePrefix.match(/(\w+)\.\s*$/);
            if (aliasMatch) {
                const prefix = aliasMatch[1];
                const prefixUpper = prefix.toUpperCase();

                // CTE alias indirection: alias parsed -> table name -> matches a CTE.
                const aliasTarget = aliases.get(prefixUpper);
                if (aliasTarget && !aliasTarget.schema) {
                    const cte = cteByUpper.get(aliasTarget.table.toUpperCase());
                    if (cte && cte.columns.length > 0) {
                        log?.appendLine(`[completion] '${prefix}' -> CTE ${cte.name} (${cte.columns.length} cols)`);
                        return this.getColumnCompletions(cte.columns);
                    }
                }
                // Direct CTE reference: `cte_name.|`
                const directCte = cteByUpper.get(prefixUpper);
                if (directCte && directCte.columns.length > 0) {
                    log?.appendLine(`[completion] '${prefix}' -> CTE ${directCte.name} (${directCte.columns.length} cols)`);
                    return this.getColumnCompletions(directCte.columns);
                }

                const resolution = resolvePrefixCompletions(objects, aliases, prefix);
                switch (resolution.kind) {
                    case 'columns': {
                        const cols = await this.getColumnsForTable(
                            activeConnection.id, resolution.schema, resolution.table
                        );
                        if (cols) {
                            log?.appendLine(`[completion] '${prefix}' -> ${resolution.schema}.${resolution.table} (${cols.length} cols)`);
                            return this.getColumnCompletions(cols);
                        }
                        log?.appendLine(`[completion] '${prefix}' -> ${resolution.schema}.${resolution.table} but column fetch failed; returning empty`);
                        return [];
                    }
                    case 'schemaObjects':
                        return this.getObjectCompletions(resolution.objects, true);
                    case 'empty':
                        log?.appendLine(`[completion] alias '${prefix}' parsed but table not in object cache; returning empty`);
                        return [];
                    case 'none':
                        log?.appendLine(`[completion] prefix '${prefix}' did not resolve as alias/schema/table; aliases known: [${Array.from(aliases.keys()).join(', ')}]`);
                        break;
                }
            }

            // No prefix-dot context: classify cursor and rank buckets accordingly.
            const docOffsetForCtx = offsetAtLineCharacter(queryText, position.line, position.character);
            const stmtForCtx = currentStmt ?? findStatementAtCursor(queryText, position.line);
            const ctxQuery = stmtForCtx?.text ?? queryText;
            const ctxOffset = stmtForCtx
                ? Math.max(0, docOffsetForCtx - stmtForCtx.startOffset)
                : docOffsetForCtx;
            const ctx = classifyContext(ctxQuery, ctxOffset);
            log?.appendLine(`[completion] context=${ctx.kind} fromTables=${ctx.fromTables.length}`);

            const schemas = await this.getSchemas(activeConnection.id);

            // Pre-fetch columns for FROM tables when the context wants them.
            const fromColumns = await this.fetchFromTableColumns(activeConnection.id, ctx, objects);
            return this.buildContextualItems(ctx, fromColumns, objects, schemas);
        } catch (error) {
            getOutputChannel()?.appendLine(`Error providing completions: ${error}`);
            return items;
        }
    }

    private async loadReservedKeywords(connectionId: string): Promise<void> {
        try {
            await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connectionId, 'background');
                const result = await rawQuery(driver, 'SELECT keyword FROM sys.exa_sql_keywords WHERE reserved');
                const rows = getRowsFromResult(result);
                this.reservedKeywords = new Set(
                    rows
                        .map((r: any) => r?.KEYWORD)
                        .filter((k: unknown): k is string => typeof k === 'string' && k.length > 0)
                        .map((k: string) => k.toUpperCase())
                );
                this.reservedKeywordsLoaded = true;
            }, connectionId, { timeoutMs: BACKGROUND_QUERY_TIMEOUT_MS, role: 'background' });
        } catch (error) {
            getOutputChannel()?.appendLine(`Failed to load reserved keywords: ${error}`);
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
        return schemas.filter((s): s is string => typeof s === 'string' && s.length > 0).map(schema => {
            const item = new vscode.CompletionItem(schema.toLowerCase(), vscode.CompletionItemKind.Module);
            item.detail = 'Schema';
            item.insertText = this.quoteIdentifier(schema);
            item.sortText = `0_${schema.toLowerCase()}`;
            return item;
        });
    }

    private static readonly OBJECT_KIND: Partial<Record<DatabaseObject['type'], vscode.CompletionItemKind>> = {
        view:           vscode.CompletionItemKind.Interface,
        script:         vscode.CompletionItemKind.Method,
        function:       vscode.CompletionItemKind.Function,
    };

    private getObjectCompletions(objects: DatabaseObject[], skipQuoting = false): vscode.CompletionItem[] {
        return objects.filter(o => o && o.name && o.schema).map(obj => {
            const kind = ExasolCompletionProvider.OBJECT_KIND[obj.type] ?? vscode.CompletionItemKind.Class;

            const displayName = obj.name.toLowerCase();
            const item = new vscode.CompletionItem(displayName, kind);
            const typeLabel = obj.type === 'virtual-table' ? 'virtual table'
                : obj.type === 'system-table' ? 'system table'
                : obj.type;
            item.detail = `${typeLabel} in ${obj.schema.toLowerCase()}`;
            item.insertText = skipQuoting ? displayName : this.quoteIdentifier(obj.name);
            item.sortText = `1_${displayName}`;
            return item;
        });
    }

    private getLocalAliasCompletions(aliases: SelectAlias[]): vscode.CompletionItem[] {
        return aliases.map((a, idx) => {
            const displayName = a.name.toLowerCase();
            const item = new vscode.CompletionItem(displayName, vscode.CompletionItemKind.Field);
            item.detail = 'SELECT alias';
            item.insertText = a.quoted ? `"${a.name.replace(/"/g, '""')}"` : this.quoteIdentifier(a.name);
            item.sortText = ExasolCompletionProvider.sourceOrderSortText(idx, displayName);
            return item;
        });
    }

    private getColumnCompletions(columns: string[]): vscode.CompletionItem[] {
        const valid = columns.filter((c): c is string => typeof c === 'string' && c.length > 0);
        return valid.map((col, idx) => {
            const displayName = col.toLowerCase();
            const item = new vscode.CompletionItem(displayName, vscode.CompletionItemKind.Field);
            item.insertText = this.quoteIdentifier(col);
            item.sortText = ExasolCompletionProvider.sourceOrderSortText(idx, displayName);
            return item;
        });
    }

    /** Build a sortText that preserves source order under VS Code's lexical sort. */
    private static sourceOrderSortText(idx: number, lower: string): string {
        return `0_${String(idx).padStart(5, '0')}_${lower}`;
    }

    /**
     * Resolve FROM-clause table refs (from the enclosing SELECT) against the
     * objects cache and pre-fetch each table's columns. Returns deduped column
     * names in FROM order. Missing tables are skipped silently.
     */
    private async fetchFromTableColumns(
        connectionId: string,
        ctx: CompletionContext,
        objects: DatabaseObject[]
    ): Promise<string[]> {
        if (ctx.fromTables.length === 0) { return []; }
        const need = ctx.kind === 'AFTER_SELECT_KEYWORD'
            || ctx.kind === 'AFTER_WHERE_HAVING_QUALIFY'
            || ctx.kind === 'AFTER_GROUP_BY_ORDER_BY';
        if (!need) { return []; }
        const out: string[] = [];
        const seen = new Set<string>();
        for (const ref of ctx.fromTables) {
            const tableUp = ref.table.toUpperCase();
            const schemaUp = ref.schema?.toUpperCase();
            const obj = objects.find(o =>
                o.name === tableUp && (!schemaUp || o.schema === schemaUp)
            );
            if (!obj) { continue; }
            const cols = await this.getColumnsForTable(connectionId, obj.schema, obj.name);
            if (!cols) { continue; }
            for (const c of cols) {
                const k = c.toUpperCase();
                if (seen.has(k)) { continue; }
                seen.add(k);
                out.push(c);
            }
        }
        return out;
    }

    /** Bucket priority by context kind. Lower index = higher priority. */
    private static readonly BUCKET_ORDER: Record<ContextKind, string[]> = {
        AFTER_DOT:                  ['columns', 'objects', 'functions', 'keywords', 'schemas'],
        AFTER_SELECT_KEYWORD:       ['columns', 'functions', 'objects', 'keywords', 'schemas'],
        AFTER_FROM_OR_JOIN:         ['schemas', 'objects', 'keywords', 'functions', 'columns'],
        AFTER_WHERE_HAVING_QUALIFY: ['columns', 'localKw', 'functions', 'keywords', 'objects', 'schemas'],
        AFTER_GROUP_BY_ORDER_BY:    ['columns', 'keywords', 'functions', 'objects', 'schemas'],
        STATEMENT_START:            ['commandKw', 'keywords'],
        UNKNOWN:                    ['keywords', 'objects', 'functions', 'columns', 'schemas']
    };

    private static readonly COMMAND_KEYWORDS = [
        'select', 'insert', 'update', 'delete', 'with', 'create', 'alter',
        'drop', 'truncate', 'merge', 'commit', 'rollback'
    ];

    private buildContextualItems(
        ctx: CompletionContext,
        fromColumns: string[],
        objects: DatabaseObject[],
        schemas: string[]
    ): vscode.CompletionItem[] {
        const order = ExasolCompletionProvider.BUCKET_ORDER[ctx.kind];
        const bucketIdx: Record<string, number> = {};
        for (let i = 0; i < order.length; i++) { bucketIdx[order[i]] = i; }
        const prio = (bucket: string): string => {
            const i = bucketIdx[bucket];
            return i === undefined ? '9_' : `${i}_`;
        };
        const out: vscode.CompletionItem[] = [];

        if (ctx.kind === 'STATEMENT_START') {
            const cmds = ExasolCompletionProvider.COMMAND_KEYWORDS;
            for (let i = 0; i < cmds.length; i++) {
                const item = new vscode.CompletionItem(cmds[i], vscode.CompletionItemKind.Keyword);
                item.insertText = cmds[i];
                item.sortText = `${prio('commandKw')}${String(i).padStart(2, '0')}_${cmds[i]}`;
                out.push(item);
            }
            // Lower-priority general keywords too, for things like `EXPLAIN`, `SHOW`.
            const cmdSet = new Set(cmds);
            for (const item of this.getKeywordCompletions()) {
                if (cmdSet.has(String(item.label).toLowerCase())) { continue; }
                item.sortText = `${prio('keywords')}${item.label}`;
                out.push(item);
            }
            return out;
        }

        if (order.includes('columns') && fromColumns.length > 0) {
            for (let i = 0; i < fromColumns.length; i++) {
                const col = fromColumns[i];
                const displayName = col.toLowerCase();
                const item = new vscode.CompletionItem(displayName, vscode.CompletionItemKind.Field);
                item.detail = 'Column';
                item.insertText = this.quoteIdentifier(col);
                item.sortText = `${prio('columns')}${String(i).padStart(5, '0')}_${displayName}`;
                out.push(item);
            }
        }

        if (order.includes('localKw')) {
            const local = new vscode.CompletionItem('local', vscode.CompletionItemKind.Keyword);
            local.insertText = 'local.';
            local.detail = 'Exasol SELECT-list alias reference';
            local.sortText = `${prio('localKw')}local`;
            out.push(local);
        }

        if (order.includes('functions')) {
            for (const item of this.getFunctionCompletions()) {
                item.sortText = `${prio('functions')}${item.label}`;
                out.push(item);
            }
        }

        if (order.includes('keywords')) {
            for (const item of this.getKeywordCompletions()) {
                item.sortText = `${prio('keywords')}${item.label}`;
                out.push(item);
            }
        }

        if (order.includes('objects')) {
            for (const item of this.getObjectCompletions(objects)) {
                item.sortText = `${prio('objects')}${item.label}`;
                out.push(item);
            }
        }

        if (order.includes('schemas')) {
            for (const item of this.getSchemaCompletions(schemas)) {
                item.sortText = `${prio('schemas')}${item.label}`;
                out.push(item);
            }
        }

        return out;
    }

    private async getSchemas(connectionId: string): Promise<string[]> {
        // Check cache with TTL
        const cached = this.schemasCache.get(connectionId);
        const expiry = this.schemasExpiry.get(connectionId);
        if (cached && expiry && Date.now() < expiry) {
            return cached;
        }

        const channel = getOutputChannel();
        return safeFetch('Failed to fetch schemas', () =>
            this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connectionId, 'background');
                const schemasQuery = `
                    SELECT SCHEMA_NAME
                    FROM SYS.EXA_SCHEMAS
                    WHERE SCHEMA_NAME NOT IN ('SYS', 'EXA_STATISTICS')
                    ORDER BY SCHEMA_NAME
                `;
                const result = await rawQuery(driver, schemasQuery);
                const rows = getRowsFromResult(result);
                const schemas: string[] = rows
                    .map((r: any) => r.SCHEMA_NAME)
                    .filter((n: unknown): n is string => typeof n === 'string' && n.length > 0);

                schemas.push('SYS', 'EXA_STATISTICS');

                try {
                    const vsResult = await rawQuery(driver, 'SELECT SCHEMA_NAME FROM SYS.EXA_ALL_VIRTUAL_SCHEMAS ORDER BY SCHEMA_NAME');
                    const vsRows = getRowsFromResult(vsResult);
                    for (const row of vsRows) {
                        const name = row?.SCHEMA_NAME;
                        if (typeof name === 'string' && name && !schemas.includes(name)) {
                            schemas.push(name);
                        }
                    }
                    schemas.sort();
                } catch (error) {
                    channel?.appendLine(`Failed to fetch virtual schemas for completions: ${error}`);
                }

                // Cache schemas with TTL
                this.schemasCache.set(connectionId, schemas);
                this.schemasExpiry.set(connectionId, Date.now() + this.CACHE_TTL);
                return schemas;
            }, connectionId, { timeoutMs: BACKGROUND_QUERY_TIMEOUT_MS, role: 'background' }),
        [], channel);
    }

    private async getDatabaseObjects(connectionId: string): Promise<DatabaseObject[]> {
        // Check cache
        const cached = this.cache.get(connectionId);
        const expiry = this.cacheExpiry.get(connectionId);

        if (cached && expiry && Date.now() < expiry) {
            return cached;
        }

        return safeFetch('Failed to fetch database objects', () =>
            this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connectionId, 'background');

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

                const result = await rawQuery(driver, tablesQuery);
                const tableRows = getRowsFromResult(result);

                // Columns are now fetched lazily per table via getColumnsForTable().
                // The previous bulk EXA_ALL_COLUMNS scan returned huge payloads that
                // triggered driver-level packet errors and poisoned this cache.
                const objects: DatabaseObject[] = [];
                for (const row of tableRows) {
                    const schema = row?.TABLE_SCHEMA;
                    const name = row?.TABLE_NAME;
                    if (typeof schema !== 'string' || !schema || typeof name !== 'string' || !name) {
                        continue;
                    }
                    objects.push({
                        schema,
                        name,
                        type: row.OBJECT_TYPE === 'view' ? 'view' : 'table',
                    });
                }

                const fetchObjects = async (
                    query: string,
                    type: DatabaseObject['type'],
                    schemaCol: string,
                    nameCol: string,
                    label: string
                ): Promise<void> => {
                    try {
                        const result = await rawQuery(driver, query);
                        const rows = getRowsFromResult(result);
                        for (const row of rows) {
                            const schema = row?.[schemaCol];
                            const name = row?.[nameCol];
                            if (typeof schema !== 'string' || !schema || typeof name !== 'string' || !name) {
                                continue;
                            }
                            objects.push({ schema, name, type });
                        }
                    } catch (error) {
                        getOutputChannel()?.appendLine(`${label}: ${error}`);
                    }
                };

                const metadataFetches: Array<{
                    query: string;
                    type: DatabaseObject['type'];
                    schemaCol: string;
                    nameCol: string;
                    label: string;
                }> = [
                    {
                        query: `
                        SELECT SCRIPT_SCHEMA, SCRIPT_NAME
                        FROM SYS.EXA_ALL_SCRIPTS
                        WHERE SCRIPT_SCHEMA NOT IN ('SYS', 'EXA_STATISTICS')
                        ORDER BY SCRIPT_SCHEMA, SCRIPT_NAME
                    `,
                        type: 'script',
                        schemaCol: 'SCRIPT_SCHEMA',
                        nameCol: 'SCRIPT_NAME',
                        label: 'Completions: Failed to fetch scripts'
                    },
                    {
                        query: `
                        SELECT FUNCTION_SCHEMA, FUNCTION_NAME
                        FROM SYS.EXA_ALL_FUNCTIONS
                        WHERE FUNCTION_SCHEMA NOT IN ('SYS', 'EXA_STATISTICS')
                        ORDER BY FUNCTION_SCHEMA, FUNCTION_NAME
                    `,
                        type: 'function',
                        schemaCol: 'FUNCTION_SCHEMA',
                        nameCol: 'FUNCTION_NAME',
                        label: 'Completions: Failed to fetch functions'
                    },
                    {
                        query: `
                        SELECT TABLE_SCHEMA, TABLE_NAME
                        FROM SYS.EXA_ALL_VIRTUAL_TABLES
                        ORDER BY TABLE_SCHEMA, TABLE_NAME
                    `,
                        type: 'virtual-table',
                        schemaCol: 'TABLE_SCHEMA',
                        nameCol: 'TABLE_NAME',
                        label: 'Completions: Failed to fetch virtual tables'
                    },
                    {
                        query: `
                        SELECT SCHEMA_NAME AS TABLE_SCHEMA, OBJECT_NAME AS TABLE_NAME
                        FROM SYS.EXA_SYSCAT
                        WHERE SCHEMA_NAME IN ('SYS', 'EXA_STATISTICS')
                        ORDER BY SCHEMA_NAME, OBJECT_NAME
                    `,
                        type: 'system-table',
                        schemaCol: 'TABLE_SCHEMA',
                        nameCol: 'TABLE_NAME',
                        label: 'Completions: Failed to fetch system tables'
                    }
                ];

                for (const fetch of metadataFetches) {
                    await fetchObjects(fetch.query, fetch.type, fetch.schemaCol, fetch.nameCol, fetch.label);
                }

                // Update cache
                this.cache.set(connectionId, objects);
                this.cacheExpiry.set(connectionId, Date.now() + this.CACHE_TTL);

                return objects;
            }, connectionId, { timeoutMs: BACKGROUND_QUERY_TIMEOUT_MS, role: 'background' }),
        [], getOutputChannel());
    }

    /**
     * Lazily fetch and cache the columns of a single table. Returns undefined
     * (without caching) when the underlying query fails, so the next lookup retries.
     */
    private async getColumnsForTable(
        connectionId: string,
        schema: string,
        table: string
    ): Promise<string[] | undefined> {
        if (!schema || !table) { return undefined; }
        const cacheKey = `${connectionId}|${schema.toUpperCase()}.${table.toUpperCase()}`;
        const cached = this.columnsCache.get(cacheKey);
        const expiry = this.columnsExpiry.get(cacheKey);
        if (cached && expiry && Date.now() < expiry) {
            return cached;
        }

        const channel = getOutputChannel();
        try {
            return await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connectionId, 'background');
                // EXA_ALL_COLUMNS uses identifiers stored uppercase; escape as string literals.
                const sql =
                    `SELECT COLUMN_NAME FROM SYS.EXA_ALL_COLUMNS ` +
                    `WHERE COLUMN_SCHEMA = '${escapeSqlString(schema.toUpperCase())}' ` +
                    `AND COLUMN_TABLE = '${escapeSqlString(table.toUpperCase())}' ` +
                    `ORDER BY COLUMN_ORDINAL_POSITION`;
                const result = await rawQuery(driver, sql);
                const rows = getRowsFromResult(result);
                const cols: string[] = [];
                for (const row of rows) {
                    const n = row?.COLUMN_NAME;
                    if (typeof n === 'string' && n) { cols.push(n); }
                }
                this.columnsCache.set(cacheKey, cols);
                this.columnsExpiry.set(cacheKey, Date.now() + this.CACHE_TTL);
                this.evictColumnsCacheIfOverCap();
                return cols;
            }, connectionId, { timeoutMs: BACKGROUND_QUERY_TIMEOUT_MS, role: 'background' });
        } catch (error) {
            channel?.appendLine(`Completions: failed to fetch columns for ${schema}.${table}: ${error}`);
            return undefined;
        }
    }

    /**
     * Soft cap on columnsCache size: when over COLUMNS_CACHE_MAX, drop the
     * entries with the oldest expiry timestamps until back at cap. Keeps memory
     * bounded for sessions that browse many tables without an LRU dep.
     */
    private evictColumnsCacheIfOverCap(): void {
        const over = this.columnsCache.size - this.COLUMNS_CACHE_MAX;
        if (over <= 0) { return; }
        const sorted = Array.from(this.columnsExpiry.entries()).sort((a, b) => a[1] - b[1]);
        for (let i = 0; i < over && i < sorted.length; i++) {
            const key = sorted[i][0];
            this.columnsCache.delete(key);
            this.columnsExpiry.delete(key);
        }
    }

    public clearCache(connectionId?: string) {
        if (connectionId) {
            this.cache.delete(connectionId);
            this.cacheExpiry.delete(connectionId);
            this.schemasCache.delete(connectionId);
            this.schemasExpiry.delete(connectionId);
            const prefix = `${connectionId}|`;
            for (const key of this.columnsCache.keys()) {
                if (key.startsWith(prefix)) {
                    this.columnsCache.delete(key);
                    this.columnsExpiry.delete(key);
                }
            }
        } else {
            this.cache.clear();
            this.cacheExpiry.clear();
            this.schemasCache.clear();
            this.schemasExpiry.clear();
            this.columnsCache.clear();
            this.columnsExpiry.clear();
            this.reservedKeywords.clear();
            this.reservedKeywordsLoaded = false;
        }
    }

}
