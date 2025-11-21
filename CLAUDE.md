# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Visual Studio Code extension for Exasol databases. It provides database connection management, SQL editing with IntelliSense, query execution (including multiple query execution), and a comprehensive object browser for exploring database schemas, tables, views, and columns.

## Development Commands

### Build and Watch
```bash
npm run compile          # Compile TypeScript to JavaScript
npm run watch           # Watch mode - recompile on file changes
npm run vscode:prepublish  # Production build (runs compile)
```

### Testing
```bash
npm test                # Run all tests (compiles, lints, then runs integration tests)
npm run test:unit       # Run unit tests only with Mocha
npm run test:watch      # Run unit tests in watch mode
npm run pretest         # Compile and lint before testing
```

### Linting
```bash
npm run lint            # Currently skipped - placeholder for future linting setup
```

### Development Workflow
When developing, use `npm run watch` in one terminal to auto-compile TypeScript changes, then press F5 in VS Code to launch the Extension Development Host for testing.

### Packaging the Extension
**CRITICAL: Always package WITH dependencies**
```bash
npx vsce package           # ✅ CORRECT - Includes node_modules (1.07 MB)
npx vsce package --no-dependencies  # ❌ WRONG - Breaks extension (114 KB)
```

**Why this matters:**
- The extension requires `@exasol/exasol-driver-ts` and `ws` (WebSocket library) at runtime
- Without dependencies, all commands fail with "command not found" errors
- The VSIX must be ~1 MB and include 198 files (not ~114 KB with 51 files)
- **NEVER use `--no-dependencies` flag when packaging this extension**

### Building VSIX for User Testing
**IMPORTANT: Always build a VSIX after making changes for the user to test locally**

After completing any feature or fix:
1. **Compile**: `npm run compile` - Ensure no TypeScript errors
2. **Package**: `npx vsce package` - Build the VSIX with dependencies
3. **Verify**: `ls -lh exasol-vscode-0.1.4.vsix` - Check size (~1.1 MB)
4. **Inform user**: Provide location and installation instructions

**Why this matters:**
- User needs testable VSIX to verify changes work correctly
- Local testing is essential before publishing
- VSIX file is at: `/Users/mikhail.zhadanov/exasol-vscode/exasol-vscode-0.1.4.vsix`

**Installation command:**
```bash
code --install-extension exasol-vscode-0.1.4.vsix
```

## Architecture

### Core Components

**ConnectionManager** (`src/connectionManager.ts`)
- Manages database connections and credentials
- Stores passwords securely using VS Code's Secret Storage API
- Maintains active connection state and driver instances
- Provides connection testing and lifecycle management
- Emits events for connection and active connection changes
- **Fast Stale Connection Detection**: Two-tier validation approach
  - **Instant check**: WebSocket readyState inspection (0ms overhead)
  - **Fallback validation**: `SELECT 1` query with 1-second timeout (configurable)
  - Detects stale connections in <1 second instead of 5+ seconds
  - Automatically reconnects on first user action after connection becomes stale
- **Centralized Error Handling**: `executeWithRetry<T>()` method
  - Single source of truth for all connection error detection
  - Detects 10+ connection error types (ECONNRESET, EPIPE, ETIMEDOUT, WebSocket, etc.)
  - Automatically resets driver and retries once on connection errors
  - Used by QueryExecutor, ObjectTreeProvider, CompletionProvider
  - **CRITICAL**: All new database operations MUST use this method (see "Handling Connection Errors" pattern)

**QueryExecutor** (`src/queryExecutor.ts`)
- Executes SQL queries against the active connection
- Handles both result-set queries (SELECT) and non-result-set queries (DDL/DML)
- **Multiple Query Execution**: Automatically splits and executes multiple queries sequentially
  - Queries separated by semicolons are executed one by one
  - Progress shown for each query (Query 1/3, Query 2/3, etc.)
  - If a query fails, user can choose to continue or stop remaining queries
  - All queries added to history individually with their results
