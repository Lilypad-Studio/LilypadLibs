import type {
  LilypadDbCheck,
  LilypadDbColumn,
  LilypadDbIndexMethod,
  LilypadDbReference,
  LilypadDbReferentialAction,
  LilypadDbSchema,
} from '@/dbConfig/LilypadDbSchema';
import {
  LILYPAD_DEFAULT_CHANGELOG_TABLE,
  LILYPAD_DEFAULT_DB_CONFIG_NAME,
  LILYPAD_DEFAULT_DB_SCHEMA,
  LILYPAD_DEFAULT_MAX_GAP,
  LILYPAD_DEFAULT_MAX_STATEMENT_TIMEOUT,
  LILYPAD_DEFAULT_NOTIFY_CHANNEL,
} from '@/dbConfig/LilypadDbConfigDefaults';
import { validateLilypadDbConfigInput } from '@/dbConfig/LilypadDbConfigValidation';
import type { LilypadDbTableHooks, LilypadDbTableHooksBase } from '@/dbConfig/LilypadDbHooks';
import { lilypadColumnTypesOfPgType } from '@/dbConfig/LilypadPgTypes';

/**
 * The config of a database: the tables the library reads and writes, how each one is kept in sync,
 * and what the database must provide for it (the changelog, the notification triggers, the
 * pruning). The application imports it at runtime, where nothing is compared with the database;
 * `lilypad-doctor` loads the same file and checks the database against it. It holds no function:
 * the application binds the functions applied to the rows with `bindLilypadDbHooks`.
 */

/** Marks the objects made by `defineLilypadDb` (shared by every copy of the library). */
const LILYPAD_DB_CONFIG: unique symbol = Symbol.for('lilypad.dbConfig');
/** Marks the table definitions made by `defineLilypadDb`. */
const LILYPAD_DB_TABLE: unique symbol = Symbol.for('lilypad.dbTable');
/** Carries the row type of a definition, for the types only. */
declare const lilypadRowType: unique symbol;

/**
 * How the old changelog rows are deleted:
 * - `detect`: the check looks for the `prune` option of the trigger and for a pg_cron job that
 *   deletes them, and suggests the best one for the database if it finds neither;
 * - `trigger`: the same, but it always suggests the `prune` option of the trigger;
 * - `cron`: the same, but it always suggests a pg_cron job, even where it cannot tell whether
 *   pg_cron runs in this database (e.g. when the role cannot read `cron.database_name`);
 * - `external`: a job the database cannot show deletes them (e.g. `pruneLilypadChangelog` called
 *   from a scheduled function): nothing is suggested, only the age of the oldest row is checked.
 */
export type LilypadChangelogPruning = 'detect' | 'trigger' | 'cron' | 'external';

/** The options shared by the strategies that see every change of the table. */
export type LilypadDbTableTrustedSync = {
  /**
   * While the sync is trusted, an entry read from the database (not a copy from the shared
   * level, nor a fallback after an error) that reaches its TTL with no change of its row is
   * kept, without a query, until it is this old (ms). It bounds how long a change the triggers
   * do not see (disabled triggers, `session_replication_role = replica`) goes unnoticed. The TTL
   * still bounds the shared level. `0` queries the row again at each TTL. Defaults to 1 hour.
   */
  maxAge?: number | undefined;
};

export type LilypadDbTableListenSync = LilypadDbTableTrustedSync & {
  strategy: 'listen';
  /**
   * `eager` (default): `create` resolves once `LISTEN` is active, and rejects if it fails.
   * `lazy`: `LISTEN` starts on the first read, so creating the cache opens no connection.
   */
  connect?: 'eager' | 'lazy' | undefined;
  /**
   * If false, the cache does not apply the notifications: keeping it up to date is then up to
   * `onNotification` (an option of `LilypadDbCache.create`), and entries are never kept past their
   * TTL. Defaults to true.
   */
  applyChanges?: boolean | undefined;
};

