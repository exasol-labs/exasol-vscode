import * as assert from 'assert';
import { registerVscodeMock, registerExtensionMock, vscodeMock } from '../helpers/vscodeMock';

// Track calls to vscode.window methods
const windowCalls: { method: string; args: any[] }[] = [];
let mockQuickPick: any;

function resetWindowCalls(): void {
    windowCalls.length = 0;
    mockQuickPick = {
        placeholder: '',
        matchOnDescription: false,
        matchOnDetail: false,
        busy: false,
        items: [] as any[],
        selectedItems: [] as any[],
        onDidAccept: (_cb: () => void) => { mockQuickPick._acceptCallback = _cb; },
        onDidHide: (_cb: () => void) => { mockQuickPick._hideCallback = _cb; },
        show: () => { windowCalls.push({ method: 'quickPick.show', args: [] }); },
        hide: () => { windowCalls.push({ method: 'quickPick.hide', args: [] }); },
        dispose: () => { windowCalls.push({ method: 'quickPick.dispose', args: [] }); },
        _acceptCallback: null as (() => void) | null,
        _hideCallback: null as (() => void) | null,
    };
}

// Enhance the vscode mock with window methods and workspace configuration
(vscodeMock as any).window = {
    showInformationMessage: (...args: any[]) => {
        windowCalls.push({ method: 'showInformationMessage', args });
        return Promise.resolve(undefined);
    },
    showErrorMessage: (...args: any[]) => {
        windowCalls.push({ method: 'showErrorMessage', args });
        return Promise.resolve(undefined);
    },
    createQuickPick: () => {
        windowCalls.push({ method: 'createQuickPick', args: [] });
        return mockQuickPick;
    }
};
// Enable column search in tests so column-related assertions still pass
(vscodeMock as any).workspace = {
    getConfiguration: () => ({
        get: (key: string, defaultValue?: any) => {
            if (key === 'searchIncludesColumns') { return true; }
            return defaultValue;
        }
    })
};

registerVscodeMock();
registerExtensionMock();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ObjectSearchProvider } = require('../../providers/objectSearchProvider');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ObjectTreeProvider } = require('../../providers/objectTreeProvider');

import { createRawResult, createEmptyRawResult, MockConnectionManager } from '../helpers/mockConnectionManager';

