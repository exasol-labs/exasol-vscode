// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        // Global ignores
        ignores: [
            'out/**',
            'dist/**',
            'node_modules/**',
            'media/**',
            'src/test/**',
        ],
    },
    {
        files: ['src/**/*.ts', 'src/**/*.tsx'],
        extends: [
            ...tseslint.configs.recommended,
        ],
        rules: {
            // `any` is fully eliminated from src/; keep it that way.
            // Query results are typed via the SqlRow generic on getRowsFromResult().
            '@typescript-eslint/no-explicit-any': 'error',

            // Error on unused vars; allow underscore-prefixed args
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
            ],

            // Modern JS hygiene
            'prefer-const': 'error',
            'no-var': 'error',
            'eqeqeq': 'warn',

            // Security
            'no-eval': 'error',
            'no-implied-eval': 'error',

            // Note: SQL-injection-via-template-literal prevention is enforced at the
            // source level via escapeSqlString/escapeSqlIdentifier wrappers (see utils.ts).
            // A no-restricted-syntax AST rule cannot reliably distinguish safe from
            // unsafe template literals in this context, so we document it here and
            // rely on the wrapper convention + code review instead.
        },
    },
);
