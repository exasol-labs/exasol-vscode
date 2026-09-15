import * as assert from 'assert';
import type * as vscode from 'vscode';
import type { ConnectionManager } from '../../connectionManager';
import type { ObjectNode } from '../../providers/objectTreeProvider';
import { registerVscodeMock, registerExtensionMock, vscodeMock } from '../helpers/vscodeMock';
import type { MockDriver, ConfigWorkspaceMock } from '../helpers/completionMocks';

// Track calls to vscode.window methods
const windowCalls: { method: string; args: unknown[] }[] = [];

interface MockQuickPickItem {
    label: string;
    description?: string;
    detail?: string;
}

interface MockQuickPick {
    placeholder: string;
    matchOnDescription: boolean;
    matchOnDetail: boolean;
    busy: boolean;
    items: MockQuickPickItem[];
    selectedItems: MockQuickPickItem[];
    onDidAccept: (cb: () => void) => void;
    onDidHide: (cb: () => void) => void;
    show: () => void;
    hide: () => void;
    dispose: () => void;
    _acceptCallback: (() => void) | null;
    _hideCallback: (() => void) | null;
}

let mockQuickPick: MockQuickPick;

function resetWindowCalls(): void {
    windowCalls.length = 0;
    mockQuickPick = {
        placeholder: '',
        matchOnDescription: false,
        matchOnDetail: false,
        busy: false,
        items: [],
        selectedItems: [],
        onDidAccept: (cb: () => void) => { mockQuickPick._acceptCallback = cb; },
        onDidHide: (cb: () => void) => { mockQuickPick._hideCallback = cb; },
        show: () => { windowCalls.push({ method: 'quickPick.show', args: [] }); },
        hide: () => { windowCalls.push({ method: 'quickPick.hide', args: [] }); },
        dispose: () => { windowCalls.push({ method: 'quickPick.dispose', args: [] }); },
        _acceptCallback: null,
        _hideCallback: null,
    };
}

// This file's own vscode.window surface (QuickPick + message boxes), not
// shared with resolveImportPath's differently-shaped MockWindow (that one
// mocks activeTextEditor, a completely different part of the API).
interface MockWindow {
    showInformationMessage: (...args: string[]) => Promise<undefined>;
    showErrorMessage: (...args: string[]) => Promise<undefined>;
    createQuickPick: () => MockQuickPick;
}
interface ObjectSearchVscodeMock {
    window: MockWindow;
    workspace: ConfigWorkspaceMock;
}

const extendedMock = vscodeMock as unknown as ObjectSearchVscodeMock;

/**
 * Builds this suite's `window` mock. Called once at module load (below), so the
 * `window` key exists on the shared vscodeMock singleton before
 * objectSearchProvider.ts is required (__importStar only wires a live getter
 * for keys present at that exact moment), and again in setup() before every
 * test, since vscodeMock is a process-wide singleton other test files also
 * mutate (some without restoring it in a teardown), so a single module-load-time
 * install is not enough to survive an arbitrary file load/run order.
 */
function buildWindowMock(): MockWindow {
    return {
        showInformationMessage: (...args: string[]) => {
            windowCalls.push({ method: 'showInformationMessage', args });
            return Promise.resolve(undefined);
        },
        showErrorMessage: (...args: string[]) => {
            windowCalls.push({ method: 'showErrorMessage', args });
            return Promise.resolve(undefined);
        },
        createQuickPick: () => {
            windowCalls.push({ method: 'createQuickPick', args: [] });
            return mockQuickPick;
        }
    };
}

extendedMock.window = buildWindowMock();

registerVscodeMock();
registerExtensionMock();

const { ObjectSearchProvider } = require('../../providers/objectSearchProvider') as typeof import('../../providers/objectSearchProvider');
const { ObjectTreeProvider, ObjectTreeItem } = require('../../providers/objectTreeProvider') as typeof import('../../providers/objectTreeProvider');

