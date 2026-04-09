import * as vscode from 'vscode';
import { performance } from 'perf_hooks';
import { ConnectionManager, StoredConnection } from './connectionManager';
import { ConnectionTreeProvider } from './providers/connectionTreeProvider';
import { ObjectTreeProvider } from './providers/objectTreeProvider';
import { QueryHistoryProvider } from './providers/queryHistoryProvider';
import { ExasolCompletionProvider } from './providers/completionProvider';
import { ExasolCodeLensProvider } from './providers/codeLensProvider';
import { FormattingProvider } from './providers/formattingProvider';
import { QueryExecutor } from './queryExecutor';
import { ResultsPanel } from './panels/resultsPanel';
import { QueryStatsPanel } from './panels/queryStatsPanel';
import { TabResultCollector } from './execution/tabResultCollector';
import { ConnectionPanel } from './panels/connectionPanel';
import { SessionManager } from './sessionManager';
import { ObjectActions } from './objectActions';
import { ObjectSearchProvider } from './providers/objectSearchProvider';
import { findStatementAtCursor, formatDuration, splitIntoStatements } from './utils';
import { ExasolNotebookSerializer } from './notebooks/serializer';
import { ExasolNotebookController } from './notebooks/controller';
import { formatError } from './connectionTypes';

// Create output channel for logging
let outputChannel: vscode.OutputChannel;
let extensionContext: vscode.ExtensionContext | undefined;
let extensionConnectionManager: ConnectionManager | undefined;

function showTimedNotification(message: string, timeoutMs: number = 2000): void {
    vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, cancellable: false },
        (progress) => {
            progress.report({ message });
            return new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
        }
    );
}