export type LilypadDbTableChangelogSync = LilypadDbTableTrustedSync & {
  strategy: 'changelog';
  /** Minimum time between two reads of the changelog, in ms. Changes are seen within it. */
  pollInterval: number;
  /**
   * `await` (default): a read that is due waits for the changelog (at most the `fetchTimeout` of
   * the cache), so it does not return data older than `pollInterval` unless the read fails.
   * `background`: the read does not wait, and may return data one interval older.
   */
  poll?: 'await' | 'background' | undefined;
  /**
   * If the changelog has not been read for this long (ms), the instance no longer trusts it:
   * every entry is expired instead. It must be much shorter than the retention of the
   * changelog: `lilypad-doctor` reports a pruning with a shorter one. Defaults to 1 hour.
   */
  maxGap?: number | undefined;
  /**
   * On the first read, or after `maxGap`, the changes of this many ms are applied, so that
   * copies in the shared level older than those changes are removed too: a row stays in the shared
   * level for at most this long after it was read (0: never written there). Defaults to the TTL
   * plus `staleWhileRevalidate`, plus 1 minute: declare it when that exceeds `maxGap`, so that
   * `lilypad-doctor` checks the retention for it.
   */
  lookback?: number | undefined;
};

/**
 * How `LilypadDbCache` learns about the changes made by other instances and other programs.
 *
 * - `listen` (default): `LISTEN/NOTIFY` on a dedicated connection, on the `notifyChannel` of the
 *   config. Near real-time, for long-running servers. Not suited to serverless platforms: the
 *   connection must stay open, it does not work through a pooler in transaction mode, and
 *   notifications sent while an instance is suspended are lost. Notifications are only hints (any
 *   role can send them): the cache reads the rows again, it never trusts their content.
 * - `changelog`: each instance reads the changelog table of the config at most once per
 *   `pollInterval`, when the cache is used. The caches of a gate read their tables together, in one
 *   query. No long-lived connection: suited to serverless platforms.
 * - `none`: only the writes of this instance and the TTL keep the cache up to date.
 *
 * `listen` and `changelog` rely on triggers that the library does not install at runtime (see
 * `lilypadChangelogSql`): `lilypad-doctor` checks them, and prints the SQL that installs them.
 *
 * While `listen` or `changelog` is trusted (`LISTEN` active and its heartbeat recent; changelog
 * read within `maxGap`, and a read applied within `pollInterval`, two with `poll: 'background'`),
 * the cache sees every change of the table, so the TTL no longer needs a query: an entry that
 * reaches its TTL without a change of its row is kept until `maxAge`.
 */
export type LilypadDbTableSync =
  LilypadDbTableListenSync | LilypadDbTableChangelogSync | { strategy: 'none' };

/**
 * A table of a config, before `defineLilypadDb` resolves it: its description, how it is kept in
 * sync, and whether `lilypad-doctor` also reports what the database has and the description lacks.
 */
export type LilypadDbTableInput<T, PK extends keyof T = keyof T> = LilypadDbSchema<T, PK> & {
  /** Defaults to `{ strategy: 'listen' }`. */
  sync?: LilypadDbTableSync | undefined;
  /** Overrides the `strict` of the config for this table. */
  strict?: boolean | undefined;
};

/** A unique key, resolved: its columns, including the `unique` columns. */
export type LilypadDbResolvedUniqueKey = { name?: string | undefined; columns: readonly string[] };

/** A foreign key, resolved: the referenced table is qualified, and every default is applied. */
export type LilypadDbResolvedForeignKey = {
  name?: string | undefined;
  columns: readonly string[];
  references: { table: string; columns: readonly string[] };
  onDelete: LilypadDbReferentialAction;
  onUpdate: LilypadDbReferentialAction;
};

export type LilypadDbResolvedIndex = {
  name?: string | undefined;
  columns: readonly string[];
  unique: boolean;
  using: LilypadDbIndexMethod;
};

