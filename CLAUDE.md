# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Visual Studio Code extension for Exasol databases. It provides database connection management, SQL editing with IntelliSense, query execution, and a comprehensive object browser for exploring database schemas, tables, views, and columns.

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

## Architecture

### Core Components

**ConnectionManager** (`src/connectionManager.ts`)
- Manages database connections and credentials
- Stores passwords securely using VS Code's Secret Storage API
- Maintains active connection state and driver instances
- Provides connection testing and lifecycle management
- Emits events for connection and active connection changes

**QueryExecutor** (`src/queryExecutor.ts`)
- Executes SQL queries against the active connection
- Handles both result-set queries (SELECT) and non-result-set queries (DDL/DML)
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

### Testing Database Operations
- Use test configuration in `src/test/testConfig.ts`
- Mock VS Code APIs when needed (context, secrets, globalState)
- Test both success and error paths
- Verify event emissions for state changes
