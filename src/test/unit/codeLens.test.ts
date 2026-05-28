// Unit tests for codeLensProvider: verifies that the state-machine splitter
// correctly identifies statement boundaries, and that the offset/line helpers
// produce accurate line numbers.
//
// We test the parser output (statement counts and positions) rather than
// making assertions about the VS Code CodeLens API itself.
import * as assert from 'assert';

// ---------------------------------------------------------------------------
// Minimal vscode mock: must be registered before codeLensProvider is required
// ---------------------------------------------------------------------------

class MockRange {
    startLine: number;
    startChar: number;
    endLine: number;
    endChar: number;
    constructor(startLine: number, startChar: number, endLine: number, endChar: number) {
        this.startLine = startLine;
        this.startChar = startChar;
        this.endLine = endLine;
        this.endChar = endChar;
    }
}

class MockCodeLens {
    range: MockRange;
    command: { title: string; command: string; arguments?: unknown[] } | undefined;
    constructor(range: MockRange, command?: { title: string; command: string; arguments?: unknown[] }) {
        this.range = range;
        this.command = command;
    }
}

class MockEventEmitter {
    event: () => void = () => {};
    fire(): void {}
    dispose(): void {}
}

const vscodeMock = {
    Range: MockRange,
    CodeLens: MockCodeLens,
    EventEmitter: MockEventEmitter,
};

const NodeModule = require('module');
const originalResolveFilename = NodeModule._resolveFilename;
NodeModule._resolveFilename = function (request: string, ...args: unknown[]) {
    if (request === 'vscode') { return 'vscode'; }
    return originalResolveFilename.call(this, request, ...args);
};
if (!require.cache['vscode']) {
    require.cache['vscode'] = {
        id: 'vscode',
        filename: 'vscode',
        loaded: true,
        exports: vscodeMock,
        paths: [],
        children: [],
        path: '',
        require,
        isPreloading: false,
    } as any;
}

// Require codeLensProvider AFTER the vscode mock is registered
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ExasolCodeLensProvider } = require('../../providers/codeLensProvider');
// findStatementRanges is exercised through provideCodeLenses (which builds the
// CodeLens range from its output), but a few tests pin range positions directly
// to lock down the anchor-on-first-code-line behaviour.
import { findStatementRanges, buildLineOffsets, offsetToLine } from '../../utils';

// ---------------------------------------------------------------------------
// Helper: build a minimal TextDocument mock
// ---------------------------------------------------------------------------

function makeDoc(text: string, scheme = 'file'): { getText(): string; uri: { scheme: string } } {
    return {
        getText(): string { return text; },
        uri: { scheme },
    };
}

// ---------------------------------------------------------------------------
// provideCodeLenses integration tests (CodeLens count via mocked provider)
// ---------------------------------------------------------------------------

suite('ExasolCodeLensProvider: CodeLens count', () => {
    function lensCount(text: string): number {
        const provider = new ExasolCodeLensProvider();
        const result = provider.provideCodeLenses(makeDoc(text), {});
        return (result as unknown[]).length;
    }

    test('semicolon inside string literal: 1 CodeLens', () => {
        assert.strictEqual(lensCount("SELECT 'a;b' FROM t;"), 1);
    });

    test('double-dash inside string: 1 CodeLens', () => {
        assert.strictEqual(lensCount("SELECT '--comment';"), 1);
    });

    test('two statements on one line: 2 CodeLenses', () => {
        assert.strictEqual(lensCount('SELECT 1; SELECT 2;'), 2);
    });

    test('block comment with semicolon: 1 CodeLens', () => {
        assert.strictEqual(lensCount('/* a; b */ SELECT 1;'), 1);
    });

    test('empty input: 0 CodeLenses', () => {
        assert.strictEqual(lensCount(''), 0);
    });

    test('notebook cell scheme returns 0 CodeLenses', () => {
        const provider = new ExasolCodeLensProvider();
        const result = provider.provideCodeLenses(makeDoc('SELECT 1;', 'vscode-notebook-cell'), {});
        assert.strictEqual((result as unknown[]).length, 0);
    });
});

