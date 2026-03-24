# Changelog

All notable changes to the "Exasol" extension will be documented in this file.

## [1.3.2] - 2026-03-24

### Changed
- Release workflow now automatically publishes to the VS Marketplace

## [1.3.0] - 2026-03-18

### Added
- **Extended object tree** — browse UDF scripts, procedures, adapter scripts, scalar/aggregate functions, virtual schema tables, primary/foreign key constraints, and indices
- **System schemas** — SYS and EXA_STATISTICS system tables browsable under a "System Schemas" folder, with column inspection
- **Find Database Object** command (`Ctrl+Shift+F` / `Cmd+Shift+F`) — QuickPick search across all object types with type icons, schema context, and tree reveal on selection
- Parent tracking on tree nodes enabling `TreeView.reveal()` for navigation
- Enhanced IntelliSense with scripts, functions, virtual tables, and system tables
- 70+ new unit tests for object tree types, parent chains, search, system schemas, scripts/functions, virtual schemas, and constraints/indices

### Changed
- Extracted node type configuration into `objectTreeTypes.ts` for maintainability
- CompletionProvider error logging uses output channel instead of console

## [1.2.0] - 2026-03-16

### Added
- **Separate result tabs** — multi-statement executions can display each result in its own tab within the results panel
- Toggle command "Exasol: Toggle Separate Result Tabs" with status bar indicator
- `exasol.separateResultTabs` setting (default: false) to enable tabbed results
- Tab bar with per-tab sort, filter, and scroll state preservation
- Error results displayed in dedicated tabs with red indicator
- Single-statement executions display without tab bar even when tabs mode is enabled
- Close button on individual tabs (hover to reveal ×)
- CSV export operates on the active tab's data
- Local test harnesses: jsdom-based webview rendering tests and VS Code e2e tests

### Changed
- Extracted shared grid CSS/JS into reusable helpers to eliminate duplication between single and multi-tab renderers
- Extracted tab bar rendering into standalone `tabBarRenderer.ts` for testability
- Tidied README — reduced from 357 to 72 lines

## [1.3.1] - 2026-03-24