/** The settings of the config that a table definition carries. */
export type LilypadDbConfigSettings = {
  /** The name of the config (`default` for `lilypad.config.*`). */
  readonly name: string;
  readonly defaultSchema: string;
  /** The channel of the `listen` strategy. */
  readonly notifyChannel: string;
  /** The changelog table of the `changelog` strategy. */
  readonly changelogTable: string;
};

/** What every table definition has, whatever its row type. */
export type LilypadDbTableDefinitionBase = {
  readonly [LILYPAD_DB_TABLE]: true;
  readonly [lilypadRowType]?: unknown;
  /** The key of the table in the `tables` of the config. */
  readonly key: string;
  /** The name of the table, unqualified. */
  readonly tableName: string;
  /** Its PostgreSQL schema. */
  readonly schemaName: string;
  /** `schema.table`: every query of the library names the table this way. */
  readonly qualifiedName: string;
  readonly primaryKey: PropertyKey;
  readonly generatedPrimaryKey?: boolean | undefined;
  /** The functions bound to the table by `bindLilypadDbHooks`, if any. */
  readonly hooks?: LilypadDbTableHooksBase | undefined;
  readonly cols: Readonly<Record<string, LilypadDbColumn>>;
  readonly sync: LilypadDbTableSync;
  readonly strict: boolean;
  readonly unique: readonly LilypadDbResolvedUniqueKey[];
  readonly foreignKeys: readonly LilypadDbResolvedForeignKey[];
  readonly indexes: readonly LilypadDbResolvedIndex[];
  readonly checks: readonly LilypadDbCheck[];
  /** The settings of the config the table belongs to. */
  readonly db: LilypadDbConfigSettings;
};

/**
 * A table of a config (`db.tables.users`), as `gate.table()` and `LilypadDbCache.create()` take it.
 * Only `defineLilypadDb` makes them.
 *
 * @typeParam T - The row type.
 * @typeParam PK - The primary key column.
 */
export type LilypadDbTableDefinition<T, PK extends keyof T = keyof T> = Omit<
  LilypadDbTableDefinitionBase,
  typeof lilypadRowType | 'primaryKey' | 'hooks' | 'cols'
> & {
  readonly [lilypadRowType]?: T | undefined;
  readonly primaryKey: PK;
  readonly hooks?: LilypadDbTableHooks<T> | undefined;
  readonly cols: { readonly [K in keyof T]-?: LilypadDbColumn };
};

/** The input of a table, whatever its row type. */
export type LilypadDbTableInputBase = Omit<
  LilypadDbTableInput<Record<string, unknown>, string>,
  'cols' | 'primaryKey' | 'unique' | 'foreignKeys' | 'indexes'
> & {
  readonly [lilypadRowType]?: unknown;
  primaryKey: PropertyKey;
  cols: Readonly<Record<string, LilypadDbColumn>>;
  unique?: readonly { name?: string | undefined; columns: readonly string[] }[] | undefined;
  foreignKeys?:
    | readonly {
        name?: string | undefined;
        columns: readonly string[];
        references: LilypadDbReference;
      }[]
    | undefined;
  indexes?:
    | readonly {
        name?: string | undefined;
        columns: readonly string[];
        unique?: boolean | undefined;
        using?: LilypadDbIndexMethod | undefined;
      }[]
    | undefined;
};

/** A table input made by `defineLilypadTable`, which carries its row type. */
export type LilypadDbTableDraft<T, PK extends keyof T = keyof T> = LilypadDbTableInput<T, PK> & {
  readonly [lilypadRowType]?: T | undefined;
};

/**
 * The definition `defineLilypadDb` makes of a table input: typed by `defineLilypadTable`, or else
 * with the columns of `cols` (of unknown types).
 */
export type LilypadDbTableDefinitionOf<I> =
  I extends LilypadDbTableDraft<infer T, infer PK>
    ? LilypadDbTableDefinition<T, PK>
    : I extends { cols: infer Cols; primaryKey: infer PK }
      ? LilypadDbTableDefinition<{ [K in keyof Cols]: unknown }, PK & keyof Cols>
      : LilypadDbTableDefinitionBase;

