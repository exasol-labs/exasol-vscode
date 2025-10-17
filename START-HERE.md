# 🚀 START HERE - Exasol VSCode Extension

## The Fastest Way to Get Started

### Option 1: One Command (Recommended)
```bash
./run-extension.sh
```
Then press `F5` in VS Code!

### Option 2: Manual Steps
```bash
npm install
npm run compile
code .
# Then press F5 in VS Code
```

---

## What This Extension Does

A **feature-complete** Exasol database extension matching Snowflake's capabilities:

✅ **IntelliSense** - Smart SQL completions (keywords, functions, tables, columns)
✅ **Object Browser** - Browse schemas, tables, views, columns with metadata
✅ **Query Execution** - Run queries with sort, filter, export (CSV/JSON)
✅ **Session Management** - Active schema tracking with status bar
✅ **Secure Storage** - Passwords stored in VSCode Secret Storage
✅ **Query Cancellation** - Stop long-running queries
✅ **Object Actions** - Preview data, view DDL, generate SELECTs
✅ **Query History** - Track all executed queries

---

## Quick Test (5 Minutes)

### 1. Launch Extension
```bash
cd /Users/mikhail.zhadanov/exasol-vscode
npm install && npm run compile
code .
```
Press `F5` in VS Code

### 2. Add Connection
In the new window:
- Click Exasol icon (left sidebar)
- Click `+` button
- Enter: `localhost:8563`, `sys`, `exasol`

### 3. Try Features
- **Browse**: Expand connection → schemas → tables
- **Query**: Create `test.sql`, type `SELECT 1`, press `Cmd+Enter`
- **IntelliSense**: Type `SEL` then `Ctrl+Space`
- **Actions**: Right-click a table → Preview Table Data

---

## Documentation

📖 **[QUICKSTART.md](QUICKSTART.md)** - 5-minute guide
📖 **[INSTALLATION.md](INSTALLATION.md)** - Complete setup instructions
📖 **[README.md](README.md)** - Full feature documentation
📖 **[src/test/README.md](src/test/README.md)** - Test documentation

---

## Run Tests

```bash
npm test
```

**Prerequisites:**
- Exasol running at localhost:8563
- Credentials: sys:exasol

**Tests include:**
- ✅ 32 comprehensive tests
- ✅ Connection management
- ✅ Query execution
- ✅ Object browser
- ✅ IntelliSense
- ✅ Integration workflows

---

## Project Structure

```
exasol-vscode/
├── src/
│   ├── extension.ts                 # Main entry point
│   ├── connectionManager.ts         # Connection & credentials
│   ├── queryExecutor.ts             # Query execution
│   ├── sessionManager.ts            # Schema context
│   ├── objectActions.ts             # Table actions
│   ├── providers/
│   │   ├── completionProvider.ts   # IntelliSense
│   │   ├── connectionTreeProvider.ts # Object browser
│   │   └── queryHistoryProvider.ts # Query history
│   ├── panels/
│   │   └── resultsPanel.ts         # Results viewer
│   └── test/                        # 32 comprehensive tests
├── package.json                     # Extension manifest
├── README.md                        # Full documentation
├── QUICKSTART.md                    # 5-minute guide
├── INSTALLATION.md                  # Setup instructions
└── START-HERE.md                    # This file!
```

---

## Key Features vs Snowflake

| Feature | Exasol Extension | Snowflake |
|---------|-----------------|-----------|
| IntelliSense | ✅ | ✅ |
| Object Browser | ✅ | ✅ |
| Session Management | ✅ | ✅ |
| Query Cancellation | ✅ | ✅ |
| Results Sort/Filter | ✅ | ✅ |
| Multiple Exports | ✅ (CSV, JSON) | ✅ |
| Preview Data | ✅ | ✅ |
| DDL Viewing | ✅ | ✅ |
| Secure Credentials | ✅ | ✅ |

**Status: Feature Parity Achieved! 🎉**

---

## Package for Installation

Create installable .vsix file:

```bash
npm install -g @vscode/vsce
vsce package
# Creates: exasol-vscode-2.0.0.vsix
```

Install:
```bash
code --install-extension exasol-vscode-2.0.0.vsix
```

---

## Keyboard Shortcuts

| Action | Mac | Windows/Linux |
|--------|-----|---------------|
| Execute Query | `Cmd+Enter` | `Ctrl+Enter` |
| Execute Selection | `Cmd+Shift+Enter` | `Ctrl+Shift+Enter` |
| Autocomplete | `Ctrl+Space` | `Ctrl+Space` |

---

## Troubleshooting

### Extension won't start
```bash
rm -rf out node_modules
npm install
npm run compile
```

### Connection fails
- Check Exasol is running: `telnet localhost 8563`
- Verify credentials: sys:exasol
- Check firewall/network

### Tests fail
- Ensure Exasol at localhost:8563
- Credentials: sys:exasol
- See `src/test/README.md`

---

## Next Steps

1. ✅ **Launch** - Run `./run-extension.sh` or press `F5`
2. ✅ **Connect** - Add localhost:8563 connection
3. ✅ **Explore** - Browse schemas and tables
4. ✅ **Query** - Execute SQL with `Cmd+Enter`
5. ✅ **Test** - Run `npm test` to verify all features

---

## Questions?

- 📖 Read `QUICKSTART.md` for quick guide
- 📖 Read `INSTALLATION.md` for detailed setup
- 📖 Read `README.md` for all features
- 🐛 Open GitHub issue for bugs
- 💡 Open GitHub issue for feature requests

---

## Version

**v2.0.0** - Major feature release
- Complete Snowflake feature parity
- 32 comprehensive tests
- Production-ready

Enjoy your new Exasol extension! 🎉
