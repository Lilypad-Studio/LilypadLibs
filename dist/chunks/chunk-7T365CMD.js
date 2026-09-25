"use strict";Object.defineProperty(exports, "__esModule", {value: true}); function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; } function _nullishCoalesce(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return rhsFn(); } } var _class; var _class2;

var _chunk7QJ33PAPjs = require('./chunk-7QJ33PAP.js');


var _chunkLL3KVXOKjs = require('./chunk-LL3KVXOK.js');



var _chunkGU4ZU4STjs = require('./chunk-GU4ZU4ST.js');

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
        onMismatch: () => {
          var _a;
          return void ((_a = options.logger) == null ? void 0 : _a.warn(
            `LilypadDbGate singleton "${options.singleton ? options.singletonIdentifier : ""}" already exists with different connection options: the new options are ignored.`
          ));
        }
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
   * - applies the schema's `insertSanitizationFn`, whose result replaces the data;
   * - validates the primary key, which an update always needs to find the row;
   * - restricts the written columns to the schema columns, so that extra properties of `data`
   *   (e.g. coming from a request body) are never written to the table;
   * - skips `undefined` values, which postgres.js rejects.
   */
  prepareWrite(schema, data, operation) {
    const writeData = schema.insertSanitizationFn ? { ...schema.insertSanitizationFn({ ...data }) } : { ...data };
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
  async selectFromTableByPrimaryKey(options, primaryKeyValue) {
    const results = await this.sql`
      SELECT ${this.selectedColumns(options)} FROM ${this.sql(options.tableName)}
      WHERE ${this.sql(String(options.primaryKey))} = ${primaryKeyValue}
    `;
    if (results.length === 0) {
      return null;
    }
    return this.mapRow(options, results[0]);
  }
  /**
   * Inserts a row.
   *
   * @returns The row as stored by the database, including generated columns such as an
   * auto-determined primary key, or `null` if the `selectSanitizationFn` discards it.
   */
  async insertToTable(options, data) {
    const { data: insertData, columns } = this.prepareWrite(options, data, "insert");
    const results = await this.sql`
      INSERT INTO ${this.sql(options.tableName)} ${this.sql(insertData, columns)}
      RETURNING *
    `;
    return this.mapRow(options, results[0]);
  }
  /**
   * Updates the row identified by the primary key contained in `data`. Only the columns present
   * in `data` are written.
   *
   * @returns The row as stored by the database, or `null` if the `selectSanitizationFn` discards it.
   * @throws If no row with that primary key exists.
   */
  async updateToTable(options, data) {
    const {
      data: updateData,
      columns,
      primaryKeyValue
    } = this.prepareWrite(options, data, "update");
    const results = await this.sql`
      UPDATE ${this.sql(options.tableName)}
      SET ${this.sql(updateData, columns)}
      WHERE ${this.sql(String(options.primaryKey))} = ${primaryKeyValue}
      RETURNING *
    `;
    if (results.count === 0) {
      throw new Error(
        `No row with primary key "${String(primaryKeyValue)}" found in table "${options.tableName}".`
      );
    }
    return this.mapRow(options, results[0]);
  }
  async deleteFromTable(options, primaryKeyValue) {
    await this.sql`
      DELETE FROM ${this.sql(options.tableName)}
      WHERE ${this.sql(String(options.primaryKey))} = ${primaryKeyValue}
    `;
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
    var _a;
    void ((_a = this.logger) == null ? void 0 : _a.debug(this.id, `Initializing listener for channel "${channel}".`));
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
      ).then(({ unlisten }) => unlisten).catch((error) => {
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
      var _a;
      void ((_a = this.logger) == null ? void 0 : _a.error(
        this.id,
        `Error in listener callback "${callbackId}" for channel "${channel}":`,
        error
      ));
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
    var _a;
    void ((_a = this.logger) == null ? void 0 : _a.warn(
      this.id,
      `LISTEN on channel "${channel}" was re-established: notifications sent meanwhile are lost.`
    ));
    for (const [callbackId, { onReconnect }] of listener.callbacks) {
      if (onReconnect) {
        this.runCallbackSafely(channel, callbackId, onReconnect);
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
    var _a, _b;
    const { channel, callbackId } = identifier;
    void ((_a = this.logger) == null ? void 0 : _a.debug(
      this.id,
      `Adding listener for channel "${channel}" with callback ID "${callbackId}".`
    ));
    const listener = _nullishCoalesce(this.listeners.get(channel), () => ( this.initializeListener(channel)));
    listener.callbacks.set(callbackId, identifier);
    await listener.ready;
    void ((_b = this.logger) == null ? void 0 : _b.debug(
      this.id,
      `Listener for channel "${channel}" has ${listener.callbacks.size} callbacks.`
    ));
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
var LILYPAD_CHANGELOG_VERSION = 2;
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
function lilypadChangelogSql(options = {}) {
  const table = _nullishCoalesce(options.table, () => ( LILYPAD_DEFAULT_CHANGELOG_TABLE));
  const channel = _nullishCoalesce(options.notifyChannel, () => ( LILYPAD_DEFAULT_NOTIFY_CHANNEL));
  const quotedTable = quoteIdentifier(table);
  const indexPrefix = table.replace(/\W/g, "_");
  const notify = (idExpression, opExpression) => channel === false ? "" : `
    PERFORM pg_notify(${quoteLiteral(channel)}, json_build_object(
      'schema', TG_TABLE_SCHEMA, 'table', TG_TABLE_NAME, 'id', ${idExpression}, 'op', ${opExpression}
    )::text);`;
  const functionName = quoteIdentifier(triggerFunctionName(table));
  return `CREATE TABLE IF NOT EXISTS ${quotedTable} (
  id           bigserial   PRIMARY KEY,
  xid          xid8        NOT NULL DEFAULT pg_current_xact_id(),
  table_schema text,
  table_name   text        NOT NULL,
  row_id       text        NOT NULL,
  op           text        NOT NULL,
  changed_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Version 1 had no schema column: tables of the same name in different schemas were mixed up
ALTER TABLE ${quotedTable} ADD COLUMN IF NOT EXISTS table_schema text;
CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${indexPrefix}_table_xid_idx`)}
  ON ${quotedTable} (table_name, xid);
CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${indexPrefix}_changed_at_idx`)}
  ON ${quotedTable} (changed_at);

-- Records a change of a row; the trigger argument is the primary key column.
CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger AS $$
DECLARE
  new_id text;
  old_id text;
BEGIN
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
  const triggerName = `${options.table.replace(/\W/g, "_")}_lilypad_changes`;
  return `DROP TRIGGER IF EXISTS ${quoteIdentifier(triggerName)} ON ${quoteIdentifier(options.table)};
CREATE TRIGGER ${quoteIdentifier(triggerName)}
  AFTER INSERT OR UPDATE OR DELETE ON ${quoteIdentifier(options.table)}
  FOR EACH ROW EXECUTE FUNCTION ${quoteIdentifier(triggerFunctionName(changelogTable))}(${quoteLiteral(options.primaryKey)});
`;
}
async function readLilypadChanges(gate, options) {
  const sql = gate.sql;
  const changelogTable = _nullishCoalesce(options.changelogTable, () => ( LILYPAD_DEFAULT_CHANGELOG_TABLE));
  const since = options.since;
  const condition = "cursor" in since ? sql`c.xid >= ${since.cursor.toString()}::xid8` : sql`c.changed_at >= clock_timestamp() - make_interval(secs => ${since.lookback / 1e3})`;
  const rows = await sql`
    WITH snapshot AS (SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS next_cursor),
    target AS (
      SELECT n.nspname AS schema_name, t.relname AS rel_name
      FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE t.oid = to_regclass(${quoteIdentifier(options.tableName)}::text)
    )
    SELECT snapshot.next_cursor, c.id::text AS id, c.xid::text AS xid, c.row_id, c.op
    FROM snapshot
    LEFT JOIN target ON true
    LEFT JOIN ${sql(changelogTable)} c
      ON c.table_name = target.rel_name
      AND (c.table_schema = target.schema_name OR c.table_schema IS NULL)
      AND ${condition}
    ORDER BY c.id
  `;
  const changes = [];
  for (const row of rows) {
    if (row.id !== null) {
      changes.push({
        id: row.id,
        xid: BigInt(row.xid),
        rowId: row.row_id,
        op: row.op
      });
    }
  }
  return { changes, cursor: BigInt(rows[0].next_cursor) };
}
async function pruneLilypadChangelog(gate, options) {
  const changelogTable = _nullishCoalesce(options.changelogTable, () => ( LILYPAD_DEFAULT_CHANGELOG_TABLE));
  const result = await gate.sql`
    DELETE FROM ${gate.sql(changelogTable)}
    WHERE changed_at < clock_timestamp() - make_interval(secs => ${options.olderThan / 1e3})
  `;
  return result.count;
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
var CHANGELOG_TRIGGER_TYPE = TRIGGER_TYPE_ROW | TRIGGER_TYPE_INSERT | TRIGGER_TYPE_DELETE | TRIGGER_TYPE_UPDATE;
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
async function checkLilypadSchema(gate, options) {
  var _a;
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
          message: `The changelog trigger of "${table}" records the column "${working[0].args.split("\\000")[0]}", not the primary key "${primaryKey}".`,
          fix
        });
      }
    }
    if (notifyChannel !== false) {
      const notifies = new RegExp(
        `pg_notify\\s*\\(\\s*'${escapeRegExp(notifyChannel.replace(/'/g, "''"))}'`,
        "i"
      );
      const notifying = triggers.some(
        (trigger) => trigger.enabled && (trigger.type & TRIGGER_TYPE_ROW) !== 0 && notifies.test(trigger.source)
      );
      if (!notifying) {
        problems.push({
          code: "missing-notify-trigger",
          table,
          message: `No trigger of "${table}" sends notifications on the "${notifyChannel}" channel: the cache is not told about changes made elsewhere.`,
          fix: lilypadChangelogSql({ table: customChangelogTable, notifyChannel }) + lilypadChangelogTriggerSql({ table, primaryKey, changelogTable: customChangelogTable })
        });
      }
    }
  }
  return { ok: problems.length === 0, problems, tables };
}

