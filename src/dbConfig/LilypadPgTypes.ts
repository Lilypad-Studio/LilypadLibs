/**
 * What the library knows about the PostgreSQL types, in one place: their spellings, and what
 * postgres.js returns for them. `defineLilypadDb`, the types of `defineLilypadTable` and
 * `lilypad-doctor` all read it from here.
 */

/**
 * The type of a column, as postgres.js returns it (it converts the values; the library does not),
 * with the type of those values: a `bigint` is an `int8`, which postgres.js returns as a string.
 * For a primary key it tells `LilypadDbCache` how to read the ids that notifications and the
 * changelog carry as text: `number` converts them to numbers, the others keep them as strings.
 */
export type LilypadDbColumnValues = {
  string: string;
  number: number;
  bigint: string;
  boolean: boolean;
  date: Date;
  json: string | number | boolean | object;
  array: readonly unknown[];
};

/**
 * The type of a column (see {@link LilypadDbColumnValues}). It follows from a known `pgType`;
 * `lilypad-doctor` checks that the database type fits it.
 */
export type LilypadDbColumnType = keyof LilypadDbColumnValues;

/** Every column type. */
export const LILYPAD_DB_COLUMN_TYPES: readonly LilypadDbColumnType[] = Object.keys({
  string: true,
  number: true,
  bigint: true,
  boolean: true,
  date: true,
  json: true,
  array: true,
} satisfies Record<LilypadDbColumnType, true>) as LilypadDbColumnType[];

type ColumnTypes = readonly [LilypadDbColumnType, ...LilypadDbColumnType[]];

/**
 * The PostgreSQL types whose JavaScript type is known, by the name `format_type` gives them:
 * - `types`: the column type postgres.js returns them as, then the others that fit them (an
 *   `int8` is a string, which a `string` column describes too);
 * - `aliases`: their other spellings;
 * - `serials`: the serial types of this integer type (which only integer types have).
 *
 * Enums, domains and the types of extensions (except `citext`) are not here.
 */
const PG_TYPES = {
  smallint: { types: ['number'], aliases: ['int2'], serials: ['smallserial', 'serial2'] },
  integer: { types: ['number'], aliases: ['int', 'int4'], serials: ['serial', 'serial4'] },
  bigint: { types: ['bigint', 'string'], aliases: ['int8'], serials: ['bigserial', 'serial8'] },
  real: { types: ['number'], aliases: ['float4'] },
  'double precision': { types: ['number'], aliases: ['float8', 'float'] },
  numeric: { types: ['string', 'bigint'], aliases: ['decimal'] },
  money: { types: ['string'] },
  text: { types: ['string'] },
  'character varying': { types: ['string'], aliases: ['varchar'] },
  character: { types: ['string'], aliases: ['char', 'bpchar'] },
  name: { types: ['string'] },
  citext: { types: ['string'] },
  uuid: { types: ['string'] },
  xml: { types: ['string'] },
  inet: { types: ['string'] },
  cidr: { types: ['string'] },
  macaddr: { types: ['string'] },
  macaddr8: { types: ['string'] },
  interval: { types: ['string'] },
  bit: { types: ['string'] },
  'bit varying': { types: ['string'], aliases: ['varbit'] },
  tsvector: { types: ['string'] },
  tsquery: { types: ['string'] },
  // postgres.js parses the dates and the timestamps, not the times of day
  'time without time zone': { types: ['string'], aliases: ['time'] },
  'time with time zone': { types: ['string'], aliases: ['timetz'] },
  date: { types: ['date'] },
  'timestamp without time zone': { types: ['date'], aliases: ['timestamp'] },
  'timestamp with time zone': { types: ['date'], aliases: ['timestamptz'] },
  boolean: { types: ['boolean'], aliases: ['bool'] },
  json: { types: ['json'] },
  jsonb: { types: ['json'] },
} as const satisfies Record<
  string,
  { types: ColumnTypes; aliases?: readonly string[]; serials?: readonly string[] }
>;

type PgTypes = typeof PG_TYPES;
type PgTypeName = keyof PgTypes;
type PgTypeEntry = { types: ColumnTypes; aliases?: readonly string[]; serials?: readonly string[] };

const entries = Object.entries(PG_TYPES) as [PgTypeName, PgTypeEntry][];

/** Each alias and serial type, with the name of its type. */
const ALIASES = new Map<string, string>(
  entries.flatMap(([name, type]) =>
    [...(type.aliases ?? []), ...(type.serials ?? [])].map((alias) => [alias, name] as const)
  )
);

const SERIAL_TYPES = new Set(entries.flatMap(([, type]) => type.serials ?? []));

/**
 * The column types that fit a column of unknown type, by `pg_type.typcategory`: a domain has the
 * category of its base type, and PostgreSQL sends its values as those of its base type.
 */
