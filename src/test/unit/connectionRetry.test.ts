import * as assert from 'assert';
import { registerVscodeMock, registerExtensionMock } from '../helpers/vscodeMock';
import { SqlError } from '../../utils';
import type { ConnectionManager as ConnectionManagerType } from '../../connectionManager';

registerVscodeMock();
registerExtensionMock();

const { isConnectionError } = require('../../connectionManager') as typeof import('../../connectionManager');
const { ConnectionManager } = require('../../connectionManager') as typeof import('../../connectionManager');

suite('isConnectionError', () => {
    test('recognizes official driver transport errors', () => {
        for (const code of ['E-EDJS-2', 'E-EDJS-8', 'E-EDJS-16', 'E-EDJS-19', 'E-EDJS-36']) {
            assert.strictEqual(isConnectionError(new Error(`${code}: transport failure`)), true, code);
        }
    });

    test('does not classify arbitrary timeout text as a connection error', () => {
        assert.strictEqual(isConnectionError(new SqlError('22003', 'Query timeout exceeded')), false);
        assert.strictEqual(isConnectionError(new Error('SQL Error [22003]: operation timeout')), false);
    });

    test('still recognizes network error names', () => {
        assert.strictEqual(isConnectionError(new Error('read ECONNRESET')), true);
        assert.strictEqual(isConnectionError(new Error('socket ETIMEDOUT')), true);
    });
});

suite('ConnectionManager.executeWithRetry', () => {
    test('retries when socket eviction happens before the command rejects', async () => {
        const manager = Object.create(ConnectionManager.prototype) as {
            activeConnection: string;
            drivers: Map<string, Map<'user', object>>;
            recentFailures: Map<string, Map<'user', { error: Error; timestamp: number }>>;
            lastSuccessfulQuery: Map<string, Map<'user', number>>;
            runExclusive: <T>(fn: () => Promise<T>, role?: 'user') => Promise<T>;
            executeWithRetry: ConnectionManagerType['executeWithRetry'];
        };
        manager.activeConnection = 'connection-1';
        manager.drivers = new Map([['connection-1', new Map([['user', {}]])]]);
        manager.recentFailures = new Map();
        manager.lastSuccessfulQuery = new Map();
        manager.runExclusive = async fn => fn();

        let attempts = 0;
        const result = await manager.executeWithRetry(async () => {
            attempts++;
            if (attempts === 1) {
                manager.drivers.get('connection-1')?.delete('user');
                throw new Error('E-EDJS-36: Socket closed');
            }
            return 'reconnected';
        });

        assert.strictEqual(result, 'reconnected');
        assert.strictEqual(attempts, 2);
    });
});
