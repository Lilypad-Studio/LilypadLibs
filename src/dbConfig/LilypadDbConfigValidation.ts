import type {
  LilypadDbConfigInput,
  LilypadDbTableInputBase,
  LilypadDbTableSync,
} from '@/dbConfig/LilypadDbConfig';
import {
  LILYPAD_DEFAULT_DB_SCHEMA,
  LILYPAD_RESERVED_CHANNEL_PART,
} from '@/dbConfig/LilypadDbConfigDefaults';
import type {
  LilypadDbCheck,
  LilypadDbColumn,
  LilypadDbColumnReference,
  LilypadDbForeignKey,
  LilypadDbIndex,
  LilypadDbReference,
  LilypadDbUniqueKey,
} from '@/dbConfig/LilypadDbSchema';
import { LILYPAD_DB_COLUMN_TYPES, lilypadColumnTypeMismatch } from '@/dbConfig/LilypadPgTypes';
import { assertNumberOption } from '@/internal/LilypadValidation';

const OWNER = 'defineLilypadDb';
const CONFIG_NAME = /^[A-Za-z0-9_-]+$/;
const COLUMN_TYPES = new Set<string>(LILYPAD_DB_COLUMN_TYPES);
const ACTIONS = new Set(['no action', 'restrict', 'cascade', 'set null', 'set default']);
const INDEX_METHODS = new Set(['btree', 'hash', 'gin', 'gist', 'brin', 'spgist']);
const PRUNING_MODES = new Set(['detect', 'trigger', 'cron', 'external']);
const STRATEGIES = new Set(['listen', 'changelog', 'none']);
/** PostgreSQL truncates longer identifiers (`NAMEDATALEN - 1`), and `pg_notify` rejects them. */
const MAX_IDENTIFIER_BYTES = 63;
const encoder = new TextEncoder();

/** The options of an object of the config: the compiler checks that it lists every one of its type. */
function optionsOf<T>(options: Record<keyof T & string, true>): ReadonlySet<string> {
  return new Set(Object.keys(options));
}

type ConfigInput = LilypadDbConfigInput<Record<string, LilypadDbTableInputBase>>;
type SyncOf<S> = Extract<LilypadDbTableSync, { strategy: S }>;

const CONFIG_OPTIONS = optionsOf<ConfigInput>({
  name: true,
  defaultSchema: true,
  notifyChannel: true,
  changelog: true,
  strict: true,
  maxStatementTimeout: true,
  appRole: true,
  tables: true,
});
const CHANGELOG_OPTIONS = optionsOf<NonNullable<ConfigInput['changelog']>>({
  table: true,
  pruning: true,
  minRetention: true,
});
const TABLE_OPTIONS = optionsOf<LilypadDbTableInputBase>({
  tableName: true,
  schemaName: true,
  primaryKey: true,
  generatedPrimaryKey: true,
  cols: true,
  unique: true,
  foreignKeys: true,
  indexes: true,
  checks: true,
  sync: true,
  strict: true,
});
const COLUMN_OPTIONS = optionsOf<LilypadDbColumn>({
  type: true,
  pgType: true,
  converted: true,
  nullable: true,
  default: true,
  unique: true,
  references: true,
});
const COLUMN_REFERENCE_OPTIONS = optionsOf<LilypadDbColumnReference>({
  table: true,
  column: true,
  onDelete: true,
  onUpdate: true,
});
const REFERENCE_OPTIONS = optionsOf<LilypadDbReference>({
  table: true,
  columns: true,
  onDelete: true,
  onUpdate: true,
});
const UNIQUE_OPTIONS = optionsOf<LilypadDbUniqueKey<unknown>>({ name: true, columns: true });
const INDEX_OPTIONS = optionsOf<LilypadDbIndex<unknown>>({
  name: true,
  columns: true,
  unique: true,
  using: true,
});
const FOREIGN_KEY_OPTIONS = optionsOf<LilypadDbForeignKey<unknown>>({
  name: true,
  columns: true,
  references: true,
});
const CHECK_OPTIONS = optionsOf<LilypadDbCheck>({ name: true, expression: true });
const SYNC_OPTIONS: Readonly<Record<LilypadDbTableSync['strategy'], ReadonlySet<string>>> = {
  listen: optionsOf<SyncOf<'listen'>>({
    strategy: true,
    maxAge: true,
    connect: true,
    applyChanges: true,
  }),
  changelog: optionsOf<SyncOf<'changelog'>>({
    strategy: true,
    maxAge: true,
    pollInterval: true,
    poll: true,
    maxGap: true,
    lookback: true,
  }),
  none: optionsOf<SyncOf<'none'>>({ strategy: true }),
};

