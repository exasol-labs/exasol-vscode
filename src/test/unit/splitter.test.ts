import * as assert from 'assert';
import { splitIntoStatements, findStatementEnds, findStatementRanges, findStatementAtCursor, stripCommentsPreservingStrings, buildLineOffsets, offsetToLine, stripFinalSlashLine, isScriptOrFunctionDefinition } from '../../utils';

suite('splitIntoStatements: string literal awareness', () => {
    test('semicolon inside string literal is not a statement boundary', () => {
        const statements = splitIntoStatements("INSERT INTO t VALUES ('a;b');");
        assert.strictEqual(statements.length, 1, 'should produce exactly 1 statement');
        assert.ok(statements[0].includes("'a;b'"), 'statement should contain the string literal');
    });

    test('two statements each containing a semicolon in a string', () => {
        const statements = splitIntoStatements("SELECT 'a;b'; SELECT 'c;d';");
        assert.strictEqual(statements.length, 2, 'should produce exactly 2 statements');
        assert.ok(statements[0].includes("'a;b'"));
        assert.ok(statements[1].includes("'c;d'"));
    });

    test('string that looks like a comment is not stripped', () => {
        const statements = splitIntoStatements("SELECT '--not a comment';");
        assert.strictEqual(statements.length, 1);
        assert.ok(statements[0].includes("'--not a comment'"), 'string content must not be stripped');
    });

    test('escaped single quote (doubled) stays in the string', () => {
        const statements = splitIntoStatements("SELECT 'O''Brien';");
        assert.strictEqual(statements.length, 1, 'escaped quote must not split the string into 2');
        assert.ok(statements[0].includes("'O''Brien'"));
    });

    test('block comment that starts before any SQL is stripped cleanly', () => {
        const statements = splitIntoStatements('/* /*nested*/ */ SELECT 1;');
        assert.strictEqual(statements.length, 1);
        assert.ok(statements[0].includes('SELECT 1'));
    });

    test('INSERT with semicolon in string followed by another statement', () => {
        const text = "INSERT INTO t VALUES ('hello;world');\nSELECT * FROM t;";
        const statements = splitIntoStatements(text);
        assert.strictEqual(statements.length, 2);
        assert.ok(statements[0].includes("'hello;world'"), 'first statement keeps string literal');
        assert.ok(statements[1].includes('SELECT * FROM t'), 'second statement is separate');
    });

    test('string containing block comment markers is not treated as a comment', () => {
        const statements = splitIntoStatements("SELECT '/* not a comment */' AS x;");
        assert.strictEqual(statements.length, 1);
        assert.ok(statements[0].includes("'/* not a comment */'"));
    });

    test('multiple semicolons inside a single string literal', () => {
        const statements = splitIntoStatements("SELECT 'a;b;c;d';");
        assert.strictEqual(statements.length, 1);
        assert.ok(statements[0].includes("'a;b;c;d'"));
    });
});

suite('findStatementEnds: string literal awareness', () => {
    test('returns empty array for empty string', () => {
        assert.deepStrictEqual(findStatementEnds(''), []);
    });

    test('finds single top-level semicolon', () => {
        const ends = findStatementEnds('SELECT 1;');
        assert.strictEqual(ends.length, 1);
        assert.strictEqual(ends[0], 8);
    });

    test('ignores semicolon inside string literal', () => {
        const ends = findStatementEnds("INSERT INTO t VALUES ('a;b');");
        // Only the final ';' at position 27 should be found
        assert.strictEqual(ends.length, 1);
    });

    test('ignores semicolon inside line comment', () => {
        const ends = findStatementEnds('SELECT 1 -- comment;\nWHERE 1=1;');
        // Only the ';' at the end of the WHERE clause
        assert.strictEqual(ends.length, 1);
    });

    test('ignores semicolon inside block comment', () => {
        const ends = findStatementEnds('SELECT 1 /* comment; */ WHERE 1=1;');
        assert.strictEqual(ends.length, 1);
    });

    test('handles escaped single quote inside string', () => {
        const ends = findStatementEnds("SELECT 'O''Brien';");
        assert.strictEqual(ends.length, 1);
    });

    test('finds two top-level semicolons', () => {
        const ends = findStatementEnds('SELECT 1; SELECT 2;');
        assert.strictEqual(ends.length, 2);
    });
});

