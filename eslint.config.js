import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import importPlugin from 'eslint-plugin-import';
import jestPlugin from 'eslint-plugin-jest';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

export default [
    // Ignores
    {
        ignores: ['node_modules/**', 'dist/**', 'cdk.out/**', 'coverage/**'],
    },

    // TypeScript files
    {
        files: ['**/*.ts', '**/*.tsx'],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                ecmaVersion: 'latest',
                sourceType: 'commonjs',
            },
            globals: { ...globals.node },
        },
        plugins: {
            '@typescript-eslint': tsPlugin,
            import: importPlugin,
        },
        settings: {
            'import/parsers': { '@typescript-eslint/parser': ['.ts', '.tsx'] },
            'import/resolver': { typescript: true },
        },
        rules: {
            // TS-aware unused vars
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            // Style / safety
            'prefer-const': 'warn',
            eqeqeq: ['error', 'smart'],
            '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
            // Import hygiene
            'import/order': [
                'warn',
                { groups: [['builtin', 'external'], ['parent', 'sibling', 'index']], 'newlines-between': 'always' },
            ],
        },
    },

    // Jest tests
    {
        files: ['test/**/*.ts', '**/*.spec.ts'],
        plugins: { jest: jestPlugin },
        languageOptions: {
            globals: { ...globals.node, ...globals.jest },
        },
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
        },
    },

    // Disable conflicting stylistic rules (use Prettier for formatting)
    prettierConfig,
];