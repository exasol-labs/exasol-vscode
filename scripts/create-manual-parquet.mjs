import { parquetWriteFile } from 'hyparquet-writer';

await parquetWriteFile({
    filename: 'manual-test-data/import-test.parquet',
    columnData: [
        { name: 'N', data: [1, 2, 3], type: 'INT32' },
        { name: 'LABEL', data: ['alpha', 'beta', 'comma, value'], type: 'STRING' },
        { name: 'AMOUNT', data: [10.5, 20.25, 30], type: 'DOUBLE' }
    ]
});

console.log('Created manual-test-data/import-test.parquet');
