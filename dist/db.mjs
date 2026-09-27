import { n as LilypadDisposedError } from "./chunks/LilypadCacheTypes-DuzvYfI8.mjs";
import { n as LilypadReadFlights, t as LilypadCacheEngine } from "./chunks/LilypadCacheEngine-BqEnxCi2.mjs";
import { n as runInBackground } from "./chunks/LilypadPlatform-DXDrm3ih.mjs";
import { t as assertNumberOption } from "./chunks/LilypadValidation-ByfswRPE.mjs";
import { t as LilypadFlowControl } from "./chunks/LilypadFlowControl-vVbPn-4y.mjs";
import { t as libLog } from "./chunks/LilypadLibLogger-D2eacfBb.mjs";
import { n as createLilypadSingletonAbleAsync } from "./chunks/LilypadSingleton-D729uyb5.mjs";
import { a as defineLilypadTable, c as resolveLilypadDbTable, i as defineLilypadDb, l as LILYPAD_DEFAULT_CHANGELOG_TABLE, n as LilypadDbMissingPrimaryKeyError, o as isLilypadDbConfig, r as LilypadDbNotFoundError, s as isLilypadDbTableDefinition, t as LilypadDbEmptyWriteError, u as LILYPAD_DEFAULT_DB_CONFIG_NAME } from "./chunks/LilypadDbSchema-wa5OpLfP.mjs";
import "./schema.mjs";
import { _ as LilypadDbGate, a as normalizeLilypadPgType, b as LilypadDbTable, c as LILYPAD_DEFAULT_NOTIFY_BULK_THRESHOLD, d as lilypadChangelogSql, f as lilypadChangelogTriggerSql, g as readLilypadChangesBatch, h as readLilypadChanges, i as checkLilypadSchema, l as LILYPAD_MIN_CHANGELOG_RETENTION, m as pruneLilypadChangelog, n as runLilypadDoctor, o as lilypadDbConfigFileNames, p as lilypadCursorCovers, r as LilypadSchemaCheckError, s as loadLilypadDbConfig, t as lilypadSchemaCheckOptions, u as lilypadChangelogPruneScheduleSql, v as lilypadServerlessPool, y as LilypadBackoff } from "./chunks/LilypadDoctor-Bnq8Cqh4.mjs";
//#region src/cache/dbCache/LilypadDbMembers.ts
/**
* The keys of the rows of a table, as far as a `LilypadDbCache` knows: each load of the table sets
* them, and the writes, the fetches and the changes keep them up to date, so that `getAll` returns
* every row while querying only those it does not hold up to date. They are tracked once the table
* has been loaded.
*
* Each member carries the ticket of what told it (a load, a stored value, a change): a load that
* started before a member was added or removed does not undo it.
*/
var LilypadDbMembers = class {
	constructor() {
		this.members = /* @__PURE__ */ new Map();
		this.floor = 0;
	}
	/** Whether a load completed, so that the members are tracked. */
	get tracked() {
		return this.loadedAt !== void 0;
	}
	get size() {
		return this.members.size;
	}
	/** The key of a known row, as stored (it keeps its type). */
	keyOf(normalizedKey) {
		return this.members.get(normalizedKey)?.key;
	}
	keys() {
		return [...this.members.values()].map((member) => member.key);
	}
	/**
	* Follows a value stored in the cache: a row is a member, `null` is not. A value older than
	* what the member already knows is ignored.
	*/
	follow(normalizedKey, key, isRow, ticket) {
		if (!this.tracked) return;
		const member = this.members.get(normalizedKey);
		if (member && member.ticket > ticket) return;
		if (isRow) this.members.set(normalizedKey, {
			key,
			ticket
		});
		else this.members.delete(normalizedKey);
	}
	/** Notes a row that exists in the table, without fetching it. */
	add(normalizedKey, key, ticket) {
		if (this.tracked) this.members.set(normalizedKey, {
			key,
			ticket
		});
	}
	delete(normalizedKey) {
		this.members.delete(normalizedKey);
	}
	/**
	* Replaces the members with the result of a load started with `ticket` at `startedAt`, keeping
	* what changed after the load started: rows added since, and rows deleted since.
	*
	* @param deletedSince - Whether the key was cached as deleted after the load started.
	*/
	replace(loaded, ticket, startedAt, deletedSince) {
		if (ticket < this.floor) return;
		const members = /* @__PURE__ */ new Map();
		for (const [normalizedKey, key] of loaded) {
			if (deletedSince(normalizedKey)) continue;
			const member = this.members.get(normalizedKey);
			members.set(normalizedKey, member && member.ticket > ticket ? member : {
				key,
				ticket
			});
		}
		for (const [normalizedKey, member] of this.members) if (member.ticket > ticket && !members.has(normalizedKey)) members.set(normalizedKey, member);
		this.members = members;
		this.loadedAt = startedAt;
	}
	/**
	* Forgets every member: the table was emptied, or changed too much to follow.
	*
	* @param floor - A ticket taken now: loads started before no longer tell which rows exist.
	* @param empty - The table is known to be empty; otherwise the next `getAll` loads it again.
	*/
	forget(floor, empty) {
		this.floor = floor;
		this.members.clear();
		if (!empty) this.loadedAt = void 0;
	}
	/**
	* Whether the rows of the table are known: loaded since the sync became trusted, or, without a
	* trusted sync, less than `ttl` ago.
	*/
	isLoaded(trustedSince, ttl) {
		if (this.loadedAt === void 0) return false;
		if (trustedSince !== void 0 && this.loadedAt >= trustedSince) return true;
		return Date.now() < this.loadedAt + ttl;
	}
	clear() {
		this.members.clear();
	}
};
//#endregion
//#region src/cache/dbCache/LilypadOwnWrites.ts
/** How long the writes of an instance are remembered, to recognize their changes. */
const OWN_WRITE_RETENTION = 6e5;
/**
* The writes of a `LilypadDbCache` instance, by normalized key: their transaction ids, and the
* ticket of the entry the last one stored. While the entry holds that ticket, the changes of these
* writes are already reflected in it, and coming back through the sync they need no query.
*/
var LilypadOwnWrites = class {
	constructor() {
		this.writes = /* @__PURE__ */ new Map();
	}
	/** Remembers a write of the key by transaction `xid`, whose result the entry `ticket` holds. */
	record(normalizedKey, xid, ticket) {
		const now = Date.now();
		for (const [key, own] of this.writes) {
			if (now - own.at <= OWN_WRITE_RETENTION) break;
			this.writes.delete(key);
		}
		const xids = this.writes.get(normalizedKey)?.xids ?? /* @__PURE__ */ new Set();
		xids.add(xid);
		this.writes.delete(normalizedKey);
		this.writes.set(normalizedKey, {
			ticket,
			xids,
			at: now
		});
	}
	/**
	* Whether a change of the key by transaction `xid` is a write of this instance, and the entry
	* (whose ticket is `entryTicket`) still holds the result of the last write of this instance:
	* that result is at least as recent as the change. The write is forgotten either way.
	*/
	consume(normalizedKey, xid, entryTicket) {
		const own = this.writes.get(normalizedKey);
		if (!own?.xids.delete(xid)) return false;
		if (own.xids.size === 0) this.writes.delete(normalizedKey);
		return entryTicket === own.ticket;
	}
	/** Forgets the writes whose changes a read of the changelog from this cursor no longer returns. */
	forgetCoveredBy(cursor) {
		for (const [normalizedKey, own] of this.writes) {
			for (const xid of own.xids) if (lilypadCursorCovers(cursor, xid)) own.xids.delete(xid);
			if (own.xids.size === 0) this.writes.delete(normalizedKey);
		}
	}
	clear() {
		this.writes.clear();
	}
};
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
* The changes to apply, in order: whether the table was emptied, and the last change of each row
* after the last `TRUNCATE`. The changes of a row are ordered by the lock of the row, so its last
* change says what it is now; the changes of a row made before a `TRUNCATE` no longer matter.
*/
function lilypadNetChanges(changes) {
	let truncated = false;
	const rows = /* @__PURE__ */ new Map();
	for (const change of changes) if (change.op === "TRUNCATE") {
		truncated = true;
		rows.clear();
	} else {
		rows.delete(change.rowId);
		rows.set(change.rowId, change);
	}
	return {
		truncated,
		rows
	};
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
	constructor(host, options) {
		this.host = host;
		this.options = options;
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
			const { truncated, rows } = lilypadNetChanges(changes);
			const changedKeys = /* @__PURE__ */ new Set();
			let wholeCache = truncated;
			if (truncated) for (const key of host.applyTruncate("lazy")) changedKeys.add(key);
			if (rows.size > 1e3) {
				host.applyBulkChange();
				changedKeys.clear();
				wholeCache = true;
			} else for (const change of rows.values()) changedKeys.add(await host.applyChange(change.op, change.rowId, "lazy", change.xid));
			host.forgetOwnWritesCoveredBy(cursor);
			this.cursor = cursor;
			this.lastRead = readAt;
			this.backoff.succeed();
			host.emitInvalidation("changelog", [...changedKeys], { wholeCache });
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
//#region src/cache/dbSync/LilypadNotificationRouter.ts
const OPERATIONS = /* @__PURE__ */ new Set([
	"INSERT",
	"UPDATE",
	"DELETE",
	"TRUNCATE",
	"BULK"
]);
/** The operations that concern the whole table, not one row: they carry no `id`. */
const TABLE_OPERATIONS = /* @__PURE__ */ new Set(["TRUNCATE", "BULK"]);
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
	if (!TABLE_OPERATIONS.has(op) && !(typeof id === "string" && id !== "" || typeof id === "number")) return;
	if (schema !== void 0 && typeof schema !== "string" || xid !== void 0 && typeof xid !== "string") return;
	return parsed;
}
/**
* Receives the notifications of a channel for every cache of a gate: one listener on the gate,
* one `JSON.parse` per notification, and each notification handed to the caches of its table only
* (instead of every cache parsing and filtering every notification).
*/
var LilypadNotificationRouter = class {
	constructor(gate, channel) {
		this.gate = gate;
		this.subscribers = /* @__PURE__ */ new Set();
		this.listener = {
			channel,
			callbackId: "lilypad_notification_router",
			callback: (payload) => this.dispatch(payload),
			onReconnect: () => {
				for (const subscriber of [...this.subscribers]) subscriber.onReconnect();
			}
		};
	}
	/**
	* Subscribes a cache, and resolves once the channel is listened to.
	*
	* @throws If `LISTEN` fails: the cache is then not subscribed.
	*/
	async subscribe(subscriber) {
		this.subscribers.add(subscriber);
		try {
			this.listening ??= this.gate.addListener(this.listener).catch((error) => {
				this.listening = void 0;
				throw error;
			});
			await this.listening;
		} catch (error) {
			this.subscribers.delete(subscriber);
			throw error;
		}
	}
	/** Unsubscribes a cache; the last one stops listening. It never rejects. */
	async unsubscribe(subscriber) {
		if (!this.subscribers.delete(subscriber) || this.subscribers.size > 0) return;
		const listening = this.listening;
		this.listening = void 0;
		await listening?.catch(() => {});
		if (this.subscribers.size === 0 && !this.listening) await this.gate.removeListener(this.listener.channel, this.listener.callbackId);
	}
	async dispatch(raw) {
		const subscribers = [...this.subscribers];
		if (subscribers.length === 0) return;
		const payload = parseLilypadNotification(raw);
		if (!payload) {
			subscribers[0].log("warn", "Ignoring a malformed cache_events notification:", raw);
			return;
		}
		await Promise.all(subscribers.filter((subscriber) => subscriber.table === payload.table).map(async (subscriber) => {
			try {
				await subscriber.handle(payload);
			} catch (error) {
				subscriber.log("error", "Error applying a notification:", error);
			}
		}));
	}
};
const routers = /* @__PURE__ */ new WeakMap();
/** The router shared by the caches of a gate that listen to this channel. */
function getLilypadNotificationRouter(gate, channel) {
	let gateRouters = routers.get(gate);
	if (!gateRouters) {
		gateRouters = /* @__PURE__ */ new Map();
		routers.set(gate, gateRouters);
	}
	let router = gateRouters.get(channel);
	if (!router) {
		router = new LilypadNotificationRouter(gate, channel);
		gateRouters.set(channel, router);
	}
	return router;
}
//#endregion
//#region src/cache/dbSync/LilypadListenSync.ts
function parseXid(xid) {
	return xid !== void 0 && /^\d+$/.test(xid) ? BigInt(xid) : void 0;
}
/**
* The `listen` strategy: the cache subscribes to the notification channel of its config (through
* the router shared by the caches of the gate), and applies the notifications of its table.
*
* It trusts that it sees every change while `LISTEN` is active and the gate's heartbeat is recent
* (`isListenHealthy`): a connection that stopped delivering notifications is not trusted, even
* before postgres.js re-establishes it.
*/
var LilypadListenSync = class {
	constructor(host, options) {
		this.host = host;
		this.options = options;
		this.seesOwnWrites = true;
		this.backoff = new LilypadBackoff(() => 1e3);
		this.applyChanges = options.applyChanges !== false;
		this.router = getLilypadNotificationRouter(host.gate, options.channel);
		this.subscriber = {
			table: host.tableName.split(".").pop(),
			handle: (payload) => this.handleNotification(payload),
			onReconnect: () => {
				if (host.isDisposed()) return;
				host.expireEverything();
				if (this.applyChanges) this.listenTrustedSince = Date.now();
			},
			log: (level, message, detail) => host.log(level, message, detail)
		};
	}
	start() {
		return this.options.connect === "lazy" ? Promise.resolve() : this.startListening();
	}
	/**
	* Subscribes once. A failed subscription is retried by the next call, after a backoff for the
	* lazy `LISTEN` of the reads. If the cache was disposed meanwhile, it unsubscribes again.
	*/
	startListening() {
		if (!this.listening) this.listening = this.router.subscribe(this.subscriber).then(async () => {
			if (this.host.isDisposed()) {
				await this.router.unsubscribe(this.subscriber);
				return;
			}
			this.backoff.succeed();
			if (this.applyChanges) this.listenTrustedSince = Date.now();
		}).catch((error) => {
			this.listening = void 0;
			this.backoff.fail();
			throw error;
		});
		return this.listening;
	}
	beforeRead() {
		if (this.listening || this.options.connect !== "lazy" || !this.backoff.ready(Date.now())) return;
		return this.startListening().catch((error) => {
			this.host.log("error", "Error starting LISTEN for the cache:", error);
		});
	}
	trustedSince() {
		return this.host.gate.isListenHealthy() ? this.listenTrustedSince : void 0;
	}
	async handleNotification(payload) {
		const { host } = this;
		if (host.isDisposed() || !this.isForSchema(payload)) return;
		host.log("debug", `Received a notification on the ${this.options.channel} channel:`, payload);
		if (this.applyChanges) {
			if (payload.op === "TRUNCATE") host.emitInvalidation("notification", host.applyTruncate("eager"), { wholeCache: true });
			else if (payload.op === "BULK") {
				host.applyBulkChange();
				host.emitInvalidation("notification", [], { wholeCache: true });
			} else {
				const key = await host.applyChange(payload.op, payload.id, "eager", parseXid(payload.xid));
				host.emitInvalidation("notification", [key]);
			}
		}
		await this.options.onNotification?.(payload);
	}
	/**
	* Whether a notification of the table (the router matched its name) is about the schema of this
	* cache: `schema`, when the trigger sends it, must match.
	*/
	isForSchema(payload) {
		return payload.schema === void 0 || payload.schema === this.host.tableSchema;
	}
	/** Waits for a `LISTEN` still starting, then unsubscribes. It never rejects. */
	async dispose() {
		await this.listening?.catch(() => {});
		await this.router.unsubscribe(this.subscriber);
	}
};
//#endregion
//#region src/cache/LilypadDbCache.ts
const DEFAULT_MAX_AGE = 36e5;
const DEFAULT_LOAD_TIMEOUT = 3e4;
/** Beyond this share of the rows to fetch, `getAll` loads the whole table in one query instead. */
const FULL_LOAD_RATIO = .25;
/**
* The most keys that notifications make this instance re-read per second. Anyone can send a
* notification: beyond this budget, the notified keys are only expired, and read again when the
* application asks for them, so that a flood of notifications cannot flood the database.
*/
const EAGER_REFRESHES_PER_SECOND = 1e3;
/**
* A cache of the rows of one table, kept up to date with the changes made elsewhere.
*
* Its values always come from the table: it reads rows on a miss (`getOrFetch`), loads the whole
* table once (`getAll`), and writes through to the database (`sqlCreate`, `sqlUpdate`,
* `sqlDelete`). Unlike `LilypadCache`, it has no `set` or `getOrSet`: a value that does not come
* from the table could be kept past its TTL as if it did.
*
* Every method throws a {@link LilypadDisposedError} once the cache is disposed, except `dispose`.
*
* @typeParam V - The row type.
* @typeParam PK - The primary key column; the keys of the cache are its values.
*
* @example
* ```typescript
* const users = await LilypadDbCache.create({ ttl: 60_000, gate, table: db.tables.users, logger });
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
var LilypadDbCache = class LilypadDbCache {
	static async create(options) {
		const { table, config, ...rest } = options;
		const definition = resolveLilypadDbTable("LilypadDbCache", table, config ?? options.gate.config);
		const resolved = {
			...rest,
			table: definition
		};
		return createLilypadSingletonAbleAsync("LilypadDbCache", resolved, async (release) => {
			const cache = new LilypadDbCache(resolved);
			try {
				await cache.sync.start();
			} catch (error) {
				await cache.dispose();
				throw error;
			}
			cache.releaseSingleton = release;
			return cache;
		}, {
			value: JSON.stringify([
				definition.db.name,
				definition.qualifiedName,
				options.ttl
			]),
			onMismatch: () => libLog(options.logger, "warn", "LilypadDbCache", `Singleton "${options.singleton ?? ""}" already exists with a different table or TTL: the new options are ignored.`)
		});
	}
	constructor(options) {
		this.releaseSingleton = () => {};
		this.members = new LilypadDbMembers();
		this.rowFetches = new LilypadReadFlights();
		this.eagerReads = /* @__PURE__ */ new Map();
		this.eagerWindow = {
			start: 0,
			count: 0
		};
		this.refreshes = /* @__PURE__ */ new Map();
		this.ownWrites = new LilypadOwnWrites();
		const { gate, table: definition, sync: overrides = {}, bulkSync, singleton: _singleton, ...cacheOptions } = options;
		const owner = "LilypadDbCache";
		assertNumberOption(owner, "bulkSync.ttl", bulkSync?.ttl, "non-negative");
		assertNumberOption(owner, "bulkSync.timeout", bulkSync?.timeout, "positive-delay");
		assertNumberOption(owner, "sync.maxAge", overrides.maxAge, "non-negative");
		assertNumberOption(owner, "sync.pollInterval", overrides.pollInterval, "non-negative");
		const tableSync = definition.sync;
		this.engine = new LilypadCacheEngine({
			...cacheOptions,
			name: options.name ?? definition.tableName
		}, {
			onValueStored: (entry) => this.followValue(entry),
			hasReadInFlight: (normalizedKey) => this.rowFetches.has(normalizedKey) || this.refreshes.has(normalizedKey) || this.eagerReads.has(normalizedKey)
		});
		this.table = gate.table(definition);
		this.definition = definition;
		this.loadTtl = bulkSync?.ttl ?? this.engine.defaultTtl;
		this.loadFlowControl = new LilypadFlowControl({ timeout: bulkSync?.timeout ?? DEFAULT_LOAD_TIMEOUT });
		this.numericPrimaryKey = definition.cols[definition.primaryKey]?.type === "number";
		this.maxAge = tableSync.strategy === "none" ? 0 : overrides.maxAge ?? tableSync.maxAge ?? DEFAULT_MAX_AGE;
		const host = this.syncHost(gate);
		if (tableSync.strategy === "listen") this.sync = new LilypadListenSync(host, {
			...tableSync,
			connect: overrides.connect ?? tableSync.connect,
			applyChanges: overrides.applyChanges ?? tableSync.applyChanges,
			onNotification: overrides.onNotification,
			channel: definition.db.notifyChannel
		});
		else if (tableSync.strategy === "changelog") this.sync = new LilypadChangelogSync(host, {
			...tableSync,
			pollInterval: overrides.pollInterval ?? tableSync.pollInterval,
			poll: overrides.poll ?? tableSync.poll,
			table: definition.db.changelogTable
		});
		else this.sync = lilypadNoSync;
		this.engine.log("debug", `LilypadDbCache initialized for table "${definition.qualifiedName}" (sync: ${tableSync.strategy})`);
	}
	/** A unique id of the instance. */
	get id() {
		return this.engine.id;
	}
	/** The name given in the options, or the table name. */
	get name() {
		return this.engine.name;
	}
	/** @throws {LilypadDisposedError} If the cache is disposed. */
	assertNotDisposed() {
		if (this.engine.disposed) throw new LilypadDisposedError(`LilypadCache "${this.name}"`);
	}
	/** What the sync strategy may use of this cache. */
	syncHost(gate) {
		const { engine } = this;
		return {
			id: engine.id,
			name: engine.name,
			gate,
			tableName: this.definition.qualifiedName,
			platform: engine.platform,
			log: (level, message, detail) => engine.log(level, message, detail),
			isDisposed: () => engine.disposed,
			applyChange: (op, id, mode, xid) => this.applyChange(op, id, mode, xid),
			applyTruncate: (mode) => this.applyTruncate(mode),
			applyBulkChange: () => this.forgetTable(false),
			expireEverything: () => engine.expireEverything(),
			emitInvalidation: (source, keys, options) => engine.emitInvalidation(source, keys, options),
			forgetOwnWritesCoveredBy: (cursor) => this.ownWrites.forgetCoveredBy(cursor),
			tableSchema: this.definition.schemaName,
			defaultLookback: () => this.defaultLookback()
		};
	}
	/** The default `lookback` of the changelog: the lifetime of a shared copy, plus 1 minute. */
	defaultLookback() {
		return this.engine.defaultTtl + this.engine.defaultStaleWhileRevalidate + 6e4;
	}
	/** Follows the values stored in the cache: the rows of the table, and the type of their keys. */
	followValue(entry) {
		if (!this.numericPrimaryKey && entry.value !== null && typeof entry.value[this.definition.primaryKey] === "number") this.numericPrimaryKey = true;
		if (entry.origin !== "fallback") this.members.follow(this.engine.normalizeKey(entry.key), entry.key, entry.value !== null, entry.ticket);
	}
	/**
	* Keeps, without a query, an entry that reached its TTL while it is known to be up to date: its
	* value was read from the database (or written by this instance) after the sync became trusted,
	* and any change of its row since would have expired it. It is kept until `maxAge`.
	*/
	renew(normalizedKey) {
		const entry = this.engine.store.get(normalizedKey);
		const now = Date.now();
		if (!entry || entry.origin !== "source" || entry.expirationTime === 0) return;
		if (now < entry.expirationTime) return;
		const trustedSince = this.sync.trustedSince();
		if (trustedSince === void 0 || entry.fetchedAt < trustedSince) return;
		if (now - entry.fetchedAt >= this.maxAge) return;
		this.engine.extendExpiration(normalizedKey, Math.min(now + this.engine.defaultTtl, entry.fetchedAt + this.maxAge));
	}
	/**
	* Applies a change of a row made elsewhere.
	* - A change made by a write of this instance whose result the entry still holds: nothing to do.
	* - A change of a key held (or being read) by this instance: `eager` re-fetches it at once
	*   (with the other keys notified meanwhile, in one query, within the eager budget); `lazy`
	*   expires it with no query, which also discards a read in flight (it may predate the change):
	*   the next read fetches it. A `lazy` DELETE caches the key as `null` at once.
	* - A change of any other key: no query, and no entry. The shared level entry is removed.
	* INSERT and UPDATE note the key as a row of the table, which `getAll` returns. An `eager`
	* DELETE of a key not held leaves it there: `getAll` reads it again, and learns whether it is
	* gone. A notification is thus never trusted without a query (any role can send one).
	*
	* @param xid - The transaction that made the change, when known.
	* @returns The key of the changed row.
	*/
	async applyChange(op, id, mode, xid) {
		const { engine } = this;
		const key = this.resolveNotifiedKey(id);
		const normalizedKey = engine.normalizeKey(key);
		if (xid !== void 0 && this.ownWrites.consume(normalizedKey, xid, engine.store.get(normalizedKey)?.ticket)) return key;
		const held = engine.store.has(normalizedKey) || engine.hasReadInFlight(normalizedKey);
		if (op === "DELETE" && mode === "lazy") {
			if (held) engine.set(key, null);
			else {
				this.members.delete(normalizedKey);
				engine.deleteShared(key);
			}
			return key;
		}
		if (op !== "DELETE") this.members.add(normalizedKey, key, engine.nextTicket());
		if (!held) engine.deleteShared(key);
		else if (mode === "eager" && this.takeEagerRefresh()) await this.refreshInBatch(key);
		else engine.markInvalid(key);
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
		const keys = [...this.engine.store.values()].map((entry) => entry.key);
		for (const key of keys) this.engine.deleteShared(key);
		this.forgetTable(mode === "lazy");
		return keys;
	}
	/**
	* Expires every entry, discards the reads started before, ignores the older copies of the shared
	* level, and forgets the rows of the table. It also applies a change of too many rows to follow
	* them one by one (a `BULK` notification, or a read of the changelog with too many keys).
	*
	* @param empty - The table is known to be empty (a `TRUNCATE` read from the changelog); otherwise
	* the next `getAll` loads it again.
	*/
	forgetTable(empty) {
		this.engine.expireEverything();
		this.engine.rejectSharedBefore(Date.now());
		this.members.forget(this.engine.nextTicket(), empty);
	}
	/** Takes one key of the eager budget: `false` once the budget of this second is spent. */
	takeEagerRefresh() {
		const now = Date.now();
		if (now - this.eagerWindow.start >= 1e3) this.eagerWindow = {
			start: now,
			count: 0
		};
		this.eagerWindow.count++;
		return this.eagerWindow.count <= EAGER_REFRESHES_PER_SECOND;
	}
	/**
	* Loads every row of the table and replaces the content of the cache with them.
	*
	* @returns The rows loaded, by normalized key: with `maxEntries`, the cache may not hold them all.
	*/
	async loadRows(signal) {
		const { engine } = this;
		const read = engine.beginRead();
		const primaryKey = this.definition.primaryKey;
		const rows = /* @__PURE__ */ new Map();
		const entries = [];
		for (const row of await this.table.selectAll({ signal })) {
			const key = row[primaryKey];
			rows.set(engine.normalizeKey(key), row);
			entries.push([key, row]);
		}
		if (!signal.aborted && !engine.disposed) {
			this.members.replace(entries.map(([key]) => [engine.normalizeKey(key), key]), read.ticket, read.startedAt, (normalizedKey) => {
				const entry = engine.store.get(normalizedKey);
				return entry !== void 0 && entry.ticket > read.ticket && entry.value === null && entry.origin !== "fallback";
			});
			engine.replaceEntries(read, entries);
		}
		return rows;
	}
	/**
	* Loads the whole table, bounded by `bulkSync.timeout`. Concurrent calls share one load.
	*
	* @returns The rows loaded, by normalized key: with `maxEntries`, the cache may not hold them all.
	*/
	loadTable() {
		if (!this.tableLoad) {
			const loading = this.loadFlowControl.executeWithTimeout((signal) => this.loadRows(signal)).catch((error) => {
				this.engine.log("error", "Error loading the table:", error);
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
			const normalizedKey = this.engine.normalizeKey(key);
			this.renew(normalizedKey);
			const entry = this.engine.store.get(normalizedKey);
			if (!entry) return !loaded?.has(normalizedKey);
			return now >= entry.expirationTime;
		});
	}
	/**
	* Fetches rows by primary key and caches them in this instance only (`null` for the keys without
	* a row). A key already being fetched by a query that started after its last change shares that
	* query.
	*
	* @returns The values read, by normalized key: with `maxEntries`, the cache may not hold them all.
	* @throws If a query fails.
	*/
	async fetchRows(keys) {
		const { engine } = this;
		const pending = /* @__PURE__ */ new Set();
		const toFetch = /* @__PURE__ */ new Map();
		for (const key of keys) {
			const normalizedKey = engine.normalizeKey(key);
			const joined = this.rowFetches.join(normalizedKey, engine.currentTicket(normalizedKey));
			if (joined) pending.add(joined);
			else toFetch.set(normalizedKey, key);
		}
		if (toFetch.size > 0) {
			const read = engine.beginRead();
			const fetching = this.queryRows([...toFetch.values()], read);
			this.rowFetches.start(toFetch.keys(), read.ticket, fetching);
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
	* @param read - Started before the query: its ticket orders the rows among the writes.
	* @param shared - Whether the rows also go to the shared level (and end the failure cooldown of
	* their keys), as a fetch of `getOrFetch` does.
	*/
	async queryRows(keys, read, shared = false) {
		const { engine } = this;
		const primaryKey = this.definition.primaryKey;
		try {
			return await this.loadFlowControl.executeWithTimeout(async (signal) => {
				const rows = /* @__PURE__ */ new Map();
				for (const row of await this.table.selectByPrimaryKeys(keys)) rows.set(engine.normalizeKey(row[primaryKey]), row);
				const values = /* @__PURE__ */ new Map();
				for (const key of keys) {
					const normalizedKey = engine.normalizeKey(key);
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
			engine.log("error", "Error fetching rows of the table:", error);
			throw error;
		}
	}
	/**
	* The rows of these keys, keyed as given, leaving out the keys without a row: the fresh entry,
	* else the value read by `sources` (in order), else the expired entry.
	*/
	rowsOf(keys, ...sources) {
		const now = Date.now();
		const rows = /* @__PURE__ */ new Map();
		for (const key of keys) {
			const normalizedKey = this.engine.normalizeKey(key);
			const entry = this.engine.store.get(normalizedKey);
			let value = entry && now < entry.expirationTime ? entry.value : void 0;
			for (const source of sources) {
				if (value !== void 0) break;
				value = source.get(normalizedKey);
			}
			value ??= entry?.value;
			if (value !== void 0 && value !== null) rows.set(key, value);
		}
		return rows;
	}
	/**
	* Returns the row of the key if it is cached and up to date, otherwise `undefined`. It reads the
	* memory of this instance only, with no query: `getOrFetch` queries the database on a miss.
	*/
	get(key, options) {
		this.assertNotDisposed();
		this.renew(this.engine.normalizeKey(key));
		return this.engine.get(key, options);
	}
	/**
	* Tells whether the key is cached, and whether its row is up to date or expired, with no query.
	* Like `get`, it first renews an entry the sync keeps up to date.
	*/
	peek(key) {
		this.assertNotDisposed();
		this.renew(this.engine.normalizeKey(key));
		return this.engine.peek(key);
	}
	/**
	* Returns the row of the key, from the cache or else from the database. Concurrent calls for the
	* same key share a single query.
	*
	* @param options - The read options (e.g. `staleWhileRevalidate`, `timeout`, `onError`).
	* @returns The row, or `null` if it does not exist.
	* @throws If the query fails and `onError` gives no fallback value.
	*/
	async getOrFetch(key, options) {
		return (await this.getOrFetchDetailed(key, options)).value;
	}
	/**
	* Like {@link getOrFetch}, but also tells where the value comes from and whether the last fetch
	* failed.
	*/
	async getOrFetchDetailed(key, options) {
		this.assertNotDisposed();
		const syncing = this.sync.beforeRead();
		if (syncing) await syncing;
		this.renew(this.engine.normalizeKey(key));
		return this.engine.getOrSetDetailed(key, () => this.table.selectByPrimaryKey(key), options);
	}
	/**
	* Fetches the row of the key from the database and caches it (`null` if it does not exist),
	* here and in the shared level. Concurrent calls share the query; a call made while a query is
	* running waits for one more query, which sees every change made before the call.
	* If a write that started later completes first, the fetched value is returned but not cached.
	*
	* @returns The row read from the database.
	* @throws If the query fails or exceeds `fetchTimeout`.
	*/
	refresh(key) {
		this.assertNotDisposed();
		const normalizedKey = this.engine.normalizeKey(key);
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
		return this.engine.flowControl.executeWithTimeout(async (signal) => {
			const read = this.engine.beginRead();
			const value = await this.table.selectByPrimaryKey(key);
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
		const normalizedKey = this.engine.normalizeKey(key);
		if (!batch.keys.has(normalizedKey)) {
			batch.keys.set(normalizedKey, key);
			this.eagerReads.set(normalizedKey, (this.eagerReads.get(normalizedKey) ?? 0) + 1);
		}
		return batch.done;
	}
	async runEagerBatch(keys) {
		try {
			if (!this.engine.disposed) await this.queryRows([...keys.values()], this.engine.beginRead(), true);
		} catch {
			if (!this.engine.disposed) for (const key of keys.values()) this.engine.markInvalid(key);
		} finally {
			for (const normalizedKey of keys.keys()) {
				const count = (this.eagerReads.get(normalizedKey) ?? 1) - 1;
				if (count > 0) this.eagerReads.set(normalizedKey, count);
				else this.eagerReads.delete(normalizedKey);
			}
		}
	}
	/**
	* Returns every row of the table, or the rows of `keys`, keyed by primary key (the keys without a
	* row are left out).
	*
	* The whole table is loaded once (again after the sync lost changes, or, with the `none`
	* strategy, after `bulkSync.ttl`). Then only the rows the cache does not hold up to date are
	* queried, by primary key: those changed elsewhere, inserted elsewhere, or expired. When they
	* are more than a quarter of the table, the whole table is loaded instead.
	* Rows are cached in the memory of this instance only, not in the shared level. With
	* `maxEntries` smaller than the table, the result is still complete, but most rows are queried
	* again at each call.
	*
	* @throws If the rows cannot be loaded.
	*/
	async getAll(keys) {
		this.assertNotDisposed();
		const syncing = this.sync.beforeRead();
		if (syncing) await syncing;
		if (keys) {
			const uniqueKeys = [...new Map(keys.map((key) => [this.engine.normalizeKey(key), key])).values()];
			const fetched = await this.fetchRows(this.staleKeys(uniqueKeys));
			return this.rowsOf(uniqueKeys, fetched);
		}
		let loaded;
		if (!this.members.isLoaded(this.sync.trustedSince(), this.loadTtl)) loaded = await this.loadTable();
		let staleKeys = this.staleKeys(this.members.keys(), loaded);
		if (staleKeys.length > this.members.size * FULL_LOAD_RATIO) {
			loaded = await this.loadTable();
			staleKeys = this.staleKeys(this.members.keys(), loaded);
		}
		const fetched = await this.fetchRows(staleKeys);
		return this.rowsOf(this.members.keys(), fetched, loaded ?? /* @__PURE__ */ new Map());
	}
	/**
	* The key of a notified id: the key of the cached entry or of the known row, so that it keeps
	* its original type (a notification may carry a numeric key as a string, or the other way
	* around), or else the id converted to a number when the primary key holds numbers (declared as a
	* `number` column, or seen in the rows read).
	*/
	resolveNotifiedKey(id) {
		const normalizedKey = String(id);
		const known = this.engine.store.get(normalizedKey)?.key ?? this.members.keyOf(normalizedKey);
		if (known !== void 0) return known;
		if (typeof id === "string" && this.numericPrimaryKey) {
			const numeric = Number(id);
			if (Number.isFinite(numeric) && String(numeric) === id) return numeric;
		}
		return id;
	}
	/**
	* Invalidates the entry of the key: it is no longer returned, not even as a stale value (but it
	* stays a fallback for `onError: { fallback: 'stale' }`), a fetch already in flight is not
	* cached, the key is removed from the shared level, and `platform.onInvalidate` receives a
	* `manual` event.
	*/
	invalidate(key) {
		this.assertNotDisposed();
		this.engine.invalidate(key);
	}
	/**
	* Deletes the key from the cache (not from the table), and from the shared level.
	*
	* @param options.force - If true, also deletes a protected key.
	* @returns `false` if the key is protected and was left untouched.
	*/
	delete(key, options) {
		this.assertNotDisposed();
		return this.engine.delete(key, options);
	}
	/**
	* Removes all entries from the memory of this instance (not from the shared level). Protected
	* keys are kept, unless `force` is set.
	*/
	clear(options) {
		this.assertNotDisposed();
		this.engine.clear(options);
	}
	/**
	* Removes all expired entries, except those still within the `staleWhileRevalidate` window.
	*
	* @param options.force - If true, also removes the expired protected keys.
	*/
	purgeExpired(options) {
		this.assertNotDisposed();
		this.engine.purgeExpired(options);
	}
	/**
	* Protects keys from `delete`, `clear`, eviction and `purgeExpired`, unless `force` is passed.
	*
	* @returns The cache, for chaining.
	*/
	addProtectedKeys(keys) {
		this.assertNotDisposed();
		this.engine.addProtectedKeys(keys);
		return this;
	}
	/** @returns The cache, for chaining. */
	removeProtectedKeys(keys) {
		this.assertNotDisposed();
		this.engine.removeProtectedKeys(keys);
		return this;
	}
	/**
	* Disposes of the cache: stops its database listener and its changelog reads, removes it from
	* the singleton registry (if it was created as a singleton) and clears it. A `LISTEN` still
	* starting is awaited, so that its listener is removed too. Every call returns the same promise.
	*/
	dispose() {
		this.disposing ??= this.disposeResources();
		return this.disposing;
	}
	async disposeResources() {
		this.releaseSingleton();
		this.engine.dispose();
		this.members.clear();
		this.ownWrites.clear();
		await this.sync.dispose();
	}
	/** `await using cache = ...` disposes of the cache at the end of the scope. */
	[Symbol.asyncDispose]() {
		return this.dispose();
	}
	getItemPrimaryKeyValue(item) {
		const keyValue = item[this.definition.primaryKey];
		if (keyValue === void 0) throw new LilypadDbMissingPrimaryKeyError(this.definition, "item");
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
		const { engine } = this;
		if (engine.disposed) return;
		const normalizedKey = engine.normalizeKey(key);
		const entry = engine.store.get(normalizedKey);
		if (entry && entry.ticket > startTicket) {
			engine.markInvalid(key);
			return;
		}
		engine.set(key, value);
		const stored = engine.store.get(normalizedKey);
		if (xid !== void 0 && stored && this.sync.seesOwnWrites) this.ownWrites.record(normalizedKey, xid, stored.ticket);
	}
	/**
	* Inserts the item in the database and caches the row returned by the database.
	* With `generatedPrimaryKey`, the primary key of `item` can be omitted: the cached row
	* holds the one generated by the database.
	*
	* @returns The created row, or `null` if the schema's `selectSanitizationFn` discards it. A row
	* that the `selectSanitizationFn` returns without its primary key is returned, but not cached.
	*/
	async sqlCreate(item) {
		this.assertNotDisposed();
		const startTicket = this.engine.nextTicket();
		const { row, xid } = await this.table.insert(item);
		if (row === null) return row;
		const key = row[this.definition.primaryKey];
		if (key === void 0) {
			this.engine.log("warn", `The row created in "${this.definition.tableName}" has no primary key "${String(this.definition.primaryKey)}" after selectSanitizationFn: it is not cached.`);
			return row;
		}
		this.storeWritten(key, row, startTicket, xid);
		this.engine.emitInvalidation("write", [key]);
		return row;
	}
	/**
	* Updates the item in the database and caches the row returned by the database.
	* Only the columns present in `item` are written.
	*
	* @returns The updated row, or `null` if the schema's `selectSanitizationFn` discards it.
	* @throws {LilypadDbNotFoundError} If no row with the item's primary key exists.
	*/
	async sqlUpdate(item) {
		this.assertNotDisposed();
		const key = this.getItemPrimaryKeyValue(item);
		const startTicket = this.engine.nextTicket();
		const { row, xid } = await this.table.update(item);
		this.storeWritten(key, row, startTicket, xid);
		this.engine.emitInvalidation("write", [key]);
		return row;
	}
	/**
	* Deletes the row in the database, and caches the key as `null` (also for a protected key).
	*
	* @returns `true` if a row had this key, `false` if there was none (the key is cached as `null`
	* either way).
	*/
	async sqlDelete(key) {
		this.assertNotDisposed();
		const startTicket = this.engine.nextTicket();
		const { deleted, xid } = await this.table.delete(key);
		this.storeWritten(key, null, startTicket, xid);
		this.engine.emitInvalidation("write", [key]);
		return deleted;
	}
};
//#endregion
export { LILYPAD_DEFAULT_CHANGELOG_TABLE, LILYPAD_DEFAULT_DB_CONFIG_NAME, LILYPAD_DEFAULT_NOTIFY_BULK_THRESHOLD, LILYPAD_MIN_CHANGELOG_RETENTION, LilypadDbCache, LilypadDbEmptyWriteError, LilypadDbGate, LilypadDbMissingPrimaryKeyError, LilypadDbNotFoundError, LilypadDbTable, LilypadDisposedError, LilypadSchemaCheckError, checkLilypadSchema, defineLilypadDb, defineLilypadTable, isLilypadDbConfig, isLilypadDbTableDefinition, lilypadChangelogPruneScheduleSql, lilypadChangelogSql, lilypadChangelogTriggerSql, lilypadDbConfigFileNames, lilypadSchemaCheckOptions, lilypadServerlessPool, loadLilypadDbConfig, normalizeLilypadPgType, pruneLilypadChangelog, readLilypadChanges, runLilypadDoctor };

//# sourceMappingURL=db.mjs.map