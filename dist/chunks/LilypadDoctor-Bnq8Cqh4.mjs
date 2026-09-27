import { n as LilypadDisposedError } from "./LilypadCacheTypes-DuzvYfI8.mjs";
import { t as assertNumberOption } from "./LilypadValidation-ByfswRPE.mjs";
import { t as libLog } from "./LilypadLibLogger-D2eacfBb.mjs";
import { n as createLilypadSingletonAbleAsync } from "./LilypadSingleton-D729uyb5.mjs";
import { c as resolveLilypadDbTable, n as LilypadDbMissingPrimaryKeyError, o as isLilypadDbConfig, r as LilypadDbNotFoundError, t as LilypadDbEmptyWriteError } from "./LilypadDbSchema-wa5OpLfP.mjs";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
//#region src/dbGate/LilypadDbTable.ts
/** Rows read at a time by `selectAll`. */
const SELECT_ALL_BATCH_SIZE = 1e3;
/** Primary keys per query of `selectByPrimaryKeys`. */
const PRIMARY_KEYS_BATCH_SIZE = 1e3;
/** The column that carries the transaction id in the results of writes. */
const XID_COLUMN = "__lilypad_xid";
/**
* The typed CRUD helpers of one table, created with `gate.table(db.tables.users)` (or
* `gate.table('users')` on a gate created with a config): every method uses the definition of the
* table, and the connections of the gate (it rejects once the gate is closed). Queries name the
* table with its schema (`public.users`), whatever the `search_path`.
*
* - Only the `cols` keys are selected (unless there is a `selectSanitizationFn`, which gets `*`)
*   and written: extra properties of the data (e.g. from a request body) are never written.
* - Rows are mapped with the `selectSanitizationFn`, or by copying the `cols` keys.
* - Writes return the id of their transaction (`xid`), as the changelog records it.
*
* @example
* ```typescript
* const users = gate.table(db.tables.users);
* const { row } = await users.insert({ name: 'Ada' });
* const user = await users.selectByPrimaryKey(row!.id);
* ```
*/
var LilypadDbTable = class {
	constructor(gate, definition) {
		this.gate = gate;
		this.definition = definition;
	}
	get sql() {
		return this.gate.sql;
	}
	/**
	* Maps a database row to `T`, using the schema's `selectSanitizationFn` if provided,
	* otherwise by copying the schema columns.
	*/
	mapRow(row) {
		const { definition: schema } = this;
		if (schema.selectSanitizationFn) return schema.selectSanitizationFn(row);
		const typedRow = {};
		for (const key in schema.cols) typedRow[key] = row[key];
		return typedRow;
	}
	mapRows(rows, into) {
		for (const row of rows) {
			const typedRow = this.mapRow(row);
			if (typedRow !== null) into.push(typedRow);
		}
	}
	/**
	* The columns to select. The `selectSanitizationFn` receives the whole row, since it may read
	* columns that are not in the schema; otherwise only the schema columns are needed.
	*/
	selectedColumns() {
		return this.definition.selectSanitizationFn ? this.sql`*` : this.sql(Object.keys(this.definition.cols));
	}
	/** The `RETURNING` list of a write: the selected columns and the transaction id. */
	returning() {
		return this.sql`${this.selectedColumns()}, pg_current_xact_id()::text AS ${this.sql(XID_COLUMN)}`;
	}
	get tableName() {
		return this.sql(this.definition.qualifiedName);
	}
	get primaryKeyColumn() {
		return this.sql(String(this.definition.primaryKey));
	}
	/**
	* Prepares the data of an insert/update:
	* - applies the schema's `writeSanitizationFn`, whose result replaces the data;
	* - validates the primary key, which an update always needs to find the row;
	* - restricts the written columns to the schema columns, so that extra properties of `data`
	*   (e.g. coming from a request body) are never written to the table;
	* - leaves the primary key out of the `SET` of an update: it identifies the row;
	* - skips `undefined` values, which postgres.js rejects.
	*/
	prepareWrite(data, operation) {
		const { definition: schema } = this;
		const writeData = schema.writeSanitizationFn ? { ...schema.writeSanitizationFn({ ...data }) } : { ...data };
		const primaryKeyValue = writeData[schema.primaryKey];
		if ((operation === "update" || !schema.generatedPrimaryKey) && (primaryKeyValue === void 0 || primaryKeyValue === null)) throw new LilypadDbMissingPrimaryKeyError(schema, operation);
		if (schema.generatedPrimaryKey) delete writeData[schema.primaryKey];
		const columns = Object.keys(schema.cols).filter((column) => writeData[column] !== void 0 && !(operation === "update" && column === schema.primaryKey));
		if (columns.length === 0) throw new LilypadDbEmptyWriteError(schema.tableName, operation);
		return {
			data: writeData,
			columns,
			primaryKeyValue
		};
	}
	/** Splits a row returned by a write into the row and the id of its transaction. */
	writeResult(results) {
		const [returned] = results;
		if (!returned) throw new Error(`The write to table "${this.definition.tableName}" returned no row.`);
		const { [XID_COLUMN]: xid, ...row } = returned;
		return {
			row: this.mapRow(row),
			xid: BigInt(xid)
		};
	}
	/**
	* Selects every row of the table. Rows are read in batches through a cursor, so the raw result
	* of the whole table is never held in memory at once.
	*
	* @param options.signal - Stops reading (and closes the cursor) once aborted: the promise then
	* rejects with the reason of the signal.
	*/
	async selectAll(options = {}) {
		this.gate.assertOpen();
		const { signal } = options;
		signal?.throwIfAborted();
		const typedRows = [];
		const cursor = this.sql`
      SELECT ${this.selectedColumns()} FROM ${this.tableName}
    `.cursor(SELECT_ALL_BATCH_SIZE);
		for await (const rows of cursor) {
			signal?.throwIfAborted();
			this.mapRows(rows, typedRows);
		}
		return typedRows;
	}
	/**
	* Selects the rows with these primary keys, in one query per batch of 1000 keys (Postgres limits
	* the parameters of a query). Keys without a row are left out of the result, as are the rows the
	* `selectSanitizationFn` discards.
	*/
	async selectByPrimaryKeys(primaryKeyValues) {
		this.gate.assertOpen();
		const typedRows = [];
		for (let start = 0; start < primaryKeyValues.length; start += PRIMARY_KEYS_BATCH_SIZE) {
			const batch = primaryKeyValues.slice(start, start + PRIMARY_KEYS_BATCH_SIZE);
			this.mapRows(await this.sql`
          SELECT ${this.selectedColumns()} FROM ${this.tableName}
          WHERE ${this.primaryKeyColumn} IN ${this.sql(batch)}
        `, typedRows);
		}
		return typedRows;
	}
	/** Selects the row with this primary key, or `null`. */
	async selectByPrimaryKey(primaryKeyValue) {
		this.gate.assertOpen();
		const [row] = await this.sql`
      SELECT ${this.selectedColumns()} FROM ${this.tableName}
      WHERE ${this.primaryKeyColumn} = ${primaryKeyValue}
    `;
		return row ? this.mapRow(row) : null;
	}
	/**
	* Inserts a row.
	*
	* @returns The row as stored by the database, including generated columns such as an
	* auto-determined primary key (`null` if the `selectSanitizationFn` discards it), and the id of
	* the transaction that wrote it.
	* @throws {LilypadDbMissingPrimaryKeyError} Without the primary key, unless it is generated.
	* @throws {LilypadDbEmptyWriteError} If the data has no column of the schema.
	*/
	async insert(data) {
		this.gate.assertOpen();
		const { data: insertData, columns } = this.prepareWrite(data, "insert");
		return this.writeResult(await this.sql`
        INSERT INTO ${this.tableName} ${this.sql(insertData, columns)}
        RETURNING ${this.returning()}
      `);
	}
	/**
	* Updates the row identified by the primary key contained in `data`. Only the columns present
	* in `data` are written.
	*
	* @returns The row as stored by the database (`null` if the `selectSanitizationFn` discards it),
	* and the id of the transaction that wrote it.
	* @throws {LilypadDbNotFoundError} If no row with that primary key exists.
	* @throws {LilypadDbMissingPrimaryKeyError} Without the primary key.
	* @throws {LilypadDbEmptyWriteError} If the data has no other column of the schema.
	*/
	async update(data) {
		this.gate.assertOpen();
		const { data: updateData, columns, primaryKeyValue } = this.prepareWrite(data, "update");
		const results = await this.sql`
      UPDATE ${this.tableName}
      SET ${this.sql(updateData, columns)}
      WHERE ${this.primaryKeyColumn} = ${primaryKeyValue}
      RETURNING ${this.returning()}
    `;
		if (results.count === 0) throw new LilypadDbNotFoundError(this.definition.tableName, primaryKeyValue);
		return this.writeResult(results);
	}
	/**
	* Deletes the row with this primary key.
	*
	* @returns Whether a row had this primary key, and the id of the transaction that deleted it.
	*/
	async delete(primaryKeyValue) {
		this.gate.assertOpen();
		const [deleted] = await this.sql`
      DELETE FROM ${this.tableName}
      WHERE ${this.primaryKeyColumn} = ${primaryKeyValue}
      RETURNING pg_current_xact_id()::text AS ${this.sql(XID_COLUMN)}
    `;
		return deleted ? {
			deleted: true,
			xid: BigInt(deleted[XID_COLUMN])
		} : { deleted: false };
	}
};
//#endregion
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
const DEFAULT_STATEMENT_TIMEOUT = 3e4;
/** How long `close` waits for the queries still running, in ms, by default. */
const DEFAULT_CLOSE_TIMEOUT = 5e3;
const DEFAULT_LISTEN_HEARTBEAT = 15e3;
/**
* A gateway to a PostgreSQL database: typed CRUD helpers over the tables of a config (through
* {@link LilypadDbGate.table}), and channel listeners (`LISTEN/NOTIFY`) with reconnection handling.
*
* @typeParam C - The config the gate was created with, whose tables can be named.
*
* @example
* ```typescript
* const gate = await LilypadDbGate.create({
*   connectionString: 'postgres://user:pass@host:port/db',
*   config: db, // the default export of lilypad.config.ts
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
		if (options.listenHeartbeat !== false) assertNumberOption("LilypadDbGate", "listenHeartbeat", options.listenHeartbeat, "positive-delay");
		this.logger = options.logger;
		this.config = options.config;
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
	* With `singleton: '<identifier>'`, a later call with the same identifier returns the existing gate and
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
				options.listenHeartbeat,
				options.config?.name
			])).digest("hex"),
			onMismatch: () => libLog(options.logger, "warn", "LilypadDbGate", `Singleton "${options.singleton ?? ""}" already exists with different connection options or config: the new options are ignored.`)
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
	table(table) {
		return new LilypadDbTable(this, resolveLilypadDbTable("LilypadDbGate", table, this.config));
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
	/** @throws {LilypadDisposedError} If the gate is closed. */
	assertOpen() {
		if (this.closing) throw new LilypadDisposedError(`LilypadDbGate "${this.id}"`, "closed");
	}
	/**
	* Closes the connections, after the queries still running (for at most `timeout` ms; the ones
	* still running then are cancelled). Later queries and listeners are rejected. Calling it again
	* returns the same promise.
	*
	* @param options.timeout - How long to wait for the running queries, in ms. Defaults to 5 s.
	* @throws If the timeout is not valid: the gate then stays open.
	*/
	close(options = {}) {
		assertNumberOption("LilypadDbGate", "close timeout", options.timeout, "non-negative-delay");
		this.closing ??= this.closeConnections(options.timeout ?? DEFAULT_CLOSE_TIMEOUT);
		return this.closing;
	}
	/** `await using gate = ...` closes the gate at the end of the scope. */
	[Symbol.asyncDispose]() {
		return this.close();
	}
	async closeConnections(timeout) {
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
const LILYPAD_CHANGELOG_VERSION_PREFIX = "lilypad-changelog:";
/** Above this number of rows changed by one statement, the trigger sends one `BULK` notification. */
const LILYPAD_DEFAULT_NOTIFY_BULK_THRESHOLD = 1e3;
/**
* The shortest retention that {@link pruneLilypadChangelog} accepts without `force`: the default
* `maxGap` of the caches. A shorter one deletes rows that the caches may still have to read.
*/
const LILYPAD_MIN_CHANGELOG_RETENTION = 36e5;
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
* and the row trigger that versions 3 and earlier installed instead of the first three (which
* `lilypadChangelogTriggerSql` drops).
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
	assertNumberOption("lilypadChangelogSql", "notifyBulkThreshold", options.notifyBulkThreshold, "positive-integer");
	const bulkThreshold = options.notifyBulkThreshold ?? 1e3;
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
	const notifyChanged = channel === false ? "" : `
  GET DIAGNOSTICS recorded = ROW_COUNT;
  IF recorded > ${bulkThreshold} THEN
    PERFORM pg_notify(${quoteLiteral(channel)}, json_build_object(
      'schema', TG_TABLE_SCHEMA, 'table', TG_TABLE_NAME, 'op', 'BULK',
      'xid', pg_current_xact_id()::text
    )::text);
  ELSIF recorded > 0 THEN
    EXECUTE format($notify$
      SELECT pg_notify(${escapeFormat(quoteLiteral(channel))}, json_build_object(
        'schema', $1, 'table', $2, 'id', changed.row_id, 'op', changed.op,
        'xid', pg_current_xact_id()::text
      )::text) FROM (%s) AS changed
    $notify$, changed) USING TG_TABLE_SCHEMA, TG_TABLE_NAME;
  END IF;`;
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
  changed text;
  recorded bigint;
BEGIN${prune ? `
  -- ${PRUNE_MARKER} olderThan=${prune.olderThan} every=${prune.every} batchSize=${prune.batchSize}` : ""}
  IF TG_OP = 'TRUNCATE' THEN
    INSERT INTO ${quotedTable} (table_schema, table_name, row_id, op)
      VALUES (TG_TABLE_SCHEMA, TG_TABLE_NAME, NULL, 'TRUNCATE');${notify("NULL", `'TRUNCATE'`)}${pruneCall("    ")}
    RETURN NULL;
  END IF;

  IF TG_LEVEL = 'ROW' THEN
    -- A row trigger of version 3 or earlier: its changes can no longer be recorded. The write
    -- goes on (a failing write would be worse), and the schema check reports the trigger
    RAISE WARNING 'lilypad: the row trigger % on %.% is outdated, run lilypadChangelogTriggerSql', TG_NAME, TG_TABLE_SCHEMA, TG_TABLE_NAME;
    RETURN NULL;
  END IF;

  -- Every row of the statement in one query, from the transition tables. Only the primary key
  -- column is read, instead of converting whole rows to JSON.
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
    INSERT INTO ${escapeFormat(quotedTable)} (table_schema, table_name, row_id, op)
    SELECT $1, $2, changed.row_id, changed.op FROM (%s) AS changed
  $record$, changed) USING TG_TABLE_SCHEMA, TG_TABLE_NAME;${notifyChanged}${pruneCall("  ")}
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
COMMENT ON FUNCTION ${functionName}() IS ${quoteLiteral(`${LILYPAD_CHANGELOG_VERSION_PREFIX}5`)};
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
* transition tables), and one for `TRUNCATE`. It drops the row trigger of the versions 3 and
* earlier, which the trigger function no longer serves. Run it once per table, in a migration (in one transaction, so that no write goes
* unrecorded), after {@link lilypadChangelogSql}.
*
* Transition tables are not supported on the partitions of a partitioned table, nor on tables with
* inheritance children: attach the triggers to the partitioned table itself.
*
* @param options.table - The cached table (`table` or `schema.table`).
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
* qualified), so a table of the same name in another schema is not mixed up with it.
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
        AND c.table_schema = targets.schema_name
        AND (c.xid >= targets.since_xmax OR c.xid = ANY(targets.since_xip))
      UNION ALL
      SELECT c.id, c.xid, c.row_id, c.op FROM ${changelogTable} c
      WHERE targets.since_xmax IS NULL
        AND c.table_name = targets.rel_name
        AND c.table_schema = targets.schema_name
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
* Deletes the changelog rows older than `olderThan` milliseconds, in batches of `batchSize` rows
* (one statement each, so that no statement locks or rewrites the whole table). Call it
* periodically (e.g. from a scheduled job): `olderThan` must be much larger than the `maxGap` and
* the `lookback` of the caches, and than the longest transaction.
*
* @param options.olderThan - The retention, in **milliseconds**. Below one hour it throws, unless
* `force` is set: a shorter retention deletes rows that the caches may still have to read, and
* they would miss these changes without knowing it.
* @param options.batchSize - The most rows one statement deletes. Defaults to 10000.
* @returns The number of deleted rows.
*/
async function pruneLilypadChangelog(gate, options) {
	const owner = "pruneLilypadChangelog";
	assertNumberOption(owner, "olderThan", options.olderThan, "non-negative");
	assertNumberOption(owner, "batchSize", options.batchSize, "positive-integer");
	if (options.olderThan < 36e5 && !options.force) throw new Error(`${owner}: olderThan is ${options.olderThan} ms, less than one hour: the caches may still need these rows (it is in milliseconds). Pass force: true to prune them anyway.`);
	const changelogTable = gate.sql(options.changelogTable ?? "lilypad_cache_changes");
	const batchSize = options.batchSize ?? 1e4;
	let deleted = 0;
	while (true) {
		const result = await gate.sql`
      DELETE FROM ${changelogTable} WHERE id IN (
        SELECT id FROM ${changelogTable}
        WHERE changed_at < clock_timestamp() - make_interval(secs => ${options.olderThan / 1e3})
        ORDER BY changed_at
        LIMIT ${batchSize}
      )
    `;
		deleted += result.count;
		if (result.count < batchSize) return deleted;
	}
}
//#endregion
//#region src/dbConfig/loadLilypadDbConfig.ts
/** The extensions of the config files, in the order they are looked for. */
const EXTENSIONS = [
	"ts",
	"mts",
	"mjs",
	"js"
];
const CONFIG_NAME = /^[A-Za-z0-9_-]+$/;
/**
* The file names of a config: `lilypad.config.<ext>` for the default one, `lilypad.<name>.config.<ext>`
* for the others.
*/
function lilypadDbConfigFileNames(name) {
	const base = name === "default" ? "lilypad.config" : `lilypad.${name}.config`;
	return EXTENSIONS.map((extension) => `${base}.${extension}`);
}
/**
* The file of a config: `config` is the name of a config (`default` when absent), looked for in
* `cwd`, or the path of a file.
*
* @throws If there is no such file.
*/
function findLilypadDbConfig(config, cwd) {
	const reference = config ?? "default";
	if (!CONFIG_NAME.test(reference)) {
		const path = isAbsolute(reference) ? reference : resolve(cwd, reference);
		if (!existsSync(path)) throw new Error(`The config file ${path} does not exist.`);
		return path;
	}
	const candidates = lilypadDbConfigFileNames(reference);
	const found = candidates.map((file) => resolve(cwd, file)).find((path) => existsSync(path));
	if (!found) throw new Error(`No config "${reference}" in ${cwd}: expected one of ${candidates.join(", ")}.`);
	return found;
}
/**
* Loads a config file: its default export (or its `config` export) must be a config made with
* `defineLilypadDb`. A config found by name must have that name.
*
* A TypeScript config is loaded by Node.js itself (type stripping: Node.js 22.18 or later, or
* `--experimental-strip-types`): it may use only erasable syntax, and its relative imports need
* their extension (`./tables/users.ts`). Otherwise, write it as `.mjs`.
*
* @param options.config - The name of the config (`default` when absent), or the path of its file.
* @param options.cwd - Where the config files are looked for. Defaults to the working directory.
* @throws If the file does not exist, cannot be loaded, or exports no config.
*/
async function loadLilypadDbConfig(options = {}) {
	const path = findLilypadDbConfig(options.config, options.cwd ?? process.cwd());
	let module;
	try {
		module = await import(pathToFileURL(path).href);
	} catch (error) {
		if (error.code === "ERR_UNKNOWN_FILE_EXTENSION") throw new Error(`Node.js ${process.version} cannot load the TypeScript config ${path}: use Node.js 22.18 or later, run it with NODE_OPTIONS=--experimental-strip-types, or write the config as .mjs.`, { cause: error });
		throw new Error(`Could not load the config ${path}: ${String(error)}`, { cause: error });
	}
	const config = [module.default, module.config].find(isLilypadDbConfig);
	if (!config) throw new Error(`The config ${path} must export a config made with defineLilypadDb (export default defineLilypadDb({ ... })).`);
	const expected = options.config ?? "default";
	if (CONFIG_NAME.test(expected) && config.name !== expected) throw new Error(`The config ${path} is named "${config.name}", but it was looked for as "${expected}": set name: '${expected}' in defineLilypadDb, or rename the file.`);
	return {
		path,
		config
	};
}
//#endregion
//#region src/dbGate/LilypadSchemaFacts.ts
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
/**
* The changelog whose facts are read, and whose SQL the fixes install: the checked one, or else
* `changelogTable` (the default table without it), whose facts only tell the fixes what is installed.
*/
function readChangelogTarget(options) {
	return changelogTarget(options) ?? changelogTarget({
		tables: [],
		changelog: { table: options.changelogTable }
	});
}
async function readDatabaseFacts(gate, options) {
	const sql = gate.sql;
	const changelog = readChangelogTarget(options);
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
	let oldestRowAge = null;
	let jobs = null;
	if (options.changelog !== false && options.changelog?.checkPruning !== false) {
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
		}
	};
}
/**
* For each table of the options, in order, its schema, its triggers, and, when its shape is checked,
* its columns, constraints and indexes: one query for all.
*/
async function readTableFacts(gate, options) {
	const sql = gate.sql;
	const changelog = readChangelogTarget(options);
	const tableRefs = options.tables.map(({ table }) => quoteIdentifier(table));
	const shapeColumns = options.tables.some((table) => table.shape !== void 0) ? sql`,
      (
        SELECT coalesce(json_agg(json_build_object(
          'name', a.attname,
          'type', format_type(a.atttypid, a.atttypmod),
          'category', ty.typcategory,
          'notNull', a.attnotnull,
          'hasDefault', a.atthasdef,
          'identity', a.attidentity <> '',
          'generated', a.attgenerated <> ''
        ) ORDER BY a.attnum), '[]'::json)
        FROM pg_attribute a JOIN pg_type ty ON ty.oid = a.atttypid
        WHERE a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
      ) AS columns,
      (
        SELECT coalesce(json_agg(json_build_object(
          'name', con.conname,
          'type', con.contype,
          'columns', (
            SELECT coalesce(json_agg(a.attname ORDER BY k.ord), '[]'::json)
            FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
          ),
          'referencedTable', (
            SELECT rn.nspname || '.' || rc.relname
            FROM pg_class rc JOIN pg_namespace rn ON rn.oid = rc.relnamespace
            WHERE rc.oid = con.confrelid
          ),
          'referencedColumns', (
            SELECT coalesce(json_agg(a.attname ORDER BY k.ord), '[]'::json)
            FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
          ),
          'onDelete', con.confdeltype,
          'onUpdate', con.confupdtype
        )), '[]'::json)
        FROM pg_constraint con
        WHERE con.conrelid = t.oid AND con.contype IN ('p', 'u', 'f', 'c')
      ) AS constraints,
      (
        SELECT coalesce(json_agg(json_build_object(
          'name', ic.relname,
          'unique', ix.indisunique,
          'primary', ix.indisprimary,
          'method', am.amname,
          -- The key columns only (not INCLUDE), NULL for an expression
          'columns', (
            SELECT coalesce(json_agg(a.attname ORDER BY k.ord), '[]'::json)
            FROM unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
            LEFT JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
            WHERE k.ord <= ix.indnkeyatts
          ),
          'partial', ix.indpred IS NOT NULL,
          'expressions', ix.indexprs IS NOT NULL,
          'constraint', EXISTS (
            SELECT 1 FROM pg_constraint ic_con
            WHERE ic_con.conindid = ix.indexrelid AND ic_con.conrelid = ix.indrelid
          )
        )), '[]'::json)
        FROM pg_index ix
        JOIN pg_class ic ON ic.oid = ix.indexrelid
        JOIN pg_am am ON am.oid = ic.relam
        WHERE ix.indrelid = t.oid
      ) AS indexes` : sql``;
	const found = tableRefs.length === 0 ? [] : await sql`
    SELECT
      requested.position,
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
      ${shapeColumns}
    FROM unnest(${textArrayLiteral(tableRefs)}::text[]) WITH ORDINALITY AS requested(ref, position)
    JOIN pg_class t ON t.oid = to_regclass(requested.ref)
    JOIN pg_namespace n ON n.oid = t.relnamespace
  `;
	const byPosition = new Map(found.map((row) => [Number(row.position), row]));
	return options.tables.map((table, index) => {
		const row = byPosition.get(index + 1);
		if (!row) return {
			schema: null,
			triggers: []
		};
		const facts = {
			schema: row.schema_name,
			triggers: parseJsonColumn(row.triggers)
		};
		if (table.shape !== void 0) {
			facts.columns = parseJsonColumn(row.columns);
			facts.constraints = parseJsonColumn(row.constraints);
			facts.indexes = parseJsonColumn(row.indexes);
		}
		return facts;
	});
}
/**
* Reads from the catalogs what {@link evaluateLilypadSchema} needs. It changes nothing.
*
* @throws If the catalogs cannot be read (e.g. the database is unreachable).
*/
async function readLilypadSchemaFacts(gate, options) {
	const [database, tables] = await Promise.all([readDatabaseFacts(gate, options), readTableFacts(gate, options)]);
	return {
		...database,
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
//#endregion
//#region src/dbGate/LilypadSchemaPruning.ts
/**
* How the changelog is pruned: the `prune` option of its trigger and the pg_cron jobs that delete
* from it, their retention, and the best pruning to suggest when none is found. `lilypad-doctor`
* checks it whenever a table of the config reads the changelog.
*/
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
		const suggestion = suggestPruning(facts, changelog, recommended, changelogSql, options?.pruning ?? "detect");
		const inactive = cronJobs.find((job) => !job.active);
		problems.push({
			code: "no-changelog-pruning",
			severity: "warning",
			message: `Nothing deletes the old rows of the changelog "${changelog.table}"` + (age !== null && age > DAY ? ` (the oldest is ${formatDuration(age)} old)` : "") + `: it grows with every change. ` + (inactive ? `The pg_cron job "${inactive.name ?? inactive.id ?? ""}" deletes them, but is inactive. ` : "") + `${suggestion.message} If a job of your own deletes them (e.g. pruneLilypadChangelog from a scheduled function), set pruning: 'external'.` + (options?.pruning === "trigger" || options?.pruning === "cron" ? "" : ` To choose the suggested pruning, set pruning: 'trigger' or 'cron'.`),
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
* `pruning: 'trigger'` or `'cron'` asks for one of them whatever the database.
*/
function suggestPruning(facts, changelog, olderThan, changelogSql, pruning) {
	const { cron } = facts;
	const retention = formatDuration(olderThan);
	const trigger = `The fix makes the changelog trigger delete the rows older than ${retention} as it records changes (the prune option of lilypadChangelogSql).`;
	if (pruning === "trigger") {
		const prune = { olderThan };
		return {
			message: trigger,
			fix: changelogSql(prune),
			prune
		};
	}
	if (cron.installed || cron.database === facts.database) return {
		message: cron.installed ? `pg_cron is installed, with no job of this role that deletes them (the jobs of the other roles are not visible): the fix schedules a daily one, which deletes the rows older than ${retention}.` : `pg_cron runs in this database: the fix installs it and schedules a daily job that deletes the rows older than ${retention}.`,
		fix: (cron.installed ? "" : "CREATE EXTENSION IF NOT EXISTS pg_cron;\n") + lilypadChangelogPruneScheduleSql({
			olderThan,
			changelogTable: changelog.custom
		})
	};
	const qualified = changelog.table.includes(".");
	const schema = qualified ? void 0 : facts.changelog.schema;
	if (cron.database !== null && (schema || qualified || pruning === "cron")) return {
		message: `pg_cron runs in the database "${cron.database}": the fix, to run there, schedules a daily job that deletes the rows older than ${retention} in this one.` + (schema || qualified ? "" : ` Qualify the changelog table with its schema if it is not on the search_path of the role of the job.`) + (pruning === "cron" ? "" : ` If you cannot run SQL there (e.g. on a managed host), make the changelog trigger delete them as it records changes, from this database: lilypadChangelogSql({ prune: { olderThan: ${olderThan} } }).`),
		fix: `-- Run in the database "${cron.database}", where pg_cron runs:\nCREATE EXTENSION IF NOT EXISTS pg_cron;
` + lilypadChangelogPruneScheduleSql({
			olderThan,
			changelogTable: schema ? `${schema}.${changelog.table}` : changelog.table,
			database: facts.database
		})
	};
	if (pruning === "cron") {
		const table = qualified ? changelog.table : `${schema ?? "<schema>"}.${changelog.table}`;
		return {
			message: `The fix installs pg_cron and schedules a daily job that deletes the rows older than ${retention}.` + (cron.available ? "" : " pg_cron is not available on this server yet.") + ` pg_cron runs in the one database set by cron.database_name, which must be this one, "${facts.database}" (on a managed host such as Neon, set it in the settings of the host first). If it is another one, schedule the job from there instead: lilypadChangelogPruneScheduleSql({ olderThan: ${olderThan}, changelogTable: '${table}', database: '${facts.database}' }).`,
			fix: "CREATE EXTENSION IF NOT EXISTS pg_cron;\n" + lilypadChangelogPruneScheduleSql({
				olderThan,
				changelogTable: changelog.custom
			})
		};
	}
	const prune = { olderThan };
	return {
		message: trigger + (cron.available ? ` pg_cron is available on this server: if it is enabled (shared_preload_libraries), a pg_cron job keeps the deletions out of the writes: lilypadChangelogPruneScheduleSql({ olderThan: ${olderThan} }).` : ""),
		fix: changelogSql(prune),
		prune
	};
}
//#endregion
//#region src/dbGate/LilypadSchemaShape.ts
const TYPE_ALIASES = {
	int: "integer",
	int4: "integer",
	serial: "integer",
	serial4: "integer",
	int2: "smallint",
	smallserial: "smallint",
	serial2: "smallint",
	int8: "bigint",
	bigserial: "bigint",
	serial8: "bigint",
	float4: "real",
	float8: "double precision",
	float: "double precision",
	bool: "boolean",
	varchar: "character varying",
	char: "character",
	bpchar: "character",
	decimal: "numeric",
	timestamptz: "timestamp with time zone",
	timetz: "time with time zone",
	varbit: "bit varying"
};
const SERIAL_TYPES = /* @__PURE__ */ new Set([
	"serial",
	"serial4",
	"smallserial",
	"serial2",
	"bigserial",
	"serial8"
]);
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
	const resolved = TYPE_ALIASES[name] ?? name;
	if (resolved === "character" && !args) return `character(1)${arrays}`;
	const zone = /^(timestamp|time) (with|without) time zone$/.exec(resolved);
	if (zone) return `${zone[1]}${args} ${zone[2]} time zone${arrays}`;
	return `${resolved}${args}${rest ? ` ${rest}` : ""}${arrays}`;
}
/** Whether a declared type names the installed one (`format_type` qualifies the types of schemas off the `search_path`). */
function sameType(declared, installed) {
	const expected = normalizeLilypadPgType(declared);
	const actual = normalizeLilypadPgType(installed);
	return actual === expected || actual.endsWith(`.${expected}`) || expected.endsWith(`.${actual}`);
}
const TIME_TYPES = /^time(\(\d+\))? with(out)? time zone$/;
/**
* Whether a column of this type is read by postgres.js as the declared `type`, or `undefined` if it
* fits; otherwise, why not.
*/
function typeMismatch(type, column) {
	const installed = normalizeLilypadPgType(column.type);
	const base = installed.replace(/\(.*$/, "");
	switch (type) {
		case "string": return [
			"S",
			"E",
			"I",
			"V",
			"T"
		].includes(column.category) || [
			"uuid",
			"xml",
			"numeric",
			"bigint"
		].includes(base) || TIME_TYPES.test(installed) ? void 0 : "postgres.js does not return it as a string";
		case "number":
			if (base === "bigint" || base === "numeric") return "postgres.js returns it as a string: declare the column as `bigint` or `string`";
			return column.category === "N" ? void 0 : "it is not a numeric type";
		case "bigint": return base === "bigint" || base === "numeric" ? void 0 : "it is not a bigint";
		case "boolean": return column.category === "B" ? void 0 : "it is not a boolean";
		case "date": return column.category === "D" && !TIME_TYPES.test(installed) ? void 0 : "postgres.js does not return it as a Date";
		case "json": return base === "json" || base === "jsonb" ? void 0 : "it is not json or jsonb";
		case "array": return column.category === "A" ? void 0 : "it is not an array";
	}
}
const ACTION_NAMES = Object.fromEntries(Object.entries({
	"no action": "a",
	restrict: "r",
	cascade: "c",
	"set null": "n",
	"set default": "d"
}).map(([name, code]) => [code, name]));
function columnList(columns) {
	return columns.map((column) => column === null ? "<expression>" : column).join(", ");
}
function quotedColumns(columns) {
	return columns.map(quoteIdentifier).join(", ");
}
function sameSet(a, b) {
	return a.length === b.length && a.every((value) => b.includes(value));
}
function sameList(a, b) {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}
/** Whether a declared column has a generating default: `default`, a serial type, or the generated primary key. */
function expectsDefault(name, column, shape, primaryKey) {
	return column.default !== void 0 || column.pgType !== void 0 && SERIAL_TYPES.has(column.pgType.trim().toLowerCase()) || shape.generatedPrimaryKey === true && name === primaryKey;
}
/** The SQL of a column, for `CREATE TABLE` and `ADD COLUMN` (its type must be known). */
function columnSql(name, column, shape, primaryKey) {
	const parts = [quoteIdentifier(name), column.pgType];
	const normalized = normalizeLilypadPgType(column.pgType);
	if (shape.generatedPrimaryKey === true && name === primaryKey && typeof column.default !== "object" && !SERIAL_TYPES.has(column.pgType.trim().toLowerCase()) && [
		"integer",
		"smallint",
		"bigint"
	].includes(normalized)) parts.push("GENERATED BY DEFAULT AS IDENTITY");
	if (column.nullable === false || name === primaryKey) parts.push("NOT NULL");
	if (typeof column.default === "object") parts.push(`DEFAULT ${column.default.sql}`);
	return parts.join(" ");
}
function foreignKeySql(table, foreignKey) {
	const name = foreignKey.name ? `CONSTRAINT ${quoteIdentifier(foreignKey.name)} ` : "";
	return `ALTER TABLE ${quoteIdentifier(table)} ADD ${name}FOREIGN KEY (${quotedColumns(foreignKey.columns)}) REFERENCES ${quoteIdentifier(foreignKey.references.table)} (${quotedColumns(foreignKey.references.columns)}) ON DELETE ${foreignKey.onDelete.toUpperCase()} ON UPDATE ${foreignKey.onUpdate.toUpperCase()};`;
}
function indexSql(table, index) {
	const name = index.name ? `${quoteIdentifier(index.name)} ` : "";
	const using = index.using === "btree" ? "" : ` USING ${index.using}`;
	return `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${name}ON ${quoteIdentifier(table)}${using} (${quotedColumns(index.columns)});`;
}
function uniqueSql(table, uniqueKey) {
	const name = uniqueKey.name ? `CONSTRAINT ${quoteIdentifier(uniqueKey.name)} ` : "";
	return `ALTER TABLE ${quoteIdentifier(table)} ADD ${name}UNIQUE (${quotedColumns(uniqueKey.columns)});`;
}
function checkSql(table, check) {
	return `ALTER TABLE ${quoteIdentifier(table)} ADD CONSTRAINT ${quoteIdentifier(check.name)} CHECK (${check.expression});`;
}
function describeForeignKey(foreignKey) {
	return `(${foreignKey.columns.join(", ")}) → ${foreignKey.references.table} (${foreignKey.references.columns.join(", ")})`;
}
/**
* The SQL that creates a missing table, with its keys, checks and indexes (its foreign keys are
* separate problems), or `undefined` if the type of a column is unknown.
*/
function lilypadCreateTableSql(table, primaryKey, shape) {
	const columns = Object.entries(shape.cols);
	if (columns.some(([, column]) => column.pgType === void 0)) return;
	const lines = columns.map(([name, column]) => columnSql(name, column, shape, primaryKey));
	lines.push(`PRIMARY KEY (${quoteIdentifier(primaryKey)})`);
	for (const uniqueKey of shape.unique) {
		const name = uniqueKey.name ? `CONSTRAINT ${quoteIdentifier(uniqueKey.name)} ` : "";
		lines.push(`${name}UNIQUE (${quotedColumns(uniqueKey.columns)})`);
	}
	for (const check of shape.checks) if (check.expression !== void 0) lines.push(`CONSTRAINT ${quoteIdentifier(check.name)} CHECK (${check.expression})`);
	return [`CREATE TABLE ${quoteIdentifier(table)} (\n  ${lines.join(",\n  ")}\n);`, ...shape.indexes.map((index) => indexSql(table, index))].join("\n");
}
/** The problems of the foreign keys of a table that does not exist yet: each one is missing. */
function lilypadMissingTableForeignKeys(table, shape) {
	return shape.foreignKeys.map((foreignKey) => ({
		code: "missing-foreign-key",
		severity: "error",
		table,
		message: `The foreign key ${describeForeignKey(foreignKey)} of "${table}" does not exist.`,
		fix: foreignKeySql(table, foreignKey)
	}));
}
/**
* The differences between the shape of a table and what the database has. It is pure.
*
* @param table - The table, as the check names it (`schema.table`).
*/
function evaluateLilypadTableShape(table, primaryKey, shape, facts) {
	const problems = [];
	const deferred = [];
	const columns = facts.columns ?? [];
	const constraints = facts.constraints ?? [];
	const indexes = facts.indexes ?? [];
	const byName = new Map(columns.map((column) => [column.name, column]));
	const quotedTable = quoteIdentifier(table);
	const push = (code, severity, message, fix) => {
		problems.push({
			code,
			severity,
			table,
			message,
			...fix !== void 0 && { fix }
		});
	};
	for (const [name, column] of Object.entries(shape.cols)) {
		const installed = byName.get(name);
		if (!installed) {
			push("missing-column", "error", `The column "${name}" of "${table}" does not exist.`, column.pgType === void 0 ? void 0 : `ALTER TABLE ${quotedTable} ADD COLUMN ${columnSql(name, column, shape, primaryKey)};`);
			continue;
		}
		if (column.pgType !== void 0) {
			if (!sameType(column.pgType, installed.type)) push("column-type-mismatch", "error", `The column "${name}" of "${table}" is ${installed.type}, not ${normalizeLilypadPgType(column.pgType)}.`, `ALTER TABLE ${quotedTable} ALTER COLUMN ${quoteIdentifier(name)} TYPE ${column.pgType};`);
		} else if (column.type !== void 0) {
			const mismatch = typeMismatch(column.type, installed);
			if (mismatch) push("column-type-mismatch", "warning", `The column "${name}" of "${table}" is ${installed.type}, declared as ${column.type}: ${mismatch}.`);
		}
		if (column.nullable === false && !installed.notNull) push("column-nullability-mismatch", "error", `The column "${name}" of "${table}" accepts NULL, but is declared not nullable.`, `ALTER TABLE ${quotedTable} ALTER COLUMN ${quoteIdentifier(name)} SET NOT NULL;`);
		else if (column.nullable === true && installed.notNull) push("column-nullability-mismatch", "error", `The column "${name}" of "${table}" is NOT NULL, but is declared nullable.`, name === primaryKey ? void 0 : `ALTER TABLE ${quotedTable} ALTER COLUMN ${quoteIdentifier(name)} DROP NOT NULL;`);
		if (expectsDefault(name, column, shape, primaryKey) && !installed.hasDefault && !installed.identity && !installed.generated) push("missing-column-default", "error", shape.generatedPrimaryKey === true && name === primaryKey ? `The primary key "${name}" of "${table}" is declared generated (generatedPrimaryKey), but the database does not generate it.` : `The column "${name}" of "${table}" has no default.`, typeof column.default === "object" ? `ALTER TABLE ${quotedTable} ALTER COLUMN ${quoteIdentifier(name)} SET DEFAULT ${column.default.sql};` : void 0);
	}
	for (const column of columns) {
		if (Object.hasOwn(shape.cols, column.name)) continue;
		if (column.notNull && !column.hasDefault && !column.identity && !column.generated) push("undeclared-required-column", "warning", `The column "${column.name}" of "${table}" is NOT NULL without a default, and is not in \`cols\`: inserts through the library fail.`);
		else if (shape.strict) push("undeclared-column", "warning", `The column "${column.name}" (${column.type}) of "${table}" is not in \`cols\`.`);
	}
	const primary = constraints.find((constraint) => constraint.type === "p");
	const isUsableUnique = (index) => index.unique && !index.partial && !index.expressions;
	if (!primary || !sameList(primary.columns, [primaryKey])) {
		const uniqueOnKey = indexes.some((index) => isUsableUnique(index) && sameList(index.columns, [primaryKey]));
		const notNull = byName.get(primaryKey)?.notNull ?? false;
		const found = primary ? `its primary key is (${primary.columns.join(", ")})` : "it has no primary key";
		if (uniqueOnKey && notNull) push("wrong-primary-key", "warning", `The key "${primaryKey}" of "${table}" is unique and NOT NULL, but ${found}.`);
		else if (byName.has(primaryKey)) push("wrong-primary-key", "error", `The key "${primaryKey}" of "${table}" is not unique: ${found}.`, primary ? void 0 : `ALTER TABLE ${quotedTable} ADD PRIMARY KEY (${quoteIdentifier(primaryKey)});`);
	}
	const uniqueSets = [...constraints.filter((constraint) => constraint.type === "p" || constraint.type === "u").map((constraint) => constraint.columns), ...indexes.filter(isUsableUnique).map((index) => index.columns)];
	for (const uniqueKey of shape.unique) if (!uniqueSets.some((columns) => sameSet(columns, uniqueKey.columns))) push("missing-unique-key", "error", `The columns (${uniqueKey.columns.join(", ")}) of "${table}" are not unique together: no unique constraint or index covers exactly them.`, uniqueSql(table, uniqueKey));
	const foreignConstraints = constraints.filter((constraint) => constraint.type === "f");
	const pairs = (columns, referenced) => columns.map((column, index) => `${column}\u0000${referenced[index] ?? ""}`);
	const matchesForeignKey = (constraint, foreignKey) => constraint.referencedTable === foreignKey.references.table && sameSet(pairs(constraint.columns, constraint.referencedColumns), pairs(foreignKey.columns, foreignKey.references.columns));
	const matchedConstraints = /* @__PURE__ */ new Set();
	for (const foreignKey of shape.foreignKeys) {
		const installed = foreignConstraints.find((constraint) => matchesForeignKey(constraint, foreignKey));
		if (!installed) {
			deferred.push({
				code: "missing-foreign-key",
				severity: "error",
				table,
				message: `The foreign key ${describeForeignKey(foreignKey)} of "${table}" does not exist.`,
				fix: foreignKeySql(table, foreignKey)
			});
			continue;
		}
		matchedConstraints.add(installed);
		const onDelete = ACTION_NAMES[installed.onDelete] ?? installed.onDelete;
		const onUpdate = ACTION_NAMES[installed.onUpdate] ?? installed.onUpdate;
		if (onDelete !== foreignKey.onDelete || onUpdate !== foreignKey.onUpdate) push("foreign-key-mismatch", "error", `The foreign key ${describeForeignKey(foreignKey)} of "${table}" is ON DELETE ${onDelete.toUpperCase()} ON UPDATE ${onUpdate.toUpperCase()}, not ON DELETE ${foreignKey.onDelete.toUpperCase()} ON UPDATE ${foreignKey.onUpdate.toUpperCase()}.`, `ALTER TABLE ${quotedTable} DROP CONSTRAINT ${quoteIdentifier(installed.name)};\n` + foreignKeySql(table, {
			...foreignKey,
			name: foreignKey.name ?? installed.name
		}));
	}
	const usableIndexes = indexes.filter((index) => !index.partial && !index.expressions);
	const matchedIndexes = /* @__PURE__ */ new Set();
	for (const declared of shape.indexes) {
		const installed = usableIndexes.find((index) => sameList(index.columns, declared.columns) && index.method === declared.using && (!declared.unique || index.unique));
		if (installed) matchedIndexes.add(installed);
		else push("missing-index", declared.unique ? "error" : "warning", `${declared.unique ? "The unique" : "The"} ${declared.using} index on (${declared.columns.join(", ")}) of "${table}" does not exist.`, indexSql(table, declared));
	}
	for (const check of shape.checks) if (!constraints.some((constraint) => constraint.type === "c" && constraint.name === check.name)) push("missing-check", "error", `The check "${check.name}" of "${table}" does not exist.`, check.expression === void 0 ? void 0 : checkSql(table, check));
	if (shape.strict) {
		for (const constraint of constraints) if (!(constraint.type === "p" || constraint.type === "f" && matchedConstraints.has(constraint) || constraint.type === "u" && (shape.unique.some((key) => sameSet(key.columns, constraint.columns)) || shape.indexes.some((index) => index.unique && sameSet(index.columns, constraint.columns))) || constraint.type === "c" && shape.checks.some((check) => check.name === constraint.name))) push("undeclared-constraint", "warning", `The ${constraint.type === "f" ? `foreign key (${constraint.columns.join(", ")}) → ${constraint.referencedTable ?? "?"} (${constraint.referencedColumns.join(", ")})` : constraint.type === "u" ? `unique key (${constraint.columns.join(", ")})` : `check "${constraint.name}"`} of "${table}" is not in its description.`);
		for (const index of indexes) if (!(index.constraint || matchedIndexes.has(index) || index.unique && !index.partial && !index.expressions && shape.unique.some((key) => sameSet(key.columns, index.columns)))) push("undeclared-index", "warning", `The index "${index.name}" (${index.method}: ${columnList(index.columns)}) of "${table}" is not in its description.`);
	}
	return {
		problems,
		deferred
	};
}
//#endregion
//#region src/dbGate/LilypadSchemaCheck.ts
/**
* Thrown by `assertOk()` of a `lilypad-doctor` report when the database is not set up (the check
* found errors). Its `problems` include the warnings.
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
* The row events whose changes a trigger of the changelog function records: for a statement
* trigger, the events whose transition tables it declares under the names the function reads. A
* row trigger (installed by version 3 and earlier) records nothing: the function no longer serves
* it.
*/
function recordedEvents(trigger) {
	if (!trigger.changelog || !trigger.enabled || (trigger.type & TRIGGER_TYPE_ROW) !== 0) return 0;
	const events = trigger.type & ROW_EVENTS;
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
	const fixChangelog = readChangelogTarget(options);
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
		const pruning = options.changelog && options.changelog.checkPruning === false ? {
			problems: [],
			prune: installedPrune
		} : evaluatePruning(facts, changelog, options.changelog || void 0, sqlWith);
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
		if (hasTable && !hasSchemaColumn || hasFunction && version < 5) {
			const compatible = (!hasTable || hasSchemaColumn) && version >= 4;
			problems.push({
				code: "outdated-changelog",
				severity: compatible ? "warning" : "error",
				message: `The changelog "${changelog.table}" was installed by an older version of the library (version ${version}, expected 5)` + (compatible ? ": the caches read it, but a statement that changes many rows notifies each of them instead of sending one BULK notification." : "."),
				fix: changelogSql
			});
		}
	}
	const tables = [];
	const deferred = [];
	options.tables.forEach((requirement, index) => {
		const { table, primaryKey, shape } = requirement;
		const needsChangelog = changelog !== void 0 && requirement.changelog !== false;
		const tableChannel = requirement.notifyChannel ?? notifyChannel;
		const found = facts.tables[index];
		if (!found || found.schema === null) {
			tables.push({
				table,
				schema: null
			});
			const createTable = shape && lilypadCreateTableSql(table, primaryKey, shape);
			const triggerSql = needsChangelog || tableChannel !== false ? (needsChangelog ? "" : lilypadChangelogSql({
				table: fixChangelog.custom,
				notifyChannel: tableChannel,
				prune: installedPrune
			})) + lilypadChangelogTriggerSql({
				table,
				primaryKey,
				changelogTable: fixChangelog.custom
			}) : "";
			problems.push({
				code: "missing-table",
				severity: "error",
				table,
				message: `The table "${table}" does not exist.`,
				...createTable !== void 0 && { fix: `${createTable}\n${triggerSql}`.trimEnd() }
			});
			if (shape) deferred.push(...lilypadMissingTableForeignKeys(table, shape));
			return;
		}
		tables.push({
			table,
			schema: found.schema
		});
		const triggers = found.triggers;
		if (shape && found.columns) {
			const shapeProblems = evaluateLilypadTableShape(table, primaryKey, shape, found);
			problems.push(...shapeProblems.problems);
			deferred.push(...shapeProblems.deferred);
		}
		if (needsChangelog) {
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
				message: triggers.some((trigger) => trigger.changelog) ? `The changelog triggers of "${table}" do not record ${eventNames(ROW_EVENTS & ~recorded)}: they are missing, disabled, lack their transition tables, or are the row trigger of an older version.` : `The table "${table}" has no changelog trigger: its changes are not recorded.`,
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
		if (tableChannel !== false) {
			const notifies = new RegExp(`pg_notify\\s*\\(\\s*'${escapeRegExp(tableChannel.replace(/'/g, "''"))}'`, "i");
			const notifiedEvents = triggers.filter((trigger) => trigger.enabled && notifies.test(trigger.source)).reduce((events, trigger) => events | ((trigger.type & TRIGGER_TYPE_ROW) !== 0 ? trigger.changelog ? 0 : trigger.type & ROW_EVENTS : recordedEvents(trigger)), 0);
			const fix = lilypadChangelogSql({
				table: fixChangelog.custom,
				notifyChannel: tableChannel,
				prune: installedPrune
			}) + lilypadChangelogTriggerSql({
				table,
				primaryKey,
				changelogTable: fixChangelog.custom
			});
			if (notifiedEvents === 0) problems.push({
				code: "missing-notify-trigger",
				severity: "error",
				table,
				message: `No trigger of "${table}" sends notifications on the "${tableChannel}" channel: the cache is not told about changes made elsewhere.`,
				fix
			});
			else if (notifiedEvents !== ROW_EVENTS) problems.push({
				code: "missing-notify-trigger",
				severity: "error",
				table,
				message: `The triggers of "${table}" send notifications on the "${tableChannel}" channel only on ${eventNames(notifiedEvents)}: the cache is not told about ${eventNames(ROW_EVENTS & ~notifiedEvents)} made elsewhere.`,
				fix
			});
			else if (!triggers.some((trigger) => firesOnTruncate(trigger) && notifies.test(trigger.source))) problems.push({
				code: "missing-truncate-trigger",
				severity: "error",
				table,
				message: `No trigger of "${table}" sends a notification on the "${tableChannel}" channel for TRUNCATE: the caches would keep the removed rows.`,
				fix
			});
		}
	});
	problems.push(...deferred, ...pruningProblems);
	return {
		ok: !problems.some((problem) => problem.severity === "error"),
		problems,
		tables
	};
}
//#endregion
//#region src/dbGate/LilypadDoctor.ts
/**
* What the schema check must verify for a config: each table with its shape (columns, keys,
* indexes, checks), the changelog triggers of the `changelog` tables, the notifying triggers of the
* `listen` tables, and the changelog and its pruning when a table reads it. The retention the
* pruning must keep is the largest of `changelog.minRetention` and the `maxGap` and `lookback` of
* the `changelog` tables.
*/
function lilypadSchemaCheckOptions(config) {
	const definitions = Object.values(config.tables);
	const changelogSyncs = definitions.flatMap((definition) => definition.sync.strategy === "changelog" ? [definition.sync] : []);
	const minRetention = Math.max(config.changelog.minRetention, ...changelogSyncs.map((sync) => Math.max(sync.maxGap ?? 36e5, sync.lookback ?? 0)));
	return {
		tables: definitions.map((definition) => ({
			table: definition.qualifiedName,
			primaryKey: String(definition.primaryKey),
			changelog: definition.sync.strategy === "changelog",
			notifyChannel: definition.sync.strategy === "listen" ? config.notifyChannel : false,
			shape: definition
		})),
		changelog: changelogSyncs.length === 0 ? false : {
			table: config.changelog.table,
			pruning: config.changelog.pruning,
			minRetention,
			checkPruning: true
		},
		changelogTable: config.changelog.table,
		notifyChannel: false
	};
}
/**
* Checks the database against a config: every table (its columns, keys, indexes and checks), the
* triggers each sync strategy needs, the changelog and how it is pruned. It connects with its own
* gate (one connection), reads the catalogs only, and closes it. `npx lilypad-doctor` runs it from
* the command line, e.g. in a deployment step.
*
* @throws If the database cannot be reached.
*/
async function runLilypadDoctor(options) {
	const gate = await LilypadDbGate.create({
		connectionString: options.connectionString,
		pool: { max: 1 },
		listenHeartbeat: false
	});
	try {
		const result = await checkLilypadSchema(gate, lilypadSchemaCheckOptions(options.config));
		const subject = `lilypad-doctor (config "${options.config.name}")`;
		return {
			...result,
			config: options.config.name,
			text: result.problems.length === 0 ? `${subject}: the database is set up.` : formatLilypadSchemaProblems(subject, result.problems),
			assertOk: () => {
				if (!result.ok) throw new LilypadSchemaCheckError(subject, result.problems);
			}
		};
	} finally {
		await gate.close();
	}
}
//#endregion
export { LilypadDbGate as _, normalizeLilypadPgType as a, LilypadDbTable as b, LILYPAD_DEFAULT_NOTIFY_BULK_THRESHOLD as c, lilypadChangelogSql as d, lilypadChangelogTriggerSql as f, readLilypadChangesBatch as g, readLilypadChanges as h, checkLilypadSchema as i, LILYPAD_MIN_CHANGELOG_RETENTION as l, pruneLilypadChangelog as m, runLilypadDoctor as n, lilypadDbConfigFileNames as o, lilypadCursorCovers as p, LilypadSchemaCheckError as r, loadLilypadDbConfig as s, lilypadSchemaCheckOptions as t, lilypadChangelogPruneScheduleSql as u, lilypadServerlessPool as v, LilypadBackoff as y };

//# sourceMappingURL=LilypadDoctor-Bnq8Cqh4.mjs.map