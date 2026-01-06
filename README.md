# Exasol Extension for Visual Studio Code

A feature-rich Visual Studio Code extension for working with Exasol databases. Provides comprehensive database management, intelligent SQL editing, and powerful query execution capabilities.

## 🚀 Quick Start (5 Minutes)

### Prerequisites
- Node.js (v14 or higher)
- VS Code (v1.85.0 or higher)
- Exasol database instance

### Launch Extension

```bash
cd exasol-vscode
npm install
npm run compile
code .
```

Press `F5` in VS Code → New window opens with "[Extension Development Host]" title

### First Steps

In the **new window** that opened:

1. **Add Connection**
   - Click the Exasol icon (blue "E") in the left sidebar
   - Click the `+` button
   - Enter: `Local Exasol`, `localhost:8563`, `sys`, `exasol`

2. **Browse Database**
   - Expand connection → schemas → tables → columns
   - See row counts and column types

3. **Execute Query**
   - Create `test.sql`
   - Type: `SELECT * FROM INFORMATION_SCHEMA.TABLES LIMIT 10;`
   - Press `Cmd+Enter` (Mac) or `Ctrl+Enter` (Windows/Linux)

🎉 **You're running!**

---

## Features

### 🔐 Connection Management
- Multiple connections with **secure password storage** (VS Code Secret Storage API)
- Switch between connections easily
- Test connections before saving
- Active connection shown in status bar

### 🚀 SQL Query Execution
- Execute full file: `Ctrl+Enter` / `Cmd+Enter`
- Execute selection: `Ctrl+Shift+Enter` / `Cmd+Shift+Enter`
- **Cancellable queries** - stop long-running operations
- Export results to **CSV/JSON**
- Automatic LIMIT clause for SELECT queries
- Query timeout and row limits

### 🎯 IntelliSense & Autocomplete
- **Context-aware completions**: keywords, functions, tables, views, columns
- 140+ SQL keywords, 180+ built-in functions
- Smart suggestions based on current schema
- Schema-qualified names (`SCHEMA.TABLE.COLUMN`)
- 5-minute metadata cache for performance

### 🗂️ Advanced Object Explorer
- **Complete hierarchy**: Connection → Schema → Tables/Views → Columns
- Table row counts displayed
- Column types and nullable status
- System schemas filtered
- Lazy loading for performance

### 🔍 Object Actions (Right-Click)
- **Preview Table Data** - First 100 rows instantly
- **Show DDL** - Generate CREATE TABLE/VIEW statements
- **Generate SELECT** - Auto-create queries with all columns
- **Describe Table** - Detailed column information
- **Set Active Schema** - Change session context

### 📊 Results Viewer
- Interactive table with **real-time filtering**
- **Sortable columns** - click headers to sort
- Column tooltips for long values
- Row counter (visible/total)
- Export CSV/JSON with proper formatting
- Performance metrics (execution time, row count)

### 🎭 Session Management
- Active schema tracking per connection
- Persistent session state across VS Code restarts
- Status bar integration
- Quick schema switching

### 📜 Query History
- Automatic tracking of all executed queries
- Configurable size (default: 1000 queries)
- Execution time, row counts, and errors
- Query previews with tooltips
- Success/error indicators

### 📝 SQL Language Support
- Syntax highlighting for Exasol SQL
- Comment support (line and block)
- Code folding with region markers
- File extensions: `.sql`, `.exasol`, `.exs`

---

## Installation

### Method 1: Development Mode (Recommended for Testing)

```bash
cd exasol-vscode
npm install
npm run compile
code .
# Press F5
```

Benefits:
- Hot reload on changes (press `F5` again)
- Debug console and breakpoints
- Extension logs visible

### Method 2: Package and Install (.vsix)

```bash
npm install -g @vscode/vsce
vsce package  # Creates exasol-vscode-0.1.6.vsix
code --install-extension exasol-vscode-0.1.6.vsix
```

Or via VS Code UI: Extensions → "..." → "Install from VSIX..."

### Method 3: From Marketplace (Future)

Once published: Extensions → Search "Exasol" → Install

---

## Commands

### General
- `Exasol: Add Connection` - Add database connection
- `Exasol: Refresh Connections` - Refresh tree
- `Exasol: Execute Query` - Execute entire file
- `Exasol: Execute Selected Query` - Execute selection
- `Exasol: Show Query History` - View history
- `Exasol: Export Results to CSV` - Export current results
- `Exasol: Clear Autocomplete Cache` - Clear IntelliSense cache

### Context Menu (Right-Click Objects)
- `Preview Table Data` - Show 100 rows
- `Describe Table` - View column definitions
- `Show Table DDL` - Generate CREATE TABLE
- `Show View DDL` - Generate CREATE VIEW
- `Generate SELECT Statement` - Create SELECT with all columns
- `Set as Active Schema` - Make schema active

---

## Keyboard Shortcuts