suite('stripCommentsPreservingStrings', () => {
    test('returns plain SQL unchanged', () => {
        const sql = 'SELECT 1';
        assert.strictEqual(stripCommentsPreservingStrings(sql), sql);
    });

    test('strips single-line comment', () => {
        const result = stripCommentsPreservingStrings('SELECT 1 -- comment\nFROM t');
        assert.ok(!result.includes('-- comment'), 'comment should be removed');
        assert.ok(result.includes('SELECT 1'), 'SQL before comment preserved');
        assert.ok(result.includes('FROM t'), 'SQL after comment preserved');
    });

    test('strips block comment', () => {
        const result = stripCommentsPreservingStrings('SELECT /* comment */ 1');
        assert.ok(!result.includes('/* comment */'), 'block comment should be removed');
        assert.ok(result.includes('SELECT'), 'SELECT keyword preserved');
    });

    test('preserves string literal that looks like a comment', () => {
        const result = stripCommentsPreservingStrings("SELECT '--not a comment' AS x");
        assert.ok(result.includes("'--not a comment'"), 'string literal must be preserved');
    });

    test('preserves string literal containing block comment markers', () => {
        const result = stripCommentsPreservingStrings("SELECT '/* not a comment */' AS x");
        assert.ok(result.includes("'/* not a comment */'"), 'string literal must be preserved');
    });

    test('preserves escaped single quotes inside string', () => {
        const result = stripCommentsPreservingStrings("SELECT 'O''Brien'");
        assert.ok(result.includes("'O''Brien'"), 'escaped quotes must be preserved');
    });

    test('strips comment but keeps string with same characters', () => {
        const result = stripCommentsPreservingStrings("SELECT '--' -- this is a comment\nFROM t");
        assert.ok(result.includes("'--'"), 'string literal preserved');
        assert.ok(!result.includes('this is a comment'), 'comment stripped');
    });
});

// ---------------------------------------------------------------------------
// buildLineOffsets and offsetToLine: now exported from utils
// ---------------------------------------------------------------------------

suite('buildLineOffsets', () => {
    test('single line has offset [0]', () => {
        const offsets = buildLineOffsets('SELECT 1;');
        assert.deepStrictEqual(offsets, [0]);
    });

    test('two lines have correct offsets', () => {
        const offsets = buildLineOffsets('SELECT 1;\nSELECT 2;');
        assert.deepStrictEqual(offsets, [0, 10]);
    });

    test('empty string has offset [0]', () => {
        const offsets = buildLineOffsets('');
        assert.deepStrictEqual(offsets, [0]);
    });

    test('three lines', () => {
        const offsets = buildLineOffsets('ab\ncd\nef');
        assert.deepStrictEqual(offsets, [0, 3, 6]);
    });
});

suite('offsetToLine', () => {
    const offsets = [0, 10, 20, 30];

    test('offset 0 is line 0', () => {
        assert.strictEqual(offsetToLine(offsets, 0), 0);
    });

    test('offset 9 is still line 0', () => {
        assert.strictEqual(offsetToLine(offsets, 9), 0);
    });

    test('offset 10 is line 1', () => {
        assert.strictEqual(offsetToLine(offsets, 10), 1);
    });

    test('offset 29 is line 2', () => {
        assert.strictEqual(offsetToLine(offsets, 29), 2);
    });

    test('offset 30 is line 3', () => {
        assert.strictEqual(offsetToLine(offsets, 30), 3);
    });
});

