/**
 * Utility functions for Exasol extension.
 * Re-exports from domain submodules for backward compatibility.
 */
export {
    escapeSqlString,
    escapeSqlIdentifier,
    stripCommentsPreservingStrings,
    findStatementEnds,
    buildLineOffsets,
    offsetToLine,
    offsetAtLineCharacter,
    findStatementRanges,
    findStatementAtCursor,
    splitIntoStatements
} from './sql';

export {
    parseSelectListAliases,
    findEnclosingSelectListText,
    parseEnclosingSelectListAliases
} from './selectAliases';
export type { SelectAlias } from './selectAliases';

export { parseCtes } from './cteParser';
export type { CteDefinition } from './cteParser';

export {
    escapeHtml,
    generateNonce,
    escapeJsonForDataIsland,
    createWebviewRenderContext
} from './webview';
export type { WebviewRenderContext } from './webview';

export {
    safeFetch,
    rawQuery,
    rawExecute,
    getRowsFromResult,
    getColumnsFromResult,
    executeWithoutResult,
    extractColumnName,
    extractColumnMetadata
} from './driver';
export type { ColumnMetadata } from './driver';
