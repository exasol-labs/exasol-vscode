# Exasol Extension for Visual Studio Code

A Visual Studio Code extension for working with Exasol databases. Provides database management, intelligent SQL editing, and query execution.

> **Note:** This extension is a **community-supported prototype** and not officially supported by Exasol.

## Quickstart

1. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/) (search "Exasol") or from a `.vsix` file
2. Click the Exasol icon in the sidebar, then `+` to add a connection
3. Open a `.sql` file and press `Cmd+Enter` (Mac) / `Ctrl+Enter` (Windows/Linux) to execute

## Features

- **Connection management** — multiple connections, secure password storage, status bar indicator
- **Query execution** — full file or selection, cancellable, automatic LIMIT, multi-statement support
- **Separate result tabs** — toggle via Command Palette to view each statement's result in its own tab
- **IntelliSense** — context-aware completions for keywords, functions, tables, views, and columns
- **Object explorer** — browse schemas, tables, views, and columns with row counts and types
- **Object actions** — right-click to preview data, show DDL, generate SELECT, describe table
- **Results viewer** — sortable, filterable grid with CSV export and cell inspection
- **Query history** — automatic tracking with execution time, row counts, and error indicators
- **SQL formatting** — configurable keyword case, indentation, and statement spacing
- **Session management** — active schema tracking, persistent state across restarts

## Keyboard Shortcuts

| Action | Windows/Linux | Mac |
|--------|---------------|-----|
| Execute query | `Ctrl+Enter` | `Cmd+Enter` |
| Execute selection | `Ctrl+Shift+Enter` | `Cmd+Shift+Enter` |

## Configuration

`Settings > Extensions > Exasol`, or search "exasol" in Settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `maxResultRows` | 10000 | Max rows to fetch per query |
| `queryTimeout` | 300 | Query timeout in seconds |
| `maxQueryHistorySize` | 1000 | Queries to keep in history |
| `autoComplete` | true | Enable IntelliSense |
| `separateResultTabs` | false | Show each statement result in a separate tab |
| `formatter.*` | — | Keyword case, indent style, tab width, statement spacing |

## Development

```bash
git clone https://github.com/exasol-labs/exasol-vscode.git
cd exasol-vscode
npm install
npm run compile
```

Press `F5` to launch the Extension Development Host.

```bash
npm run watch        # Auto-compile on changes
npm run test:unit    # Unit tests (122 tests)
npm run test:local   # Webview rendering tests (jsdom)
npm run test:e2e     # E2E tests (requires compile first)
```

## Limitations

- Large result sets (>10,000 rows) may impact rendering performance
- Query cancellation relies on driver support; some queries may not cancel immediately
- The [Exasol TypeScript driver](https://github.com/exasol/exasol-driver-ts) only supports cloud file uploads

## Support

- [GitHub Issues](https://github.com/exasol-labs/exasol-vscode/issues)
- Contributions welcome — submit issues or pull requests

## License

MIT
