import type {
  LilypadDbResolvedForeignKey,
  LilypadDbResolvedIndex,
  LilypadDbResolvedUniqueKey,
} from '@/dbConfig/LilypadDbConfig';
import { quoteIdentifier } from '@/dbGate/LilypadChangelog';
import type {
  LilypadDbCheck,
  LilypadDbColumn,
  LilypadDbColumnType,
  LilypadDbReferentialAction,
} from '@/dbGate/LilypadDbSchema';
import type {
  LilypadColumnInfo,
  LilypadConstraintInfo,
  LilypadIndexInfo,
  LilypadTableFacts,
} from '@/dbGate/LilypadSchemaFacts';
import type { LilypadSchemaProblem } from '@/dbGate/LilypadSchemaCheck';

/**
 * The shape of a table, compared with the database by the schema check: its columns, keys,
 * indexes and checks. A table definition of a config (`db.tables.users`) is one.
 */
export type LilypadSchemaTableShape = {
  cols: Readonly<Record<string, LilypadDbColumn>>;
  generatedPrimaryKey?: boolean;
  unique: readonly LilypadDbResolvedUniqueKey[];
  foreignKeys: readonly LilypadDbResolvedForeignKey[];
  indexes: readonly LilypadDbResolvedIndex[];
  checks: readonly LilypadDbCheck[];
  /** Also reports what the database has and the shape lacks (as warnings). */
  strict: boolean;
};

/** The problems of the shape of one table, and those to report after every table (see below). */
export type LilypadShapeProblems = {
  problems: LilypadSchemaProblem[];
  /**
   * The foreign keys to create: reported after the problems of every table, so that the SQL that
   * creates a missing table comes before the foreign keys that reference it.
   */
  deferred: LilypadSchemaProblem[];
};

const TYPE_ALIASES: Record<string, string> = {
  int: 'integer',
  int4: 'integer',
  serial: 'integer',
  serial4: 'integer',
  int2: 'smallint',
  smallserial: 'smallint',
  serial2: 'smallint',
  int8: 'bigint',
  bigserial: 'bigint',
  serial8: 'bigint',
  float4: 'real',
  float8: 'double precision',
  float: 'double precision',
  bool: 'boolean',
  varchar: 'character varying',
  char: 'character',
  bpchar: 'character',
  decimal: 'numeric',
  timestamptz: 'timestamp with time zone',
  timetz: 'time with time zone',
  varbit: 'bit varying',
};

const SERIAL_TYPES = new Set([
  'serial',
  'serial4',
  'smallserial',
  'serial2',
  'bigserial',
  'serial8',
]);

/**
 * A PostgreSQL type as `format_type` writes it: lower case, aliases resolved (`int4` is
 * `integer`, `varchar(64)` is `character varying(64)`, `timestamptz(3)` is
 * `timestamp(3) with time zone`), array suffixes kept.
 */
export function normalizeLilypadPgType(type: string): string {
  let text = type.trim().toLowerCase().replace(/\s+/g, ' ');
  let arrays = '';
  while (text.endsWith('[]')) {
    arrays += '[]';
    text = text.slice(0, -2).trimEnd();
  }
  // `name(args) rest`, e.g. `timestamp(3) with time zone`
  const open = text.indexOf('(');
  const close = open < 0 ? -1 : text.indexOf(')', open);
  const name = (close < 0 ? text : text.slice(0, open)).trim();
  const args = close < 0 ? '' : text.slice(open, close + 1).replace(/\s+/g, '');
  const rest = close < 0 ? '' : text.slice(close + 1).trim();
  if (name === 'timestamp' || name === 'time') {
    return `${name}${args} ${rest || 'without time zone'}${arrays}`;
  }
  const resolved = TYPE_ALIASES[name] ?? name;
  if (resolved === 'character' && !args) {
    return `character(1)${arrays}`;
  }
  // `timestamptz(3)`: the precision goes before the time zone
  const zone = /^(timestamp|time) (with|without) time zone$/.exec(resolved);
  if (zone) {
    return `${zone[1]}${args} ${zone[2]} time zone${arrays}`;
  }
  return `${resolved}${args}${rest ? ` ${rest}` : ''}${arrays}`;
}