import { createRawResult, createEmptyRawResult, MockConnectionManager } from '../helpers/mockConnectionManager';

type ObjectTreeItemInstance = InstanceType<typeof ObjectTreeItem>;
type ObjectTreeView = vscode.TreeView<ObjectNode>;

// Minimal partial double for vscode.TreeView<ObjectNode> (only `reveal` is
// exercised); a fully typed double would be far larger than these tests need.
interface MockTreeView {
    reveal: (element: ObjectTreeItemInstance, options?: { select?: boolean; focus?: boolean; expand?: boolean | number }) => Promise<void>;
}

suite('ObjectSearchProvider', () => {

    let searchProvider: InstanceType<typeof ObjectSearchProvider>;
    let mockDriver: MockDriver;
    let mockCM: InstanceType<typeof MockConnectionManager>;
    let objectTreeProvider: InstanceType<typeof ObjectTreeProvider>;
    let mockTreeView: MockTreeView;

    setup(() => {
        resetWindowCalls();
        // Reinstall window per-test: vscodeMock is a shared singleton, and other
        // test files mutate it (some without restoring it in a teardown), so a
        // single module-load-time install does not survive an arbitrary file
        // load/run order. See buildWindowMock's doc comment above.
        extendedMock.window = buildWindowMock();
        // Enable column search in tests so column-related assertions still pass.
        // Installed per-test (not at module load) since vscodeMock.workspace is
        // a shared singleton other test files also mutate; see the comment
        // above extendedMock.window for why.
        extendedMock.workspace = {
            getConfiguration: () => ({
                get: (key: string, defaultValue?: unknown) => {
                    if (key === 'searchIncludesColumns') { return true; }
                    return defaultValue;
                }
            })
        };
        mockDriver = {
            query: async (sql: string) => {
                if (sql.includes('EXA_ALL_TABLES') && sql.includes('UNION')) {
                    return createRawResult(
                        ['TABLE_SCHEMA', 'TABLE_NAME', 'OBJECT_TYPE'],
                        [
                            ['MY_SCHEMA', 'USERS', 'table'],
                            ['MY_SCHEMA', 'ACTIVE_USERS', 'view']
                        ]
                    );
                }
                if (sql.includes('EXA_ALL_SCRIPTS') && sql.includes('SCRIPT_SCHEMA')) {
                    return createRawResult(
                        ['SCRIPT_SCHEMA', 'SCRIPT_NAME'],
                        [['MY_SCHEMA', 'MY_UDF']]
                    );
                }
                if (sql.includes('EXA_ALL_FUNCTIONS') && sql.includes('FUNCTION_SCHEMA')) {
                    return createRawResult(
                        ['FUNCTION_SCHEMA', 'FUNCTION_NAME'],
                        [['MY_SCHEMA', 'MY_FUNC']]
                    );
                }
                if (sql.includes('EXA_ALL_VIRTUAL_TABLES')) {
                    return createRawResult(
                        ['TABLE_SCHEMA', 'TABLE_NAME'],
                        [['VS_SCHEMA', 'REMOTE_TABLE']]
                    );
                }
                if (sql.includes('EXA_SYSCAT')) {
                    return createRawResult(
                        ['TABLE_SCHEMA', 'TABLE_NAME'],
                        [['SYS', 'EXA_ALL_COLUMNS']]
                    );
                }
                if (sql.includes('EXA_ALL_COLUMNS') && sql.includes('COLUMN_SCHEMA')) {
                    return createRawResult(
                        ['COLUMN_SCHEMA', 'COLUMN_TABLE', 'COLUMN_NAME'],
                        [['MY_SCHEMA', 'USERS', 'ID']]
                    );
                }
                return createEmptyRawResult(['DUMMY']);
            }
        };
        mockCM = new MockConnectionManager(mockDriver);
        objectTreeProvider = new ObjectTreeProvider(mockCM as unknown as ConnectionManager);
        mockTreeView = {
            reveal: async () => {}
        };
        searchProvider = new ObjectSearchProvider(
            mockCM as unknown as ConnectionManager,
            objectTreeProvider,
            mockTreeView as unknown as ObjectTreeView
        );
    });

    test('shows info message when no active connection', async () => {
        mockCM = new MockConnectionManager(mockDriver);
        // Override to return no active connection
        mockCM.getActiveConnection = () => undefined;
        searchProvider = new ObjectSearchProvider(
            mockCM as unknown as ConnectionManager,
            objectTreeProvider,
            mockTreeView as unknown as ObjectTreeView
        );

        await searchProvider.showSearch();

        const infoCall = windowCalls.find(c => c.method === 'showInformationMessage');
        assert.ok(infoCall, 'Should call showInformationMessage');
        const infoMessage = infoCall.args[0];
        assert.ok(typeof infoMessage === 'string');
        assert.ok(
            infoMessage.includes('No active connection'),
            'Message should mention no active connection'
        );
    });

    test('creates QuickPick and shows it', async () => {
        await searchProvider.showSearch();

        const createCall = windowCalls.find(c => c.method === 'createQuickPick');
        assert.ok(createCall, 'Should call createQuickPick');
        const showCall = windowCalls.find(c => c.method === 'quickPick.show');
        assert.ok(showCall, 'Should call quickPick.show');
    });

    test('populates QuickPick items with correct structure', async () => {
        await searchProvider.showSearch();

        assert.ok(mockQuickPick.items.length > 0, 'Should have items');

        const tableItem = mockQuickPick.items.find(
            (i) => i.label.includes('USERS') && i.detail === 'Table'
        );
        assert.ok(tableItem, 'Should find USERS table item');
        assert.strictEqual(tableItem.description, 'MY_SCHEMA', 'Description should be schema name');
        assert.ok(tableItem.label.includes('$('), 'Label should contain icon codicon');

        const viewItem = mockQuickPick.items.find(
            (i) => i.label.includes('ACTIVE_USERS') && i.detail === 'View'
        );
        assert.ok(viewItem, 'Should find ACTIVE_USERS view item');

        const scriptItem = mockQuickPick.items.find(
            (i) => i.label.includes('MY_UDF') && i.detail === 'Script'
        );
        assert.ok(scriptItem, 'Should find MY_UDF script item');

        const funcItem = mockQuickPick.items.find(
            (i) => i.label.includes('MY_FUNC') && i.detail === 'Function'
        );
        assert.ok(funcItem, 'Should find MY_FUNC function item');

        const virtualItem = mockQuickPick.items.find(
            (i) => i.label.includes('REMOTE_TABLE') && i.detail === 'Virtual Table'
        );
        assert.ok(virtualItem, 'Should find REMOTE_TABLE virtual table item');

        const sysItem = mockQuickPick.items.find(
            (i) => i.label.includes('EXA_ALL_COLUMNS') && i.detail === 'System Table'
        );
        assert.ok(sysItem, 'Should find EXA_ALL_COLUMNS system table item');

        const colItem = mockQuickPick.items.find(
            (i) => i.label.includes('ID') && i.detail === 'Column'
        );
        assert.ok(colItem, 'Should find ID column item');
    });

    test('sets busy true initially then false after loading', async () => {
        await searchProvider.showSearch();

        assert.strictEqual(mockQuickPick.busy, false, 'Busy should be false after loading');
    });

    test('shows error message on database error', async () => {
        const failDriver: MockDriver = {
            query: async () => { throw new Error('Connection lost'); }
        };
        const failCM = new MockConnectionManager(failDriver);
        const failSearch = new ObjectSearchProvider(
            failCM as unknown as ConnectionManager,
            objectTreeProvider,
            mockTreeView as unknown as ObjectTreeView
        );

        await failSearch.showSearch();

        const errorCall = windowCalls.find(c => c.method === 'showErrorMessage');
        assert.ok(errorCall, 'Should call showErrorMessage');
        const errorMessage = errorCall.args[0];
        assert.ok(typeof errorMessage === 'string');
        assert.ok(
            errorMessage.includes('Failed to fetch objects'),
            'Error message should mention failure to fetch objects'
        );

        const hideCall = windowCalls.find(c => c.method === 'quickPick.hide');
        assert.ok(hideCall, 'Should hide QuickPick on error');
    });

    test('onDidAccept calls treeView.reveal with the selected item', async () => {
        const revealCalls: { node: ObjectTreeItemInstance; options: { select?: boolean; focus?: boolean; expand?: boolean | number } | undefined }[] = [];
        mockTreeView.reveal = async (node, options) => {
            revealCalls.push({ node, options });
        };

        // We need an objectTreeProvider that returns nodes matching the search results
        const mockSchemaNode = new ObjectTreeItem({
            label: 'MY_SCHEMA',
            id: 'schema-my_schema',
            collapsibleState: 0 as vscode.TreeItemCollapsibleState,
            type: 'schema',
            schemaName: 'MY_SCHEMA',
        });
        const mockTablesFolder = new ObjectTreeItem({
            label: 'Tables',
            id: 'tables-folder-my_schema',
            collapsibleState: 0 as vscode.TreeItemCollapsibleState,
            type: 'tables-folder',
            schemaName: 'MY_SCHEMA',
        });
        const mockTableNode = new ObjectTreeItem({
            label: 'USERS',
            id: 'table-my_schema-users',
            collapsibleState: 0 as vscode.TreeItemCollapsibleState,
            type: 'table',
            schemaName: 'MY_SCHEMA',
        });

        objectTreeProvider.getChildren = async (element?: ObjectNode) => {
            if (!element) {
                return [mockSchemaNode];
            }
            if (element === mockSchemaNode) {
                return [mockTablesFolder];
            }
            if (element === mockTablesFolder) {
                return [mockTableNode];
            }
            return [];
        };

        searchProvider = new ObjectSearchProvider(
            mockCM as unknown as ConnectionManager,
            objectTreeProvider,
            mockTreeView as unknown as ObjectTreeView
        );
        await searchProvider.showSearch();

        const tableItem = mockQuickPick.items.find(
            (i) => i.label.includes('USERS') && i.detail === 'Table'
        );
        assert.ok(tableItem, 'Should find USERS table item');

        mockQuickPick.selectedItems = [tableItem];
        assert.ok(mockQuickPick._acceptCallback, 'Accept callback should be registered');
        await mockQuickPick._acceptCallback();

        assert.strictEqual(revealCalls.length, 1, 'Should call reveal exactly once');
        assert.strictEqual(revealCalls[0].node, mockTableNode, 'Should reveal the correct tree node');
        assert.deepStrictEqual(revealCalls[0].options, {
            select: true,
            focus: true,
            expand: true
        }, 'Should pass correct reveal options');
    });

    test('QuickPick items have correct icon for each type', async () => {
        await searchProvider.showSearch();

        const tableItem = mockQuickPick.items.find(
            (i) => i.detail === 'Table'
        );
        assert.ok(tableItem, 'Should find a table item');
        assert.ok(tableItem.label.includes('$(table)'), 'Table should use table icon');

        const viewItem = mockQuickPick.items.find(
            (i) => i.detail === 'View'
        );
        assert.ok(viewItem, 'Should find a view item');
        assert.ok(viewItem.label.includes('$(eye)'), 'View should use eye icon');

        const colItem = mockQuickPick.items.find(
            (i) => i.detail === 'Column'
        );
        assert.ok(colItem, 'Should find a column item');
        assert.ok(colItem.label.includes('$(symbol-field)'), 'Column should use symbol-field icon');
    });
});
