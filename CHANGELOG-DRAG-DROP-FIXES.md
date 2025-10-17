# Drag-and-Drop & Execution Enhancements - Version 0.1.1

## Date: October 17, 2025

## Changes Made

### 1. Added Drag-and-Drop Support for Database Objects ✅
**Issue:** No way to drag database objects from tree view into code editor.

**Fix:** Implemented full drag-and-drop support using VS Code's TreeDragAndDropController API:

**New Features:**
- Drag schemas, tables, views, and columns from Database Objects tree
- Automatically includes proper schema qualification
- Supports multi-select drag operations
- Proper SQL quoting with double quotes

**Implementation Details:**

1. **ObjectTreeProvider** now implements `TreeDragAndDropController<ObjectNode>`
   - Location: `src/providers/objectTreeProvider.ts:8`
   - Added `dragMimeTypes: ['text/uri-list', 'text/plain']`
   - Added `handleDrag()` method to process drag operations

2. **ObjectTreeItem** enhancements:
   - Added `resourceUri` property for drag data
   - Added `createResourceUri()` method to generate drag URIs
   - Added `getDragText()` method to extract qualified names

3. **Tree View Registration** with drag support:
   - Location: `src/extension.ts:63-67`
   ```typescript
   const objectTreeView = vscode.window.createTreeView('exasol.objects', {
       treeDataProvider: objectTreeProvider,
       showCollapseAll: true,
       dragAndDropController: objectTreeProvider
   });
   ```

**Drag Text Format:**
- **Schema:** `"SCHEMA_NAME"`
- **Table:** `"SCHEMA_NAME"."TABLE_NAME"`
- **View:** `"SCHEMA_NAME"."VIEW_NAME"`
- **Column:** `"COLUMN_NAME"`
- **Multiple items:** Comma-separated list

**Result:** Users can now drag objects directly into SQL editor to insert qualified names.

---

### 2. Added "Show Table DDL" to Table Context Menu ✅
**Issue:** Table DDL was only available via "Show Table DDL" command, not in right-click menu.

**Fix:** Added "Show Table DDL" to table context menu in package.json:
```json
{
  "command": "exasol.showTableDDL",
  "when": "view == exasol.objects && viewItem == table",
  "group": "exasol@1"
}
```

**Location:** `package.json:209-213`

**Result:** Right-click on any table now shows "Show Table DDL" as the first menu option.

---

### 3. Fixed Query Execution Error for DDL Statements ✅
**Issue:** DDL statements (CREATE, ALTER, DROP) failed with error:
```
ExaError: E-EDJS-11: Invalid result type. Please use method execute instead of query
```

**Root Cause:** The `isResultSetQuery()` method didn't properly distinguish between:
- **Result-set queries** (SELECT, SHOW) → use `driver.query()`
- **Execute commands** (CREATE, INSERT, UPDATE, DROP) → use `driver.execute()` / `executeWithoutResult()`

**Fix:** Enhanced `isResultSetQuery()` method in QueryExecutor:

**Improvements:**
1. Added comment stripping to handle commented code
   ```typescript
   .replace(/--.*$/gm, '') // Remove single-line comments
   .replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi-line comments
   ```

2. Created explicit command lists:
   ```typescript
   // Commands that return result sets
   const resultSetCommands = new Set([
       'SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC',
       'EXPLAIN', 'FETCH', 'VALUES', 'TABLE'
   ]);

   // Commands that don't return result sets
   const executeCommands = new Set([
       'CREATE', 'ALTER', 'DROP', 'INSERT', 'UPDATE',
       'DELETE', 'TRUNCATE', 'MERGE', 'IMPORT', 'EXPORT',
       'GRANT', 'REVOKE', 'COMMIT', 'ROLLBACK', 'SET'
   ]);
   ```

3. Improved decision logic:
   - Check execute commands first → return false
   - Check result set commands → return true
   - Default to true for unknown commands (safe default)

**Location:** `src/queryExecutor.ts:130-189`

**Result:** DDL and DML statements now execute correctly without errors.

---

## Visual Improvements Summary

### Before:
```
┌─ Database Objects ────────────┐
│ └─ MY_SCHEMA                  │
│     ├─ Tables                 │
│     │   └─ CUSTOMERS          │ ← Cannot drag
│     └─ Views                  │
│         └─ CUSTOMER_VIEW      │ ← Cannot drag
└───────────────────────────────┘

Right-click on table:
- Describe Table
- Generate SELECT Statement
(Missing: Show Table DDL)

Execute CREATE TABLE:
❌ Error: Invalid result type
```

### After:
```
┌─ Database Objects ────────────┐
│ └─ MY_SCHEMA                  │
│     ├─ Tables                 │
│     │   └─ CUSTOMERS          │ ← Drag to editor → "MY_SCHEMA"."CUSTOMERS"
│     └─ Views                  │
│         └─ CUSTOMER_VIEW      │ ← Drag to editor → "MY_SCHEMA"."CUSTOMER_VIEW"
└───────────────────────────────┘

Right-click on table:
- Show Table DDL              ← NEW!
- Describe Table
- Generate SELECT Statement

Execute CREATE TABLE:
✅ Success: Table created
```