/**
 * Whether a string is a config name (letters, digits, `_` and `-`): the loader and
 * `lilypad-doctor init` take a `--config` that is one for a name, anything else for a path.
 */
export function isLilypadDbConfigName(value: string): boolean {
  return CONFIG_NAME.test(value);
}

function fail(message: string): never {
  throw new Error(`${OWNER}: ${message}`);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertName(value: unknown, what: string): asserts value is string {
  if (!isNonEmptyString(value)) {
    fail(`${what} must be a non-empty string (got ${JSON.stringify(value)}).`);
  }
}

/** A name that PostgreSQL keeps as it is: 63 bytes at most. */
function assertLength(value: string, what: string): void {
  if (encoder.encode(value).length > MAX_IDENTIFIER_BYTES) {
    fail(
      `${what} "${value}" is longer than ${MAX_IDENTIFIER_BYTES} bytes, which PostgreSQL truncates.`
    );
  }
}

/** An unqualified identifier: the library splits the names it quotes on their dots. */
function assertIdentifier(value: unknown, what: string): asserts value is string {
  assertName(value, what);
  if (value.includes('.')) {
    fail(`${what} must not contain a dot (got "${value}").`);
  }
  assertLength(value, what);
}

function assertOptionalIdentifier(value: unknown, what: string): void {
  if (value !== undefined) {
    assertIdentifier(value, what);
  }
}

/** An object that is not an array (an array would give its items the keys `0`, `1`...). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertObject(value: unknown, what: string): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    fail(`${what} must be an object.`);
  }
}

/**
 * A config in JavaScript is not type-checked: a misspelled option would be ignored. `what` is the
 * path of the object (empty for the config itself).
 */
function assertOptions(value: object, options: ReadonlySet<string>, what: string): void {
  for (const key of Object.keys(value)) {
    if (!options.has(key)) {
      fail(
        `${what ? `${what}.` : ''}${key} is not an option (expected ${[...options].join(', ')}).`
      );
    }
  }
}

/** An optional list of objects that have only these options. */
function assertEntries(
  value: unknown,
  options: ReadonlySet<string>,
  what: string
): Record<string, unknown>[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail(`${what} must be an array.`);
  }
  return (value as unknown[]).map((entry, index) => {
    assertObject(entry, `${what}[${index}]`);
    assertOptions(entry, options, `${what}[${index}]`);
    return entry;
  });
}

function assertBoolean(value: unknown, what: string): void {
  if (value !== undefined && typeof value !== 'boolean') {
    fail(`${what} must be a boolean (got ${JSON.stringify(value)}).`);
  }
}

function assertOneOf(value: unknown, allowed: Set<string>, what: string): void {
  if (value !== undefined && (typeof value !== 'string' || !allowed.has(value))) {
    fail(`${what} must be one of ${[...allowed].join(', ')} (got ${JSON.stringify(value)}).`);
  }
}

/** `schema.table` has at most one dot, and no empty part. */
function assertTableName(value: unknown, what: string): asserts value is string {
  assertName(value, what);
  const parts = value.split('.');
  if (parts.length > 2 || parts.some((part) => part.length === 0)) {
    fail(`${what} must be "table" or "schema.table" (got "${value}").`);
  }
  for (const part of parts) {
    assertLength(part, what);
  }
}

