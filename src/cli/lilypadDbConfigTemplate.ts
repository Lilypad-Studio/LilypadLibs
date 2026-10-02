import { LILYPAD_DEFAULT_DB_CONFIG_NAME } from '@/dbConfig/LilypadDbConfigDefaults';

export type LilypadDbConfigTemplateOptions = {
  /** The name of the config (`default`: no `name` option in the file). */
  name: string;
  /** A TypeScript file (with the row type of the example table), or JavaScript. */
  typescript: boolean;
  /** No example table: `tables: {}`, with the example as a comment. */
  empty: boolean;
};

/** The comment at the top of the file. */
function header(typescript: boolean): string {
  return [
    '// The database config of @lilypad-studio/libs: the tables the application uses, and what the database',
    '// must provide for them. The application imports it to create its gates and caches;',
    '// `npx lilypad-doctor` checks the database against it, and prints the SQL that fixes what differs.',
    '//',
    "// Node.js loads it without a bundler: import only '@lilypad-studio/libs/schema' and relative files with",
    typescript
      ? "// their extension (e.g. './db/users.ts'). Import the row types with `import type` (erased before"
      : "// their extension (e.g. './db/users.mjs'), without path aliases.",
    ...(typescript
      ? ["// loading, so path aliases work there: import type { User } from '@/types/user')."]
      : []),
    '// Keep the application code out of it: bind the functions applied to the rows where the',
    '// application creates its gate, with bindLilypadDbHooks(db, { example: { write, select } }).',
  ].join('\n');
}

/** The lines of the example table, from `const example = ...` to its end. */
function exampleTable(typescript: boolean): string[] {
  return [
    ...(typescript
      ? [
          '/** A row of the `example` table, as the application reads it. */',
          'type Example = {',
          '  id: number;',
          '  name: string;',
          '  createdAt: Date;',
          '};',
          '',
          "const example = defineLilypadTable<Example, 'id'>({",
        ]
      : ['const example = defineLilypadTable({']),
    "  tableName: 'example', // or 'schema.example'",
    "  primaryKey: 'id',",
    '  generatedPrimaryKey: true, // the database generates the id',
    '  // pgType gives the type of the row property (int4: number, text: string, timestamptz: Date...);',
    "  // declare it for the other types: { type: 'string', pgType: 'user_role' } (an enum)",
    '  cols: {',
    "    id: { pgType: 'int4' },",
    "    name: { pgType: 'text', nullable: false, unique: true },",
    "    createdAt: { pgType: 'timestamptz', nullable: false, default: { sql: 'now()' } },",
    '  },',
    "  // unique: [{ columns: ['name', 'createdAt'] }],",
    "  // foreignKeys: [{ columns: ['ownerId'], references: { table: 'owners', onDelete: 'cascade' } }],",
    "  // indexes: [{ columns: ['createdAt'] }],",
    `  // checks: [{ name: 'example_name_check', expression: "name <> ''" }],`,
    '  // How LilypadDbCache follows the changes made elsewhere: listen (long-running servers),',
    "  // { strategy: 'changelog', pollInterval: 5_000 } (serverless platforms), or { strategy: 'none' }",
    "  sync: { strategy: 'listen' },",
    "  // access: 'read', // the application only reads it: its appRole gets no write of it",
    '});',
  ];
}

/**
 * The content of a new config file: an example table (or none), and the options of the config
 * with their defaults, as comments.
 */
export function lilypadDbConfigTemplate({
  name,
  typescript,
  empty,
}: LilypadDbConfigTemplateOptions): string {
  const table = exampleTable(typescript);
  const lines = [
    header(typescript),
    empty
      ? "import { defineLilypadDb } from '@lilypad-studio/libs/schema';"
      : "import { defineLilypadDb, defineLilypadTable } from '@lilypad-studio/libs/schema';",
    '',
    ...(empty
      ? [
          '// Describe each table with defineLilypadTable (imported from the same module), e.g.:',
          '//',
          ...table.map((line) => (line === '' ? '//' : `// ${line}`)),
        ]
      : table),
    '',
    'export default defineLilypadDb({',
    ...(name === LILYPAD_DEFAULT_DB_CONFIG_NAME ? [] : [`  name: '${name}',`]),
    "  // defaultSchema: 'public', // the schema of the tables whose name is not qualified",
    "  // notifyChannel: 'cache_events', // the channel of the 'listen' tables",
    "  // changelog: { table: 'lilypad_cache_changes', pruning: 'detect' }, // for the 'changelog' tables",
    '  // strict: false, // true: lilypad-doctor also reports what the database has and the config lacks, and an over-privileged appRole',
    '  // maxStatementTimeout: 60_000, // the longest statement_timeout lilypad-doctor accepts for the app role (false: not checked)',
    "  // appRole: 'app_user', // the role the application connects as (default: the role of lilypad-doctor)",
    empty ? '  tables: {},' : '  tables: { example },',
    '});',
    '',
  ];
  return lines.join('\n');
}
