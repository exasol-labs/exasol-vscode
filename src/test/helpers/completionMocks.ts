/**
 * Shared test doubles for the completion-provider test family
 * (completionContextSort, completionLazyColumns, completionResolvePrefix,
 * cteCompletion, parseAliases) plus a few narrowly-reused pieces (MockDriver,
 * FakeConnectionManager) pulled out of objectSearch / objectTreeGetParent /
 * queryExecutorRouting / queryExecutorStatementIdentity / planProvider to
 * remove near-identical copies.
 *
 * LOAD ORDER: the Mock* classes here are plain classes with no dependency on
 * `vscode` or on the module-resolution hook, so they are safe to import
 * before `registerVscodeMock()` runs. Each consuming test file must still
 * call `applyCompletionVscodeMock(vscodeMock)` (which mutates the shared
 * `vscodeMock` singleton from '../helpers/vscodeMock') BEFORE calling
 * `registerVscodeMock()` and BEFORE `require()`-ing the module under test;
 * `registerVscodeMock()` is what wires `vscodeMock` into `require.cache` as
 * the 'vscode' module, and the provider modules read `vscode.CompletionItem`
 * etc. at call time, not at import time, but only after that require.cache
 * entry exists. Do not reorder: apply mocks -> registerVscodeMock() ->
 * registerExtensionMock() -> require(moduleUnderTest).
 */
import type * as vscode from 'vscode';
import type { ConnectionManager, StoredConnection } from '../../connectionManager';
import type { SQLQueriesResponse, SQLResponse } from '@exasol/exasol-driver-ts';

// ---------------------------------------------------------------------------
// vscode.CompletionItem / MarkdownString / SnippetString / Position / Range
// ---------------------------------------------------------------------------

export class MockCompletionItem {
    detail?: string;
    insertText?: string | vscode.SnippetString;
    sortText?: string;
    documentation?: string | vscode.MarkdownString;
    constructor(public label: string, public kind?: number) {}
}
export class MockMarkdownString {
    constructor(public value: string) {}
}
export class MockSnippetString {
    constructor(public value: string) {}
}
export class MockPosition {
    constructor(public line: number, public character: number) {}
}
export class MockRange {}

/**
 * vscodeMock is a plain object built from the shared subset used by other
 * test files; the completion provider needs a wider slice of the vscode API,
 * so this is a locally-typed view applied on top of it rather than editing
 * the shared helper (src/test/helpers/vscodeMock.ts is owned by another
 * in-flight change).
 */
export interface CompletionVscodeMock {
    CompletionItemKind: Record<string, number>;
    CompletionItem: typeof MockCompletionItem;
    MarkdownString: typeof MockMarkdownString;
    SnippetString: typeof MockSnippetString;
    workspace: { getConfiguration: () => { get: (key: string, dflt?: unknown) => unknown } };
    Position: typeof MockPosition;
    Range: typeof MockRange;
}

/**
 * Applies the completion-provider vscode surface (CompletionItem family plus
 * `workspace`/`Position`/`Range`) onto the shared vscodeMock singleton. Call
 * this BEFORE registerVscodeMock(), see the load-order note at the top of
 * this file.
 *
 * vscodeMock is a process-wide singleton shared by every test file in the
 * same mocha run. Other suites that need a different `vscode.workspace`
 * double (for example objectSearch.test.ts, which needs
 * `searchIncludesColumns` to resolve to `true`) install their own workspace
 * mock inside a per-test setup() hook rather than at module load time, so it
 * is reinstalled before each of that suite's own tests and is not at risk of
 * being overwritten by another file's module-load-time mutation depending on
 * file load order.
 */