### Added
- **Separate background connection** — object tree, autocompletion, and session queries use a dedicated connection so long-running user queries no longer block the sidebar (fixes #27)
- **Disconnect command** — right-click a connection or use the command palette to close all sessions without removing the profile
- **Execute Script command** (`Cmd+Alt+Enter` / `Ctrl+Alt+Enter`) — runs all statements in the current file regardless of cursor position or selection (fixes #26)
- **Application name in sessions** — connections identify as "VSCode Exasol" in `EXA_*_SESSIONS.CLIENT` instead of the generic "Javascript client"
- Idle connection cleanup: background drivers close after 5 minutes of inactivity; old connections close 2 minutes after switching away
- Proper shutdown: `deactivate()` now closes all database sessions on extension exit

### Fixed
- Editor no longer loses focus when query results are displayed (fixes #25)
- Background operations (tree, completion, session) have a 30s timeout so a hanging query can't freeze the extension
- User query cancellation now aborts in-flight driver calls instead of only checking between queries
- Clicking "Continue" after cancelling a batch query now properly resumes execution with a fresh cancellation token

### Security
- Resolved 4 Dependabot alerts (3 high, 1 low) in dev dependencies via dependency updates and overrides

## [1.1.2] - 2026-02-25

### Fixed
- Serialize driver access with a query mutex to prevent E-EDJS-8 pool exhaustion on concurrent calls
- Close stale driver on validation failure instead of leaking WebSocket
- Stale driver close now has a 2s timeout to prevent mutex deadlock when `pool.drain()` hangs on a dead WebSocket
- Retry path no longer destroys a freshly-reconnected driver (race condition fix)
- User-cancelled queries no longer trigger 5s failure cooldown

### Changed
- Skip redundant `SELECT 1` validation when a query succeeded within the last 10s
- Autocompletion loads all column metadata in a single bulk query instead of one per table

## [1.1.1] - 2026-02-23

### Added
- Automatic reconnection with retry: up to 3 attempts with 2s delay and cancellable VS Code progress notification
- Concurrent connection deduplication: tree provider, autocompletion, and query executor share a single reconnection attempt
- WebSocket ping/pong keep-alive (every 30s) to detect dead connections proactively instead of hanging for 30-75s on stale TCP sockets
- 28 unit tests for TLS validation logic (fingerprint normalization, error formatting, error extraction)

### Fixed
- Connection form now allows blank password when editing (keeps existing password)
- Error messages no longer show `[object Object]` for authentication failures
- Error messages no longer show empty text after "Connection failed:" on wrong port
- Error codes (e.g. `ECONNREFUSED`) now surfaced when original error message is empty
- "Full validation" TLS mode now shows meaningful error instead of generic `E-EDJS-1`
- Edit connection button now correctly shows "Test & Update Connection" instead of "Test & Add Connection"
- `executeWithRetry()` no longer double-stacks retries when `connectWithRetry()` already exhausted its attempts
- Repository URL corrected from `exasol/` to `exasol-labs/` in package.json, README, and RELEASE.md
- License corrected from ISC to MIT in README (matching LICENSE file); added `"license": "MIT"` to package.json
- Removed hardcoded version numbers from README to avoid stale references on each release

### Added
- GitHub Actions CI: type check + unit tests on every PR
- GitHub Actions Release: auto-builds VSIX and creates GitHub release on merge to main when version changes

### Changed
- Bundled extension with esbuild: single JS output file, faster activation, smaller VSIX
- Separated `host` and `port` into distinct fields in connection model (old format auto-migrated)
- Connection tree and picker now display `host:port` instead of just `host`
- Added 10-second connection timeout to prevent indefinite hangs on unreachable hosts
- Reduced TLS certificate probe timeout from 10s to 5s
- Fingerprint is now re-validated on every reconnect, not just initial connection
- `executeWithRetry()` delay increased from 100ms to 1s for connection stabilization
- Extracted connection types and utilities into `connectionTypes.ts` for testability

### Dependencies
- `glob` 10 → 13 (drops 33 transitive deps, fixes CVE-2025-64756)
- `mocha` 10 → 11
- `@types/node` 24 → 22 (aligned with VS Code's Node 22 runtime)
- `@types/vscode` 1.105 → 1.109, `engines.vscode` aligned
- `@vscode/vsce` 3.6 → 3.7, `ws` 8.18 → 8.19
- Transitive security fixes: qs, lodash, jws, node-forge

## [1.1.0] - 2026-02-06

### Added
- Per-connection TLS certificate validation with three modes:
  - **Off**: Skip validation (default, preserves existing behavior)
  - **Fingerprint**: SHA-256 certificate pinning with trust-on-first-use (TOFU)
  - **Full validation**: Standard CA certificate verification
- Trust-on-first-use (TOFU) prompt when connecting with Fingerprint mode and no stored fingerprint
- Certificate change detection with old/new fingerprint comparison and accept/reject dialog
- Manual fingerprint entry field in connection form (accepts colon-separated or plain hex)
- TLS mode selector and fingerprint field in Add/Edit Connection form

### Changed
- Replaced hardcoded `rejectUnauthorized: false` with per-connection TLS settings
- Fingerprint validation errors are no longer silently retried by `executeWithRetry`

## [1.0.2] - 2026-01-20

### Fixed
- Statement parsing now correctly handles semicolons inside both single-line (`--`) and multi-line (`/* */`) comments, preventing premature statement termination

## [1.0.1] - 2026-01-09

### Added
- Pre-packaged .vsix extension file for easy installation (exasol-vscode-1.0.1.vsix)
- RELEASE.md with release checklist for maintainers
- Repository URL in package.json for proper vsce packaging

### Changed
- Updated .vscodeignore to exclude test files from package (reduced size to ~1.0 MB, 170 files)
- Enhanced README.md with streamlined installation section (packaged extension method first)
- Improved publishing documentation with GitHub release workflow

## [1.0.0] - 2026-01-06

### Added
- AI agent instructions in `.github/copilot-instructions.md` for GitHub Copilot and other AI coding assistants
  - Critical connection error handling patterns
  - Centralized retry logic (`executeWithRetry`)
  - Security conventions (VS Code Secrets API)
  - Multi-query execution workflow
  - VSIX packaging requirements

### Changed
- Consolidated documentation into single `README.md`
  - Merged START-HERE.md, INSTALLATION.md, QUICKSTART.md into README.md
  - Quick Start section at top for immediate results
  - Complete feature documentation, installation methods, troubleshooting
  - Development and publishing workflows
- Removed user-specific paths from documentation (e.g., `/Users/mikhail.zhadanov` → `exasol-vscode`)

### Removed
- CLAUDE.md (replaced by `.github/copilot-instructions.md`)
- TEST-COVERAGE.md (covered in `src/test/README.md`)
- reinstall.sh (outdated installation script)
- START-HERE.md (merged into README.md)
- INSTALLATION.md (merged into README.md)
- QUICKSTART.md (merged into README.md)

## [0.1.2] - 2025-11-05

### Added
- Context menu in Query Results with 4 copy options: Copy, Copy with Headers, Copy as CSV, Copy as CSV with Headers
- Object counts displayed in Database Objects explorer
  - Schema level: Shows table and view counts (e.g., "5 tables, 3 views")
  - Folder level: Shows counts on Tables and Views folders
  - Empty schemas marked as "empty"
- Column type metadata extraction from query results (type, precision, scale, size)

### Changed
- Cell type inspector now shows actual column type from database metadata instead of inferred types
  - Displays proper types like `VARCHAR(100)`, `DECIMAL(18,2)`, `INTEGER`
  - Shows precision, scale, and size information where available
- Autocomplete filtering improved to show only relevant columns after table aliases
  - When typing after alias (e.g., `u.`), shows only columns from that table
  - Removed keyword/function clutter from alias-specific completions
  - Context-aware suggestions for schema.table patterns

### Fixed
- Cmd+C keyboard shortcut for copying selected cells now works consistently
  - Added proper event propagation handling
  - Automatic focus management when selecting cells
  - Works alongside context menu copy options
- Cmd+A keyboard shortcut for selecting all cells in results table
  - Table container made focusable for keyboard event capture
  - Proper event handling with preventDefault and stopPropagation
- Connection pool exhaustion error (E-EDJS-8) with automatic retry
  - Detects pool limit errors and resets driver connection
  - Automatic single retry for failed queries
  - Applied to both execute() and executeAndFetch() methods

### Technical
- Enhanced QueryResult interface with columnMetadata field
- Added ColumnMetadata interface for type information storage
- Updated QueryExecutor to extract and populate column metadata
- Improved ObjectTreeProvider with optimized schema query using JOINs
- Enhanced CompletionProvider with priority-based context detection

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
