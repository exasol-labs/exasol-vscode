# Installing and Running the Exasol VSCode Extension

## Method 1: Development Mode (Recommended for Testing)

### Prerequisites
- Node.js (v14 or higher)
- VS Code (v1.85.0 or higher)
- Exasol database instance

### Steps

1. **Navigate to the extension directory**
   ```bash
   cd /Users/mikhail.zhadanov/exasol-vscode
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Compile the extension**
   ```bash
   npm run compile
   ```

4. **Open in VS Code**
   ```bash
   code .
   ```

5. **Run the extension**
   - Press `F5` or go to `Run > Start Debugging`
   - This will open a new VS Code window with the extension loaded
   - The title will say "[Extension Development Host]"

6. **Use the extension in the new window**
   - Click the Exasol icon in the Activity Bar (left sidebar)
   - Add a connection using the "+" button
   - Start writing and executing SQL queries!

### Debug Mode Benefits
- Hot reload on code changes (just press `F5` again)
- Access to debug console and breakpoints
- See extension logs in the Debug Console

---

## Method 2: Package and Install (.vsix file)

### Create the Package

1. **Install vsce (VSCode Extension Manager)**
   ```bash
   npm install -g @vscode/vsce
   ```

2. **Package the extension**
   ```bash
   cd /Users/mikhail.zhadanov/exasol-vscode
   vsce package
   ```

   This creates: `exasol-vscode-2.0.0.vsix`

### Install the Package

#### Option A: Via Command Line
```bash
code --install-extension exasol-vscode-2.0.0.vsix
```

#### Option B: Via VS Code UI
1. Open VS Code
2. Go to Extensions view (`Cmd+Shift+X` or `Ctrl+Shift+X`)
3. Click the "..." menu in the top right
4. Select "Install from VSIX..."
5. Choose `exasol-vscode-2.0.0.vsix`
6. Reload VS Code when prompted

---

## Method 3: Install from Marketplace (Future)

Once published to the VS Code Marketplace:

1. Open VS Code Extensions view (`Cmd+Shift+X`)
2. Search for "Exasol"
3. Click "Install"

---

## Quick Start Guide

### 1. Add Your First Connection

After installation:

1. **Open Exasol View**
   - Click the Exasol icon in the Activity Bar (blue "E" icon)

2. **Add Connection**
   - Click the "+" button in the Connections panel
   - Enter connection details:
     - Name: `My Exasol DB`
     - Host: `localhost:8563` (or your server address)
     - Username: `sys` (or your username)
     - Password: `exasol` (or your password)
   - Click Enter after each field

3. **Connection Test**
   - The extension will test the connection
   - If successful: "Connection 'My Exasol DB' added successfully"
   - If failed: Error message with details

### 2. Browse Database Objects

1. **Expand Connection**
   - Click the arrow next to your connection name
   - View all schemas (system schemas filtered out)

2. **Browse Schema Objects**
   - Click a schema to expand
   - See "Tables" and "Views" folders
   - Expand to see all tables/views

3. **View Column Details**
   - Click a table or view
   - See all columns with data types
   - Hover for additional info (nullable, etc.)

### 3. Execute Your First Query

1. **Create SQL File**
   - `File > New File`
   - Save as `test.sql` or `test.exasql`

2. **Write Query**
   ```sql
   SELECT *
   FROM MY_SCHEMA.MY_TABLE
   LIMIT 10;
   ```

3. **Execute**
   - Full file: `Cmd+Enter` (Mac) or `Ctrl+Enter` (Windows/Linux)
   - Selected text: `Cmd+Shift+Enter` or `Ctrl+Shift+Enter`

4. **View Results**
   - Results appear in a new panel
   - Click column headers to sort
   - Use filter box to search
   - Export to CSV or JSON

### 4. Use IntelliSense

Start typing in a SQL file:

```sql
SEL  -- Press Ctrl+Space for completions
```

You'll see:
- SQL keywords (SELECT, FROM, WHERE, etc.)
- Functions (COUNT, SUM, UPPER, etc.)
- Your tables and views
- Columns (when typing after table name)

### 5. Use Context Menu Actions

Right-click on tables/views in the explorer:

- **Preview Table Data** - Quick view of first 100 rows
- **Describe Table** - See column definitions
- **Show Table DDL** - Generate CREATE TABLE statement
- **Generate SELECT Statement** - Auto-create query with all columns
- **Set as Active Schema** - Change your session schema

---

## Keyboard Shortcuts

| Action | Windows/Linux | Mac |
|--------|---------------|-----|
| Execute Query | `Ctrl+Enter` | `Cmd+Enter` |
| Execute Selection | `Ctrl+Shift+Enter` | `Cmd+Shift+Enter` |
| Open Command Palette | `Ctrl+Shift+P` | `Cmd+Shift+P` |
| Open Extensions | `Ctrl+Shift+X` | `Cmd+Shift+X` |

---

## Configuration

Access settings: `File > Preferences > Settings` (or `Code > Preferences > Settings` on Mac)

Search for "Exasol" to find:

```json
{
  // Maximum queries to keep in history
  "exasol.maxQueryHistorySize": 1000,

  // Query timeout in seconds
  "exasol.queryTimeout": 300,

  // Maximum rows to fetch
  "exasol.maxResultRows": 10000,

  // Enable autocomplete
  "exasol.autoComplete": true
}
```

---

## Troubleshooting

### Extension Not Showing Up

1. **Check installation**
   ```bash
   code --list-extensions | grep exasol
   ```

2. **Reload VS Code**
   - `Cmd+Shift+P` → "Developer: Reload Window"

3. **Check Extension Host Log**
   - `Help > Toggle Developer Tools`
   - Look for errors in Console tab

### Cannot Connect to Database

1. **Verify Exasol is running**
   ```bash
   telnet localhost 8563
   ```

2. **Check credentials**
   - Username and password are correct
   - User has appropriate permissions

3. **Check firewall**
   - Port 8563 is not blocked
   - Network allows connection

### IntelliSense Not Working

1. **Check setting**
   ```json
   "exasol.autoComplete": true
   ```

2. **Clear cache**
   - Open Command Palette (`Cmd+Shift+P`)
   - Run: "Exasol: Clear Autocomplete Cache"

3. **Verify connection**
   - Active connection must be set
   - Connection must be valid

### Queries Fail to Execute

1. **Check active connection**
   - Status bar shows: `Exasol: <connection name>`
   - If not, add/select a connection

2. **Verify SQL syntax**
   - Check for typos
   - Ensure proper Exasol SQL syntax

3. **Check permissions**
   - User has SELECT/INSERT/UPDATE/DELETE rights
   - Schema/table exists and is accessible

---

## Uninstalling

### Via Command Line
```bash
code --uninstall-extension exasol.exasol-vscode
```

### Via VS Code UI
1. Open Extensions view
2. Find "Exasol"
3. Click gear icon → "Uninstall"
4. Reload VS Code

---

## Development Setup (For Contributors)

### Clone and Setup
```bash
git clone <repository-url>
cd exasol-vscode
npm install
npm run compile
```

### Run Tests
```bash
# Start local Exasol instance first
# Then run tests
npm test
```

### Debug Tests
1. Open `src/test` folder
2. Set breakpoints
3. Press `F5`
4. Select "Extension Tests" from debug configurations

### Watch Mode
```bash
# Auto-compile on changes
npm run watch
```

### Lint Code
```bash
npm run lint
```

---

## Publishing (For Maintainers)

### Prepare for Publishing

1. **Update version in package.json**
   ```json
   "version": "2.0.0"
   ```

2. **Update CHANGELOG.md**

3. **Build and test**
   ```bash
   npm run compile
   npm test
   ```

### Publish to Marketplace

```bash
# Login to Visual Studio Marketplace
vsce login <publisher-name>

# Publish
vsce publish
```

### Create GitHub Release

```bash
# Create package
vsce package

# Upload to GitHub releases
# Tag: v2.0.0
# Attach: exasol-vscode-2.0.0.vsix
```

---

## Support

- **Issues**: Open an issue on GitHub
- **Questions**: Check the README.md
- **Feature Requests**: Submit via GitHub Issues

## Version History

- **v2.0.0** - Major feature release (current)
  - IntelliSense & Autocomplete
  - Complete object browser
  - Session management
  - Advanced results viewer
  - Secure credentials
  - Query cancellation

- **v1.0.0** - Initial release
  - Basic connection management
  - Query execution
  - Simple object browser