// ---------------------------------------------------------------------------
// CodeLens range start positions: each lens must anchor at the FIRST line of
// real SQL for its statement, not at the line of the previous statement's
// terminator and not at decorative comment header lines above the statement.
// ---------------------------------------------------------------------------

function lenses(text: string): MockCodeLens[] {
    const provider = new ExasolCodeLensProvider();
    return provider.provideCodeLenses(makeDoc(text), {}) as MockCodeLens[];
}

suite('ExasolCodeLensProvider: CodeLens anchor line', () => {
    test('inline comment with semicolon does not split statement: 1 CodeLens, anchored at first code line', () => {
        const text = "-- header\nSELECT * FROM t WHERE id = 1 -- comment;\nAND name = 'x';\n";
        const out = lenses(text);
        assert.strictEqual(out.length, 1, 'inline-comment ; must not introduce a second lens');
        assert.strictEqual(out[0].range.startLine, 1, 'lens should anchor on the SELECT line, not the header');
    });

    test('multiple consecutive multi-line statements: each lens anchored at its own first code line', () => {
        const text = 'SELECT 1\nFROM t1;\nSELECT 2\nFROM t2;\n';
        const out = lenses(text);
        assert.strictEqual(out.length, 2);
        assert.strictEqual(out[0].range.startLine, 0, 'first lens at SELECT 1');
        assert.strictEqual(out[1].range.startLine, 2, 'second lens at SELECT 2, NOT at the terminator of stmt 1');
    });

    test('statement preceded by blank+comment lines anchors on the SELECT line, not the comment', () => {
        const text = '-- header\n\n-- comment\nSELECT 1;\n';
        const out = lenses(text);
        assert.strictEqual(out.length, 1);
        assert.strictEqual(out[0].range.startLine, 3, 'lens anchors on the SELECT line (0-based line 3)');
    });

    test('two statements on one line still produces two lenses at same line', () => {
        const text = 'SELECT 1; SELECT 2;';
        const out = lenses(text);
        assert.strictEqual(out.length, 2);
        assert.strictEqual(out[0].range.startLine, 0);
        assert.strictEqual(out[1].range.startLine, 0);
    });
});

// ---------------------------------------------------------------------------
// Execution-argument range: the second argument passed to exasol.executeStatement
// must cover the FULL statement, including the terminating semicolon line.
// Regression cover for: "Execute CodeLens stops at the first comment line"
// (the previous code reused the display range as the exec range, which used
// (endLine, 0) for the end position and therefore excluded the entire line
// containing the semicolon, dropping clauses like LIMIT 100; that sit on it).
// ---------------------------------------------------------------------------

// Mirror VS Code's TextDocument.getText(range) semantics: returns text from
// (startLine, startChar) up to but not including (endLine, endChar). Suitable
// for verifying that the range passed to exasol.executeStatement covers the
// full statement text (semicolon included) as the real handler would extract.
function getTextInRange(doc: string, range: MockRange): string {
    const lines = doc.split('\n');
    if (range.startLine === range.endLine) {
        return (lines[range.startLine] ?? '').slice(range.startChar, range.endChar);
    }
    const head = (lines[range.startLine] ?? '').slice(range.startChar);
    const middle = lines.slice(range.startLine + 1, range.endLine);
    const tail = (lines[range.endLine] ?? '').slice(0, range.endChar);
    return [head, ...middle, tail].join('\n');
}