/** Columns of `cols`, at least one, each once. */
function assertColumns(columns: unknown, known: Record<string, unknown>, what: string): void {
  if (!Array.isArray(columns) || columns.length === 0) {
    fail(`${what} must list at least one column.`);
  }
  const seen = new Set<string>();
  for (const column of columns as unknown[]) {
    if (typeof column !== 'string' || !Object.hasOwn(known, column)) {
      fail(`${what} names "${String(column)}", which is not a column of \`cols\`.`);
    }
    if (seen.has(column)) {
      fail(`${what} names "${column}" twice.`);
    }
    seen.add(column);
  }
}

/** The columns of the referenced table, each once (`defineLilypadDb` checks that they exist). */
function assertReferencedColumns(columns: unknown, what: string): void {
  if (columns === undefined) {
    return;
  }
  if (!Array.isArray(columns) || columns.length === 0) {
    fail(`${what} must list column names.`);
  }
  const seen = new Set<string>();
  (columns as unknown[]).forEach((column, index) => {
    assertIdentifier(column, `${what}[${index}]`);
    if (seen.has(column)) {
      fail(`${what} names "${column}" twice.`);
    }
    seen.add(column);
  });
}

function assertReference(
  reference: unknown,
  options: ReadonlySet<string>,
  what: string
): asserts reference is Record<string, unknown> {
  assertObject(reference, what);
  assertOptions(reference, options, what);
  assertTableName(reference.table, `${what}.table`);
  assertOneOf(reference.onDelete, ACTIONS, `${what}.onDelete`);
  assertOneOf(reference.onUpdate, ACTIONS, `${what}.onUpdate`);
}

function assertColumn(name: string, column: unknown, what: string): void {
  assertIdentifier(name, what);
  if (!isPlainObject(column)) {
    fail(`${what} must be an object (e.g. { type: 'string' }).`);
  }
  assertOptions(column, COLUMN_OPTIONS, what);
  const { type, pgType, converted, nullable, unique, references } = column as LilypadDbColumn;
  assertOneOf(type, COLUMN_TYPES, `${what}.type`);
  if (pgType !== undefined) {
    assertName(pgType, `${what}.pgType`);
    const fitting = type === undefined ? undefined : lilypadColumnTypeMismatch(type, pgType);
    if (fitting) {
      fail(
        `${what}.type "${String(type)}" does not fit its pgType "${pgType}", which postgres.js returns as ${fitting[0]}: declare ${fitting.map((fit) => `"${fit}"`).join(' or ')}, or leave type out.`
      );
    }
  }
  assertBoolean(converted, `${what}.converted`);
  assertBoolean(nullable, `${what}.nullable`);
  assertBoolean(unique, `${what}.unique`);
  const columnDefault: unknown = (column as LilypadDbColumn).default;
  if (
    columnDefault !== undefined &&
    columnDefault !== true &&
    !(
      typeof columnDefault === 'object' &&
      columnDefault !== null &&
      Object.keys(columnDefault).length === 1 &&
      isNonEmptyString((columnDefault as { sql?: unknown }).sql)
    )
  ) {
    fail(`${what}.default must be true or { sql: '<expression>' }.`);
  }
  if (references !== undefined) {
    assertReference(references, COLUMN_REFERENCE_OPTIONS, `${what}.references`);
    assertOptionalIdentifier(references.column, `${what}.references.column`);
  }
}

function assertSync(sync: unknown, what: string): void {
  if (sync === undefined) {
    return;
  }
  assertObject(sync, what);
  if (sync.strategy === undefined) {
    fail(`${what}.strategy is required (one of ${[...STRATEGIES].join(', ')}).`);
  }
  assertOneOf(sync.strategy, STRATEGIES, `${what}.strategy`);
  const typed = sync as LilypadDbTableSync;
  assertOptions(sync, SYNC_OPTIONS[typed.strategy], what);
  if (typed.strategy === 'none') {
    return;
  }
  assertNumberOption(OWNER, `${what}.maxAge`, typed.maxAge, 'non-negative');
  if (typed.strategy === 'listen') {
    assertOneOf(typed.connect, new Set(['eager', 'lazy']), `${what}.connect`);
    assertBoolean(typed.applyChanges, `${what}.applyChanges`);
    return;
  }
  if (typeof typed.pollInterval !== 'number') {
    fail(`${what}.pollInterval is required with the changelog strategy.`);
  }
  assertNumberOption(OWNER, `${what}.pollInterval`, typed.pollInterval, 'non-negative');
  assertNumberOption(OWNER, `${what}.maxGap`, typed.maxGap, 'positive');
  assertNumberOption(OWNER, `${what}.lookback`, typed.lookback, 'non-negative');
  assertOneOf(typed.poll, new Set(['await', 'background']), `${what}.poll`);
}