export function activate(context: vscode.ExtensionContext) {
    extensionContext = context;

    // Create output channel
    outputChannel = vscode.window.createOutputChannel('Exasol');
    outputChannel.appendLine('🚀 Exasol extension activated');
    console.log('Exasol extension is now active');

    // Initialize managers
    const extensionVersion = context.extension.packageJSON.version ?? '0.0.0';
    const connectionManager = new ConnectionManager(context, extensionVersion);
    extensionConnectionManager = connectionManager;
    const queryExecutor = new QueryExecutor(connectionManager);
    const sessionManager = new SessionManager(connectionManager, context);
    const objectActions = new ObjectActions(connectionManager, queryExecutor, context.extensionUri);

    // Initialize tree providers
    const connectionTreeProvider = new ConnectionTreeProvider(connectionManager);
    const objectTreeProvider = new ObjectTreeProvider(connectionManager);
    const queryHistoryProvider = new QueryHistoryProvider(context);

    // Register panel views
    ResultsPanel.register(context);
    QueryStatsPanel.register(context);

    // Register notebook support
    const notebookSerializer = vscode.workspace.registerNotebookSerializer(
        'exasol-sql-notebook',
        new ExasolNotebookSerializer(),
        { transientOutputs: true }
    );
    const notebookController = new ExasolNotebookController(connectionManager, queryExecutor);

    // Register completion provider
    const completionProvider = new ExasolCompletionProvider(connectionManager);
    const completionDisposable = vscode.languages.registerCompletionItemProvider(
        ['sql', 'exasol-sql'],
        completionProvider,
        '.', '"'
    );

    // Register CodeLens provider
    const codeLensProvider = new ExasolCodeLensProvider();
    const codeLensDisposable = vscode.languages.registerCodeLensProvider(
        { language: 'exasol-sql' },
        codeLensProvider
    );

    // Register formatting provider
    const formattingProvider = new FormattingProvider();
    const formattingDisposable = vscode.languages.registerDocumentFormattingEditProvider(
        'exasol-sql',
        formattingProvider
    );
    const rangeFormattingDisposable = vscode.languages.registerDocumentRangeFormattingEditProvider(
        'exasol-sql',
        formattingProvider
    );

    // Register formatQuery command
    const formatQueryCmd = vscode.commands.registerCommand('exasol.formatQuery', () => {
        return vscode.commands.executeCommand('editor.action.formatDocument');
    });

    // Register tree views
    const connectionTreeView = vscode.window.createTreeView('exasol.connections', {
        treeDataProvider: connectionTreeProvider,
        showCollapseAll: true
    });

    const objectTreeView = vscode.window.createTreeView('exasol.objects', {
        treeDataProvider: objectTreeProvider,
        showCollapseAll: true,
        dragAndDropController: objectTreeProvider,
        canSelectMany: true
    });

    const queryHistoryTreeView = vscode.window.createTreeView('exasol.queryHistory', {
        treeDataProvider: queryHistoryProvider,
        showCollapseAll: true
    });

    // Initialize object search provider
    const objectSearchProvider = new ObjectSearchProvider(connectionManager, objectTreeProvider, objectTreeView);
    const findObjectCmd = vscode.commands.registerCommand('exasol.findObject', () => {
        objectSearchProvider.showSearch();
    });

    // Create status bar item for result tabs mode
    const resultTabsStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    resultTabsStatusBar.command = 'exasol.toggleSeparateResultTabs';

    function updateResultTabsStatusBar() {
        const enabled = vscode.workspace.getConfiguration('exasol').get<boolean>('separateResultTabs', false);
        resultTabsStatusBar.text = enabled ? '$(split-horizontal) Tabs' : '$(split-horizontal) Single';
        resultTabsStatusBar.tooltip = enabled
            ? 'Result tabs: Separate (click to toggle)'
            : 'Result tabs: Single (click to toggle)';
    }
    updateResultTabsStatusBar();
    resultTabsStatusBar.show();

    const toggleSeparateResultTabsCmd = vscode.commands.registerCommand('exasol.toggleSeparateResultTabs', async () => {
        const config = vscode.workspace.getConfiguration('exasol');
        const current = config.get<boolean>('separateResultTabs', false);
        await config.update('separateResultTabs', !current, vscode.ConfigurationTarget.Global);
    });

    const resultTabsConfigListener = vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('exasol.separateResultTabs')) {
            updateResultTabsStatusBar();
        }
    });

    // Create status bar item for session info
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.text = sessionManager.getStatusBarText();
    statusBarItem.command = 'exasol.selectConnection';
    statusBarItem.tooltip = 'Click to select active connection';
    statusBarItem.show();

    // Update status bar when session changes
    sessionManager.onDidChangeSession(() => {
        statusBarItem.text = sessionManager.getStatusBarText();
    });

    // Update status bar when active connection changes
    connectionManager.onDidChangeActiveConnection(() => {
        statusBarItem.text = sessionManager.getStatusBarText();
    });

    // Set initial context for active connection
    vscode.commands.executeCommand('setContext', 'exasol.hasActiveConnection', !!connectionManager.getActiveConnection());

    // Register commands
    const addConnectionCmd = vscode.commands.registerCommand('exasol.addConnection', async () => {
        await addConnection(connectionManager, connectionTreeProvider, objectTreeProvider, context);
    });

    const refreshConnectionsCmd = vscode.commands.registerCommand('exasol.refreshConnections', () => {
        connectionTreeProvider.refresh();
        objectTreeProvider.refresh();
    });

    const executeQueryCmd = vscode.commands.registerCommand('exasol.executeQuery', async () => {
        await executeQuery(queryExecutor, queryHistoryProvider, context, false, connectionManager);
    });

    const executeSelectedQueryCmd = vscode.commands.registerCommand('exasol.executeSelectedQuery', async () => {
        await executeQuery(queryExecutor, queryHistoryProvider, context, true, connectionManager);
    });

    const executeScriptCmd = vscode.commands.registerCommand('exasol.executeScript', async () => {
        await executeQuery(queryExecutor, queryHistoryProvider, context, false, connectionManager, true);
    });

    const executeStatementCmd = vscode.commands.registerCommand('exasol.executeStatement', async (document: vscode.TextDocument, range: vscode.Range) => {
        await executeStatement(queryExecutor, queryHistoryProvider, connectionManager, document, range);
    });

    const showQueryHistoryCmd = vscode.commands.registerCommand('exasol.showQueryHistory', () => {
        queryHistoryProvider.refresh();
    });

    const exportResultsCmd = vscode.commands.registerCommand('exasol.exportResults', async () => {
        await ResultsPanel.exportCurrentToCSV();
    });

    const renameConnectionCmd = vscode.commands.registerCommand('exasol.renameConnection', async (item: any) => {
        if (item && item.connection) {
            await renameConnection(connectionManager, connectionTreeProvider, objectTreeProvider, item.connection);
        }
    });

    const openQueryFromHistoryCmd = vscode.commands.registerCommand('exasol.openQueryFromHistory', async (query: string) => {
        const document = await vscode.workspace.openTextDocument({
            content: query,
            language: 'exasol-sql'
        });
        await vscode.window.showTextDocument(document);
    });

    // New commands for object actions
    const previewTableCmd = vscode.commands.registerCommand('exasol.previewTable', async (item: any) => {
        if (item && item.connection && item.schemaName && item.tableInfo) {
            await objectActions.previewTableData(item.connection, item.schemaName, item.tableInfo.name, 100);
        }
    });

    const showTableDDLCmd = vscode.commands.registerCommand('exasol.showTableDDL', async (item: any) => {
        if (item && item.connection && item.schemaName && item.tableInfo) {
            await objectActions.showTableDDL(item.connection, item.schemaName, item.tableInfo.name);
        }
    });

    const showViewDDLCmd = vscode.commands.registerCommand('exasol.showViewDDL', async (item: any) => {
        if (item && item.connection && item.schemaName && item.tableInfo) {
            await objectActions.showViewDDL(item.connection, item.schemaName, item.tableInfo.name);
        }
    });

    const generateSelectCmd = vscode.commands.registerCommand('exasol.generateSelect', async (item: any) => {
        if (item && item.connection && item.schemaName && item.tableInfo) {
            await objectActions.generateSelectStatement(item.connection, item.schemaName, item.tableInfo.name, item.type);
        }
    });

    const describeTableCmd = vscode.commands.registerCommand('exasol.describeTable', async (item: any) => {
        if (item && item.connection && item.schemaName && item.tableInfo) {
            await objectActions.describeTable(item.connection, item.schemaName, item.tableInfo.name);
        }
    });

    // Prevent rapid duplicate executions (e.g., double-click)
    const openObjectExecuting = new Map<string, boolean>();

    const openObjectCmd = vscode.commands.registerCommand('exasol.openObject', async (item: any) => {
        if (item && item.connection && item.schemaName && item.tableInfo) {
            const key = `${item.connection.id}:${item.schemaName}:${item.tableInfo.name}`;

            // If already executing for this object, skip
            if (openObjectExecuting.get(key)) {
                return;
            }

            try {
                openObjectExecuting.set(key, true);
                if (item.type === 'system-table') {
                    await objectActions.previewTableData(item.connection, item.schemaName, item.tableInfo.name);
                } else {
                    await objectActions.describeTable(item.connection, item.schemaName, item.tableInfo.name);
                }
            } finally {
                // Clear after a short delay to allow UI to settle
                setTimeout(() => openObjectExecuting.delete(key), 500);
            }
        }
    });

    const setSchemaCmd = vscode.commands.registerCommand('exasol.setSchema', async (item: any) => {
        if (item && item.schemaName) {
            await sessionManager.setSchema(item.schemaName);
        }
    });

    const clearCacheCmd = vscode.commands.registerCommand('exasol.clearCache', () => {
        completionProvider.clearCache();
        vscode.window.showInformationMessage('Autocomplete cache cleared');
    });

    const editConnectionCmd = vscode.commands.registerCommand('exasol.editConnection', async (item: any) => {
        if (item && item.connection) {
            await editConnection(connectionManager, connectionTreeProvider, objectTreeProvider, context, item.connection);
        }
    });

    const deleteConnectionCmd = vscode.commands.registerCommand('exasol.deleteConnection', async (item: any) => {
        if (item && item.connection) {
            await deleteConnection(connectionManager, connectionTreeProvider, objectTreeProvider, item.connection);
        }
    });

    const setActiveConnectionCmd = vscode.commands.registerCommand('exasol.setActiveConnection', async (item: any) => {
        const connection: StoredConnection | undefined = item?.connection ?? (
            typeof item?.id === 'string' ? connectionManager.getConnection(item.id) : undefined
        );

        if (!connection) {
            vscode.window.showWarningMessage('Unable to determine connection to activate.');
            return;
        }

        const currentActive = connectionManager.getActiveConnection();
        if (currentActive?.id === connection.id) {
            vscode.window.setStatusBarMessage(`Exasol: '${connection.name}' is already active`, 2000);
            return;
        }

        const output = getOutputChannel();

        try {
            await connectionManager.setActiveConnection(connection.id);
            connectionTreeProvider.refresh();
            objectTreeProvider.refresh();
            output.appendLine(`✅ Active connection set to '${connection.name}'`);
            vscode.window.setStatusBarMessage(`Exasol: Active connection '${connection.name}'`, 3000);
        } catch (error) {
            const message = `Failed to set active connection: ${error}`;
            output.appendLine(`❌ ${message}`);
            vscode.window.showErrorMessage(message);
        }
    });

    const disconnectConnectionCmd = vscode.commands.registerCommand('exasol.disconnectConnection', async (item: any) => {
        const connection: StoredConnection | undefined = item?.connection;
        const output = getOutputChannel();
        let name: string;

        if (connection) {
            name = connection.name;
            await connectionManager.disconnectConnection(connection.id);
        } else {
            const active = connectionManager.getActiveConnection();
            if (!active) {
                vscode.window.showWarningMessage('No active connection to disconnect.');
                return;
            }
            name = active.name;
            await connectionManager.disconnectConnection(active.id);
        }

        // Clear session state and refresh UI
        await sessionManager.clearSession();
        connectionTreeProvider.refresh();
        objectTreeProvider.refresh();
        output.appendLine(`Disconnected from '${name}'`);
        vscode.window.setStatusBarMessage(`Exasol: Disconnected from '${name}'`, 3000);
    });

    const copyQualifiedNameCmd = vscode.commands.registerCommand('exasol.copyQualifiedName', async (item: any) => {
        let qualifiedName: string | undefined;

        if (item?.type === 'schema' && item?.schemaName) {
            qualifiedName = `"${item.schemaName}"`;
        } else if ((item?.type === 'table' || item?.type === 'view') && item?.schemaName && item?.tableInfo) {
            qualifiedName = `"${item.schemaName}"."${item.tableInfo.name}"`;
        } else if (item?.type === 'column' && item?.columnInfo) {
            qualifiedName = `"${item.columnInfo.name}"`;
        }

        if (qualifiedName) {
            await vscode.env.clipboard.writeText(qualifiedName);
            vscode.window.setStatusBarMessage(`Copied: ${qualifiedName}`, 2000);
        }
    });

    const selectConnectionCmd = vscode.commands.registerCommand('exasol.selectConnection', async () => {
        const connections = connectionManager.getConnections();

        if (connections.length === 0) {
            const answer = await vscode.window.showInformationMessage(
                'No connections available. Would you like to add one?',
                'Add Connection',
                'Cancel'
            );
            if (answer === 'Add Connection') {
                await vscode.commands.executeCommand('exasol.addConnection');
            }
            return;
        }

        const items = connections.map((conn: StoredConnection) => ({
            label: conn.name,
            description: `${conn.host}:${conn.port}`,
            detail: connectionManager.getActiveConnection()?.id === conn.id ? '✓ Active' : '',
            connection: conn
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a connection to activate',
            matchOnDescription: true
        });

        if (selected) {
            await vscode.commands.executeCommand('exasol.setActiveConnection', selected);
        }
    });

    const connectionsChanged = connectionManager.onDidChangeConnections(() => {
        connectionTreeProvider.refresh();
        objectTreeProvider.refresh();
    });

    const activeConnectionChanged = connectionManager.onDidChangeActiveConnection(() => {
        connectionTreeProvider.refresh();
        objectTreeProvider.refresh();
        vscode.commands.executeCommand('setContext', 'exasol.hasActiveConnection', !!connectionManager.getActiveConnection());
    });

    // Add all disposables to context
    context.subscriptions.push(
        addConnectionCmd,
        refreshConnectionsCmd,
        executeQueryCmd,
        executeSelectedQueryCmd,
        executeScriptCmd,
        executeStatementCmd,
        showQueryHistoryCmd,
        exportResultsCmd,
        openQueryFromHistoryCmd,
        previewTableCmd,
        showTableDDLCmd,
        showViewDDLCmd,
        generateSelectCmd,
        describeTableCmd,
        openObjectCmd,
        setSchemaCmd,
        clearCacheCmd,
        editConnectionCmd,
        deleteConnectionCmd,
        renameConnectionCmd,
        setActiveConnectionCmd,
        disconnectConnectionCmd,
        copyQualifiedNameCmd,
        selectConnectionCmd,
        findObjectCmd,
        toggleSeparateResultTabsCmd,
        resultTabsStatusBar,
        resultTabsConfigListener,
        completionDisposable,
        codeLensDisposable,
        formattingDisposable,
        rangeFormattingDisposable,
        formatQueryCmd,
        connectionTreeView,
        objectTreeView,
        queryHistoryTreeView,
        statusBarItem,
        outputChannel,
        connectionsChanged,
        activeConnectionChanged,
        notebookSerializer,
        notebookController
    );

    return {
        context,
        connectionManager,
        queryExecutor,
        sessionManager
    };
}

