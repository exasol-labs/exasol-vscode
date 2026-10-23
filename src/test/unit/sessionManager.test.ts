import * as assert from 'assert';
import type * as vscode from 'vscode';
import type { ConnectionManager } from '../../connectionManager';
import { registerVscodeMock, registerExtensionMock, vscodeMock } from '../helpers/vscodeMock';
import { createEmptyRawResult, createRawErrorResult, MockConnectionManager } from '../helpers/mockConnectionManager';

interface SessionVscodeMock {
    window: { showInformationMessage: (msg: string) => Promise<undefined> };
}
const extendedMock = vscodeMock as unknown as SessionVscodeMock;
const infoMessages: string[] = [];
if (!('window' in vscodeMock)) {
    extendedMock.window = { showInformationMessage: () => Promise.resolve(undefined) };
}

registerVscodeMock();
registerExtensionMock();

const { SessionManager } = require('../../sessionManager') as typeof import('../../sessionManager');

function makeContext(): vscode.ExtensionContext {
    const state = new Map<string, unknown>();
    return {
        workspaceState: {
            get: (key: string) => state.get(key),
            update: async (key: string, value: unknown) => { state.set(key, value); }
        }
    } as unknown as vscode.ExtensionContext;
}

suite('SessionManager.setSchema', () => {
    let savedWindow: SessionVscodeMock['window'];

    setup(() => {
        infoMessages.length = 0;
        savedWindow = extendedMock.window;
        extendedMock.window = {
            showInformationMessage: (msg: string) => { infoMessages.push(msg); return Promise.resolve(undefined); }
        };
    });

    teardown(() => {
        extendedMock.window = savedWindow;
    });

    test('a failed OPEN SCHEMA rejects with the database error and keeps the schema unset', async () => {
        const queries: string[] = [];
        const manager = new MockConnectionManager({
            query: async (sql: string) => {
                queries.push(sql);
                return createRawErrorResult('42000', 'schema NO_SUCH not found');
            }
        });
        const session = new SessionManager(manager as unknown as ConnectionManager, makeContext());

        await assert.rejects(session.setSchema('NO_SUCH'), {
            message: 'Failed to set schema: SQL Error [42000]: schema NO_SUCH not found'
        });

        assert.strictEqual(session.getCurrentSchema(), undefined);
        assert.deepStrictEqual(infoMessages, []);
        assert.deepStrictEqual(queries, ['OPEN SCHEMA "NO_SUCH"', 'OPEN SCHEMA "NO_SUCH"']);
    });

    test('quotes the schema name on both connections', async () => {
        const queries: string[] = [];
        const manager = new MockConnectionManager({
            query: async (sql: string) => { queries.push(sql); return createEmptyRawResult([]); }
        });
        const session = new SessionManager(manager as unknown as ConnectionManager, makeContext());

        await session.setSchema('my "odd" schema');

        assert.deepStrictEqual(queries, ['OPEN SCHEMA "my ""odd"" schema"', 'OPEN SCHEMA "my ""odd"" schema"']);
        assert.strictEqual(session.getCurrentSchema(), 'my "odd" schema');
        assert.deepStrictEqual(infoMessages, ['Schema set to: my "odd" schema']);
    });
});
