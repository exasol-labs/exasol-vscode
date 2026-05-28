import * as assert from 'assert';
import { formatDialect, sql } from 'sql-formatter';

/**
 * Vscode mock types used by the formatting provider tests.
 * The real provider imports from 'vscode'; these stubs satisfy
 * the same interface so we can test outside the extension host.
 */

class MockPosition {
    line: number;
    character: number;
    constructor(line: number, character: number) {
        this.line = line;
        this.character = character;
    }
}

class MockRange {
    start: MockPosition;
    end: MockPosition;
    constructor(start: MockPosition, end: MockPosition) {
        this.start = start;
        this.end = end;
    }
}

class MockTextEdit {
    range: MockRange;
    newText: string;
    constructor(range: MockRange, newText: string) {
        this.range = range;
        this.newText = newText;
    }
    static replace(range: MockRange, newText: string): MockTextEdit {
        return new MockTextEdit(range, newText);
    }
}

let configValues: Record<string, any> = {};

function setMockConfig(values: Record<string, any>): void {
    configValues = values;
}

const vscodeMock = {
    Position: MockPosition,
    Range: MockRange,
    TextEdit: MockTextEdit,
    workspace: {
        getConfiguration(_section?: string) {
            return {
                get<T>(key: string): T | undefined {
                    return configValues[key] as T | undefined;
                },
            };
        },
    },
    CancellationToken: {},
};

// Register the vscode mock before importing FormattingProvider.
// The extension host normally provides the 'vscode' module; in unit tests
// we intercept module resolution so the provider gets our mock instead.
const NodeModule = require('module');
const originalResolveFilename = NodeModule._resolveFilename;
NodeModule._resolveFilename = function (request: string, ...args: any[]) {
    if (request === 'vscode') {
        return 'vscode';
    }
    return originalResolveFilename.call(this, request, ...args);
};
require.cache['vscode'] = {
    id: 'vscode',
    filename: 'vscode',
    loaded: true,
    exports: vscodeMock,
    paths: [],
    children: [],
    path: '',
    require: require,
    isPreloading: false,
} as any;

// Now import the real FormattingProvider -- it will get our vscode mock.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { FormattingProvider } = require('../../providers/formattingProvider');

function makeMockDocument(text: string, lineCount?: number): any {
    const lines = text.split('\n');
    return {
        getText(range?: MockRange): string {
            if (!range) { return text; }
            const startOffset = lines.slice(0, range.start.line).join('\n').length +
                (range.start.line > 0 ? 1 : 0) + range.start.character;
            const endOffset = lines.slice(0, range.end.line).join('\n').length +
                (range.end.line > 0 ? 1 : 0) + range.end.character;
            return text.substring(startOffset, endOffset);
        },
        lineCount: lineCount ?? lines.length,
        lineAt(line: number): any {
            return {
                text: lines[line] ?? '',
                range: new MockRange(
                    new MockPosition(line, 0),
                    new MockPosition(line, (lines[line] ?? '').length)
                )
            };
        },
        get uri() { return { toString: () => 'file:///test.exasql' }; },
    };
}

/**
 * Helper that calls sql-formatter directly with explicit options.
 * Used by the pure formatting tests (keyword case, indentation, etc.)
 * to verify sql-formatter output without going through the provider.
 */
function formatSql(
    text: string,
    options: {
        keywordCase?: 'upper' | 'lower' | 'preserve';
        indentStyle?: 'standard' | 'tabularLeft' | 'tabularRight';
        tabWidth?: number;
        useTabs?: boolean;
        linesBetweenQueries?: number;
    } = {}
): string {
    return formatDialect(text, {
        dialect: sql,
        keywordCase: options.keywordCase ?? 'upper',
        indentStyle: options.indentStyle ?? 'standard',
        tabWidth: options.tabWidth ?? 2,
        useTabs: options.useTabs ?? false,
        linesBetweenQueries: options.linesBetweenQueries ?? 2,
    });
}

const mockOptions = { tabSize: 2, insertSpaces: true };
const mockToken: any = {};

suite('SQL Formatting — keyword case', () => {
    test('uppercases keywords by default', () => {
        const input = 'select id, name from users where id = 1';
        const result = formatSql(input);
        assert.ok(result.startsWith('SELECT'));
        assert.ok(result.includes('FROM'));
        assert.ok(result.includes('WHERE'));
    });

    test('uppercases keywords when keywordCase is upper', () => {
        const input = 'select id from users';
        const result = formatSql(input, { keywordCase: 'upper' });
        assert.ok(result.includes('SELECT'));
        assert.ok(result.includes('FROM'));
    });

    test('lowercases keywords when keywordCase is lower', () => {
        const input = 'SELECT id FROM users';
        const result = formatSql(input, { keywordCase: 'lower' });
        assert.ok(result.includes('select'));
        assert.ok(result.includes('from'));
        assert.ok(!result.includes('SELECT'));
        assert.ok(!result.includes('FROM'));
    });

    test('preserves keyword case when keywordCase is preserve', () => {
        const input = 'Select id From users';
        const result = formatSql(input, { keywordCase: 'preserve' });
        assert.ok(result.includes('Select'));
        assert.ok(result.includes('From'));
    });
});

