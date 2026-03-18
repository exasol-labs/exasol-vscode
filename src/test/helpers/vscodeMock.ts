class MockTreeItem {
    label: string;
    collapsibleState: number;
    id?: string;
    description?: string;
    iconPath?: any;
    contextValue?: string;
    tooltip?: string;
    command?: any;

    constructor(label: string, collapsibleState: number = 0) {
        this.label = label;
        this.collapsibleState = collapsibleState;
    }
}

class MockThemeIcon {
    id: string;
    constructor(id: string) {
        this.id = id;
    }
}

class MockEventEmitter {
    private listeners: Array<(...args: any[]) => void> = [];
    event = (listener: (...args: any[]) => void) => {
        this.listeners.push(listener);
        return { dispose: () => {} };
    };
    fire(...args: any[]) {
        for (const fn of this.listeners) { fn(...args); }
    }
}

export const vscodeMock = {
    TreeItem: MockTreeItem,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: MockThemeIcon,
    EventEmitter: MockEventEmitter,
    workspace: {
        getConfiguration() {
            return { get: () => undefined };
        }
    },
    DataTransferItem: class {},
    DataTransfer: class {},
    Uri: { parse: (s: string) => s },
};

export function registerVscodeMock(): void {
    const NodeModule = require('module');
    const originalResolveFilename = NodeModule._resolveFilename;
    NodeModule._resolveFilename = function (request: string, ...args: any[]) {
        if (request === 'vscode') {
            return 'vscode';
        }
        return originalResolveFilename.call(this, request, ...args);
    };
    require.cache['vscode'] = {
        id: 'vscode',
        filename: 'vscode',
        loaded: true,
        exports: vscodeMock,
        paths: [],
        children: [],
        path: '',
        require: require,
        isPreloading: false,
    } as any;
}

export function registerExtensionMock(): void {
    const path = require('path');
    const extensionMock = {
        getOutputChannel: () => ({
            appendLine: () => {},
            show: () => {}
        })
    };
    delete require.cache[require.resolve('../../extension')];
    const extensionResolvedPath = require.resolve('../../extension');
    require.cache[extensionResolvedPath] = {
        id: extensionResolvedPath,
        filename: extensionResolvedPath,
        loaded: true,
        exports: extensionMock,
        paths: [],
        children: [],
        path: path.dirname(extensionResolvedPath),
        require: require,
        isPreloading: false,
    } as any;
}