// Export output channel for use in other modules
export function getOutputChannel(): vscode.OutputChannel {
    return outputChannel;
}

export function getExtensionContext(): vscode.ExtensionContext | undefined {
    return extensionContext;
}

async function addConnection(
    connectionManager: ConnectionManager,
    treeProvider: ConnectionTreeProvider,
    objectsProvider: ObjectTreeProvider,
    context: vscode.ExtensionContext
) {
    outputChannel.appendLine('📋 Opening connection panel...');

    // Show connection panel - it will handle errors internally
    const result = await ConnectionPanel.show(context.extensionUri, connectionManager, outputChannel);

    if (result) {
        // Connection was successful
        outputChannel.appendLine(`✅ Connection '${result.name}' added successfully`);
        treeProvider.refresh();
        objectsProvider.refresh();
        vscode.window.showInformationMessage(`✅ Connection '${result.name}' added successfully!`);
    } else {
        // User cancelled
        outputChannel.appendLine('❌ Connection creation cancelled');
    }
}

async function executeQuery(
    queryExecutor: QueryExecutor,
    queryHistoryProvider: QueryHistoryProvider,
    context: vscode.ExtensionContext,
    selectedOnly: boolean,
    connectionManager: ConnectionManager,
    fullFile: boolean = false
) {
    const output = getOutputChannel();
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
    }

    // Only allow execution from Exasol SQL files
    if (editor.document.languageId !== 'exasol-sql') {
        vscode.window.showWarningMessage('Please use Exasol SQL language mode to execute queries. Click the language indicator in the bottom-right corner and select "Exasol SQL".');
        return;
    }

    let queryText: string;
    const selection = editor.selection;
    const hasSelection = !selection.isEmpty;

    if (fullFile) {
        // Execute entire file regardless of selection or cursor
        queryText = editor.document.getText();
        output.appendLine('📄 Executing entire script');
    } else if (selectedOnly || hasSelection) {
        // Execute selected text if explicitly requested OR if there's a selection
        queryText = editor.document.getText(selection);
        if (hasSelection) {
            output.appendLine(`📝 Executing selected text (lines ${selection.start.line + 1}-${selection.end.line + 1})`);
        }
    } else {
        // No selection - try to find the statement at the cursor position
        const cursorLine = editor.selection.active.line;
        const documentText = editor.document.getText();
        const statement = findStatementAtCursor(documentText, cursorLine);

        if (statement) {
            // Found a statement at the cursor - execute only that statement
            queryText = statement.text;
            output.appendLine(`🎯 Executing statement at cursor (lines ${statement.range.start + 1}-${statement.range.end + 1})`);
        } else {
            // No statement found at cursor - execute entire file
            queryText = documentText;
            output.appendLine('📄 Executing entire file');
        }
    }

    if (!queryText.trim()) {
        vscode.window.showWarningMessage('No query to execute');
        return;
    }

    // Split the text into individual statements
    const statements = splitIntoStatements(queryText);

    if (statements.length === 0) {
        vscode.window.showWarningMessage('No queries to execute');
        return;
    }

    const activeConnection = connectionManager.getActiveConnection();
    if (!activeConnection) {
        const message = 'No active connection. Please add a connection first.';
        output.appendLine(`❌ ${message}`);
        vscode.window.showErrorMessage(message);
        return;
    }

    // If multiple statements, notify the user
    if (statements.length > 1) {
        output.appendLine(`🔢 Found ${statements.length} statements to execute`);
    }

    let cancellationTokenSource = new vscode.CancellationTokenSource();
    queryExecutor.setCancellationToken(cancellationTokenSource);

    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: statements.length > 1
                    ? `Executing ${statements.length} queries...`
                    : 'Executing query...',
                cancellable: true
            },
            async (progress, token) => {
                let cancelled = false;
                token.onCancellationRequested(() => {
                    cancelled = true;
                    cancellationTokenSource.cancel();
                });

                const separateTabs = vscode.workspace.getConfiguration('exasol').get<boolean>('separateResultTabs', false);
                const useTabCollection = separateTabs && statements.length > 1;
                const collector = useTabCollection ? new TabResultCollector() : null;
                let lastResult = null;

                const batchStartTime = performance.now();
                let successCount = 0;
                let failCount = 0;

                for (let i = 0; i < statements.length; i++) {
                    const query = statements[i];
                    const queryNum = i + 1;

                    if (cancelled) {
                        output.appendLine(`⚠️ Execution cancelled after query ${i}/${statements.length}`);
                        break;
                    }

                    if (statements.length > 1) {
                        progress.report({
                            message: `Query ${queryNum}/${statements.length}`,
                            increment: (100 / statements.length)
                        });
                        output.appendLine(`\n▶️ Executing query ${queryNum}/${statements.length}:`);
                        output.appendLine(`   ${query.substring(0, 100)}${query.length > 100 ? '...' : ''}`);
                    }

                    try {
                        const result = await queryExecutor.execute(query, cancellationTokenSource.token);

                        // Add to history
                        queryHistoryProvider.addQuery(query, result.rowCount);

                        // Keep track of the last result to show in the panel
                        lastResult = result;
                        successCount++;

                        if (statements.length > 1) {
                            output.appendLine(`   ✅ Query ${queryNum} completed. ${result.rowCount} rows affected.`);
                        } else {
                            output.appendLine(`✅ Query executed successfully. ${result.rowCount} rows returned.`);
                        }

                        if (collector) {
                            collector.addResult(result);
                        } else {
                            await ResultsPanel.show(result);
                            QueryStatsPanel.updateStats(query, result);
                        }

                    } catch (error) {
                        const errorMsg = formatError(error);
                        failCount++;

                        if (statements.length > 1) {
                            output.appendLine(`   ❌ Query ${queryNum} failed: ${errorMsg}`);
                        } else {
                            output.appendLine(`❌ Query failed: ${errorMsg}`);
                        }

                        queryHistoryProvider.addQuery(query, 0, errorMsg);

                        if (collector) {
                            collector.addError(errorMsg);

                            // Ask user if they want to continue with remaining queries
                            if (i < statements.length - 1) {
                                const continueExecution = await vscode.window.showErrorMessage(
                                    `Query ${queryNum}/${statements.length} failed. Continue with remaining queries?`,
                                    'Continue',
                                    'Stop'
                                );

                                if (continueExecution !== 'Continue') {
                                    output.appendLine(`⚠️ Execution stopped by user after query ${queryNum}/${statements.length}`);
                                    break;
                                } else {
                                    output.appendLine(`   ⏩ Continuing with remaining queries...`);
                                    // Reset cancellation state so the batch can continue
                                    if (cancelled) {
                                        cancelled = false;
                                        cancellationTokenSource.dispose();
                                        cancellationTokenSource = new vscode.CancellationTokenSource();
                                        cancellationTokenSource.token.onCancellationRequested(() => {
                                            cancelled = true;
                                        });
                                    }
                                }
                            }
                        } else {
                            // Show error in results panel
                            await ResultsPanel.showError(errorMsg);

                            // Ask user if they want to continue with remaining queries
                            if (statements.length > 1 && i < statements.length - 1) {
                                const continueExecution = await vscode.window.showErrorMessage(
                                    `Query ${queryNum}/${statements.length} failed. Continue with remaining queries?`,
                                    'Continue',
                                    'Stop'
                                );

                                if (continueExecution !== 'Continue') {
                                    output.appendLine(`⚠️ Execution stopped by user after query ${queryNum}/${statements.length}`);
                                    break;
                                } else {
                                    output.appendLine(`   ⏩ Continuing with remaining queries...`);
                                    // Reset cancellation state so the batch can continue
                                    if (cancelled) {
                                        cancelled = false;
                                        cancellationTokenSource.dispose();
                                        cancellationTokenSource = new vscode.CancellationTokenSource();
                                        cancellationTokenSource.token.onCancellationRequested(() => {
                                            cancelled = true;
                                        });
                                    }
                                }
                            } else {
                                // Single query or last query - just throw
                                throw error;
                            }
                        }
                    }
                }

                if (collector && collector.hasResults()) {
                    ResultsPanel.showMultiple(collector.getTabs());
                    // Update stats for the first successful result
                    const firstTab = collector.getTabs().find(t => t.result);
                    if (firstTab?.result) {
                        QueryStatsPanel.updateStats(statements[0], firstTab.result);
                    }
                }

                if (statements.length > 1) {
                    output.appendLine(`\n🎉 Completed executing ${statements.length} queries`);
                }

                // Show query notifications
                const showNotifications = vscode.workspace.getConfiguration('exasol').get<boolean>('showQueryNotifications', true);
                if (showNotifications) {
                    const totalDuration = formatDuration(performance.now() - batchStartTime);

                    if (statements.length === 1 && lastResult) {
                        // Single query success in executeQueries path
                        showTimedNotification(`Query executed in ${formatDuration(lastResult.executionTime)} — ${lastResult.rowCount} rows returned`);
                    } else if (statements.length > 1) {
                        // Batch summary
                        if (failCount === 0) {
                            showTimedNotification(`${successCount}/${statements.length} queries executed in ${totalDuration}`);
                        } else {
                            vscode.window.showWarningMessage(`${successCount}/${statements.length} queries executed (${failCount} failed) in ${totalDuration}`);
                        }
                    }
                }
            }
        );
    } catch (error) {
        // Error already handled in the loop — but show failure notification for single-query case
        const showNotifications = vscode.workspace.getConfiguration('exasol').get<boolean>('showQueryNotifications', true);
        if (showNotifications && statements.length === 1) {
            const errorMsg = formatError(error);
            const action = await vscode.window.showErrorMessage(`Query failed: ${errorMsg}`, 'Show Details');
            if (action === 'Show Details') {
                output.show();
            }
        }
    } finally {
        cancellationTokenSource.dispose();
    }
}

