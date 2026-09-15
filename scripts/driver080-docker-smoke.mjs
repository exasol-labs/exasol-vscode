import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parquetWriteFile } from 'hyparquet-writer';
import { WebSocket } from 'ws';

// The VS Code extension is bundled for Node and resolves the driver's CommonJS
// entry point. Use the same entry point here; the 0.8.0 ESM bundle currently
// exposes an uninitialised node-forge namespace under native Node ESM imports.
const { ExasolDriver } = createRequire(import.meta.url)('@exasol/exasol-driver-ts');

const schema = 'COMPAT_DRIVER_080';
const table = `${schema}.T`;
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exasol-driver-080-'));
const parquetPath = path.join(tempDir, 'input.parquet');
const csvPath = path.join(tempDir, 'output.csv');
const driver = new ExasolDriver(
    url => new WebSocket(url, { rejectUnauthorized: false }),
    {
        host: process.env.EXASOL_HOST ?? '127.0.0.1',
        port: Number(process.env.EXASOL_PORT ?? 8563),
        user: process.env.EXASOL_USER ?? 'sys',
        password: process.env.EXASOL_PASSWORD ?? 'exasol',
        clientName: 'exasol-vscode-driver-test',
        clientVersion: '0.0.0'
    }
);

try {
    await driver.connect();
    const session = await driver.query('SELECT CLIENT, DRIVER, ENCRYPTED FROM SYS.EXA_ALL_SESSIONS WHERE SESSION_ID = CURRENT_SESSION');
    assert.equal(session.resultSet.data[0][0], 'exasol-vscode-driver-test 0.0.0');
    assert.match(session.resultSet.data[1][0], /^exasol-driver-ts v0\.8\.0/);
    assert.equal(session.resultSet.data[2][0], true);
    await driver.execute(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await driver.execute(`DROP TABLE IF EXISTS ${table}`);
    await driver.execute(`CREATE TABLE ${table} (N DECIMAL(10, 0), LABEL VARCHAR(50))`);

    await parquetWriteFile({
        filename: parquetPath,
        columnData: [
            { name: 'N', data: [1, 2], type: 'INT32' },
            { name: 'LABEL', data: ['alpha', 'beta'], type: 'STRING' }
        ]
    });
    const abortedImport = new AbortController();
    abortedImport.abort();
    await assert.rejects(
        driver.importFromParquetFile(table, parquetPath, {}, { signal: abortedImport.signal }),
        /aborted/i
    );
    const imported = await driver.importFromParquetFile(table, parquetPath, {}, { signal: new AbortController().signal });
    assert.equal(imported, 2);

    const result = await driver.query(`SELECT N, LABEL FROM ${table} ORDER BY N`);
    assert.deepEqual(result.resultSet.data, [[1, 2], ['alpha', 'beta']]);

    const exported = await driver.exportToCsvFile(table, csvPath, { withColumnNames: true }, { signal: new AbortController().signal });
    assert.equal(exported, 2);
    const csv = await fs.readFile(csvPath, 'utf8');
    assert.match(csv, /N,LABEL/);
    assert.match(csv, /1,alpha/);
    assert.match(csv, /2,beta/);

    const abortedExport = new AbortController();
    abortedExport.abort();
    await assert.rejects(
        driver.exportToCsvFile(table, path.join(tempDir, 'aborted.csv'), undefined, { signal: abortedExport.signal }),
        /aborted/i
    );

    console.log('Driver 0.8.0 Docker smoke test: PASS (Parquet import + CSV export)');
} finally {
    try {
        await driver.execute(`DROP TABLE IF EXISTS ${table}`);
        await driver.execute(`DROP SCHEMA ${schema} CASCADE`);
    } catch {
        // Preserve the original test failure if cleanup cannot connect.
    }
    await driver.close();
    await fs.rm(tempDir, { recursive: true, force: true });
}