export type LilypadDbConfigInput<Tables extends Record<string, LilypadDbTableInputBase>> = {
  /**
   * The name of the config: `default` (the default) for `lilypad.config.*`, the `<name>` of
   * `lilypad.<name>.config.*` for the others. Letters, digits, `_` and `-`.
   */
  name?: string | undefined;
  /** The schema of the tables whose name is not qualified. Defaults to `public`. */
  defaultSchema?: string | undefined;
  /** The channel the triggers notify, for the `listen` tables. Defaults to `cache_events`. */
  notifyChannel?: string | undefined;
  /** The changelog, for the `changelog` tables. */
  changelog?:
    | {
        /** Defaults to `lilypad_cache_changes`. */
        table?: string | undefined;
        /** How the old rows are deleted (see {@link LilypadChangelogPruning}). Defaults to `detect`. */
        pruning?: LilypadChangelogPruning | undefined;
        /**
         * The shortest retention of the changelog, in ms: a pruning found with a retention that is not
         * longer is an error. `lilypad-doctor` also raises it to the `maxGap` and `lookback` of each
         * table. Defaults to 1 hour.
         */
        minRetention?: number | undefined;
      }
    | undefined;
  /**
   * `lilypad-doctor` also warns about what the database has and the description lacks: columns,
   * foreign keys, unique keys and indexes. Defaults to false.
   */
  strict?: boolean | undefined;
  /**
   * The longest `statement_timeout` that `lilypad-doctor` accepts for the role it connects as, in
   * ms: a longer one, or none (`0`), is a warning. Without it, a query stuck on a lock or a dead
   * connection holds its connection of the pool, and its caller, for as long as it lasts (the gate
   * sets no timeout by default). `false` skips the check, e.g. when the doctor connects as another
   * role than the application. Defaults to 1 minute.
   */
  maxStatementTimeout?: number | false | undefined;
  /** The tables, by key: `db.tables.<key>`. */
  tables: Tables;
};

/** A config made by {@link defineLilypadDb}. */
export type LilypadDbConfig<
  Tables extends Record<string, LilypadDbTableDefinitionBase> = Record<
    string,
    LilypadDbTableDefinitionBase
  >,
> = {
  readonly [LILYPAD_DB_CONFIG]: true;
  readonly name: string;
  readonly defaultSchema: string;
  readonly notifyChannel: string;
  readonly changelog: {
    readonly table: string;
    readonly pruning: LilypadChangelogPruning;
    readonly minRetention: number;
  };
  readonly strict: boolean;
  readonly maxStatementTimeout: number | false;
  readonly tables: Tables;
};

/** The keys of the tables of a config. */
export type LilypadDbTableName<C> =
  C extends LilypadDbConfig<infer Tables> ? keyof Tables & string : never;

/**
 * The row type of a table of a config (`Record<string, unknown>` when the config type does not
 * carry it, e.g. on a gate typed `LilypadDbGate`).
 */
export type LilypadDbRow<C, N> =
  C extends LilypadDbConfig<infer Tables>
    ? N extends keyof Tables
      ? Tables[N] extends LilypadDbTableDefinition<infer T extends object, infer _PK>
        ? T
        : Record<string, unknown>
      : never
    : never;

/** The primary key column of a table of a config. */
export type LilypadDbPrimaryKey<C, N> =
  C extends LilypadDbConfig<infer Tables>
    ? N extends keyof Tables
      ? Tables[N] extends { readonly primaryKey: infer PK }
        ? PK & keyof LilypadDbRow<C, N>
        : never
      : never
    : never;