- Implements cancellable query execution with CancellationToken
- Automatically adds LIMIT clause to SELECT queries without explicit LIMIT
- Returns QueryResult with columns, rows, rowCount, and executionTime

**SessionManager** (`src/sessionManager.ts`)
- Manages session state per connection (active schema)
- Persists session state using VS Code's workspace state
- Executes `OPEN SCHEMA` commands to set the active schema
- Provides session refresh and clear functionality

**ObjectActions** (`src/objectActions.ts`)
- Implements context menu actions for database objects
- Actions: preview table data, show DDL, generate SELECT, describe table
- Creates read-only text documents for DDL and table descriptions

### Providers (src/providers/)

**ConnectionTreeProvider** - Displays connection list in the sidebar
**ObjectTreeProvider** - Displays hierarchical database objects (connection → schemas → tables/views → columns)
**QueryHistoryProvider** - Tracks executed queries with success/error status
**ExasolCompletionProvider** - IntelliSense with cached completions for keywords, functions, tables, views, and columns
**ExasolCodeLensProvider** - Adds "▶ Execute" buttons above SQL statements

### Panels (src/panels/)

**ResultsPanel** - Webview panel displaying query results with sorting, filtering, and CSV/JSON export
**QueryStatsPanel** - Webview panel showing execution metrics (time, rows, throughput)
**ConnectionPanel** - Webview panel for adding/editing connections with connection testing

### Entry Point

**extension.ts** (`src/extension.ts`)
- `activate()` - Initializes all components, registers commands, and sets up tree views
- Registers 20+ commands for connection management, query execution, and object actions
- Sets up event listeners for connection changes and session updates
- Creates status bar item showing active connection and schema

## Key Design Patterns

### Secure Credential Storage
- Connection metadata stored in `globalState` (without passwords)
- Passwords stored separately in VS Code's `secrets` API with keys like `exasol.password.{connectionId}`
- Never persist passwords in plain text or workspace state

### Event-Driven Architecture
- Managers emit events (e.g., `onDidChangeConnections`, `onDidChangeActiveConnection`)
- Tree providers listen to events and call `refresh()` to update UI
- Enables loose coupling between components

### Lazy Loading
- Database driver connections established on-demand via `getDriver()`
- Object tree expands nodes lazily (schemas → tables/views → columns)
- Completion provider caches metadata with 5-minute TTL

### Cancellable Operations
- Query execution supports VS Code's CancellationToken
- Users can cancel long-running queries via progress notification
- Token checked at multiple points during execution

### Webview Communication
- Panels use VS Code webview API with message passing
- HTML templates embedded in TypeScript files
- Results panel supports interactive features (sort, filter, export)

## Testing

Tests are located in `src/test/` with ~1800 lines of test code covering:
- `connectionManager.test.ts` - Connection CRUD operations
- `queryExecutor.test.ts` - Query execution and cancellation
- `sessionManager.test.ts` - Schema management
- `objectTreeProvider.test.ts` - Tree view hierarchy
- `completionProvider.test.ts` - IntelliSense functionality
- `queryHistoryProvider.test.ts` - History tracking
- `objectActions.test.ts` - Context menu actions
- `integration.test.ts` - End-to-end workflows

Run tests with `npm run test:unit` for fast unit tests or `npm test` for full integration tests.

## Database Driver

