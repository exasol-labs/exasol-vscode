# Feature: Multi-Result Tabs

Enables users to view results from multiple SQL statements side-by-side in separate tabs within the results panel, rather than only seeing the last result.

## Background

The results panel displays query results in a webview within the Exasol panel. By default, each execution replaces the previous result. When separate tabs mode is active, each statement in a multi-statement execution gets its own tab. A new execution always replaces all existing tabs.

## Scenarios

### Scenario: Default single-tab execution

* *GIVEN* the user has not enabled separate tabs mode
* *AND* the user runs a multi-statement script
* *WHEN* the execution completes
* *THEN* the results panel SHALL display only the last statement's result
* *AND* the behavior SHALL match the current single-result behavior

### Scenario: Execute statements in separate tabs

* *GIVEN* the user has enabled separate tabs mode
* *AND* the user runs a script containing multiple statements
* *WHEN* the execution completes
* *THEN* the results panel SHALL display a tab bar at the top
* *AND* each statement that returns a result set SHALL have its own tab
* *AND* the first tab SHALL be selected by default

### Scenario: Tab labeling

* *GIVEN* separate tabs mode is active
* *WHEN* a multi-statement execution completes
* *THEN* each tab label SHALL display "Result N" where N is the statement's position
* *AND* non-result statements (DDL, DML) SHALL display their affected row count in the tab label

### Scenario: Switch between result tabs

* *GIVEN* the results panel displays multiple tabs
* *WHEN* the user clicks a different tab
* *THEN* the panel SHALL display that tab's result grid
* *AND* the tab SHALL retain its sort, filter, and scroll state

### Scenario: New execution replaces tabs

* *GIVEN* the results panel displays tabs from a previous execution
* *WHEN* the user executes a new query or script
* *THEN* all existing tabs SHALL be removed
* *AND* the new execution's results SHALL replace them

### Scenario: Toggle separate tabs via command

* *GIVEN* the user opens the command palette
* *WHEN* the user invokes "Exasol: Toggle Separate Result Tabs"
* *THEN* the separate tabs mode SHALL toggle on or off
* *AND* the status bar SHALL indicate the current mode

### Scenario: Error result in tab

* *GIVEN* separate tabs mode is active
* *AND* one statement in a multi-statement execution fails
* *WHEN* the execution reaches the failed statement
* *THEN* the failed statement SHALL have its own tab showing the error
* *AND* the user SHALL be prompted whether to continue with remaining statements

### Scenario: Single statement execution with separate tabs

* *GIVEN* separate tabs mode is active
* *AND* the user executes a single statement
* *WHEN* the execution completes
* *THEN* the result SHALL display without a tab bar
* *AND* the behavior SHALL be identical to default single-tab mode

### Scenario: Close individual tab

* *GIVEN* the results panel displays multiple tabs
* *WHEN* the user hovers over a tab and clicks the close button
* *THEN* that tab SHALL be removed from the tab bar
* *AND* the active tab SHALL adjust if the closed tab was before or at the active position
* *AND* closing the last remaining tab SHALL return the panel to the empty state

### Scenario: Export from active tab

* *GIVEN* the results panel displays multiple tabs
* *AND* a tab with results is selected
* *WHEN* the user exports to CSV
* *THEN* the export SHALL contain only the active tab's result data
