import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';
import { importX } from 'eslint-plugin-import-x';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import vitest from '@vitest/eslint-plugin';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import { edgeFolders } from './edge.config.ts';

// The modules of the edge-compatible entries (every entry except `db`, and the command), listed in
// edge.config.ts. The typecheck (tsconfig.edge.json) and entries.test.ts check them too: these
// rules name the import in the editor
const edgeModules = [
  'src/index.ts',
  'src/entries/!(db).ts',
  ...edgeFolders.map((folder) => `src/${folder}/**/*.ts`),
];
const nodeOnlyModules = ['**/*.test.ts'];

export default defineConfig([
  globalIgnores(['dist/', 'coverage/', 'api-docs/']),
  {
    plugins: { 'import-x': importX },
    settings: {
      'import-x/resolver-next': [createTypeScriptImportResolver()],
    },
  },
  {
    files: ['**/*.{ts,mts,cts}'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Unhandled rejections terminate the Node.js process: every promise must be awaited,
      // returned, or explicitly marked as fire-and-forget with `void`.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        // `typeof import('...')` is how vi.mock types the original module
        { fixStyle: 'inline-type-imports', disallowTypeAnnotations: false },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
      // Rethrowing what a `catch` received
      '@typescript-eslint/prefer-promise-reject-errors': ['error', { allowThrowingUnknown: true }],
      // The library defends itself against JavaScript callers and untyped configs (`typeof x !==
      // 'object'`), and against the runtimes whose types differ from Node.js's (`timer.unref?.()`)
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // False positives on the keys of generic objects: the codebase has no enum
      '@typescript-eslint/no-unsafe-enum-assignment': 'off',
      // Deliberate no-ops (`.catch(() => {})`, the release of a non-singleton)
      '@typescript-eslint/no-empty-function': 'off',
      // With noUncheckedIndexedAccess, `!` marks an index or a lookup the code has just checked
      '@typescript-eslint/no-non-null-assertion': 'off',
      // The codebase declares its object types with `type`
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      // Template literals format numbers, booleans and nullish values the way the messages expect
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowNullish: true },
      ],

      // A value cycle between modules breaks the order in which they initialize
      'import-x/no-cycle': 'error',
      'import-x/no-duplicates': ['error', { 'prefer-inline': true }],
      'import-x/no-extraneous-dependencies': 'error',
      'import-x/no-self-import': 'error',

      curly: ['warn', 'all'], // Always use braces for clarity
      eqeqeq: ['warn', 'always'], // Enforce strict equality checks
    },
  },
  {
    files: edgeModules,
    ignores: nodeOnlyModules,
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*'],
              message: 'The edge-compatible modules must not use Node.js APIs.',
            },
            {
              group: ['postgres', '@/dbGate/*', '@/cli/*'],
              allowTypeImports: true,
              message: 'Only the `db` entry may reach postgres.js and the gate.',
            },
          ],
        },
      ],
      // The typecheck resolves `import('postgres')` (postgres.js has its types), and the import
      // rules ignore dynamic imports: the edge modules import statically only
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression',
          message:
            'The edge-compatible modules import statically, so that the checks of their imports see every import.',
        },
      ],
    },
  },
  {
    // Mocks are often async without awaiting, and read loosely typed mock data
    files: ['**/*.test.ts'],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      // `expect(value, message)`
      'vitest/valid-expect': ['error', { maxArgs: 2 }],
      'vitest/expect-expect': ['error', { assertFunctionNames: ['expect', 'expect*'] }],
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Mocks and no-op callbacks
      '@typescript-eslint/no-empty-function': 'off',
      // The tests reach the internals of the classes: `cache['engine']`
      '@typescript-eslint/dot-notation': 'off',
      // The tests probe what the types rule out (a JavaScript caller, a key of the wrong type) and
      // check that the channel methods of the logger return nothing
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-unnecessary-type-conversion': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },
  {
    // The config files of the tools run in Node.js
    files: ['*.config.{ts,mjs}'],
    rules: { 'import-x/no-extraneous-dependencies': ['error', { devDependencies: true }] },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  // Formatting is Prettier's (`npm run format`): turns off the rules it would conflict with
  eslintConfigPrettier,
]);