export function applyCompletionVscodeMock(mock: object): CompletionVscodeMock {
    const extended = mock as unknown as CompletionVscodeMock;
    extended.CompletionItemKind = {
        Interface: 7, Method: 1, Function: 2, Class: 6, Module: 8, Field: 4, Keyword: 13,
    };
    extended.CompletionItem = MockCompletionItem;
    extended.MarkdownString = MockMarkdownString;
    extended.SnippetString = MockSnippetString;
    extended.workspace = {
        getConfiguration: () => ({ get: (_key: string, dflt?: unknown) => dflt }),
    };
    extended.Position = MockPosition;
    extended.Range = MockRange;
    return extended;
}

/** A single-cast factory for vscode.Position, so call sites never repeat
 * `as unknown as vscode.Position`. */
export function makePosition(line: number, character: number): vscode.Position {
    return new MockPosition(line, character) as unknown as vscode.Position;
}

/** A single-cast factory for a minimal vscode.TextDocument double: getText(),
 * lineAt(position) (the only overload completionProvider.ts calls), and
 * getWordRangeAtPosition() (always undefined, none of these tests rely on
 * word-range-based prefix detection). */
export function makeDocument(text: string): vscode.TextDocument {
    const lines = text.split('\n');
    const doc = {
        getText: () => text,
        lineAt: (position: vscode.Position) => ({ text: lines[position.line] ?? '' }),
        getWordRangeAtPosition: () => undefined,
    };
    return doc as unknown as vscode.TextDocument;
}

/**
 * Shape of a `vscode.workspace` double that only backs `getConfiguration().get()`,
 * reused verbatim across objectSearch / queryExecutorRouting /
 * queryExecutorStatementIdentity, all of which just need a settings lookup
 * with a fallback. NOT the same shape as resolveImportPath's workspace mock
 * (which mocks `workspaceFolders`, a different part of the vscode.workspace
 * API entirely). That one stays file-local since forcing it into this
 * interface would just be a name collision, not real duplication.
 */
export interface ConfigWorkspaceMock {
    getConfiguration: () => { get: (key: string, fallback?: unknown) => unknown };
}

// ---------------------------------------------------------------------------
// Driver / ConnectionManager test doubles
// ---------------------------------------------------------------------------

/** The real shape createRawResult/createEmptyRawResult/createRawErrorResult
 * in helpers/mockConnectionManager.ts will return once that file's own
 * in-flight typing change lands. */
export type RawResult = SQLResponse<SQLQueriesResponse>;

/** Minimal driver double: only `query` is required, `execute` is optional
 * since several tests only ever go through the query() path. */
export interface MockDriver {
    query: (sql: string) => Promise<RawResult>;
    execute?: (sql: string) => Promise<RawResult>;
}

export function makeDriver(handler: (sql: string) => RawResult): Required<MockDriver> {
    return {
        query: async (sql: string) => handler(sql),
        execute: async (sql: string) => handler(sql),
    };
}

/**
 * Deliberate partial double for ConnectionManager (only the methods any one
 * provider actually calls); callers cast the result with
 * `as unknown as ConnectionManager` at construction time since a full typed
 * double would be larger than the tests. Parameterized by the driver shape
 * (`TDriver`) and the executeWithRetry options shape (`TOptions`) because
 * different providers exercise different subsets of ConnectionManager's real
 * (wider) method signatures.
 */
export interface FakeConnectionManager<TDriver, TOptions = Record<string, never>> {
    getActiveConnection?: () => StoredConnection | undefined;
    isExecutionPlanAvailable?: (connectionId?: string) => boolean;
    getDriver: (connectionId?: string, role?: string) => Promise<TDriver>;
    executeWithRetry: <T>(fn: () => Promise<T>, connectionId?: string, options?: TOptions) => Promise<T>;
}

/** Casts a FakeConnectionManager double to the real ConnectionManager type
 * for passing into a provider constructor; see the FakeConnectionManager
 * doc comment for why this cast is the intended usage, not a workaround. */
export function asConnectionManager<TDriver, TOptions>(
    fake: FakeConnectionManager<TDriver, TOptions>
): ConnectionManager {
    return fake as unknown as ConnectionManager;
}
