/**
 * Test configuration for Exasol extension
 * Uses local Exasol instance at localhost with sys:exasol credentials
 */

export const TEST_CONFIG = {
    connection: {
        name: 'Test Connection',
        host: 'localhost:8563',
        user: 'sys',
        password: 'exasol'
    },
    testSchema: 'TEST_SCHEMA',
    testTable: 'TEST_TABLE',
    testView: 'TEST_VIEW',
    timeout: 30000 // 30 seconds for queries
};