/** Whether a declared type names the installed one (`format_type` qualifies the types of schemas off the `search_path`). */
function sameType(declared: string, installed: string): boolean {
  const expected = normalizeLilypadPgType(declared);
  const actual = normalizeLilypadPgType(installed);
  return actual === expected || actual.endsWith(`.${expected}`) || expected.endsWith(`.${actual}`);
}

const TIME_TYPES = /^time(\(\d+\))? with(out)? time zone$/;

/**
 * Whether a column of this type is read by postgres.js as the declared `type`, or `undefined` if it
 * fits; otherwise, why not.
 */
function typeMismatch(type: LilypadDbColumnType, column: LilypadColumnInfo): string | undefined {
  const installed = normalizeLilypadPgType(column.type);
  const base = installed.replace(/\(.*$/, '');
  switch (type) {
    case 'string':
      return ['S', 'E', 'I', 'V', 'T'].includes(column.category) ||
        ['uuid', 'xml', 'numeric', 'bigint'].includes(base) ||
        TIME_TYPES.test(installed)
        ? undefined
        : 'postgres.js does not return it as a string';
    case 'number':
      if (base === 'bigint' || base === 'numeric') {
        return 'postgres.js returns it as a string: declare the column as `bigint` or `string`';
      }
      return column.category === 'N' ? undefined : 'it is not a numeric type';
    case 'bigint':
      return base === 'bigint' || base === 'numeric' ? undefined : 'it is not a bigint';
    case 'boolean':
      return column.category === 'B' ? undefined : 'it is not a boolean';
    case 'date':
      return column.category === 'D' && !TIME_TYPES.test(installed)
        ? undefined
        : 'postgres.js does not return it as a Date';
    case 'json':
      return base === 'json' || base === 'jsonb' ? undefined : 'it is not json or jsonb';
    case 'array':
      return column.category === 'A' ? undefined : 'it is not an array';
  }
}

const ACTION_CODES: Record<LilypadDbReferentialAction, string> = {
  'no action': 'a',
  restrict: 'r',
  cascade: 'c',
  'set null': 'n',
  'set default': 'd',
};
const ACTION_NAMES = Object.fromEntries(
  Object.entries(ACTION_CODES).map(([name, code]) => [code, name])
) as Record<string, LilypadDbReferentialAction>;

function columnList(columns: readonly (string | null)[]): string {
  return columns.map((column) => (column === null ? '<expression>' : column)).join(', ');
}

function quotedColumns(columns: readonly string[]): string {
  return columns.map(quoteIdentifier).join(', ');
}

function sameSet(a: readonly (string | null)[], b: readonly (string | null)[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

function sameList(a: readonly (string | null)[], b: readonly (string | null)[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Whether a declared column has a generating default: `default`, a serial type, or the generated primary key. */
function expectsDefault(
  name: string,
  column: LilypadDbColumn,
  shape: LilypadSchemaTableShape,
  primaryKey: string
): boolean {
  return (
    column.default !== undefined ||
    (column.pgType !== undefined && SERIAL_TYPES.has(column.pgType.trim().toLowerCase())) ||
    (shape.generatedPrimaryKey === true && name === primaryKey)
  );
}

/** The SQL of a column, for `CREATE TABLE` and `ADD COLUMN` (its type must be known). */
function columnSql(
  name: string,
  column: LilypadDbColumn & { pgType: string },
  shape: LilypadSchemaTableShape,
  primaryKey: string
): string {
  const parts = [quoteIdentifier(name), column.pgType];
  const normalized = normalizeLilypadPgType(column.pgType);
  const generated = shape.generatedPrimaryKey === true && name === primaryKey;
  if (
    generated &&
    typeof column.default !== 'object' &&
    !SERIAL_TYPES.has(column.pgType.trim().toLowerCase()) &&
    ['integer', 'smallint', 'bigint'].includes(normalized)
  ) {
    parts.push('GENERATED BY DEFAULT AS IDENTITY');
  }
  if (column.nullable === false || name === primaryKey) {
    parts.push('NOT NULL');
  }
  if (typeof column.default === 'object') {
    parts.push(`DEFAULT ${column.default.sql}`);
  }
  return parts.join(' ');
}

function foreignKeySql(table: string, foreignKey: LilypadDbResolvedForeignKey): string {
  const name = foreignKey.name ? `CONSTRAINT ${quoteIdentifier(foreignKey.name)} ` : '';
  return (
    `ALTER TABLE ${quoteIdentifier(table)} ADD ${name}FOREIGN KEY (${quotedColumns(foreignKey.columns)}) ` +
    `REFERENCES ${quoteIdentifier(foreignKey.references.table)} (${quotedColumns(foreignKey.references.columns)}) ` +
    `ON DELETE ${foreignKey.onDelete.toUpperCase()} ON UPDATE ${foreignKey.onUpdate.toUpperCase()};`
  );
}

function indexSql(table: string, index: LilypadDbResolvedIndex): string {
  const name = index.name ? `${quoteIdentifier(index.name)} ` : '';
  const using = index.using === 'btree' ? '' : ` USING ${index.using}`;
  return `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${name}ON ${quoteIdentifier(table)}${using} (${quotedColumns(index.columns)});`;
}

function uniqueSql(table: string, uniqueKey: LilypadDbResolvedUniqueKey): string {
  const name = uniqueKey.name ? `CONSTRAINT ${quoteIdentifier(uniqueKey.name)} ` : '';
  return `ALTER TABLE ${quoteIdentifier(table)} ADD ${name}UNIQUE (${quotedColumns(uniqueKey.columns)});`;
}

function checkSql(table: string, check: LilypadDbCheck & { expression: string }): string {
  return `ALTER TABLE ${quoteIdentifier(table)} ADD CONSTRAINT ${quoteIdentifier(check.name)} CHECK (${check.expression});`;
}

function describeForeignKey(foreignKey: {
  columns: readonly string[];
  references: { table: string; columns: readonly string[] };
}): string {
  return `(${foreignKey.columns.join(', ')}) → ${foreignKey.references.table} (${foreignKey.references.columns.join(', ')})`;
}

/**
 * The SQL that creates a missing table, with its keys, checks and indexes (its foreign keys are
 * separate problems), or `undefined` if the type of a column is unknown.
 */
export function lilypadCreateTableSql(
  table: string,
  primaryKey: string,
  shape: LilypadSchemaTableShape
): string | undefined {
  const columns = Object.entries(shape.cols);
  if (columns.some(([, column]) => column.pgType === undefined)) {
    return undefined;
  }
  const lines = columns.map(([name, column]) =>
    columnSql(name, column as LilypadDbColumn & { pgType: string }, shape, primaryKey)
  );
  lines.push(`PRIMARY KEY (${quoteIdentifier(primaryKey)})`);
  for (const uniqueKey of shape.unique) {
    const name = uniqueKey.name ? `CONSTRAINT ${quoteIdentifier(uniqueKey.name)} ` : '';
    lines.push(`${name}UNIQUE (${quotedColumns(uniqueKey.columns)})`);
  }
  for (const check of shape.checks) {
    if (check.expression !== undefined) {
      lines.push(`CONSTRAINT ${quoteIdentifier(check.name)} CHECK (${check.expression})`);
    }
  }
  const statements = [
    `CREATE TABLE ${quoteIdentifier(table)} (\n  ${lines.join(',\n  ')}\n);`,
    ...shape.indexes.map((index) => indexSql(table, index)),
  ];
  return statements.join('\n');
}

/** The problems of the foreign keys of a table that does not exist yet: each one is missing. */
export function lilypadMissingTableForeignKeys(
  table: string,
  shape: LilypadSchemaTableShape
): LilypadSchemaProblem[] {
  return shape.foreignKeys.map((foreignKey) => ({
    code: 'missing-foreign-key',
    severity: 'error',
    table,
    message: `The foreign key ${describeForeignKey(foreignKey)} of "${table}" does not exist.`,
    fix: foreignKeySql(table, foreignKey),
  }));
}

/**
 * The differences between the shape of a table and what the database has. It is pure.
 *
 * @param table - The table, as the check names it (`schema.table`).
 */
export function evaluateLilypadTableShape(
  table: string,
  primaryKey: string,
  shape: LilypadSchemaTableShape,
  facts: LilypadTableFacts
): LilypadShapeProblems {
  const problems: LilypadSchemaProblem[] = [];
  const deferred: LilypadSchemaProblem[] = [];
  const columns = facts.columns ?? [];
  const constraints = facts.constraints ?? [];
  const indexes = facts.indexes ?? [];
  const byName = new Map(columns.map((column) => [column.name, column]));
  const quotedTable = quoteIdentifier(table);
  const push = (
    code: LilypadSchemaProblem['code'],
    severity: LilypadSchemaProblem['severity'],
    message: string,
    fix?: string
  ) => {
    problems.push({ code, severity, table, message, ...(fix !== undefined && { fix }) });
  };

  // Columns
  for (const [name, column] of Object.entries(shape.cols)) {
    const installed = byName.get(name);
    if (!installed) {
      push(
        'missing-column',
        'error',
        `The column "${name}" of "${table}" does not exist.`,
        column.pgType === undefined
          ? undefined
          : `ALTER TABLE ${quotedTable} ADD COLUMN ${columnSql(name, column as LilypadDbColumn & { pgType: string }, shape, primaryKey)};`
      );
      continue;
    }
    if (column.pgType !== undefined) {
      if (!sameType(column.pgType, installed.type)) {
        push(
          'column-type-mismatch',
          'error',
          `The column "${name}" of "${table}" is ${installed.type}, not ${normalizeLilypadPgType(column.pgType)}.`,
          `ALTER TABLE ${quotedTable} ALTER COLUMN ${quoteIdentifier(name)} TYPE ${column.pgType};`
        );
      }
    } else if (column.type !== undefined) {
      const mismatch = typeMismatch(column.type, installed);
      if (mismatch) {
        push(
          'column-type-mismatch',
          'warning',
          `The column "${name}" of "${table}" is ${installed.type}, declared as ${column.type}: ${mismatch}.`
        );
      }
    }
    if (column.nullable === false && !installed.notNull) {
      push(
        'column-nullability-mismatch',
        'error',
        `The column "${name}" of "${table}" accepts NULL, but is declared not nullable.`,
        `ALTER TABLE ${quotedTable} ALTER COLUMN ${quoteIdentifier(name)} SET NOT NULL;`
      );
    } else if (column.nullable === true && installed.notNull) {
      push(
        'column-nullability-mismatch',
        'error',
        `The column "${name}" of "${table}" is NOT NULL, but is declared nullable.`,
        name === primaryKey
          ? undefined
          : `ALTER TABLE ${quotedTable} ALTER COLUMN ${quoteIdentifier(name)} DROP NOT NULL;`
      );
    }
    if (
      expectsDefault(name, column, shape, primaryKey) &&
      !installed.hasDefault &&
      !installed.identity &&
      !installed.generated
    ) {
      push(
        'missing-column-default',
        'error',
        shape.generatedPrimaryKey === true && name === primaryKey
          ? `The primary key "${name}" of "${table}" is declared generated (generatedPrimaryKey), but the database does not generate it.`
          : `The column "${name}" of "${table}" has no default.`,
        typeof column.default === 'object'
          ? `ALTER TABLE ${quotedTable} ALTER COLUMN ${quoteIdentifier(name)} SET DEFAULT ${column.default.sql};`
          : undefined
      );
    }
  }
  for (const column of columns) {
    if (Object.hasOwn(shape.cols, column.name)) {
      continue;
    }
    if (column.notNull && !column.hasDefault && !column.identity && !column.generated) {
      push(
        'undeclared-required-column',
        'warning',
        `The column "${column.name}" of "${table}" is NOT NULL without a default, and is not in \`cols\`: inserts through the library fail.`
      );
    } else if (shape.strict) {
      push(
        'undeclared-column',
        'warning',
        `The column "${column.name}" (${column.type}) of "${table}" is not in \`cols\`.`
      );
    }
  }

  // Primary key
  const primary = constraints.find((constraint) => constraint.type === 'p');
  const isUsableUnique = (index: LilypadIndexInfo) =>
    index.unique && !index.partial && !index.expressions;
  if (!primary || !sameList(primary.columns, [primaryKey])) {
    const uniqueOnKey = indexes.some(
      (index) => isUsableUnique(index) && sameList(index.columns, [primaryKey])
    );
    const notNull = byName.get(primaryKey)?.notNull ?? false;
    const found = primary
      ? `its primary key is (${primary.columns.join(', ')})`
      : 'it has no primary key';
    if (uniqueOnKey && notNull) {
      push(
        'wrong-primary-key',
        'warning',
        `The key "${primaryKey}" of "${table}" is unique and NOT NULL, but ${found}.`
      );
    } else if (byName.has(primaryKey)) {
      push(
        'wrong-primary-key',
        'error',
        `The key "${primaryKey}" of "${table}" is not unique: ${found}.`,
        primary
          ? undefined
          : `ALTER TABLE ${quotedTable} ADD PRIMARY KEY (${quoteIdentifier(primaryKey)});`
      );
    }
  }

  // Unique keys: satisfied by the primary key, a unique constraint or a unique index
  const uniqueSets: (string | null)[][] = [
    ...constraints
      .filter((constraint) => constraint.type === 'p' || constraint.type === 'u')
      .map((constraint) => constraint.columns),
    ...indexes.filter(isUsableUnique).map((index) => index.columns),
  ];
  for (const uniqueKey of shape.unique) {
    if (!uniqueSets.some((columns) => sameSet(columns, uniqueKey.columns))) {
      push(
        'missing-unique-key',
        'error',
        `The columns (${uniqueKey.columns.join(', ')}) of "${table}" are not unique together: no unique constraint or index covers exactly them.`,
        uniqueSql(table, uniqueKey)
      );
    }
  }

  // Foreign keys: the same pairs of columns, the same referenced table
  const foreignConstraints = constraints.filter((constraint) => constraint.type === 'f');
  const pairs = (columns: readonly string[], referenced: readonly string[]) =>
    columns.map((column, index) => `${column}\u0000${referenced[index] ?? ''}`);
  const matchesForeignKey = (
    constraint: LilypadConstraintInfo,
    foreignKey: LilypadDbResolvedForeignKey
  ) =>
    constraint.referencedTable === foreignKey.references.table &&
    sameSet(
      pairs(constraint.columns, constraint.referencedColumns),
      pairs(foreignKey.columns, foreignKey.references.columns)
    );
  const matchedConstraints = new Set<LilypadConstraintInfo>();
  for (const foreignKey of shape.foreignKeys) {
    const installed = foreignConstraints.find((constraint) =>
      matchesForeignKey(constraint, foreignKey)
    );
    if (!installed) {
      deferred.push({
        code: 'missing-foreign-key',
        severity: 'error',
        table,
        message: `The foreign key ${describeForeignKey(foreignKey)} of "${table}" does not exist.`,
        fix: foreignKeySql(table, foreignKey),
      });
      continue;
    }
    matchedConstraints.add(installed);
    const onDelete = ACTION_NAMES[installed.onDelete] ?? installed.onDelete;
    const onUpdate = ACTION_NAMES[installed.onUpdate] ?? installed.onUpdate;
    if (onDelete !== foreignKey.onDelete || onUpdate !== foreignKey.onUpdate) {
      push(
        'foreign-key-mismatch',
        'error',
        `The foreign key ${describeForeignKey(foreignKey)} of "${table}" is ON DELETE ${onDelete.toUpperCase()} ON UPDATE ${onUpdate.toUpperCase()}, not ON DELETE ${foreignKey.onDelete.toUpperCase()} ON UPDATE ${foreignKey.onUpdate.toUpperCase()}.`,
        `ALTER TABLE ${quotedTable} DROP CONSTRAINT ${quoteIdentifier(installed.name)};\n` +
          foreignKeySql(table, { ...foreignKey, name: foreignKey.name ?? installed.name })
      );
    }
  }

  // Indexes: the same columns in the same order, the same method, unique if declared unique
  const usableIndexes = indexes.filter((index) => !index.partial && !index.expressions);
  const matchedIndexes = new Set<LilypadIndexInfo>();
  for (const declared of shape.indexes) {
    const installed = usableIndexes.find(
      (index) =>
        sameList(index.columns, declared.columns) &&
        index.method === declared.using &&
        (!declared.unique || index.unique)
    );
    if (installed) {
      matchedIndexes.add(installed);
    } else {
      push(
        'missing-index',
        declared.unique ? 'error' : 'warning',
        `${declared.unique ? 'The unique' : 'The'} ${declared.using} index on (${declared.columns.join(', ')}) of "${table}" does not exist.`,
        indexSql(table, declared)
      );
    }
  }

  // Checks, by name
  for (const check of shape.checks) {
    if (
      !constraints.some((constraint) => constraint.type === 'c' && constraint.name === check.name)
    ) {
      push(
        'missing-check',
        'error',
        `The check "${check.name}" of "${table}" does not exist.`,
        check.expression === undefined
          ? undefined
          : checkSql(table, check as LilypadDbCheck & { expression: string })
      );
    }
  }

  if (shape.strict) {
    for (const constraint of constraints) {
      const declared =
        constraint.type === 'p' ||
        (constraint.type === 'f' && matchedConstraints.has(constraint)) ||
        (constraint.type === 'u' &&
          (shape.unique.some((key) => sameSet(key.columns, constraint.columns)) ||
            shape.indexes.some(
              (index) => index.unique && sameSet(index.columns, constraint.columns)
            ))) ||
        (constraint.type === 'c' && shape.checks.some((check) => check.name === constraint.name));
      if (!declared) {
        const kind =
          constraint.type === 'f'
            ? `foreign key (${constraint.columns.join(', ')}) → ${constraint.referencedTable ?? '?'} (${constraint.referencedColumns.join(', ')})`
            : constraint.type === 'u'
              ? `unique key (${constraint.columns.join(', ')})`
              : `check "${constraint.name}"`;
        push(
          'undeclared-constraint',
          'warning',
          `The ${kind} of "${table}" is not in its description.`
        );
      }
    }
    for (const index of indexes) {
      const declared =
        index.constraint ||
        matchedIndexes.has(index) ||
        (index.unique &&
          !index.partial &&
          !index.expressions &&
          shape.unique.some((key) => sameSet(key.columns, index.columns)));
      if (!declared) {
        push(
          'undeclared-index',
          'warning',
          `The index "${index.name}" (${index.method}: ${columnList(index.columns)}) of "${table}" is not in its description.`
        );
      }
    }
  }

  return { problems, deferred };
}
