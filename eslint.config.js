import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import prettier from 'eslint-plugin-prettier';
import typescriptEslint from '@typescript-eslint/eslint-plugin';
import _import from 'eslint-plugin-import';
import { fixupPluginRules } from '@eslint/compat';
import globals from 'globals';
import tsParser from '@typescript-eslint/parser';
import js from '@eslint/js';
import { FlatCompat } from '@eslint/eslintrc';
import lodash from 'lodash';

const dir = dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({
    baseDirectory: dir,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all,
});

// add to this as you see fit, i just disabled most things to start with to prevent common issues
const allowedGlobals = [
    '__dirname',
    '__filename',
    'Array',
    'Buffer',
    'clearInterval',
    'clearTimeout',
    'console',
    'document',
    'fetch',
    'FormData',
    'global',
    'globalThis',
    'indexedDB',
    'IntersectionObserver',
    'localStorage',
    'location',
    'navigator',
    'Object',
    'process',
    'require',
    'ResizeObserver',
    'setInterval',
    'setTimeout',
    'URL',
    'window',
    'XMLHttpRequest',
];
const allGlobals = { ...globals.browser, ...globals.node };
const restrictedGlobals = Object.keys(allGlobals).filter(key => !allowedGlobals.includes(key));

export default [
    {
        ignores: [
            '**/.eslintrc.js',
            '**/.prettierrc.js',
            '**/build',
            '**/dist',
            '**/generated',
            '**/*.generated.ts',
            '**/_generated',
            '**/node_modules',
            '**/*.gen.ts',
        ],
    },
    ...compat.extends(
        'eslint:recommended',
        'plugin:@typescript-eslint/eslint-recommended',
        'plugin:@typescript-eslint/recommended',
        'prettier',
    ),
    {
        plugins: {
            prettier,
            '@typescript-eslint': typescriptEslint,
            import: fixupPluginRules(_import),

        },

        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.browser,
                STYLUS: 'readonly',
                _: 'readonly',
            },

            parser: tsParser,
            ecmaVersion: 5,
            sourceType: 'commonjs',

            parserOptions: {
                project: [
                    './tsconfig.eslint.json',
                    './scripts/tsconfig.json',
                    './evals/tsconfig.json',
                ],
                tsconfigRootDir: dir,
                ecmaFeatures: {
                    jsx: true,
                },
            },
        },

        settings: {
            'import/resolver': {
                node: {
                    extensions: ['.js', '.jsx', '.ts', '.tsx'],
                },
            },

        },

        rules: {
            'prettier/prettier': 1,
            '@typescript-eslint/ban-ts-comment': 0,
            '@typescript-eslint/consistent-type-imports': [
                1,
                {
                    prefer: 'type-imports',
                    fixStyle: 'inline-type-imports',
                },
            ],
            '@typescript-eslint/default-param-last': 1,
            '@typescript-eslint/explicit-module-boundary-types': 0,
            '@typescript-eslint/no-confusing-non-null-assertion': 2,
            '@typescript-eslint/no-empty-function': 0,
            '@typescript-eslint/no-empty-interface': 0,
            '@typescript-eslint/no-explicit-any': 0,
            '@typescript-eslint/no-extra-non-null-assertion': 2,
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-for-in-array': 2,
            '@typescript-eslint/no-implied-eval': 2,
            '@typescript-eslint/no-inferrable-types': 1,
            '@typescript-eslint/no-invalid-this': 2,
            '@typescript-eslint/no-misused-new': 2,
            '@typescript-eslint/no-misused-promises': [
                2,
                {
                    checksVoidReturn: {
                        arguments: false,
                        attributes: false,
                        properties: false,
                    },
                },
            ],
            '@typescript-eslint/no-namespace': 0,
            '@typescript-eslint/no-non-null-assertion': 0,
            '@typescript-eslint/no-this-alias': 2,
            '@typescript-eslint/no-unnecessary-boolean-literal-compare': 1,
            '@typescript-eslint/no-unused-vars': [
                1,
                {
                    ignoreRestSiblings: true,
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                },
            ],
            '@typescript-eslint/no-var-requires': 0,
            '@typescript-eslint/switch-exhaustiveness-check': [
                'error',
                {
                    allowDefaultCaseForExhaustiveSwitch: true,
                    considerDefaultExhaustiveForUnions: true,
                    requireDefaultForNonUnion: false,
                },
            ],
            '@typescript-eslint/no-empty-object-type': 1,
            '@typescript-eslint/unified-signatures': 1,
            'no-console': 0,
            'no-unsafe-optional-chaining': 2,
            'no-unused-vars': 0,
            'no-restricted-globals': ['error', ...restrictedGlobals],
            'no-restricted-imports': [
                2,
                {
                    patterns: [
                        {
                            group: ['lodash'],
                            importNames: Object.keys(lodash),
                            message: 'Use "import _ from \'lodash\'" instead',
                        },
                        {
                            group: ['@tanstack/react-router'],
                            importNames: ['redirect'],
                            message: 'Use the "useNavigate" hook instead of "redirect"',
                        },
                        {
                            group: ['antd'],
                            importNames: ['message', 'notification'],
                            message:
                                'Use "import { App } from "antd"; const { ... } = App.useApp()" instead',
                        },
                        {
                            group: ['*/_generated/server'],
                            importNames: ['query', 'mutation', 'action'],
                            message: 'Use functions.ts for query, mutation, or action',
                        },
                    ],
                },
            ],
            'import/newline-after-import': [
                1,
                {
                    count: 1,
                },
            ],
            'import/no-duplicates': 1,
            'import/no-unresolved': 0,
            'import/order': [
                1,
                {
                    'newlines-between': 'always',
                    groups: [
                        'builtin',
                        'external',
                        'internal',
                        ['index', 'sibling', 'parent'],
                        'object',
                        'type',
                    ],
                },
            ],


            'valtio/state-snapshot-rule': ['error'],
            'valtio/avoid-this-in-proxy': ['error'],
        },
    },
];
