import type * as vscode from 'vscode';

class MockTreeItem {
    label: string;
    collapsibleState: number;
    id?: string;
    description?: string;
    iconPath?: vscode.TreeItem['iconPath'];
    contextValue?: string;
    tooltip?: string;
    command?: vscode.Command;

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

class MockEventEmitter<T = unknown> {
    private listeners: Array<(arg: T) => void> = [];
    event = (listener: (arg: T) => void) => {
        this.listeners.push(listener);
        return { dispose: () => {} };
    };
    fire(arg: T) {
        for (const fn of this.listeners) { fn(arg); }
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

/**
 * vscodeMock only declares the handful of members objectTreeProvider.ts/etc need
 * (TreeItem, EventEmitter, ...); local test files that load modules reaching
 * further into the 'vscode' namespace (window, commands, workspace.fs, env,
 * CancellationTokenSource) grow the shared mock with those members at their own
 * module top-level, before calling registerVscodeMock(). This is the common
 * base shape for that extension: fields exercised by only *some* callers are
 * optional here, so no single caller is forced to declare members it never
 * assigns. vscodeMock's own declared type has none of these members, so
 * casting through `unknown` to this type (or one of the narrower types below)
 * is how a caller enables them, rather than reproducing the whole shared
 * mock's type at each call site.
 */
export interface ExtendedVscodeMock {
    Uri: { parse: (s: string) => string; joinPath: () => Record<string, never> };
    window: {
        registerWebviewViewProvider: () => { dispose: () => void };
        showInformationMessage: (msg: string) => void;
        showWarningMessage: () => void;
        showErrorMessage?: () => void;
        showSaveDialog?: () => Promise<undefined>;
    };
    commands: {
        registerCommand: () => { dispose: () => void };
        executeCommand?: () => void;
    };
    workspace: {
        getConfiguration: () => { get: () => undefined };
        fs?: { writeFile: () => Promise<void> };
    };
    env: { clipboard: { writeText: (text: string) => Promise<void> } };
    CancellationTokenSource?: new () => object;
}

/**
 * The ExtendedVscodeMock members resultsPanelPlanTab.test.ts's ResultsPanel
 * module actually calls, narrowed from the optional base above so that
 * omitting one of them is a compile error again.
 */
export type ResultsPanelVscodeMock = ExtendedVscodeMock & {
    window: Required<Pick<ExtendedVscodeMock['window'],
        'registerWebviewViewProvider' | 'showInformationMessage' | 'showWarningMessage' | 'showErrorMessage'>>;
    commands: Required<Pick<ExtendedVscodeMock['commands'], 'registerCommand'>>;
    workspace: Required<Pick<ExtendedVscodeMock['workspace'], 'getConfiguration'>>;
};

/**
 * The ExtendedVscodeMock members webviewRendering.test.ts's ResultsPanel/
 * tabBarRenderer/tabManager modules actually call, narrowed the same way.
 */
export type WebviewRenderingVscodeMock = ExtendedVscodeMock & {
    window: Required<Pick<ExtendedVscodeMock['window'],
        'registerWebviewViewProvider' | 'showSaveDialog' | 'showInformationMessage' | 'showWarningMessage'>>;
    commands: Required<Pick<ExtendedVscodeMock['commands'], 'registerCommand' | 'executeCommand'>>;
    workspace: Required<Pick<ExtendedVscodeMock['workspace'], 'getConfiguration' | 'fs'>>;
    CancellationTokenSource: NonNullable<ExtendedVscodeMock['CancellationTokenSource']>;
};

export function registerVscodeMock(): void {
    const NodeModule = require('module');
    const originalResolveFilename = NodeModule._resolveFilename;
    NodeModule._resolveFilename = function (request: string, ...args: unknown[]) {
        if (request === 'vscode') {
            return 'vscode';
        }
        return originalResolveFilename.call(this, request, ...args);
    };
    // require.cache stores real NodeJS.Module instances (private-ish internal shape);
    // this stub only needs to satisfy `require('vscode')`, so it's cast rather than
    // reproducing every Module field (parent, require(), etc.) a real module carries.
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
    } as unknown as NodeJS.Module;
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
    // Same rationale as registerVscodeMock: a minimal require.cache stand-in, cast to
    // NodeJS.Module rather than reproducing its full internal shape.
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
    } as unknown as NodeJS.Module;
}