/** The functions a table description may no longer hold, and the hook that replaces each. */
const HOOK_FIELDS: Record<string, string> = {
  writeSanitizationFn: 'write',
  selectSanitizationFn: 'select',
  hooks: 'write, select',
};

/**
 * A config holds no function, so that `lilypad-doctor` loads it without the application code:
 * they are bound by the application (a config in JavaScript is not type-checked).
 */
function assertNoHooks(key: string, table: Record<string, unknown>): void {
  for (const [field, hook] of Object.entries(HOOK_FIELDS)) {
    if (table[field] !== undefined) {
      fail(
        `tables.${key}.${field}: a config holds no functions, so that lilypad-doctor loads it without the application code. Bind them where the application creates its gate: bindLilypadDbHooks(db, { ${key}: { ${hook} } }).`
      );
    }
  }
}

function assertTable(key: string, table: unknown, defaultSchema: string): string {
  const what = `tables.${key}`;
  if (!isPlainObject(table)) {
    fail(`${what} must be a table (see defineLilypadTable).`);
  }
  assertNoHooks(key, table);
  assertOptions(table, TABLE_OPTIONS, what);
  const input = table as LilypadDbTableInputBase;
  assertTableName(input.tableName, `${what}.tableName`);
  const qualified = input.tableName.includes('.');
  if (input.schemaName !== undefined) {
    assertIdentifier(input.schemaName, `${what}.schemaName`);
    if (qualified) {
      fail(`${what}: give the schema in tableName or in schemaName, not both.`);
    }
  }
  const cols = input.cols as Record<string, unknown> | undefined;
  if (!isPlainObject(cols) || Object.keys(cols).length === 0) {
    fail(`${what}.cols must describe at least one column.`);
  }
  for (const [name, column] of Object.entries(cols)) {
    assertColumn(name, column, `${what}.cols.${name}`);
  }
  if (typeof input.primaryKey !== 'string' || !Object.hasOwn(cols, input.primaryKey)) {
    fail(`${what}.primaryKey "${String(input.primaryKey)}" is not a column of \`cols\`.`);
  }
  assertBoolean(input.generatedPrimaryKey, `${what}.generatedPrimaryKey`);
  assertBoolean(input.strict, `${what}.strict`);
  assertEntries(input.unique, UNIQUE_OPTIONS, `${what}.unique`).forEach((uniqueKey, index) => {
    assertOptionalIdentifier(uniqueKey.name, `${what}.unique[${index}].name`);
    assertColumns(uniqueKey.columns, cols, `${what}.unique[${index}].columns`);
  });
  assertEntries(input.indexes, INDEX_OPTIONS, `${what}.indexes`).forEach((tableIndex, index) => {
    assertOptionalIdentifier(tableIndex.name, `${what}.indexes[${index}].name`);
    assertColumns(tableIndex.columns, cols, `${what}.indexes[${index}].columns`);
    assertBoolean(tableIndex.unique, `${what}.indexes[${index}].unique`);
    assertOneOf(tableIndex.using, INDEX_METHODS, `${what}.indexes[${index}].using`);
  });
  assertEntries(input.foreignKeys, FOREIGN_KEY_OPTIONS, `${what}.foreignKeys`).forEach(
    (foreignKey, index) => {
      const at = `${what}.foreignKeys[${index}]`;
      assertOptionalIdentifier(foreignKey.name, `${at}.name`);
      assertColumns(foreignKey.columns, cols, `${at}.columns`);
      assertReference(foreignKey.references, REFERENCE_OPTIONS, `${at}.references`);
      assertReferencedColumns(foreignKey.references.columns, `${at}.references.columns`);
    }
  );
  const checkNames = new Set<string>();
  assertEntries(input.checks, CHECK_OPTIONS, `${what}.checks`).forEach((check, index) => {
    assertIdentifier(check.name, `${what}.checks[${index}].name`);
    if (checkNames.has(check.name)) {
      fail(`${what}.checks has two checks named "${check.name}".`);
    }
    checkNames.add(check.name);
    if (check.expression !== undefined) {
      assertName(check.expression, `${what}.checks[${index}].expression`);
    }
  });
  assertSync(input.sync, `${what}.sync`);
  return qualified ? input.tableName : `${input.schemaName ?? defaultSchema}.${input.tableName}`;
}

