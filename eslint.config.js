// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import regexp from 'eslint-plugin-regexp';
import noComputedObjectKey from './tools/eslint-rules/no-computed-object-key.js';

const NODE_GLOBALS = [
  'Buffer',
  'process',
  'require',
  'module',
  '__dirname',
  '__filename',
  'global',
  'setImmediate',
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', 'corpus/**', 'hostile/**', 'site/**', '**/*.config.*'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  regexp.configs['flat/recommended'],
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // SEC-7: no super-linear regular expressions.
      'regexp/no-super-linear-backtracking': 'error',
      'regexp/no-super-linear-move': 'error',
      // SEC-11: never run content.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      // SEC-6: no prototype tricks.
      'no-proto': 'error',
      // Section 15: the library logs nothing.
      'no-console': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // RT-2: the core uses only web-standard APIs. Node-only code lives in src/node.
    files: ['packages/docsluice/src/**/*.ts'],
    ignores: ['packages/docsluice/src/node/**'],
    plugins: {
      docsluice: { rules: { 'no-computed-object-key': noComputedObjectKey } },
    },
    rules: {
      // SEC-6: file data must never be used as a plain-object key.
      'docsluice/no-computed-object-key': 'error',
      'no-restricted-globals': ['error', ...NODE_GLOBALS],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'node:*',
                'fs',
                'path',
                'os',
                'stream',
                'buffer',
                'zlib',
                'crypto',
                'worker_threads',
                'child_process',
                'http',
                'https',
                'net',
              ],
              message: 'Core code must be runtime-neutral (RT-2). Put Node code in src/node.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Repo scripts run on Node and talk to the user.
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
    rules: { 'no-console': 'off' },
  },
  {
    // Docs recipes run on any runtime with web-standard globals (ADR 0013).
    files: ['examples/**/*.mjs'],
    languageOptions: { globals: { AbortSignal: 'readonly', TextEncoder: 'readonly' } },
  },
);