| Action | Windows/Linux | Mac |
|--------|---------------|-----|
| Execute Query | `Ctrl+Enter` | `Cmd+Enter` |
| Execute Selection | `Ctrl+Shift+Enter` | `Cmd+Shift+Enter` |
| Autocomplete | `Ctrl+Space` | `Ctrl+Space` |
| Command Palette | `Ctrl+Shift+P` | `Cmd+Shift+P` |

---

## Configuration

`File > Preferences > Settings` → Search "Exasol":

```json
{
  "exasol.maxQueryHistorySize": 1000,
  "exasol.queryTimeout": 300,
  "exasol.maxResultRows": 10000,
  "exasol.connectionValidationTimeout": 1,
  "exasol.autoComplete": true
}
```

### Settings Details

- `maxQueryHistorySize` - Queries to keep in history (default: 1000)
- `queryTimeout` - Timeout in seconds (default: 300)
- `maxResultRows` - Max rows to fetch (default: 10000)
- `connectionValidationTimeout` - Stale detection timeout (default: 1s)
- `autoComplete` - Enable IntelliSense (default: true)

---

## Troubleshooting

### Extension Not Loading
```bash
rm -rf out node_modules
npm install
npm run compile
```
- Close ALL VS Code windows
- Reopen and press F5

### "Command not found" Error
```bash
npm run compile
```

### Connection Fails
```bash
telnet localhost 8563  # Verify Exasol is running
```
- Check credentials (sys:exasol)
- Verify port 8563 accessible
- Check firewall settings

### IntelliSense Not Working
- Check: `"exasol.autoComplete": true`
- Run: "Exasol: Clear Autocomplete Cache"
- Verify active connection set

### Queries Fail
- Check status bar shows active connection
- Verify SQL syntax
- Check user permissions

---

## Development

### Setup
```bash
git clone <repository-url>
cd exasol-vscode
npm install
npm run compile
```

### Common Commands
```bash
npm run watch          # Auto-compile on changes
npm run compile        # Compile once
npm test              # Run all tests
npm run test:unit     # Unit tests only
npm run test:watch    # Watch mode
```

### Run Tests

**Requires local Exasol at `localhost:8563` with `sys:exasol` credentials**

```bash
npm test              # Full integration tests (32 tests)
npm run test:unit     # Fast unit tests
```

Tests auto-create `TEST_SCHEMA` and clean up. See [src/test/README.md](src/test/README.md).

### Debug Tests
1. Open `src/test` folder
2. Set breakpoints
3. Press `F5` → Select "Extension Tests"

### Watch Mode
```bash
npm run watch  # Terminal 1: auto-compile
# Press F5     # VS Code: launch extension
```

### Project Structure
```
exasol-vscode/
├── src/
│   ├── extension.ts              # Entry point
│   ├── connectionManager.ts      # Connections & credentials
│   ├── queryExecutor.ts          # Query execution
│   ├── sessionManager.ts         # Schema context
│   ├── objectActions.ts          # Table actions
│   ├── providers/
│   │   ├── completionProvider.ts    # IntelliSense
│   │   ├── objectTreeProvider.ts    # Object browser
│   │   └── queryHistoryProvider.ts  # Query history
│   ├── panels/
│   │   └── resultsPanel.ts          # Results viewer
│   └── test/                         # 32 tests
├── package.json                  # Extension manifest
└── syntaxes/
    └── exasol-sql.tmLanguage.json  # Syntax highlighting
```

---

## Publishing (Maintainers)

### Prepare Release

1. Update version in `package.json`
2. Update `CHANGELOG.md`
3. Test: `npm run compile && npm test`

### Publish

```bash
vsce login <publisher-name>
vsce publish
```

### Create GitHub Release

```bash
vsce package
# Upload exasol-vscode-0.1.6.vsix to GitHub release
```

**⚠️ CRITICAL:** Always use `vsce package` (NOT `--no-dependencies`). Extension requires `@exasol/exasol-driver-ts` and `ws` at runtime (~1.07 MB, 198 files).

---

## Uninstalling

**Via Command:**
```bash
code --uninstall-extension exasol.exasol-vscode
```

**Via UI:**
Extensions → "Exasol" → Gear icon → Uninstall

---

## Known Issues

- Very large result sets (>10,000 rows) may impact rendering performance
- Query cancellation relies on driver support; some queries may not cancel immediately

---

## Support

- **Issues**: [GitHub Issues](https://github.com/exasol/exasol-vscode/issues)
- **Tests**: [src/test/README.md](src/test/README.md)
- **AI Agents**: [.github/copilot-instructions.md](.github/copilot-instructions.md)

---

## Contributing

Contributions welcome! Please submit issues or pull requests.

---

## License

ISC

---

## Version History

- **v0.1.6** (current) - IntelliSense, object browser, session management, secure credentials, query cancellation
- **v1.0.0** (future) - Marketplace release
