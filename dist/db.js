"use strict";Object.defineProperty(exports, "__esModule", {value: true}); function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; } function _nullishCoalesce(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return rhsFn(); } } var _class; var _class2; var _class3; var _class4; var _class5; var _class6; var _class7; var _class8;



var _chunkUWWZT52Cjs = require('./chunks/chunk-UWWZT52C.js');
require('./chunks/chunk-J2XBSNY7.js');


var _chunkLL3KVXOKjs = require('./chunks/chunk-LL3KVXOK.js');


var _chunkBQAYFDD3js = require('./chunks/chunk-BQAYFDD3.js');

// src/dbGate/LilypadDbGate.ts
var _crypto = require('crypto');

// src/dbGate/LilypadListenHeartbeat.ts
var LilypadListenHeartbeat = (_class = class _LilypadListenHeartbeat {
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
  /** Missed beats (as a number of intervals) after which the connection counts as unhealthy. */
  static __initStatic() {this.UNHEALTHY_AFTER_INTERVALS = 2.5}
  
  
  /** Starts sending heartbeats; the connection counts as healthy from now. */
  start(now = Date.now()) {
    var _a, _b;
    if (this.timer) {
      return;
    }
    this.lastBeat = now;
    this.timer = setInterval(() => {
      this.send().catch(this.onError);
    }, this.interval);
    (_b = (_a = this.timer).unref) == null ? void 0 : _b.call(_a);
  }
  /** Records a heartbeat received on the `LISTEN` connection. */
  beat(now = Date.now()) {
    if (this.timer) {
      this.lastBeat = now;
    }
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
    return this.lastBeat !== void 0 && now - this.lastBeat <= this.interval * _LilypadListenHeartbeat.UNHEALTHY_AFTER_INTERVALS;
  }
}, _class.__initStatic(), _class);