The extension uses `@exasol/exasol-driver-ts` (Exasol's official TypeScript driver) for database connectivity. Key methods:
- `driver.query(sql)` - Execute queries returning result sets
- `driver.execute(sql)` - Execute DDL/DML statements
- Connection established via WebSocket protocol

The driver is wrapped in utility functions (`src/utils.ts`):
- `executeWithoutResult()` - Execute statements without expecting results
- `getColumnsFromResult()` - Extract column metadata
- `getRowsFromResult()` - Extract row data

## Language Support

The extension contributes a custom `exasol-sql` language ID with:
- Syntax highlighting via TextMate grammar (`syntaxes/exasol-sql.tmLanguage.json`)
- Language configuration (`language-configuration.json`) for comments, brackets, auto-closing pairs
- File extensions: `.sql`, `.exasql`, `.exs`
- 140+ SQL keywords and 180+ built-in functions recognized

## Configuration

User-configurable settings (via `package.json` contributions):
- `exasol.maxQueryHistorySize` - Default: 1000
- `exasol.queryTimeout` - Default: 300 seconds
- `exasol.maxResultRows` - Default: 10000
- `exasol.connectionValidationTimeout` - Default: 1 second (range: 1-5 seconds recommended)
- `exasol.autoComplete` - Default: true

## Common Development Patterns

### Adding a New Command
1. Register command in `activate()` using `vscode.commands.registerCommand()`
2. Add command to `package.json` under `contributes.commands`
3. Add to appropriate menu in `package.json` under `contributes.menus`
4. Add disposable to `context.subscriptions.push()`

### Working with Database Objects
- Always use the active connection via `connectionManager.getActiveConnection()`
- Obtain driver via `await connectionManager.getDriver()`
- Handle errors gracefully and show user-friendly messages
- Log to output channel via `getOutputChannel().appendLine()`

### Handling Connection Errors (CRITICAL PATTERN)

**IMPORTANT:** All database operations MUST use the centralized error handling pattern to ensure consistent stale connection detection and automatic retry logic.

**✅ CORRECT - Use ConnectionManager.executeWithRetry():**
```typescript
// Wrap ALL database operations in executeWithRetry
return await this.connectionManager.executeWithRetry(async () => {
    const driver = await this.connectionManager.getDriver(connectionId);
    const result = await driver.query('SELECT * FROM table');
    // ... process result ...
    return processedData;
}, connectionId); // connectionId is optional, defaults to active connection
```

**❌ WRONG - Do NOT implement local retry logic:**
```typescript
// DON'T DO THIS - duplicates error handling
try {
    const driver = await this.connectionManager.getDriver();
    return await driver.query('SELECT * FROM table');
} catch (error) {
    if (error.message.includes('ECONNRESET')) { // Don't duplicate this!
        await this.connectionManager.resetDriver();
        return await driver.query('SELECT * FROM table');
    }
}
```

**Why this pattern?**
- **Single source of truth:** All connection error detection in `ConnectionManager.isConnectionError()`
- **Consistent behavior:** Same fast stale detection across QueryExecutor, ObjectTreeProvider, CompletionProvider
- **Easy maintenance:** Add new error types in one place
- **DRY principle:** No code duplication

**Connection errors detected automatically:**
- `E-EDJS-8` - Pool exhaustion
- `ECONNRESET` - Connection reset by peer
- `EPIPE` - Broken pipe
- `ETIMEDOUT` - Operation timed out
- `ENOTFOUND` - Host not found
- `ECONNREFUSED` - Connection refused
- `connection closed` - Explicit close
- `WebSocket` - WebSocket-level errors
- `socket hang up` - Socket hang up
- `timeout` - Any timeout errors

**When adding new database operations:**
1. Always wrap in `connectionManager.executeWithRetry()`
2. NEVER implement local `executeWithRetry` or retry logic
3. NEVER duplicate error detection patterns
4. Trust the centralized handler to manage reconnection

**Reference implementations:**
- `queryExecutor.ts:49-140` - Query execution with retry
- `objectTreeProvider.ts:235` - Tree data fetching with retry
- `completionProvider.ts:158` - Autocomplete data with retry

### Testing Database Operations
- Use test configuration in `src/test/testConfig.ts`
- Mock VS Code APIs when needed (context, secrets, globalState)
- Test both success and error paths
- Verify event emissions for state changes
