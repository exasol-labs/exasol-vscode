import * as vscode from 'vscode';
import { ConnectionManager, StoredConnection } from './connectionManager';
import { ConnectionTreeProvider } from './providers/connectionTreeProvider';
import { ObjectTreeProvider } from './providers/objectTreeProvider';
import { QueryHistoryProvider } from './providers/queryHistoryProvider';
import { ExasolCompletionProvider } from './providers/completionProvider';
import { ExasolCodeLensProvider } from './providers/codeLensProvider';
import { QueryExecutor } from './queryExecutor';
import { ResultsPanel } from './panels/resultsPanel';
import { QueryStatsPanel } from './panels/queryStatsPanel';
import { ConnectionPanel } from './panels/connectionPanel';
import { SessionManager } from './sessionManager';
import { ObjectActions } from './objectActions';

// Create output channel for logging
let outputChannel: vscode.OutputChannel;
let extensionContext: vscode.ExtensionContext | undefined;

export function activate(context: vscode.ExtensionContext) {
    extensionContext = context;

    // Create output channel
    outputChannel = vscode.window.createOutputChannel('Exasol');
    outputChannel.appendLine('🚀 Exasol extension activated');
    console.log('Exasol extension is now active');

    // Initialize managers
    const connectionManager = new ConnectionManager(context);
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

    // Create status bar item for session info
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.text = sessionManager.getStatusBarText();
    statusBarItem.show();

    // Update status bar when session changes
    sessionManager.onDidChangeSession(() => {
        statusBarItem.text = sessionManager.getStatusBarText();
    });

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
            await objectActions.previewTableData(item.connection, item.schemaName, item.tableInfo.name);
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

    const openObjectCmd = vscode.commands.registerCommand('exasol.openObject', async (item: any) => {
        if (item && item.connection && item.schemaName && item.tableInfo) {
            await objectActions.previewTableData(item.connection, item.schemaName, item.tableInfo.name, 100, false);
            await objectActions.describeTable(item.connection, item.schemaName, item.tableInfo.name);
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

    const connectionsChanged = connectionManager.onDidChangeConnections(() => {
        connectionTreeProvider.refresh();
        objectTreeProvider.refresh();
    });

    const activeConnectionChanged = connectionManager.onDidChangeActiveConnection(() => {
        connectionTreeProvider.refresh();
        objectTreeProvider.refresh();
    });

    // Add all disposables to context
    context.subscriptions.push(
        addConnectionCmd,
        refreshConnectionsCmd,
        executeQueryCmd,
        executeSelectedQueryCmd,
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
        copyQualifiedNameCmd,
        completionDisposable,
        codeLensDisposable,
        connectionTreeView,
        objectTreeView,
        queryHistoryTreeView,
        statusBarItem,
        outputChannel,
        connectionsChanged,
        activeConnectionChanged
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
    connectionManager: ConnectionManager
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

    let query: string;
    if (selectedOnly) {
        const selection = editor.selection;
        query = editor.document.getText(selection);
    } else {
        query = editor.document.getText();
    }

    if (!query.trim()) {
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
                ResultsPanel.show(result);
                QueryStatsPanel.updateStats(query, result);

                output.appendLine(`✅ Query executed successfully. ${result.rowCount} rows returned.`);
            }
        );
    } catch (error) {
        const errorMsg = String(error);
        output.appendLine(`❌ Query failed: ${errorMsg}`);

        // Show error in results panel
        ResultsPanel.showError(errorMsg);

        queryHistoryProvider.addQuery(query, 0, errorMsg);
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
                ResultsPanel.show(result);
                QueryStatsPanel.updateStats(query, result);

                output.appendLine(`✅ Query executed successfully. ${result.rowCount} rows returned.`);
            }
        );
    } catch (error) {
        const errorMsg = String(error);
        output.appendLine(`❌ Query failed: ${errorMsg}`);

        // Show error in results panel
        ResultsPanel.showError(errorMsg);

        queryHistoryProvider.addQuery(query, 0, errorMsg);
    } finally {
        cancellationTokenSource.dispose();
    }
}

export function deactivate() {
    console.log('Exasol extension is now deactivated');
}