/**
 * Describes a table, for the `tables` of {@link defineLilypadDb}. It returns its input: it only
 * carries the row type.
 *
 * @example
 * ```typescript
 * export const users = defineLilypadTable<User, 'id'>({
 *   tableName: 'users',
 *   primaryKey: 'id',
 *   generatedPrimaryKey: true,
 *   cols: {
 *     id: { pgType: 'int4' },
 *     orgId: { pgType: 'int4', references: { table: 'orgs', onDelete: 'cascade' } },
 *     email: { pgType: 'text', nullable: false, unique: true },
 *     role: { type: 'string', pgType: 'user_role' }, // an enum: declare its type
 *   },
 *   indexes: [{ columns: ['orgId'] }],
 *   sync: { strategy: 'changelog', pollInterval: 1000 },
 * });
 * ```
 */
export function defineLilypadTable<T, PK extends keyof T = keyof T>(
  input: LilypadDbTableInput<T, PK>
): LilypadDbTableDraft<T, PK> {
  return input;
}

/** Whether a value is a config made by {@link defineLilypadDb} (by any copy of the library). */
export function isLilypadDbConfig(value: unknown): value is LilypadDbConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[LILYPAD_DB_CONFIG] === true
  );
}

/** Whether a value is a table definition made by {@link defineLilypadDb}. */
export function isLilypadDbTableDefinition(value: unknown): value is LilypadDbTableDefinitionBase {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[LILYPAD_DB_TABLE] === true
  );
}

/**
 * The table definition passed to `gate.table()` or `LilypadDbCache.create()`: a definition, or
 * the key of a table in `config`. A definition without hooks of a table of `config` takes the
 * hooks bound to it there (see {@link withConfigHooks}).
 *
 * @throws If it is neither.
 */
export function resolveLilypadDbTable(
  owner: string,
  table: unknown,
  config: LilypadDbConfig | undefined
): LilypadDbTableDefinitionBase {
  if (typeof table === 'string') {
    if (!config) {
      throw new Error(
        `${owner}: the table "${table}" is given by name, but there is no config to find it in (pass \`config\`, or create the gate with one).`
      );
    }
    const definition = Object.hasOwn(config.tables, table) ? config.tables[table] : undefined;
    if (!definition) {
      throw new Error(`${owner}: the config "${config.name}" has no table "${table}".`);
    }
    return definition;
  }
  if (!isLilypadDbTableDefinition(table)) {
    throw new Error(
      `${owner}: the table must be a table of a config made with defineLilypadDb (e.g. db.tables.users), or its name.`
    );
  }
  return withConfigHooks(table, config);
}

/**
 * A definition given without hooks (e.g. `db.tables.users`, imported from the config file) of a
 * table to which `config` binds hooks (the config of `bindLilypadDbHooks`, given to the gate)
 * takes those hooks: importing the original config instead of the bound one cannot skip them.
 * It must be the same table of a config of the same name.
 */
function withConfigHooks(
  definition: LilypadDbTableDefinitionBase,
  config: LilypadDbConfig | undefined
): LilypadDbTableDefinitionBase {
  if (definition.hooks || !config || !Object.hasOwn(config.tables, definition.key)) {
    return definition;
  }
  const bound = config.tables[definition.key];
  if (
    !bound?.hooks ||
    bound.db.name !== definition.db.name ||
    bound.qualifiedName !== definition.qualifiedName
  ) {
    return definition;
  }
  return Object.freeze({ ...definition, hooks: bound.hooks });
}

/**
 * The columns, each with the `type` that follows from its `pgType` when it has none: frozen copies,
 * so that a change of the input (or of a column shared by two tables) does not reach them.
 */
function resolveColumns(
  cols: Readonly<Record<string, LilypadDbColumn>>
): Readonly<Record<string, LilypadDbColumn>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(cols).map(([name, column]) => {
        const type =
          column.type ??
          (column.pgType === undefined
            ? undefined
            : lilypadColumnTypesOfPgType(column.pgType)?.[0]);
        const resolved: LilypadDbColumn = {
          ...column,
          ...(type === undefined ? {} : { type }),
          ...(column.references ? { references: Object.freeze({ ...column.references }) } : {}),
          ...(typeof column.default === 'object'
            ? { default: Object.freeze({ ...column.default }) }
            : {}),
        };
        return [name, Object.freeze(resolved)];
      })
    )
  );
}

