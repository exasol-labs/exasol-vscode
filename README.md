# Exasol Extension for Visual Studio Code

A feature-rich Visual Studio Code extension for working with Exasol databases, inspired by the Snowflake extension. Provides comprehensive database management, intelligent SQL editing, and powerful query execution capabilities.

## Features

### 🔐 Connection Management
- Add and manage multiple Exasol database connections
- **Secure credential storage** using VS Code's Secret Storage API
- Switch between connections easily
- Test connections before saving
- View active connection and schema in status bar

### 🚀 SQL Query Execution
- Execute SQL queries with `Ctrl+Enter` (or `Cmd+Enter` on Mac)
- Execute selected queries with `Ctrl+Shift+Enter`
- **Cancellable query execution** - stop long-running queries
- View query results in a dedicated panel
- Export results to **CSV and JSON formats**
- Query execution timeout and result row limits
- Automatic LIMIT clause addition for SELECT queries

### 🎯 IntelliSense & Autocomplete
- **Context-aware SQL completions** for keywords, functions, tables, views, and columns
- Smart suggestions based on current schema
- Function signatures with snippets
- Cached completions for better performance (5-minute TTL)
- Supports schema-qualified object names (e.g., `SCHEMA.TABLE.COLUMN`)

### 🗂️ Advanced Object Explorer
- **Complete hierarchical browser**: Connection → Schema → Tables/Views → Columns
- View table row counts directly in the tree
- Column types and nullable status displayed
- Filter system schemas for cleaner view
- Expandable structure with lazy loading

### 🔍 Object Actions (Right-Click Context Menu)
- **Preview Table Data** - View first 100 rows instantly
- **Show DDL** - Generate CREATE TABLE/VIEW statements
- **Generate SELECT Statement** - Auto-generate queries with all columns
- **Describe Table** - View detailed column information
- **Set Active Schema** - Change your session schema context

### 📊 Advanced Results Viewer
- Interactive table with **real-time filtering**
- **Sortable columns** - click headers to sort ascending/descending
- Column tooltips for long values
- Visible/total row counter
- Export to CSV or JSON with proper formatting
- Responsive design with theme integration
- Performance metrics (execution time, row count)

### 🎭 Session Management
- Set and track active schema per connection
- Persistent session state across VS Code restarts
- Status bar integration showing active connection and schema
- Quick schema switching via context menu

### 📜 Query History
- Automatic tracking of all executed queries
- Configurable history size (default: 1000 queries)
- View execution time, row counts, and errors
- Query previews with full text tooltips
- Success/error indicators

### 📝 SQL Language Support
- Syntax highlighting for Exasol SQL
- 140+ SQL keywords recognized
- 180+ built-in functions with snippets
- Comment support (line and block)
- Code folding with region markers
- Support for `.sql`, `.exasql`, and `.exs` file extensions

## Getting Started

### Prerequisites
- Visual Studio Code v1.85.0 or higher
- Access to an Exasol database

### Installation
1. Install the extension from the VS Code marketplace
2. Reload VS Code

### Add Your First Connection
1. Click the Exasol icon in the Activity Bar
2. Click the "+" button to add a new connection
3. Enter your connection details:
   - Connection Name
   - Host (e.g., localhost:8563)
   - Username
   - Password
4. The connection will be tested and saved

### Execute Your First Query
1. Open a new file or create a `.sql` or `.exasql` file
2. Write your SQL query
3. Press `Ctrl+Enter` (or `Cmd+Enter` on Mac) to execute
4. View results in the Results panel

## Commands

### General Commands
- `Exasol: Add Connection` - Add a new database connection
- `Exasol: Refresh Connections` - Refresh the connections tree
- `Exasol: Execute Query` - Execute the entire current file (cancellable)
- `Exasol: Execute Selected Query` - Execute the selected text (cancellable)
- `Exasol: Show Query History` - Show query execution history
- `Exasol: Export Results to CSV` - Export current results to CSV
- `Exasol: Clear Autocomplete Cache` - Clear the IntelliSense cache