suite('splitIntoStatements: script and function definitions', () => {
    const luaScript = 'CREATE OR REPLACE LUA SCRIPT s.lua_scr (a) RETURNS TABLE AS\nlocal x = 1; -- trailing; comment\nexit({{x}}, "v int")';
    const pythonUdf = 'CREATE PYTHON3 SCALAR SCRIPT s.py_udf (v VARCHAR(10)) RETURNS VARCHAR(20) AS\n# it\'s a comment; with / inside\ndef run(ctx):\n    return \'a;b\' + "/;" + ctx.v\n';
    const adapter = 'CREATE OR REPLACE JAVA ADAPTER SCRIPT s.adapter AS\n%scriptclass com.example.Adapter;\n%jar /buckets/bfsdefault/default/adapter.jar;\n';
    const fn = 'CREATE OR REPLACE FUNCTION s.f (p DECIMAL) RETURN DECIMAL\nIS\n  r DECIMAL;\nBEGIN\n  IF p > 0 THEN\n    r := CASE WHEN p > 1 THEN 2 ELSE 1 END;\n  ELSE\n    r := 0;\n  END IF;\n  FOR i := 1 TO 2 DO r := r + 1; END FOR;\n  WHILE r < 5 DO r := r + 1; END WHILE;\n  RETURN r;\nEND f;';

    test('Lua script with semicolons ends at the / line', () => {
        assert.deepStrictEqual(splitIntoStatements(`${luaScript}\n/\nSELECT 1;`), [luaScript, 'SELECT 1;']);
    });

    test('Python UDF with ; and / in strings and comments keeps its body exactly', () => {
        assert.deepStrictEqual(splitIntoStatements(`${pythonUdf}\n/\nSELECT 2;`), [pythonUdf, 'SELECT 2;']);
    });

    test('adapter script is one statement', () => {
        assert.deepStrictEqual(splitIntoStatements(`${adapter}\n/`), [adapter]);
    });

    test('script without a / line is split at ; like any other text', () => {
        assert.deepStrictEqual(splitIntoStatements(`SELECT 1;\n${luaScript}\nSELECT 2;`), [
            'SELECT 1;',
            'CREATE OR REPLACE LUA SCRIPT s.lua_scr (a) RETURNS TABLE AS\nlocal x = 1; -- trailing; comment',
            'exit({{x}}, "v int")\nSELECT 2;'
        ]);
        const doc = 'CREATE OR REPLACE LUA SCRIPT s AS\n  return 1;\n;\nSELECT 1;\nDROP TABLE t;';
        assert.deepStrictEqual(splitIntoStatements(doc), ['CREATE OR REPLACE LUA SCRIPT s AS\n  return 1;', 'SELECT 1;', 'DROP TABLE t;']);
        assert.strictEqual(findStatementAtCursor(doc, 3)?.text, 'SELECT 1;');
    });

    test('unfinished function without a / line is split at ;', () => {
        const doc = 'CREATE FUNCTION f(x DECIMAL) RETURN DECIMAL IS\nBEGIN\n RETURN x;\n\nSELECT 1;\nDELETE FROM t;';
        assert.deepStrictEqual(splitIntoStatements(doc), [
            'CREATE FUNCTION f(x DECIMAL) RETURN DECIMAL IS\nBEGIN\n RETURN x;',
            'SELECT 1;',
            'DELETE FROM t;'
        ]);
        assert.strictEqual(findStatementAtCursor(doc, 4)?.text, 'SELECT 1;');
        assert.deepStrictEqual(
            splitIntoStatements('CREATE FUNCTION f(x DECIMAL) RETURN DECIMAL IS\n r DECIMAL;\nSELECT 1;'),
            ['CREATE FUNCTION f(x DECIMAL) RETURN DECIMAL IS\n r DECIMAL;', 'SELECT 1;']
        );
    });

    test('a / line inside an open function body does not end the function', () => {
        const fnText = 'CREATE FUNCTION f(a DECIMAL, b DECIMAL) RETURN DECIMAL IS\nBEGIN\n RETURN a\n/\n b;\nEND f;';
        assert.deepStrictEqual(splitIntoStatements(`${fnText}\nSELECT 1;`), [fnText, 'SELECT 1;']);
    });

    test('many statements on one line', () => {
        const text = Array.from({ length: 20000 }, (_, i) => `INSERT INTO t VALUES (${i}, 'abc'); /* c */`).join(' ');
        const statements = splitIntoStatements(text);
        assert.strictEqual(statements.length, 20000);
        assert.strictEqual(statements[1], "/* c */ INSERT INTO t VALUES (1, 'abc');");
        assert.strictEqual(statements[19999], "/* c */ INSERT INTO t VALUES (19999, 'abc'); /* c */");
    });

    test('/ line with surrounding whitespace and CRLF line breaks', () => {
        assert.deepStrictEqual(
            splitIntoStatements('CREATE LUA SCRIPT x AS\r\nlocal a = 1;\r\n  /  \r\nSELECT 1;'),
            ['CREATE LUA SCRIPT x AS\r\nlocal a = 1;', 'SELECT 1;']
        );
    });

    test('lowercase keywords and comments before and inside the header', () => {
        const text = '-- a comment;\n/* block; */ create /* x */ or replace python3 set script s.u (a int) emits (b int) as\ndef run(ctx):\n    ctx.emit(1); pass\n/\nselect 3;';
        assert.deepStrictEqual(splitIntoStatements(text), [
            '/* block; */ create /* x */ or replace python3 set script s.u (a int) emits (b int) as\ndef run(ctx):\n    ctx.emit(1); pass',
            'select 3;'
        ]);
    });

    test('function with IF, CASE, FOR and WHILE ends at the ; after END name', () => {
        assert.deepStrictEqual(splitIntoStatements(`${fn}\nSELECT s.f(1);`), [fn, 'SELECT s.f(1);']);
    });

    test('function followed by a / line', () => {
        assert.deepStrictEqual(splitIntoStatements(`${fn}\n/\nSELECT s.f(1);`), [fn, 'SELECT s.f(1);']);
    });

    test('function closed by a / line without a final semicolon', () => {
        const text = 'create function f (p decimal) return decimal is begin return p; end "f"';
        assert.deepStrictEqual(splitIntoStatements(`${text}\n/\nselect 1;`), [text, 'select 1;']);
    });

    test('function with a quoted name ending in END', () => {
        const text = 'CREATE FUNCTION "case end" (p DECIMAL) RETURN DECIMAL IS BEGIN RETURN p; END "case end";';
        assert.deepStrictEqual(splitIntoStatements(`${text} SELECT 1;`), [text, 'SELECT 1;']);
    });

    test('mixed file: script, /, SELECT, function, /, SELECT', () => {
        const text = `${luaScript}\n/\nSELECT 1;\n${fn}\n/\nSELECT 2;\n`;
        assert.deepStrictEqual(splitIntoStatements(text), [luaScript, 'SELECT 1;', fn, 'SELECT 2;']);
    });

    test('other CREATE statements and divisions are unchanged', () => {
        assert.deepStrictEqual(
            splitIntoStatements('CREATE TABLE t (a INT);\nCREATE VIEW v AS SELECT 4\n/\n2 AS x FROM t;\nCREATE SCHEMA s;'),
            ['CREATE TABLE t (a INT);', 'CREATE VIEW v AS SELECT 4\n/\n2 AS x FROM t;', 'CREATE SCHEMA s;']
        );
    });

    test('a script after a statement on the same line is its own statement', () => {
        assert.deepStrictEqual(
            splitIntoStatements('SELECT 1; CREATE LUA SCRIPT x AS\nlocal a = 1;\n/\nSELECT 2;'),
            ['SELECT 1;', 'CREATE LUA SCRIPT x AS\nlocal a = 1;', 'SELECT 2;']
        );
    });

    test('a / line between statements is not sent', () => {
        assert.deepStrictEqual(splitIntoStatements('SELECT 1;\n/\nSELECT 2;'), ['SELECT 1;', 'SELECT 2;']);
    });

    test('findStatementEnds points at the / of the terminator line', () => {
        const text = `${luaScript}\n/\nSELECT 1;`;
        assert.deepStrictEqual(findStatementEnds(text), [luaScript.length + 1, text.length - 1]);
    });
});

