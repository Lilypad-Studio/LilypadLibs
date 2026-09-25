import { defineConfig, globalIgnores } from 'eslint/config';
import eslintPluginImport from 'eslint-plugin-import';
import eslintPluginPrettier from 'eslint-plugin-prettier';
import eslintPluginTypescript from '@typescript-eslint/eslint-plugin';
import tsParser from "@typescript-eslint/parser";

// The recommended rules that use type information, for the TypeScript files
const recommendedTypeChecked = eslintPluginTypescript.configs['flat/recommended-type-checked'].map(
  (config) => ({ ...config, files: ['**/*.ts', '**/*.tsx'] })
);

const eslintConfig = defineConfig([
  ...recommendedTypeChecked,
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
      '@typescript-eslint/no-require-imports': 'error',
      // Unhandled rejections terminate the Node.js process: every promise must be awaited,
      // returned, or explicitly marked as fire-and-forget with `void`.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // General Best Practices
      curly: ['warn', 'all'], // Always use braces for clarity
      eqeqeq: ['warn', 'always'], // Enforce strict equality checks
      'no-throw-literal': 'warn', // Prevent throwing literals as exceptions
      semi: ['warn', 'always'], // Enforce semicolons
    },
  },
  {
    // Mocks are often async without awaiting, and read loosely typed mock data
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  // The build output is generated
  globalIgnores(['dist/**']),
]);

export default eslintConfig;
