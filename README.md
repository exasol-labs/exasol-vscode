# Exasol Extension for Visual Studio Code

A Visual Studio Code extension for working with Exasol databases. Provides database management, intelligent SQL editing, and query execution.

> **Note:** This extension is a **community-supported prototype** and not officially supported by Exasol.

## Installation

For Visual Studio Code, install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/).

For Cursor and other VS Code-compatible editors that use the Open VSX Registry, install it from [Open VSX](https://open-vsx.org/extension/Exasol/exasol-vscode).

## Quickstart

1. Install the extension from the marketplace for your editor, or install a `.vsix` file
2. Click the Exasol icon in the sidebar, then `+` to add a connection
3. Enter the database host, port, credentials, and TLS mode
4. Open a `.sql` file and press `Cmd+Enter` (Mac) / `Ctrl+Enter` (Windows/Linux) to execute

## Features

- **Connection management** — multiple connections, secure password storage, status bar indicator
- **Query execution** — full file or selection, cancellable, automatic LIMIT, multi-statement support
- **Separate result tabs** — toggle via Command Palette to view each statement's result in its own tab
- **IntelliSense** — context-aware completions for keywords, functions, tables, views, and columns
- **Object explorer** — browse schemas, tables, views, columns, scripts, functions, virtual schemas, constraints, indices, and system tables
- **Object actions** — right-click to preview data, show DDL, generate SELECT, describe table
- **Results viewer** — sortable, filterable grid with CSV export and cell inspection
- **Local file transfer** — CSV and Parquet imports through the driver, plus direct table/query-to-CSV export
- **Execution plan viewer** — a "Plan" tab alongside every query result, showing a visual per-operator breakdown (cost share, duration, rows, CPU/network/disk) with warnings for skew, disk spills, and large redistributions; available for any profiled statement, not just SELECT — DDL, DML, IMPORT, and EXPORT included
- **Query history** — automatic tracking with execution time, row counts, and error indicators
- **SQL Notebooks** — interactive `.exabook` notebooks with SQL cells, inline results, and markdown documentation
- **SQL formatting** — configurable keyword case, indentation, and statement spacing
- **Session management** — active schema tracking, persistent state across restarts

## Keyboard Shortcuts

| Action | Windows/Linux | Mac |
|--------|---------------|-----|
| Execute query | `Ctrl+Enter` | `Cmd+Enter` |
| Execute selection | `Ctrl+Shift+Enter` | `Cmd+Shift+Enter` |
| Execute entire script | `Ctrl+Alt+Enter` | `Cmd+Alt+Enter` |
| Find database object | `Ctrl+Shift+F` (objects view) | `Cmd+Shift+F` (objects view) |

## Configuration

`Settings > Extensions > Exasol`, or search "exasol" in Settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `maxResultRows` | 10000 | Max rows to fetch per query |
| `queryTimeout` | 300 | Query timeout in seconds |
| `fetchSize` | 1048576 | Approximate bytes fetched per result-set request |
| `maxQueryHistorySize` | 1000 | Queries to keep in history |
| `autoComplete` | true | Enable IntelliSense |
| `separateResultTabs` | false | Show each statement result in a separate tab |
| `executionPlan` | true | Enable execution plan capture and the Plan tab; new user connections automatically enable session profiling |
| `exportSource` | empty | Optional default source for direct CSV export: a table or parenthesized query |
| `formatter.*` | — | Keyword case, indent style, tab width, statement spacing |

## Limitations

- Large result sets (>10,000 rows) may impact rendering performance
- Query cancellation depends on Exasol and network state; local file operations use the driver's `AbortSignal` cancellation and release their resources
- Local file import is supported for CSV and Parquet via `IMPORT INTO <table> FROM LOCAL CSV|PARQUET FILE '<path>'`. The cluster must be able to open a connection back to the client machine for the import tunnel. Parquet requires Exasol 2025.1.9 or later.
- `Exasol: Export Table or Query to CSV` streams a table or parenthesized query directly to a local CSV file through the driver, including column names and cancellation. `Exasol: Export Results to CSV` remains available for exporting the currently displayed result grid.
- Direct CSV export uses `queryTimeout` as its maximum wall-clock duration; increase that setting for exports of very large data sets.
- Cloud/server-side `IMPORT` and `EXPORT` statements continue to execute as ordinary SQL. Local FBV imports, multi-file local imports, and local Parquet export have no dedicated extension support.
- Execution plans require session profiling. When `executionPlan` is enabled, the extension runs `ALTER SESSION SET PROFILE = 'ON'` on new user connections; reconnect after changing the setting or after a profiling setup failure
- The Plan tab is only available for single-statement results — not yet for the multi-statement "Result 1 / Result 2" tab bar

## Development

```bash
git clone https://github.com/exasol-labs/exasol-vscode.git
cd exasol-vscode
npm install
npm run compile
```

Press `F5` to launch the Extension Development Host.

```bash
npm run watch              # Auto-compile on changes
npm run test:unit          # Unit tests
npm run test:local         # Webview rendering tests (jsdom)
npm run test:driver-docker # Driver import/export tests against local Exasol Docker
npm run test:e2e           # VS Code integration tests
```

The extension uses the official `@exasol/exasol-driver-ts` 0.8.0 package. `npm ci` may print transitive deprecation warnings from `@vscode/vsce` dependencies; these do not affect runtime use.

## Support

- [GitHub Issues](https://github.com/exasol-labs/exasol-vscode/issues)
- Contributions welcome — submit issues or pull requests

## License

MIT
