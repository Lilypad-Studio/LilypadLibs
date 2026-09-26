"use strict";Object.defineProperty(exports, "__esModule", {value: true}); function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; } function _nullishCoalesce(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return rhsFn(); } } var _class; var _class2; var _class3;


var _chunkV2P7JKUSjs = require('./chunks/chunk-V2P7JKUS.js');
require('./chunks/chunk-UTHHG4QQ.js');


var _chunkLL3KVXOKjs = require('./chunks/chunk-LL3KVXOK.js');



var _chunkGU4ZU4STjs = require('./chunks/chunk-GU4ZU4ST.js');

// src/dbGate/LilypadDbGate.ts
var _crypto = require('crypto');
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
var SELECT_ALL_BATCH_SIZE = 1e3;
var PRIMARY_KEYS_BATCH_SIZE = 1e3;
var XID_COLUMN = "__lilypad_xid";
function lilypadMissingPrimaryKeyError(schema, context) {
  return new Error(
    `Primary key "${String(schema.primaryKey)}" is missing in the ${context} data for table "${schema.tableName}".`
  );
}
var LilypadDbGate = (_class = class _LilypadDbGate {
  __init() {this.id = `LilypadDbGate-${globalThis.crypto.randomUUID()}`}
  
  
  
  
  __init2() {this.listeners = /* @__PURE__ */ new Map()}
  
  constructor(options) {;_class.prototype.__init.call(this);_class.prototype.__init2.call(this);
    this.logger = options.logger;
    this.listenerConnectionString = options.listenerConnectionString || options.connectionString;
    this.sql = _postgres2.default.call(void 0, options.connectionString, {
      prepare: false,
      ...toPostgresPoolOptions(options.pool),
      ...options.statementTimeout !== void 0 && {
        connection: { statement_timeout: options.statementTimeout }
      }
    });
  }
  /**
   * Creates a gate and registers the listeners of `options.listen`.
   * Without listeners it opens no connection: the pool connects on the first query, so creating a
   * gate at module level does not reach the database (e.g. during a build).
   * With `singleton: true`, a later call with the same identifier returns the existing gate and
   * ignores its own options (a warning is logged if they differ).
   */
  static async create(options) {
    return _chunkGU4ZU4STjs.createLilypadSingletonAbleAsync.call(void 0, 
      "LilypadDbGate",
      options,
      async (registryKey) => {
        const instance = await _LilypadDbGate.initializeNew(options);
        instance.singletonIdentifier = registryKey;
        return instance;
      },
      {
        // Hashed: the connection strings contain credentials
        value: _crypto.createHash.call(void 0, "sha256").update(
          JSON.stringify([
            options.connectionString,
            options.listenerConnectionString,
            options.statementTimeout,
            options.pool
          ])
        ).digest("hex"),
        onMismatch: () => _chunkV2P7JKUSjs.libLog.call(void 0, 
          options.logger,
          "warn",
          `LilypadDbGate singleton "${options.singleton ? options.singletonIdentifier : ""}" already exists with different connection options: the new options are ignored.`
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
   */
  async selectAllFromTable(options) {
    const typedResults = [];
    const cursor = this.sql`
      SELECT ${this.selectedColumns(options)} FROM ${this.sql(options.tableName)}
    `.cursor(SELECT_ALL_BATCH_SIZE);
    for await (const rows of cursor) {
      for (const row of rows) {
        const typedRow = this.mapRow(options, row);
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
  async selectFromTableByPrimaryKeys(options, primaryKeyValues) {
    const typedRows = [];
    for (let start = 0; start < primaryKeyValues.length; start += PRIMARY_KEYS_BATCH_SIZE) {
      const batch = primaryKeyValues.slice(start, start + PRIMARY_KEYS_BATCH_SIZE);
      const results = await this.sql`
        SELECT ${this.selectedColumns(options)} FROM ${this.sql(options.tableName)}
        WHERE ${this.sql(String(options.primaryKey))} IN ${this.sql(batch)}
      `;
      for (const row of results) {
        const typedRow = this.mapRow(options, row);
        if (typedRow !== null) {
          typedRows.push(typedRow);
        }
      }
    }
    return typedRows;
  }
  async selectFromTableByPrimaryKey(options, primaryKeyValue) {
    const results = await this.sql`
      SELECT ${this.selectedColumns(options)} FROM ${this.sql(options.tableName)}
      WHERE ${this.sql(String(options.primaryKey))} = ${primaryKeyValue}
    `;
    const [row] = results;
    return row ? this.mapRow(options, row) : null;
  }
  /**
   * Inserts a row.
   *
   * @returns The row as stored by the database, including generated columns such as an
   * auto-determined primary key, or `null` if the `selectSanitizationFn` discards it.
   */
  async insertToTable(options, data) {
    return (await this.insertToTableDetailed(options, data)).row;
  }
  /** Like {@link insertToTable}, but also returns the id of the transaction that wrote the row. */
  async insertToTableDetailed(options, data) {
    const { data: insertData, columns } = this.prepareWrite(options, data, "insert");
    const results = await this.sql`
      INSERT INTO ${this.sql(options.tableName)} ${this.sql(insertData, columns)}
      RETURNING *, txid_current()::text AS ${this.sql(XID_COLUMN)}
    `;
    return this.writeResult(options, results);
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
   * @returns The row as stored by the database, or `null` if the `selectSanitizationFn` discards it.
   * @throws If no row with that primary key exists.
   */
  async updateToTable(options, data) {
    return (await this.updateToTableDetailed(options, data)).row;
  }
  /** Like {@link updateToTable}, but also returns the id of the transaction that wrote the row. */
  async updateToTableDetailed(options, data) {
    const {
      data: updateData,
      columns,
      primaryKeyValue
    } = this.prepareWrite(options, data, "update");
    const results = await this.sql`
      UPDATE ${this.sql(options.tableName)}
      SET ${this.sql(updateData, columns)}
      WHERE ${this.sql(String(options.primaryKey))} = ${primaryKeyValue}
      RETURNING *, txid_current()::text AS ${this.sql(XID_COLUMN)}
    `;
    if (results.count === 0) {
      throw new Error(
        `No row with primary key "${String(primaryKeyValue)}" found in table "${options.tableName}".`
      );
    }
    return this.writeResult(options, results);
  }
  async deleteFromTable(options, primaryKeyValue) {
    await this.deleteFromTableDetailed(options, primaryKeyValue);
  }
  /**
   * Like {@link deleteFromTable}, but also returns the id of the transaction that deleted the row
   * (`undefined` when no row had this primary key).
   */
  async deleteFromTableDetailed(options, primaryKeyValue) {
    const results = await this.sql`
      DELETE FROM ${this.sql(options.tableName)}
      WHERE ${this.sql(String(options.primaryKey))} = ${primaryKeyValue}
      RETURNING txid_current()::text AS ${this.sql(XID_COLUMN)}
    `;
    const [deleted] = results;
    return deleted ? { xid: BigInt(deleted[XID_COLUMN]) } : {};
  }
  // LISTENER MANAGEMENT
  /**
   * Retrieves the singleton listener database connection.
   *
   * If the listener connection does not already exist, this method initializes it
   * using the provided connection string and specific connection options:
   * - `max`: Limits the pool to a single connection.
   * - `idle_timeout`: Disables idle timeout for the connection.
   * - `max_lifetime`: Disables maximum lifetime for the connection.
   *
   * @returns The singleton listener database connection instance.
   */
  getListenerConnection() {
    if (!this.listenerConnection) {
      this.listenerConnection = _postgres2.default.call(void 0, this.listenerConnectionString, {
        max: 1,
        idle_timeout: 0,
        max_lifetime: null
      });
    }
    return this.listenerConnection;
  }
  /**
   * Starts listening on the specified channel.
   *
   * The listener entry is registered immediately, before LISTEN is active, so that concurrent
   * `addListener` calls for the same channel share it and await the same `ready` promise.
   * If LISTEN fails, the entry is removed, so that a later `addListener` call retries it.
   *
   * @param channel - The name of the channel to listen on.
   * @returns The listener entry of the channel.
   */
  initializeListener(channel) {
    _chunkV2P7JKUSjs.libLog.call(void 0, this.logger, "debug", this.id, `Initializing listener for channel "${channel}".`);
    const listener = {
      callbacks: /* @__PURE__ */ new Map(),
      listening: false,
      ready: this.getListenerConnection().listen(
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
      _chunkV2P7JKUSjs.libLog.call(void 0, 
        this.logger,
        "error",
        this.id,
        `Error in listener callback "${callbackId}" for channel "${channel}":`,
        error
      );
    });
  }
  /**
   * Executes all registered listener callbacks for a given channel, passing the provided payload to each callback.
   *
   * @param channel - The name of the channel whose listener callbacks should be executed.
   * @param payload - The data to pass to each listener callback.
   */
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
    _chunkV2P7JKUSjs.libLog.call(void 0, 
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
   * Adds a listener callback for a specified channel.
   *
   * If the channel does not already have a listener, it initializes one.
   * The callback is associated with the provided `callbackId`: adding a callback with an existing
   * `callbackId` on the same channel replaces the previous one.
   *
   * @param params - An object containing:
   *   @param params.channel - The name of the channel to listen to.
   *   @param params.callbackId - A unique identifier for the callback.
   *   @param params.callback - The callback function to be invoked for the channel.
   *   @param params.onReconnect - Optional function called when LISTEN is re-established after a reconnection.
   *
   * @returns A promise that resolves once LISTEN is active on the channel.
   * @throws If LISTEN fails; in that case the callback is not registered.
   */
  async addListener(identifier) {
    const { channel, callbackId } = identifier;
    _chunkV2P7JKUSjs.libLog.call(void 0, 
      this.logger,
      "debug",
      this.id,
      `Adding listener for channel "${channel}" with callback ID "${callbackId}".`
    );
    const listener = _nullishCoalesce(this.listeners.get(channel), () => ( this.initializeListener(channel)));
    listener.callbacks.set(callbackId, identifier);
    await listener.ready;
    _chunkV2P7JKUSjs.libLog.call(void 0, 
      this.logger,
      "debug",
      this.id,
      `Listener for channel "${channel}" has ${listener.callbacks.size} callbacks.`
    );
  }
  /**
   * Removes a listener callback. When the channel has no callbacks left, it stops listening to it.
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
      const unlisten = await listener.ready;
      await unlisten();
    }
    return true;
  }
  async close() {
    var _a;
    this.listeners.clear();
    if (this.singletonIdentifier !== void 0) {
      _chunkGU4ZU4STjs.removeLilypadSingletonInstance.call(void 0, this.singletonIdentifier);
      this.singletonIdentifier = void 0;
    }
    await ((_a = this.listenerConnection) == null ? void 0 : _a.end());
    await this.sql.end();
  }
}, _class);

// src/dbGate/LilypadChangelog.ts
var LILYPAD_DEFAULT_CHANGELOG_TABLE = "lilypad_cache_changes";
var LILYPAD_DEFAULT_NOTIFY_CHANNEL = "cache_events";
var LILYPAD_CHANGELOG_VERSION = 3;
var LILYPAD_CHANGELOG_VERSION_PREFIX = "lilypad-changelog:";
function quoteIdentifier(identifier) {
  return identifier.split(".").map((part) => `"${part.replace(/"/g, '""')}"`).join(".");
}
function quoteLiteral(value) {
  return `'${value.replace(/'/g, "''")}'`;
}
function triggerFunctionName(changelogTable) {
  return `${changelogTable.replace(/\W/g, "_")}_record`;
}
function changelogTriggerNames(table) {
  const prefix = table.replace(/\W/g, "_");
  return { row: `${prefix}_lilypad_changes`, truncate: `${prefix}_lilypad_truncate` };
}
function lilypadChangelogSql(options = {}) {
  const table = _nullishCoalesce(options.table, () => ( LILYPAD_DEFAULT_CHANGELOG_TABLE));
  const channel = _nullishCoalesce(options.notifyChannel, () => ( LILYPAD_DEFAULT_NOTIFY_CHANNEL));
  const quotedTable = quoteIdentifier(table);
  const indexPrefix = table.replace(/\W/g, "_");
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
async function readLilypadChanges(gate, options) {
  const { changes, cursor } = await readLilypadChangesBatch(gate, {
    requests: [{ tableName: options.tableName, since: options.since }],
    changelogTable: options.changelogTable
  });
  return { changes: _nullishCoalesce(changes[0], () => ( [])), cursor };
}
async function readLilypadChangesBatch(gate, options) {
  var _a, _b;
  const sql = gate.sql;
  const changelogTable = sql(_nullishCoalesce(options.changelogTable, () => ( LILYPAD_DEFAULT_CHANGELOG_TABLE)));
  const tableRefs = options.requests.map((request) => quoteIdentifier(request.tableName));
  const cursors = options.requests.map(
    (request) => "cursor" in request.since ? request.since.cursor.toString() : ""
  );
  const lookbacks = options.requests.map(
    (request) => "lookback" in request.since ? String(request.since.lookback / 1e3) : "0"
  );
  const rows = await sql`
    WITH snapshot AS (SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS next_cursor),
    requests AS (
      SELECT (r.ordinality - 1)::int AS request, r.table_ref,
        NULLIF(r.since_cursor, '')::xid8 AS since_cursor, r.lookback_secs::float8 AS lookback_secs
      FROM unnest(
        ${sql.array(tableRefs)}::text[], ${sql.array(cursors)}::text[], ${sql.array(lookbacks)}::text[]
      ) WITH ORDINALITY AS r(table_ref, since_cursor, lookback_secs, ordinality)
    ),
    targets AS (
      SELECT requests.*, n.nspname AS schema_name, t.relname AS rel_name
      FROM requests
      JOIN pg_class t ON t.oid = to_regclass(requests.table_ref)
      JOIN pg_namespace n ON n.oid = t.relnamespace
    )
    SELECT snapshot.next_cursor, targets.request, c.id::text AS id, c.xid::text AS xid, c.row_id, c.op
    FROM snapshot
    LEFT JOIN targets ON true
    LEFT JOIN LATERAL (
      SELECT c.id, c.xid, c.row_id, c.op FROM ${changelogTable} c
      WHERE targets.since_cursor IS NOT NULL
        AND c.table_name = targets.rel_name
        AND (c.table_schema = targets.schema_name OR c.table_schema IS NULL)
        AND c.xid >= targets.since_cursor
      UNION ALL
      SELECT c.id, c.xid, c.row_id, c.op FROM ${changelogTable} c
      WHERE targets.since_cursor IS NULL
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
  const nextCursor = (_b = rows[0]) == null ? void 0 : _b.next_cursor;
  if (typeof nextCursor !== "string") {
    throw new Error("Reading the changelog returned no snapshot.");
  }
  return { changes, cursor: BigInt(nextCursor) };
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
var LilypadChangelogReader = (_class2 = class {
  constructor(gate, changelogTable) {;_class2.prototype.__init3.call(this);
    this.gate = gate;
    this.changelogTable = changelogTable;
  }
  __init3() {this.subscribers = /* @__PURE__ */ new Set()}
  
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
}, _class2);
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
async function checkLilypadSchema(gate, options) {
  var _a, _b;
  const sql = gate.sql;
  const changelogTable = options.changelog === false ? void 0 : _nullishCoalesce(((_a = options.changelog) == null ? void 0 : _a.table), () => ( LILYPAD_DEFAULT_CHANGELOG_TABLE));
  const notifyChannel = _nullishCoalesce(options.notifyChannel, () => ( false));
  const customChangelogTable = changelogTable === LILYPAD_DEFAULT_CHANGELOG_TABLE ? void 0 : changelogTable;
  const functionSignature = `${quoteIdentifier(
    triggerFunctionName(_nullishCoalesce(changelogTable, () => ( LILYPAD_DEFAULT_CHANGELOG_TABLE)))
  )}()`;
  const problems = [];
  const [database] = await sql`
    SELECT
      current_setting('server_version_num')::int AS version,
      to_regclass(${quoteIdentifier(_nullishCoalesce(changelogTable, () => ( LILYPAD_DEFAULT_CHANGELOG_TABLE)))}::text)
        IS NOT NULL AS has_changelog_table,
      EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = to_regclass(${quoteIdentifier(_nullishCoalesce(changelogTable, () => ( LILYPAD_DEFAULT_CHANGELOG_TABLE)))}::text)
          AND attname = 'table_schema' AND NOT attisdropped
      ) AS has_schema_column,
      to_regprocedure(${functionSignature}::text) IS NOT NULL AS has_function,
      obj_description(to_regprocedure(${functionSignature}::text), 'pg_proc') AS function_comment
  `;
  if (!database) {
    throw new Error("Reading the database settings returned no row.");
  }
  if (database.version < 13e4) {
    problems.push({
      code: "unsupported-version",
      message: `PostgreSQL ${database.version} is too old: the changelog needs PostgreSQL 13 or later.`
    });
  }
  if (changelogTable !== void 0) {
    const changelogSql = lilypadChangelogSql({ table: customChangelogTable });
    if (!database.has_changelog_table || !database.has_function) {
      problems.push({
        code: "missing-changelog",
        message: !database.has_changelog_table ? `The changelog table "${changelogTable}" does not exist.` : `The changelog trigger function ${functionSignature} does not exist.`,
        fix: changelogSql
      });
    }
    const comment = _nullishCoalesce(database.function_comment, () => ( ""));
    const version = comment.startsWith(LILYPAD_CHANGELOG_VERSION_PREFIX) ? Number(comment.slice(LILYPAD_CHANGELOG_VERSION_PREFIX.length)) : 1;
    if (database.has_changelog_table && !database.has_schema_column || database.has_function && version < LILYPAD_CHANGELOG_VERSION) {
      problems.push({
        code: "outdated-changelog",
        message: `The changelog "${changelogTable}" was installed by an older version of the library (version ${version}, expected ${LILYPAD_CHANGELOG_VERSION}).`,
        fix: changelogSql
      });
    }
  }
  const tables = [];
  for (const { table, primaryKey } of options.tables) {
    const [found] = await sql`
      SELECT
        n.nspname AS schema_name,
        (
          SELECT coalesce(json_agg(json_build_object(
            'changelog', tr.tgfoid = to_regprocedure(${functionSignature}::text)::oid,
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
    if (!found) {
      tables.push({ table, schema: null });
      problems.push({
        code: "missing-table",
        table,
        message: `The table "${table}" does not exist.`
      });
      continue;
    }
    tables.push({ table, schema: found.schema_name });
    const triggers = typeof found.triggers === "string" ? JSON.parse(found.triggers) : found.triggers;
    if (changelogTable !== void 0) {
      const fix = lilypadChangelogTriggerSql({
        table,
        primaryKey,
        changelogTable: customChangelogTable
      });
      const working = triggers.filter(
        (trigger) => trigger.changelog && trigger.enabled && (trigger.type & CHANGELOG_TRIGGER_TYPE) === CHANGELOG_TRIGGER_TYPE
      );
      if (working.length === 0) {
        problems.push({
          code: "missing-changelog-trigger",
          table,
          message: triggers.some((trigger) => trigger.changelog) ? `The changelog trigger of "${table}" is disabled or does not fire on each INSERT, UPDATE and DELETE row.` : `The table "${table}" has no changelog trigger: its changes are not recorded.`,
          fix
        });
      } else if (!working.some((trigger) => trigger.args.split("\\000")[0] === primaryKey)) {
        problems.push({
          code: "wrong-trigger-primary-key",
          table,
          message: `The changelog trigger of "${table}" records the column "${(_b = working[0]) == null ? void 0 : _b.args.split("\\000")[0]}", not the primary key "${primaryKey}".`,
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
      const fix = lilypadChangelogSql({ table: customChangelogTable, notifyChannel }) + lilypadChangelogTriggerSql({ table, primaryKey, changelogTable: customChangelogTable });
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
  }
  return { ok: problems.length === 0, problems, tables };
}

// src/cache/LilypadDbCache.ts
var DEFAULT_CHANGELOG_MAX_GAP = 60 * 60 * 1e3;
var DEFAULT_MAX_AGE = 60 * 60 * 1e3;
var FULL_LOAD_RATIO = 0.25;
var OWN_WRITE_RETENTION = 10 * 60 * 1e3;
var MAX_RETRY_DELAY = 6e4;
function retryDelay(failures, base) {
  return Math.max(base, Math.min(base * 2 ** (failures - 1), MAX_RETRY_DELAY));
}
var LilypadDbCache = (_class3 = class _LilypadDbCache extends _chunkV2P7JKUSjs.LilypadCache_default {
  
  
  
  /** Whether the default listener updates the cache (not only `onNotification`). */
  __init4() {this.listenAppliesChanges = false}
  
  __init5() {this.listenFailures = 0}
  __init6() {this.listenRetryAt = 0}
  
  /**
   * The schema of the table: from `tableName` when it is qualified, otherwise as resolved by the
   * schema check. Notifications from another schema are ignored; while it is unknown, notifications
   * of the table in any schema are applied.
   */
  
  /** The schema check, once it has run or while it runs; reset when it could not run. */
  
  __init7() {this.schemaCheckFailures = 0}
  __init8() {this.schemaCheckRetryAt = 0}
  /**
   * The keys of the rows of the table, as far as this instance knows. Each load of the table sets
   * them; the writes, the fetches and the changes keep them up to date. `getAll` returns these
   * rows, fetching only those it does not hold up to date. Tracked once the table has been loaded.
   */
  __init9() {this.members = /* @__PURE__ */ new Map()}
  /** When the last load of the table started, if one completed. */
  
  /** Loads started before this ticket (before a `TRUNCATE`) no longer tell which rows exist. */
  __init10() {this.membersFloor = 0}
  /** Receive the rows of the next load of the table (see `loadTable`). */
  __init11() {this.tableLoadWaiters = /* @__PURE__ */ new Set()}
  /** The queries of `fetchRows` in flight, by normalized key. */
  __init12() {this.rowFetches = /* @__PURE__ */ new Map()}
  /** The refreshes of `refresh` in flight, and the one queued after each (normalized keys). */
  __init13() {this.refreshes = /* @__PURE__ */ new Map()}
  /** Since when `LISTEN` delivers every change to this instance. */
  
  /** Since when the chain of changelog reads is unbroken. */
  
  /**
   * The writes of this instance, by normalized key: their transaction ids, and the ticket of the
   * entry the last one stored. While the entry holds it, the changes of these writes are already
   * reflected in it.
   */
  __init14() {this.ownWrites = /* @__PURE__ */ new Map()}
  // Changelog strategy state
  
  
  
  
  /** Changes already applied, by id, with their transaction id, until the cursor passes them. */
  __init15() {this.appliedChanges = /* @__PURE__ */ new Map()}
  __init16() {this.lastChangelogRead = 0}
  __init17() {this.changelogFailures = 0}
  __init18() {this.changelogRetryAt = 0}
  /**
   * Creates a cache and, with the `listen` strategy (unless `connect: 'lazy'`), registers its
   * database listener.
   * With `singleton: true`, a later call with the same identifier returns the existing cache and
   * ignores its own options (a warning is logged if the table or the TTL differ).
   *
   * @throws If the database listener cannot be registered (e.g. the database is unreachable).
   */
  static async create(options) {
    return _chunkGU4ZU4STjs.createLilypadSingletonAbleAsync.call(void 0, 
      "LilypadDbCache",
      options,
      async (registryKey) => {
        const cache = await _LilypadDbCache.initializeNew(options);
        cache.singletonIdentifier = registryKey;
        return cache;
      },
      {
        value: JSON.stringify([options.dbGate.schema.tableName, options.ttl]),
        onMismatch: () => _chunkV2P7JKUSjs.libLog.call(void 0, 
          options.logger,
          "warn",
          `LilypadDbCache singleton "${options.singleton ? options.singletonIdentifier : ""}" already exists with a different table or TTL: the new options are ignored.`
        )
      }
    );
  }
  static async initializeNew(options) {
    const cache = new _LilypadDbCache(options);
    try {
      if (cache.schemaVerification() === "throw") {
        await cache.verifySchema();
      }
      if (cache.sync.strategy === "listen" && cache.sync.connect !== "lazy") {
        await cache.startListening();
      }
    } catch (error) {
      await cache.dispose();
      throw error;
    }
    return cache;
  }
  constructor(options) {
    super({ ...options, name: _nullishCoalesce(options.name, () => ( options.dbGate.schema.tableName)) });_class3.prototype.__init4.call(this);_class3.prototype.__init5.call(this);_class3.prototype.__init6.call(this);_class3.prototype.__init7.call(this);_class3.prototype.__init8.call(this);_class3.prototype.__init9.call(this);_class3.prototype.__init10.call(this);_class3.prototype.__init11.call(this);_class3.prototype.__init12.call(this);_class3.prototype.__init13.call(this);_class3.prototype.__init14.call(this);_class3.prototype.__init15.call(this);_class3.prototype.__init16.call(this);_class3.prototype.__init17.call(this);_class3.prototype.__init18.call(this);;
    this.dbGate = options.dbGate;
    this.bulkSyncFn = async (signal) => {
      const read = this.beginRead();
      const entries = (await this.dbGate.gate.selectAllFromTable(this.dbGate.schema)).map(
        (item) => [item[this.dbGate.schema.primaryKey], item]
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
    };
    this.sync = _nullishCoalesce(options.sync, () => ( { strategy: "listen" }));
    const tableNameParts = this.dbGate.schema.tableName.split(".");
    if (tableNameParts.length > 1) {
      this.tableSchema = tableNameParts[tableNameParts.length - 2];
    }
    if (this.sync.strategy === "listen") {
      this.listenAppliesChanges = this.sync.applyChanges !== false;
      this.defaultDbListener = this.getDefaultDbListener(this.sync);
    }
    if (this.sync.strategy === "changelog") {
      this.changelogReader = getLilypadChangelogReader(this.dbGate.gate, this.sync.table);
      this.changelogSubscriber = {
        request: (readAt) => this.changelogRequest(readAt),
        apply: (result, request) => this.applyChangelog(result, "cursor" in request.since)
      };
      this.unsubscribeChangelog = this.changelogReader.subscribe(this.changelogSubscriber);
    }
    _chunkV2P7JKUSjs.libLog.call(void 0, 
      this.logger,
      "debug",
      this.name,
      `LilypadDbCache initialized for table "${this.dbGate.schema.tableName}" (sync: ${this.sync.strategy})`
    );
  }
  // SCHEMA VERIFICATION
  schemaVerification() {
    return this.sync.strategy === "none" ? "off" : _nullishCoalesce(this.sync.verify, () => ( "warn"));
  }
  /**
   * Checks once that the database has the triggers the sync strategy needs, and resolves the schema
   * of the table. With `verify: 'warn'` it never rejects: problems and failures are logged. A check
   * that could not run (e.g. the database was unreachable) is forgotten, so that a later read runs
   * it again (see {@link checkSchemaInBackground}); a check that found problems is not repeated.
   *
   * @throws A `LilypadSchemaCheckError` with `verify: 'throw'`, or the error of the check.
   */
  verifySchema() {
    const mode = this.schemaVerification();
    if (mode === "off") {
      return Promise.resolve();
    }
    if (!this.schemaCheck) {
      const check = this.runSchemaCheck(mode).then((ran) => {
        if (!ran && this.schemaCheck === check) {
          this.schemaCheck = void 0;
        }
      });
      this.schemaCheck = check;
    }
    return this.schemaCheck;
  }
  /**
   * Runs the schema check in the background, unless it has already run, is running, or failed less
   * than a backoff ago. Reads call it to retry a check that could not run.
   */
  checkSchemaInBackground(now) {
    if (this.schemaCheck || now < this.schemaCheckRetryAt || this.schemaVerification() === "off") {
      return;
    }
    _chunkLL3KVXOKjs.runInBackground.call(void 0, this.platform, this.verifySchema(), () => {
    });
  }
  /** @returns `false` if the check could not run (with `verify: 'warn'`; `throw` rejects). */
  async runSchemaCheck(mode) {
    var _a, _b;
    const { tableName, primaryKey } = this.dbGate.schema;
    const subject = `LilypadDbCache "${tableName}" (sync: ${this.sync.strategy})`;
    try {
      const result = await checkLilypadSchema(this.dbGate.gate, {
        tables: [{ table: tableName, primaryKey: String(primaryKey) }],
        changelog: this.sync.strategy === "changelog" ? { table: this.sync.table } : false,
        notifyChannel: this.sync.strategy === "listen" ? LILYPAD_DEFAULT_NOTIFY_CHANNEL : false
      });
      this.tableSchema = _nullishCoalesce(((_a = result.tables[0]) == null ? void 0 : _a.schema), () => ( this.tableSchema));
      this.schemaCheckFailures = 0;
      this.schemaCheckRetryAt = 0;
      if (result.ok) {
        return true;
      }
      if (mode === "throw") {
        throw new LilypadSchemaCheckError(subject, result.problems);
      }
      const message = formatLilypadSchemaProblems(subject, result.problems);
      if ((_b = this.logger) == null ? void 0 : _b.warn) {
        _chunkV2P7JKUSjs.libLog.call(void 0, this.logger, "warn", this.name, message);
      } else {
        console.warn(message);
      }
      return true;
    } catch (error) {
      if (mode === "throw") {
        throw error;
      }
      this.schemaCheckFailures++;
      this.schemaCheckRetryAt = Date.now() + retryDelay(this.schemaCheckFailures, 1e3);
      _chunkV2P7JKUSjs.libLog.call(void 0, 
        this.logger,
        "warn",
        this.name,
        `${subject}: could not check the database schema:`,
        error
      );
      return false;
    }
  }
  // SYNCHRONIZATION
  /**
   * Registers the listener once, after the schema check (which resolves the schema of the table,
   * to ignore the notifications of other schemas). A failed registration is retried by the next
   * call, after a backoff for the lazy `LISTEN` of the reads.
   */
  startListening() {
    if (!this.listening && this.defaultDbListener) {
      const listener = this.defaultDbListener;
      this.listening = this.verifySchema().then(() => this.dbGate.gate.addListener(listener)).then(() => {
        this.listenFailures = 0;
        this.listenRetryAt = 0;
        if (this.listenAppliesChanges) {
          this.listenTrustedSince = Date.now();
        }
      }).catch((error) => {
        this.listening = void 0;
        this.listenFailures++;
        this.listenRetryAt = Date.now() + retryDelay(this.listenFailures, 1e3);
        throw error;
      });
    }
    return _nullishCoalesce(this.listening, () => ( Promise.resolve()));
  }
  /**
   * Since when this instance sees every change of the table, or `undefined` if it may miss some:
   * no sync, `LISTEN` not active (or it does not update the cache), or changelog not read for
   * longer than `maxGap`.
   */
  syncTrustedSince() {
    if (this.sync.strategy === "listen") {
      return this.listenTrustedSince;
    }
    if (this.sync.strategy === "changelog") {
      const maxGap = _nullishCoalesce(this.sync.maxGap, () => ( DEFAULT_CHANGELOG_MAX_GAP));
      if (this.changelogCursor === void 0 || Date.now() - this.lastChangelogRead > maxGap) {
        return void 0;
      }
      return this.changelogTrustedSince;
    }
    return void 0;
  }
  maxAge() {
    return this.sync.strategy === "none" ? 0 : _nullishCoalesce(this.sync.maxAge, () => ( DEFAULT_MAX_AGE));
  }
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
    const trustedSince = this.syncTrustedSince();
    const maxAge = this.maxAge();
    if (trustedSince === void 0 || entry.fetchedAt < trustedSince) {
      return;
    }
    if (now - entry.fetchedAt >= maxAge) {
      return;
    }
    this.store.set(normalizedKey, {
      ...entry,
      expirationTime: Math.min(now + this.defaultTtl, entry.fetchedAt + maxAge)
    });
  }
  /**
   * Brings the cache up to date with the changes made elsewhere before a read: starts a lazy
   * `LISTEN`, or reads the changelog when it is due. It never throws: a failure is logged, and
   * the read goes on with the cache as it is.
   *
   * @returns A promise to await, or `undefined` when there is nothing to wait for: the read then
   * goes on synchronously, as without synchronization.
   */
  syncBeforeRead() {
    const now = Date.now();
    if (this.sync.strategy === "listen") {
      if (this.listening) {
        this.checkSchemaInBackground(now);
        return void 0;
      }
      if (this.sync.connect !== "lazy" || now < this.listenRetryAt) {
        return void 0;
      }
      return this.startListening().catch((error) => {
        _chunkV2P7JKUSjs.libLog.call(void 0, this.logger, "error", this.name, "Error starting LISTEN for the cache:", error);
      });
    }
    if (this.sync.strategy !== "changelog") {
      return void 0;
    }
    if (now - this.lastChangelogRead < this.sync.pollInterval || now < this.changelogRetryAt) {
      return void 0;
    }
    this.checkSchemaInBackground(now);
    const reading = this.readChangelog();
    if (this.sync.poll === "background") {
      _chunkLL3KVXOKjs.runInBackground.call(void 0, this.platform, reading, () => {
      });
      return void 0;
    }
    return reading;
  }
  /**
   * Reads the changelog (with the other caches of the gate); errors are logged, and the next read
   * waits for a backoff.
   */
  readChangelog() {
    if (!this.changelogReader || !this.changelogSubscriber || this.sync.strategy !== "changelog") {
      return Promise.resolve();
    }
    const pollInterval = this.sync.pollInterval;
    return this.changelogReader.read(this.changelogSubscriber).catch((error) => {
      this.changelogFailures++;
      this.changelogRetryAt = Date.now() + retryDelay(this.changelogFailures, Math.max(pollInterval, 1e3));
      _chunkV2P7JKUSjs.libLog.call(void 0, this.logger, "error", this.name, "Error reading the changelog:", error);
    });
  }
  /** What to read for this cache: the changes since its cursor, or a lookback if it lost it. */
  changelogRequest(readAt) {
    const tableName = this.dbGate.schema.tableName;
    if (this.sync.strategy !== "changelog") {
      return { tableName, since: { lookback: 0 } };
    }
    const maxGap = _nullishCoalesce(this.sync.maxGap, () => ( DEFAULT_CHANGELOG_MAX_GAP));
    if (this.changelogCursor !== void 0 && readAt - this.lastChangelogRead <= maxGap) {
      return { tableName, since: { cursor: this.changelogCursor } };
    }
    const lookback = _nullishCoalesce(this.sync.lookback, () => ( this.defaultTtl + this.defaultStaleWhileRevalidate + 6e4));
    return { tableName, since: { lookback } };
  }
  /**
   * Applies a read of the changelog. Its errors are logged: the other caches read with it must not
   * be affected.
   *
   * @param trusted - Whether the read started from the cursor of this cache.
   */
  async applyChangelog({ changes, cursor, readAt }, trusted) {
    if (this.disposed) {
      return;
    }
    try {
      if (!trusted) {
        this.appliedChanges.clear();
        this.expireEverything();
        this.changelogTrustedSince = readAt;
      }
      const changedKeys = [];
      let truncated = false;
      for (const change of changes) {
        if (this.appliedChanges.has(change.id)) {
          continue;
        }
        this.appliedChanges.set(change.id, change.xid);
        if (change.op === "TRUNCATE") {
          changedKeys.push(...this.applyTruncate());
          truncated = true;
        } else {
          changedKeys.push(await this.applyChange(change.op, change.rowId, "lazy", change.xid));
        }
      }
      for (const [id, xid] of this.appliedChanges) {
        if (xid < cursor) {
          this.appliedChanges.delete(id);
        }
      }
      for (const [normalizedKey, own] of this.ownWrites) {
        for (const xid of own.xids) {
          if (xid < cursor) {
            own.xids.delete(xid);
          }
        }
        if (own.xids.size === 0) {
          this.ownWrites.delete(normalizedKey);
        }
      }
      this.changelogCursor = cursor;
      this.lastChangelogRead = readAt;
      this.changelogFailures = 0;
      this.changelogRetryAt = 0;
      this.emitInvalidation("changelog", changedKeys, { wholeCache: truncated });
    } catch (error) {
      _chunkV2P7JKUSjs.libLog.call(void 0, this.logger, "error", this.name, "Error applying the changelog:", error);
    }
  }
  /**
   * Applies a change of a row made elsewhere.
   * - A change made by a write of this instance whose result the entry still holds: nothing to do.
   * - DELETE: the key is cached as `null`.
   * - INSERT/UPDATE of a key held (or being read) by this instance: `eager` re-fetches it at once;
   *   `lazy` expires it with no query, which also discards a read in flight (it may predate the
   *   change): the next read fetches it.
   * - INSERT/UPDATE of any other key: no query. The shared level entry is removed.
   * In every INSERT/UPDATE case, the key is noted as a row of the table, which `getAll` returns.
   *
   * @param xid - The transaction that made the change, when known.
   * @returns The key of the changed row.
   */
  async applyChange(op, id, mode, xid) {
    const key = this.resolveNotifiedKey(id);
    if (xid !== void 0 && this.isOwnWrite(key, xid)) {
      return key;
    }
    if (op === "DELETE") {
      this.markDeleted(key);
      return key;
    }
    const normalizedKey = this.normalizeKey(key);
    const held = this.store.has(normalizedKey) || this.hasReadInFlight(normalizedKey);
    this.addMember(key);
    if (!held) {
      this.deleteShared(key);
      this.invalidateBulkSync();
    } else if (mode === "eager") {
      await this.refreshKey(key);
    } else {
      this.markInvalid(key);
    }
    return key;
  }
  /**
   * Applies a `TRUNCATE` of the table: every entry is expired, the reads started before are
   * discarded, the copies of the shared level produced before are ignored, and the table is known
   * to be empty (until the changes that follow).
   *
   * @returns The keys that were cached.
   */
  applyTruncate() {
    const keys = [...this.store.values()].map((entry) => entry.key);
    for (const key of keys) {
      this.deleteShared(key);
    }
    this.expireEverything();
    this.rejectSharedBefore(Date.now());
    this.membersFloor = this.nextTicket();
    this.members.clear();
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
   * trusted sync, less than `defaultBulkSyncTtl` ago.
   */
  isTableLoaded() {
    if (this.membersLoadedAt === void 0) {
      return false;
    }
    const trustedSince = this.syncTrustedSince();
    if (trustedSince !== void 0 && this.membersLoadedAt >= trustedSince) {
      return true;
    }
    return Date.now() < this.membersLoadedAt + this.defaultBulkSyncTtl;
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
        this.invalidateBulkSync();
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
  /** One read of `fetchRows`, bounded by `bulkSyncTimeout`. */
  async queryRows(keys) {
    const primaryKey = this.dbGate.schema.primaryKey;
    try {
      return await this.bulkSyncFlowControl.executeWithTimeout(async (signal) => {
        const read = this.beginRead();
        const rows = /* @__PURE__ */ new Map();
        for (const row of await this.dbGate.gate.selectFromTableByPrimaryKeys(
          this.dbGate.schema,
          keys
        )) {
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
      _chunkV2P7JKUSjs.libLog.call(void 0, this.logger, "error", this.name, "Error fetching rows of the table: ", error);
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
  // READS
  get(key, options = {}) {
    this.renew(this.normalizeKey(key));
    return super.get(key, options);
  }
  async getOrSetDetailed(key, valueFn, options = {}) {
    this.assertNotDisposed();
    const syncing = this.syncBeforeRead();
    if (syncing) {
      await syncing;
    }
    this.renew(this.normalizeKey(key));
    return super.getOrSetDetailed(key, valueFn, options);
  }
  /**
   * Retrieves a cached value by key, or fetches it from the database if not found in cache.
   * Concurrent calls for the same key share a single database query.
   *
   * @param key - The cache key to retrieve or fetch.
   * @param options - The `getOrSet` options (e.g. `staleWhileRevalidate`, `timeout`, `errorFn`).
   * @returns The row, or `null` if it does not exist.
   * @throws If the query fails and the options give no fallback value (see `getOrSet`).
   */
  async getOrFetch(key, options = {}) {
    return (await this.getOrFetchDetailed(key, options)).value;
  }
  /**
   * Like {@link getOrFetch}, but also tells where the value comes from and whether the last fetch
   * failed (see `getOrSetDetailed`).
   */
  getOrFetchDetailed(key, options = {}) {
    return this.getOrSetDetailed(
      key,
      () => this.dbGate.gate.selectFromTableByPrimaryKey(this.dbGate.schema, key),
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
   * @throws If the query fails or exceeds `flowControlTimeout`.
   */
  refresh(key) {
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
      const value = await this.dbGate.gate.selectFromTableByPrimaryKey(
        this.dbGate.schema,
        key
      );
      if (!signal.aborted) {
        read.storeFetched(key, value);
      }
      return value;
    });
  }
  /** Re-fetches a key; if the query fails, expires it instead. */
  async refreshKey(key) {
    try {
      await this.refresh(key);
    } catch (error) {
      _chunkV2P7JKUSjs.libLog.call(void 0, 
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
   * strategy, after `defaultBulkSyncTtl`). Then only the rows the cache does not hold up to date
   * are queried, by primary key: those changed elsewhere, inserted elsewhere, or expired. When
   * they are more than a quarter of the table, the whole table is loaded instead.
   * Rows are cached in the memory of this instance only, not in the shared level. With
   * `maxEntries` smaller than the table, the result is still complete, but most rows are queried
   * again at each call.
   *
   * @throws If the rows cannot be loaded, or the cache is disposed.
   */
  async getAll(keys) {
    this.assertNotDisposed();
    const syncing = this.syncBeforeRead();
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
  memberKeys() {
    return [...this.members.values()].map((member) => member.key);
  }
  /**
   * The key of a notified id: the key of the cached entry or of the known row, so that it keeps
   * its original type (a notification may carry a numeric key as a string, or the other way
   * around), or else the id converted to a number when the schema declares the primary key as a
   * `number` column.
   */
  resolveNotifiedKey(id) {
    var _a, _b, _c;
    const normalizedKey = this.normalizeKey(id);
    const known = _nullishCoalesce(((_a = this.store.get(normalizedKey)) == null ? void 0 : _a.key), () => ( ((_b = this.members.get(normalizedKey)) == null ? void 0 : _b.key)));
    if (known !== void 0) {
      return known;
    }
    const { cols, primaryKey } = this.dbGate.schema;
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
    this.set(key, null);
  }
  getDefaultDbListener(options) {
    return {
      channel: LILYPAD_DEFAULT_NOTIFY_CHANNEL,
      // The instance id keeps the callbacks of different caches on the same table apart
      callbackId: `lilypad_dbcache_${this.dbGate.schema.tableName}_${this.id}`,
      // Notifications sent while the connection was down are lost: every entry may be stale
      onReconnect: () => {
        this.expireEverything();
        if (this.listenAppliesChanges) {
          this.listenTrustedSince = Date.now();
        }
      },
      callback: async (payload) => {
        var _a;
        _chunkV2P7JKUSjs.libLog.call(void 0, 
          this.logger,
          "debug",
          this.name,
          "LilypadDbCache handler has received payload on cache_events channel:",
          payload
        );
        if (typeof payload !== "string") {
          return;
        }
        let parsedPayload;
        try {
          parsedPayload = JSON.parse(payload);
        } catch (e) {
          _chunkV2P7JKUSjs.libLog.call(void 0, this.logger, "error", this.name, "Error parsing cache_events payload:", e);
          return;
        }
        if (typeof parsedPayload !== "object" || parsedPayload === null) {
          return;
        }
        const { id, op } = parsedPayload;
        const truncate = op === "TRUNCATE";
        if (!truncate && (typeof id !== "string" && typeof id !== "number" || id === "") || !parsedPayload.table) {
          return;
        }
        if (!this.isNotificationForTable(parsedPayload)) {
          return;
        }
        _chunkV2P7JKUSjs.libLog.call(void 0, 
          this.logger,
          "debug",
          this.name,
          "LilypadDbCache handler is processing payload:",
          parsedPayload
        );
        if (this.listenAppliesChanges) {
          if (truncate) {
            this.emitInvalidation("notification", this.applyTruncate(), { wholeCache: true });
          } else {
            const key = await this.applyChange(
              op,
              id,
              "eager",
              _LilypadDbCache.parseXid(parsedPayload.xid)
            );
            this.emitInvalidation("notification", [key]);
          }
        }
        await ((_a = options.onNotification) == null ? void 0 : _a.call(options, parsedPayload));
      }
    };
  }
  static parseXid(xid) {
    return typeof xid === "string" && /^\d+$/.test(xid) ? BigInt(xid) : void 0;
  }
  /**
   * Whether a notification is about the table of this cache. `table` is the name without its
   * schema; `schema`, when the trigger sends it and the schema of the table is known, must match.
   */
  isNotificationForTable(payload) {
    if (payload.table !== this.dbGate.schema.tableName.split(".").pop()) {
      return false;
    }
    return typeof payload.schema !== "string" || this.tableSchema === void 0 || payload.schema === this.tableSchema;
  }
  /**
   * Disposes of the cache: stops its database listener and its changelog reads, removes it from
   * the singleton registry (if it was created as a singleton) and clears it.
   */
  async dispose() {
    var _a;
    if (this.singletonIdentifier !== void 0) {
      _chunkGU4ZU4STjs.removeLilypadSingletonInstance.call(void 0, this.singletonIdentifier);
      this.singletonIdentifier = void 0;
    }
    (_a = this.unsubscribeChangelog) == null ? void 0 : _a.call(this);
    this.unsubscribeChangelog = void 0;
    const listenerRemoval = this.defaultDbListener ? this.dbGate.gate.removeListener(
      this.defaultDbListener.channel,
      this.defaultDbListener.callbackId
    ) : void 0;
    await super.dispose();
    this.members.clear();
    this.ownWrites.clear();
    this.appliedChanges.clear();
    await listenerRemoval;
  }
  getItemPrimaryKeyValue(item) {
    const keyValue = item[this.dbGate.schema.primaryKey];
    if (keyValue === void 0) {
      throw lilypadMissingPrimaryKeyError(this.dbGate.schema, "item");
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
    const normalizedKey = this.normalizeKey(key);
    const entry = this.store.get(normalizedKey);
    if (entry && entry.ticket > startTicket) {
      this.markInvalid(key, { invalidateBulkSync: false });
      return;
    }
    this.set(key, value);
    const stored = this.store.get(normalizedKey);
    if (xid !== void 0 && stored && this.sync.strategy !== "none") {
      this.recordOwnWrite(normalizedKey, xid, stored.ticket);
    }
  }
  /**
   * Inserts the item in the database and caches the row returned by the database.
   * With `primaryKeyShouldAutoDetermine`, the primary key of `item` can be omitted: the cached row
   * holds the one generated by the database.
   *
   * @returns The created row, or `null` if the schema's `selectSanitizationFn` discards it.
   */
  async sqlCreate(item) {
    const startTicket = this.nextTicket();
    const { row, xid } = await this.dbGate.gate.insertToTableDetailed(
      this.dbGate.schema,
      item
    );
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
   * @throws If no row with the item's primary key exists.
   */
  async sqlUpdate(item) {
    const key = this.getItemPrimaryKeyValue(item);
    const startTicket = this.nextTicket();
    const { row, xid } = await this.dbGate.gate.updateToTableDetailed(
      this.dbGate.schema,
      item
    );
    this.storeWritten(key, row, startTicket, xid);
    this.emitInvalidation("write", [key]);
    return row;
  }
  /**
   * Deletes the row in the database, and caches the key as `null` (also for a protected key).
   */
  async sqlDelete(key) {
    const startTicket = this.nextTicket();
    const { xid } = await this.dbGate.gate.deleteFromTableDetailed(this.dbGate.schema, key);
    this.storeWritten(key, null, startTicket, xid);
    this.emitInvalidation("write", [key]);
  }
}, _class3);












exports.LILYPAD_DEFAULT_CHANGELOG_TABLE = LILYPAD_DEFAULT_CHANGELOG_TABLE; exports.LilypadDbCache = LilypadDbCache; exports.LilypadDbGate = LilypadDbGate; exports.LilypadSchemaCheckError = LilypadSchemaCheckError; exports.checkLilypadSchema = checkLilypadSchema; exports.lilypadChangelogSql = lilypadChangelogSql; exports.lilypadChangelogTriggerSql = lilypadChangelogTriggerSql; exports.lilypadServerlessPool = lilypadServerlessPool; exports.pruneLilypadChangelog = pruneLilypadChangelog; exports.readLilypadChanges = readLilypadChanges; exports.readLilypadChangesBatch = readLilypadChangesBatch;
//# sourceMappingURL=db.js.map