// src/cache/LilypadDbCache.ts
var DEFAULT_CHANGELOG_MAX_GAP = 60 * 60 * 1e3;
var LilypadDbCache = (_class2 = class _LilypadDbCache extends _chunk7QJ33PAPjs.LilypadCache_default {
  
  
  
  
  
  /**
   * The schema of the table: from `tableName` when it is qualified, otherwise as resolved by the
   * schema check. Notifications from another schema are ignored; while it is unknown, notifications
   * of the table in any schema are applied.
   */
  
  
  // Changelog strategy state
  
  /** Changes already applied, by id, with their transaction id, until the cursor passes them. */
  __init3() {this.appliedChanges = /* @__PURE__ */ new Map()}
  __init4() {this.lastChangelogRead = 0}
  
  /**
   * Creates a cache and, with the `listen` strategy (unless `connect: 'lazy'`), registers its
   * database listener.
   * With `singleton: true`, a later call with the same identifier returns the existing cache and
   * ignores its own options (a warning is logged if the table or the TTL differ).
   *
   * @throws If the database listener cannot be registered (e.g. the database is unreachable).
   */
  static async create(ttl = 6e4, options) {
    return _chunkGU4ZU4STjs.createLilypadSingletonAbleAsync.call(void 0, 
      "LilypadDbCache",
      options,
      async (registryKey) => {
        const cache = await _LilypadDbCache.initializeNew(ttl, options);
        cache.singletonIdentifier = registryKey;
        return cache;
      },
      {
        value: JSON.stringify([options.dbGate.schema.tableName, ttl]),
        onMismatch: () => {
          var _a;
          return void ((_a = options.logger) == null ? void 0 : _a.warn(
            `LilypadDbCache singleton "${options.singleton ? options.singletonIdentifier : ""}" already exists with a different table or TTL: the new options are ignored.`
          ));
        }
      }
    );
  }
  static async initializeNew(ttl, options) {
    const cache = new _LilypadDbCache(ttl, options);
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
  constructor(ttl, options) {
    var _a;
    super(ttl, { ...options, name: _nullishCoalesce(options.name, () => ( options.dbGate.schema.tableName)) });_class2.prototype.__init3.call(this);_class2.prototype.__init4.call(this);;
    this.dbGate = options.dbGate;
    this.bulkSyncFn = async () => (await this.dbGate.gate.selectAllFromTable(this.dbGate.schema)).map((item) => [
      item[this.dbGate.schema.primaryKey],
      item
    ]);
    this.sync = _nullishCoalesce(options.sync, () => ( _LilypadDbCache.syncFromLegacyOptions(options)));
    const tableNameParts = this.dbGate.schema.tableName.split(".");
    if (tableNameParts.length > 1) {
      this.tableSchema = tableNameParts[tableNameParts.length - 2];
    }
    if (this.sync.strategy === "listen") {
      this.defaultDbListener = this.getDefaultDbListener(this.sync.listenerOptions);
    }
    void ((_a = this.logger) == null ? void 0 : _a.debug(
      this.id,
      `LilypadDbCache initialized for table "${this.dbGate.schema.tableName}" (sync: ${this.sync.strategy})`
    ));
  }
  static syncFromLegacyOptions(options) {
    if (options.useDefaultDbListener === false) {
      return { strategy: "none" };
    }
    return {
      strategy: "listen",
      listenerOptions: options.useDefaultDbListener ? options.defaultListenerOptions : void 0
    };
  }
  // SCHEMA VERIFICATION
  schemaVerification() {
    return this.sync.strategy === "none" ? "off" : _nullishCoalesce(this.sync.verify, () => ( "warn"));
  }
  /**
   * Checks once that the database has the triggers the sync strategy needs, and resolves the schema
   * of the table. With `verify: 'warn'` it never rejects: problems and failures are logged.
   *
   * @throws A `LilypadSchemaCheckError` with `verify: 'throw'`, or the error of the check.
   */
  verifySchema() {
    const mode = this.schemaVerification();
    if (mode === "off") {
      return Promise.resolve();
    }
    this.schemaCheck ??= this.runSchemaCheck(mode);
    return this.schemaCheck;
  }
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
      if (result.ok) {
        return;
      }
      if (mode === "throw") {
        throw new LilypadSchemaCheckError(subject, result.problems);
      }
      const message = formatLilypadSchemaProblems(subject, result.problems);
      if (this.logger) {
        void this.logger.warn(this.id, message);
      } else {
        console.warn(message);
      }
    } catch (error) {
      if (mode === "throw") {
        throw error;
      }
      void ((_b = this.logger) == null ? void 0 : _b.warn(this.id, `${subject}: could not check the database schema:`, error));
    }
  }
  // SYNCHRONIZATION
  /**
   * Registers the listener once, after the schema check (which resolves the schema of the table,
   * to ignore the notifications of other schemas); a failed registration is retried by the next call.
   */
  startListening() {
    if (!this.listening && this.defaultDbListener) {
      const listener = this.defaultDbListener;
      this.listening = this.verifySchema().then(() => this.dbGate.gate.addListener(listener)).catch((error) => {
        this.listening = void 0;
        throw error;
      });
    }
    return _nullishCoalesce(this.listening, () => ( Promise.resolve()));
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
    if (this.sync.strategy === "listen" && this.sync.connect === "lazy") {
      if (this.listening) {
        return void 0;
      }
      return this.startListening().catch((error) => {
        var _a;
        void ((_a = this.logger) == null ? void 0 : _a.error(this.id, "Error starting LISTEN for the cache:", error));
      });
    }
    if (this.sync.strategy !== "changelog") {
      return void 0;
    }
    if (Date.now() - this.lastChangelogRead < this.sync.pollInterval) {
      return void 0;
    }
    if (!this.schemaCheck) {
      _chunkLL3KVXOKjs.runInBackground.call(void 0, this.platform, this.verifySchema(), () => {
      });
    }
    const reading = this.readChangelog();
    if (this.sync.poll === "background") {
      _chunkLL3KVXOKjs.runInBackground.call(void 0, this.platform, reading, () => {
      });
      return void 0;
    }
    return reading;
  }
  /** Reads the changelog once at a time; errors are logged. */
  readChangelog() {
    if (!this.changelogRead) {
      this.changelogRead = this.applyChangelog().catch((error) => {
        var _a;
        void ((_a = this.logger) == null ? void 0 : _a.error(this.id, "Error reading the changelog:", error));
      }).finally(() => {
        this.changelogRead = void 0;
      });
    }
    return this.changelogRead;
  }
  async applyChangelog() {
    if (this.sync.strategy !== "changelog") {
      return;
    }
    const maxGap = _nullishCoalesce(this.sync.maxGap, () => ( DEFAULT_CHANGELOG_MAX_GAP));
    const readAt = Date.now();
    const trusted = this.changelogCursor !== void 0 && readAt - this.lastChangelogRead <= maxGap;
    const lookback = _nullishCoalesce(this.sync.lookback, () => ( this.defaultTtl + this.defaultStaleWhileRevalidate + 6e4));
    const { changes, cursor } = await readLilypadChanges(this.dbGate.gate, {
      tableName: this.dbGate.schema.tableName,
      since: trusted ? { cursor: this.changelogCursor } : { lookback },
      changelogTable: this.sync.table
    });
    if (!trusted) {
      this.appliedChanges.clear();
      this.expireAll();
    }
    const changedKeys = [];
    for (const change of changes) {
      if (this.appliedChanges.has(change.id)) {
        continue;
      }
      this.appliedChanges.set(change.id, change.xid);
      changedKeys.push(await this.applyChange(change.op, change.rowId, "lazy"));
    }
    for (const [id, xid] of this.appliedChanges) {
      if (xid < cursor) {
        this.appliedChanges.delete(id);
      }
    }
    this.changelogCursor = cursor;
    this.lastChangelogRead = readAt;
    this.emitInvalidation("changelog", changedKeys);
  }
  /**
   * Applies a change of a row made elsewhere.
   * - DELETE: the key is cached as `null`.
   * - INSERT/UPDATE of a key held (or being fetched) by this instance: `eager` re-fetches it at
   *   once; `lazy` expires it, so the next read fetches it. A fetch in flight is always re-fetched,
   *   since it may have read the row before the change.
   * - INSERT/UPDATE of any other key: no query, but the shared level entry is removed and the next
   *   `getAll` reloads the table.
   *
   * @returns The key of the changed row.
   */
  async applyChange(op, id, mode) {
    const key = this.resolveNotifiedKey(id);
    if (op === "DELETE") {
      this.markDeleted(key);
      return key;
    }
    const inFlight = this.isFetchInFlight(key);
    if (inFlight || mode === "eager" && this.getComprehensive(key).type !== "miss") {
      await this.refreshKey(key, { invalidateBulkSync: false });
    } else if (this.getComprehensive(key).type !== "miss") {
      this.markInvalid(key, { invalidateBulkSync: false });
    } else {
      this.deleteShared(key);
      this.invalidateBulkSync();
    }
    return key;
  }
  async getOrSetDetailed(key, valueFn, options = {}) {
    const syncing = this.syncBeforeRead();
    if (syncing) {
      await syncing;
    }
    return super.getOrSetDetailed(key, valueFn, options);
  }
  /**
   * Retrieves a cached value by key, or fetches it from the database if not found in cache.
   * Concurrent calls for the same key share a single database query.
   *
   * @param key - The cache key to retrieve or fetch.
   * @param options - The `getOrSet` options (e.g. `staleWhileRevalidate`, `timeout`).
   * @returns A promise that resolves to the cached value (`null` if the row does not exist),
   * or undefined if an error occurs during fetching.
   * @throws Does not throw; errors are logged internally.
   */
  async getOrFetch(key, options = {}) {
    try {
      return await this.getOrSet(
        key,
        () => this.dbGate.gate.selectFromTableByPrimaryKey(this.dbGate.schema, key),
        options
      );
    } catch (e2) {
      return void 0;
    }
  }
  /**
   * Invalidates the cache entry for the specified key.
   *
   * Attempts to update the cache for the given key. If the update fails,
   * logs the error and expires the entry, as the base class's invalidate method does.
   * `platform.onInvalidate` receives a `manual` event.
   *
   * @param key - The cache key to invalidate.
   * @param options - Optional settings for invalidation.
   * @param options.invalidateBulkSync - Whether to invalidate bulk sync when the update fails (default: true).
   * @returns A promise that resolves when the invalidation process is complete.
   */
  async invalidate(key, options = {}) {
    await this.refreshKey(key, options);
    this.emitInvalidation("manual", [key]);
  }
  /** Re-fetches a key; if the query fails, expires it instead. */
  async refreshKey(key, options) {
    var _a;
    try {
      await this.update(key);
    } catch (error) {
      void ((_a = this.logger) == null ? void 0 : _a.error(
        this.id,
        `Error updating cache key "${String(key)}" after invalidation: `,
        error
      ));
      this.markInvalid(key, options);
    }
  }
  /**
   * Updates the cache entry for the specified key by fetching the latest value from the database.
   * A row that does not exist is cached as `null`.
   * If a write that started later completes first, the fetched value is returned but not cached.
   *
   * @param key - The primary key of the cache entry to update.
   * @returns A promise that resolves to the updated value from the database.
   * @throws Rethrows any error encountered during the database fetch.
   */
  async update(key) {
    const ticket = this.nextTicket();
    const fetchedAt = Date.now();
    const value = await this.dbGate.gate.selectFromTableByPrimaryKey(
      this.dbGate.schema,
      key
    );
    this.storeFetched(key, value, void 0, ticket, fetchedAt);
    return value;
  }
  /**
   * Returns every row of the table, loading it if the bulk sync has expired.
   * The table is loaded into the memory of this instance only, not into the shared level.
   *
   * @throws If the table cannot be loaded.
   */
  async getAll(keys) {
    const syncing = this.syncBeforeRead();
    if (syncing) {
      await syncing;
    }
    await this.bulkSync(void 0, { throwOnError: true });
    const values = this.bulkGet({ keys });
    return Array.from(values.values()).filter((item) => item !== null);
  }
  /**
   * The key of the cached entry for a notified id, so that the entry keeps its original key type
   * (a notification may carry a numeric key as a string, or the other way around).
   */
  resolveNotifiedKey(id) {
    var _a;
    const normalizedKey = this.normalizeKey(id);
    return _nullishCoalesce(((_a = this.store.get(normalizedKey)) == null ? void 0 : _a.key), () => ( id));
  }
  /**
   * Caches the key as "does not exist", here and in the shared level. Unlike
   * `delete(key, { setNull: true })`, it also applies to protected keys: they are protected from
   * removal, not from reflecting a deleted row.
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
      onReconnect: () => this.expireAll(),
      callback: async (payload) => {
        var _a, _b, _c, _d;
        void ((_a = this.logger) == null ? void 0 : _a.debug(
          this.id,
          this.dbGate.schema.tableName,
          "LilypadDbCache handler has received payload on cache_events channel:",
          payload
        ));
        if (typeof payload !== "string") {
          return;
        }
        let parsedPayload;
        try {
          parsedPayload = JSON.parse(payload);
        } catch (e) {
          void ((_b = this.logger) == null ? void 0 : _b.error(this.id, "Error parsing cache_events payload:", e));
          return;
        }
        if (typeof parsedPayload !== "object" || parsedPayload === null) {
          return;
        }
        if (typeof parsedPayload.id !== "string" && typeof parsedPayload.id !== "number" || parsedPayload.id === "" || !parsedPayload.table) {
          return;
        }
        if (this.isNotificationForTable(parsedPayload)) {
          void ((_c = this.logger) == null ? void 0 : _c.debug(
            this.id,
            this.dbGate.schema.tableName,
            "LilypadDbCache handler is processing payload:",
            parsedPayload
          ));
          if (!(options == null ? void 0 : options.callback) || options.automaticallyInvalidateDataBeforeCallback) {
            const key = await this.applyChange(parsedPayload.op, parsedPayload.id, "eager");
            this.emitInvalidation("notification", [key]);
          }
          await ((_d = options == null ? void 0 : options.callback) == null ? void 0 : _d.call(options, parsedPayload));
          return;
        }
      }
    };
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
   * Marks every entry as expired (keeping the values as fallback) and forces the next bulk sync.
   */
  expireAll() {
    for (const entry of [...this.store.values()]) {
      this.expire(entry.key);
    }
    this.invalidateBulkSync();
  }
  /**
   * Disposes of the cache: stops its database listener, removes it from the singleton registry
   * (if it was created as a singleton) and clears it.
   */
  async dispose() {
    if (this.singletonIdentifier !== void 0) {
      _chunkGU4ZU4STjs.removeLilypadSingletonInstance.call(void 0, this.singletonIdentifier);
      this.singletonIdentifier = void 0;
    }
    const listenerRemoval = this.defaultDbListener ? this.dbGate.gate.removeListener(
      this.defaultDbListener.channel,
      this.defaultDbListener.callbackId
    ) : void 0;
    super.dispose();
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
   * Inserts the item in the database and caches the row returned by the database.
   * With `primaryKeyShouldAutoDetermine`, the primary key of `item` can be omitted: the cached row
   * holds the one generated by the database.
   *
   * @returns The created row, or `null` if the schema's `selectSanitizationFn` discards it.
   */
  async sqlCreate(item) {
    const row = await this.dbGate.gate.insertToTable(this.dbGate.schema, item);
    if (row !== null) {
      const key = this.getItemPrimaryKeyValue(row);
      this.set(key, row);
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
    const row = await this.dbGate.gate.updateToTable(this.dbGate.schema, item);
    this.set(key, row);
    this.emitInvalidation("write", [key]);
    return row;
  }
  async sqlDelete(key) {
    await this.dbGate.gate.deleteFromTable(this.dbGate.schema, key);
    this.markDeleted(key);
    this.emitInvalidation("write", [key]);
  }
}, _class2);












exports.lilypadServerlessPool = lilypadServerlessPool; exports.LilypadDbGate = LilypadDbGate; exports.LILYPAD_DEFAULT_CHANGELOG_TABLE = LILYPAD_DEFAULT_CHANGELOG_TABLE; exports.lilypadChangelogSql = lilypadChangelogSql; exports.lilypadChangelogTriggerSql = lilypadChangelogTriggerSql; exports.readLilypadChanges = readLilypadChanges; exports.pruneLilypadChangelog = pruneLilypadChangelog; exports.LilypadSchemaCheckError = LilypadSchemaCheckError; exports.checkLilypadSchema = checkLilypadSchema; exports.LilypadDbCache = LilypadDbCache;
//# sourceMappingURL=chunk-7T365CMD.js.map