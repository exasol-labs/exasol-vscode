# Quick Start - 5 Minutes to Running Extension

## Step 1: Install Dependencies (30 seconds)
```bash
cd /Users/mikhail.zhadanov/exasol-vscode
npm install
```

## Step 2: Compile (15 seconds)
```bash
npm run compile
```

## Step 3: Open in VS Code (5 seconds)
```bash
code .
```

## Step 4: Launch Extension (10 seconds)

**Option A: Using F5 Key**
- Just press `F5`
- A new VS Code window opens with "[Extension Development Host]" in the title
- ✅ Extension is now running!

**Option B: Using Run Menu**
- Click `Run` menu → `Start Debugging`
- Or click the green play button in the debug panel
- ✅ Extension is now running!

## Step 5: Use the Extension (2 minutes)

In the **new window** that opened:

### 1. Open Exasol Panel
- Click the Exasol icon (blue "E") in the left sidebar

### 2. Add Connection
- Click the `+` button
- Enter:
  - Name: `Local Exasol`
  - Host: `localhost:8563`
  - Username: `sys`
  - Password: `exasol`
- Press Enter after each field

### 3. Browse Database
- Expand your connection
- See schemas, tables, views
- Click to explore!

### 4. Write and Execute Query
- Create new file: `test.sql`
- Type:
  ```sql
  SELECT * FROM INFORMATION_SCHEMA.TABLES LIMIT 10;
  ```
- Press `Cmd+Enter` (Mac) or `Ctrl+Enter` (Windows/Linux)
- See results in the panel!

## 🎉 Done! Your extension is running!

---

## Common Commands

```bash
# Compile and watch for changes
npm run watch

# Run tests
npm test

# Package for installation
npx @vscode/vsce package
```

---

## Troubleshooting

### "Cannot find module" error
```bash
npm install
```

### Compilation errors
```bash
rm -rf out node_modules
npm install
npm run compile
```

### Extension not loading
- Close ALL VS Code windows
- Reopen and press F5 again

### Connection fails
- Ensure Exasol is running at localhost:8563
- Check credentials: sys:exasol
- Test with: `telnet localhost 8563`

---

## What You Get

✅ **Connection Management**
- Multiple connections
- Secure password storage
- Easy switching

✅ **IntelliSense**
- SQL keywords (140+)
- Functions (180+)
- Tables, views, columns
- Context-aware suggestions

✅ **Object Browser**
- Full database hierarchy
- Tables with row counts
- Columns with types
- Right-click actions

✅ **Query Execution**
- Execute full file or selection
- Cancellable queries
- Results with sort/filter
- Export CSV/JSON

✅ **Session Management**
- Active schema tracking
- Status bar integration
- Quick schema switching

✅ **Advanced Features**
- Table data preview
- DDL generation
- SELECT statement generation
- Query history

---

## Next Steps

1. **Explore Features**
   - Right-click tables for actions
   - Try autocomplete (type `SEL` + Ctrl+Space)
   - Filter results
   - Export data

2. **Read Documentation**
   - `README.md` - Full feature list
   - `INSTALLATION.md` - Detailed setup
   - `src/test/README.md` - Test documentation

3. **Run Tests**
   ```bash
   npm test
   ```

4. **Package Extension**
   ```bash
   npx @vscode/vsce package
   # Creates: exasol-vscode-2.0.0.vsix
   # Install with: code --install-extension exasol-vscode-2.0.0.vsix
   ```

---

## Support

Questions? Check:
- `README.md` for features
- `INSTALLATION.md` for setup help
- GitHub Issues for bugs/features