async function editConnection(
    connectionManager: ConnectionManager,
    treeProvider: ConnectionTreeProvider,
    objectsProvider: ObjectTreeProvider,
    context: vscode.ExtensionContext,
    connection: any
) {
    outputChannel.appendLine(`✏️ Editing connection '${connection.name}'`);

    // Show connection panel with existing connection data
    const result = await ConnectionPanel.showEdit(context.extensionUri, connectionManager, outputChannel, connection);

    if (result) {
        outputChannel.appendLine(`✅ Connection '${result.name}' updated successfully`);
        treeProvider.refresh();
        objectsProvider.refresh();
        vscode.window.showInformationMessage(`✅ Connection '${result.name}' updated successfully!`);
    } else {
        outputChannel.appendLine('❌ Connection edit cancelled');
    }
}

async function deleteConnection(
    connectionManager: ConnectionManager,
    treeProvider: ConnectionTreeProvider,
    objectsProvider: ObjectTreeProvider,
    connection: any
) {
    outputChannel.appendLine(`🗑️ Deleting connection '${connection.name}'`);

    const answer = await vscode.window.showWarningMessage(
        `Are you sure you want to delete connection '${connection.name}'?`,
        { modal: true },
        'Delete'
    );

    if (answer === 'Delete') {
        try {
            await connectionManager.removeConnection(connection.id);
            treeProvider.refresh();
            objectsProvider.refresh();
            outputChannel.appendLine(`✅ Connection '${connection.name}' deleted`);
            vscode.window.showInformationMessage(`Connection '${connection.name}' deleted`);
        } catch (error) {
            outputChannel.appendLine(`❌ Failed to delete connection: ${error}`);
            vscode.window.showErrorMessage(`Failed to delete connection: ${error}`);
        }
    } else {
        outputChannel.appendLine('❌ Connection deletion cancelled');
    }
}

