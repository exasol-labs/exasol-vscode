import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Tree items and menus name commands by string, so a command that is
 * referenced but never registered compiles fine and silently does nothing
 * on click. These checks read the sources and package.json to catch that.
 */
const srcDir = path.resolve(__dirname, '../..');
const packageJson = JSON.parse(fs.readFileSync(path.resolve(srcDir, '../package.json'), 'utf8')) as {
    contributes: {
        commands: Array<{ command: string }>;
        menus: Record<string, Array<{ command: string }>>;
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

suite('Command registration', () => {
    test('every command a tree item runs on click is registered and declared', () => {
        const providerSources = readSources(path.join(srcDir, 'providers'));
        const clickCommands = matchAll(providerSources, /command: '(exasol\.[\w.]+)'/g);
        assert.ok(clickCommands.has('exasol.openScriptSource'), 'scan must find the script click command');
        for (const command of clickCommands) {
            assert.ok(registered.has(command), `${command} is used by a tree item but never registered`);
        }
        for (const command of ['exasol.openScriptSource', 'exasol.openFunctionSource', 'exasol.openObject']) {
            assert.ok(declared.has(command), `${command} is not declared in package.json`);
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
});
