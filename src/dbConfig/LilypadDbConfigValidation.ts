import type {
  LilypadDbConfigInput,
  LilypadDbTableInputBase,
  LilypadDbTableSync,
} from '@/dbConfig/LilypadDbConfig';
import { LILYPAD_DEFAULT_DB_SCHEMA } from '@/dbConfig/LilypadDbConfigDefaults';
import { LILYPAD_DB_COLUMN_TYPES, lilypadColumnTypeMismatch } from '@/dbConfig/LilypadPgTypes';
import type { LilypadDbColumn, LilypadDbReference } from '@/dbGate/LilypadDbSchema';
import { assertNumberOption } from '@/internal/LilypadValidation';

const OWNER = 'defineLilypadDb';
const CONFIG_NAME = /^[A-Za-z0-9_-]+$/;
const COLUMN_TYPES = new Set<string>(LILYPAD_DB_COLUMN_TYPES);
const ACTIONS = new Set(['no action', 'restrict', 'cascade', 'set null', 'set default']);
const INDEX_METHODS = new Set(['btree', 'hash', 'gin', 'gist', 'brin', 'spgist']);
const PRUNING_MODES = new Set(['detect', 'trigger', 'cron', 'external']);

function fail(message: string): never {
  throw new Error(`${OWNER}: ${message}`);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertName(value: unknown, what: string): void {
  if (!isNonEmptyString(value)) {
    fail(`${what} must be a non-empty string (got ${JSON.stringify(value)}).`);
  }
}

function assertOneOf(value: unknown, allowed: Set<string>, what: string): void {
  if (value !== undefined && (typeof value !== 'string' || !allowed.has(value))) {
    fail(`${what} must be one of ${[...allowed].join(', ')} (got ${JSON.stringify(value)}).`);
  }
}

/** `schema.table` has at most one dot, and no empty part. */
function assertTableName(value: unknown, what: string): void {
  assertName(value, what);
  const parts = (value as string).split('.');
  if (parts.length > 2 || parts.some((part) => part.length === 0)) {
    fail(`${what} must be "table" or "schema.table" (got "${value as string}").`);
  }
}

function assertColumns(
  columns: unknown,
  known: Record<string, unknown>,
  what: string
): asserts columns is readonly string[] {
  if (!Array.isArray(columns) || columns.length === 0) {
    fail(`${what} must list at least one column.`);
  }
  for (const column of columns as unknown[]) {
    if (typeof column !== 'string' || !Object.hasOwn(known, column)) {
      fail(`${what} names "${String(column)}", which is not a column of \`cols\`.`);
    }
  }
}

function assertReference(reference: Partial<LilypadDbReference>, what: string): void {
  if (typeof reference !== 'object' || reference === null) {
    fail(`${what} must be an object.`);
  }
  assertTableName(reference.table, `${what}.table`);
  assertOneOf(reference.onDelete, ACTIONS, `${what}.onDelete`);
  assertOneOf(reference.onUpdate, ACTIONS, `${what}.onUpdate`);
}

function assertColumn(column: LilypadDbColumn, what: string): void {
  if (typeof column !== 'object' || column === null) {
    fail(`${what} must be an object (e.g. { type: 'string' }).`);
  }
  assertOneOf(column.type, COLUMN_TYPES, `${what}.type`);
  if (column.pgType !== undefined) {
    assertName(column.pgType, `${what}.pgType`);
    const fitting =
      column.type === undefined ? undefined : lilypadColumnTypeMismatch(column.type, column.pgType);
    if (fitting) {
      fail(
        `${what}.type "${String(column.type)}" does not fit its pgType "${column.pgType}", which postgres.js returns as ${fitting[0]}: declare ${fitting.map((type) => `"${type}"`).join(' or ')}, or leave type out.`
      );
    }
  }
  if (column.converted !== undefined && typeof column.converted !== 'boolean') {
    fail(`${what}.converted must be a boolean.`);
  }
  const columnDefault: unknown = column.default;
  if (
    columnDefault !== undefined &&
    columnDefault !== true &&
    !(
      typeof columnDefault === 'object' &&
      columnDefault !== null &&
      isNonEmptyString((columnDefault as { sql?: unknown }).sql)
    )
  ) {
    fail(`${what}.default must be true or { sql: '<expression>' }.`);
  }
  if (column.references !== undefined) {
    assertReference(column.references, `${what}.references`);
    if (column.references.column !== undefined) {
      assertName(column.references.column, `${what}.references.column`);
    }
  }
}

function assertSync(sync: LilypadDbTableSync | undefined, what: string): void {
  if (sync === undefined) {
    return;
  }
  assertOneOf(sync.strategy, new Set(['listen', 'changelog', 'none']), `${what}.strategy`);
  if (sync.strategy === 'none') {
    return;
  }
  assertNumberOption(OWNER, `${what}.maxAge`, sync.maxAge, 'non-negative');
  if (sync.strategy === 'listen') {
    assertOneOf(sync.connect, new Set(['eager', 'lazy']), `${what}.connect`);
    return;
  }
  if (typeof sync.pollInterval !== 'number') {
    fail(`${what}.pollInterval is required with the changelog strategy.`);
  }
  assertNumberOption(OWNER, `${what}.pollInterval`, sync.pollInterval, 'non-negative');
  assertNumberOption(OWNER, `${what}.maxGap`, sync.maxGap, 'positive');
  assertNumberOption(OWNER, `${what}.lookback`, sync.lookback, 'non-negative');
  assertOneOf(sync.poll, new Set(['await', 'background']), `${what}.poll`);
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

function assertTable(key: string, table: LilypadDbTableInputBase, defaultSchema: string): string {
  const what = `tables.${key}`;
  if (typeof table !== 'object' || table === null) {
    fail(`${what} must be a table (see defineLilypadTable).`);
  }
  assertTableName(table.tableName, `${what}.tableName`);
  const qualified = table.tableName.includes('.');
  if (table.schemaName !== undefined) {
    assertName(table.schemaName, `${what}.schemaName`);
    if (qualified) {
      fail(`${what}: give the schema in tableName or in schemaName, not both.`);
    }
  }
  const cols = table.cols as Record<string, LilypadDbColumn> | undefined;
  if (typeof cols !== 'object' || cols === null || Object.keys(cols).length === 0) {
    fail(`${what}.cols must describe at least one column.`);
  }
  for (const [name, column] of Object.entries(cols)) {
    assertColumn(column, `${what}.cols.${name}`);
  }
  if (typeof table.primaryKey !== 'string' || !Object.hasOwn(cols, table.primaryKey)) {
    fail(`${what}.primaryKey "${String(table.primaryKey)}" is not a column of \`cols\`.`);
  }
  (table.unique ?? []).forEach((uniqueKey, index) => {
    assertColumns(uniqueKey.columns, cols, `${what}.unique[${index}].columns`);
  });
  (table.indexes ?? []).forEach((tableIndex, index) => {
    assertColumns(tableIndex.columns, cols, `${what}.indexes[${index}].columns`);
    assertOneOf(tableIndex.using, INDEX_METHODS, `${what}.indexes[${index}].using`);
  });
  (table.foreignKeys ?? []).forEach((foreignKey, index) => {
    assertColumns(foreignKey.columns, cols, `${what}.foreignKeys[${index}].columns`);
    assertReference(foreignKey.references, `${what}.foreignKeys[${index}].references`);
    if (foreignKey.references.columns !== undefined) {
      const referencedColumns: unknown = foreignKey.references.columns;
      if (
        !Array.isArray(referencedColumns) ||
        referencedColumns.length === 0 ||
        !referencedColumns.every(isNonEmptyString)
      ) {
        fail(`${what}.foreignKeys[${index}].references.columns must list column names.`);
      }
    }
  });
  const checkNames = new Set<string>();
  (table.checks ?? []).forEach((check, index) => {
    assertName(check.name, `${what}.checks[${index}].name`);
    if (checkNames.has(check.name)) {
      fail(`${what}.checks has two checks named "${check.name}".`);
    }
    checkNames.add(check.name);
    if (check.expression !== undefined) {
      assertName(check.expression, `${what}.checks[${index}].expression`);
    }
  });
  assertSync(table.sync, `${what}.sync`);
  assertNoHooks(key, table as Record<string, unknown>);
  return qualified ? table.tableName : `${table.schemaName ?? defaultSchema}.${table.tableName}`;
}

/**
 * Checks a config before `defineLilypadDb` resolves it: only the config itself, never the
 * database.
 *
 * @throws With a message naming the option that is not valid.
 */
export function validateLilypadDbConfigInput(
  input: LilypadDbConfigInput<Record<string, LilypadDbTableInputBase>>
): void {
  if (typeof input !== 'object' || input === null) {
    fail('the config must be an object.');
  }
  if (
    input.name !== undefined &&
    (typeof input.name !== 'string' || !CONFIG_NAME.test(input.name))
  ) {
    fail(
      `name must contain only letters, digits, "_" and "-" (got ${JSON.stringify(input.name)}).`
    );
  }
  if (input.defaultSchema !== undefined) {
    assertName(input.defaultSchema, 'defaultSchema');
  }
  if (input.notifyChannel !== undefined) {
    assertName(input.notifyChannel, 'notifyChannel');
  }
  if (input.changelog !== undefined) {
    if (input.changelog.table !== undefined) {
      assertTableName(input.changelog.table, 'changelog.table');
    }
    assertOneOf(input.changelog.pruning, PRUNING_MODES, 'changelog.pruning');
    assertNumberOption(OWNER, 'changelog.minRetention', input.changelog.minRetention, 'positive');
  }
  if (typeof input.tables !== 'object' || input.tables === null) {
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
