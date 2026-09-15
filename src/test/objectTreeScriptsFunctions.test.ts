import * as assert from 'assert';
import * as vscode from 'vscode';
import { ObjectTreeItem, ObjectTreeProvider } from '../providers/objectTreeProvider';
import { fetchScriptCounts, fetchFunctionCount, fetchScripts, fetchFunctions } from '../providers/objectTreeFetchers';
import {
    TEST_CONNECTION,
    createRawResult,
    createEmptyRawResult,
    MockConnectionManager,
    asConnectionManager
} from './helpers/mockConnectionManager';

const connection = TEST_CONNECTION;

suite('ObjectTreeProvider Scripts & Functions', () => {

    suite('fetchScriptCounts', () => {
        test('returns counts grouped by script type', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('EXA_ALL_SCRIPTS') && sql.includes('GROUP BY')) {
                        return createRawResult(
                            ['SCRIPT_TYPE', 'SCRIPT_COUNT'],
                            [
                                ['UDF', 5],
                                ['SCRIPTING', 2],
                                ['ADAPTER', 1]
                            ]
                        );
                    }
                    throw new Error('Unexpected query');
                }
            };

            const manager = new MockConnectionManager(driver);

            const counts = await fetchScriptCounts(asConnectionManager(manager), connection, 'MY_SCHEMA');

            assert.strictEqual(counts.get('UDF'), 5);
            assert.strictEqual(counts.get('SCRIPTING'), 2);
            assert.strictEqual(counts.get('ADAPTER'), 1);
        });

        test('returns empty map on query failure', async () => {
            const driver = {
                async query() { throw new Error('Access denied'); }
            };

            const manager = new MockConnectionManager(driver);

            const counts = await fetchScriptCounts(asConnectionManager(manager), connection, 'MY_SCHEMA');

            assert.strictEqual(counts.size, 0);
        });

        test('skips types with zero count', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('EXA_ALL_SCRIPTS') && sql.includes('GROUP BY')) {
                        return createRawResult(
                            ['SCRIPT_TYPE', 'SCRIPT_COUNT'],
                            [
                                ['UDF', 3],
                                ['SCRIPTING', 0]
                            ]
                        );
                    }
                    throw new Error('Unexpected query');
                }
            };

            const manager = new MockConnectionManager(driver);

            const counts = await fetchScriptCounts(asConnectionManager(manager), connection, 'MY_SCHEMA');

            assert.strictEqual(counts.get('UDF'), 3);
            assert.ok(!counts.has('SCRIPTING'), 'Zero-count types should not be in map');
        });
    });

    suite('fetchFunctionCount', () => {
        test('returns function count for a schema', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('EXA_ALL_FUNCTIONS') && sql.includes('COUNT')) {
                        return createRawResult(
                            ['FUNCTION_COUNT'],
                            [[7]]
                        );
                    }
                    throw new Error('Unexpected query');
                }
            };

            const manager = new MockConnectionManager(driver);

            const count = await fetchFunctionCount(asConnectionManager(manager), connection, 'MY_SCHEMA');

            assert.strictEqual(count, 7);
        });

        test('returns 0 on query failure', async () => {
            const driver = {
                async query() { throw new Error('Access denied'); }
            };

            const manager = new MockConnectionManager(driver);

            const count = await fetchFunctionCount(asConnectionManager(manager), connection, 'MY_SCHEMA');

            assert.strictEqual(count, 0);
        });
    });

    suite('fetchScripts', () => {
        test('returns UDF scripts with language and input type', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('EXA_ALL_SCRIPTS') && sql.includes("'UDF'")) {
                        return createRawResult(
                            ['SCRIPT_NAME', 'SCRIPT_LANGUAGE', 'SCRIPT_INPUT_TYPE', 'SCRIPT_TYPE'],
                            [
                                ['MY_UDF', 'PYTHON3', 'SET', 'UDF'],
                                ['ANOTHER_UDF', 'JAVA', 'SCALAR', 'UDF']
                            ]
                        );
                    }
                    throw new Error('Unexpected query');
                }
            };

            const manager = new MockConnectionManager(driver);

            const scripts = await fetchScripts(asConnectionManager(manager), connection, 'MY_SCHEMA', 'UDF');

            assert.strictEqual(scripts.length, 2);
            assert.strictEqual(scripts[0].name, 'MY_UDF');
            assert.strictEqual(scripts[0].language, 'PYTHON3');
            assert.strictEqual(scripts[0].inputType, 'SET');
            assert.strictEqual(scripts[0].scriptType, 'UDF');
            assert.strictEqual(scripts[1].name, 'ANOTHER_UDF');
            assert.strictEqual(scripts[1].inputType, 'SCALAR');
        });

        test('returns procedure scripts', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('EXA_ALL_SCRIPTS') && sql.includes("'SCRIPTING'")) {
                        return createRawResult(
                            ['SCRIPT_NAME', 'SCRIPT_LANGUAGE', 'SCRIPT_INPUT_TYPE', 'SCRIPT_TYPE'],
                            [
                                ['MY_PROC', 'LUA', null, 'SCRIPTING']
                            ]
                        );
                    }
                    throw new Error('Unexpected query');
                }
            };

            const manager = new MockConnectionManager(driver);

            const scripts = await fetchScripts(asConnectionManager(manager), connection, 'MY_SCHEMA', 'SCRIPTING');

            assert.strictEqual(scripts.length, 1);
            assert.strictEqual(scripts[0].name, 'MY_PROC');
            assert.strictEqual(scripts[0].language, 'LUA');
            assert.strictEqual(scripts[0].inputType, null);
            assert.strictEqual(scripts[0].scriptType, 'SCRIPTING');
        });

        test('returns adapter scripts', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('EXA_ALL_SCRIPTS') && sql.includes("'ADAPTER'")) {
                        return createRawResult(
                            ['SCRIPT_NAME', 'SCRIPT_LANGUAGE', 'SCRIPT_INPUT_TYPE', 'SCRIPT_TYPE'],
                            [
                                ['S3_ADAPTER', 'JAVA', null, 'ADAPTER']
                            ]
                        );
                    }
                    throw new Error('Unexpected query');
                }
            };

            const manager = new MockConnectionManager(driver);

            const scripts = await fetchScripts(asConnectionManager(manager), connection, 'MY_SCHEMA', 'ADAPTER');

            assert.strictEqual(scripts.length, 1);
            assert.strictEqual(scripts[0].name, 'S3_ADAPTER');
            assert.strictEqual(scripts[0].scriptType, 'ADAPTER');
        });

        test('returns empty array on query failure', async () => {
            const driver = {
                async query() { throw new Error('Connection failed'); }
            };

            const manager = new MockConnectionManager(driver);

            const scripts = await fetchScripts(asConnectionManager(manager), connection, 'MY_SCHEMA', 'UDF');
            assert.deepStrictEqual(scripts, []);
        });
    });

    suite('fetchFunctions', () => {
        test('returns function names for a schema', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('EXA_ALL_FUNCTIONS') && !sql.includes('COUNT')) {
                        return createRawResult(
                            ['FUNCTION_NAME'],
                            [
                                ['MY_FUNC'],
                                ['ANOTHER_FUNC']
                            ]
                        );
                    }
                    throw new Error('Unexpected query');
                }
            };

            const manager = new MockConnectionManager(driver);

            const functions = await fetchFunctions(asConnectionManager(manager), connection, 'MY_SCHEMA');

            assert.strictEqual(functions.length, 2);
            assert.strictEqual(functions[0].name, 'MY_FUNC');
            assert.strictEqual(functions[1].name, 'ANOTHER_FUNC');
        });

        test('returns empty array on query failure', async () => {
            const driver = {
                async query() { throw new Error('Connection failed'); }
            };

            const manager = new MockConnectionManager(driver);

            const functions = await fetchFunctions(asConnectionManager(manager), connection, 'MY_SCHEMA');
            assert.deepStrictEqual(functions, []);
        });
    });

    suite('schema node expansion with script and function folders', () => {
        test('includes UDFs, Procedures, and Functions folders when counts are non-zero', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('EXA_ALL_SCRIPTS') && sql.includes('GROUP BY')) {
                        return createRawResult(
                            ['SCRIPT_TYPE', 'SCRIPT_COUNT'],
                            [
                                ['UDF', 3],
                                ['SCRIPTING', 2]
                            ]
                        );
                    }
                    if (sql.includes('EXA_ALL_FUNCTIONS') && sql.includes('COUNT')) {
                        return createRawResult(['FUNCTION_COUNT'], [[4]]);
                    }
                    throw new Error(`Unexpected query: ${sql}`);
                }
            };

            const manager = new MockConnectionManager(driver);
            const provider = new ObjectTreeProvider(asConnectionManager(manager));

            const schemaElement = new ObjectTreeItem({
                type: 'schema',
                connection,
                schemaName: 'MY_SCHEMA',
                label: 'MY_SCHEMA',
                id: 'conn-1:MY_SCHEMA',
                tableCount: 5,
                viewCount: 2,
                collapsibleState: vscode.TreeItemCollapsibleState.Collapsed
            });

            const children = await provider.getChildren(schemaElement);
            const labels = children.map(c => c.label);

            assert.ok(labels.includes('Tables'), 'Should have Tables folder');
            assert.ok(labels.includes('Views'), 'Should have Views folder');
            assert.ok(labels.includes('UDFs'), 'Should have UDFs folder');
            assert.ok(labels.includes('Procedures'), 'Should have Procedures folder');
            assert.ok(labels.includes('Functions'), 'Should have Functions folder');
            assert.ok(!labels.includes('Adapters'), 'Should NOT have Adapters folder (zero count)');
        });

        test('omits all script and function folders when counts are zero', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('EXA_ALL_SCRIPTS') && sql.includes('GROUP BY')) {
                        return createEmptyRawResult(['SCRIPT_TYPE', 'SCRIPT_COUNT']);
                    }
                    if (sql.includes('EXA_ALL_FUNCTIONS') && sql.includes('COUNT')) {
                        return createRawResult(['FUNCTION_COUNT'], [[0]]);
                    }
                    throw new Error(`Unexpected query: ${sql}`);
                }
            };

            const manager = new MockConnectionManager(driver);
            const provider = new ObjectTreeProvider(asConnectionManager(manager));

            const schemaElement = new ObjectTreeItem({
                type: 'schema',
                connection,
                schemaName: 'MY_SCHEMA',
                label: 'MY_SCHEMA',
                id: 'conn-1:MY_SCHEMA',
                tableCount: 5,
                viewCount: 2,
                collapsibleState: vscode.TreeItemCollapsibleState.Collapsed
            });

            const children = await provider.getChildren(schemaElement);
            const labels = children.map(c => c.label);

            assert.ok(labels.includes('Tables'), 'Should always have Tables folder');
            assert.ok(labels.includes('Views'), 'Should always have Views folder');
            assert.ok(!labels.includes('UDFs'), 'Should NOT have UDFs folder');
            assert.ok(!labels.includes('Procedures'), 'Should NOT have Procedures folder');
            assert.ok(!labels.includes('Adapters'), 'Should NOT have Adapters folder');
            assert.ok(!labels.includes('Functions'), 'Should NOT have Functions folder');
        });

        test('still shows Tables and Views when script count query fails', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('EXA_ALL_SCRIPTS')) {
                        throw new Error('Access denied');
                    }
                    if (sql.includes('EXA_ALL_FUNCTIONS')) {
                        throw new Error('Access denied');
                    }
                    throw new Error(`Unexpected query: ${sql}`);
                }
            };

            const manager = new MockConnectionManager(driver);
            const provider = new ObjectTreeProvider(asConnectionManager(manager));

            const schemaElement = new ObjectTreeItem({
                type: 'schema',
                connection,
                schemaName: 'MY_SCHEMA',
                label: 'MY_SCHEMA',
                id: 'conn-1:MY_SCHEMA',
                tableCount: 5,
                viewCount: 2,
                collapsibleState: vscode.TreeItemCollapsibleState.Collapsed
            });

            const children = await provider.getChildren(schemaElement);
            const labels = children.map(c => c.label);

            assert.ok(labels.includes('Tables'), 'Tables folder should still exist');
            assert.ok(labels.includes('Views'), 'Views folder should still exist');
            assert.strictEqual(children.length, 2, 'Only Tables and Views when script/function queries fail');
        });
    });

    suite('UDFs folder expansion', () => {
        test('expands UDFs folder to show script nodes', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('EXA_ALL_SCRIPTS') && sql.includes("'UDF'")) {
                        return createRawResult(
                            ['SCRIPT_NAME', 'SCRIPT_LANGUAGE', 'SCRIPT_INPUT_TYPE', 'SCRIPT_TYPE'],
                            [
                                ['MY_UDF', 'PYTHON3', 'SET', 'UDF'],
                                ['SCALAR_UDF', 'JAVA', 'SCALAR', 'UDF']
                            ]
                        );
                    }
                    throw new Error('Unexpected query');
                }
            };

            const manager = new MockConnectionManager(driver);
            const provider = new ObjectTreeProvider(asConnectionManager(manager));

            const udfsFolderElement = new ObjectTreeItem({
                type: 'udfs-folder',
                connection,
                schemaName: 'MY_SCHEMA',
                label: 'UDFs',
                id: 'conn-1:MY_SCHEMA:udfs-folder',
                collapsibleState: vscode.TreeItemCollapsibleState.Collapsed
            });

            const children = await provider.getChildren(udfsFolderElement);

            assert.strictEqual(children.length, 2);
            assert.strictEqual(children[0].label, 'MY_UDF');
            assert.strictEqual((children[0] as ObjectTreeItem).type, 'script');
            assert.strictEqual(children[1].label, 'SCALAR_UDF');
            assert.strictEqual((children[1] as ObjectTreeItem).type, 'script');
        });
    });

    suite('Procedures folder expansion', () => {
        test('expands procedures folder to show procedure script nodes', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('EXA_ALL_SCRIPTS') && sql.includes("'SCRIPTING'")) {
                        return createRawResult(
                            ['SCRIPT_NAME', 'SCRIPT_LANGUAGE', 'SCRIPT_INPUT_TYPE', 'SCRIPT_TYPE'],
                            [
                                ['MY_PROC', 'LUA', null, 'SCRIPTING']
                            ]
                        );
                    }
                    throw new Error('Unexpected query');
                }
            };

            const manager = new MockConnectionManager(driver);
            const provider = new ObjectTreeProvider(asConnectionManager(manager));

            const procsFolderElement = new ObjectTreeItem({
                type: 'procedures-folder',
                connection,
                schemaName: 'MY_SCHEMA',
                label: 'Procedures',
                id: 'conn-1:MY_SCHEMA:procedures-folder',
                collapsibleState: vscode.TreeItemCollapsibleState.Collapsed
            });

            const children = await provider.getChildren(procsFolderElement);

            assert.strictEqual(children.length, 1);
            assert.strictEqual(children[0].label, 'MY_PROC');
            assert.strictEqual((children[0] as ObjectTreeItem).type, 'script');
        });
    });

    suite('Adapters folder expansion', () => {
        test('expands adapters folder to show adapter script nodes', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('EXA_ALL_SCRIPTS') && sql.includes("'ADAPTER'")) {
                        return createRawResult(
                            ['SCRIPT_NAME', 'SCRIPT_LANGUAGE', 'SCRIPT_INPUT_TYPE', 'SCRIPT_TYPE'],
                            [
                                ['S3_ADAPTER', 'JAVA', null, 'ADAPTER']
                            ]
                        );
                    }
                    throw new Error('Unexpected query');
                }
            };

            const manager = new MockConnectionManager(driver);
            const provider = new ObjectTreeProvider(asConnectionManager(manager));

            const adaptersFolderElement = new ObjectTreeItem({
                type: 'adapters-folder',
                connection,
                schemaName: 'MY_SCHEMA',
                label: 'Adapters',
                id: 'conn-1:MY_SCHEMA:adapters-folder',
                collapsibleState: vscode.TreeItemCollapsibleState.Collapsed
            });

            const children = await provider.getChildren(adaptersFolderElement);

            assert.strictEqual(children.length, 1);
            assert.strictEqual(children[0].label, 'S3_ADAPTER');
            assert.strictEqual((children[0] as ObjectTreeItem).type, 'script');
        });
    });

    suite('Functions folder expansion', () => {
        test('expands functions folder to show function nodes', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('EXA_ALL_FUNCTIONS') && !sql.includes('COUNT')) {
                        return createRawResult(
                            ['FUNCTION_NAME'],
                            [
                                ['MY_FUNC'],
                                ['ANOTHER_FUNC']
                            ]
                        );
                    }
                    throw new Error('Unexpected query');
                }
            };

            const manager = new MockConnectionManager(driver);
            const provider = new ObjectTreeProvider(asConnectionManager(manager));

            const functionsFolderElement = new ObjectTreeItem({
                type: 'functions-folder',
                connection,
                schemaName: 'MY_SCHEMA',
                label: 'Functions',
                id: 'conn-1:MY_SCHEMA:functions-folder',
                collapsibleState: vscode.TreeItemCollapsibleState.Collapsed
            });

            const children = await provider.getChildren(functionsFolderElement);

            assert.strictEqual(children.length, 2);
            assert.strictEqual(children[0].label, 'MY_FUNC');
            assert.strictEqual((children[0] as ObjectTreeItem).type, 'function');
            assert.strictEqual(children[1].label, 'ANOTHER_FUNC');
            assert.strictEqual((children[1] as ObjectTreeItem).type, 'function');
        });

        test('returns empty array when functions folder query fails', async () => {
            const driver = {
                async query() { throw new Error('Connection failed'); }
            };

            const manager = new MockConnectionManager(driver);
            const provider = new ObjectTreeProvider(asConnectionManager(manager));

            const functionsFolderElement = new ObjectTreeItem({
                type: 'functions-folder',
                connection,
                schemaName: 'MY_SCHEMA',
                label: 'Functions',
                id: 'conn-1:MY_SCHEMA:functions-folder',
                collapsibleState: vscode.TreeItemCollapsibleState.Collapsed
            });

            const children = await provider.getChildren(functionsFolderElement);

            assert.strictEqual(children.length, 0);
        });
    });

    suite('script node metadata', () => {
        test('UDF script node has language and input type as description', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('EXA_ALL_SCRIPTS') && sql.includes("'UDF'")) {
                        return createRawResult(
                            ['SCRIPT_NAME', 'SCRIPT_LANGUAGE', 'SCRIPT_INPUT_TYPE', 'SCRIPT_TYPE'],
                            [['MY_UDF', 'PYTHON3', 'SET', 'UDF']]
                        );
                    }
                    throw new Error('Unexpected query');
                }
            };

            const manager = new MockConnectionManager(driver);
            const provider = new ObjectTreeProvider(asConnectionManager(manager));

            const udfsFolderElement = new ObjectTreeItem({
                type: 'udfs-folder',
                connection,
                schemaName: 'MY_SCHEMA',
                label: 'UDFs',
                id: 'conn-1:MY_SCHEMA:udfs-folder',
                collapsibleState: vscode.TreeItemCollapsibleState.Collapsed
            });

            const children = await provider.getChildren(udfsFolderElement);
            const scriptNode = children[0] as ObjectTreeItem;

            assert.strictEqual(scriptNode.description, 'PYTHON3, SET');
        });

        test('procedure script node has only language as description', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('EXA_ALL_SCRIPTS') && sql.includes("'SCRIPTING'")) {
                        return createRawResult(
                            ['SCRIPT_NAME', 'SCRIPT_LANGUAGE', 'SCRIPT_INPUT_TYPE', 'SCRIPT_TYPE'],
                            [['MY_PROC', 'LUA', null, 'SCRIPTING']]
                        );
                    }
                    throw new Error('Unexpected query');
                }
            };

            const manager = new MockConnectionManager(driver);
            const provider = new ObjectTreeProvider(asConnectionManager(manager));

            const procsFolderElement = new ObjectTreeItem({
                type: 'procedures-folder',
                connection,
                schemaName: 'MY_SCHEMA',
                label: 'Procedures',
                id: 'conn-1:MY_SCHEMA:procedures-folder',
                collapsibleState: vscode.TreeItemCollapsibleState.Collapsed
            });

            const children = await provider.getChildren(procsFolderElement);
            const scriptNode = children[0] as ObjectTreeItem;

            assert.strictEqual(scriptNode.description, 'LUA');
        });

        test('script node has click command to open source', async () => {
            const driver = {
                async query(sql: string) {
                    if (sql.includes('EXA_ALL_SCRIPTS') && sql.includes("'UDF'")) {
                        return createRawResult(
                            ['SCRIPT_NAME', 'SCRIPT_LANGUAGE', 'SCRIPT_INPUT_TYPE', 'SCRIPT_TYPE'],
                            [['MY_UDF', 'PYTHON3', 'SET', 'UDF']]
                        );
                    }
                    throw new Error('Unexpected query');
                }
            };

            const manager = new MockConnectionManager(driver);
            const provider = new ObjectTreeProvider(asConnectionManager(manager));

            const udfsFolderElement = new ObjectTreeItem({
                type: 'udfs-folder',
                connection,
                schemaName: 'MY_SCHEMA',
                label: 'UDFs',
                id: 'conn-1:MY_SCHEMA:udfs-folder',
                collapsibleState: vscode.TreeItemCollapsibleState.Collapsed
            });

            const children = await provider.getChildren(udfsFolderElement);
            const scriptNode = children[0] as ObjectTreeItem;

            assert.ok(scriptNode.command, 'Script node should have a command');
            assert.strictEqual(scriptNode.command!.command, 'exasol.openScriptSource');
        });
    });
});
