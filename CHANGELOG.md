# Changelog

All notable changes to the "Exasol" extension will be documented in this file.

## [0.1.1] - 2025-10-17

### Added
- Query Stats panel showing real-time query execution statistics (execution time, rows, columns, throughput, avg/row)
- Column sorting in Query Results (click headers to sort ascending/descending)
- Copy Name button for database objects (schemas, tables, views) with inline copy icon
- CodeLens "▶ Execute" buttons before each SQL statement in Exasol SQL files
- Exasol icon in language picker and file tabs for Exasol SQL files
- Query execution errors now displayed in Query Results panel
- Enhanced test coverage (83 comprehensive tests)

### Changed
- Query execution restricted to Exasol SQL language mode only
- Table describe results now show in Query Results panel instead of separate panel
- Generated SELECT statements now open with Exasol SQL language mode
- Query History panel height reduced for more Database Objects space (initialSize: 3)
- Query Stats panel width constrained to 200px for compact display
- Removed success/error notification popups (errors show in Results panel)
- Improved drag-and-drop with direct text insertion (no Shift required for single items)
- Semicolons automatically stripped from query execution to prevent errors

### Fixed
- TABLE_TYPE metadata error with comprehensive fallback query strategy
- Query execution failures for queries with/without trailing semicolons
- Drag-and-drop showing URI strings instead of qualified names
- CodeLens execute buttons work correctly with query range detection
- Column missing errors handled gracefully with 4-tier fallback approach

### Technical
- Enhanced ObjectTreeProvider with metadata fallback for Exasol version compatibility
- Improved QueryExecutor with better DDL/DML detection and error handling
- Added QueryStatsPanel and removed deprecated DescribePanel
- Tree view drag-and-drop uses DataTransfer API for plain text

## [0.1.0] - 2025-10-16

### Added
- Initial release
- Exasol database connection management with secure password storage
- Object browser for schemas, tables, views, and columns
- Query execution with Cmd/Ctrl+Enter
- Query results viewer with filtering and export to CSV
- Query history tracking
- SQL auto-completion for keywords, functions, tables, and columns
- IntelliSense support
- Session management with active schema selection
- Connection status in status bar

### Features
- Add/Edit/Delete/Rename connections
- Preview table data
- Show table/view DDL
- Generate SELECT statements
- Describe table structure
- Set active schema
- Clear autocomplete cache

---

For more details, see individual changelog files:
- CHANGELOG-UI-FIXES.md
- CHANGELOG-LANGUAGE-FIXES.md
- CHANGELOG-DRAG-DROP-FIXES.md
- CHANGELOG-FINAL-FIXES.md
- CHANGELOG-QUERY-STATS.md