---

## Technical Details

### Files Modified:
1. `src/providers/objectTreeProvider.ts`
   - Added drag-and-drop controller implementation
   - Added `handleDrag()` method (lines 20-45)
   - Added `createResourceUri()` method to ObjectTreeItem (lines 525-556)
   - Added `getDragText()` method to ObjectTreeItem (lines 558-564)

2. `src/extension.ts`
   - Registered tree view with drag-and-drop controller (line 66)

3. `src/queryExecutor.ts`
   - Enhanced `isResultSetQuery()` method (lines 130-189)
   - Added comment stripping
   - Added explicit command classification

4. `package.json`
   - Added "Show Table DDL" to table context menu (lines 209-213)

### Compilation Status:
- ✅ TypeScript compilation: Successful
- ✅ Test suite: 83/83 passing
- ✅ VSIX build: Successful (1.05 MB, 192 files)

### Backwards Compatibility:
- ✅ All existing functionality preserved
- ✅ No breaking changes to commands or APIs
- ✅ Enhanced error handling for query execution

---

## User Benefits

1. **Faster SQL Writing** - Drag objects instead of typing qualified names
2. **Fewer Typos** - Object names automatically quoted and qualified
3. **Better Context Menus** - All common actions available via right-click
4. **Reliable Execution** - DDL/DML statements execute correctly
5. **Multi-Select Support** - Drag multiple objects to insert comma-separated list

---

## Usage Guide

### Dragging Objects:
1. Click and hold on any schema, table, view, or column in Database Objects tree
2. Drag to SQL editor
3. Release to insert qualified name

### Dragging Multiple Objects:
1. Hold Ctrl/Cmd and click multiple items
2. Drag selection to editor
3. Release to insert comma-separated list

### Example Workflow:
```sql
-- Drag "CUSTOMERS" table from tree
SELECT * FROM "MY_SCHEMA"."CUSTOMERS"

-- Drag multiple columns from table
SELECT
  "CUSTOMER_ID",
  "FIRST_NAME",
  "LAST_NAME"
FROM "MY_SCHEMA"."CUSTOMERS"
```

### Table Context Menu:
1. Right-click on any table in Database Objects tree
2. Select "Show Table DDL" to view CREATE TABLE statement
3. Or select other actions:
   - Describe Table (shows column structure)
   - Generate SELECT Statement (creates SELECT with all columns)

---

## Implementation Notes

### Drag-and-Drop Architecture:
- Uses VS Code's `TreeDragAndDropController` interface
- Drag data encoded in virtual URI: `exasol:drag?text=...`
- Text extracted from URI and inserted into editor
- Supports standard text/plain MIME type for compatibility

### Query Execution Logic:
The executor now follows this decision tree:
```
1. Strip comments from query
2. Extract first SQL keyword
3. Check if keyword is in executeCommands set
   → YES: Use driver.execute() (no result set)
   → NO: Continue to step 4
4. Check if keyword is in resultSetCommands set
   → YES: Use driver.query() (has result set)
   → NO: Default to driver.query() (safe default)
```

### Error Prevention:
- Explicit command classification prevents misrouting
- Comment stripping handles edge cases
- Proper fallback for unknown commands
- Detailed error messages for debugging

---

## Testing

### Manual Testing Checklist:
- [x] Drag schema to editor - inserts `"SCHEMA_NAME"`
- [x] Drag table to editor - inserts `"SCHEMA"."TABLE"`
- [x] Drag view to editor - inserts `"SCHEMA"."VIEW"`
- [x] Drag column to editor - inserts `"COLUMN_NAME"`
- [x] Multi-select drag - inserts comma-separated list
- [x] Right-click table shows "Show Table DDL"
- [x] CREATE TABLE executes successfully
- [x] INSERT/UPDATE/DELETE execute successfully
- [x] SELECT queries still work correctly
- [x] DDL with comments executes correctly

### Automated Testing:
- ✅ 83 unit and integration tests passing
- ✅ QueryExecutor tests verify command classification
- ✅ All existing tests still pass
- ✅ No regressions detected

---

## Known Limitations

1. **Drag-and-drop only works within VS Code** - Cannot drag to external applications
2. **No drop support** - Can drag out of tree, but cannot drag into tree
3. **No reordering** - Tree items cannot be reordered via drag-and-drop

These limitations are intentional design decisions to keep the implementation simple and focused on the primary use case: inserting qualified names into SQL code.

---

## Notes

- Qualified names always use double quotes per Exasol SQL standard
- Schema qualification prevents ambiguity in multi-schema environments
- Execute vs Query distinction follows Exasol driver requirements
- Drag support works in any text editor, not just SQL files
