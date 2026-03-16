import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Multi-Result Tabs E2E', () => {

    setup(async () => {
        const config = vscode.workspace.getConfiguration('exasol');
        await config.update('separateResultTabs', undefined, vscode.ConfigurationTarget.Global);
    });

    test('toggle command is registered', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(
            commands.includes('exasol.toggleSeparateResultTabs'),
            'exasol.toggleSeparateResultTabs should be in registered commands'
        );
    });

    test('default setting is false', () => {
        const config = vscode.workspace.getConfiguration('exasol');
        const value = config.get<boolean>('separateResultTabs');
        assert.strictEqual(value, false, 'separateResultTabs should default to false');
    });

    test('toggle command executes without error', async () => {
        await vscode.commands.executeCommand('exasol.toggleSeparateResultTabs');
    });

    test('toggle flips setting value', async () => {
        const config = vscode.workspace.getConfiguration('exasol');
        const before = config.get<boolean>('separateResultTabs');
        await vscode.commands.executeCommand('exasol.toggleSeparateResultTabs');
        const after = config.get<boolean>('separateResultTabs');
        assert.notStrictEqual(before, after, 'setting should flip after toggle');
    });

    test('setting persists across toggles', async () => {
        const config = vscode.workspace.getConfiguration('exasol');

        assert.strictEqual(config.get<boolean>('separateResultTabs'), false, 'should start false');

        await vscode.commands.executeCommand('exasol.toggleSeparateResultTabs');
        assert.strictEqual(
            vscode.workspace.getConfiguration('exasol').get<boolean>('separateResultTabs'),
            true,
            'should be true after first toggle'
        );

        await vscode.commands.executeCommand('exasol.toggleSeparateResultTabs');
        assert.strictEqual(
            vscode.workspace.getConfiguration('exasol').get<boolean>('separateResultTabs'),
            false,
            'should be false after second toggle'
        );
    });
});