const CATEGORY_TYPES: Readonly<Record<string, ColumnTypes>> = {
  A: ['array'],
  B: ['boolean'],
  D: ['date'],
  N: ['number'],
  S: ['string'],
  E: ['string'],
  I: ['string'],
  V: ['string'],
  T: ['string'],
};

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
  const resolved = ALIASES.get(name) ?? name;
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

/** The known type of a `pgType`, without its modifiers (`character varying(64)` is `character varying`). */
function knownType(pgType: string): PgTypeEntry | undefined {
  const name = normalizeLilypadPgType(pgType).replace(/\([^)]*\)/, '');
  return Object.hasOwn(PG_TYPES, name) ? PG_TYPES[name as PgTypeName] : undefined;
}

/**
 * The column types that describe a `pgType`, the one postgres.js returns it as first (e.g.
 * `['bigint', 'string']` for `int8`); `undefined` for a type whose JavaScript type is not known
 * (an enum, a domain, the type of an extension). Any array is `['array']`. It reads the spellings
 * of `normalizeLilypadPgType`.
 */
export function lilypadColumnTypesOfPgType(pgType: string): ColumnTypes | undefined {
  return normalizeLilypadPgType(pgType).endsWith('[]') ? ['array'] : knownType(pgType)?.types;
}

/**
 * When postgres.js does not return a column of `pgType` as `type`, the column types that fit it
 * (the one it returns first); otherwise, or when the type is not known, `undefined`. A type that
 * is not known is judged by its `pg_type.typcategory`, when given.
 */
export function lilypadColumnTypeMismatch(
  type: LilypadDbColumnType,
  pgType: string,
  category?: string
): ColumnTypes | undefined {
  const fitting =
    lilypadColumnTypesOfPgType(pgType) ??
    (category !== undefined && Object.hasOwn(CATEGORY_TYPES, category)
      ? CATEGORY_TYPES[category]
      : undefined);
  return fitting && !fitting.includes(type) ? fitting : undefined;
}

/** Whether a `pgType` is a serial type (`serial`, `bigserial`...), which has a default. */
export function isLilypadSerialPgType(pgType: string): boolean {
  return SERIAL_TYPES.has(pgType.trim().toLowerCase());
}

/** Whether a `pgType` is an integer type (one that has serial types), which can be an identity. */
export function isLilypadIntegerPgType(pgType: string): boolean {
  return knownType(pgType)?.serials !== undefined && !normalizeLilypadPgType(pgType).endsWith('[]');
}

// The same, for the types

/** The spellings of a known type: its name, its aliases, its serial types. */
type Spellings<N extends PgTypeName> =
  | N
  | (PgTypes[N] extends { aliases: readonly (infer A extends string)[] } ? A : never)
  | (PgTypes[N] extends { serials: readonly (infer S extends string)[] } ? S : never);

/** `timestamp(3) with time zone`: the precision of a time type goes before its zone. */
type WithPrecision<N extends string> =
  N extends `${infer Base} ${infer Zone extends `with${string}`}`
    ? `${Base}(${number}) ${Zone}`
    : never;

type WithModifiers<N extends string> =
  | N
  | `${N}(${number})`
  | `${N}(${number},${number})`
  | `${N}(${number}, ${number})`;

/** The spellings of the known types that fit the column type `C`. */
type PgTypeSpelling<C extends LilypadDbColumnType> = {
  [N in PgTypeName]: C extends PgTypes[N]['types'][number]
    ? WithModifiers<Spellings<N>> | WithPrecision<N>
    : never;
}[PgTypeName];

/**
 * The `pgType`s whose column type is known to fit `C` (see {@link lilypadColumnTypesOfPgType}), in
 * lower case: `'int4'`, `'varchar(64)'`, `'numeric(10, 2)'`, `'timestamp(3) with time zone'`...
 * Any array (`'text[]'`, `'mood[]'`) fits `array`.
 */
export type LilypadPgTypeOf<C extends LilypadDbColumnType> = C extends 'array'
  ? `${string}[]`
  : PgTypeSpelling<C>;

/**
 * The column types that fit a property of the row type: those whose values
 * ({@link LilypadDbColumnValues}) it accepts. `null` and `undefined` are left out (see
 * `nullable`); `unknown` fits every type, and a JavaScript `bigint` none (postgres.js returns
 * `int8` as a string).
 */
export type LilypadDbColumnTypeOf<V> = unknown extends V
  ? LilypadDbColumnType
  : [Exclude<V, null | undefined>] extends [never]
    ? LilypadDbColumnType
    : ColumnTypesOfValue<Exclude<V, null | undefined>>;

/** Distributed over a union: the column types of each of its members. */
type ColumnTypesOfValue<V> = {
  [C in LilypadDbColumnType]: V extends LilypadDbColumnValues[C] ? C : never;
}[LilypadDbColumnType];