suite('findStatementRanges and findStatementAtCursor: script definitions', () => {
    const text = 'SELECT 0;\nCREATE LUA SCRIPT x AS\nlocal a = 1;\nexit()\n/\nSELECT 1;';

    test('range of a script ends before the / line', () => {
        const ranges = findStatementRanges(text).map(r => text.slice(r.start, r.end + 1));
        assert.deepStrictEqual(ranges, ['SELECT 0;', 'CREATE LUA SCRIPT x AS\nlocal a = 1;\nexit()', 'SELECT 1;']);
    });

    test('cursor inside the body selects the whole script', () => {
        for (const line of [1, 2, 3]) {
            const result = findStatementAtCursor(text, line);
            assert.ok(result);
            assert.strictEqual(result.text, 'CREATE LUA SCRIPT x AS\nlocal a = 1;\nexit()');
            assert.deepStrictEqual(result.range, { start: 1, end: 3 });
        }
    });

    test('cursor on the / line selects the script it closes, without the / line', () => {
        const result = findStatementAtCursor(text, 4);
        assert.ok(result);
        assert.strictEqual(result.text, 'CREATE LUA SCRIPT x AS\nlocal a = 1;\nexit()');
        assert.deepStrictEqual(result.range, { start: 1, end: 3 });
    });

    test('cursor on the / line after a function selects the function', () => {
        const fnText = 'CREATE FUNCTION f (p DECIMAL) RETURN DECIMAL IS\nBEGIN\n  RETURN p;\nEND f';
        assert.strictEqual(findStatementAtCursor(`${fnText}\n/\nSELECT 1;`, 4)?.text, fnText);
    });

    suite('function ending in `END f;` followed by a / line', () => {
        const fnText = 'CREATE FUNCTION f (p DECIMAL) RETURN DECIMAL IS\nBEGIN\n  RETURN p;\nEND f;';
        const doc = `${fnText}\n/\nSELECT 2;`;

        test('cursor on the / line selects only the function', () => {
            const result = findStatementAtCursor(doc, 4);
            assert.ok(result);
            assert.strictEqual(result.text, fnText);
            assert.deepStrictEqual(result.range, { start: 0, end: 3 });
        });

        test('cursor on the line after the / line selects the next statement', () => {
            assert.strictEqual(findStatementAtCursor(doc, 5)?.text, 'SELECT 2;');
        });

        test('blank line between the function and the / line', () => {
            assert.strictEqual(findStatementAtCursor(`${fnText}\n\n/\nSELECT 2;`, 5)?.text, fnText);
        });

        test('a / line after a plain statement stays outside it', () => {
            assert.strictEqual(findStatementAtCursor('SELECT 1;\n/\nSELECT 2;', 1), undefined);
        });

        test('ranges and run-all give exactly two statements, without the / line', () => {
            assert.deepStrictEqual(findStatementRanges(doc).map(r => doc.slice(r.start, r.end + 1)), [fnText, 'SELECT 2;']);
            assert.deepStrictEqual(splitIntoStatements(doc), [fnText, 'SELECT 2;']);
        });
    });

    test('cursor after the / line selects the next statement', () => {
        assert.strictEqual(findStatementAtCursor(text, 5)?.text, 'SELECT 1;');
    });

    test('cursor inside a script without a / line at the end of the text', () => {
        const result = findStatementAtCursor('SELECT 0;\ncreate python3 scalar script p() returns int as\ndef run(ctx): return 1', 2);
        assert.strictEqual(result?.text, 'create python3 scalar script p() returns int as\ndef run(ctx): return 1');
    });

    test('a script that starts after a statement on the same line', () => {
        const doc = 'SELECT 1; CREATE LUA SCRIPT s AS\nreturn 1\n/\nSELECT 2;';
        for (const line of [1, 2]) {
            const result = findStatementAtCursor(doc, line);
            assert.strictEqual(result?.text, 'CREATE LUA SCRIPT s AS\nreturn 1');
            assert.strictEqual(result?.startOffset, 10);
            assert.deepStrictEqual(result?.range, { start: 0, end: 1 });
        }
        assert.strictEqual(findStatementAtCursor(doc, 0)?.text, 'SELECT 1;');
    });

    test('statement after a script closed by a ; line', () => {
        const doc = 'CREATE OR REPLACE LUA SCRIPT s.sc AS\n  -- don\'t\n  exit()\n;\nSELECT  FROM s.t';
        const result = findStatementAtCursor(doc, 4);
        assert.strictEqual(result?.text, 'SELECT  FROM s.t');
        assert.strictEqual(result?.startOffset, doc.indexOf('SELECT'));
    });
});