/**
 * Checks a config before `defineLilypadDb` resolves it: only the config itself, never the
 * database. Every object of the config may hold only its options.
 *
 * @throws With a message naming the option that is not valid.
 */
export function validateLilypadDbConfigInput(input: ConfigInput): void {
  assertObject(input, 'the config');
  assertOptions(input, CONFIG_OPTIONS, '');
  if (
    input.name !== undefined &&
    (typeof input.name !== 'string' || !isLilypadDbConfigName(input.name))
  ) {
    fail(
      `name must contain only letters, digits, "_" and "-" (got ${JSON.stringify(input.name)}).`
    );
  }
  assertOptionalIdentifier(input.defaultSchema, 'defaultSchema');
  if (input.notifyChannel !== undefined) {
    assertIdentifier(input.notifyChannel, 'notifyChannel');
    // postgres.js keeps its channels in a plain object
    if (Object.hasOwn(Object.prototype, input.notifyChannel)) {
      fail(`notifyChannel cannot be "${input.notifyChannel}".`);
    }
    // lilypadChangelogSql refuses it, so lilypad-doctor could not write the SQL of the triggers
    if (input.notifyChannel.includes(LILYPAD_RESERVED_CHANNEL_PART)) {
      fail(
        `notifyChannel cannot contain "${LILYPAD_RESERVED_CHANNEL_PART}", which the changelog SQL reserves (got "${input.notifyChannel}").`
      );
    }
  }
  if (input.changelog !== undefined) {
    assertObject(input.changelog, 'changelog');
    assertOptions(input.changelog, CHANGELOG_OPTIONS, 'changelog');
    if (input.changelog.table !== undefined) {
      assertTableName(input.changelog.table, 'changelog.table');
    }
    assertOneOf(input.changelog.pruning, PRUNING_MODES, 'changelog.pruning');
    assertNumberOption(OWNER, 'changelog.minRetention', input.changelog.minRetention, 'positive');
  }
  assertBoolean(input.strict, 'strict');
  if (input.maxStatementTimeout !== false) {
    // statement_timeout holds at most 2^31 - 1 ms, as a timer does
    assertNumberOption(OWNER, 'maxStatementTimeout', input.maxStatementTimeout, 'positive-delay');
  }
  // A role name, never split: it may contain a dot
  if (input.appRole !== undefined) {
    assertName(input.appRole, 'appRole');
    assertLength(input.appRole, 'appRole');
  }
  if (!isPlainObject(input.tables)) {
    fail('tables must be an object: { <key>: <table> }.');
  }
  const defaultSchema = input.defaultSchema ?? LILYPAD_DEFAULT_DB_SCHEMA;
  const keys = new Map<string, string>();
  for (const [key, table] of Object.entries(input.tables)) {
    const qualifiedName = assertTable(key, table, defaultSchema);
    const previous = keys.get(qualifiedName);
    if (previous !== undefined) {
      fail(`tables.${previous} and tables.${key} are both the table "${qualifiedName}".`);
    }
    keys.set(qualifiedName, key);
  }
}