suite('SQL Formatting — indentation with spaces', () => {
    test('indents with 2 spaces by default', () => {
        const input = 'select id from users where id = 1';
        const result = formatSql(input);
        const lines = result.split('\n');
        const indentedLine = lines.find(l => l.startsWith('  ') && !l.startsWith('   '));
        assert.ok(indentedLine, 'Should have a line indented with 2 spaces');
    });

    test('indents with 4 spaces when tabWidth is 4', () => {
        const input = 'select id from users where id = 1';
        const result = formatSql(input, { tabWidth: 4 });
        const lines = result.split('\n');
        const indentedLine = lines.find(l => l.startsWith('    '));
        assert.ok(indentedLine, 'Should have a line indented with 4 spaces');
    });

    test('indents with 8 spaces when tabWidth is 8', () => {
        const input = 'select id from users where id = 1';
        const result = formatSql(input, { tabWidth: 8 });
        const lines = result.split('\n');
        const indentedLine = lines.find(l => l.startsWith('        '));
        assert.ok(indentedLine, 'Should have a line indented with 8 spaces');
    });
});

suite('SQL Formatting — indentation with tabs', () => {
    test('uses tab characters when useTabs is true', () => {
        const input = 'select id from users where id = 1';
        const result = formatSql(input, { useTabs: true });
        const lines = result.split('\n');
        const tabLine = lines.find(l => l.startsWith('\t'));
        assert.ok(tabLine, 'Should have a line indented with a tab');
    });

    test('does not use tabs when useTabs is false', () => {
        const input = 'select id from users where id = 1';
        const result = formatSql(input, { useTabs: false });
        assert.ok(!result.includes('\t'), 'Should not contain tab characters');
    });
});

suite('SQL Formatting — tabular indent styles', () => {
    test('applies tabularLeft alignment: keywords left-padded to same column width', () => {
        const input = 'select id, name from users where id = 1';
        const result = formatSql(input, { indentStyle: 'tabularLeft' });
        const lines = result.split('\n');
        // In tabularLeft style all clause keywords begin at column 0 with no leading spaces
        const selectLine = lines.find(l => l.startsWith('SELECT'));
        const fromLine = lines.find(l => l.startsWith('FROM') || l.startsWith('  FROM'));
        assert.ok(selectLine, 'Should have a SELECT line with no leading whitespace');
        assert.ok(fromLine, 'Should have a FROM line');
        // keyword widths should be right-padded: SELECT(6) FROM(4) WHERE(5) are all present
        assert.ok(result.includes('SELECT'), 'Should contain SELECT');
        assert.ok(result.includes('FROM'), 'Should contain FROM');
        assert.ok(result.includes('WHERE'), 'Should contain WHERE');
    });

    test('applies tabularRight alignment: keywords right-aligned to same column', () => {
        const input = 'select id, name from users where id = 1';
        const result = formatSql(input, { indentStyle: 'tabularRight' });
        const lines = result.split('\n');
        // In tabularRight the longest keyword (SELECT=6) is the reference; shorter ones are padded left
        // FROM (4 chars) should have 2 leading spaces to align with SELECT
        const fromLine = lines.find(l => /^\s+FROM\b/.test(l));
        assert.ok(fromLine, 'FROM should have leading spaces (right-aligned padding)');
        assert.ok(result.includes('SELECT'), 'Should contain SELECT');
        assert.ok(result.includes('WHERE'), 'Should contain WHERE');
    });
});

suite('SQL Formatting — multi-statement spacing', () => {
    test('separates statements with 2 blank lines by default', () => {
        const input = 'select 1; select 2;';
        const result = formatSql(input);
        assert.ok(result.includes(';\n\n\nSELECT'), 'Should have 2 blank lines (3 newlines) between statements');
    });

    test('separates statements with 1 blank line when configured', () => {
        const input = 'select 1; select 2;';
        const result = formatSql(input, { linesBetweenQueries: 1 });
        assert.ok(result.includes(';\n\nSELECT'), 'Should have 1 blank line (2 newlines) between statements');
    });

    test('separates statements with 0 blank lines when configured', () => {
        const input = 'select 1; select 2;';
        const result = formatSql(input, { linesBetweenQueries: 0 });
        assert.ok(!result.includes('\n\n'), 'Should have no blank lines between statements');
    });
});