suite('ExasolCodeLensProvider: execution-argument range', () => {
    test('bug-report fixture: multi-line statement with embedded line comments, execute range covers full statement including semicolon line', () => {
        // Verbatim from the user's bug report: SELECT with WHERE 1=1, two
        // commented-out predicates, then LIMIT 100; on its own line. The
        // previous implementation excluded the entire LIMIT line because the
        // exec range ended at (endLine, 0).
        const text = [
            'select * from "SCHEMA_A"."TABLE_X" as b',
            'where 1=1',
            "    --b.col_a = '90'",
            "    --and b.col_d = '2025'",
            'limit 100;',
        ].join('\n');

        const out = lenses(text);
        assert.strictEqual(out.length, 1, 'one CodeLens for the single statement');

        const execRange = out[0].command!.arguments![1] as MockRange;
        const execText = getTextInRange(text, execRange);

        // Critical: the LIMIT clause AND the terminator must be present.
        assert.ok(execText.includes('limit 100'),
            `exec text must include the LIMIT clause; got: ${JSON.stringify(execText)}`);
        assert.ok(execText.trimEnd().endsWith(';'),
            `exec text must end with the statement terminator; got: ${JSON.stringify(execText)}`);
        // And the SELECT clause from the very first code line must be present.
        assert.ok(execText.startsWith('select * from'),
            `exec text must start at the first code line; got: ${JSON.stringify(execText)}`);
    });

    test('single-line statement: execute range covers semicolon', () => {
        const text = 'SELECT 1;';
        const out = lenses(text);
        assert.strictEqual(out.length, 1);
        const execText = getTextInRange(text, out[0].command!.arguments![1] as MockRange);
        assert.strictEqual(execText, 'SELECT 1;');
    });

    test('two statements on one line: each execute range covers only its own text including its own semicolon', () => {
        const text = 'SELECT 1; SELECT 2;';
        const out = lenses(text);
        assert.strictEqual(out.length, 2);
        const exec1 = getTextInRange(text, out[0].command!.arguments![1] as MockRange);
        const exec2 = getTextInRange(text, out[1].command!.arguments![1] as MockRange);
        // First lens covers "SELECT 1;" (its range starts at col 0)
        assert.ok(exec1.trimEnd().endsWith('SELECT 1;'),
            `first exec must end at first ;; got: ${JSON.stringify(exec1)}`);
        // Second lens covers " SELECT 2;" or "SELECT 2;"; must include the second semicolon
        assert.ok(exec2.trimEnd().endsWith('SELECT 2;'),
            `second exec must end at second ;; got: ${JSON.stringify(exec2)}`);
    });

    test('multi-line statement with no embedded comments: execute range covers all lines including semicolon', () => {
        const text = 'SELECT a,\n       b,\n       c\nFROM t;\n';
        const out = lenses(text);
        assert.strictEqual(out.length, 1);
        const execText = getTextInRange(text, out[0].command!.arguments![1] as MockRange);
        assert.ok(execText.startsWith('SELECT a,'));
        assert.ok(execText.trimEnd().endsWith('FROM t;'),
            `exec must include FROM t; got: ${JSON.stringify(execText)}`);
    });
});

// ---------------------------------------------------------------------------
// findStatementRanges: direct assertions on the fixture used by the bug report
// ---------------------------------------------------------------------------