suite('ObjectSearchProvider', () => {

    let searchProvider: any;
    let mockDriver: any;
    let mockCM: any;
    let objectTreeProvider: any;
    let mockTreeView: any;

    setup(() => {
        resetWindowCalls();
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
        objectTreeProvider = new ObjectTreeProvider(mockCM);
        mockTreeView = {
            reveal: async () => {}
        };
        searchProvider = new ObjectSearchProvider(mockCM, objectTreeProvider, mockTreeView);
    });

    test('shows info message when no active connection', async () => {
        mockCM = new MockConnectionManager(mockDriver);
        // Override to return null
        mockCM.getActiveConnection = () => null;
        searchProvider = new ObjectSearchProvider(mockCM, objectTreeProvider, mockTreeView);

        await searchProvider.showSearch();

        const infoCall = windowCalls.find(c => c.method === 'showInformationMessage');
        assert.ok(infoCall, 'Should call showInformationMessage');
        assert.ok(
            infoCall.args[0].includes('No active connection'),
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
            (i: any) => i.label.includes('USERS') && i.detail === 'Table'
        );
        assert.ok(tableItem, 'Should find USERS table item');
        assert.strictEqual(tableItem.description, 'MY_SCHEMA', 'Description should be schema name');
        assert.ok(tableItem.label.includes('$('), 'Label should contain icon codicon');

        const viewItem = mockQuickPick.items.find(
            (i: any) => i.label.includes('ACTIVE_USERS') && i.detail === 'View'
        );
        assert.ok(viewItem, 'Should find ACTIVE_USERS view item');

        const scriptItem = mockQuickPick.items.find(
            (i: any) => i.label.includes('MY_UDF') && i.detail === 'Script'
        );
        assert.ok(scriptItem, 'Should find MY_UDF script item');

        const funcItem = mockQuickPick.items.find(
            (i: any) => i.label.includes('MY_FUNC') && i.detail === 'Function'
        );
        assert.ok(funcItem, 'Should find MY_FUNC function item');

        const virtualItem = mockQuickPick.items.find(
            (i: any) => i.label.includes('REMOTE_TABLE') && i.detail === 'Virtual Table'
        );
        assert.ok(virtualItem, 'Should find REMOTE_TABLE virtual table item');

        const sysItem = mockQuickPick.items.find(
            (i: any) => i.label.includes('EXA_ALL_COLUMNS') && i.detail === 'System Table'
        );
        assert.ok(sysItem, 'Should find EXA_ALL_COLUMNS system table item');

        const colItem = mockQuickPick.items.find(
            (i: any) => i.label.includes('ID') && i.detail === 'Column'
        );
        assert.ok(colItem, 'Should find ID column item');
    });

    test('sets busy true initially then false after loading', async () => {
        await searchProvider.showSearch();

        assert.strictEqual(mockQuickPick.busy, false, 'Busy should be false after loading');
    });

    test('shows error message on database error', async () => {
        const failDriver = {
            query: async () => { throw new Error('Connection lost'); }
        };
        const failCM = new MockConnectionManager(failDriver);
        const failSearch = new ObjectSearchProvider(failCM, objectTreeProvider, mockTreeView);

        await failSearch.showSearch();

        const errorCall = windowCalls.find(c => c.method === 'showErrorMessage');
        assert.ok(errorCall, 'Should call showErrorMessage');
        assert.ok(
            errorCall.args[0].includes('Failed to fetch objects'),
            'Error message should mention failure to fetch objects'
        );

        const hideCall = windowCalls.find(c => c.method === 'quickPick.hide');
        assert.ok(hideCall, 'Should hide QuickPick on error');
    });

    test('onDidAccept calls treeView.reveal with the selected item', async () => {
        const revealCalls: { node: any; options: any }[] = [];
        mockTreeView.reveal = async (node: any, options: any) => {
            revealCalls.push({ node, options });
        };

        // We need an objectTreeProvider that returns nodes matching the search results
        const mockSchemaNode = new (require('../../providers/objectTreeProvider').ObjectTreeItem)({
            label: 'MY_SCHEMA',
            type: 'schema',
            connectionId: 'conn-1',
            schemaName: 'MY_SCHEMA',
        });
        const mockTablesFolder = new (require('../../providers/objectTreeProvider').ObjectTreeItem)({
            label: 'Tables',
            type: 'tables-folder',
            connectionId: 'conn-1',
            schemaName: 'MY_SCHEMA',
        });
        const mockTableNode = new (require('../../providers/objectTreeProvider').ObjectTreeItem)({
            label: 'USERS',
            type: 'table',
            connectionId: 'conn-1',
            schemaName: 'MY_SCHEMA',
        });

        objectTreeProvider.getChildren = async (element?: any) => {
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

        searchProvider = new ObjectSearchProvider(mockCM, objectTreeProvider, mockTreeView);
        await searchProvider.showSearch();

        const tableItem = mockQuickPick.items.find(
            (i: any) => i.label.includes('USERS') && i.detail === 'Table'
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
            (i: any) => i.detail === 'Table'
        );
        assert.ok(tableItem, 'Should find a table item');
        assert.ok(tableItem.label.includes('$(table)'), 'Table should use table icon');

        const viewItem = mockQuickPick.items.find(
            (i: any) => i.detail === 'View'
        );
        assert.ok(viewItem, 'Should find a view item');
        assert.ok(viewItem.label.includes('$(eye)'), 'View should use eye icon');

        const colItem = mockQuickPick.items.find(
            (i: any) => i.detail === 'Column'
        );
        assert.ok(colItem, 'Should find a column item');
        assert.ok(colItem.label.includes('$(symbol-field)'), 'Column should use symbol-field icon');
    });
});