suite('SQL Formatting — comment preservation', () => {
    test('preserves single-line comments', () => {
        const input = '-- this is a header comment\nselect id from users';
        const result = formatSql(input);
        assert.ok(result.includes('-- this is a header comment'), 'Should preserve single-line comment');
    });

    test('preserves block comments', () => {
        const input = 'select /* important */ id from users';
        const result = formatSql(input);
        assert.ok(result.includes('/* important */'), 'Should preserve block comment');
    });

    test('preserves both single-line and block comments together', () => {
        const input = '-- header\nselect /* block */ id from users';
        const result = formatSql(input);
        assert.ok(result.includes('-- header'), 'Should preserve single-line comment');
        assert.ok(result.includes('/* block */'), 'Should preserve block comment');
    });
});

suite('SQL Formatting — empty and whitespace input', () => {
    test('returns empty string for empty input', () => {
        const result = formatSql('');
        assert.strictEqual(result.trim(), '');
    });

    test('returns empty string for whitespace-only input', () => {
        const result = formatSql('   \n  \n   ');
        assert.strictEqual(result.trim(), '');
    });
});

suite('SQL Formatting — document provider behavior', () => {
    let provider: InstanceType<typeof FormattingProvider>;

    setup(() => {
        setMockConfig({});
        provider = new FormattingProvider();
    });

    test('empty document produces no edits', () => {
        const doc = makeMockDocument('');
        const edits = provider.provideDocumentFormattingEdits(doc, mockOptions, mockToken);
        assert.strictEqual(edits.length, 0);
    });

    test('whitespace-only document produces no edits', () => {
        const doc = makeMockDocument('   \n  \n   ');
        const edits = provider.provideDocumentFormattingEdits(doc, mockOptions, mockToken);
        assert.strictEqual(edits.length, 0);
    });

    test('formatting returns a single TextEdit replacing the full document', () => {
        const input = 'select id from users';
        const doc = makeMockDocument(input);

        const edits = provider.provideDocumentFormattingEdits(doc, mockOptions, mockToken);
        assert.strictEqual(edits.length, 1);
        assert.ok(edits[0].newText.includes('SELECT'), 'Should contain formatted SQL');
        assert.strictEqual(edits[0].range.start.line, 0);
        assert.strictEqual(edits[0].range.start.character, 0);
    });
});

suite('SQL Formatting — range formatting', () => {
    let provider: InstanceType<typeof FormattingProvider>;

    setup(() => {
        setMockConfig({});
        provider = new FormattingProvider();
    });

    test('formats only the selected range text', () => {
        const line1 = 'select id from users;';
        const line2 = 'select name from orders;';
        const fullText = `${line1}\n${line2}`;
        const doc = makeMockDocument(fullText);

        // Select only the second line
        const range = new MockRange(
            new MockPosition(1, 0),
            new MockPosition(1, line2.length)
        );

        const edits = provider.provideDocumentRangeFormattingEdits(doc, range, mockOptions, mockToken);
        assert.strictEqual(edits.length, 1);
        assert.ok(edits[0].newText.includes('SELECT'), 'Selected range should be formatted');
        assert.ok(edits[0].newText.includes('name'), 'Selected range should contain original column');
    });

    test('range formatting preserves text outside selection', () => {
        const before = '-- header comment';
        const selected = 'select id from users';
        const after = '-- footer comment';
        const fullText = `${before}\n${selected}\n${after}`;
        const doc = makeMockDocument(fullText);

        // Select only the middle line
        const range = new MockRange(
            new MockPosition(1, 0),
            new MockPosition(1, selected.length)
        );

        const edits = provider.provideDocumentRangeFormattingEdits(doc, range, mockOptions, mockToken);
        assert.strictEqual(edits.length, 1);
        assert.ok(edits[0].newText.includes('SELECT'), 'Selected text should be formatted');
        // The edit only covers the selected range, so text outside is untouched
        assert.strictEqual(edits[0].range.start.line, 1);
        assert.strictEqual(edits[0].range.end.line, 1);
    });
});

suite('SQL Formatting — combined option scenarios', () => {
    test('lowercase keywords with tab indentation', () => {
        const input = 'SELECT id FROM users WHERE id = 1';
        const result = formatSql(input, { keywordCase: 'lower', useTabs: true });
        assert.ok(result.includes('select'), 'Keywords should be lowercased');
        assert.ok(result.includes('\t'), 'Should use tab indentation');
    });

    test('preserve case with 4-space indent', () => {
        const input = 'Select id From users Where id = 1';
        const result = formatSql(input, { keywordCase: 'preserve', tabWidth: 4 });
        assert.ok(result.includes('Select'), 'Should preserve Select');
        assert.ok(result.includes('From'), 'Should preserve From');
        const lines = result.split('\n');
        const indented = lines.find(l => l.startsWith('    '));
        assert.ok(indented, 'Should have 4-space indentation');
    });

    test('tabularLeft with lowercase', () => {
        const input = 'SELECT id, name FROM users WHERE id = 1';
        const result = formatSql(input, { keywordCase: 'lower', indentStyle: 'tabularLeft' });
        assert.ok(result.includes('select'), 'Keywords should be lower');
        assert.ok(result.includes('from'), 'Keywords should be lower');
    });
});
