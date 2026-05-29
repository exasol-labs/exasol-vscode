import * as assert from 'assert';
import * as path from 'path';
import { registerVscodeMock, vscodeMock } from '../helpers/vscodeMock';

registerVscodeMock();

// localCsvImport captures the `vscode` namespace at require time, and tsx's CJS
// interop only live-binds NESTED property mutations on the captured window/
// workspace objects, not full reassignments. Because other test files share the
// singleton vscodeMock and reassign window/workspace, we install fresh stable
// objects in setup() and re-require the module so it re-captures them; per-test
// helpers then mutate those same objects' nested fields.
let resolveImportPath: (filePath: string) => string;

function setActiveEditor(fsPath: string | undefined, scheme = 'file'): void {
    (vscodeMock as any).window.activeTextEditor = fsPath
        ? { document: { uri: { scheme, fsPath } } }
        : undefined;
}

function setWorkspaceFolder(fsPath: string | undefined): void {
    (vscodeMock as any).workspace.workspaceFolders = fsPath
        ? [{ uri: { fsPath } }]
        : undefined;
}

suite('resolveImportPath', () => {
    setup(() => {
        (vscodeMock as any).window = { activeTextEditor: undefined };
        (vscodeMock as any).workspace = { workspaceFolders: undefined };
        // Re-require so localCsvImport re-captures the freshly installed objects.
        delete require.cache[require.resolve('../../localCsvImport')];
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        resolveImportPath = require('../../localCsvImport').resolveImportPath;
    });

    test('returns an absolute path unchanged', () => {
        setActiveEditor('/home/user/queries/run.sql');
        setWorkspaceFolder('/home/user/project');
        const abs = path.resolve('/abs/data/in.csv');
        assert.strictEqual(resolveImportPath(abs), abs);
    });

    test('resolves a relative path against the active file-scheme editor dir', () => {
        setActiveEditor('/home/user/queries/run.sql');
        setWorkspaceFolder('/home/user/project');
        assert.strictEqual(
            resolveImportPath('data/in.csv'),
            path.resolve('/home/user/queries', 'data/in.csv')
        );
    });

    test('falls back to the workspace folder when the editor is not file-scheme', () => {
        setActiveEditor('/virtual/notebook', 'untitled');
        setWorkspaceFolder('/home/user/project');
        assert.strictEqual(
            resolveImportPath('data/in.csv'),
            path.resolve('/home/user/project', 'data/in.csv')
        );
    });

    test('resolves against the workspace folder when no active editor', () => {
        setActiveEditor(undefined);
        setWorkspaceFolder('/home/user/project');
        assert.strictEqual(
            resolveImportPath('data/in.csv'),
            path.resolve('/home/user/project', 'data/in.csv')
        );
    });

    test('throws when neither an active file editor nor a workspace folder is available', () => {
        setActiveEditor(undefined);
        setWorkspaceFolder(undefined);
        assert.throws(() => resolveImportPath('data/in.csv'), /Relative import path/);
    });
});
