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
- **Object explorer** — browse schemas, tables, views, columns, scripts, functions, virtual schemas, constraints, indices, and system tables
- **Object actions** — right-click to preview data, show DDL, generate SELECT, describe table
- **Results viewer** — sortable, filterable grid with CSV export and cell inspection
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
npm run test:unit    # Unit tests (192 tests)
npm run test:local   # Webview rendering tests (jsdom)
npm run test:e2e     # E2E tests (requires compile first)
```

### Known build warnings

`npm ci` prints two transitive deprecation warnings (`prebuild-install` via `keytar`, `whatwg-encoding` via `cheerio`). Both come from `@vscode/vsce` and have no upstream fix yet. Tracked at https://github.com/microsoft/vscode-vsce/issues/1237.

A third warning, `npm warn skipping integrity check for git dependency ssh://git@github.com/mikhail-zhadanov/exasol-driver-ts.git`, appears because `@exasol/exasol-driver-ts` is installed from a git URL (the fork branch) instead of an npm tarball, so npm cannot verify a registry integrity hash. The SHA pin in `package.json` provides integrity (any tampering would change the SHA). Will go away once the upstream PR ([exasol/exasol-driver-ts#59](https://github.com/exasol/exasol-driver-ts/pull/59)) merges and we switch back to the npm release.

### Forked driver

`@exasol/exasol-driver-ts` is temporarily sourced from a fork at [mikhail-zhadanov/exasol-driver-ts](https://github.com/mikhail-zhadanov/exasol-driver-ts) (v0.4.1, rebased on upstream 0.4.0). The fork replaces `node-forge` with Node's built-in `node:crypto` in both the RSA login path and the local CSV import TLS-certificate path, removing `node-forge` from the bundle entirely (~280 KB of `extension.js`). The pin reverts to the upstream package once the change lands there ([exasol/exasol-driver-ts#59](https://github.com/exasol/exasol-driver-ts/pull/59)).

## Limitations

- Large result sets (>10,000 rows) may impact rendering performance
- Query cancellation relies on driver support; some queries may not cancel immediately
- Importing local files is not yet available from the extension; only cloud file imports work. Local CSV import support exists in the driver as of 0.4.1, but the extension UI wiring is tracked separately ([#9](https://github.com/exasol-labs/exasol-vscode/issues/9))

## Support

- [GitHub Issues](https://github.com/exasol-labs/exasol-vscode/issues)
- Contributions welcome — submit issues or pull requests

## License

MIT
