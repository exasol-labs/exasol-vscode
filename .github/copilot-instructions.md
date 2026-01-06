# Exasol VS Code Extension - AI Coding Agent Instructions

## Project Overview

VS Code extension for Exasol databases providing connection management, SQL IntelliSense, query execution (including multi-query), and hierarchical object browsing. Built with TypeScript targeting `@exasol/exasol-driver-ts` (WebSocket-based driver).

## Architecture: Component Boundaries

**Core Managers** ([src/connectionManager.ts](../src/connectionManager.ts), [src/sessionManager.ts](../src/sessionManager.ts), [src/queryExecutor.ts](../src/queryExecutor.ts))
- ConnectionManager owns driver instances, credential storage (VS Code Secrets API), and connection lifecycle
- SessionManager persists active schema per connection in workspace state
- QueryExecutor handles query classification (SELECT vs DDL/DML), auto-LIMIT, and multi-query splitting

**Providers** ([src/providers/](../src/providers/))
- Tree providers refresh on manager events (`onDidChangeConnections`, `onDidChangeActiveConnection`)
- CompletionProvider caches metadata with 5-min TTL; invalidated on schema change
- CodeLensProvider adds executable "▶ Execute" buttons above SQL statements

**Panels** ([src/panels/](../src/panels/))
- Webview-based with message passing; HTML embedded in TypeScript
- ResultsPanel supports client-side sorting/filtering; export to CSV/JSON

## Critical Pattern: Centralized Connection Error Handling

**MANDATORY for all database operations:**

```typescript
// ✅ CORRECT - Use ConnectionManager.executeWithRetry()
return await this.connectionManager.executeWithRetry(async () => {
    const driver = await this.connectionManager.getDriver(connectionId);
    const result = await driver.query('SELECT * FROM table');
    return processedData;
}, connectionId);
```

**Why:** Single source of truth for stale connection detection (10+ error types: ECONNRESET, EPIPE, WebSocket errors, etc.). Auto-reconnects in <1 second via WebSocket readyState check + `SELECT 1` fallback. **Never implement local retry logic** - see [src/connectionManager.ts#L268-L345](../src/connectionManager.ts#L268-L345) for canonical implementation.

Reference: [src/queryExecutor.ts#L70](../src/queryExecutor.ts#L70), [src/providers/objectTreeProvider.ts#L235](../src/providers/objectTreeProvider.ts#L235)

## Security: Credential Storage

```typescript
// Passwords NEVER in globalState - use Secrets API
await context.secrets.store(`exasol.password.${connectionId}`, password);
const password = await context.secrets.get(`exasol.password.${connectionId}`);
```

Connection metadata (host, user, name) stored in `globalState`, passwords separately keyed by connection ID.

## Build & Packaging

**Development:** `npm run watch` (auto-compile) + F5 to launch Extension Development Host

**CRITICAL - VSIX Packaging:**
```bash
npx vsce package  # ✅ MUST include dependencies (~1.07 MB, 198 files)
```
**NEVER use `--no-dependencies`** - breaks runtime (`@exasol/exasol-driver-ts`, `ws` required).

## Testing

**Config:** [src/test/testConfig.ts](../src/test/testConfig.ts) - requires local Exasol at `localhost:8563` (sys/exasol)

```bash
npm run test:unit   # Fast Mocha tests (~1800 lines coverage)
npm test           # Full integration tests (compiles, lints, runs)
```

Tests auto-create `TEST_SCHEMA` and clean up. See [src/test/README.md](../src/test/README.md).

## Multi-Query Execution Pattern

[src/queryExecutor.ts#L159-L245](../src/queryExecutor.ts#L159-L245) splits queries by semicolons, executes sequentially with progress indicators (Query 1/3...). On error, prompts user to continue or stop. Each query logged to history individually.

## Adding Commands

1. Register in [src/extension.ts](../src/extension.ts) `activate()`: `vscode.commands.registerCommand(...)`
2. Add to [package.json](../package.json) `contributes.commands` and `contributes.menus`
3. Push to `context.subscriptions`

## Language Support

Custom `exasol-sql` language ([syntaxes/exasol-sql.tmLanguage.json](../syntaxes/exasol-sql.tmLanguage.json)):
- 140+ SQL keywords, 180+ built-in functions with snippets
- File extensions: `.sql`, `.exasql`, `.exs`

## Configuration Settings

[package.json](../package.json) - User settings:
- `exasol.maxQueryHistorySize`: 1000 (default)
- `exasol.queryTimeout`: 300 seconds
- `exasol.maxResultRows`: 10000
- `exasol.connectionValidationTimeout`: 1 second (range: 1-5s)

## Event-Driven Updates

Tree providers listen to manager events:
```typescript
connectionManager.onDidChangeActiveConnection(() => {
    statusBarItem.text = sessionManager.getStatusBarText();
});
```
Enables loose coupling - managers emit, providers refresh UI.
