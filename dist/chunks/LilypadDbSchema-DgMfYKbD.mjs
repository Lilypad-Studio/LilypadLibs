import { t as assertNumberOption } from "./LilypadValidation-ByfswRPE.mjs";
//#region src/dbConfig/LilypadDbConfigDefaults.ts
/** The defaults of the database configs (see `defineLilypadDb`). */
const LILYPAD_DEFAULT_CHANGELOG_TABLE = "lilypad_cache_changes";
const LILYPAD_DEFAULT_NOTIFY_CHANNEL = "cache_events";
/** The name of the config of `lilypad.config.*`: the others are `lilypad.<name>.config.*`. */
const LILYPAD_DEFAULT_DB_CONFIG_NAME = "default";
/** The default `maxGap` of the `changelog` strategy, and the default `minRetention` of the changelog. */
const LILYPAD_DEFAULT_MAX_GAP = 36e5;
//#endregion
//#region src/dbConfig/LilypadPgTypes.ts
/** Every column type. */
const LILYPAD_DB_COLUMN_TYPES = Object.keys({
	string: true,
	number: true,
	bigint: true,
	boolean: true,
	date: true,
	json: true,
	array: true
});
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
	smallint: {
		types: ["number"],
		aliases: ["int2"],
		serials: ["smallserial", "serial2"]
	},
	integer: {
		types: ["number"],
		aliases: ["int", "int4"],
		serials: ["serial", "serial4"]
	},
	bigint: {
		types: ["bigint", "string"],
		aliases: ["int8"],
		serials: ["bigserial", "serial8"]
	},
	real: {
		types: ["number"],
		aliases: ["float4"]
	},
	"double precision": {
		types: ["number"],
		aliases: ["float8", "float"]
	},
	numeric: {
		types: ["string", "bigint"],
		aliases: ["decimal"]
	},
	money: { types: ["string"] },
	text: { types: ["string"] },
	"character varying": {
		types: ["string"],
		aliases: ["varchar"]
	},
	character: {
		types: ["string"],
		aliases: ["char", "bpchar"]
	},
	name: { types: ["string"] },
	citext: { types: ["string"] },
	uuid: { types: ["string"] },
	xml: { types: ["string"] },
	inet: { types: ["string"] },
	cidr: { types: ["string"] },
	macaddr: { types: ["string"] },
	macaddr8: { types: ["string"] },
	interval: { types: ["string"] },
	bit: { types: ["string"] },
	"bit varying": {
		types: ["string"],
		aliases: ["varbit"]
	},
	tsvector: { types: ["string"] },
	tsquery: { types: ["string"] },
	"time without time zone": {
		types: ["string"],
		aliases: ["time"]
	},
	"time with time zone": {
		types: ["string"],
		aliases: ["timetz"]
	},
	date: { types: ["date"] },
	"timestamp without time zone": {
		types: ["date"],
		aliases: ["timestamp"]
	},
	"timestamp with time zone": {
		types: ["date"],
		aliases: ["timestamptz"]
	},
	boolean: {
		types: ["boolean"],
		aliases: ["bool"]
	},
	json: { types: ["json"] },
	jsonb: { types: ["json"] }
};
const entries = Object.entries(PG_TYPES);
/** Each alias and serial type, with the name of its type. */
const ALIASES = new Map(entries.flatMap(([name, type]) => [...type.aliases ?? [], ...type.serials ?? []].map((alias) => [alias, name])));
const SERIAL_TYPES = new Set(entries.flatMap(([, type]) => type.serials ?? []));
/**
* The column types that fit a column of unknown type, by `pg_type.typcategory`: a domain has the
* category of its base type, and PostgreSQL sends its values as those of its base type.
*/
const CATEGORY_TYPES = {
	A: ["array"],
	B: ["boolean"],
	D: ["date"],
	N: ["number"],
	S: ["string"],
	E: ["string"],
	I: ["string"],
	V: ["string"],
	T: ["string"]
};
/**
* A PostgreSQL type as `format_type` writes it: lower case, aliases resolved (`int4` is
* `integer`, `varchar(64)` is `character varying(64)`, `timestamptz(3)` is
* `timestamp(3) with time zone`), array suffixes kept.
*/
function normalizeLilypadPgType(type) {
	let text = type.trim().toLowerCase().replace(/\s+/g, " ");
	let arrays = "";
	while (text.endsWith("[]")) {
		arrays += "[]";
		text = text.slice(0, -2).trimEnd();
	}
	const open = text.indexOf("(");
	const close = open < 0 ? -1 : text.indexOf(")", open);
	const name = (close < 0 ? text : text.slice(0, open)).trim();
	const args = close < 0 ? "" : text.slice(open, close + 1).replace(/\s+/g, "");
	const rest = close < 0 ? "" : text.slice(close + 1).trim();
	if (name === "timestamp" || name === "time") return `${name}${args} ${rest || "without time zone"}${arrays}`;
	const resolved = ALIASES.get(name) ?? name;
	if (resolved === "character" && !args) return `character(1)${arrays}`;
	const zone = /^(timestamp|time) (with|without) time zone$/.exec(resolved);
	if (zone) return `${zone[1]}${args} ${zone[2]} time zone${arrays}`;
	return `${resolved}${args}${rest ? ` ${rest}` : ""}${arrays}`;
}
/** The known type of a `pgType`, without its modifiers (`character varying(64)` is `character varying`). */
function knownType(pgType) {
	const name = normalizeLilypadPgType(pgType).replace(/\([^)]*\)/, "");
	return Object.hasOwn(PG_TYPES, name) ? PG_TYPES[name] : void 0;
}
/**
* The column types that describe a `pgType`, the one postgres.js returns it as first (e.g.
* `['bigint', 'string']` for `int8`); `undefined` for a type whose JavaScript type is not known
* (an enum, a domain, the type of an extension). Any array is `['array']`. It reads the spellings
* of `normalizeLilypadPgType`.
*/
function lilypadColumnTypesOfPgType(pgType) {
	return normalizeLilypadPgType(pgType).endsWith("[]") ? ["array"] : knownType(pgType)?.types;
}
/**
* When postgres.js does not return a column of `pgType` as `type`, the column types that fit it
* (the one it returns first); otherwise, or when the type is not known, `undefined`. A type that
* is not known is judged by its `pg_type.typcategory`, when given.
*/
function lilypadColumnTypeMismatch(type, pgType, category) {
	const fitting = lilypadColumnTypesOfPgType(pgType) ?? (category !== void 0 && Object.hasOwn(CATEGORY_TYPES, category) ? CATEGORY_TYPES[category] : void 0);
	return fitting && !fitting.includes(type) ? fitting : void 0;
}
/** Whether a `pgType` is a serial type (`serial`, `bigserial`...), which has a default. */
function isLilypadSerialPgType(pgType) {
	return SERIAL_TYPES.has(pgType.trim().toLowerCase());
}
/** Whether a `pgType` is an integer type (one that has serial types), which can be an identity. */
function isLilypadIntegerPgType(pgType) {
	return knownType(pgType)?.serials !== void 0 && !normalizeLilypadPgType(pgType).endsWith("[]");
}
//#endregion
//#region src/dbConfig/LilypadDbConfigValidation.ts
const OWNER = "defineLilypadDb";
const CONFIG_NAME = /^[A-Za-z0-9_-]+$/;
const COLUMN_TYPES = new Set(LILYPAD_DB_COLUMN_TYPES);
const ACTIONS = /* @__PURE__ */ new Set([
	"no action",
	"restrict",
	"cascade",
	"set null",
	"set default"
]);
const INDEX_METHODS = /* @__PURE__ */ new Set([
	"btree",
	"hash",
	"gin",
	"gist",
	"brin",
	"spgist"
]);
const PRUNING_MODES = /* @__PURE__ */ new Set([
	"detect",
	"trigger",
	"cron",
	"external"
]);
function fail(message) {
	throw new Error(`${OWNER}: ${message}`);
}
function isNonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0;
}
function assertName(value, what) {
	if (!isNonEmptyString(value)) fail(`${what} must be a non-empty string (got ${JSON.stringify(value)}).`);
}
function assertOneOf(value, allowed, what) {
	if (value !== void 0 && (typeof value !== "string" || !allowed.has(value))) fail(`${what} must be one of ${[...allowed].join(", ")} (got ${JSON.stringify(value)}).`);
}
/** `schema.table` has at most one dot, and no empty part. */
function assertTableName(value, what) {
	assertName(value, what);
	const parts = value.split(".");
	if (parts.length > 2 || parts.some((part) => part.length === 0)) fail(`${what} must be "table" or "schema.table" (got "${value}").`);
}
function assertColumns(columns, known, what) {
	if (!Array.isArray(columns) || columns.length === 0) fail(`${what} must list at least one column.`);
	for (const column of columns) if (typeof column !== "string" || !Object.hasOwn(known, column)) fail(`${what} names "${String(column)}", which is not a column of \`cols\`.`);
}
function assertReference(reference, what) {
	if (typeof reference !== "object" || reference === null) fail(`${what} must be an object.`);
	assertTableName(reference.table, `${what}.table`);
	assertOneOf(reference.onDelete, ACTIONS, `${what}.onDelete`);
	assertOneOf(reference.onUpdate, ACTIONS, `${what}.onUpdate`);
}
function assertColumn(column, what) {
	if (typeof column !== "object" || column === null) fail(`${what} must be an object (e.g. { type: 'string' }).`);
	assertOneOf(column.type, COLUMN_TYPES, `${what}.type`);
	if (column.pgType !== void 0) {
		assertName(column.pgType, `${what}.pgType`);
		const fitting = column.type === void 0 ? void 0 : lilypadColumnTypeMismatch(column.type, column.pgType);
		if (fitting) fail(`${what}.type "${String(column.type)}" does not fit its pgType "${column.pgType}", which postgres.js returns as ${fitting[0]}: declare ${fitting.map((type) => `"${type}"`).join(" or ")}, or leave type out.`);
	}
	if (column.converted !== void 0 && typeof column.converted !== "boolean") fail(`${what}.converted must be a boolean.`);
	const columnDefault = column.default;
	if (columnDefault !== void 0 && columnDefault !== true && !(typeof columnDefault === "object" && columnDefault !== null && isNonEmptyString(columnDefault.sql))) fail(`${what}.default must be true or { sql: '<expression>' }.`);
	if (column.references !== void 0) {
		assertReference(column.references, `${what}.references`);
		if (column.references.column !== void 0) assertName(column.references.column, `${what}.references.column`);
	}
}
function assertSync(sync, what) {
	if (sync === void 0) return;
	assertOneOf(sync.strategy, /* @__PURE__ */ new Set([
		"listen",
		"changelog",
		"none"
	]), `${what}.strategy`);
	if (sync.strategy === "none") return;
	assertNumberOption(OWNER, `${what}.maxAge`, sync.maxAge, "non-negative");
	if (sync.strategy === "listen") {
		assertOneOf(sync.connect, /* @__PURE__ */ new Set(["eager", "lazy"]), `${what}.connect`);
		return;
	}
	if (typeof sync.pollInterval !== "number") fail(`${what}.pollInterval is required with the changelog strategy.`);
	assertNumberOption(OWNER, `${what}.pollInterval`, sync.pollInterval, "non-negative");
	assertNumberOption(OWNER, `${what}.maxGap`, sync.maxGap, "positive");
	assertNumberOption(OWNER, `${what}.lookback`, sync.lookback, "non-negative");
	assertOneOf(sync.poll, /* @__PURE__ */ new Set(["await", "background"]), `${what}.poll`);
}
/** The functions a table description may no longer hold, and the hook that replaces each. */
const HOOK_FIELDS = {
	writeSanitizationFn: "write",
	selectSanitizationFn: "select",
	hooks: "write, select"
};
/**
* A config holds no function, so that `lilypad-doctor` loads it without the application code:
* they are bound by the application (a config in JavaScript is not type-checked).
*/
function assertNoHooks(key, table) {
	for (const [field, hook] of Object.entries(HOOK_FIELDS)) if (table[field] !== void 0) fail(`tables.${key}.${field}: a config holds no functions, so that lilypad-doctor loads it without the application code. Bind them where the application creates its gate: bindLilypadDbHooks(db, { ${key}: { ${hook} } }).`);
}
function assertTable(key, table, defaultSchema) {
	const what = `tables.${key}`;
	if (typeof table !== "object" || table === null) fail(`${what} must be a table (see defineLilypadTable).`);
	assertTableName(table.tableName, `${what}.tableName`);
	const qualified = table.tableName.includes(".");
	if (table.schemaName !== void 0) {
		assertName(table.schemaName, `${what}.schemaName`);
		if (qualified) fail(`${what}: give the schema in tableName or in schemaName, not both.`);
	}
	const cols = table.cols;
	if (typeof cols !== "object" || cols === null || Object.keys(cols).length === 0) fail(`${what}.cols must describe at least one column.`);
	for (const [name, column] of Object.entries(cols)) assertColumn(column, `${what}.cols.${name}`);
	if (typeof table.primaryKey !== "string" || !Object.hasOwn(cols, table.primaryKey)) fail(`${what}.primaryKey "${String(table.primaryKey)}" is not a column of \`cols\`.`);
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
		if (foreignKey.references.columns !== void 0) {
			const referencedColumns = foreignKey.references.columns;
			if (!Array.isArray(referencedColumns) || referencedColumns.length === 0 || !referencedColumns.every(isNonEmptyString)) fail(`${what}.foreignKeys[${index}].references.columns must list column names.`);
		}
	});
	const checkNames = /* @__PURE__ */ new Set();
	(table.checks ?? []).forEach((check, index) => {
		assertName(check.name, `${what}.checks[${index}].name`);
		if (checkNames.has(check.name)) fail(`${what}.checks has two checks named "${check.name}".`);
		checkNames.add(check.name);
		if (check.expression !== void 0) assertName(check.expression, `${what}.checks[${index}].expression`);
	});
	assertSync(table.sync, `${what}.sync`);
	assertNoHooks(key, table);
	return qualified ? table.tableName : `${table.schemaName ?? defaultSchema}.${table.tableName}`;
}
/**
* Checks a config before `defineLilypadDb` resolves it: only the config itself, never the
* database.
*
* @throws With a message naming the option that is not valid.
*/
function validateLilypadDbConfigInput(input) {
	if (typeof input !== "object" || input === null) fail("the config must be an object.");
	if (input.name !== void 0 && (typeof input.name !== "string" || !CONFIG_NAME.test(input.name))) fail(`name must contain only letters, digits, "_" and "-" (got ${JSON.stringify(input.name)}).`);
	if (input.defaultSchema !== void 0) assertName(input.defaultSchema, "defaultSchema");
	if (input.notifyChannel !== void 0) assertName(input.notifyChannel, "notifyChannel");
	if (input.changelog !== void 0) {
		if (input.changelog.table !== void 0) assertTableName(input.changelog.table, "changelog.table");
		assertOneOf(input.changelog.pruning, PRUNING_MODES, "changelog.pruning");
		assertNumberOption(OWNER, "changelog.minRetention", input.changelog.minRetention, "positive");
	}
	if (typeof input.tables !== "object" || input.tables === null) fail("tables must be an object: { <key>: <table> }.");
	const defaultSchema = input.defaultSchema ?? "public";
	const keys = /* @__PURE__ */ new Map();
	for (const [key, table] of Object.entries(input.tables)) {
		const qualifiedName = assertTable(key, table, defaultSchema);
		const previous = keys.get(qualifiedName);
		if (previous !== void 0) fail(`tables.${previous} and tables.${key} are both the table "${qualifiedName}".`);
		keys.set(qualifiedName, key);
	}
}
//#endregion
//#region src/dbConfig/LilypadDbConfig.ts
/**
* The config of a database: the tables the library reads and writes, how each one is kept in sync,
* and what the database must provide for it (the changelog, the notification triggers, the
* pruning). The application imports it at runtime, where nothing is compared with the database;
* `lilypad-doctor` loads the same file and checks the database against it. It holds no function:
* the application binds the functions applied to the rows with `bindLilypadDbHooks`.
*/
/** Marks the objects made by `defineLilypadDb` (shared by every copy of the library). */
const LILYPAD_DB_CONFIG = Symbol.for("lilypad.dbConfig");
/** Marks the table definitions made by `defineLilypadDb`. */
const LILYPAD_DB_TABLE = Symbol.for("lilypad.dbTable");
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
function defineLilypadTable(input) {
	return input;
}
/** Whether a value is a config made by {@link defineLilypadDb} (by any copy of the library). */
function isLilypadDbConfig(value) {
	return typeof value === "object" && value !== null && value[LILYPAD_DB_CONFIG] === true;
}
/** Whether a value is a table definition made by {@link defineLilypadDb}. */
function isLilypadDbTableDefinition(value) {
	return typeof value === "object" && value !== null && value[LILYPAD_DB_TABLE] === true;
}
/**
* The table definition passed to `gate.table()` or `LilypadDbCache.create()`: a definition, or
* the key of a table in `config`. A definition without hooks of a table of `config` takes the
* hooks bound to it there (see {@link withConfigHooks}).
*
* @throws If it is neither.
*/
function resolveLilypadDbTable(owner, table, config) {
	if (typeof table === "string") {
		if (!config) throw new Error(`${owner}: the table "${table}" is given by name, but there is no config to find it in (pass \`config\`, or create the gate with one).`);
		const definition = Object.hasOwn(config.tables, table) ? config.tables[table] : void 0;
		if (!definition) throw new Error(`${owner}: the config "${config.name}" has no table "${table}".`);
		return definition;
	}
	if (!isLilypadDbTableDefinition(table)) throw new Error(`${owner}: the table must be a table of a config made with defineLilypadDb (e.g. db.tables.users), or its name.`);
	return withConfigHooks(table, config);
}
/**
* A definition given without hooks (e.g. `db.tables.users`, imported from the config file) of a
* table to which `config` binds hooks (the config of `bindLilypadDbHooks`, given to the gate)
* takes those hooks: importing the original config instead of the bound one cannot skip them.
* It must be the same table of a config of the same name.
*/
function withConfigHooks(definition, config) {
	if (definition.hooks || !config || !Object.hasOwn(config.tables, definition.key)) return definition;
	const bound = config.tables[definition.key];
	if (!bound?.hooks || bound.db.name !== definition.db.name || bound.qualifiedName !== definition.qualifiedName) return definition;
	return Object.freeze({
		...definition,
		hooks: bound.hooks
	});
}
/** The columns, each with the `type` that follows from its `pgType` when it has none. */
function resolveColumns(cols) {
	return Object.fromEntries(Object.entries(cols).map(([name, column]) => {
		const type = column.type ?? (column.pgType === void 0 ? void 0 : lilypadColumnTypesOfPgType(column.pgType)?.[0]);
		return [name, type === column.type ? column : {
			...column,
			type
		}];
	}));
}
/** Splits `schema.table`, or applies the default schema. */
function qualify(name, defaultSchema) {
	const separator = name.lastIndexOf(".");
	return separator < 0 ? {
		schema: defaultSchema,
		table: name
	} : {
		schema: name.slice(0, separator),
		table: name.slice(separator + 1)
	};
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
function defineLilypadDb(input) {
	validateLilypadDbConfigInput(input);
	const defaultSchema = input.defaultSchema ?? "public";
	const settings = Object.freeze({
		name: input.name ?? "default",
		defaultSchema,
		notifyChannel: input.notifyChannel ?? "cache_events",
		changelogTable: input.changelog?.table ?? "lilypad_cache_changes"
	});
	const located = Object.entries(input.tables).map(([key, table]) => {
		const { schema, table: tableName } = qualify(table.tableName, table.schemaName ?? defaultSchema);
		return {
			key,
			table,
			schema,
			tableName,
			qualifiedName: `${schema}.${tableName}`
		};
	});
	const byName = /* @__PURE__ */ new Map();
	for (const entry of located) {
		byName.set(entry.qualifiedName, entry);
		if (!byName.has(entry.tableName) || entry.schema === defaultSchema) byName.set(entry.tableName, entry);
	}
	const referenced = (name, owner, columns) => {
		const target = byName.get(name);
		const qualified = qualify(name, defaultSchema);
		const table = target?.qualifiedName ?? `${qualified.schema}.${qualified.table}`;
		const resolvedColumns = columns ?? (target ? [String(target.table.primaryKey)] : void 0);
		if (!resolvedColumns) throw new Error(`defineLilypadDb: ${owner} references "${name}", which is not a table of the config: give the referenced columns.`);
		return {
			table,
			columns: resolvedColumns
		};
	};
	const tables = {};
	for (const { key, table, schema, tableName, qualifiedName } of located) {
		const { sync, strict, unique, foreignKeys, indexes, checks, schemaName: _schemaName, tableName: _tableName, ...rest } = table;
		const owner = `the table "${key}"`;
		const resolvedUnique = [...Object.entries(table.cols).filter(([, column]) => column.unique).map(([name]) => ({ columns: [name] })), ...(unique ?? []).map((uniqueKey) => ({
			name: uniqueKey.name,
			columns: [...uniqueKey.columns]
		}))];
		const resolvedForeignKeys = [...Object.entries(table.cols).flatMap(([name, column]) => {
			const reference = column.references;
			if (!reference) return [];
			return [{
				columns: [name],
				references: referenced(reference.table, `${owner} (column "${name}")`, reference.column === void 0 ? void 0 : [reference.column]),
				onDelete: reference.onDelete ?? "no action",
				onUpdate: reference.onUpdate ?? "no action"
			}];
		}), ...(foreignKeys ?? []).map((foreignKey) => ({
			name: foreignKey.name,
			columns: [...foreignKey.columns],
			references: referenced(foreignKey.references.table, owner, foreignKey.references.columns && [...foreignKey.references.columns]),
			onDelete: foreignKey.references.onDelete ?? "no action",
			onUpdate: foreignKey.references.onUpdate ?? "no action"
		}))];
		for (const foreignKey of resolvedForeignKeys) if (foreignKey.references.columns.length !== foreignKey.columns.length) throw new Error(`defineLilypadDb: a foreign key of ${owner} has ${foreignKey.columns.length} columns, but references ${foreignKey.references.columns.length}.`);
		tables[key] = Object.freeze({
			...rest,
			[LILYPAD_DB_TABLE]: true,
			key,
			tableName,
			schemaName: schema,
			qualifiedName,
			cols: resolveColumns(table.cols),
			sync: Object.freeze({ ...sync ?? { strategy: "listen" } }),
			strict: strict ?? input.strict ?? false,
			unique: resolvedUnique,
			foreignKeys: resolvedForeignKeys,
			indexes: (indexes ?? []).map((index) => ({
				name: index.name,
				columns: [...index.columns],
				unique: index.unique ?? false,
				using: index.using ?? "btree"
			})),
			checks: [...checks ?? []],
			db: settings
		});
	}
	return Object.freeze({
		[LILYPAD_DB_CONFIG]: true,
		name: settings.name,
		defaultSchema,
		notifyChannel: settings.notifyChannel,
		changelog: Object.freeze({
			table: settings.changelogTable,
			pruning: input.changelog?.pruning ?? "detect",
			minRetention: input.changelog?.minRetention ?? 36e5
		}),
		strict: input.strict ?? false,
		tables: Object.freeze(tables)
	});
}
//#endregion
//#region src/dbGate/LilypadDbSchema.ts
/** Thrown by the writes when the data has no primary key where one is needed. */
var LilypadDbMissingPrimaryKeyError = class extends Error {
	constructor(schema, context) {
		super(`Primary key "${String(schema.primaryKey)}" is missing in the ${context} data for table "${schema.tableName}".`);
		this.name = "LilypadDbMissingPrimaryKeyError";
		this.tableName = schema.tableName;
		this.primaryKey = String(schema.primaryKey);
	}
};
/** Thrown by an insert or an update whose data has no column of the schema to write. */
var LilypadDbEmptyWriteError = class extends Error {
	constructor(tableName, operation) {
		super(`No columns to ${operation} for table "${tableName}".`);
		this.name = "LilypadDbEmptyWriteError";
		this.tableName = tableName;
	}
};
/** Thrown by `updateToTable` when no row has the primary key of the data. */
var LilypadDbNotFoundError = class extends Error {
	constructor(tableName, primaryKeyValue) {
		super(`No row with primary key "${String(primaryKeyValue)}" found in table "${tableName}".`);
		this.name = "LilypadDbNotFoundError";
		this.tableName = tableName;
		this.primaryKeyValue = primaryKeyValue;
	}
};
//#endregion
export { LILYPAD_DEFAULT_NOTIFY_CHANNEL as _, defineLilypadTable as a, resolveLilypadDbTable as c, lilypadColumnTypeMismatch as d, lilypadColumnTypesOfPgType as f, LILYPAD_DEFAULT_MAX_GAP as g, LILYPAD_DEFAULT_DB_CONFIG_NAME as h, defineLilypadDb as i, isLilypadIntegerPgType as l, LILYPAD_DEFAULT_CHANGELOG_TABLE as m, LilypadDbMissingPrimaryKeyError as n, isLilypadDbConfig as o, normalizeLilypadPgType as p, LilypadDbNotFoundError as r, isLilypadDbTableDefinition as s, LilypadDbEmptyWriteError as t, isLilypadSerialPgType as u };

//# sourceMappingURL=LilypadDbSchema-DgMfYKbD.mjs.map