suite('stripFinalSlashLine', () => {
    test('removes one final / line', () => {
        assert.strictEqual(stripFinalSlashLine('CREATE LUA SCRIPT x AS\nexit()\n/'), 'CREATE LUA SCRIPT x AS\nexit()');
        assert.strictEqual(stripFinalSlashLine('SELECT 1\r\n  / \n'), 'SELECT 1');
    });

    test('keeps a division and a / line that is not the last line', () => {
        assert.strictEqual(stripFinalSlashLine('SELECT 4\n/ 2'), 'SELECT 4\n/ 2');
        assert.strictEqual(stripFinalSlashLine('SELECT 1;\n/\nSELECT 2'), 'SELECT 1;\n/\nSELECT 2');
        assert.strictEqual(stripFinalSlashLine('/'), '/');
    });

    test('removes only one / line', () => {
        assert.strictEqual(stripFinalSlashLine('SELECT 1\n/\n/'), 'SELECT 1\n/');
    });
});

suite('isScriptOrFunctionDefinition', () => {
    test('detects CREATE SCRIPT and CREATE FUNCTION in their variants', () => {
        assert.strictEqual(isScriptOrFunctionDefinition('CREATE FUNCTION f() RETURN DECIMAL IS BEGIN RETURN 1; END f;'), true);
        assert.strictEqual(isScriptOrFunctionDefinition('create or replace function s.f(p DECIMAL) return decimal'), true);
        assert.strictEqual(isScriptOrFunctionDefinition('CREATE SCRIPT s.x AS\nexit()'), true);
        assert.strictEqual(isScriptOrFunctionDefinition('CREATE OR REPLACE LUA SCALAR SCRIPT x() RETURNS INT AS'), true);
        assert.strictEqual(isScriptOrFunctionDefinition('CREATE OR REPLACE JAVA ADAPTER SCRIPT a AS'), true);
        assert.strictEqual(isScriptOrFunctionDefinition('  -- header\n/* note */ CREATE PYTHON3 SET SCRIPT p(a INT) EMITS (b INT) AS'), true);
    });

    test('rejects other statements', () => {
        assert.strictEqual(isScriptOrFunctionDefinition('SELECT 1;'), false);
        assert.strictEqual(isScriptOrFunctionDefinition('CREATE TABLE script_log (a INT);'), false);
        assert.strictEqual(isScriptOrFunctionDefinition('CREATE OR REPLACE VIEW v AS SELECT 1;'), false);
        assert.strictEqual(isScriptOrFunctionDefinition('DROP SCRIPT s.x;'), false);
        assert.strictEqual(isScriptOrFunctionDefinition('EXECUTE SCRIPT s.x();'), false);
        assert.strictEqual(isScriptOrFunctionDefinition(''), false);
    });
});

