import { n as libLog, t as LilypadCacheCore } from "./chunks/LilypadCacheCore-CwziKox7.mjs";
import { n as runInBackground } from "./chunks/LilypadPlatform-Cdm5WJuh.mjs";
import { i as assertNumberOption } from "./chunks/LilypadFlowControl-bLx7gUhG.mjs";
import { n as createLilypadSingletonAbleAsync } from "./chunks/LilypadSingleton-w0oZfBDG.mjs";
import { createHash } from "node:crypto";
import postgres from "postgres";
//#region src/dbGate/LilypadListenHeartbeat.ts
/**
* Tells whether the `LISTEN` connection still delivers notifications.
*
* postgres.js re-establishes a lost `LISTEN` connection by itself, but it gives no signal while the
* connection is down: until it is back, notifications are lost silently. The heartbeat sends a
* notification to itself every `interval` (through the main pool), and counts the connection as
* unhealthy when none has come back for {@link UNHEALTHY_AFTER_INTERVALS} intervals.
*/
var LilypadListenHeartbeat = class LilypadListenHeartbeat {
	static {
		this.UNHEALTHY_AFTER_INTERVALS = 2.5;
	}
	/**
	* @param interval - Time between two heartbeats, in ms.
	* @param send - Sends one heartbeat notification.
	* @param onError - Receives the errors of `send` (a missed beat is enough of a consequence).
	*/
	constructor(interval, send, onError) {
		this.interval = interval;
		this.send = send;
		this.onError = onError;
	}
	/** Starts sending heartbeats; the connection counts as healthy from now. */
	start(now = Date.now()) {
		if (this.timer) return;
		this.lastBeat = now;
		this.timer = setInterval(() => {
			this.send().catch(this.onError);
		}, this.interval);
		this.timer.unref?.();
	}
	/** Records a heartbeat received on the `LISTEN` connection. */
	beat(now = Date.now()) {
		if (this.timer) this.lastBeat = now;
	}
	stop() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = void 0;
		}
		this.lastBeat = void 0;
	}
	get running() {
		return this.timer !== void 0;
	}
	/** Whether a heartbeat came back recently. `false` when stopped. */
	healthy(now = Date.now()) {
		return this.lastBeat !== void 0 && now - this.lastBeat <= this.interval * LilypadListenHeartbeat.UNHEALTHY_AFTER_INTERVALS;
	}
};
//#endregion
//#region src/internal/LilypadBackoff.ts
/** The longest wait before a retry, unless the base delay itself is longer. */
const MAX_RETRY_DELAY = 6e4;
/**
* Tracks the failures of a repeated operation (a `LISTEN`, a read of the changelog, a schema
* check), so that it is retried after an exponential backoff instead of at every call.
*/
var LilypadBackoff = class {
	/** @param baseDelay - The wait after the first failure, in ms; it doubles at each failure. */
	constructor(baseDelay) {
		this.baseDelay = baseDelay;
		this.failures = 0;
		this.retryAt = 0;
	}
	/** Whether the operation may run now: no failure, or the backoff is over. */
	ready(now = Date.now()) {
		return now >= this.retryAt;
	}
	/** Records a failure: the next attempt waits `base * 2^(failures - 1)`, up to one minute. */
	fail(now = Date.now()) {
		this.failures++;
		const base = this.baseDelay();
		const delay = Math.max(base, Math.min(base * 2 ** (this.failures - 1), MAX_RETRY_DELAY));
		this.retryAt = now + delay;
	}
	/** Records a success: the next failure starts again from the base delay. */
	succeed() {
		this.failures = 0;
		this.retryAt = 0;
	}
};
//#endregion
//#region src/dbGate/LilypadDbGate.ts
/**
* Pool settings for serverless platforms (e.g. Vercel Functions), where many short-lived instances
* each open their own pool:
* - few connections per instance, so that many instances do not exhaust the database;
* - idle connections closed quickly, so that a suspended instance does not keep them open.
*
* Use it with a pooled connection string (e.g. PgBouncer in transaction mode). Adjust `max` to the
* number of queries a single instance runs in parallel.
*/
const lilypadServerlessPool = Object.freeze({
	max: 3,
	idleTimeout: 5e3,
	connectTimeout: 1e4
});
/** postgres.js takes durations in seconds. */
function toPostgresPoolOptions(pool) {
	const seconds = (ms) => ms === void 0 ? void 0 : ms / 1e3;
	return Object.fromEntries(Object.entries({
		max: pool?.max,
		idle_timeout: seconds(pool?.idleTimeout),
		connect_timeout: seconds(pool?.connectTimeout),
		max_lifetime: seconds(pool?.maxLifetime)
	}).filter(([, value]) => value !== void 0));
}
/** Thrown by `updateToTable` when no row has the primary key of the data. */
var LilypadDbNotFoundError = class extends Error {
	constructor(tableName, primaryKeyValue) {
		super(`No row with primary key "${String(primaryKeyValue)}" found in table "${tableName}".`);
		this.name = "LilypadDbNotFoundError";
		this.tableName = tableName;
		this.primaryKeyValue = primaryKeyValue;
	}
};
/** Rows read at a time by `selectAllFromTable`. */
const SELECT_ALL_BATCH_SIZE = 1e3;
/** Primary keys per query of `selectFromTableByPrimaryKeys`. */
const PRIMARY_KEYS_BATCH_SIZE = 1e3;
const DEFAULT_STATEMENT_TIMEOUT = 3e4;
/** How long `close` waits for the queries still running, in ms, by default. */
const DEFAULT_CLOSE_TIMEOUT = 5e3;
/** The column that carries the transaction id in the results of writes. */
const XID_COLUMN = "__lilypad_xid";
const DEFAULT_LISTEN_HEARTBEAT = 15e3;
function lilypadMissingPrimaryKeyError(schema, context) {
	return /* @__PURE__ */ new Error(`Primary key "${String(schema.primaryKey)}" is missing in the ${context} data for table "${schema.tableName}".`);
}
/**
* A gateway to a PostgreSQL database: typed CRUD helpers over a {@link LilypadDbSchema}, and
* channel listeners (`LISTEN/NOTIFY`) with reconnection handling.
*
* @example
* ```typescript
* const gate = await LilypadDbGate.create({
*   connectionString: 'postgres://user:pass@host:port/db',
*   listen: [
*     { channel: 'my_channel', callbackId: 'my_callback', callback: (payload) => console.log(payload) }
*   ]
* });
* ```
*/
var LilypadDbGate = class LilypadDbGate {
	constructor(options) {
		this.id = `LilypadDbGate-${globalThis.crypto.randomUUID()}`;
		this.listeners = /* @__PURE__ */ new Map();
		this.releaseSingleton = () => {};
		this.heartbeatChannel = `lilypad_heartbeat_${this.id.slice(-36).replace(/-/g, "")}`;
		this.heartbeatBackoff = new LilypadBackoff(() => 1e3);
		if (options.statementTimeout !== false) assertNumberOption("LilypadDbGate", "statementTimeout", options.statementTimeout, "positive");
		if (options.listenHeartbeat !== false) assertNumberOption("LilypadDbGate", "listenHeartbeat", options.listenHeartbeat, "positive");
		this.logger = options.logger;
		const statementTimeout = resolveStatementTimeout(options);
		this.sql = postgres(options.connectionString, {
			prepare: false,
			...toPostgresPoolOptions(options.pool),
			...statementTimeout !== void 0 && { connection: { statement_timeout: statementTimeout } }
		});
		const listenerConnectionString = options.listenerConnectionString;
		if (listenerConnectionString && listenerConnectionString !== options.connectionString) this.listenerClient = postgres(listenerConnectionString);
		if (options.listenHeartbeat !== false) this.heartbeat = new LilypadListenHeartbeat(options.listenHeartbeat ?? DEFAULT_LISTEN_HEARTBEAT, () => this.sql`SELECT pg_notify(${this.heartbeatChannel}, '')`, (error) => libLog(this.logger, "debug", this.id, "LISTEN heartbeat failed:", error));
	}
	/**
	* Creates a gate and registers the listeners of `options.listen`.
	* Without listeners it opens no connection: the pool connects on the first query, so creating a
	* gate at module level does not reach the database (e.g. during a build).
	* With `singleton: true`, a later call with the same identifier returns the existing gate and
	* ignores its own options (a warning is logged if they differ).
	*/
	static async create(options) {
		return createLilypadSingletonAbleAsync("LilypadDbGate", options, async (release) => {
			const instance = await LilypadDbGate.initializeNew(options);
			instance.releaseSingleton = release;
			return instance;
		}, {
			value: createHash("sha256").update(JSON.stringify([
				options.connectionString,
				options.listenerConnectionString,
				resolveStatementTimeout(options),
				options.pool,
				options.listenHeartbeat
			])).digest("hex"),
			onMismatch: () => libLog(options.logger, "warn", "LilypadDbGate", `Singleton "${options.singleton ? options.singletonIdentifier : ""}" already exists with different connection options: the new options are ignored.`)
		});
	}
	static async initializeNew(options) {
		const instance = new LilypadDbGate(options);
		try {
			for (const listenOption of options.listen ?? []) await instance.addListener(listenOption);
		} catch (error) {
			await instance.close();
			throw error;
		}
		return instance;
	}
	/**
	* Maps a database row to `T`, using the schema's `selectSanitizationFn` if provided,
	* otherwise by copying the schema columns.
	*/
	mapRow(schema, row) {
		if (schema.selectSanitizationFn) return schema.selectSanitizationFn(row);
		const typedRow = {};
		for (const key in schema.cols) typedRow[key] = row[key];
		return typedRow;
	}
	/**
	* The columns to select. The `selectSanitizationFn` receives the whole row, since it may read
	* columns that are not in the schema; otherwise only the schema columns are needed.
	*/
	selectedColumns(schema) {
		return schema.selectSanitizationFn ? this.sql`*` : this.sql(Object.keys(schema.cols));
	}
	/**
	* Prepares the data of an insert/update:
	* - applies the schema's `writeSanitizationFn`, whose result replaces the data;
	* - validates the primary key, which an update always needs to find the row;
	* - restricts the written columns to the schema columns, so that extra properties of `data`
	*   (e.g. coming from a request body) are never written to the table;
	* - skips `undefined` values, which postgres.js rejects.
	*/
	prepareWrite(schema, data, operation) {
		const writeData = schema.writeSanitizationFn ? { ...schema.writeSanitizationFn({ ...data }) } : { ...data };
		const primaryKeyValue = writeData[schema.primaryKey];
		if ((operation === "update" || !schema.generatedPrimaryKey) && (primaryKeyValue === void 0 || primaryKeyValue === null)) throw lilypadMissingPrimaryKeyError(schema, operation);
		if (schema.generatedPrimaryKey) delete writeData[schema.primaryKey];
		const columns = Object.keys(schema.cols).filter((column) => writeData[column] !== void 0);
		if (columns.length === 0) throw new Error(`No columns to ${operation} for table "${schema.tableName}".`);
		return {
			data: writeData,
			columns,
			primaryKeyValue
		};
	}
	/**
	* Selects every row of the table. Rows are read in batches through a cursor, so the raw result
	* of the whole table is never held in memory at once.
	*
	* @param options.signal - Stops reading (and closes the cursor) once aborted: the promise then
	* rejects with the reason of the signal.
	*/
	async selectAllFromTable(schema, options = {}) {
		this.assertOpen();
		const { signal } = options;
		signal?.throwIfAborted();
		const typedResults = [];
		const cursor = this.sql`
      SELECT ${this.selectedColumns(schema)} FROM ${this.sql(schema.tableName)}
    `.cursor(SELECT_ALL_BATCH_SIZE);
		for await (const rows of cursor) {
			signal?.throwIfAborted();
			for (const row of rows) {
				const typedRow = this.mapRow(schema, row);
				if (typedRow !== null) typedResults.push(typedRow);
			}
		}
		return typedResults;
	}
	/**
	* Selects the rows with these primary keys, in one query per batch of 1000 keys (Postgres limits
	* the parameters of a query). Keys without a row are left out of the result, as are the rows the
	* `selectSanitizationFn` discards.
	*/
	async selectFromTableByPrimaryKeys(schema, primaryKeyValues) {
		this.assertOpen();
		const typedRows = [];
		for (let start = 0; start < primaryKeyValues.length; start += PRIMARY_KEYS_BATCH_SIZE) {
			const batch = primaryKeyValues.slice(start, start + PRIMARY_KEYS_BATCH_SIZE);
			const results = await this.sql`
        SELECT ${this.selectedColumns(schema)} FROM ${this.sql(schema.tableName)}
        WHERE ${this.sql(String(schema.primaryKey))} IN ${this.sql(batch)}
      `;
			for (const row of results) {
				const typedRow = this.mapRow(schema, row);
				if (typedRow !== null) typedRows.push(typedRow);
			}
		}
		return typedRows;
	}
	async selectFromTableByPrimaryKey(schema, primaryKeyValue) {
		this.assertOpen();
		const [row] = await this.sql`
      SELECT ${this.selectedColumns(schema)} FROM ${this.sql(schema.tableName)}
      WHERE ${this.sql(String(schema.primaryKey))} = ${primaryKeyValue}
    `;
		return row ? this.mapRow(schema, row) : null;
	}
	/**
	* Inserts a row.
	*
	* @returns The row as stored by the database, including generated columns such as an
	* auto-determined primary key (`null` if the `selectSanitizationFn` discards it), and the id of
	* the transaction that wrote it.
	*/
	async insertToTable(schema, data) {
		this.assertOpen();
		const { data: insertData, columns } = this.prepareWrite(schema, data, "insert");
		const results = await this.sql`
      INSERT INTO ${this.sql(schema.tableName)} ${this.sql(insertData, columns)}
      RETURNING ${this.selectedColumns(schema)}, pg_current_xact_id()::text AS ${this.sql(XID_COLUMN)}
    `;
		return this.writeResult(schema, results);
	}
	/** Splits a row returned by a write into the row and the id of its transaction. */
	writeResult(schema, results) {
		const [returned] = results;
		if (!returned) throw new Error(`The write to table "${schema.tableName}" returned no row.`);
		const { [XID_COLUMN]: xid, ...row } = returned;
		return {
			row: this.mapRow(schema, row),
			xid: BigInt(xid)
		};
	}
	/**
	* Updates the row identified by the primary key contained in `data`. Only the columns present
	* in `data` are written.
	*
	* @returns The row as stored by the database (`null` if the `selectSanitizationFn` discards it),
	* and the id of the transaction that wrote it.
	* @throws {LilypadDbNotFoundError} If no row with that primary key exists.
	*/
	async updateToTable(schema, data) {
		this.assertOpen();
		const { data: updateData, columns, primaryKeyValue } = this.prepareWrite(schema, data, "update");
		const results = await this.sql`
      UPDATE ${this.sql(schema.tableName)}
      SET ${this.sql(updateData, columns)}
      WHERE ${this.sql(String(schema.primaryKey))} = ${primaryKeyValue}
      RETURNING ${this.selectedColumns(schema)}, pg_current_xact_id()::text AS ${this.sql(XID_COLUMN)}
    `;
		if (results.count === 0) throw new LilypadDbNotFoundError(schema.tableName, primaryKeyValue);
		return this.writeResult(schema, results);
	}
	/**
	* Deletes the row with this primary key.
	*
	* @returns Whether a row had this primary key, and the id of the transaction that deleted it.
	*/
	async deleteFromTable(schema, primaryKeyValue) {
		this.assertOpen();
		const [deleted] = await this.sql`
      DELETE FROM ${this.sql(schema.tableName)}
      WHERE ${this.sql(String(schema.primaryKey))} = ${primaryKeyValue}
      RETURNING pg_current_xact_id()::text AS ${this.sql(XID_COLUMN)}
    `;
		return deleted ? {
			deleted: true,
			xid: BigInt(deleted[XID_COLUMN])
		} : { deleted: false };
	}
	/** The client that listens: postgres.js keeps one dedicated connection per client for LISTEN. */
	listenClient() {
		return this.listenerClient ?? this.sql;
	}
	/**
	* Starts listening on the specified channel.
	*
	* The listener entry is registered immediately, before LISTEN is active, so that concurrent
	* `addListener` calls for the same channel share it and await the same `ready` promise.
	* If LISTEN fails, the entry is removed, so that a later `addListener` call retries it.
	*/
	initializeListener(channel) {
		libLog(this.logger, "debug", this.id, `Initializing listener for channel "${channel}".`);
		const listener = {
			callbacks: /* @__PURE__ */ new Map(),
			listening: false,
			ready: this.listenClient().listen(channel, (payload) => this.executeAllListenerCallbacks(channel, payload), () => {
				if (listener.listening) this.executeReconnectCallbacks(channel, listener);
				listener.listening = true;
			}).then((meta) => () => meta.unlisten()).catch((error) => {
				if (this.listeners.get(channel) === listener) this.listeners.delete(channel);
				throw error;
			})
		};
		this.listeners.set(channel, listener);
		return listener;
	}
	/**
	* Runs a listener callback, catching both synchronous throws and rejected promises,
	* so a failing callback can neither affect the others nor cause an unhandled rejection.
	*/
	runCallbackSafely(channel, callbackId, callback) {
		Promise.resolve().then(callback).catch((error) => {
			libLog(this.logger, "error", this.id, `Error in listener callback "${callbackId}" for channel "${channel}":`, error);
		});
	}
	/** Runs every callback of a channel with the payload of a notification. */
	executeAllListenerCallbacks(channel, payload) {
		const listener = this.listeners.get(channel);
		if (!listener) return;
		for (const [callbackId, { callback }] of listener.callbacks) this.runCallbackSafely(channel, callbackId, () => callback(payload));
	}
	executeReconnectCallbacks(channel, listener) {
		libLog(this.logger, "warn", this.id, `LISTEN on channel "${channel}" was re-established: notifications sent meanwhile are lost.`);
		for (const [callbackId, identifier] of listener.callbacks) if (identifier.onReconnect) this.runCallbackSafely(channel, callbackId, () => identifier.onReconnect?.());
	}
	/**
	* Adds a listener callback for a channel. Adding a callback with an existing `callbackId` on the
	* same channel replaces the previous one.
	*
	* @returns A promise that resolves once LISTEN is active on the channel.
	* @throws If LISTEN fails; in that case the callback is not registered.
	*/
	async addListener(identifier) {
		this.assertOpen();
		const { channel, callbackId } = identifier;
		libLog(this.logger, "debug", this.id, `Adding listener for channel "${channel}" with callback ID "${callbackId}".`);
		const listener = this.listeners.get(channel) ?? this.initializeListener(channel);
		listener.callbacks.set(callbackId, identifier);
		await listener.ready;
		if (this.listeners.get(channel) === listener) await this.startHeartbeat();
		libLog(this.logger, "debug", this.id, `Listener for channel "${channel}" has ${listener.callbacks.size} callbacks.`);
	}
	/**
	* Removes a listener callback. When the channel has no callbacks left, it stops listening to it.
	* It never rejects: a failed UNLISTEN is logged (the connection keeps the channel, whose
	* notifications are then ignored).
	*
	* @returns `true` if the callback was registered.
	*/
	async removeListener(channel, callbackId) {
		const listener = this.listeners.get(channel);
		if (!listener || !listener.callbacks.delete(callbackId)) return false;
		if (listener.callbacks.size === 0) {
			this.listeners.delete(channel);
			if (this.listeners.size === 0) await this.stopHeartbeat();
			try {
				await (await listener.ready)();
			} catch (error) {
				libLog(this.logger, "warn", this.id, `Could not stop listening on "${channel}":`, error);
			}
		}
		return true;
	}
	/** Starts the heartbeat, unless it is running or starting. It never rejects. */
	async startHeartbeat() {
		const heartbeat = this.heartbeat;
		if (!heartbeat || this.heartbeatStop || this.closing) return;
		const starting = this.listenClient().listen(this.heartbeatChannel, () => heartbeat.beat()).then((meta) => {
			if (this.heartbeatStop === starting) heartbeat.start();
			return () => meta.unlisten();
		});
		this.heartbeatStop = starting;
		try {
			await starting;
			this.heartbeatBackoff.succeed();
		} catch (error) {
			if (this.heartbeatStop === starting) this.heartbeatStop = void 0;
			this.heartbeatBackoff.fail();
			libLog(this.logger, "warn", this.id, "Could not start the LISTEN heartbeat:", error);
		}
	}
	async stopHeartbeat() {
		const stop = this.heartbeatStop;
		this.heartbeatStop = void 0;
		this.heartbeat?.stop();
		try {
			await (await stop)?.();
		} catch {}
	}
	/**
	* Whether the `LISTEN` connection is known to deliver notifications: a heartbeat came back
	* recently. Without heartbeat (`listenHeartbeat: false`), `true` as soon as a channel is
	* listened to. `false` while no channel is listened to.
	*/
	isListenHealthy() {
		if (!this.heartbeat) return this.listeners.size > 0;
		if (!this.heartbeatStop && this.listeners.size > 0 && this.heartbeatBackoff.ready()) this.startHeartbeat();
		return this.heartbeat.healthy();
	}
	/** Whether `close` was called: the gate then rejects every query and listener. */
	get closed() {
		return this.closing !== void 0;
	}
	assertOpen() {
		if (this.closing) throw new Error(`LilypadDbGate "${this.id}" is closed.`);
	}
	/**
	* Closes the connections, after the queries still running (for at most `timeout` ms; the ones
	* still running then are cancelled). Later queries and listeners are rejected. Calling it again
	* returns the same promise.
	*
	* @param options.timeout - How long to wait for the running queries, in ms. Defaults to 5 s.
	*/
	close(options = {}) {
		this.closing ??= this.closeConnections(options.timeout ?? DEFAULT_CLOSE_TIMEOUT);
		return this.closing;
	}
	async closeConnections(timeout) {
		assertNumberOption("LilypadDbGate", "close timeout", timeout, "non-negative");
		this.listeners.clear();
		this.heartbeat?.stop();
		this.heartbeatStop = void 0;
		this.releaseSingleton();
		await Promise.all([this.listenerClient?.end({ timeout: timeout / 1e3 }), this.sql.end({ timeout: timeout / 1e3 })]);
	}
};
function resolveStatementTimeout(options) {
	return options.statementTimeout === false ? void 0 : options.statementTimeout ?? DEFAULT_STATEMENT_TIMEOUT;
}
//#endregion
//#region src/dbGate/LilypadChangelog.ts
/**
* The changelog records every change of the cached tables in a table, so that each instance can
* read the changes made since its last check with one query. It needs no long-lived connection
* (unlike `LISTEN/NOTIFY`), so it suits serverless platforms, and it also catches the changes made
* by other programs. It needs PostgreSQL 13 or later (`xid8`).
*/
const LILYPAD_DEFAULT_CHANGELOG_TABLE = "lilypad_cache_changes";
const LILYPAD_DEFAULT_NOTIFY_CHANNEL = "cache_events";
const LILYPAD_CHANGELOG_VERSION_PREFIX = "lilypad-changelog:";
/** The transition tables of the statement triggers (version 4): the rows before and after. */
const LILYPAD_CHANGELOG_OLD_ROWS = "lilypad_old";
const LILYPAD_CHANGELOG_NEW_ROWS = "lilypad_new";
/** Replaces the characters that are not allowed in the names derived from a table name. */
function identifierPrefix(name) {
	return name.replace(/\W/g, "_");
}
/** Quotes an identifier; `schema.table` is quoted part by part. */
function quoteIdentifier(identifier) {
	return identifier.split(".").map((part) => `"${part.replace(/"/g, "\"\"")}"`).join(".");
}
function quoteLiteral(value) {
	return `'${value.replace(/'/g, "''")}'`;
}
/** The trigger function name for a changelog table. */
function triggerFunctionName(changelogTable) {
	return `${identifierPrefix(changelogTable)}_record`;
}
/** The name of the function that deletes the old rows of a changelog table (`prune` option). */
function pruneFunctionName(changelogTable) {
	return `${identifierPrefix(changelogTable)}_prune`;
}
/**
* The names of the triggers that record the changes of a table: one statement trigger per event,
* and the row trigger that versions 3 and earlier installed instead of the first three.
*/
function changelogTriggerNames(table) {
	const prefix = identifierPrefix(table);
	return {
		insert: `${prefix}_lilypad_insert`,
		update: `${prefix}_lilypad_update`,
		delete: `${prefix}_lilypad_delete`,
		truncate: `${prefix}_lilypad_truncate`,
		legacyRow: `${prefix}_lilypad_changes`
	};
}
/** Escapes a string placed in the format string of the SQL `format()` function. */
function escapeFormat(value) {
	return value.replace(/%/g, "%%");
}
/** The comment of the trigger function that records its prune options (read back by the schema check). */
const PRUNE_MARKER = "lilypad-prune:";
function resolvePruneOptions(owner, prune) {
	if (!prune) return;
	assertNumberOption(owner, "prune.olderThan", prune.olderThan, "positive");
	assertNumberOption(owner, "prune.every", prune.every, "positive-integer");
	assertNumberOption(owner, "prune.batchSize", prune.batchSize, "positive-integer");
	return {
		olderThan: prune.olderThan,
		every: prune.every ?? 20,
		batchSize: prune.batchSize ?? 1e3
	};
}
/**
* The `prune` options of an installed trigger function, from its source, or `false` if it does not
* prune: the SQL that fixes an outdated changelog keeps them.
*/
function installedLilypadChangelogPrune(source) {
	const match = source ? new RegExp(`${PRUNE_MARKER} olderThan=(\\S+) every=(\\d+) batchSize=(\\d+)`).exec(source) : null;
	if (!match) return false;
	const prune = {
		olderThan: Number(match[1]),
		every: Number(match[2]),
		batchSize: Number(match[3])
	};
	return Number.isFinite(prune.olderThan) && prune.olderThan > 0 && prune.every > 0 && prune.batchSize > 0 ? prune : false;
}
/** The SQL condition on `changed_at` of the rows older than `olderThan` milliseconds. */
function olderThanCondition(olderThan) {
	return `changed_at < clock_timestamp() - make_interval(secs => ${olderThan / 1e3})`;
}
/**
* The SQL that creates the changelog table and its trigger function. Run it once, in a migration.
* It is idempotent (`IF NOT EXISTS` / `CREATE OR REPLACE`).
*
* Then attach the trigger to every cached table with {@link lilypadChangelogTriggerSql}.
*/
function lilypadChangelogSql(options = {}) {
	const table = options.table ?? "lilypad_cache_changes";
	const channel = options.notifyChannel ?? "cache_events";
	const prune = resolvePruneOptions("lilypadChangelogSql", options.prune);
	const quotedTable = quoteIdentifier(table);
	const indexPrefix = identifierPrefix(table);
	const pruneFunction = quoteIdentifier(pruneFunctionName(table));
	const pruneCall = (indent) => prune ? `
${indent}IF random() * ${prune.every} < 1 AND current_setting('transaction_isolation') = 'read committed' THEN
${indent}  PERFORM ${pruneFunction}();
${indent}END IF;` : "";
	const notify = (idExpression, opExpression) => channel === false ? "" : `
    PERFORM pg_notify(${quoteLiteral(channel)}, json_build_object(
      'schema', TG_TABLE_SCHEMA, 'table', TG_TABLE_NAME, 'id', ${idExpression}, 'op', ${opExpression},
      'xid', pg_current_xact_id()::text
    )::text);`;
	const functionName = quoteIdentifier(triggerFunctionName(table));
	const oldRows = LILYPAD_CHANGELOG_OLD_ROWS;
	const newRows = LILYPAD_CHANGELOG_NEW_ROWS;
	const recordChanged = channel === false ? `INSERT INTO ${escapeFormat(quotedTable)} (table_schema, table_name, row_id, op)
      SELECT $1, $2, changed.row_id, changed.op FROM (%s) AS changed` : `WITH recorded AS (
        INSERT INTO ${escapeFormat(quotedTable)} (table_schema, table_name, row_id, op)
        SELECT $1, $2, changed.row_id, changed.op FROM (%s) AS changed
        RETURNING row_id, op
      )
      SELECT pg_notify(${escapeFormat(quoteLiteral(channel))}, json_build_object(
        'schema', $1, 'table', $2, 'id', row_id, 'op', op, 'xid', pg_current_xact_id()::text
      )::text) FROM recorded`;
	return `CREATE TABLE IF NOT EXISTS ${quotedTable} (
  id           bigserial   PRIMARY KEY,
  xid          xid8        NOT NULL DEFAULT pg_current_xact_id(),
  table_schema text,
  table_name   text        NOT NULL,
  row_id       text,
  op           text        NOT NULL,
  changed_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Version 1 had no schema column: tables of the same name in different schemas were mixed up
ALTER TABLE ${quotedTable} ADD COLUMN IF NOT EXISTS table_schema text;
-- Version 3 records TRUNCATE, which concerns no single row
ALTER TABLE ${quotedTable} ALTER COLUMN row_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${indexPrefix}_table_xid_idx`)}
  ON ${quotedTable} (table_name, xid);
CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${indexPrefix}_changed_at_idx`)}
  ON ${quotedTable} (changed_at);
${prune ? `
-- Deletes up to ${prune.batchSize} changelog rows older than the retention, for the trigger function.
-- SECURITY DEFINER, so that the writing roles need no DELETE privilege on the changelog, with the
-- search_path of this migration, where the changelog table is. SKIP LOCKED: concurrent prunes
-- delete different rows and never wait for each other.
CREATE OR REPLACE FUNCTION ${pruneFunction}() RETURNS void AS $$
  DELETE FROM ${quotedTable} WHERE id IN (
    SELECT id FROM ${quotedTable}
    WHERE ${olderThanCondition(prune.olderThan)}
    ORDER BY changed_at
    LIMIT ${prune.batchSize}
    FOR UPDATE SKIP LOCKED
  );
$$ LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT;
` : ""}
-- Records the changes of the rows of a statement, or a TRUNCATE of the table; the trigger argument
-- is the primary key column.
CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger AS $$
DECLARE
  new_id text;
  old_id text;
  changed text;
BEGIN${prune ? `
  -- ${PRUNE_MARKER} olderThan=${prune.olderThan} every=${prune.every} batchSize=${prune.batchSize}` : ""}
  IF TG_OP = 'TRUNCATE' THEN
    INSERT INTO ${quotedTable} (table_schema, table_name, row_id, op)
      VALUES (TG_TABLE_SCHEMA, TG_TABLE_NAME, NULL, 'TRUNCATE');${notify("NULL", `'TRUNCATE'`)}${pruneCall("    ")}
    RETURN NULL;
  END IF;

  IF TG_LEVEL = 'STATEMENT' THEN
    -- Statement triggers (version 4): every row of the statement in one query, from the transition
    -- tables. Only the primary key column is read, instead of converting whole rows to JSON.
    changed := CASE TG_OP
      WHEN 'INSERT' THEN format(
        'SELECT to_jsonb(n.%1$I) #>> ''{}'' AS row_id, ''INSERT'' AS op FROM ${newRows} n',
        TG_ARGV[0])
      WHEN 'DELETE' THEN format(
        'SELECT to_jsonb(o.%1$I) #>> ''{}'' AS row_id, ''DELETE'' AS op FROM ${oldRows} o',
        TG_ARGV[0])
      -- An update that changes primary keys also deletes the old keys that no row has any more
      ELSE format(
        'SELECT to_jsonb(o.%1$I) #>> ''{}'' AS row_id, ''DELETE'' AS op FROM ${oldRows} o '
        || 'WHERE NOT EXISTS (SELECT 1 FROM ${newRows} n WHERE n.%1$I = o.%1$I) '
        || 'UNION ALL SELECT to_jsonb(n.%1$I) #>> ''{}'', ''UPDATE'' FROM ${newRows} n',
        TG_ARGV[0])
    END;
    EXECUTE format($record$
      ${recordChanged}
    $record$, changed) USING TG_TABLE_SCHEMA, TG_TABLE_NAME;${pruneCall("    ")}
    RETURN NULL;
  END IF;

  -- Row triggers, installed by version 3 and earlier: one change at a time
  IF TG_OP <> 'DELETE' THEN
    new_id := to_jsonb(NEW) ->> TG_ARGV[0];
  END IF;
  IF TG_OP <> 'INSERT' THEN
    old_id := to_jsonb(OLD) ->> TG_ARGV[0];
  END IF;

  -- An update that changes the primary key also deletes the old key
  IF TG_OP = 'UPDATE' AND old_id IS DISTINCT FROM new_id THEN
    INSERT INTO ${quotedTable} (table_schema, table_name, row_id, op)
      VALUES (TG_TABLE_SCHEMA, TG_TABLE_NAME, old_id, 'DELETE');${notify("old_id", `'DELETE'`)}
  END IF;

  INSERT INTO ${quotedTable} (table_schema, table_name, row_id, op)
    VALUES (TG_TABLE_SCHEMA, TG_TABLE_NAME, COALESCE(new_id, old_id), TG_OP);${notify("COALESCE(new_id, old_id)", "TG_OP")}${pruneCall("  ")}
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
COMMENT ON FUNCTION ${functionName}() IS ${quoteLiteral(`${LILYPAD_CHANGELOG_VERSION_PREFIX}4`)};
${prune ? "" : `DROP FUNCTION IF EXISTS ${pruneFunction}();\n`}`;
}
/**
* The SQL that schedules a pg_cron job deleting the changelog rows older than `olderThan`: the
* database then prunes its changelog itself. Run it once, in a migration, with pg_cron installed
* (`CREATE EXTENSION pg_cron`). Running it again updates the job.
*/
function lilypadChangelogPruneScheduleSql(options) {
	assertNumberOption("lilypadChangelogPruneScheduleSql", "olderThan", options.olderThan, "positive");
	const table = options.changelogTable ?? "lilypad_cache_changes";
	const jobName = quoteLiteral(options.jobName ?? pruneFunctionName(table));
	const schedule = quoteLiteral(options.schedule ?? "0 3 * * *");
	const condition = olderThanCondition(options.olderThan);
	if (options.database !== void 0) return `SELECT cron.schedule_in_database(${jobName}, ${schedule}, ${quoteLiteral(`DELETE FROM ${quoteIdentifier(table)} WHERE ${condition}`)}, ${quoteLiteral(options.database)});
`;
	return `SELECT cron.schedule(${jobName}, ${schedule}, format(
  'DELETE FROM %I.%I WHERE ${condition}',
  n.nspname, c.relname
))
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.oid = ${quoteLiteral(quoteIdentifier(table))}::regclass;
`;
}
/**
* The SQL that attaches the changelog triggers to a cached table: one statement trigger for each of
* INSERT, UPDATE and DELETE, which records all the rows of a statement in one query (through its
* transition tables), and one for `TRUNCATE`. It replaces the row trigger of the versions 3 and
* earlier. Run it once per table, in a migration (in one transaction, so that no write goes
* unrecorded), after {@link lilypadChangelogSql}.
*
* Transition tables are not supported on the partitions of a partitioned table, nor on tables with
* inheritance children: attach the triggers to the partitioned table itself.
*
* @param options.table - The cached table (as in its `LilypadDbSchema`).
* @param options.primaryKey - Its primary key column.
* @param options.changelogTable - The changelog table, if not the default one.
*/
function lilypadChangelogTriggerSql(options) {
	const changelogTable = options.changelogTable ?? "lilypad_cache_changes";
	const names = changelogTriggerNames(options.table);
	const table = quoteIdentifier(options.table);
	const execute = `EXECUTE FUNCTION ${quoteIdentifier(triggerFunctionName(changelogTable))}(${quoteLiteral(options.primaryKey)})`;
	const oldRows = LILYPAD_CHANGELOG_OLD_ROWS;
	const newRows = LILYPAD_CHANGELOG_NEW_ROWS;
	return `DROP TRIGGER IF EXISTS ${quoteIdentifier(names.legacyRow)} ON ${table};
DROP TRIGGER IF EXISTS ${quoteIdentifier(names.insert)} ON ${table};
CREATE TRIGGER ${quoteIdentifier(names.insert)}
  AFTER INSERT ON ${table} REFERENCING NEW TABLE AS ${newRows}
  FOR EACH STATEMENT ${execute};
DROP TRIGGER IF EXISTS ${quoteIdentifier(names.update)} ON ${table};
CREATE TRIGGER ${quoteIdentifier(names.update)}
  AFTER UPDATE ON ${table} REFERENCING OLD TABLE AS ${oldRows} NEW TABLE AS ${newRows}
  FOR EACH STATEMENT ${execute};
DROP TRIGGER IF EXISTS ${quoteIdentifier(names.delete)} ON ${table};
CREATE TRIGGER ${quoteIdentifier(names.delete)}
  AFTER DELETE ON ${table} REFERENCING OLD TABLE AS ${oldRows}
  FOR EACH STATEMENT ${execute};
DROP TRIGGER IF EXISTS ${quoteIdentifier(names.truncate)} ON ${table};
CREATE TRIGGER ${quoteIdentifier(names.truncate)}
  AFTER TRUNCATE ON ${table}
  FOR EACH STATEMENT ${execute};
`;
}
/**
* Whether the changes of the transaction `xid` were visible to the read that produced `cursor`:
* a later read from this cursor does not return them.
*/
function lilypadCursorCovers(cursor, xid) {
	return xid < cursor.xmax && !cursor.xip.includes(xid);
}
/**
* Reads the changes of a table since `cursor`, and the cursor for the next read.
*
* The cursor holds the transactions the read could not see yet (see
* {@link LilypadChangelogCursor}): the next read returns exactly the changes of those
* transactions that are visible to it, whatever the order of the commits. Each change is thus
* returned once, and a long-running transaction does not make every read return again all the
* changes made since it started.
*
* Without a cursor (first read, or a cursor no longer trusted), `since.lookback` returns the
* changes recorded in the last `lookback` milliseconds instead.
*
* `tableName` is resolved as the gate's queries resolve it (with the `search_path` when it is not
* qualified), so a table of the same name in another schema is not mixed up with it. Rows recorded
* by a version 1 trigger, which had no schema, match any schema.
*/
async function readLilypadChanges(gate, options) {
	const { changes, cursor } = await readLilypadChangesBatch(gate, {
		requests: [{
			tableName: options.tableName,
			since: options.since
		}],
		changelogTable: options.changelogTable
	});
	return {
		changes: changes[0] ?? [],
		cursor
	};
}
/**
* Like {@link readLilypadChanges}, for several tables in one query: `changes[i]` holds the changes
* of `requests[i]`. Every request shares the cursor for the next read.
*/
async function readLilypadChangesBatch(gate, options) {
	const sql = gate.sql;
	const changelogTable = sql(options.changelogTable ?? "lilypad_cache_changes");
	const tableRefs = options.requests.map((request) => quoteIdentifier(request.tableName));
	const cursors = options.requests.map((request) => "cursor" in request.since ? request.since.cursor : void 0);
	const xmaxes = cursors.map((cursor) => cursor?.xmax.toString() ?? "");
	const xips = cursors.map((cursor) => cursor?.xip.join(",") ?? "");
	const lookbacks = options.requests.map((request) => "lookback" in request.since ? String(request.since.lookback / 1e3) : "0");
	const rows = await sql`
    WITH snapshot AS (
      SELECT pg_snapshot_xmax(current.s)::text AS next_xmax,
        (SELECT coalesce(string_agg(x::text, ','), '') FROM pg_snapshot_xip(current.s) AS x) AS next_xip
      FROM (SELECT pg_current_snapshot() AS s) AS current
    ),
    requests AS (
      SELECT (r.ordinality - 1)::int AS request, r.table_ref,
        NULLIF(r.since_xmax, '')::xid8 AS since_xmax,
        string_to_array(NULLIF(r.since_xip, ''), ',')::xid8[] AS since_xip,
        r.lookback_secs::float8 AS lookback_secs
      FROM unnest(
        ${textArrayLiteral(tableRefs)}::text[], ${textArrayLiteral(xmaxes)}::text[],
        ${textArrayLiteral(xips)}::text[], ${textArrayLiteral(lookbacks)}::text[]
      ) WITH ORDINALITY AS r(table_ref, since_xmax, since_xip, lookback_secs, ordinality)
    ),
    targets AS (
      SELECT requests.*, n.nspname AS schema_name, t.relname AS rel_name
      FROM requests
      JOIN pg_class t ON t.oid = to_regclass(requests.table_ref)
      JOIN pg_namespace n ON n.oid = t.relnamespace
    )
    SELECT snapshot.next_xmax, snapshot.next_xip, targets.request,
      c.id::text AS id, c.xid::text AS xid, c.row_id, c.op
    FROM snapshot
    LEFT JOIN targets ON true
    LEFT JOIN LATERAL (
      SELECT c.id, c.xid, c.row_id, c.op FROM ${changelogTable} c
      WHERE targets.since_xmax IS NOT NULL
        AND c.table_name = targets.rel_name
        AND (c.table_schema = targets.schema_name OR c.table_schema IS NULL)
        AND (c.xid >= targets.since_xmax OR c.xid = ANY(targets.since_xip))
      UNION ALL
      SELECT c.id, c.xid, c.row_id, c.op FROM ${changelogTable} c
      WHERE targets.since_xmax IS NULL
        AND c.table_name = targets.rel_name
        AND (c.table_schema = targets.schema_name OR c.table_schema IS NULL)
        AND c.changed_at >= clock_timestamp() - make_interval(secs => targets.lookback_secs)
    ) c ON true
    ORDER BY c.id
  `;
	const changes = options.requests.map(() => []);
	for (const row of rows) if (row.id !== null && (row.row_id !== null || row.op === "TRUNCATE")) changes[row.request]?.push({
		id: row.id,
		xid: BigInt(row.xid),
		rowId: row.row_id,
		op: row.op
	});
	const nextXmax = rows[0]?.next_xmax;
	const nextXip = rows[0]?.next_xip;
	if (typeof nextXmax !== "string" || typeof nextXip !== "string") throw new Error("Reading the changelog returned no snapshot.");
	return {
		changes,
		cursor: {
			xmax: BigInt(nextXmax),
			xip: nextXip === "" ? [] : nextXip.split(",").map((xid) => BigInt(xid))
		}
	};
}
/**
* The Postgres literal of a `text[]`, passed as a string parameter. Not `sql.array()`: postgres.js
* registers the array types of a client once its first connection has fetched them, but builds
* the first query of that connection before, so an array sent by the first query of a process is
* serialized as `a,b` (malformed array literal), with or without an explicit type.
*/
function textArrayLiteral(values) {
	return `{${values.map((value) => `"${value.replace(/[\\"]/g, "\\$&")}"`).join(",")}}`;
}
/**
* Deletes the changelog rows older than `olderThan` milliseconds. Call it periodically (e.g. from
* a scheduled job): `olderThan` must be much larger than the `maxGap` and the `lookback` of the
* caches.
*
* @returns The number of deleted rows.
*/
async function pruneLilypadChangelog(gate, options) {
	const changelogTable = options.changelogTable ?? "lilypad_cache_changes";
	return (await gate.sql`
    DELETE FROM ${gate.sql(changelogTable)}
    WHERE changed_at < clock_timestamp() - make_interval(secs => ${options.olderThan / 1e3})
  `).count;
}
//#endregion
//#region src/dbGate/LilypadChangelogReader.ts
/**
* Reads the changelog for every cache of a gate in one query: when a cache needs a read, the
* tables of all the subscribed caches are read together, so that N cached tables cost one query
* per poll instead of N.
*/
var LilypadChangelogReader = class {
	constructor(gate, changelogTable) {
		this.gate = gate;
		this.changelogTable = changelogTable;
		this.subscribers = /* @__PURE__ */ new Set();
	}
	/** @returns The function that unsubscribes. */
	subscribe(subscriber) {
		this.subscribers.add(subscriber);
		return () => {
			this.subscribers.delete(subscriber);
		};
	}
	/**
	* Reads the changelog for every subscriber, and resolves once `subscriber` has applied its
	* changes. A read already running that includes `subscriber` is shared.
	*
	* @throws If the changelog cannot be read.
	*/
	read(subscriber) {
		const current = this.current;
		if (!current) return this.start();
		if (current.included.has(subscriber)) return current.promise;
		const noop = () => {};
		this.queued ??= current.promise.then(noop, noop).then(() => {
			this.queued = void 0;
			return this.start();
		});
		return this.queued;
	}
	start() {
		const included = new Set(this.subscribers);
		const promise = this.readAll([...included]).finally(() => {
			if (this.current?.promise === promise) this.current = void 0;
		});
		this.current = {
			included,
			promise
		};
		return promise;
	}
	async readAll(subscribers) {
		if (subscribers.length === 0) return;
		const readAt = Date.now();
		const requests = subscribers.map((subscriber) => subscriber.request(readAt));
		const { changes, cursor } = await readLilypadChangesBatch(this.gate, {
			requests,
			changelogTable: this.changelogTable
		});
		await Promise.allSettled(subscribers.map(async (subscriber, index) => subscriber.apply({
			changes: changes[index] ?? [],
			cursor,
			readAt
		}, requests[index])));
	}
};
const readers = /* @__PURE__ */ new WeakMap();
/** The reader shared by the caches of a gate that use this changelog table. */
function getLilypadChangelogReader(gate, changelogTable = LILYPAD_DEFAULT_CHANGELOG_TABLE) {
	let gateReaders = readers.get(gate);
	if (!gateReaders) {
		gateReaders = /* @__PURE__ */ new Map();
		readers.set(gate, gateReaders);
	}
	let reader = gateReaders.get(changelogTable);
	if (!reader) {
		reader = new LilypadChangelogReader(gate, changelogTable);
		gateReaders.set(changelogTable, reader);
	}
	return reader;
}
/**
* The `changelog` strategy: before a read, at most once per `pollInterval`, the cache reads the
* changes of its table (with the other caches of the gate, see `LilypadChangelogReader`) and
* applies them without a query.
*
* It trusts that it sees every change while its chain of reads is unbroken: each read starts from
* the cursor of the previous one, and the previous one is at most `maxGap` old. Otherwise it reads
* a `lookback` and expires every entry.
*/
var LilypadChangelogSync = class {
	constructor(host, options, verifier) {
		this.host = host;
		this.options = options;
		this.verifier = verifier;
		this.seesOwnWrites = true;
		this.lastRead = 0;
		this.backoff = new LilypadBackoff(() => Math.max(options.pollInterval, 1e3));
		this.reader = getLilypadChangelogReader(host.gate, options.table);
		this.subscriber = {
			request: (readAt) => this.request(readAt),
			apply: (result, request) => this.apply(result, "cursor" in request.since)
		};
		this.unsubscribe = this.reader.subscribe(this.subscriber);
	}
	get maxGap() {
		return this.options.maxGap ?? 36e5;
	}
	start() {
		return Promise.resolve();
	}
	beforeRead() {
		const now = Date.now();
		if (now - this.lastRead < this.options.pollInterval || !this.backoff.ready(now)) return;
		this.verifier.checkInBackground(now);
		const reading = this.read();
		if (this.options.poll === "background") {
			runInBackground(this.host.platform, reading, () => {});
			return;
		}
		return reading;
	}
	trustedSince() {
		if (this.cursor === void 0 || Date.now() - this.lastRead > this.maxGap) return;
		return this.chainStartedAt;
	}
	/** Reads the changelog; errors are logged, and the next read waits for a backoff. */
	read() {
		return this.reader.read(this.subscriber).catch((error) => {
			this.backoff.fail();
			this.host.log("error", "Error reading the changelog:", error);
		});
	}
	/** What to read: the changes since the cursor, or a lookback if the chain is broken. */
	request(readAt) {
		const tableName = this.host.tableName;
		if (this.cursor !== void 0 && readAt - this.lastRead <= this.maxGap) return {
			tableName,
			since: { cursor: this.cursor }
		};
		return {
			tableName,
			since: { lookback: this.options.lookback ?? this.host.defaultLookback() }
		};
	}
	/**
	* Applies a read of the changelog. Its errors are logged: the other caches read with it must not
	* be affected. Each change is returned by one read only (see `LilypadChangelogCursor`).
	*
	* @param trusted - Whether the read started from the cursor of this cache.
	*/
	async apply({ changes, cursor, readAt }, trusted) {
		const { host } = this;
		if (host.isDisposed()) return;
		try {
			if (!trusted) {
				host.expireEverything();
				this.chainStartedAt = readAt;
			}
			const changedKeys = [];
			let truncated = false;
			for (const change of changes) if (change.op === "TRUNCATE") {
				changedKeys.push(...host.applyTruncate("lazy"));
				truncated = true;
			} else changedKeys.push(await host.applyChange(change.op, change.rowId, "lazy", change.xid));
			host.forgetOwnWritesCoveredBy(cursor);
			this.cursor = cursor;
			this.lastRead = readAt;
			this.backoff.succeed();
			host.emitInvalidation("changelog", changedKeys, { wholeCache: truncated });
		} catch (error) {
			this.backoff.fail();
			host.log("error", "Error applying the changelog:", error);
		}
	}
	dispose() {
		this.unsubscribe();
		return Promise.resolve();
	}
};
//#endregion
//#region src/cache/dbSync/LilypadDbSyncTypes.ts
/** The `none` strategy: nothing to follow. */
const lilypadNoSync = {
	start: () => Promise.resolve(),
	beforeRead: () => void 0,
	trustedSince: () => void 0,
	seesOwnWrites: false,
	dispose: () => Promise.resolve()
};
//#endregion
//#region src/cache/dbSync/LilypadListenSync.ts
const OPERATIONS = /* @__PURE__ */ new Set([
	"INSERT",
	"UPDATE",
	"DELETE",
	"TRUNCATE"
]);
/**
* Parses a notification of the `cache_events` channel.
*
* @returns The payload, or `undefined` if it does not have the expected shape.
*/
function parseLilypadNotification(payload) {
	if (typeof payload !== "string") return;
	let parsed;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null) return;
	const { table, op, id, schema, xid } = parsed;
	if (typeof table !== "string" || table === "" || typeof op !== "string" || !OPERATIONS.has(op)) return;
	if (op !== "TRUNCATE" && !(typeof id === "string" && id !== "" || typeof id === "number")) return;
	if (schema !== void 0 && typeof schema !== "string" || xid !== void 0 && typeof xid !== "string") return;
	return parsed;
}
function parseXid(xid) {
	return xid !== void 0 && /^\d+$/.test(xid) ? BigInt(xid) : void 0;
}
/**
* The `listen` strategy: the cache registers a callback on the `cache_events` channel of the gate,
* and applies the notifications of its table.
*
* It trusts that it sees every change while `LISTEN` is active and the gate's heartbeat is recent
* (`isListenHealthy`): a connection that stopped delivering notifications is not trusted, even
* before postgres.js re-establishes it.
*/
var LilypadListenSync = class {
	constructor(host, options, verifier) {
		this.host = host;
		this.options = options;
		this.verifier = verifier;
		this.seesOwnWrites = true;
		this.backoff = new LilypadBackoff(() => 1e3);
		this.applyChanges = options.applyChanges !== false;
		this.listener = {
			channel: LILYPAD_DEFAULT_NOTIFY_CHANNEL,
			callbackId: `lilypad_dbcache_${host.tableName}_${host.id}`,
			onReconnect: () => {
				if (host.isDisposed()) return;
				host.expireEverything();
				if (this.applyChanges) this.listenTrustedSince = Date.now();
			},
			callback: (payload) => this.handleNotification(payload)
		};
	}
	start() {
		return this.options.connect === "lazy" ? Promise.resolve() : this.startListening();
	}
	/**
	* Registers the listener once, after the schema check (which resolves the schema of the table,
	* to ignore the notifications of other schemas). A failed registration is retried by the next
	* call, after a backoff for the lazy `LISTEN` of the reads. If the cache was disposed meanwhile,
	* the listener is removed again.
	*/
	startListening() {
		if (!this.listening) {
			const { gate } = this.host;
			this.listening = this.verifier.verify().then(() => gate.addListener(this.listener)).then(async () => {
				if (this.host.isDisposed()) {
					await gate.removeListener(this.listener.channel, this.listener.callbackId);
					return;
				}
				this.backoff.succeed();
				if (this.applyChanges) this.listenTrustedSince = Date.now();
			}).catch((error) => {
				this.listening = void 0;
				this.backoff.fail();
				throw error;
			});
		}
		return this.listening;
	}
	beforeRead() {
		const now = Date.now();
		if (this.listening) {
			this.verifier.checkInBackground(now);
			return;
		}
		if (this.options.connect !== "lazy" || !this.backoff.ready(now)) return;
		return this.startListening().catch((error) => {
			this.host.log("error", "Error starting LISTEN for the cache:", error);
		});
	}
	trustedSince() {
		return this.host.gate.isListenHealthy() ? this.listenTrustedSince : void 0;
	}
	async handleNotification(raw) {
		const { host } = this;
		if (host.isDisposed()) return;
		host.log("debug", "Received a notification on the cache_events channel:", raw);
		const payload = parseLilypadNotification(raw);
		if (!payload) {
			host.log("warn", "Ignoring a malformed cache_events notification:", raw);
			return;
		}
		if (!this.isForTable(payload)) return;
		if (this.applyChanges) {
			if (payload.op === "TRUNCATE") host.emitInvalidation("notification", host.applyTruncate("eager"), { wholeCache: true });
			else {
				const key = await host.applyChange(payload.op, payload.id, "eager", parseXid(payload.xid));
				host.emitInvalidation("notification", [key]);
			}
		}
		await this.options.onNotification?.(payload);
	}
	/**
	* Whether a notification is about the table of this cache. `table` is the name without its
	* schema; `schema`, when the trigger sends it and the schema of the table is known, must match.
	*/
	isForTable(payload) {
		if (payload.table !== this.host.tableName.split(".").pop()) return false;
		const tableSchema = this.host.tableSchema();
		return payload.schema === void 0 || tableSchema === void 0 || payload.schema === tableSchema;
	}
	/** Waits for a `LISTEN` still starting, then removes the listener. It never rejects. */
	async dispose() {
		await this.listening?.catch(() => {});
		await this.host.gate.removeListener(this.listener.channel, this.listener.callbackId);
	}
};
//#endregion
//#region src/dbGate/LilypadSchemaCheck.ts
/**
* Thrown by `LilypadDbCache.create` with `verify: 'throw'` when the database is not set up (the
* check found errors). Its `problems` include the warnings.
*/
var LilypadSchemaCheckError = class extends Error {
	constructor(subject, problems) {
		super(formatLilypadSchemaProblems(subject, problems));
		this.name = "LilypadSchemaCheckError";
		this.problems = problems;
	}
};
/** A readable report of the problems, followed by the SQL that fixes them. */
function formatLilypadSchemaProblems(subject, problems) {
	const lines = [problems.some((problem) => problem.severity === "error") ? `${subject}: the database is not set up.` : `${subject}: the database is set up, with warnings.`];
	for (const problem of problems) lines.push(`- ${problem.severity === "warning" ? "Warning: " : ""}${problem.message}`);
	const fixes = [...new Set(problems.flatMap((problem) => problem.fix ? [problem.fix] : []))];
	if (fixes.length > 0) lines.push("Run this SQL in a migration to fix it:", ...fixes);
	return lines.join("\n");
}
const TRIGGER_TYPE_ROW = 1;
const TRIGGER_TYPE_INSERT = 4;
const TRIGGER_TYPE_DELETE = 8;
const TRIGGER_TYPE_UPDATE = 16;
const TRIGGER_TYPE_TRUNCATE = 32;
const ROW_EVENTS = 28;
const ROW_EVENT_NAMES = [
	[TRIGGER_TYPE_INSERT, "INSERT"],
	[TRIGGER_TYPE_UPDATE, "UPDATE"],
	[TRIGGER_TYPE_DELETE, "DELETE"]
];
/**
* The row events whose changes a trigger of the changelog function records: all its events for a
* row trigger (versions 3 and earlier), and for a statement trigger the events whose transition
* tables it declares under the names the function reads.
*/
function recordedEvents(trigger) {
	if (!trigger.changelog || !trigger.enabled) return 0;
	const events = trigger.type & ROW_EVENTS;
	if ((trigger.type & TRIGGER_TYPE_ROW) !== 0) return events;
	const hasOld = trigger.oldTable === LILYPAD_CHANGELOG_OLD_ROWS;
	const hasNew = trigger.newTable === LILYPAD_CHANGELOG_NEW_ROWS;
	let recorded = 0;
	if ((events & TRIGGER_TYPE_INSERT) !== 0 && hasNew) recorded |= TRIGGER_TYPE_INSERT;
	if ((events & TRIGGER_TYPE_UPDATE) !== 0 && hasOld && hasNew) recorded |= TRIGGER_TYPE_UPDATE;
	if ((events & TRIGGER_TYPE_DELETE) !== 0 && hasOld) recorded |= TRIGGER_TYPE_DELETE;
	return recorded;
}
/** The names of the row events, e.g. `INSERT, DELETE`. */
function eventNames(events) {
	return ROW_EVENT_NAMES.filter(([bit]) => (events & bit) !== 0).map(([, name]) => name).join(", ");
}
/** An enabled statement-level trigger on TRUNCATE. */
function firesOnTruncate(trigger) {
	return trigger.enabled && (trigger.type & TRIGGER_TYPE_ROW) === 0 && (trigger.type & TRIGGER_TYPE_TRUNCATE) !== 0;
}
function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/**
* The channel on which an installed changelog function sends notifications (its first
* `pg_notify`, in the `TRUNCATE` branch, where the literal is not escaped for `format()`), or
* `false` if it sends none.
*/
function installedNotifyChannel(source) {
	const match = source ? /pg_notify\s*\(\s*'((?:[^']|'')*)'/i.exec(source) : null;
	return match?.[1] !== void 0 ? match[1].replace(/''/g, "'") : false;
}
/** A `json` column: postgres.js parses it, unless the type is not registered yet. */
function parseJsonColumn(value) {
	return typeof value === "string" ? JSON.parse(value) : value;
}
/** The changelog table and trigger function the options designate, or `undefined` if not checked. */
function changelogTarget(options) {
	if (options.changelog === false) return;
	const table = options.changelog?.table ?? "lilypad_cache_changes";
	return {
		table,
		custom: table === "lilypad_cache_changes" ? void 0 : table,
		functionSignature: `${quoteIdentifier(triggerFunctionName(table))}()`
	};
}
const MINUTE = 6e4;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The default `minRetention`: the default `maxGap` of the caches. */
const DEFAULT_MIN_RETENTION = HOUR;
/**
* How much older than the retention the oldest row may be before it is reported: a job that runs
* daily, or even weekly, leaves rows up to one period older than its retention.
*/
const UNPRUNED_MARGIN = 7 * DAY;
/** A duration for a message, e.g. `36 hours`, `2.5 days`. */
function formatDuration(ms) {
	const units = [
		[DAY, "day"],
		[HOUR, "hour"],
		[MINUTE, "minute"],
		[1e3, "second"]
	];
	for (const [size, name] of units) if (ms >= size * (size === DAY ? 2 : 1)) {
		const amount = Math.round(ms / size * 10) / 10;
		return `${amount} ${name}${amount === 1 ? "" : "s"}`;
	}
	return `${Math.round(ms)} ms`;
}
const INTERVAL_UNITS = [
	[/^(w|weeks?)$/, 7 * DAY],
	[/^(d|days?)$/, DAY],
	[/^(h|hrs?|hours?)$/, HOUR],
	[/^(mons?|months?)$/, 30 * DAY],
	[/^(m|mins?|minutes?)$/, MINUTE],
	[/^(s|secs?|seconds?)$/, 1e3]
];
/** The duration of an interval literal (`24 hours`, `1 day 12:00:00`), or `undefined`. */
function parseInterval(text) {
	let total = 0;
	let matched = false;
	for (const [, hours, minutes, seconds] of text.matchAll(/(\d+):(\d{2})(?::(\d{2}))?/g)) {
		total += Number(hours) * HOUR + Number(minutes) * MINUTE + Number(seconds ?? 0) * 1e3;
		matched = true;
	}
	for (const [, amount, unit] of text.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
		const size = INTERVAL_UNITS.find(([pattern]) => pattern.test(unit.toLowerCase()))?.[1];
		if (size !== void 0) {
			total += Number(amount) * size;
			matched = true;
		}
	}
	return matched ? total : void 0;
}
/**
* The retention of a pruning command, from `make_interval(secs => ...)` (the SQL of the library)
* or an interval literal (`interval '7 days'`, `'1 day'::interval`); `undefined` if not found.
*/
function lilypadPruneCommandRetention(command) {
	const seconds = /make_interval\s*\(\s*secs\s*=>\s*'?(\d+(?:\.\d+)?)'?\s*\)/i.exec(command);
	if (seconds) return Number(seconds[1]) * 1e3;
	const literal = /interval\s*'([^']*)'|'([^']*)'\s*::\s*interval/i.exec(command);
	const text = literal?.[1] ?? literal?.[2];
	return text === void 0 ? void 0 : parseInterval(text);
}
/**
* Whether a command deletes rows from the changelog table: a `DELETE FROM` of the same table name,
* in the same schema when both name one. Case and quotes are ignored.
*/
function lilypadCommandDeletesFrom(command, changelogTable) {
	const target = changelogTable.replace(/"/g, "").toLowerCase().split(".");
	for (const [, name] of command.matchAll(/\bdelete\s+from\s+(?:only\s+)?([\w$."]+)/gi)) {
		const parts = name.replace(/"/g, "").toLowerCase().split(".");
		if (parts.at(-1) === target.at(-1) && (parts.length === 1 || target.length === 1 || parts.at(-2) === target.at(-2))) return true;
	}
	return false;
}
/**
* The pruning problems of the changelog, and the `prune` option that the SQL fixing the changelog
* must install: the installed one, or the one suggested when the trigger is the best pruning.
*/
function evaluatePruning(facts, changelog, options, changelogSql) {
	const minRetention = options?.minRetention ?? DEFAULT_MIN_RETENTION;
	assertNumberOption("checkLilypadSchema", "changelog.minRetention", minRetention, "positive");
	const recommended = Math.max(DAY, 4 * minRetention);
	const installed = installedLilypadChangelogPrune(facts.changelog.functionSource);
	const problems = [];
	const detected = [];
	if (installed && facts.changelog.hasFunction) {
		if (!facts.changelog.hasPruneFunction) problems.push({
			code: "missing-changelog",
			severity: "error",
			message: `The changelog trigger function prunes with ${pruneFunctionName(changelog.table)}(), which does not exist: the writes that prune fail.`,
			fix: changelogSql(installed)
		});
		detected.push({
			by: "the prune option of the changelog trigger",
			retention: installed.olderThan,
			fixWith: (olderThan) => changelogSql({
				...installed,
				olderThan
			})
		});
	}
	const cronJobs = (facts.cron.jobs ?? []).filter((job) => (job.database === null || job.database === facts.database) && lilypadCommandDeletesFrom(job.command, changelog.table));
	for (const job of cronJobs.filter((job) => job.active)) {
		const by = job.name !== null ? `the pg_cron job "${job.name}"` : `the pg_cron job ${job.id ?? ""}`;
		detected.push({
			by,
			retention: lilypadPruneCommandRetention(job.command),
			fixWith: (olderThan) => (job.name === null && job.id !== null ? `SELECT cron.unschedule(${job.id});\n` : "") + lilypadChangelogPruneScheduleSql({
				olderThan,
				schedule: job.schedule || void 0,
				changelogTable: changelog.custom,
				jobName: job.name ?? void 0
			})
		});
	}
	for (const { by, retention, fixWith } of detected) if (retention !== void 0 && retention <= minRetention) problems.push({
		code: "short-changelog-retention",
		severity: "error",
		message: `${capitalize(by)} deletes the changelog rows older than ${formatDuration(retention)}, but the caches need them for ${formatDuration(minRetention)} (their maxGap and lookback): a cache could miss changes without knowing it. Keep them far longer, e.g. ${formatDuration(recommended)}.`,
		fix: fixWith(recommended)
	});
	const age = facts.changelog.oldestRowAge;
	const external = options?.pruning === "external" || facts.changelog.deletedRows > 0;
	let prune = installed;
	if (detected.length === 0 && !external) {
		const suggestion = suggestPruning(facts, changelog, recommended, changelogSql);
		const inactive = cronJobs.find((job) => !job.active);
		problems.push({
			code: "no-changelog-pruning",
			severity: "warning",
			message: `Nothing deletes the old rows of the changelog "${changelog.table}"` + (age !== null && age > DAY ? ` (the oldest is ${formatDuration(age)} old)` : "") + `: it grows with every change. ` + (inactive ? `The pg_cron job "${inactive.name ?? inactive.id ?? ""}" deletes them, but is inactive. ` : "") + `${suggestion.message} If a job of your own deletes them (e.g. pruneLilypadChangelog from a scheduled function), set pruning: 'external'.`,
			fix: suggestion.fix
		});
		prune = suggestion.prune ?? installed;
	} else if (age !== null) {
		const retentions = detected.flatMap(({ retention }) => retention !== void 0 ? [retention] : []);
		const retention = retentions.length > 0 ? Math.max(...retentions) : recommended;
		if (age > retention + UNPRUNED_MARGIN) {
			const by = detected.map((pruning) => pruning.by).join(" and ");
			problems.push({
				code: "unpruned-changelog",
				severity: "warning",
				message: `The oldest row of the changelog "${changelog.table}" is ${formatDuration(age)} old: ` + (by ? `${by} does not run, or does not keep up.` : `its pruning does not run, or does not keep up.`) + (installed ? " The trigger deletes at most batchSize rows on one statement in every: raise batchSize or lower every if the statements change more rows on average." : "") + " The fix deletes the old rows once.",
				fix: `DELETE FROM ${quoteIdentifier(changelog.table)} WHERE ${olderThanCondition(Math.max(retention, recommended))};\n`
			});
		}
	}
	return {
		problems,
		prune
	};
}
function capitalize(text) {
	return text.charAt(0).toUpperCase() + text.slice(1);
}
/**
* The best pruning for the database: a pg_cron job, which keeps the deletions out of the writes,
* when pg_cron is known to run; otherwise the `prune` option of the trigger, which needs nothing.
*/
function suggestPruning(facts, changelog, olderThan, changelogSql) {
	const { cron } = facts;
	const retention = formatDuration(olderThan);
	if (cron.installed || cron.database === facts.database) return {
		message: cron.installed ? `pg_cron is installed, with no job of this role that deletes them (the jobs of the other roles are not visible): the fix schedules a daily one, which deletes the rows older than ${retention}.` : `pg_cron runs in this database: the fix installs it and schedules a daily job that deletes the rows older than ${retention}.`,
		fix: (cron.installed ? "" : "CREATE EXTENSION IF NOT EXISTS pg_cron;\n") + lilypadChangelogPruneScheduleSql({
			olderThan,
			changelogTable: changelog.custom
		})
	};
	const schema = changelog.table.includes(".") ? void 0 : facts.changelog.schema;
	if (cron.database !== null && (schema || changelog.table.includes("."))) return {
		message: `pg_cron runs in the database "${cron.database}": the fix, to run there, schedules a daily job that deletes the rows older than ${retention} in this one.`,
		fix: `-- Run in the database "${cron.database}", where pg_cron runs:\nCREATE EXTENSION IF NOT EXISTS pg_cron;
` + lilypadChangelogPruneScheduleSql({
			olderThan,
			changelogTable: schema ? `${schema}.${changelog.table}` : changelog.table,
			database: facts.database
		})
	};
	const prune = { olderThan };
	return {
		message: `The fix makes the changelog trigger delete the rows older than ${retention} as it records changes (the prune option of lilypadChangelogSql).` + (cron.available ? ` pg_cron is available on this server: if it is enabled (shared_preload_libraries), a pg_cron job keeps the deletions out of the writes: lilypadChangelogPruneScheduleSql({ olderThan: ${olderThan} }).` : ""),
		fix: changelogSql(prune),
		prune
	};
}
/**
* Reads from the catalogs what {@link evaluateLilypadSchema} needs. It changes nothing.
*
* @throws If the catalogs cannot be read (e.g. the database is unreachable).
*/
async function readLilypadSchemaFacts(gate, options) {
	const sql = gate.sql;
	const changelog = changelogTarget(options) ?? changelogTarget({ tables: [] });
	const quotedChangelog = quoteIdentifier(changelog.table);
	const [database] = await sql`
    SELECT
      current_setting('server_version_num')::int AS version,
      current_database() AS database,
      to_regclass(${quotedChangelog}::text) IS NOT NULL AS has_changelog_table,
      (
        SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.oid = to_regclass(${quotedChangelog}::text)
      ) AS changelog_schema,
      to_regprocedure(${`${quoteIdentifier(pruneFunctionName(changelog.table))}()`}::text) IS NOT NULL AS has_prune_function,
      coalesce((
        SELECT n_tup_del FROM pg_stat_user_tables WHERE relid = to_regclass(${quotedChangelog}::text)
      ), 0)::float8 AS deleted_rows,
      EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') AS cron_available,
      EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') AS cron_installed,
      (SELECT setting FROM pg_settings WHERE name = 'cron.database_name') AS cron_database,
      to_regclass('cron.job') IS NOT NULL AS has_cron_jobs,
      EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = to_regclass(${quotedChangelog}::text)
          AND attname = 'table_schema' AND NOT attisdropped
      ) AS has_schema_column,
      to_regprocedure(${changelog.functionSignature}::text) IS NOT NULL AS has_function,
      obj_description(to_regprocedure(${changelog.functionSignature}::text), 'pg_proc') AS function_comment,
      (
        SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(${changelog.functionSignature}::text)
      ) AS function_source
  `;
	if (!database) throw new Error("Reading the database settings returned no row.");
	const tables = [];
	for (const { table } of options.tables) {
		const [found] = await sql`
      SELECT
        n.nspname AS schema_name,
        (
          SELECT coalesce(json_agg(json_build_object(
            'changelog', tr.tgfoid = to_regprocedure(${changelog.functionSignature}::text)::oid,
            'args', encode(tr.tgargs, 'escape'),
            'type', tr.tgtype,
            -- 'R' (ENABLE REPLICA) triggers fire only with session_replication_role = replica
            'enabled', tr.tgenabled IN ('O', 'A'),
            'source', p.prosrc,
            'oldTable', tr.tgoldtable,
            'newTable', tr.tgnewtable
          )), '[]'::json)
          FROM pg_trigger tr JOIN pg_proc p ON p.oid = tr.tgfoid
          WHERE tr.tgrelid = t.oid AND NOT tr.tgisinternal
        ) AS triggers
      FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE t.oid = to_regclass(${quoteIdentifier(table)}::text)
    `;
		tables.push(found ? {
			schema: found.schema_name,
			triggers: parseJsonColumn(found.triggers)
		} : {
			schema: null,
			triggers: []
		});
	}
	let oldestRowAge = null;
	let jobs = null;
	if (options.changelog !== false) {
		if (database.has_changelog_table) oldestRowAge = await sql`
        SELECT (extract(epoch FROM clock_timestamp() - min(changed_at)) * 1000)::float8 AS age
        FROM ${sql(changelog.table)}
      `.then(([row]) => row?.age ?? null, () => null);
		if (database.has_cron_jobs) jobs = await readCronJobs(gate);
	}
	return {
		version: database.version,
		database: database.database,
		changelog: {
			hasTable: database.has_changelog_table,
			hasSchemaColumn: database.has_schema_column,
			hasFunction: database.has_function,
			functionComment: database.function_comment,
			functionSource: database.function_source,
			schema: database.changelog_schema,
			hasPruneFunction: database.has_prune_function,
			oldestRowAge,
			deletedRows: database.deleted_rows
		},
		cron: {
			available: database.cron_available,
			installed: database.cron_installed,
			database: database.cron_database,
			jobs
		},
		tables
	};
}
/**
* The jobs of `cron.job`, or `null` if they cannot be read. Read as JSON, so that the columns
* that older versions of pg_cron lack (`jobname`, `database`) are simply absent.
*/
async function readCronJobs(gate) {
	try {
		const [row] = await gate.sql`
      SELECT coalesce(json_agg(row_to_json(j)), '[]'::json) AS jobs FROM cron.job j
    `;
		return (parseJsonColumn(row?.jobs) ?? []).map((job) => ({
			id: typeof job.jobid === "number" ? job.jobid : null,
			name: typeof job.jobname === "string" ? job.jobname : null,
			schedule: typeof job.schedule === "string" ? job.schedule : "",
			command: typeof job.command === "string" ? job.command : "",
			active: job.active !== false,
			database: typeof job.database === "string" ? job.database : null
		}));
	} catch {
		return null;
	}
}
/**
* Checks that the database has what `LilypadDbCache` needs to learn about changes: the changelog
* table, its trigger function and a trigger on each cached table, or a trigger that sends
* notifications. It only reads the catalogs: it changes nothing.
*
* @returns The problems found, each with a message and, when the library can generate it, the SQL
* that fixes it (`ok` is true when there is none).
* @throws If the catalogs cannot be read (e.g. the database is unreachable).
*/
async function checkLilypadSchema(gate, options) {
	return evaluateLilypadSchema(await readLilypadSchemaFacts(gate, options), options);
}
/**
* The problems of the facts read by {@link readLilypadSchemaFacts}, for these options. It is pure:
* it reads no database.
*/
function evaluateLilypadSchema(facts, options) {
	const changelog = changelogTarget(options);
	const notifyChannel = options.notifyChannel ?? false;
	const installedPrune = installedLilypadChangelogPrune(facts.changelog.functionSource);
	const problems = [];
	if (facts.version < 13e4) problems.push({
		code: "unsupported-version",
		severity: "error",
		message: `PostgreSQL ${facts.version} is too old: the changelog needs PostgreSQL 13 or later.`
	});
	let pruningProblems = [];
	if (changelog) {
		const channel = notifyChannel !== false ? notifyChannel : installedNotifyChannel(facts.changelog.functionSource);
		const sqlWith = (prune) => lilypadChangelogSql({
			table: changelog.custom,
			notifyChannel: channel,
			prune
		});
		const pruning = evaluatePruning(facts, changelog, options.changelog || void 0, sqlWith);
		pruningProblems = pruning.problems;
		const changelogSql = sqlWith(pruning.prune);
		const { hasTable, hasSchemaColumn, hasFunction, functionComment } = facts.changelog;
		if (!hasTable || !hasFunction) problems.push({
			code: "missing-changelog",
			severity: "error",
			message: !hasTable ? `The changelog table "${changelog.table}" does not exist.` : `The changelog trigger function ${changelog.functionSignature} does not exist.`,
			fix: changelogSql
		});
		const comment = functionComment ?? "";
		const version = comment.startsWith("lilypad-changelog:") ? Number(comment.slice(18)) : 1;
		if (hasTable && !hasSchemaColumn || hasFunction && version < 4) problems.push({
			code: "outdated-changelog",
			severity: "error",
			message: `The changelog "${changelog.table}" was installed by an older version of the library (version ${version}, expected 4).`,
			fix: changelogSql
		});
	}
	const tables = [];
	options.tables.forEach(({ table, primaryKey }, index) => {
		const found = facts.tables[index];
		if (!found || found.schema === null) {
			tables.push({
				table,
				schema: null
			});
			problems.push({
				code: "missing-table",
				severity: "error",
				table,
				message: `The table "${table}" does not exist.`
			});
			return;
		}
		tables.push({
			table,
			schema: found.schema
		});
		const triggers = found.triggers;
		if (changelog) {
			const fix = lilypadChangelogTriggerSql({
				table,
				primaryKey,
				changelogTable: changelog.custom
			});
			const working = triggers.filter((trigger) => recordedEvents(trigger) !== 0);
			const recorded = working.reduce((events, trigger) => events | recordedEvents(trigger), 0);
			const recordedColumn = (trigger) => trigger.args.split("\\000")[0];
			const wrongColumn = working.find((trigger) => recordedColumn(trigger) !== primaryKey);
			if (recorded !== ROW_EVENTS) problems.push({
				code: "missing-changelog-trigger",
				severity: "error",
				table,
				message: triggers.some((trigger) => trigger.changelog) ? `The changelog triggers of "${table}" do not record ${eventNames(ROW_EVENTS & ~recorded)}: they are missing, disabled, or lack their transition tables.` : `The table "${table}" has no changelog trigger: its changes are not recorded.`,
				fix
			});
			else if (wrongColumn) problems.push({
				code: "wrong-trigger-primary-key",
				severity: "error",
				table,
				message: `The changelog trigger of "${table}" records the column "${recordedColumn(wrongColumn)}", not the primary key "${primaryKey}".`,
				fix
			});
			else if (!triggers.some((trigger) => trigger.changelog && firesOnTruncate(trigger))) problems.push({
				code: "missing-truncate-trigger",
				severity: "error",
				table,
				message: `The changelog does not record TRUNCATE of "${table}": the caches would keep the removed rows.`,
				fix
			});
		}
		if (notifyChannel !== false) {
			const notifies = new RegExp(`pg_notify\\s*\\(\\s*'${escapeRegExp(notifyChannel.replace(/'/g, "''"))}'`, "i");
			const notifiedEvents = triggers.filter((trigger) => trigger.enabled && notifies.test(trigger.source)).reduce((events, trigger) => events | ((trigger.type & TRIGGER_TYPE_ROW) !== 0 ? trigger.type & ROW_EVENTS : recordedEvents(trigger)), 0);
			const fix = lilypadChangelogSql({
				table: changelog?.custom,
				notifyChannel,
				prune: installedPrune
			}) + lilypadChangelogTriggerSql({
				table,
				primaryKey,
				changelogTable: changelog?.custom
			});
			if (notifiedEvents === 0) problems.push({
				code: "missing-notify-trigger",
				severity: "error",
				table,
				message: `No trigger of "${table}" sends notifications on the "${notifyChannel}" channel: the cache is not told about changes made elsewhere.`,
				fix
			});
			else if (notifiedEvents !== ROW_EVENTS) problems.push({
				code: "missing-notify-trigger",
				severity: "error",
				table,
				message: `The triggers of "${table}" send notifications on the "${notifyChannel}" channel only on ${eventNames(notifiedEvents)}: the cache is not told about ${eventNames(ROW_EVENTS & ~notifiedEvents)} made elsewhere.`,
				fix
			});
			else if (!triggers.some((trigger) => firesOnTruncate(trigger) && notifies.test(trigger.source))) problems.push({
				code: "missing-truncate-trigger",
				severity: "error",
				table,
				message: `No trigger of "${table}" sends a notification on the "${notifyChannel}" channel for TRUNCATE: the caches would keep the removed rows.`,
				fix
			});
		}
	});
	problems.push(...pruningProblems);
	return {
		ok: !problems.some((problem) => problem.severity === "error"),
		problems,
		tables
	};
}
//#endregion
//#region src/cache/dbSync/LilypadSchemaVerifier.ts
/**
* Checks once that the database has the triggers a sync strategy needs, and resolves the schema of
* the table. With `warn` it never rejects: problems and failures are logged. With `throw` it rejects
* if the check found errors; warnings (e.g. a changelog that nothing prunes) are logged. A check that could not
* run (e.g. the database was unreachable) is forgotten, so that a later read runs it again after a
* backoff; a check that found problems is not repeated.
*/
var LilypadSchemaVerifier = class {
	constructor(options) {
		this.options = options;
		this.backoff = new LilypadBackoff(() => 1e3);
	}
	get mode() {
		return this.options.strategy === "none" ? "off" : this.options.mode;
	}
	/** @throws A `LilypadSchemaCheckError` with `throw`, or the error of the check. */
	verify() {
		const mode = this.mode;
		if (mode === "off") return Promise.resolve();
		if (!this.check) {
			const check = this.run(mode).then((ran) => {
				if (!ran && this.check === check) this.check = void 0;
			});
			this.check = check;
		}
		return this.check;
	}
	/**
	* Runs the check in the background, unless it has already run, is running, or failed less than
	* a backoff ago. Reads call it to retry a check that could not run.
	*/
	checkInBackground(now = Date.now()) {
		if (this.check || !this.backoff.ready(now) || this.mode === "off") return;
		runInBackground(this.options.platform, this.verify(), () => {});
	}
	/** @returns `false` if the check could not run (with `warn`; `throw` rejects). */
	async run(mode) {
		const { gate, tableName, primaryKey, strategy, changelogTable, pruning, minRetention, log } = this.options;
		const subject = `LilypadDbCache "${tableName}" (sync: ${strategy})`;
		try {
			const result = await checkLilypadSchema(gate, {
				tables: [{
					table: tableName,
					primaryKey
				}],
				changelog: strategy === "changelog" ? {
					table: changelogTable,
					pruning,
					minRetention
				} : false,
				notifyChannel: strategy === "listen" ? LILYPAD_DEFAULT_NOTIFY_CHANNEL : false
			});
			const schema = result.tables[0]?.schema;
			if (schema) this.options.onSchema(schema);
			this.backoff.succeed();
			if (result.problems.length === 0) return true;
			if (mode === "throw" && !result.ok) throw new LilypadSchemaCheckError(subject, result.problems);
			const message = formatLilypadSchemaProblems(subject, result.problems);
			if (this.options.canWarn()) log("warn", message);
			else console.warn(message);
			return true;
		} catch (error) {
			if (mode === "throw") throw error;
			this.backoff.fail();
			log("warn", `${subject}: could not check the database schema:`, error);
			return false;
		}
	}
};
//#endregion
//#region src/cache/LilypadDbCache.ts
const DEFAULT_MAX_AGE = 36e5;
/** Beyond this share of the rows to fetch, `getAll` loads the whole table in one query instead. */
const FULL_LOAD_RATIO = .25;
/** How long the writes of this instance are remembered, to recognize their changes. */
const OWN_WRITE_RETENTION = 6e5;
/**
* A cache of the rows of one table, kept up to date with the changes made elsewhere.
*
* Its values always come from the table: it reads rows on a miss (`getOrFetch`), loads the whole
* table once (`getAll`), and writes through to the database (`sqlCreate`, `sqlUpdate`,
* `sqlDelete`). Unlike `LilypadCache`, it has no `set` or `getOrSet`: a value that does not come
* from the table could be kept past its TTL as if it did.
*
* @typeParam V - The row type.
* @typeParam PK - The primary key column; the keys of the cache are its values.
*
* @example
* ```typescript
* const users = await LilypadDbCache.create({ ttl: 60_000, gate, schema: usersSchema, logger });
* const user = await users.getOrFetch(42); // User, or null when there is no such row
* await users.dispose();
* ```
*
* @remarks
* - `get` reads memory only. `getOrFetch` queries the database on a miss; `refresh` always
*   re-fetches the key; `getAll` loads the whole table once, then fetches only the rows it does
*   not hold up to date.
* - Changes made elsewhere reach the cache through the `sync` strategy ({@link LilypadDbCacheSync}).
*   Only keys the cache holds (or is fetching) are re-fetched or expired; for other keys it only
*   notes that the row exists, and `getAll` fetches it.
* - The name of the cache (shared level keys, invalidation events, logs) defaults to the table name.
*/
var LilypadDbCache = class LilypadDbCache extends LilypadCacheCore {
	/**
	* Creates a cache and, with the `listen` strategy (unless `connect: 'lazy'`), registers its
	* database listener. The row type and the primary key are inferred from `schema`.
	* With `singleton: true`, a later call with the same identifier returns the existing cache and
	* ignores its own options (a warning is logged if the table or the TTL differ).
	*
	* @throws If the database listener cannot be registered (e.g. the database is unreachable), or,
	* with `verify: 'throw'`, if the database is not set up.
	*/
	static async create(options) {
		return createLilypadSingletonAbleAsync("LilypadDbCache", options, async (release) => {
			const cache = new LilypadDbCache(options);
			try {
				if (cache.verifier.mode === "throw") await cache.verifier.verify();
				await cache.sync.start();
			} catch (error) {
				await cache.dispose();
				throw error;
			}
			cache.releaseSingleton = release;
			return cache;
		}, {
			value: JSON.stringify([options.schema.tableName, options.ttl]),
			onMismatch: () => libLog(options.logger, "warn", "LilypadDbCache", `Singleton "${options.singleton ? options.singletonIdentifier : ""}" already exists with a different table or TTL: the new options are ignored.`)
		});
	}
	constructor(options) {
		const { gate, schema, sync = { strategy: "listen" }, bulkSync, ...cacheOptions } = options;
		super({
			...cacheOptions,
			bulkSync,
			name: options.name ?? schema.tableName
		});
		this.releaseSingleton = () => {};
		this.members = /* @__PURE__ */ new Map();
		this.membersFloor = 0;
		this.rowFetches = /* @__PURE__ */ new Map();
		this.eagerReads = /* @__PURE__ */ new Map();
		this.refreshes = /* @__PURE__ */ new Map();
		this.ownWrites = /* @__PURE__ */ new Map();
		const owner = "LilypadDbCache";
		if (sync.strategy !== "none") assertNumberOption(owner, "sync.maxAge", sync.maxAge, "non-negative");
		if (sync.strategy === "changelog") {
			assertNumberOption(owner, "sync.pollInterval", sync.pollInterval, "non-negative");
			assertNumberOption(owner, "sync.maxGap", sync.maxGap, "positive");
			assertNumberOption(owner, "sync.lookback", sync.lookback, "non-negative");
			if (typeof sync.pollInterval !== "number") throw new Error(`${owner}: sync.pollInterval is required with the changelog strategy.`);
		}
		this.gate = gate;
		this.schema = schema;
		this.maxAge = sync.strategy === "none" ? 0 : sync.maxAge ?? DEFAULT_MAX_AGE;
		const tableNameParts = schema.tableName.split(".");
		if (tableNameParts.length > 1) this.tableSchema = tableNameParts[tableNameParts.length - 2];
		this.verifier = new LilypadSchemaVerifier({
			gate,
			tableName: schema.tableName,
			primaryKey: String(schema.primaryKey),
			strategy: sync.strategy,
			changelogTable: sync.strategy === "changelog" ? sync.table : void 0,
			pruning: sync.strategy === "changelog" ? sync.pruning : void 0,
			minRetention: sync.strategy === "changelog" ? Math.max(sync.maxGap ?? 36e5, sync.lookback ?? this.defaultLookback()) : void 0,
			mode: sync.strategy === "none" ? "off" : sync.verify ?? "warn",
			platform: this.platform,
			log: (level, ...message) => libLog(this.logger, level, this.name, ...message),
			canWarn: () => this.logger?.warn !== void 0,
			onSchema: (resolved) => {
				this.tableSchema = resolved;
			}
		});
		const host = this.syncHost();
		this.sync = sync.strategy === "listen" ? new LilypadListenSync(host, sync, this.verifier) : sync.strategy === "changelog" ? new LilypadChangelogSync(host, sync, this.verifier) : lilypadNoSync;
		libLog(this.logger, "debug", this.name, `LilypadDbCache initialized for table "${schema.tableName}" (sync: ${sync.strategy})`);
	}
	/** What the sync strategy may use of this cache. */
	syncHost() {
		return {
			id: this.id,
			name: this.name,
			gate: this.gate,
			tableName: this.schema.tableName,
			platform: this.platform,
			log: (level, ...message) => libLog(this.logger, level, this.name, ...message),
			isDisposed: () => this.disposed,
			applyChange: (op, id, mode, xid) => this.applyChange(op, id, mode, xid),
			applyTruncate: (mode) => this.applyTruncate(mode),
			expireEverything: () => this.expireEverything(),
			emitInvalidation: (source, keys, options) => this.emitInvalidation(source, keys, options),
			forgetOwnWritesCoveredBy: (cursor) => this.forgetOwnWritesCoveredBy(cursor),
			tableSchema: () => this.tableSchema,
			defaultLookback: () => this.defaultLookback()
		};
	}
	/** The default `lookback` of the changelog: the lifetime of a shared copy, plus 1 minute. */
	defaultLookback() {
		return this.defaultTtl + this.defaultStaleWhileRevalidate + 6e4;
	}
	/**
	* Loads every row of the table and replaces the content of the cache with them.
	*
	* @returns The rows loaded, by normalized key: with `maxEntries`, the cache may not hold them all.
	*/
	async loadRows(signal) {
		const read = this.beginRead();
		const primaryKey = this.schema.primaryKey;
		const entries = (await this.gate.selectAllFromTable(this.schema, { signal })).map((row) => [row[primaryKey], row]);
		if (!signal.aborted && !this.disposed) {
			this.replaceMembers(entries, read.ticket, read.startedAt);
			this.replaceEntries(read, entries);
		}
		return new Map(entries.map(([key, row]) => [this.normalizeKey(key), row]));
	}
	/**
	* Keeps, without a query, an entry that reached its TTL while it is known to be up to date: its
	* value was read from the database (or written by this instance) after the sync became trusted,
	* and any change of its row since would have expired it. It is kept until `maxAge`.
	*/
	renew(normalizedKey) {
		const entry = this.store.get(normalizedKey);
		const now = Date.now();
		if (!entry || entry.origin !== "source" || entry.expirationTime === 0) return;
		if (now < entry.expirationTime) return;
		const trustedSince = this.sync.trustedSince();
		if (trustedSince === void 0 || entry.fetchedAt < trustedSince) return;
		if (now - entry.fetchedAt >= this.maxAge) return;
		this.store.set(normalizedKey, {
			...entry,
			expirationTime: Math.min(now + this.defaultTtl, entry.fetchedAt + this.maxAge)
		});
	}
	/**
	* Applies a change of a row made elsewhere.
	* - A change made by a write of this instance whose result the entry still holds: nothing to do.
	* - A change of a key held (or being read) by this instance: `eager` re-fetches it at once
	*   (with the other keys notified meanwhile, in one query); `lazy` expires it with no query,
	*   which also discards a read in flight (it may predate the change): the next read fetches
	*   it. A `lazy` DELETE caches the key as `null` at once.
	* - A change of any other key: no query, and no entry. The shared level entry is removed.
	* INSERT and UPDATE note the key as a row of the table, which `getAll` returns. An `eager`
	* DELETE of a key not held leaves it there: `getAll` reads it again, and learns whether it is
	* gone. A notification is thus never trusted without a query (any role can send one).
	*
	* @param xid - The transaction that made the change, when known.
	* @returns The key of the changed row.
	*/
	async applyChange(op, id, mode, xid) {
		const key = this.resolveNotifiedKey(id);
		if (xid !== void 0 && this.isOwnWrite(key, xid)) return key;
		const normalizedKey = this.normalizeKey(key);
		const held = this.store.has(normalizedKey) || this.hasReadInFlight(normalizedKey);
		if (op === "DELETE" && mode === "lazy") {
			if (held) this.markDeleted(key);
			else {
				this.members.delete(normalizedKey);
				this.deleteShared(key);
			}
			return key;
		}
		if (op !== "DELETE") this.addMember(key);
		if (!held) this.deleteShared(key);
		else if (mode === "eager") await this.refreshInBatch(key);
		else this.markInvalid(key);
		return key;
	}
	/**
	* Applies a `TRUNCATE` of the table: every entry is expired, the reads started before are
	* discarded, and the copies of the shared level produced before are ignored. From the changelog
	* (`lazy`) the table is known to be empty; from a notification (`eager`), which anyone can send,
	* the next `getAll` loads the table again instead.
	*
	* @returns The keys that were cached.
	*/
	applyTruncate(mode) {
		const keys = [...this.store.values()].map((entry) => entry.key);
		for (const key of keys) this.deleteShared(key);
		this.expireEverything();
		this.rejectSharedBefore(Date.now());
		this.membersFloor = this.nextTicket();
		this.members.clear();
		if (mode === "eager") this.membersLoadedAt = void 0;
		return keys;
	}
	/**
	* Whether a change is the one of a write of this instance, and the entry still holds the result
	* of the last write of this instance (nothing else replaced it since): that result is at least
	* as recent as the change. The write is forgotten either way.
	*/
	isOwnWrite(key, xid) {
		const normalizedKey = this.normalizeKey(key);
		const own = this.ownWrites.get(normalizedKey);
		if (!own?.xids.delete(xid)) return false;
		if (own.xids.size === 0) this.ownWrites.delete(normalizedKey);
		return this.store.get(normalizedKey)?.ticket === own.ticket;
	}
	recordOwnWrite(normalizedKey, xid, ticket) {
		const now = Date.now();
		for (const [key, own] of this.ownWrites) {
			if (now - own.at <= OWN_WRITE_RETENTION) break;
			this.ownWrites.delete(key);
		}
		const xids = this.ownWrites.get(normalizedKey)?.xids ?? /* @__PURE__ */ new Set();
		xids.add(xid);
		this.ownWrites.delete(normalizedKey);
		this.ownWrites.set(normalizedKey, {
			ticket,
			xids,
			at: now
		});
	}
	/** Forgets the own writes whose changes a read from this cursor no longer returns. */
	forgetOwnWritesCoveredBy(cursor) {
		for (const [normalizedKey, own] of this.ownWrites) {
			for (const xid of own.xids) if (lilypadCursorCovers(cursor, xid)) own.xids.delete(xid);
			if (own.xids.size === 0) this.ownWrites.delete(normalizedKey);
		}
	}
	/** Follows the values stored in the cache: a row is a row of the table, `null` is not. */
	onValueStored(entry) {
		if (this.membersLoadedAt === void 0 || entry.origin === "fallback") return;
		const normalizedKey = this.normalizeKey(entry.key);
		const member = this.members.get(normalizedKey);
		if (member && member.ticket > entry.ticket) return;
		if (entry.value === null) this.members.delete(normalizedKey);
		else this.members.set(normalizedKey, {
			key: entry.key,
			ticket: entry.ticket
		});
	}
	/** Notes a row that exists in the table, without fetching it. */
	addMember(key) {
		if (this.membersLoadedAt !== void 0) this.members.set(this.normalizeKey(key), {
			key,
			ticket: this.nextTicket()
		});
	}
	/**
	* Replaces the rows of the table with the result of a load, keeping what changed after the load
	* started: rows added since, rows deleted since.
	*/
	replaceMembers(entries, ticket, startedAt) {
		if (ticket < this.membersFloor) return;
		const members = /* @__PURE__ */ new Map();
		for (const [key] of entries) {
			const normalizedKey = this.normalizeKey(key);
			const entry = this.store.get(normalizedKey);
			if (entry && entry.ticket > ticket && entry.value === null && entry.origin !== "fallback") continue;
			const member = this.members.get(normalizedKey);
			members.set(normalizedKey, member && member.ticket > ticket ? member : {
				key,
				ticket
			});
		}
		for (const [normalizedKey, member] of this.members) if (member.ticket > ticket && !members.has(normalizedKey)) members.set(normalizedKey, member);
		this.members = members;
		this.membersLoadedAt = startedAt;
	}
	/**
	* Whether the rows of the table are known: loaded since the sync became trusted, or, without a
	* trusted sync, less than `bulkSync.ttl` ago.
	*/
	isTableLoaded() {
		if (this.membersLoadedAt === void 0) return false;
		const trustedSince = this.sync.trustedSince();
		if (trustedSince !== void 0 && this.membersLoadedAt >= trustedSince) return true;
		return Date.now() < this.membersLoadedAt + this.bulkSyncTtl;
	}
	/**
	* Loads the whole table, bounded by `bulkSync.timeout`. Concurrent calls share one load.
	*
	* @returns The rows loaded, by normalized key: with `maxEntries`, the cache may not hold them all.
	*/
	loadTable() {
		if (!this.tableLoad) {
			const loading = this.bulkSyncFlowControl.executeWithTimeout((signal) => this.loadRows(signal)).catch((error) => {
				libLog(this.logger, "error", this.name, "Error loading the table: ", error);
				throw error;
			}).finally(() => {
				if (this.tableLoad === loading) this.tableLoad = void 0;
			});
			this.tableLoad = loading;
		}
		return this.tableLoad;
	}
	/**
	* The keys whose entry is missing or expired (after renewing the entries still up to date). A
	* missing entry whose row was just loaded is not stale: `maxEntries` evicted it.
	*/
	staleKeys(keys, loaded) {
		const now = Date.now();
		return keys.filter((key) => {
			const normalizedKey = this.normalizeKey(key);
			this.renew(normalizedKey);
			const entry = this.store.get(normalizedKey);
			if (!entry) return !loaded?.has(normalizedKey);
			return now >= entry.expirationTime;
		});
	}
	/**
	* Fetches rows by primary key and caches them in this instance only (`null` for the keys without
	* a row). A key already being fetched shares that query.
	*
	* @returns The values read, by normalized key: with `maxEntries`, the cache may not hold them all.
	* @throws If a query fails.
	*/
	async fetchRows(keys) {
		const pending = /* @__PURE__ */ new Set();
		const toFetch = /* @__PURE__ */ new Map();
		for (const key of keys) {
			const normalizedKey = this.normalizeKey(key);
			const inFlight = this.rowFetches.get(normalizedKey);
			if (inFlight) pending.add(inFlight);
			else toFetch.set(normalizedKey, key);
		}
		if (toFetch.size > 0) {
			const fetching = this.queryRows([...toFetch.values()]);
			for (const normalizedKey of toFetch.keys()) this.rowFetches.set(normalizedKey, fetching);
			const cleanup = () => {
				for (const normalizedKey of toFetch.keys()) if (this.rowFetches.get(normalizedKey) === fetching) this.rowFetches.delete(normalizedKey);
			};
			fetching.then(cleanup, cleanup);
			pending.add(fetching);
		}
		const values = /* @__PURE__ */ new Map();
		for (const result of await Promise.all(pending)) for (const [normalizedKey, value] of result) values.set(normalizedKey, value);
		return values;
	}
	/**
	* Reads rows by primary key, bounded by `bulkSync.timeout`, and caches them (`null` for the keys
	* without a row).
	*
	* @param shared - Whether the rows also go to the shared level (and end the failure cooldown of
	* their keys), as a fetch of `getOrFetch` does.
	*/
	async queryRows(keys, shared = false) {
		const primaryKey = this.schema.primaryKey;
		try {
			return await this.bulkSyncFlowControl.executeWithTimeout(async (signal) => {
				const read = this.beginRead();
				const rows = /* @__PURE__ */ new Map();
				for (const row of await this.gate.selectFromTableByPrimaryKeys(this.schema, keys)) rows.set(this.normalizeKey(row[primaryKey]), row);
				const values = /* @__PURE__ */ new Map();
				for (const key of keys) {
					const normalizedKey = this.normalizeKey(key);
					const row = rows.get(normalizedKey) ?? null;
					values.set(normalizedKey, row);
					if (!signal.aborted) {
						const storedKey = row ? row[primaryKey] : key;
						if (shared) read.storeFetched(storedKey, row);
						else read.store(storedKey, row);
					}
				}
				return values;
			});
		} catch (error) {
			libLog(this.logger, "error", this.name, "Error fetching rows of the table: ", error);
			throw error;
		}
	}
	/**
	* The rows of these keys, leaving out the keys without a row: the fresh entry, else the value
	* read by `sources` (in order), else the expired entry.
	*/
	rowsOf(keys, ...sources) {
		const now = Date.now();
		const rows = [];
		for (const key of keys) {
			const normalizedKey = this.normalizeKey(key);
			const entry = this.store.get(normalizedKey);
			let value = entry && now < entry.expirationTime ? entry.value : void 0;
			for (const source of sources) {
				if (value !== void 0) break;
				value = source.get(normalizedKey);
			}
			value ??= entry?.value;
			if (value !== void 0 && value !== null) rows.push(value);
		}
		return rows;
	}
	memberKeys() {
		return [...this.members.values()].map((member) => member.key);
	}
	/**
	* Returns the row of the key if it is cached and up to date, otherwise `undefined`. It reads the
	* memory of this instance only, with no query: `getOrFetch` queries the database on a miss.
	*
	* @throws If the cache is disposed.
	*/
	get(key, options = {}) {
		this.assertNotDisposed();
		this.renew(this.normalizeKey(key));
		return super.get(key, options);
	}
	/**
	* Tells whether the key is cached, and whether its row is up to date or expired, with no query.
	* Like `get`, it first renews an entry the sync keeps up to date.
	*
	* @throws If the cache is disposed.
	*/
	peek(key) {
		this.assertNotDisposed();
		this.renew(this.normalizeKey(key));
		return super.peek(key);
	}
	/**
	* Returns the row of the key, from the cache or else from the database. Concurrent calls for the
	* same key share a single query.
	*
	* @param options - The read options (e.g. `staleWhileRevalidate`, `timeout`, `onError`).
	* @returns The row, or `null` if it does not exist.
	* @throws If the query fails and `onError` gives no fallback value, or if the cache is disposed.
	*/
	async getOrFetch(key, options = {}) {
		return (await this.getOrFetchDetailed(key, options)).value;
	}
	/**
	* Like {@link getOrFetch}, but also tells where the value comes from and whether the last fetch
	* failed.
	*/
	async getOrFetchDetailed(key, options = {}) {
		this.assertNotDisposed();
		const syncing = this.sync.beforeRead();
		if (syncing) await syncing;
		this.renew(this.normalizeKey(key));
		return this.getOrSetDetailed(key, () => this.gate.selectFromTableByPrimaryKey(this.schema, key), options);
	}
	/**
	* Fetches the row of the key from the database and caches it (`null` if it does not exist),
	* here and in the shared level. Concurrent calls share the query; a call made while a query is
	* running waits for one more query, which sees every change made before the call.
	* If a write that started later completes first, the fetched value is returned but not cached.
	*
	* @returns The row read from the database.
	* @throws If the query fails or exceeds `fetchTimeout`, or if the cache is disposed.
	*/
	refresh(key) {
		this.assertNotDisposed();
		return this.refreshRow(key);
	}
	refreshRow(key) {
		const normalizedKey = this.normalizeKey(key);
		let state = this.refreshes.get(normalizedKey);
		if (!state) {
			state = {};
			this.refreshes.set(normalizedKey, state);
		}
		if (state.queued) return state.queued;
		const current = state;
		const start = () => {
			const running = this.fetchRow(key);
			current.running = running;
			current.queued = void 0;
			const settle = () => {
				if (current.running === running) {
					current.running = void 0;
					if (!current.queued) this.refreshes.delete(normalizedKey);
				}
			};
			running.then(settle, settle);
			return running;
		};
		if (!current.running) return start();
		const noop = () => {};
		current.queued = current.running.then(noop, noop).then(start);
		return current.queued;
	}
	fetchRow(key) {
		return this.flowControl.executeWithTimeout(async (signal) => {
			const read = this.beginRead();
			const value = await this.gate.selectFromTableByPrimaryKey(this.schema, key);
			if (!signal.aborted) read.storeFetched(key, value);
			return value;
		});
	}
	/**
	* Re-reads a key after a notification, together with the other keys notified meanwhile: a change
	* of many rows notifies each of them, and one query per row would flood the pool. The batch is
	* sent once the notifications received together have been handled (a microtask later). The keys
	* of a failed query are expired instead.
	*
	* The query of a batch starts after the notifications of its keys: it sees their changes, even
	* when an older read of the key is still running.
	*/
	refreshInBatch(key) {
		let batch = this.eagerBatch;
		if (!batch) {
			const keys = /* @__PURE__ */ new Map();
			batch = {
				keys,
				done: new Promise((resolve) => {
					queueMicrotask(() => {
						if (this.eagerBatch?.keys === keys) this.eagerBatch = void 0;
						resolve(this.runEagerBatch(keys));
					});
				})
			};
			this.eagerBatch = batch;
		}
		const normalizedKey = this.normalizeKey(key);
		if (!batch.keys.has(normalizedKey)) {
			batch.keys.set(normalizedKey, key);
			this.eagerReads.set(normalizedKey, (this.eagerReads.get(normalizedKey) ?? 0) + 1);
		}
		return batch.done;
	}
	async runEagerBatch(keys) {
		try {
			if (!this.disposed) await this.queryRows([...keys.values()], true);
		} catch {
			if (!this.disposed) for (const key of keys.values()) this.markInvalid(key);
		} finally {
			for (const normalizedKey of keys.keys()) {
				const count = (this.eagerReads.get(normalizedKey) ?? 1) - 1;
				if (count > 0) this.eagerReads.set(normalizedKey, count);
				else this.eagerReads.delete(normalizedKey);
			}
		}
	}
	hasReadInFlight(normalizedKey) {
		return super.hasReadInFlight(normalizedKey) || this.rowFetches.has(normalizedKey) || this.refreshes.has(normalizedKey) || this.eagerReads.has(normalizedKey);
	}
	/**
	* Returns every row of the table, or the rows of `keys`.
	*
	* The whole table is loaded once (again after the sync lost changes, or, with the `none`
	* strategy, after `bulkSync.ttl`). Then only the rows the cache does not hold up to date are
	* queried, by primary key: those changed elsewhere, inserted elsewhere, or expired. When they
	* are more than a quarter of the table, the whole table is loaded instead.
	* Rows are cached in the memory of this instance only, not in the shared level. With
	* `maxEntries` smaller than the table, the result is still complete, but most rows are queried
	* again at each call.
	*
	* @throws If the rows cannot be loaded, or the cache is disposed.
	*/
	async getAll(keys) {
		this.assertNotDisposed();
		const syncing = this.sync.beforeRead();
		if (syncing) await syncing;
		if (keys) {
			const uniqueKeys = [...new Map(keys.map((key) => [this.normalizeKey(key), key])).values()];
			const fetched = await this.fetchRows(this.staleKeys(uniqueKeys));
			return this.rowsOf(uniqueKeys, fetched);
		}
		let loaded;
		if (!this.isTableLoaded()) loaded = await this.loadTable();
		let staleKeys = this.staleKeys(this.memberKeys(), loaded);
		if (staleKeys.length > this.members.size * FULL_LOAD_RATIO) {
			loaded = await this.loadTable();
			staleKeys = this.staleKeys(this.memberKeys(), loaded);
		}
		const fetched = await this.fetchRows(staleKeys);
		return this.rowsOf(this.memberKeys(), fetched, loaded ?? /* @__PURE__ */ new Map());
	}
	/**
	* The key of a notified id: the key of the cached entry or of the known row, so that it keeps
	* its original type (a notification may carry a numeric key as a string, or the other way
	* around), or else the id converted to a number when the schema declares the primary key as a
	* `number` column.
	*/
	resolveNotifiedKey(id) {
		const normalizedKey = String(id);
		const known = this.store.get(normalizedKey)?.key ?? this.members.get(normalizedKey)?.key;
		if (known !== void 0) return known;
		const { cols, primaryKey } = this.schema;
		if (typeof id === "string" && cols[primaryKey]?.type === "number") {
			const numeric = Number(id);
			if (Number.isFinite(numeric) && String(numeric) === id) return numeric;
		}
		return id;
	}
	/**
	* Caches the key as "does not exist", here and in the shared level. It also applies to protected
	* keys: they are protected from removal, not from reflecting a deleted row.
	*/
	markDeleted(key) {
		this.setValue(key, null);
	}
	/**
	* Disposes of the cache: stops its database listener and its changelog reads, removes it from
	* the singleton registry (if it was created as a singleton) and clears it. A `LISTEN` still
	* starting is awaited, so that its listener is removed too.
	*/
	async dispose() {
		if (this.disposed) return;
		this.releaseSingleton();
		await super.dispose();
		this.members.clear();
		this.ownWrites.clear();
		await this.sync.dispose();
	}
	getItemPrimaryKeyValue(item) {
		const keyValue = item[this.schema.primaryKey];
		if (keyValue === void 0) throw lilypadMissingPrimaryKeyError(this.schema, "item");
		return keyValue;
	}
	/**
	* Caches the row returned by a write of this instance, and remembers the write, so that its
	* change is not applied again when it comes back through the sync.
	* If the entry changed while the write was running (a change applied meanwhile, or a fetch that
	* may have read the row before the write), it is expired instead: the next read fetches the row.
	*
	* @param startTicket - A ticket taken before the write.
	* @param xid - The transaction of the write, if it changed a row.
	*/
	storeWritten(key, value, startTicket, xid) {
		if (this.disposed) return;
		const normalizedKey = this.normalizeKey(key);
		const entry = this.store.get(normalizedKey);
		if (entry && entry.ticket > startTicket) {
			this.markInvalid(key, { invalidateBulkSync: false });
			return;
		}
		this.setValue(key, value);
		const stored = this.store.get(normalizedKey);
		if (xid !== void 0 && stored && this.sync.seesOwnWrites) this.recordOwnWrite(normalizedKey, xid, stored.ticket);
	}
	/**
	* Inserts the item in the database and caches the row returned by the database.
	* With `generatedPrimaryKey`, the primary key of `item` can be omitted: the cached row
	* holds the one generated by the database.
	*
	* @returns The created row, or `null` if the schema's `selectSanitizationFn` discards it. A row
	* that the `selectSanitizationFn` returns without its primary key is returned, but not cached.
	* @throws If the cache is disposed.
	*/
	async sqlCreate(item) {
		this.assertNotDisposed();
		const startTicket = this.nextTicket();
		const { row, xid } = await this.gate.insertToTable(this.schema, item);
		if (row === null) return row;
		const key = row[this.schema.primaryKey];
		if (key === void 0) {
			libLog(this.logger, "warn", this.name, `The row created in "${this.schema.tableName}" has no primary key "${String(this.schema.primaryKey)}" after selectSanitizationFn: it is not cached.`);
			return row;
		}
		this.storeWritten(key, row, startTicket, xid);
		this.emitInvalidation("write", [key]);
		return row;
	}
	/**
	* Updates the item in the database and caches the row returned by the database.
	* Only the columns present in `item` are written.
	*
	* @returns The updated row, or `null` if the schema's `selectSanitizationFn` discards it.
	* @throws {LilypadDbNotFoundError} If no row with the item's primary key exists.
	* @throws If the cache is disposed.
	*/
	async sqlUpdate(item) {
		this.assertNotDisposed();
		const key = this.getItemPrimaryKeyValue(item);
		const startTicket = this.nextTicket();
		const { row, xid } = await this.gate.updateToTable(this.schema, item);
		this.storeWritten(key, row, startTicket, xid);
		this.emitInvalidation("write", [key]);
		return row;
	}
	/**
	* Deletes the row in the database, and caches the key as `null` (also for a protected key).
	*
	* @returns `true` if a row had this key, `false` if there was none (the key is cached as `null`
	* either way).
	* @throws If the cache is disposed.
	*/
	async sqlDelete(key) {
		this.assertNotDisposed();
		const startTicket = this.nextTicket();
		const { deleted, xid } = await this.gate.deleteFromTable(this.schema, key);
		this.storeWritten(key, null, startTicket, xid);
		this.emitInvalidation("write", [key]);
		return deleted;
	}
};
//#endregion
export { LILYPAD_DEFAULT_CHANGELOG_TABLE, LilypadDbCache, LilypadDbGate, LilypadDbNotFoundError, LilypadSchemaCheckError, checkLilypadSchema, lilypadChangelogPruneScheduleSql, lilypadChangelogSql, lilypadChangelogTriggerSql, lilypadServerlessPool, pruneLilypadChangelog, readLilypadChanges };

//# sourceMappingURL=db.mjs.map