import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { parseCsvHeader } from '../csvUtils';

suite('CSV Utils Test Suite', () => {
    let tmpDir: string;

    suiteSetup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-test-'));
    });

    suiteTeardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeTmpCsv(filename: string, content: string): string {
        const filePath = path.join(tmpDir, filename);
        fs.writeFileSync(filePath, content, 'utf-8');
        return filePath;
    }

    suite('parseCsvHeader', () => {
        test('Should parse simple comma-separated header', async () => {
            const filePath = writeTmpCsv('simple.csv', 'id,name,price\n1,Widget,9.99\n');
            const columns = await parseCsvHeader(filePath);
            assert.deepStrictEqual(columns, ['id', 'name', 'price']);
        });

        test('Should trim whitespace from column names', async () => {
            const filePath = writeTmpCsv('whitespace.csv', '  id , name , price  \n1,Widget,9.99\n');
            const columns = await parseCsvHeader(filePath);
            assert.deepStrictEqual(columns, ['id', 'name', 'price']);
        });

        test('Should handle quoted column names', async () => {
            const filePath = writeTmpCsv('quoted.csv', '"First Name","Last Name","Email"\nJohn,Doe,john@example.com\n');
            const columns = await parseCsvHeader(filePath);
            assert.deepStrictEqual(columns, ['First Name', 'Last Name', 'Email']);
        });

        test('Should handle quoted fields containing separator', async () => {
            const filePath = writeTmpCsv('separator-in-quotes.csv', '"Name, Full","Age","City, State"\nJohn,30,"New York, NY"\n');
            const columns = await parseCsvHeader(filePath);
            assert.deepStrictEqual(columns, ['Name, Full', 'Age', 'City, State']);
        });

        test('Should handle escaped double quotes inside quoted fields', async () => {
            const filePath = writeTmpCsv('escaped-quotes.csv', '"Say ""Hello""","Normal"\nvalue1,value2\n');
            const columns = await parseCsvHeader(filePath);
            assert.deepStrictEqual(columns, ['Say "Hello"', 'Normal']);
        });

        test('Should handle custom separator (semicolon)', async () => {
            const filePath = writeTmpCsv('semicolon.csv', 'id;name;price\n1;Widget;9.99\n');
            const columns = await parseCsvHeader(filePath, ';');
            assert.deepStrictEqual(columns, ['id', 'name', 'price']);
        });

        test('Should handle tab separator', async () => {
            const filePath = writeTmpCsv('tab.tsv', 'id\tname\tprice\n1\tWidget\t9.99\n');
            const columns = await parseCsvHeader(filePath, '\t');
            assert.deepStrictEqual(columns, ['id', 'name', 'price']);
        });

        test('Should handle single column', async () => {
            const filePath = writeTmpCsv('single.csv', 'id\n1\n2\n');
            const columns = await parseCsvHeader(filePath);
            assert.deepStrictEqual(columns, ['id']);
        });

        test('Should handle mixed quoted and unquoted fields', async () => {
            const filePath = writeTmpCsv('mixed.csv', 'id,"Full Name",email\n1,John Doe,john@example.com\n');
            const columns = await parseCsvHeader(filePath);
            assert.deepStrictEqual(columns, ['id', 'Full Name', 'email']);
        });

        test('Should throw error for empty file', async () => {
            const filePath = writeTmpCsv('empty.csv', '');
            await assert.rejects(
                () => parseCsvHeader(filePath),
                (err: Error) => {
                    assert.ok(err.message.includes('empty') || err.message.includes('no header'),
                        `Expected error about empty file, got: ${err.message}`);
                    return true;
                }
            );
        });

        test('Should throw error for file with only whitespace', async () => {
            const filePath = writeTmpCsv('whitespace-only.csv', '   \n\n');
            await assert.rejects(
                () => parseCsvHeader(filePath),
                (err: Error) => {
                    assert.ok(err.message.includes('empty') || err.message.includes('no header'),
                        `Expected error about empty file, got: ${err.message}`);
                    return true;
                }
            );
        });

        test('Should throw error for non-existent file', async () => {
            await assert.rejects(
                () => parseCsvHeader('/nonexistent/path/file.csv'),
                (err: Error) => {
                    assert.ok(err instanceof Error, 'Should throw an Error');
                    return true;
                }
            );
        });

        test('Should handle header-only file (no data rows)', async () => {
            const filePath = writeTmpCsv('header-only.csv', 'id,name,price\n');
            const columns = await parseCsvHeader(filePath);
            assert.deepStrictEqual(columns, ['id', 'name', 'price']);
        });

        test('Should handle header without trailing newline', async () => {
            const filePath = writeTmpCsv('no-newline.csv', 'id,name,price');
            const columns = await parseCsvHeader(filePath);
            assert.deepStrictEqual(columns, ['id', 'name', 'price']);
        });

        test('Should handle quoted fields with custom separator', async () => {
            const filePath = writeTmpCsv('quoted-semicolon.csv', '"Name; Full";"Age";"City"\nJohn;30;NYC\n');
            const columns = await parseCsvHeader(filePath, ';');
            assert.deepStrictEqual(columns, ['Name; Full', 'Age', 'City']);
        });

        test('Should handle Windows-style line endings (CRLF)', async () => {
            const filePath = writeTmpCsv('crlf.csv', 'id,name,price\r\n1,Widget,9.99\r\n');
            const columns = await parseCsvHeader(filePath);
            assert.deepStrictEqual(columns, ['id', 'name', 'price']);
        });
    });
});
