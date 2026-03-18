import * as assert from 'assert';
import { ObjectTreeItemType, getNodeTypeConfig } from '../../providers/objectTreeTypes';

suite('ObjectTreeItemType and getNodeTypeConfig', () => {

    suite('existing node types', () => {
        test('schema returns symbol-namespace icon', () => {
            const config = getNodeTypeConfig('schema');
            assert.ok(config);
            assert.strictEqual(config.icon, 'symbol-namespace');
            assert.strictEqual(config.contextValue, 'schema');
        });

        test('tables-folder returns folder icon', () => {
            const config = getNodeTypeConfig('tables-folder');
            assert.ok(config);
            assert.strictEqual(config.icon, 'folder');
            assert.strictEqual(config.contextValue, 'tables-folder');
        });

        test('table returns table icon', () => {
            const config = getNodeTypeConfig('table');
            assert.ok(config);
            assert.strictEqual(config.icon, 'table');
            assert.strictEqual(config.contextValue, 'table');
        });

        test('views-folder returns folder icon', () => {
            const config = getNodeTypeConfig('views-folder');
            assert.ok(config);
            assert.strictEqual(config.icon, 'folder');
            assert.strictEqual(config.contextValue, 'views-folder');
        });

        test('view returns eye icon', () => {
            const config = getNodeTypeConfig('view');
            assert.ok(config);
            assert.strictEqual(config.icon, 'eye');
            assert.strictEqual(config.contextValue, 'view');
        });

        test('column returns symbol-field icon', () => {
            const config = getNodeTypeConfig('column');
            assert.ok(config);
            assert.strictEqual(config.icon, 'symbol-field');
            assert.strictEqual(config.contextValue, 'column');
        });
    });

    suite('new node types', () => {
        test('virtual-schema returns remote icon', () => {
            const config = getNodeTypeConfig('virtual-schema');
            assert.ok(config, 'virtual-schema should return a config');
            assert.strictEqual(config.icon, 'remote');
            assert.strictEqual(config.contextValue, 'virtual-schema');
        });

        test('virtual-table returns table icon', () => {
            const config = getNodeTypeConfig('virtual-table');
            assert.ok(config, 'virtual-table should return a config');
            assert.strictEqual(config.icon, 'table');
            assert.strictEqual(config.contextValue, 'virtual-table');
        });

        test('udfs-folder returns folder icon', () => {
            const config = getNodeTypeConfig('udfs-folder');
            assert.ok(config, 'udfs-folder should return a config');
            assert.strictEqual(config.icon, 'folder');
            assert.strictEqual(config.contextValue, 'udfs-folder');
        });

        test('procedures-folder returns folder icon', () => {
            const config = getNodeTypeConfig('procedures-folder');
            assert.ok(config, 'procedures-folder should return a config');
            assert.strictEqual(config.icon, 'folder');
            assert.strictEqual(config.contextValue, 'procedures-folder');
        });

        test('adapters-folder returns folder icon', () => {
            const config = getNodeTypeConfig('adapters-folder');
            assert.ok(config, 'adapters-folder should return a config');
            assert.strictEqual(config.icon, 'folder');
            assert.strictEqual(config.contextValue, 'adapters-folder');
        });

        test('functions-folder returns folder icon', () => {
            const config = getNodeTypeConfig('functions-folder');
            assert.ok(config, 'functions-folder should return a config');
            assert.strictEqual(config.icon, 'folder');
            assert.strictEqual(config.contextValue, 'functions-folder');
        });

        test('script with UDF type returns symbol-method icon', () => {
            const config = getNodeTypeConfig('script', { scriptType: 'UDF' });
            assert.ok(config, 'script (UDF) should return a config');
            assert.strictEqual(config.icon, 'symbol-method');
            assert.strictEqual(config.contextValue, 'script');
        });

        test('script with SCRIPTING type returns symbol-event icon', () => {
            const config = getNodeTypeConfig('script', { scriptType: 'SCRIPTING' });
            assert.ok(config, 'script (SCRIPTING) should return a config');
            assert.strictEqual(config.icon, 'symbol-event');
            assert.strictEqual(config.contextValue, 'script');
        });

        test('script with ADAPTER type returns extensions icon', () => {
            const config = getNodeTypeConfig('script', { scriptType: 'ADAPTER' });
            assert.ok(config, 'script (ADAPTER) should return a config');
            assert.strictEqual(config.icon, 'extensions');
            assert.strictEqual(config.contextValue, 'script');
        });

        test('script with no type defaults to symbol-method icon', () => {
            const config = getNodeTypeConfig('script');
            assert.ok(config, 'script (default) should return a config');
            assert.strictEqual(config.icon, 'symbol-method');
            assert.strictEqual(config.contextValue, 'script');
        });

        test('function returns symbol-function icon', () => {
            const config = getNodeTypeConfig('function');
            assert.ok(config, 'function should return a config');
            assert.strictEqual(config.icon, 'symbol-function');
            assert.strictEqual(config.contextValue, 'function');
        });

        test('constraints-folder returns folder icon', () => {
            const config = getNodeTypeConfig('constraints-folder');
            assert.ok(config, 'constraints-folder should return a config');
            assert.strictEqual(config.icon, 'folder');
            assert.strictEqual(config.contextValue, 'constraints-folder');
        });

        test('indices-folder returns folder icon', () => {
            const config = getNodeTypeConfig('indices-folder');
            assert.ok(config, 'indices-folder should return a config');
            assert.strictEqual(config.icon, 'folder');
            assert.strictEqual(config.contextValue, 'indices-folder');
        });

        test('constraint with PRIMARY KEY type returns key icon', () => {
            const config = getNodeTypeConfig('constraint', { constraintType: 'PRIMARY KEY' });
            assert.ok(config, 'constraint (PK) should return a config');
            assert.strictEqual(config.icon, 'key');
            assert.strictEqual(config.contextValue, 'constraint');
        });

        test('constraint with FOREIGN KEY type returns link icon', () => {
            const config = getNodeTypeConfig('constraint', { constraintType: 'FOREIGN KEY' });
            assert.ok(config, 'constraint (FK) should return a config');
            assert.strictEqual(config.icon, 'link');
            assert.strictEqual(config.contextValue, 'constraint');
        });

        test('constraint with other type returns key icon', () => {
            const config = getNodeTypeConfig('constraint', { constraintType: 'NOT NULL' });
            assert.ok(config, 'constraint (other) should return a config');
            assert.strictEqual(config.icon, 'key');
            assert.strictEqual(config.contextValue, 'constraint');
        });

        test('constraint with no type defaults to key icon', () => {
            const config = getNodeTypeConfig('constraint');
            assert.ok(config, 'constraint (default) should return a config');
            assert.strictEqual(config.icon, 'key');
            assert.strictEqual(config.contextValue, 'constraint');
        });

        test('index returns list-tree icon', () => {
            const config = getNodeTypeConfig('index');
            assert.ok(config, 'index should return a config');
            assert.strictEqual(config.icon, 'list-tree');
            assert.strictEqual(config.contextValue, 'index');
        });

        test('system-schemas-folder returns library icon', () => {
            const config = getNodeTypeConfig('system-schemas-folder');
            assert.ok(config, 'system-schemas-folder should return a config');
            assert.strictEqual(config.icon, 'library');
            assert.strictEqual(config.contextValue, 'system-schemas-folder');
        });

        test('system-schema returns database icon', () => {
            const config = getNodeTypeConfig('system-schema');
            assert.ok(config, 'system-schema should return a config');
            assert.strictEqual(config.icon, 'database');
            assert.strictEqual(config.contextValue, 'system-schema');
        });

        test('system-table returns table icon', () => {
            const config = getNodeTypeConfig('system-table');
            assert.ok(config, 'system-table should return a config');
            assert.strictEqual(config.icon, 'table');
            assert.strictEqual(config.contextValue, 'system-table');
        });
    });

    suite('type safety', () => {
        test('all new types are valid ObjectTreeItemType values', () => {
            const allTypes: ObjectTreeItemType[] = [
                'schema', 'tables-folder', 'table', 'views-folder', 'view', 'column',
                'virtual-schema', 'virtual-table',
                'udfs-folder', 'procedures-folder', 'adapters-folder', 'functions-folder',
                'script', 'function',
                'constraints-folder', 'indices-folder', 'constraint', 'index',
                'system-schemas-folder', 'system-schema', 'system-table'
            ];
            for (const type of allTypes) {
                const config = getNodeTypeConfig(type);
                assert.ok(config, `${type} should return a valid config`);
                assert.ok(config.icon, `${type} should have an icon`);
                assert.ok(config.contextValue, `${type} should have a contextValue`);
            }
        });
    });
});