### Context Menu Commands (Right-Click on Objects)
- `Preview Table Data` - Show first 100 rows from table/view
- `Describe Table` - View column definitions and types
- `Show Table DDL` - Generate CREATE TABLE statement
- `Show View DDL` - Generate CREATE VIEW statement
- `Generate SELECT Statement` - Create SELECT with all columns
- `Set as Active Schema` - Make schema active for current session

## Keyboard Shortcuts

- `Ctrl+Enter` / `Cmd+Enter` - Execute current query
- `Ctrl+Shift+Enter` / `Cmd+Shift+Enter` - Execute selected query

## Configuration

The extension can be configured through VS Code settings:

```json
{
  "exasol.maxQueryHistorySize": 1000,
  "exasol.queryTimeout": 300,
  "exasol.maxResultRows": 10000,
  "exasol.autoComplete": true
}
```

### Settings

- `exasol.maxQueryHistorySize` - Maximum number of queries to keep in history (default: 1000)
- `exasol.queryTimeout` - Query execution timeout in seconds (default: 300)
- `exasol.maxResultRows` - Maximum number of rows to fetch from query results (default: 10000)
- `exasol.autoComplete` - Enable SQL auto-completion (default: true)

## What's New in v2.0

### Major Features Added
✅ **IntelliSense & Autocomplete** - Context-aware completions for tables, columns, and functions
✅ **Complete Object Browser** - Full hierarchy with tables, views, and columns
✅ **Session Management** - Set active schema per connection
✅ **Advanced Results** - Sorting, filtering, and multiple export formats
✅ **Object Actions** - Preview data, view DDL, generate queries
✅ **Secure Credentials** - Passwords stored in VS Code Secret Storage
✅ **Query Cancellation** - Stop long-running queries
✅ **Enhanced UI** - Status bar integration, better icons, row counts

### Comparison with Snowflake Extension

This extension now matches the Snowflake extension's capabilities:

| Feature | Exasol Extension | Snowflake Extension |
|---------|-----------------|---------------------|
| Connection Management | ✅ | ✅ |
| IntelliSense/Autocomplete | ✅ | ✅ |
| Object Browser (Full Hierarchy) | ✅ | ✅ |
| Session Management | ✅ | ✅ |
| Query Execution (Cancellable) | ✅ | ✅ |
| Results Filtering & Sorting | ✅ | ✅ |
| Multiple Export Formats | ✅ (CSV, JSON) | ✅ (CSV, compressed) |
| Table Data Preview | ✅ | ✅ |
| DDL Viewing | ✅ | ✅ |
| Secure Credential Storage | ✅ | ✅ |
| Query History | ✅ | ✅ |

## Known Issues

- Very large result sets (>10,000 rows) may impact browser rendering performance
- Query cancellation relies on driver support; some queries may not be immediately cancellable

## Release Notes

### 2.0.0

Major feature release bringing the extension to parity with Snowflake:
- **NEW:** IntelliSense with context-aware autocomplete for tables, views, columns, keywords, and functions
- **NEW:** Complete object browser showing full table/view/column hierarchy with metadata
- **NEW:** Session management with active schema tracking
- **NEW:** Advanced results viewer with sorting, filtering, and JSON export
- **NEW:** Object context menu actions (preview, DDL, describe, generate SELECT)
- **NEW:** Secure credential storage using VS Code's Secret Storage API
- **NEW:** Cancellable query execution
- **NEW:** Status bar integration showing active connection and schema
- **IMPROVED:** Enhanced tree view with table row counts and column types
- **IMPROVED:** Better error handling and user feedback
- **FIXED:** Various performance improvements and bug fixes

### 1.0.0

Initial release with the following features:
- Connection management
- SQL query execution
- Basic object explorer (schemas only)
- Query history
- SQL syntax highlighting
- Results viewer with CSV export

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## License

ISC

## Support

For issues, questions, or feature requests, please open an issue on the GitHub repository.