// src/dbGate/LilypadDbGate.ts
var _postgres = require('postgres'); var _postgres2 = _interopRequireDefault(_postgres);
var lilypadServerlessPool = Object.freeze({
  max: 3,
  idleTimeout: 5e3,
  connectTimeout: 1e4
});
function toPostgresPoolOptions(pool) {
  const seconds = (ms) => ms === void 0 ? void 0 : ms / 1e3;
  return Object.fromEntries(
    Object.entries({
      max: pool == null ? void 0 : pool.max,
      idle_timeout: seconds(pool == null ? void 0 : pool.idleTimeout),
      connect_timeout: seconds(pool == null ? void 0 : pool.connectTimeout),
      max_lifetime: seconds(pool == null ? void 0 : pool.maxLifetime)
    }).filter(([, value]) => value !== void 0)
  );
}
var LilypadDbNotFoundError = class extends Error {
  
  
  constructor(tableName, primaryKeyValue) {
    super(`No row with primary key "${String(primaryKeyValue)}" found in table "${tableName}".`);
    this.name = "LilypadDbNotFoundError";
    this.tableName = tableName;
    this.primaryKeyValue = primaryKeyValue;
  }
};
var SELECT_ALL_BATCH_SIZE = 1e3;
var PRIMARY_KEYS_BATCH_SIZE = 1e3;
var XID_COLUMN = "__lilypad_xid";
var DEFAULT_LISTEN_HEARTBEAT = 15e3;
function lilypadMissingPrimaryKeyError(schema, context) {
  return new Error(
    `Primary key "${String(schema.primaryKey)}" is missing in the ${context} data for table "${schema.tableName}".`
  );
}
var LilypadDbGate = (_class2 = class _LilypadDbGate {
  __init() {this.id = `LilypadDbGate-${globalThis.crypto.randomUUID()}`}
  
  /** Only when `listenerConnectionString` differs: otherwise `sql` listens. */
  
  
  __init2() {this.listeners = /* @__PURE__ */ new Map()}
  __init3() {this.releaseSingleton = () => {
  }}
  
  __init4() {this.heartbeatChannel = `lilypad_heartbeat_${this.id.slice(-36).replace(/-/g, "")}`}
  
  constructor(options) {;_class2.prototype.__init.call(this);_class2.prototype.__init2.call(this);_class2.prototype.__init3.call(this);_class2.prototype.__init4.call(this);
    _chunkUWWZT52Cjs.assertNumberOption.call(void 0, "LilypadDbGate", "statementTimeout", options.statementTimeout, "positive");
    if (options.listenHeartbeat !== false) {
      _chunkUWWZT52Cjs.assertNumberOption.call(void 0, "LilypadDbGate", "listenHeartbeat", options.listenHeartbeat, "positive");
    }
    this.logger = options.logger;
    this.sql = _postgres2.default.call(void 0, options.connectionString, {
      prepare: false,
      ...toPostgresPoolOptions(options.pool),
      ...options.statementTimeout !== void 0 && {
        connection: { statement_timeout: options.statementTimeout }
      }
    });
    const listenerConnectionString = options.listenerConnectionString;
    if (listenerConnectionString && listenerConnectionString !== options.connectionString) {
      this.listenerClient = _postgres2.default.call(void 0, listenerConnectionString);
    }
    if (options.listenHeartbeat !== false) {
      this.heartbeat = new LilypadListenHeartbeat(
        _nullishCoalesce(options.listenHeartbeat, () => ( DEFAULT_LISTEN_HEARTBEAT)),
        () => this.sql`SELECT pg_notify(${this.heartbeatChannel}, '')`,
        (error) => _chunkUWWZT52Cjs.libLog.call(void 0, this.logger, "debug", this.id, "LISTEN heartbeat failed:", error)
      );
    }
  }
  /**
   * Creates a gate and registers the listeners of `options.listen`.
   * Without listeners it opens no connection: the pool connects on the first query, so creating a
   * gate at module level does not reach the database (e.g. during a build).
   * With `singleton: true`, a later call with the same identifier returns the existing gate and
   * ignores its own options (a warning is logged if they differ).
   */
  static async create(options) {
    return _chunkBQAYFDD3js.createLilypadSingletonAbleAsync.call(void 0, 
      "LilypadDbGate",
      options,
      async (release) => {
        const instance = await _LilypadDbGate.initializeNew(options);
        instance.releaseSingleton = release;
        return instance;
      },
      {
        // Hashed: the connection strings contain credentials
        value: _crypto.createHash.call(void 0, "sha256").update(
          JSON.stringify([
            options.connectionString,
            options.listenerConnectionString,
            options.statementTimeout,
            options.pool,
            options.listenHeartbeat
          ])
        ).digest("hex"),
        onMismatch: () => _chunkUWWZT52Cjs.libLog.call(void 0, 
          options.logger,
          "warn",
          "LilypadDbGate",
          `Singleton "${options.singleton ? options.singletonIdentifier : ""}" already exists with different connection options: the new options are ignored.`
        )
      }
    );
  }
  static async initializeNew(options) {
    const instance = new _LilypadDbGate(options);
    try {
      for (const listenOption of _nullishCoalesce(options.listen, () => ( []))) {
        await instance.addListener(listenOption);
      }
    } catch (error) {
      await instance.close();
      throw error;
    }
    return instance;
  }
  // CRUD OPERATIONS
  /**
   * Maps a database row to `T`, using the schema's `selectSanitizationFn` if provided,
   * otherwise by copying the schema columns.
   */
  mapRow(schema, row) {
    if (schema.selectSanitizationFn) {
      return schema.selectSanitizationFn(row);
    }
    const typedRow = {};
    for (const key in schema.cols) {
      typedRow[key] = row[key];
    }
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
    const primaryKeyRequired = operation === "update" || !schema.primaryKeyShouldAutoDetermine;
    if (primaryKeyRequired && (primaryKeyValue === void 0 || primaryKeyValue === null)) {
      throw lilypadMissingPrimaryKeyError(schema, operation);
    }
    if (schema.primaryKeyShouldAutoDetermine) {
      delete writeData[schema.primaryKey];
    }
    const columns = Object.keys(schema.cols).filter(
      (column) => writeData[column] !== void 0
    );
    if (columns.length === 0) {
      throw new Error(`No columns to ${operation} for table "${schema.tableName}".`);
    }
    return { data: writeData, columns, primaryKeyValue };
  }
  /**
   * Selects every row of the table. Rows are read in batches through a cursor, so the raw result
   * of the whole table is never held in memory at once.
   *
   * @param options.signal - Stops reading (and closes the cursor) once aborted: the promise then
   * rejects with the reason of the signal.
   */
  async selectAllFromTable(schema, options = {}) {
    const { signal } = options;
    signal == null ? void 0 : signal.throwIfAborted();
    const typedResults = [];
    const cursor = this.sql`
      SELECT ${this.selectedColumns(schema)} FROM ${this.sql(schema.tableName)}
    `.cursor(SELECT_ALL_BATCH_SIZE);
    for await (const rows of cursor) {
      signal == null ? void 0 : signal.throwIfAborted();
      for (const row of rows) {
        const typedRow = this.mapRow(schema, row);
        if (typedRow !== null) {
          typedResults.push(typedRow);
        }
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
    const typedRows = [];
    for (let start = 0; start < primaryKeyValues.length; start += PRIMARY_KEYS_BATCH_SIZE) {
      const batch = primaryKeyValues.slice(start, start + PRIMARY_KEYS_BATCH_SIZE);
      const results = await this.sql`
        SELECT ${this.selectedColumns(schema)} FROM ${this.sql(schema.tableName)}
        WHERE ${this.sql(String(schema.primaryKey))} IN ${this.sql(batch)}
      `;
      for (const row of results) {
        const typedRow = this.mapRow(schema, row);
        if (typedRow !== null) {
          typedRows.push(typedRow);
        }
      }
    }
    return typedRows;
  }
  async selectFromTableByPrimaryKey(schema, primaryKeyValue) {
    const results = await this.sql`
      SELECT ${this.selectedColumns(schema)} FROM ${this.sql(schema.tableName)}
      WHERE ${this.sql(String(schema.primaryKey))} = ${primaryKeyValue}
    `;
    const [row] = results;
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
    if (!returned) {
      throw new Error(`The write to table "${schema.tableName}" returned no row.`);
    }
    const { [XID_COLUMN]: xid, ...row } = returned;
    return { row: this.mapRow(schema, row), xid: BigInt(xid) };
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
    const {
      data: updateData,
      columns,
      primaryKeyValue
    } = this.prepareWrite(schema, data, "update");
    const results = await this.sql`
      UPDATE ${this.sql(schema.tableName)}
      SET ${this.sql(updateData, columns)}
      WHERE ${this.sql(String(schema.primaryKey))} = ${primaryKeyValue}
      RETURNING ${this.selectedColumns(schema)}, pg_current_xact_id()::text AS ${this.sql(XID_COLUMN)}
    `;
    if (results.count === 0) {
      throw new LilypadDbNotFoundError(schema.tableName, primaryKeyValue);
    }
    return this.writeResult(schema, results);
  }
  /**
   * Deletes the row with this primary key.
   *
   * @returns Whether a row had this primary key, and the id of the transaction that deleted it.
   */
  async deleteFromTable(schema, primaryKeyValue) {
    const results = await this.sql`
      DELETE FROM ${this.sql(schema.tableName)}
      WHERE ${this.sql(String(schema.primaryKey))} = ${primaryKeyValue}
      RETURNING pg_current_xact_id()::text AS ${this.sql(XID_COLUMN)}
    `;
    const [deleted] = results;
    return deleted ? { deleted: true, xid: BigInt(deleted[XID_COLUMN]) } : { deleted: false };
  }
  // LISTENER MANAGEMENT
  /** The client that listens: postgres.js keeps one dedicated connection per client for LISTEN. */
  listenClient() {
    return _nullishCoalesce(this.listenerClient, () => ( this.sql));
  }
  /**
   * Starts listening on the specified channel.
   *
   * The listener entry is registered immediately, before LISTEN is active, so that concurrent
   * `addListener` calls for the same channel share it and await the same `ready` promise.
   * If LISTEN fails, the entry is removed, so that a later `addListener` call retries it.
   */
  initializeListener(channel) {
    _chunkUWWZT52Cjs.libLog.call(void 0, this.logger, "debug", this.id, `Initializing listener for channel "${channel}".`);
    const listener = {
      callbacks: /* @__PURE__ */ new Map(),
      listening: false,
      ready: this.listenClient().listen(
        channel,
        (payload) => this.executeAllListenerCallbacks(channel, payload),
        // postgres.js calls it on the first LISTEN and again after every reconnection
        () => {
          if (listener.listening) {
            this.executeReconnectCallbacks(channel, listener);
          }
          listener.listening = true;
        }
      ).then((meta) => () => meta.unlisten()).catch((error) => {
        if (this.listeners.get(channel) === listener) {
          this.listeners.delete(channel);
        }
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
      _chunkUWWZT52Cjs.libLog.call(void 0, 
        this.logger,
        "error",
        this.id,
        `Error in listener callback "${callbackId}" for channel "${channel}":`,
        error
      );
    });
  }
  /** Runs every callback of a channel with the payload of a notification. */
  executeAllListenerCallbacks(channel, payload) {
    const listener = this.listeners.get(channel);
    if (!listener) {
      return;
    }
    for (const [callbackId, { callback }] of listener.callbacks) {
      this.runCallbackSafely(channel, callbackId, () => callback(payload));
    }
  }
  executeReconnectCallbacks(channel, listener) {
    _chunkUWWZT52Cjs.libLog.call(void 0, 
      this.logger,
      "warn",
      this.id,
      `LISTEN on channel "${channel}" was re-established: notifications sent meanwhile are lost.`
    );
    for (const [callbackId, identifier] of listener.callbacks) {
      if (identifier.onReconnect) {
        this.runCallbackSafely(channel, callbackId, () => {
          var _a;
          return (_a = identifier.onReconnect) == null ? void 0 : _a.call(identifier);
        });
      }
    }
  }
  /**
   * Adds a listener callback for a channel. Adding a callback with an existing `callbackId` on the
   * same channel replaces the previous one.
   *
   * @returns A promise that resolves once LISTEN is active on the channel.
   * @throws If LISTEN fails; in that case the callback is not registered.
   */
  async addListener(identifier) {
    const { channel, callbackId } = identifier;
    _chunkUWWZT52Cjs.libLog.call(void 0, 
      this.logger,
      "debug",
      this.id,
      `Adding listener for channel "${channel}" with callback ID "${callbackId}".`
    );
    const listener = _nullishCoalesce(this.listeners.get(channel), () => ( this.initializeListener(channel)));
    listener.callbacks.set(callbackId, identifier);
    await listener.ready;
    if (this.listeners.get(channel) === listener) {
      await this.startHeartbeat();
    }
    _chunkUWWZT52Cjs.libLog.call(void 0, 
      this.logger,
      "debug",
      this.id,
      `Listener for channel "${channel}" has ${listener.callbacks.size} callbacks.`
    );
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
    if (!listener || !listener.callbacks.delete(callbackId)) {
      return false;
    }
    if (listener.callbacks.size === 0) {
      this.listeners.delete(channel);
      if (this.listeners.size === 0) {
        await this.stopHeartbeat();
      }
      try {
        const unlisten = await listener.ready;
        await unlisten();
      } catch (error) {
        _chunkUWWZT52Cjs.libLog.call(void 0, this.logger, "warn", this.id, `Could not stop listening on "${channel}":`, error);
      }
    }
    return true;
  }
  async startHeartbeat() {
    const heartbeat = this.heartbeat;
    if (!heartbeat || this.heartbeatStop) {
      return;
    }
    this.heartbeatStop = this.listenClient().listen(this.heartbeatChannel, () => heartbeat.beat()).then((meta) => {
      heartbeat.start();
      return () => meta.unlisten();
    });
    try {
      await this.heartbeatStop;
    } catch (error) {
      this.heartbeatStop = void 0;
      _chunkUWWZT52Cjs.libLog.call(void 0, this.logger, "warn", this.id, "Could not start the LISTEN heartbeat:", error);
    }
  }
  async stopHeartbeat() {
    var _a, _b;
    const stop = this.heartbeatStop;
    this.heartbeatStop = void 0;
    (_a = this.heartbeat) == null ? void 0 : _a.stop();
    try {
      await ((_b = await stop) == null ? void 0 : _b());
    } catch (e) {
    }
  }
  /**
   * Whether the `LISTEN` connection is known to deliver notifications: a heartbeat came back
   * recently. Without heartbeat (`listenHeartbeat: false`), `true` as soon as a channel is
   * listened to. `false` while no channel is listened to.
   */
  isListenHealthy() {
    if (!this.heartbeat) {
      return this.listeners.size > 0;
    }
    return this.heartbeat.healthy();
  }
  async close() {
    var _a, _b;
    this.listeners.clear();
    (_a = this.heartbeat) == null ? void 0 : _a.stop();
    this.heartbeatStop = void 0;
    this.releaseSingleton();
    await ((_b = this.listenerClient) == null ? void 0 : _b.end());
    await this.sql.end();
  }
}, _class2);

// src/dbGate/LilypadChangelog.ts
var LILYPAD_DEFAULT_CHANGELOG_TABLE = "lilypad_cache_changes";
var LILYPAD_DEFAULT_NOTIFY_CHANNEL = "cache_events";
var LILYPAD_CHANGELOG_VERSION = 3;
var LILYPAD_CHANGELOG_VERSION_PREFIX = "lilypad-changelog:";
function identifierPrefix(name) {
  return name.replace(/\W/g, "_");
}
function quoteIdentifier(identifier) {
  return identifier.split(".").map((part) => `"${part.replace(/"/g, '""')}"`).join(".");
}
function quoteLiteral(value) {
  return `'${value.replace(/'/g, "''")}'`;
}
function triggerFunctionName(changelogTable) {
  return `${identifierPrefix(changelogTable)}_record`;
}
function changelogTriggerNames(table) {
  const prefix = identifierPrefix(table);
  return { row: `${prefix}_lilypad_changes`, truncate: `${prefix}_lilypad_truncate` };
}
function lilypadChangelogSql(options = {}) {
  const table = _nullishCoalesce(options.table, () => ( LILYPAD_DEFAULT_CHANGELOG_TABLE));
  const channel = _nullishCoalesce(options.notifyChannel, () => ( LILYPAD_DEFAULT_NOTIFY_CHANNEL));
  const quotedTable = quoteIdentifier(table);
  const indexPrefix = identifierPrefix(table);
  const notify = (idExpression, opExpression) => channel === false ? "" : `
    PERFORM pg_notify(${quoteLiteral(channel)}, json_build_object(
      'schema', TG_TABLE_SCHEMA, 'table', TG_TABLE_NAME, 'id', ${idExpression}, 'op', ${opExpression},
      'xid', pg_current_xact_id()::text
    )::text);`;
  const functionName = quoteIdentifier(triggerFunctionName(table));
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

-- Records a change of a row, or a TRUNCATE of the table; the trigger argument is the primary key column.
CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger AS $$
DECLARE
  new_id text;
  old_id text;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    INSERT INTO ${quotedTable} (table_schema, table_name, row_id, op)
      VALUES (TG_TABLE_SCHEMA, TG_TABLE_NAME, NULL, 'TRUNCATE');${notify("NULL", `'TRUNCATE'`)}
    RETURN NULL;
  END IF;

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
    VALUES (TG_TABLE_SCHEMA, TG_TABLE_NAME, COALESCE(new_id, old_id), TG_OP);${notify("COALESCE(new_id, old_id)", "TG_OP")}
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
COMMENT ON FUNCTION ${functionName}() IS ${quoteLiteral(`${LILYPAD_CHANGELOG_VERSION_PREFIX}${LILYPAD_CHANGELOG_VERSION}`)};
`;
}
function lilypadChangelogTriggerSql(options) {
  const changelogTable = _nullishCoalesce(options.changelogTable, () => ( LILYPAD_DEFAULT_CHANGELOG_TABLE));
  const names = changelogTriggerNames(options.table);
  const table = quoteIdentifier(options.table);
  const execute = `EXECUTE FUNCTION ${quoteIdentifier(triggerFunctionName(changelogTable))}(${quoteLiteral(options.primaryKey)})`;
  return `DROP TRIGGER IF EXISTS ${quoteIdentifier(names.row)} ON ${table};
CREATE TRIGGER ${quoteIdentifier(names.row)}
  AFTER INSERT OR UPDATE OR DELETE ON ${table}
  FOR EACH ROW ${execute};
DROP TRIGGER IF EXISTS ${quoteIdentifier(names.truncate)} ON ${table};
CREATE TRIGGER ${quoteIdentifier(names.truncate)}
  AFTER TRUNCATE ON ${table}
  FOR EACH STATEMENT ${execute};
`;
}
function lilypadCursorCovers(cursor, xid) {
  return xid < cursor.xmax && !cursor.xip.includes(xid);
}
async function readLilypadChanges(gate, options) {
  const { changes, cursor } = await readLilypadChangesBatch(gate, {
    requests: [{ tableName: options.tableName, since: options.since }],
    changelogTable: options.changelogTable
  });
  return { changes: _nullishCoalesce(changes[0], () => ( [])), cursor };
}
async function readLilypadChangesBatch(gate, options) {
  var _a, _b, _c;
  const sql = gate.sql;
  const changelogTable = sql(_nullishCoalesce(options.changelogTable, () => ( LILYPAD_DEFAULT_CHANGELOG_TABLE)));
  const tableRefs = options.requests.map((request) => quoteIdentifier(request.tableName));
  const cursors = options.requests.map(
    (request) => "cursor" in request.since ? request.since.cursor : void 0
  );
  const xmaxes = cursors.map((cursor2) => _nullishCoalesce((cursor2 == null ? void 0 : cursor2.xmax.toString()), () => ( "")));
  const xips = cursors.map((cursor2) => _nullishCoalesce((cursor2 == null ? void 0 : cursor2.xip.join(",")), () => ( "")));
  const lookbacks = options.requests.map(
    (request) => "lookback" in request.since ? String(request.since.lookback / 1e3) : "0"
  );
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
        ${sql.array(tableRefs)}::text[], ${sql.array(xmaxes)}::text[],
        ${sql.array(xips)}::text[], ${sql.array(lookbacks)}::text[]
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
  for (const row of rows) {
    if (row.id !== null) {
      (_a = changes[row.request]) == null ? void 0 : _a.push({
        id: row.id,
        xid: BigInt(row.xid),
        rowId: row.row_id,
        op: row.op
      });
    }
  }
  const nextXmax = (_b = rows[0]) == null ? void 0 : _b.next_xmax;
  const nextXip = (_c = rows[0]) == null ? void 0 : _c.next_xip;
  if (typeof nextXmax !== "string" || typeof nextXip !== "string") {
    throw new Error("Reading the changelog returned no snapshot.");
  }
  const cursor = {
    xmax: BigInt(nextXmax),
    xip: nextXip === "" ? [] : nextXip.split(",").map((xid) => BigInt(xid))
  };
  return { changes, cursor };
}
async function pruneLilypadChangelog(gate, options) {
  const changelogTable = _nullishCoalesce(options.changelogTable, () => ( LILYPAD_DEFAULT_CHANGELOG_TABLE));
  const result = await gate.sql`
    DELETE FROM ${gate.sql(changelogTable)}
    WHERE changed_at < clock_timestamp() - make_interval(secs => ${options.olderThan / 1e3})
  `;
  return result.count;
}

// src/dbGate/LilypadChangelogReader.ts
var LilypadChangelogReader = (_class3 = class {
  constructor(gate, changelogTable) {;_class3.prototype.__init5.call(this);
    this.gate = gate;
    this.changelogTable = changelogTable;
  }
  __init5() {this.subscribers = /* @__PURE__ */ new Set()}
  
  /** A read queued after the current one, for subscribers that the current one does not include. */
  
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
    if (!current) {
      return this.start();
    }
    if (current.included.has(subscriber)) {
      return current.promise;
    }
    const noop = () => {
    };
    this.queued ??= current.promise.then(noop, noop).then(() => {
      this.queued = void 0;
      return this.start();
    });
    return this.queued;
  }
  start() {
    const included = new Set(this.subscribers);
    const promise = this.readAll([...included]).finally(() => {
      var _a;
      if (((_a = this.current) == null ? void 0 : _a.promise) === promise) {
        this.current = void 0;
      }
    });
    this.current = { included, promise };
    return promise;
  }
  async readAll(subscribers) {
    if (subscribers.length === 0) {
      return;
    }
    const readAt = Date.now();
    const requests = subscribers.map((subscriber) => subscriber.request(readAt));
    const { changes, cursor } = await readLilypadChangesBatch(this.gate, {
      requests,
      changelogTable: this.changelogTable
    });
    await Promise.allSettled(
      subscribers.map(
        async (subscriber, index) => subscriber.apply({ changes: _nullishCoalesce(changes[index], () => ( [])), cursor, readAt }, requests[index])
      )
    );
  }
}, _class3);
var readers = /* @__PURE__ */ new WeakMap();
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

// src/internal/LilypadBackoff.ts
var MAX_RETRY_DELAY = 6e4;
var LilypadBackoff = (_class4 = class {
  /** @param baseDelay - The wait after the first failure, in ms; it doubles at each failure. */
  constructor(baseDelay) {;_class4.prototype.__init6.call(this);_class4.prototype.__init7.call(this);
    this.baseDelay = baseDelay;
  }
  __init6() {this.failures = 0}
  __init7() {this.retryAt = 0}
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
}, _class4);

// src/cache/dbSync/LilypadChangelogSync.ts
var DEFAULT_MAX_GAP = 60 * 60 * 1e3;
var LilypadChangelogSync = (_class5 = class {
  constructor(host, options, verifier) {;_class5.prototype.__init8.call(this);_class5.prototype.__init9.call(this);
    this.host = host;
    this.options = options;
    this.verifier = verifier;
    this.backoff = new LilypadBackoff(() => Math.max(options.pollInterval, 1e3));
    this.reader = getLilypadChangelogReader(host.gate, options.table);
    this.subscriber = {
      request: (readAt) => this.request(readAt),
      apply: (result, request) => this.apply(result, "cursor" in request.since)
    };
    this.unsubscribe = this.reader.subscribe(this.subscriber);
  }
  __init8() {this.seesOwnWrites = true}
  
  
  
  
  __init9() {this.lastRead = 0}
  /** Since when the chain of reads is unbroken. */
  
  
  get maxGap() {
    return _nullishCoalesce(this.options.maxGap, () => ( DEFAULT_MAX_GAP));
  }
  start() {
    return Promise.resolve();
  }
  beforeRead() {
    const now = Date.now();
    if (now - this.lastRead < this.options.pollInterval || !this.backoff.ready(now)) {
      return void 0;
    }
    this.verifier.checkInBackground(now);
    const reading = this.read();
    if (this.options.poll === "background") {
      _chunkLL3KVXOKjs.runInBackground.call(void 0, this.host.platform, reading, () => {
      });
      return void 0;
    }
    return reading;
  }
  trustedSince() {
    if (this.cursor === void 0 || Date.now() - this.lastRead > this.maxGap) {
      return void 0;
    }
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
    if (this.cursor !== void 0 && readAt - this.lastRead <= this.maxGap) {
      return { tableName, since: { cursor: this.cursor } };
    }
    return { tableName, since: { lookback: _nullishCoalesce(this.options.lookback, () => ( this.host.defaultLookback())) } };
  }
  /**
   * Applies a read of the changelog. Its errors are logged: the other caches read with it must not
   * be affected. Each change is returned by one read only (see `LilypadChangelogCursor`).
   *
   * @param trusted - Whether the read started from the cursor of this cache.
   */
  async apply({ changes, cursor, readAt }, trusted) {
    const { host } = this;
    if (host.isDisposed()) {
      return;
    }
    try {
      if (!trusted) {
        host.expireEverything();
        this.chainStartedAt = readAt;
      }
      const changedKeys = [];
      let truncated = false;
      for (const change of changes) {
        if (change.op === "TRUNCATE") {
          changedKeys.push(...host.applyTruncate("lazy"));
          truncated = true;
        } else {
          changedKeys.push(await host.applyChange(change.op, change.rowId, "lazy", change.xid));
        }
      }
      host.forgetOwnWritesCoveredBy(cursor);
      this.cursor = cursor;
      this.lastRead = readAt;
      this.backoff.succeed();
      host.emitInvalidation("changelog", changedKeys, { wholeCache: truncated });
    } catch (error) {
      host.log("error", "Error applying the changelog:", error);
    }
  }
  dispose() {
    this.unsubscribe();
    return Promise.resolve();
  }
}, _class5);

// src/cache/dbSync/LilypadDbSyncTypes.ts
var lilypadNoSync = {
  start: () => Promise.resolve(),
  beforeRead: () => void 0,
  trustedSince: () => void 0,
  seesOwnWrites: false,
  dispose: () => Promise.resolve()
};

// src/cache/dbSync/LilypadListenSync.ts
var OPERATIONS = /* @__PURE__ */ new Set(["INSERT", "UPDATE", "DELETE", "TRUNCATE"]);
function parseLilypadNotification(payload) {
  if (typeof payload !== "string") {
    return void 0;
  }
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch (e2) {
    return void 0;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return void 0;
  }
  const { table, op, id, schema, xid } = parsed;
  if (typeof table !== "string" || table === "" || typeof op !== "string" || !OPERATIONS.has(op)) {
    return void 0;
  }
  if (op !== "TRUNCATE" && !(typeof id === "string" && id !== "" || typeof id === "number")) {
    return void 0;
  }
  if (schema !== void 0 && typeof schema !== "string" || xid !== void 0 && typeof xid !== "string") {
    return void 0;
  }
  return parsed;
}
function parseXid(xid) {
  return xid !== void 0 && /^\d+$/.test(xid) ? BigInt(xid) : void 0;
}
var LilypadListenSync = (_class6 = class {
  constructor(host, options, verifier) {;_class6.prototype.__init10.call(this);_class6.prototype.__init11.call(this);
    this.host = host;
    this.options = options;
    this.verifier = verifier;
    this.applyChanges = options.applyChanges !== false;
    this.listener = {
      channel: LILYPAD_DEFAULT_NOTIFY_CHANNEL,
      // The instance id keeps the callbacks of different caches on the same table apart
      callbackId: `lilypad_dbcache_${host.tableName}_${host.id}`,
      // Notifications sent while the connection was down are lost: every entry may be stale
      onReconnect: () => {
        if (host.isDisposed()) {
          return;
        }
        host.expireEverything();
        if (this.applyChanges) {
          this.listenTrustedSince = Date.now();
        }
      },
      callback: (payload) => this.handleNotification(payload)
    };
  }
  __init10() {this.seesOwnWrites = true}
  
  
  
  __init11() {this.backoff = new LilypadBackoff(() => 1e3)}
  /** Since when `LISTEN` delivers every change to this instance. */
  
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
        if (this.applyChanges) {
          this.listenTrustedSince = Date.now();
        }
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
      return void 0;
    }
    if (this.options.connect !== "lazy" || !this.backoff.ready(now)) {
      return void 0;
    }
    return this.startListening().catch((error) => {
      this.host.log("error", "Error starting LISTEN for the cache:", error);
    });
  }
  trustedSince() {
    return this.host.gate.isListenHealthy() ? this.listenTrustedSince : void 0;
  }
  async handleNotification(raw) {
    var _a, _b;
    const { host } = this;
    if (host.isDisposed()) {
      return;
    }
    host.log("debug", "Received a notification on the cache_events channel:", raw);
    const payload = parseLilypadNotification(raw);
    if (!payload) {
      host.log("warn", "Ignoring a malformed cache_events notification:", raw);
      return;
    }
    if (!this.isForTable(payload)) {
      return;
    }
    if (this.applyChanges) {
      if (payload.op === "TRUNCATE") {
        host.emitInvalidation("notification", host.applyTruncate("eager"), { wholeCache: true });
      } else {
        const key = await host.applyChange(payload.op, payload.id, "eager", parseXid(payload.xid));
        host.emitInvalidation("notification", [key]);
      }
    }
    await ((_b = (_a = this.options).onNotification) == null ? void 0 : _b.call(_a, payload));
  }
  /**
   * Whether a notification is about the table of this cache. `table` is the name without its
   * schema; `schema`, when the trigger sends it and the schema of the table is known, must match.
   */
  isForTable(payload) {
    if (payload.table !== this.host.tableName.split(".").pop()) {
      return false;
    }
    const tableSchema = this.host.tableSchema();
    return payload.schema === void 0 || tableSchema === void 0 || payload.schema === tableSchema;
  }
  /** Waits for a `LISTEN` still starting, then removes the listener. It never rejects. */
  async dispose() {
    var _a;
    await ((_a = this.listening) == null ? void 0 : _a.catch(() => {
    }));
    await this.host.gate.removeListener(this.listener.channel, this.listener.callbackId);
  }
}, _class6);

// src/dbGate/LilypadSchemaCheck.ts
var LilypadSchemaCheckError = class extends Error {
  
  constructor(subject, problems) {
    super(formatLilypadSchemaProblems(subject, problems));
    this.name = "LilypadSchemaCheckError";
    this.problems = problems;
  }
};
function formatLilypadSchemaProblems(subject, problems) {
  const lines = [`${subject}: the database is not set up.`];
  for (const problem of problems) {
    lines.push(`- ${problem.message}`);
  }
  const fixes = [...new Set(problems.flatMap((problem) => problem.fix ? [problem.fix] : []))];
  if (fixes.length > 0) {
    lines.push("Run this SQL in a migration to fix it:", ...fixes);
  }
  return lines.join("\n");
}
var TRIGGER_TYPE_ROW = 1;
var TRIGGER_TYPE_INSERT = 4;
var TRIGGER_TYPE_DELETE = 8;
var TRIGGER_TYPE_UPDATE = 16;
var TRIGGER_TYPE_TRUNCATE = 32;
var ROW_EVENTS = TRIGGER_TYPE_INSERT | TRIGGER_TYPE_UPDATE | TRIGGER_TYPE_DELETE;
var ROW_EVENT_NAMES = [
  [TRIGGER_TYPE_INSERT, "INSERT"],
  [TRIGGER_TYPE_UPDATE, "UPDATE"],
  [TRIGGER_TYPE_DELETE, "DELETE"]
];
var CHANGELOG_TRIGGER_TYPE = TRIGGER_TYPE_ROW | ROW_EVENTS;
function firesOnTruncate(trigger) {
  return trigger.enabled && (trigger.type & TRIGGER_TYPE_ROW) === 0 && (trigger.type & TRIGGER_TYPE_TRUNCATE) !== 0;
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function changelogTarget(options) {
  var _a;
  if (options.changelog === false) {
    return void 0;
  }
  const table = _nullishCoalesce(((_a = options.changelog) == null ? void 0 : _a.table), () => ( LILYPAD_DEFAULT_CHANGELOG_TABLE));
  return {
    table,
    // The changelog table's name when it is not the default, for the generated SQL
    custom: table === LILYPAD_DEFAULT_CHANGELOG_TABLE ? void 0 : table,
    functionSignature: `${quoteIdentifier(triggerFunctionName(table))}()`
  };
}
async function readLilypadSchemaFacts(gate, options) {
  const sql = gate.sql;
  const changelog = _nullishCoalesce(changelogTarget(options), () => ( changelogTarget({ tables: [] })));
  const quotedChangelog = quoteIdentifier(changelog.table);
  const [database] = await sql`
    SELECT
      current_setting('server_version_num')::int AS version,
      to_regclass(${quotedChangelog}::text) IS NOT NULL AS has_changelog_table,
      EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = to_regclass(${quotedChangelog}::text)
          AND attname = 'table_schema' AND NOT attisdropped
      ) AS has_schema_column,
      to_regprocedure(${changelog.functionSignature}::text) IS NOT NULL AS has_function,
      obj_description(to_regprocedure(${changelog.functionSignature}::text), 'pg_proc') AS function_comment
  `;
  if (!database) {
    throw new Error("Reading the database settings returned no row.");
  }
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
            'enabled', tr.tgenabled <> 'D',
            'source', p.prosrc
          )), '[]'::json)
          FROM pg_trigger tr JOIN pg_proc p ON p.oid = tr.tgfoid
          WHERE tr.tgrelid = t.oid AND NOT tr.tgisinternal
        ) AS triggers
      FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE t.oid = to_regclass(${quoteIdentifier(table)}::text)
    `;
    tables.push(
      found ? {
        schema: found.schema_name,
        triggers: typeof found.triggers === "string" ? JSON.parse(found.triggers) : found.triggers
      } : { schema: null, triggers: [] }
    );
  }
  return {
    version: database.version,
    changelog: {
      hasTable: database.has_changelog_table,
      hasSchemaColumn: database.has_schema_column,
      hasFunction: database.has_function,
      functionComment: database.function_comment
    },
    tables
  };
}
async function checkLilypadSchema(gate, options) {
  return evaluateLilypadSchema(await readLilypadSchemaFacts(gate, options), options);
}
function evaluateLilypadSchema(facts, options) {
  const changelog = changelogTarget(options);
  const notifyChannel = _nullishCoalesce(options.notifyChannel, () => ( false));
  const problems = [];
  if (facts.version < 13e4) {
    problems.push({
      code: "unsupported-version",
      message: `PostgreSQL ${facts.version} is too old: the changelog needs PostgreSQL 13 or later.`
    });
  }
  if (changelog) {
    const changelogSql = lilypadChangelogSql({ table: changelog.custom });
    const { hasTable, hasSchemaColumn, hasFunction, functionComment } = facts.changelog;
    if (!hasTable || !hasFunction) {
      problems.push({
        code: "missing-changelog",
        message: !hasTable ? `The changelog table "${changelog.table}" does not exist.` : `The changelog trigger function ${changelog.functionSignature} does not exist.`,
        fix: changelogSql
      });
    }
    const comment = _nullishCoalesce(functionComment, () => ( ""));
    const version = comment.startsWith(LILYPAD_CHANGELOG_VERSION_PREFIX) ? Number(comment.slice(LILYPAD_CHANGELOG_VERSION_PREFIX.length)) : 1;
    if (hasTable && !hasSchemaColumn || hasFunction && version < LILYPAD_CHANGELOG_VERSION) {
      problems.push({
        code: "outdated-changelog",
        message: `The changelog "${changelog.table}" was installed by an older version of the library (version ${version}, expected ${LILYPAD_CHANGELOG_VERSION}).`,
        fix: changelogSql
      });
    }
  }
  const tables = [];
  options.tables.forEach(({ table, primaryKey }, index) => {
    const found = facts.tables[index];
    if (!found || found.schema === null) {
      tables.push({ table, schema: null });
      problems.push({
        code: "missing-table",
        table,
        message: `The table "${table}" does not exist.`
      });
      return;
    }
    tables.push({ table, schema: found.schema });
    const triggers = found.triggers;
    if (changelog) {
      const fix = lilypadChangelogTriggerSql({
        table,
        primaryKey,
        changelogTable: changelog.custom
      });
      const working = triggers.filter(
        (trigger) => trigger.changelog && trigger.enabled && (trigger.type & CHANGELOG_TRIGGER_TYPE) === CHANGELOG_TRIGGER_TYPE
      );
      const recordedColumn = (trigger) => trigger.args.split("\\000")[0];
      if (working.length === 0) {
        problems.push({
          code: "missing-changelog-trigger",
          table,
          message: triggers.some((trigger) => trigger.changelog) ? `The changelog trigger of "${table}" is disabled or does not fire on each INSERT, UPDATE and DELETE row.` : `The table "${table}" has no changelog trigger: its changes are not recorded.`,
          fix
        });
      } else if (!working.some((trigger) => recordedColumn(trigger) === primaryKey)) {
        problems.push({
          code: "wrong-trigger-primary-key",
          table,
          message: `The changelog trigger of "${table}" records the column "${recordedColumn(working[0])}", not the primary key "${primaryKey}".`,
          fix
        });
      } else if (!triggers.some((trigger) => trigger.changelog && firesOnTruncate(trigger))) {
        problems.push({
          code: "missing-truncate-trigger",
          table,
          message: `The changelog does not record TRUNCATE of "${table}": the caches would keep the removed rows.`,
          fix
        });
      }
    }
    if (notifyChannel !== false) {
      const notifies = new RegExp(
        `pg_notify\\s*\\(\\s*'${escapeRegExp(notifyChannel.replace(/'/g, "''"))}'`,
        "i"
      );
      const notifiedEvents = triggers.filter(
        (trigger) => trigger.enabled && (trigger.type & TRIGGER_TYPE_ROW) !== 0 && notifies.test(trigger.source)
      ).reduce((events, trigger) => events | trigger.type & ROW_EVENTS, 0);
      const fix = lilypadChangelogSql({ table: changelog == null ? void 0 : changelog.custom, notifyChannel }) + lilypadChangelogTriggerSql({ table, primaryKey, changelogTable: changelog == null ? void 0 : changelog.custom });
      if (notifiedEvents === 0) {
        problems.push({
          code: "missing-notify-trigger",
          table,
          message: `No trigger of "${table}" sends notifications on the "${notifyChannel}" channel: the cache is not told about changes made elsewhere.`,
          fix
        });
      } else if (notifiedEvents !== ROW_EVENTS) {
        const names = (events) => ROW_EVENT_NAMES.filter(([bit]) => (events & bit) !== 0).map(([, name]) => name).join(", ");
        problems.push({
          code: "missing-notify-trigger",
          table,
          message: `The triggers of "${table}" send notifications on the "${notifyChannel}" channel only on ${names(notifiedEvents)}: the cache is not told about ${names(ROW_EVENTS & ~notifiedEvents)} made elsewhere.`,
          fix
        });
      } else if (!triggers.some((trigger) => firesOnTruncate(trigger) && notifies.test(trigger.source))) {
        problems.push({
          code: "missing-truncate-trigger",
          table,
          message: `No trigger of "${table}" sends a notification on the "${notifyChannel}" channel for TRUNCATE: the caches would keep the removed rows.`,
          fix
        });
      }
    }
  });
  return { ok: problems.length === 0, problems, tables };
}

// src/cache/dbSync/LilypadSchemaVerifier.ts
var LilypadSchemaVerifier = (_class7 = class {
  constructor(options) {;_class7.prototype.__init12.call(this);
    this.options = options;
  }
  
  __init12() {this.backoff = new LilypadBackoff(() => 1e3)}
  get mode() {
    return this.options.strategy === "none" ? "off" : this.options.mode;
  }
  /** @throws A `LilypadSchemaCheckError` with `throw`, or the error of the check. */
  verify() {
    const mode = this.mode;
    if (mode === "off") {
      return Promise.resolve();
    }
    if (!this.check) {
      const check = this.run(mode).then((ran) => {
        if (!ran && this.check === check) {
          this.check = void 0;
        }
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
    if (this.check || !this.backoff.ready(now) || this.mode === "off") {
      return;
    }
    _chunkLL3KVXOKjs.runInBackground.call(void 0, this.options.platform, this.verify(), () => {
    });
  }
  /** @returns `false` if the check could not run (with `warn`; `throw` rejects). */
  async run(mode) {
    var _a;
    const { gate, tableName, primaryKey, strategy, changelogTable, log } = this.options;
    const subject = `LilypadDbCache "${tableName}" (sync: ${strategy})`;
    try {
      const result = await checkLilypadSchema(gate, {
        tables: [{ table: tableName, primaryKey }],
        changelog: strategy === "changelog" ? { table: changelogTable } : false,
        notifyChannel: strategy === "listen" ? LILYPAD_DEFAULT_NOTIFY_CHANNEL : false
      });
      const schema = (_a = result.tables[0]) == null ? void 0 : _a.schema;
      if (schema) {
        this.options.onSchema(schema);
      }
      this.backoff.succeed();
      if (result.ok) {
        return true;
      }
      if (mode === "throw") {
        throw new LilypadSchemaCheckError(subject, result.problems);
      }
      const message = formatLilypadSchemaProblems(subject, result.problems);
      if (this.options.canWarn()) {
        log("warn", message);
      } else {
        console.warn(message);
      }
      return true;
    } catch (error) {
      if (mode === "throw") {
        throw error;
      }
      this.backoff.fail();
      log("warn", `${subject}: could not check the database schema:`, error);
      return false;
    }
  }
}, _class7);

// src/cache/LilypadDbCache.ts
var DEFAULT_MAX_AGE = 60 * 60 * 1e3;
var FULL_LOAD_RATIO = 0.25;
var OWN_WRITE_RETENTION = 10 * 60 * 1e3;
var LilypadDbCache = (_class8 = class _LilypadDbCache extends _chunkUWWZT52Cjs.LilypadCacheCore {
  
  
  
  
  
  __init13() {this.releaseSingleton = () => {
  }}
  /**
   * The schema of the table: from `tableName` when it is qualified, otherwise as resolved by the
   * schema check. Notifications from another schema are ignored; while it is unknown, notifications
   * of the table in any schema are applied.
   */
  
  /**
   * The keys of the rows of the table, as far as this instance knows. Each load of the table sets
   * them; the writes, the fetches and the changes keep them up to date. `getAll` returns these
   * rows, fetching only those it does not hold up to date. Tracked once the table has been loaded.
   */
  __init14() {this.members = /* @__PURE__ */ new Map()}
  /** When the last load of the table started, if one completed (and nothing voided it since). */
  
  /** Loads started before this ticket (before a `TRUNCATE`) no longer tell which rows exist. */
  __init15() {this.membersFloor = 0}
  /** Receive the rows of the next load of the table (see `loadTable`). */
  __init16() {this.tableLoadWaiters = /* @__PURE__ */ new Set()}
  /** The queries of `fetchRows` in flight, by normalized key. */
  __init17() {this.rowFetches = /* @__PURE__ */ new Map()}
  /** The refreshes of `refresh` in flight, and the one queued after each (normalized keys). */
  __init18() {this.refreshes = /* @__PURE__ */ new Map()}
  /**
   * The writes of this instance, by normalized key: their transaction ids, and the ticket of the
   * entry the last one stored. While the entry holds it, the changes of these writes are already
   * reflected in it.
   */
  __init19() {this.ownWrites = /* @__PURE__ */ new Map()}
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
    return _chunkBQAYFDD3js.createLilypadSingletonAbleAsync.call(void 0, 
      "LilypadDbCache",
      options,
      async (release) => {
        const cache = new _LilypadDbCache(options);
        try {
          if (cache.verifier.mode === "throw") {
            await cache.verifier.verify();
          }
          await cache.sync.start();
        } catch (error) {
          await cache.dispose();
          throw error;
        }
        cache.releaseSingleton = release;
        return cache;
      },
      {
        value: JSON.stringify([options.schema.tableName, options.ttl]),
        onMismatch: () => _chunkUWWZT52Cjs.libLog.call(void 0, 
          options.logger,
          "warn",
          "LilypadDbCache",
          `Singleton "${options.singleton ? options.singletonIdentifier : ""}" already exists with a different table or TTL: the new options are ignored.`
        )
      }
    );
  }
  constructor(options) {
    const { gate, schema, sync = { strategy: "listen" }, bulkSync, ...cacheOptions } = options;
    super({ ...cacheOptions, bulkSync, name: _nullishCoalesce(options.name, () => ( schema.tableName)) });_class8.prototype.__init13.call(this);_class8.prototype.__init14.call(this);_class8.prototype.__init15.call(this);_class8.prototype.__init16.call(this);_class8.prototype.__init17.call(this);_class8.prototype.__init18.call(this);_class8.prototype.__init19.call(this);;
    const owner = "LilypadDbCache";
    if (sync.strategy !== "none") {
      _chunkUWWZT52Cjs.assertNumberOption.call(void 0, owner, "sync.maxAge", sync.maxAge, "non-negative");
    }
    if (sync.strategy === "changelog") {
      _chunkUWWZT52Cjs.assertNumberOption.call(void 0, owner, "sync.pollInterval", sync.pollInterval, "non-negative");
      _chunkUWWZT52Cjs.assertNumberOption.call(void 0, owner, "sync.maxGap", sync.maxGap, "positive");
      _chunkUWWZT52Cjs.assertNumberOption.call(void 0, owner, "sync.lookback", sync.lookback, "non-negative");
      if (typeof sync.pollInterval !== "number") {
        throw new Error(`${owner}: sync.pollInterval is required with the changelog strategy.`);
      }
    }
    this.gate = gate;
    this.schema = schema;
    this.maxAge = sync.strategy === "none" ? 0 : _nullishCoalesce(sync.maxAge, () => ( DEFAULT_MAX_AGE));
    const tableNameParts = schema.tableName.split(".");
    if (tableNameParts.length > 1) {
      this.tableSchema = tableNameParts[tableNameParts.length - 2];
    }
    this.bulkSyncFn = (signal) => this.loadRows(signal);
    this.verifier = new LilypadSchemaVerifier({
      gate,
      tableName: schema.tableName,
      primaryKey: String(schema.primaryKey),
      strategy: sync.strategy,
      changelogTable: sync.strategy === "changelog" ? sync.table : void 0,
      mode: sync.strategy === "none" ? "off" : _nullishCoalesce(sync.verify, () => ( "warn")),
      platform: this.platform,
      log: (level, ...message) => _chunkUWWZT52Cjs.libLog.call(void 0, this.logger, level, this.name, ...message),
      canWarn: () => {
        var _a;
        return ((_a = this.logger) == null ? void 0 : _a.warn) !== void 0;
      },
      onSchema: (resolved) => {
        this.tableSchema = resolved;
      }
    });
    const host = this.syncHost();
    this.sync = sync.strategy === "listen" ? new LilypadListenSync(host, sync, this.verifier) : sync.strategy === "changelog" ? new LilypadChangelogSync(host, sync, this.verifier) : lilypadNoSync;
    _chunkUWWZT52Cjs.libLog.call(void 0, 
      this.logger,
      "debug",
      this.name,
      `LilypadDbCache initialized for table "${schema.tableName}" (sync: ${sync.strategy})`
    );
  }
  /** What the sync strategy may use of this cache. */
  syncHost() {
    return {
      id: this.id,
      name: this.name,
      gate: this.gate,
      tableName: this.schema.tableName,
      platform: this.platform,
      log: (level, ...message) => _chunkUWWZT52Cjs.libLog.call(void 0, this.logger, level, this.name, ...message),
      isDisposed: () => this.disposed,
      applyChange: (op, id, mode, xid) => this.applyChange(op, id, mode, xid),
      applyTruncate: (mode) => this.applyTruncate(mode),
      expireEverything: () => this.expireEverything(),
      emitInvalidation: (source, keys, options) => this.emitInvalidation(source, keys, options),
      forgetOwnWritesCoveredBy: (cursor) => this.forgetOwnWritesCoveredBy(cursor),
      tableSchema: () => this.tableSchema,
      defaultLookback: () => this.defaultTtl + this.defaultStaleWhileRevalidate + 6e4
    };
  }
  /** Loads every row of the table, for the bulk sync of the base class. */
  async loadRows(signal) {
    const read = this.beginRead();
    const primaryKey = this.schema.primaryKey;
    const entries = (await this.gate.selectAllFromTable(this.schema, { signal })).map(
      (row) => [row[primaryKey], row]
    );
    if (!signal.aborted) {
      this.replaceMembers(entries, read.ticket, read.startedAt);
      if (this.tableLoadWaiters.size > 0) {
        const rows = new Map(entries.map(([key, row]) => [this.normalizeKey(key), row]));
        for (const waiter of this.tableLoadWaiters) {
          waiter(rows);
        }
      }
    }
    return entries;
  }
  // TRUST AND RENEWAL
  /**
   * Keeps, without a query, an entry that reached its TTL while it is known to be up to date: its
   * value was read from the database (or written by this instance) after the sync became trusted,
   * and any change of its row since would have expired it. It is kept until `maxAge`.
   */
  renew(normalizedKey) {
    const entry = this.store.get(normalizedKey);
    const now = Date.now();
    if (!entry || entry.origin !== "source" || entry.expirationTime === 0) {
      return;
    }
    if (now < entry.expirationTime) {
      return;
    }
    const trustedSince = this.sync.trustedSince();
    if (trustedSince === void 0 || entry.fetchedAt < trustedSince) {
      return;
    }
    if (now - entry.fetchedAt >= this.maxAge) {
      return;
    }
    this.store.set(normalizedKey, {
      ...entry,
      expirationTime: Math.min(now + this.defaultTtl, entry.fetchedAt + this.maxAge)
    });
  }
  // CHANGES MADE ELSEWHERE
  /**
   * Applies a change of a row made elsewhere.
   * - A change made by a write of this instance whose result the entry still holds: nothing to do.
   * - A change of a key held (or being read) by this instance: `eager` re-fetches it at once;
   *   `lazy` expires it with no query, which also discards a read in flight (it may predate the
   *   change): the next read fetches it. A `lazy` DELETE caches the key as `null` at once.
   * - A change of any other key: no query. The shared level entry is removed.
   * INSERT and UPDATE note the key as a row of the table, which `getAll` returns. An `eager`
   * DELETE of a key not held leaves it there: `getAll` reads it again, and learns whether it is
   * gone. A notification is thus never trusted without a query (any role can send one).
   *
   * @param xid - The transaction that made the change, when known.
   * @returns The key of the changed row.
   */
  async applyChange(op, id, mode, xid) {
    const key = this.resolveNotifiedKey(id);
    if (xid !== void 0 && this.isOwnWrite(key, xid)) {
      return key;
    }
    if (op === "DELETE" && mode === "lazy") {
      this.markDeleted(key);
      return key;
    }
    const normalizedKey = this.normalizeKey(key);
    const held = this.store.has(normalizedKey) || this.hasReadInFlight(normalizedKey);
    if (op !== "DELETE") {
      this.addMember(key);
    }
    if (!held) {
      this.deleteShared(key);
      this.forceNextBulkSync();
    } else if (mode === "eager") {
      await this.refreshKey(key);
    } else {
      this.markInvalid(key);
    }
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
    for (const key of keys) {
      this.deleteShared(key);
    }
    this.expireEverything();
    this.rejectSharedBefore(Date.now());
    this.membersFloor = this.nextTicket();
    this.members.clear();
    if (mode === "eager") {
      this.membersLoadedAt = void 0;
    }
    return keys;
  }
  /**
   * Whether a change is the one of a write of this instance, and the entry still holds the result
   * of the last write of this instance (nothing else replaced it since): that result is at least
   * as recent as the change. The write is forgotten either way.
   */
  isOwnWrite(key, xid) {
    var _a;
    const normalizedKey = this.normalizeKey(key);
    const own = this.ownWrites.get(normalizedKey);
    if (!(own == null ? void 0 : own.xids.delete(xid))) {
      return false;
    }
    if (own.xids.size === 0) {
      this.ownWrites.delete(normalizedKey);
    }
    return ((_a = this.store.get(normalizedKey)) == null ? void 0 : _a.ticket) === own.ticket;
  }
  recordOwnWrite(normalizedKey, xid, ticket) {
    var _a;
    const now = Date.now();
    for (const [key, own] of this.ownWrites) {
      if (now - own.at <= OWN_WRITE_RETENTION) {
        break;
      }
      this.ownWrites.delete(key);
    }
    const xids = _nullishCoalesce(((_a = this.ownWrites.get(normalizedKey)) == null ? void 0 : _a.xids), () => ( /* @__PURE__ */ new Set()));
    xids.add(xid);
    this.ownWrites.delete(normalizedKey);
    this.ownWrites.set(normalizedKey, { ticket, xids, at: now });
  }
  /** Forgets the own writes whose changes a read from this cursor no longer returns. */
  forgetOwnWritesCoveredBy(cursor) {
    for (const [normalizedKey, own] of this.ownWrites) {
      for (const xid of own.xids) {
        if (lilypadCursorCovers(cursor, xid)) {
          own.xids.delete(xid);
        }
      }
      if (own.xids.size === 0) {
        this.ownWrites.delete(normalizedKey);
      }
    }
  }
  // ROWS OF THE TABLE
  /** Follows the values stored in the cache: a row is a row of the table, `null` is not. */
  onValueStored(entry) {
    if (this.membersLoadedAt === void 0 || entry.origin === "fallback") {
      return;
    }
    const normalizedKey = this.normalizeKey(entry.key);
    const member = this.members.get(normalizedKey);
    if (member && member.ticket > entry.ticket) {
      return;
    }
    if (entry.value === null) {
      this.members.delete(normalizedKey);
    } else {
      this.members.set(normalizedKey, { key: entry.key, ticket: entry.ticket });
    }
  }
  /** Notes a row that exists in the table, without fetching it. */
  addMember(key) {
    if (this.membersLoadedAt !== void 0) {
      this.members.set(this.normalizeKey(key), { key, ticket: this.nextTicket() });
    }
  }
  /**
   * Replaces the rows of the table with the result of a load, keeping what changed after the load
   * started: rows added since, rows deleted since.
   */
  replaceMembers(entries, ticket, startedAt) {
    if (ticket < this.membersFloor) {
      return;
    }
    const members = /* @__PURE__ */ new Map();
    for (const [key] of entries) {
      const normalizedKey = this.normalizeKey(key);
      const entry = this.store.get(normalizedKey);
      if (entry && entry.ticket > ticket && entry.value === null && entry.origin !== "fallback") {
        continue;
      }
      const member = this.members.get(normalizedKey);
      members.set(normalizedKey, member && member.ticket > ticket ? member : { key, ticket });
    }
    for (const [normalizedKey, member] of this.members) {
      if (member.ticket > ticket && !members.has(normalizedKey)) {
        members.set(normalizedKey, member);
      }
    }
    this.members = members;
    this.membersLoadedAt = startedAt;
  }
  /**
   * Whether the rows of the table are known: loaded since the sync became trusted, or, without a
   * trusted sync, less than `bulkSync.ttl` ago.
   */
  isTableLoaded() {
    if (this.membersLoadedAt === void 0) {
      return false;
    }
    const trustedSince = this.sync.trustedSince();
    if (trustedSince !== void 0 && this.membersLoadedAt >= trustedSince) {
      return true;
    }
    return Date.now() < this.membersLoadedAt + this.bulkSyncTtl;
  }
  /**
   * Loads the whole table, even if the bulk sync of the base class still counts as fresh.
   *
   * @returns The rows loaded, by normalized key: with `maxEntries`, the cache may not hold them all.
   */
  async loadTable() {
    let loaded = /* @__PURE__ */ new Map();
    const waiter = (rows) => {
      loaded = rows;
    };
    this.tableLoadWaiters.add(waiter);
    try {
      if (Date.now() < this.bulkSyncExpirationTime) {
        this.forceNextBulkSync();
      }
      await this.bulkSync({ throwOnError: true });
    } finally {
      this.tableLoadWaiters.delete(waiter);
    }
    return loaded;
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
      if (!entry) {
        return !(loaded == null ? void 0 : loaded.has(normalizedKey));
      }
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
      if (inFlight) {
        pending.add(inFlight);
      } else {
        toFetch.set(normalizedKey, key);
      }
    }
    if (toFetch.size > 0) {
      const fetching = this.queryRows([...toFetch.values()]);
      for (const normalizedKey of toFetch.keys()) {
        this.rowFetches.set(normalizedKey, fetching);
      }
      const cleanup = () => {
        for (const normalizedKey of toFetch.keys()) {
          if (this.rowFetches.get(normalizedKey) === fetching) {
            this.rowFetches.delete(normalizedKey);
          }
        }
      };
      void fetching.then(cleanup, cleanup);
      pending.add(fetching);
    }
    const values = /* @__PURE__ */ new Map();
    for (const result of await Promise.all(pending)) {
      for (const [normalizedKey, value] of result) {
        values.set(normalizedKey, value);
      }
    }
    return values;
  }
  /** One read of `fetchRows`, bounded by `bulkSync.timeout`. */
  async queryRows(keys) {
    const primaryKey = this.schema.primaryKey;
    try {
      return await this.bulkSyncFlowControl.executeWithTimeout(async (signal) => {
        const read = this.beginRead();
        const rows = /* @__PURE__ */ new Map();
        for (const row of await this.gate.selectFromTableByPrimaryKeys(this.schema, keys)) {
          rows.set(this.normalizeKey(row[primaryKey]), row);
        }
        const values = /* @__PURE__ */ new Map();
        for (const key of keys) {
          const normalizedKey = this.normalizeKey(key);
          const row = _nullishCoalesce(rows.get(normalizedKey), () => ( null));
          values.set(normalizedKey, row);
          if (!signal.aborted) {
            read.store(row ? row[primaryKey] : key, row);
          }
        }
        return values;
      });
    } catch (error) {
      _chunkUWWZT52Cjs.libLog.call(void 0, this.logger, "error", this.name, "Error fetching rows of the table: ", error);
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
        if (value !== void 0) {
          break;
        }
        value = source.get(normalizedKey);
      }
      value ??= entry == null ? void 0 : entry.value;
      if (value !== void 0 && value !== null) {
        rows.push(value);
      }
    }
    return rows;
  }
  memberKeys() {
    return [...this.members.values()].map((member) => member.key);
  }
  // READS
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
    if (syncing) {
      await syncing;
    }
    this.renew(this.normalizeKey(key));
    return this.getOrSetDetailed(
      key,
      () => this.gate.selectFromTableByPrimaryKey(this.schema, key),
      options
    );
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
    if (state.queued) {
      return state.queued;
    }
    const current = state;
    const start = () => {
      const running = this.fetchRow(key);
      current.running = running;
      current.queued = void 0;
      const settle = () => {
        if (current.running === running) {
          current.running = void 0;
          if (!current.queued) {
            this.refreshes.delete(normalizedKey);
          }
        }
      };
      void running.then(settle, settle);
      return running;
    };
    if (!current.running) {
      return start();
    }
    const noop = () => {
    };
    current.queued = current.running.then(noop, noop).then(start);
    return current.queued;
  }
  fetchRow(key) {
    return this.flowControl.executeWithTimeout(async (signal) => {
      const read = this.beginRead();
      const value = await this.gate.selectFromTableByPrimaryKey(this.schema, key);
      if (!signal.aborted) {
        read.storeFetched(key, value);
      }
      return value;
    });
  }
  /** Re-fetches a key; if the query fails, expires it instead. */
  async refreshKey(key) {
    try {
      await this.refreshRow(key);
    } catch (error) {
      _chunkUWWZT52Cjs.libLog.call(void 0, 
        this.logger,
        "error",
        this.name,
        `Error updating cache key "${String(key)}" after a change: `,
        error
      );
      this.markInvalid(key);
    }
  }
  hasReadInFlight(normalizedKey) {
    return super.hasReadInFlight(normalizedKey) || this.rowFetches.has(normalizedKey) || this.refreshes.has(normalizedKey);
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
    if (syncing) {
      await syncing;
    }
    if (keys) {
      const uniqueKeys = [...new Map(keys.map((key) => [this.normalizeKey(key), key])).values()];
      const fetched2 = await this.fetchRows(this.staleKeys(uniqueKeys));
      return this.rowsOf(uniqueKeys, fetched2);
    }
    let loaded;
    if (!this.isTableLoaded()) {
      loaded = await this.loadTable();
    }
    let staleKeys = this.staleKeys(this.memberKeys(), loaded);
    if (staleKeys.length > this.members.size * FULL_LOAD_RATIO) {
      loaded = await this.loadTable();
      staleKeys = this.staleKeys(this.memberKeys(), loaded);
    }
    const fetched = await this.fetchRows(staleKeys);
    return this.rowsOf(this.memberKeys(), fetched, _nullishCoalesce(loaded, () => ( /* @__PURE__ */ new Map())));
  }
  /**
   * The key of a notified id: the key of the cached entry or of the known row, so that it keeps
   * its original type (a notification may carry a numeric key as a string, or the other way
   * around), or else the id converted to a number when the schema declares the primary key as a
   * `number` column.
   */
  resolveNotifiedKey(id) {
    var _a, _b, _c;
    const normalizedKey = String(id);
    const known = _nullishCoalesce(((_a = this.store.get(normalizedKey)) == null ? void 0 : _a.key), () => ( ((_b = this.members.get(normalizedKey)) == null ? void 0 : _b.key)));
    if (known !== void 0) {
      return known;
    }
    const { cols, primaryKey } = this.schema;
    if (typeof id === "string" && ((_c = cols[primaryKey]) == null ? void 0 : _c.type) === "number") {
      const numeric = Number(id);
      if (Number.isFinite(numeric) && String(numeric) === id) {
        return numeric;
      }
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
    if (this.disposed) {
      return;
    }
    this.releaseSingleton();
    await super.dispose();
    this.members.clear();
    this.ownWrites.clear();
    await this.sync.dispose();
  }
  // WRITES
  getItemPrimaryKeyValue(item) {
    const keyValue = item[this.schema.primaryKey];
    if (keyValue === void 0) {
      throw lilypadMissingPrimaryKeyError(this.schema, "item");
    }
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
    if (this.disposed) {
      return;
    }
    const normalizedKey = this.normalizeKey(key);
    const entry = this.store.get(normalizedKey);
    if (entry && entry.ticket > startTicket) {
      this.markInvalid(key, { invalidateBulkSync: false });
      return;
    }
    this.setValue(key, value);
    const stored = this.store.get(normalizedKey);
    if (xid !== void 0 && stored && this.sync.seesOwnWrites) {
      this.recordOwnWrite(normalizedKey, xid, stored.ticket);
    }
  }
  /**
   * Inserts the item in the database and caches the row returned by the database.
   * With `primaryKeyShouldAutoDetermine`, the primary key of `item` can be omitted: the cached row
   * holds the one generated by the database.
   *
   * @returns The created row, or `null` if the schema's `selectSanitizationFn` discards it.
   * @throws If the cache is disposed.
   */
  async sqlCreate(item) {
    this.assertNotDisposed();
    const startTicket = this.nextTicket();
    const { row, xid } = await this.gate.insertToTable(this.schema, item);
    if (row !== null) {
      const key = this.getItemPrimaryKeyValue(row);
      this.storeWritten(key, row, startTicket, xid);
      this.emitInvalidation("write", [key]);
    }
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
   * @throws If the cache is disposed.
   */
  async sqlDelete(key) {
    this.assertNotDisposed();
    const startTicket = this.nextTicket();
    const { xid } = await this.gate.deleteFromTable(this.schema, key);
    this.storeWritten(key, null, startTicket, xid);
    this.emitInvalidation("write", [key]);
  }
}, _class8);














exports.LILYPAD_DEFAULT_CHANGELOG_TABLE = LILYPAD_DEFAULT_CHANGELOG_TABLE; exports.LilypadDbCache = LilypadDbCache; exports.LilypadDbGate = LilypadDbGate; exports.LilypadDbNotFoundError = LilypadDbNotFoundError; exports.LilypadSchemaCheckError = LilypadSchemaCheckError; exports.checkLilypadSchema = checkLilypadSchema; exports.lilypadChangelogSql = lilypadChangelogSql; exports.lilypadChangelogTriggerSql = lilypadChangelogTriggerSql; exports.lilypadCursorCovers = lilypadCursorCovers; exports.lilypadServerlessPool = lilypadServerlessPool; exports.pruneLilypadChangelog = pruneLilypadChangelog; exports.readLilypadChanges = readLilypadChanges; exports.readLilypadChangesBatch = readLilypadChangesBatch;
//# sourceMappingURL=db.js.map