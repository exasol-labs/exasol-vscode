import * as assert from 'assert';
import { registerVscodeMock, registerExtensionMock } from '../helpers/vscodeMock';
import { SqlError } from '../../utils';

registerVscodeMock();
registerExtensionMock();

const { isConnectionError } = require('../../connectionManager') as typeof import('../../connectionManager');

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
