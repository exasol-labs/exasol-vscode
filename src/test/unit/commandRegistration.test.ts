import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Menus name commands by string, so a command that is referenced but never
 * registered compiles fine and silently does nothing when chosen. These
 * checks read the sources and package.json to catch that.
 */
const srcDir = path.resolve(__dirname, '../..');
const packageJson = JSON.parse(fs.readFileSync(path.resolve(srcDir, '../package.json'), 'utf8')) as {
    contributes: {
        commands: Array<{ command: string }>;
        menus: Record<string, Array<{ command: string; when?: string }>>;
    };
};

function readSources(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            return entry.name === 'test' ? [] : readSources(full);
        }
        return /\.tsx?$/.test(entry.name) ? [fs.readFileSync(full, 'utf8')] : [];
    });
}

function matchAll(sources: string[], pattern: RegExp): Set<string> {
    return new Set(sources.flatMap(source => [...source.matchAll(pattern)].map(m => m[1])));
}

const sources = readSources(srcDir);
const registered = matchAll(sources, /(?:registerCommand|itemCommand)\(\s*'(exasol\.[\w.]+)'/g);
const declared = new Set(packageJson.contributes.commands.map(c => c.command));
const itemCommands = matchAll(sources, /itemCommand\(\s*'(exasol\.[\w.]+)'/g);
// Registered with registerCommand, but they read the connection from the tree
// item and only show a warning or do nothing without one.
const inlineItemCommands = ['exasol.copyQualifiedName', 'exasol.setActiveConnection', 'exasol.reconnectConnection'];
const hiddenInPalette = new Set(
    (packageJson.contributes.menus.commandPalette ?? []).filter(e => e.when === 'false').map(e => e.command)
);

suite('Command registration', () => {
    test('every command declared in package.json is registered', () => {
        assert.ok(registered.has('exasol.openScriptSource'), 'scan must find itemCommand registrations');
        for (const command of declared) {
            assert.ok(registered.has(command), `${command} is declared but never registered`);
        }
    });

    test('every command in a package.json menu is declared and registered', () => {
        for (const [menu, entries] of Object.entries(packageJson.contributes.menus)) {
            for (const { command } of entries) {
                assert.ok(declared.has(command), `${command} in menu ${menu} is not declared`);
                assert.ok(registered.has(command), `${command} in menu ${menu} is never registered`);
            }
        }
    });

    test('every command that needs a tree item is hidden in the Command Palette', () => {
        assert.ok(itemCommands.has('exasol.renameConnection'), 'scan must find itemCommand registrations');
        for (const command of [...itemCommands, ...inlineItemCommands]) {
            assert.ok(declared.has(command), `${command} is not declared`);
            assert.ok(hiddenInPalette.has(command), `${command} needs a tree item but is shown in the Command Palette`);
        }
    });
});