suite('findStatementRanges: fixture cases', () => {
    // Programmatically derive the expected first-code-line for a given statement
    // index by scanning the fixture text. Used to keep the test resilient to
    // future fixture edits.
    function fixtureRanges(text: string): Array<{ startLine: number; endLine: number }> {
        const ranges = findStatementRanges(text);
        const lo = buildLineOffsets(text);
        return ranges.map(r => ({
            startLine: offsetToLine(lo, r.start) + 1, // 1-based for readability
            endLine: offsetToLine(lo, r.end) + 1,
        }));
    }

    test('all 14 ranges of test-inline-comment-fix.exasql start at first code line', () => {
        // Inline copy of the fixture content so tests remain pure (no fs access).
        const text = [
            '-- Test file to demonstrate the inline comment semicolon fix',                       // 1
            '',                                                                                   // 2
            '-- Case 1: Semicolon in inline comment should NOT terminate the statement',          // 3
            'SELECT * FROM table1 WHERE id = 1 -- This is a test;',                               // 4
            "AND name = 'test';",                                                                 // 5
            '',                                                                                   // 6
            '-- Case 2: Semicolon with trailing spaces in comment',                               // 7
            'SELECT * FROM table2 WHERE id = 2 -- Comment;   ',                                   // 8
            "AND status = 'active';",                                                             // 9
            '',                                                                                   // 10
            '-- Case 3: Multiple inline comments with semicolons',                                // 11
            'SELECT -- comment1;',                                                                // 12
            '    column1, -- comment2;',                                                          // 13
            '    column2',                                                                        // 14
            'FROM table3; -- final comment;',                                                     // 15
            '',                                                                                   // 16
            '-- Case 4: Real semicolon followed by comment (should terminate)',                   // 17
            'SELECT * FROM table4; -- This is the end',                                           // 18
            '',                                                                                   // 19
            '-- Case 5: Complex real-world scenario',                                             // 20
            'CREATE TABLE test_table (',                                                          // 21
            '    id INT, -- primary key;',                                                        // 22
            '    name VARCHAR(100), -- user name;',                                               // 23
            '    status VARCHAR(20) -- active/inactive;',                                         // 24
            '); -- end of CREATE TABLE;',                                                         // 25
            '',                                                                                   // 26
            '-- Case 6: Consecutive semicolons in comments',                                      // 27
            'SELECT * FROM table5 WHERE id = 5 -- test;;; more;;;',                               // 28
            "AND name = 'test';",                                                                 // 29
            '',                                                                                   // 30
            '-- Case 7: Multi-line comment with semicolon (should NOT terminate)',                // 31
            'SELECT * FROM table6 /* comment',                                                    // 32
            'with semicolon; inside */ WHERE id = 6;',                                            // 33
            '',                                                                                   // 34
            '-- Case 8: Inline multi-line comment with semicolon',                                // 35
            "SELECT * FROM table7 /* comment; */ WHERE status = 'active';",                       // 36
            '',                                                                                   // 37
            '-- Case 9: Multiple multi-line comments with semicolons',                            // 38
            'SELECT /* first; */',                                                                // 39
            '    column1, /* second; more; */',                                                   // 40
            '    column2',                                                                        // 41
            'FROM table8;',                                                                       // 42
            '',                                                                                   // 43
            '-- Case 10: Mixed single-line and multi-line comments',                              // 44
            'SELECT * FROM table9 /* block comment; */ WHERE id = 9 -- line comment;',            // 45
            'AND active = true;',                                                                 // 46
            '',                                                                                   // 47
            '-- Case 11: Multi-line block comment with semicolon inside (should NOT terminate)',  // 48
            'SELECT * FROM table10',                                                              // 49
            '/* This block comment',                                                              // 50
            '   spans multiple lines;',                                                           // 51
            '   and contains; multiple; semicolons */',                                           // 52
            'WHERE id = 10;',                                                                     // 53
            '',                                                                                   // 54
            '-- Case 12: Apostrophe-escaped (doubled) string with semicolon inside',              // 55
            "SELECT 'O''Brien''s; query' FROM table11",                                           // 56
            "WHERE name = 'test';",                                                               // 57
            '',                                                                                   // 58
            '-- Case 13: Two statements on one line (each should be a separate statement)',      // 59
            'SELECT * FROM table12; SELECT * FROM table13;',                                      // 60
            '',                                                                                   // 61
        ].join('\n');

        const expected = [
            { startLine: 4, endLine: 5 },
            { startLine: 8, endLine: 9 },
            { startLine: 12, endLine: 15 },
            { startLine: 18, endLine: 18 },
            { startLine: 21, endLine: 25 },
            { startLine: 28, endLine: 29 },
            { startLine: 32, endLine: 33 },
            { startLine: 36, endLine: 36 },
            { startLine: 39, endLine: 42 },
            { startLine: 45, endLine: 46 },
            { startLine: 49, endLine: 53 },
            { startLine: 56, endLine: 57 },
            { startLine: 60, endLine: 60 },
            { startLine: 60, endLine: 60 },
        ];

        assert.deepStrictEqual(fixtureRanges(text), expected);
    });

    test('range start advances past trailing portion of previous-stmt line', () => {
        // The previous statement ends with `;` followed by `\n`; the next statement
        // begins on the line AFTER the semicolon. The next range must anchor on the
        // following SELECT, not on the same line as the prior `;`.
        const text = 'SELECT 1;\nSELECT 2;\n';
        const ranges = findStatementRanges(text);
        const lo = buildLineOffsets(text);
        assert.strictEqual(ranges.length, 2);
        assert.strictEqual(offsetToLine(lo, ranges[0].start), 0);
        assert.strictEqual(offsetToLine(lo, ranges[1].start), 1);
    });
});