/** A frozen copy of each item of a list, in a frozen list. */
function frozenList<T extends object>(items: readonly T[]): readonly T[] {
  return Object.freeze(items.map((item) => Object.freeze({ ...item })));
}

/** Splits `schema.table`, or applies the default schema. */
function qualify(name: string, defaultSchema: string): { schema: string; table: string } {
  const separator = name.lastIndexOf('.');
  return separator < 0
    ? { schema: defaultSchema, table: name }
    : { schema: name.slice(0, separator), table: name.slice(separator + 1) };
}

/**
 * Defines a database config: export it as the default export of `lilypad.config.ts` (or
 * `lilypad.<name>.config.ts` for another config), and import it where the application creates its
 * gates and caches. It checks the config itself (a primary key that is not a column, a duplicate
 * table...), never the database: `lilypad-doctor` does that.
 *
 * @example
 * ```typescript
 * export default defineLilypadDb({
 *   notifyChannel: 'cache_events',
 *   changelog: { pruning: 'cron' },
 *   tables: { users, orgs },
 * });
 * ```
 *
 * @throws If the config is not valid.
 */
export function defineLilypadDb<Tables extends Record<string, LilypadDbTableInputBase>>(
  input: LilypadDbConfigInput<Tables>
): LilypadDbConfig<{ [K in keyof Tables]: LilypadDbTableDefinitionOf<Tables[K]> }> {
  validateLilypadDbConfigInput(input);
  const defaultSchema = input.defaultSchema ?? LILYPAD_DEFAULT_DB_SCHEMA;
  const settings: LilypadDbConfigSettings = Object.freeze({
    name: input.name ?? LILYPAD_DEFAULT_DB_CONFIG_NAME,
    defaultSchema,
    notifyChannel: input.notifyChannel ?? LILYPAD_DEFAULT_NOTIFY_CHANNEL,
    changelogTable: input.changelog?.table ?? LILYPAD_DEFAULT_CHANGELOG_TABLE,
  });

  const entries = Object.entries(input.tables);
  const located = entries.map(([key, table]) => {
    const { schema, table: tableName } = qualify(
      table.tableName,
      table.schemaName ?? defaultSchema
    );
    return { key, table, schema, tableName, qualifiedName: `${schema}.${tableName}` };
  });
  const byQualifiedName = new Map(located.map((entry) => [entry.qualifiedName, entry]));
  // The table of the config a reference names: an unqualified name is its table of the default
  // schema, or else its only table of that name; several, in other schemas, are ambiguous
  const tableOf = (name: string, owner: string) => {
    if (name.includes('.')) {
      return byQualifiedName.get(name);
    }
    const candidates = located.filter((entry) => entry.tableName === name);
    const target =
      byQualifiedName.get(`${defaultSchema}.${name}`) ??
      (candidates.length === 1 ? candidates[0] : undefined);
    if (!target && candidates.length > 1) {
      throw new Error(
        `defineLilypadDb: ${owner} references "${name}", which is a table of several schemas (${candidates.map((entry) => entry.qualifiedName).join(', ')}): qualify it.`
      );
    }
    return target;
  };
  const referenced = (name: string, owner: string, columns: readonly string[] | undefined) => {
    const target = tableOf(name, owner);
    const qualified = qualify(name, defaultSchema);
    const table = target?.qualifiedName ?? `${qualified.schema}.${qualified.table}`;
    const resolvedColumns = columns ?? (target ? [String(target.table.primaryKey)] : undefined);
    if (!resolvedColumns) {
      throw new Error(
        `defineLilypadDb: ${owner} references "${name}", which is not a table of the config: give the referenced columns.`
      );
    }
    const unknown =
      target && resolvedColumns.find((column) => !Object.hasOwn(target.table.cols, column));
    if (unknown !== undefined) {
      throw new Error(
        `defineLilypadDb: ${owner} references the column "${unknown}" of "${name}", which is not a column of that table.`
      );
    }
    return Object.freeze({ table, columns: Object.freeze([...resolvedColumns]) });
  };

  const tables: Record<string, LilypadDbTableDefinitionBase> = {};
  for (const { key, table, schema, tableName, qualifiedName } of located) {
    const { sync, strict, unique, foreignKeys, indexes, checks } = table;
    const owner = `the table "${key}"`;
    const resolvedUnique: LilypadDbResolvedUniqueKey[] = [
      ...Object.entries(table.cols)
        .filter(([, column]) => column.unique)
        .map(([name]) => ({ columns: Object.freeze([name]) })),
      ...(unique ?? []).map((uniqueKey) => ({
        name: uniqueKey.name,
        columns: Object.freeze([...uniqueKey.columns]),
      })),
    ];
    const resolvedForeignKeys: LilypadDbResolvedForeignKey[] = [
      ...Object.entries(table.cols).flatMap(([name, column]) => {
        const reference = column.references;
        if (!reference) {
          return [];
        }
        return [
          {
            columns: Object.freeze([name]),
            references: referenced(
              reference.table,
              `${owner} (column "${name}")`,
              reference.column === undefined ? undefined : [reference.column]
            ),
            onDelete: reference.onDelete ?? 'no action',
            onUpdate: reference.onUpdate ?? 'no action',
          },
        ];
      }),
      ...(foreignKeys ?? []).map((foreignKey) => ({
        name: foreignKey.name,
        columns: Object.freeze([...foreignKey.columns]),
        references: referenced(
          foreignKey.references.table,
          owner,
          foreignKey.references.columns && [...foreignKey.references.columns]
        ),
        onDelete: foreignKey.references.onDelete ?? 'no action',
        onUpdate: foreignKey.references.onUpdate ?? 'no action',
      })),
    ];
    for (const foreignKey of resolvedForeignKeys) {
      if (foreignKey.references.columns.length !== foreignKey.columns.length) {
        throw new Error(
          `defineLilypadDb: a foreign key of ${owner} has ${foreignKey.columns.length} columns, but references ${foreignKey.references.columns.length}.`
        );
      }
    }
    tables[key] = Object.freeze({
      [LILYPAD_DB_TABLE]: true as const,
      key,
      tableName,
      schemaName: schema,
      qualifiedName,
      primaryKey: table.primaryKey,
      generatedPrimaryKey: table.generatedPrimaryKey ?? false,
      cols: resolveColumns(table.cols),
      sync: Object.freeze({ ...(sync ?? { strategy: 'listen' }) }),
      strict: strict ?? input.strict ?? false,
      unique: frozenList(resolvedUnique),
      foreignKeys: frozenList(resolvedForeignKeys),
      indexes: frozenList(
        (indexes ?? []).map((index) => ({
          name: index.name,
          columns: Object.freeze([...index.columns]),
          unique: index.unique ?? false,
          using: index.using ?? 'btree',
        }))
      ),
      checks: frozenList(checks ?? []),
      db: settings,
    });
  }

  return Object.freeze({
    [LILYPAD_DB_CONFIG]: true as const,
    name: settings.name,
    defaultSchema,
    notifyChannel: settings.notifyChannel,
    changelog: Object.freeze({
      table: settings.changelogTable,
      pruning: input.changelog?.pruning ?? 'detect',
      minRetention: input.changelog?.minRetention ?? LILYPAD_DEFAULT_MAX_GAP,
    }),
    strict: input.strict ?? false,
    maxStatementTimeout: input.maxStatementTimeout ?? LILYPAD_DEFAULT_MAX_STATEMENT_TIMEOUT,
    tables: Object.freeze(tables),
  }) as unknown as LilypadDbConfig<{ [K in keyof Tables]: LilypadDbTableDefinitionOf<Tables[K]> }>;
}