// Exasol accepts ;, --, /* and "" inside quoted identifiers (docker, 2026-10-22):
// SELECT 1 AS "a;b" returns the column a;b, CREATE VIEW S."v;--/*" works.
suite('quoted identifiers holding ;, -- or /*', () => {
    test('a ; inside a quoted identifier does not end the statement', () => {
        assert.deepStrictEqual(splitIntoStatements('SELECT 1 AS "a;b"; SELECT 2;'), ['SELECT 1 AS "a;b";', 'SELECT 2;']);
        assert.deepStrictEqual(splitIntoStatements('SELECT 1 AS "x""y;z";\nSELECT 2;'), ['SELECT 1 AS "x""y;z";', 'SELECT 2;']);
    });

    test('-- and /* inside a quoted identifier do not start a comment', () => {
        assert.deepStrictEqual(splitIntoStatements('SELECT 1 AS "a--b";\nSELECT 2;'), ['SELECT 1 AS "a--b";', 'SELECT 2;']);
        assert.deepStrictEqual(splitIntoStatements('SELECT 1 AS "a/*b";\nSELECT 2;'), ['SELECT 1 AS "a/*b";', 'SELECT 2;']);
        assert.deepStrictEqual(findStatementEnds('SELECT 1 AS "a--b"; SELECT 2;'), [18, 28]);
    });

    test('a quoted identifier next to a string literal', () => {
        assert.deepStrictEqual(
            splitIntoStatements(`SELECT 'it"s' AS "a';b"; SELECT 2;`),
            [`SELECT 'it"s' AS "a';b";`, 'SELECT 2;']
        );
    });

    test('statement at cursor', () => {
        const doc = 'SELECT 1 AS "a;b"\nFROM DUAL;\nSELECT 1 AS "c--d";\nSELECT 1 AS "e/*f";\nSELECT 2;';
        assert.strictEqual(findStatementAtCursor(doc, 1)?.text, 'SELECT 1 AS "a;b"\nFROM DUAL;');
        assert.strictEqual(findStatementAtCursor(doc, 2)?.text, 'SELECT 1 AS "c--d";');
        assert.strictEqual(findStatementAtCursor(doc, 3)?.text, 'SELECT 1 AS "e/*f";');
        assert.strictEqual(findStatementAtCursor(doc, 4)?.text, 'SELECT 2;');
    });

    test('statement ranges for CodeLens', () => {
        const doc = 'SELECT 1 AS "a;b"; SELECT 2;\nSELECT 1 AS "c--d";\nSELECT 1 AS "e/*f";\nSELECT 3;';
        assert.deepStrictEqual(
            findStatementRanges(doc).map(r => doc.slice(r.start, r.end + 1)),
            ['SELECT 1 AS "a;b";', 'SELECT 2;', 'SELECT 1 AS "c--d";', 'SELECT 1 AS "e/*f";', 'SELECT 3;']
        );
    });

    test('comment stripping keeps quoted identifiers', () => {
        assert.strictEqual(stripCommentsPreservingStrings('SELECT 1 AS "a--b" -- note\nFROM t'), 'SELECT 1 AS "a--b"  \nFROM t');
        assert.strictEqual(stripCommentsPreservingStrings('SELECT 1 AS "a/*b" /* c */'), 'SELECT 1 AS "a/*b"  ');
        assert.strictEqual(stripCommentsPreservingStrings('SELECT 1 AS "x""--y"'), 'SELECT 1 AS "x""--y"');
    });

    test('a comment after the ; stays with a statement that ends in a quoted identifier', () => {
        assert.deepStrictEqual(
            splitIntoStatements('SELECT 1 AS "a--b"; -- note\nSELECT 2;'),
            ['SELECT 1 AS "a--b"; -- note', 'SELECT 2;']
        );
    });

    test('script and function definitions with quoted names', () => {
        const script = 'CREATE OR REPLACE LUA SCRIPT S."s;--/*" AS\n  return 1;\n/\nSELECT 2;';
        assert.deepStrictEqual(splitIntoStatements(script), ['CREATE OR REPLACE LUA SCRIPT S."s;--/*" AS\n  return 1;', 'SELECT 2;']);
        assert.strictEqual(isScriptOrFunctionDefinition('CREATE SCRIPT "a;b" AS return 1;'), true);

        const fn = [
            'CREATE OR REPLACE FUNCTION S."f;--/*" (x IN NUMBER) RETURN NUMBER IS',
            '  "END;" NUMBER;',
            'BEGIN',
            '  "END;" := x;',
            '  RETURN "END;";',
            'END "f;--/*";',
            'SELECT 2;',
        ].join('\n');
        const statements = splitIntoStatements(fn);
        assert.strictEqual(statements.length, 2, JSON.stringify(statements));
        assert.ok(statements[0].endsWith('END "f;--/*";'));
        assert.strictEqual(isScriptOrFunctionDefinition(statements[0]), true);
    });
});