async function renameConnection(
    connectionManager: ConnectionManager,
    treeProvider: ConnectionTreeProvider,
    objectsProvider: ObjectTreeProvider,
    connection: any
) {
    const newName = await vscode.window.showInputBox({
        title: 'Rename Exasol Connection',
        value: connection.name,
        prompt: 'Enter a new name for this connection',
        validateInput: value => !value.trim() ? 'Name cannot be empty' : undefined
    });

    if (!newName || newName === connection.name) {
        return;
    }

    try {
        await connectionManager.renameConnection(connection.id, newName.trim());
        treeProvider.refresh();
        objectsProvider.refresh();
        outputChannel.appendLine(`✏️ Connection '${connection.name}' renamed to '${newName.trim()}'`);
        vscode.window.showInformationMessage(`Connection renamed to '${newName.trim()}'`);
    } catch (error) {
        outputChannel.appendLine(`❌ Failed to rename connection: ${error}`);
        vscode.window.showErrorMessage(`Failed to rename connection: ${error}`);
    }
}

async function executeStatement(
    queryExecutor: QueryExecutor,
    queryHistoryProvider: QueryHistoryProvider,
    connectionManager: ConnectionManager,
    document: vscode.TextDocument,
    range: vscode.Range
) {
    const output = getOutputChannel();

    // Get the query text from the range
    const query = document.getText(range).trim();

    if (!query) {
        vscode.window.showWarningMessage('No query to execute');
        return;
    }

    const cancellationTokenSource = new vscode.CancellationTokenSource();
    queryExecutor.setCancellationToken(cancellationTokenSource);

    try {
        const activeConnection = connectionManager.getActiveConnection();
        if (!activeConnection) {
            const message = 'No active connection. Please add a connection first.';
            output.appendLine(`❌ ${message}`);
            vscode.window.showErrorMessage(message);
            return;
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Executing query...',
                cancellable: true
            },
            async (progress, token) => {
                token.onCancellationRequested(() => {
                    cancellationTokenSource.cancel();
                });

                const result = await queryExecutor.execute(query, cancellationTokenSource.token);

                // Add to history
                queryHistoryProvider.addQuery(query, result.rowCount);

                // Show results and stats
                await ResultsPanel.show(result);
                QueryStatsPanel.updateStats(query, result);

                output.appendLine(`✅ Query executed successfully. ${result.rowCount} rows returned.`);

                // Show success notification
                const showNotifications = vscode.workspace.getConfiguration('exasol').get<boolean>('showQueryNotifications', true);
                if (showNotifications) {
                    showTimedNotification(`Query executed in ${formatDuration(result.executionTime)} — ${result.rowCount} rows returned`);
                }
            }
        );
    } catch (error) {
        const errorMsg = formatError(error);
        output.appendLine(`❌ Query failed: ${errorMsg}`);

        // Show error in results panel
        await ResultsPanel.showError(errorMsg);

        queryHistoryProvider.addQuery(query, 0, errorMsg);

        // Show failure notification
        const showNotifications = vscode.workspace.getConfiguration('exasol').get<boolean>('showQueryNotifications', true);
        if (showNotifications) {
            const action = await vscode.window.showErrorMessage(`Query failed: ${errorMsg}`, 'Show Details');
            if (action === 'Show Details') {
                output.show();
            }
        }
    } finally {
        cancellationTokenSource.dispose();
    }
}

export async function deactivate() {
    console.log('Exasol extension is now deactivated');
    if (extensionConnectionManager) {
        await extensionConnectionManager.closeAll();
    }
}
