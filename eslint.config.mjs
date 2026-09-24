import { defineConfig, globalIgnores } from 'eslint/config';
import eslintPluginImport from 'eslint-plugin-import';
import eslintPluginPrettier from 'eslint-plugin-prettier';
import eslintPluginTypescript from '@typescript-eslint/eslint-plugin';
import tsParser from "@typescript-eslint/parser";

const eslintConfig = defineConfig([
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      import: eslintPluginImport,
      prettier: eslintPluginPrettier,
      '@typescript-eslint': eslintPluginTypescript,
    },
    rules: {
      'prettier/prettier': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/naming-convention': [
        'warn',
        {
          selector: 'import',
          format: ['camelCase', 'PascalCase'],
        },
      ],
      '@typescript-eslint/no-var-requires': 'error',
      // Unhandled rejections terminate the Node.js process: every promise must be awaited,
      // returned, or explicitly marked as fire-and-forget with `void`.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        // Async overrides of sync methods (e.g. LilypadDbCache.invalidate/dispose) are intended:
        // the base classes never call them without awaiting the result.
        { checksVoidReturn: { inheritedMethods: false } },
      ],

      // General Best Practices
      curly: ['warn', 'all'], // Always use braces for clarity
      eqeqeq: ['warn', 'always'], // Enforce strict equality checks
      'no-throw-literal': 'warn', // Prevent throwing literals as exceptions
      semi: ['warn', 'always'], // Enforce semicolons
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    'dist/**',
  ]),
]);

export default eslintConfig;
