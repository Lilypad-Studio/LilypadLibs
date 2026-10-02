import { LILYPAD_DEFAULT_CHANGELOG_TABLE } from '@/dbConfig/LilypadDbConfigDefaults';
import type { LilypadDbGate } from '@/dbGate/LilypadDbGate';
import {
  lilypadSafeKeyTypeSql,
  pruneFunctionName,
  quoteIdentifier,
  textArrayLiteral,
  triggerFunctionName,
} from '@/dbGate/LilypadChangelog';
import type { LilypadSchemaCheckOptions } from '@/dbGate/LilypadSchemaTypes';

/**
 * What the schema check reads from the catalogs (`readLilypadSchemaFacts`), before it evaluates it
 * (`evaluateLilypadSchema`). It only reads: it changes nothing.
 */

export type LilypadTriggerInfo = {
  /** Whether it calls the changelog trigger function. */
  changelog: boolean | null;
  /** Its arguments (`tgargs`). */
  args: string[];
  type: number;
  /** Whether it fires in normal operation (not disabled, nor `ENABLE REPLICA` only). */
  enabled: boolean;
  /** Its name (`tgname`). */
  name?: string | undefined;
  /** Whether it fires with `session_replication_role = replica` too (`ENABLE ALWAYS`). */
  always?: boolean | undefined;
  source: string;
  /** The names of its transition tables (`REFERENCING OLD TABLE / NEW TABLE`), if any. */
  oldTable?: string | null | undefined;
  newTable?: string | null | undefined;
};

/** A column of a table (`pg_attribute`). */
export type LilypadColumnInfo = {
  name: string;
  /** `format_type(atttypid, atttypmod)`, e.g. `character varying(64)`, `integer[]`. */
  type: string;
  /** `pg_type.typcategory`, e.g. `N` (numeric), `S` (string), `A` (array). */
  category: string;
  /**
   * For a domain, the type it is based on, through nested domains (`format_type`, without
   * modifiers): PostgreSQL sends the values of a domain as those of its base type. `null` otherwise.
   */
  baseType?: string | null | undefined;
  notNull: boolean;
  /** Whether it has a default expression (`atthasdef`; a generated column has one too). */
  hasDefault: boolean;
  /** An identity column (`GENERATED ... AS IDENTITY`). */
  identity: boolean;
  /** A generated column (`GENERATED ALWAYS AS (...) STORED`). */
  generated: boolean;
};

/** A constraint of a table (`pg_constraint`): primary key, unique, foreign key or check. */
export type LilypadConstraintInfo = {
  name: string;
  /** `p` (primary key), `u` (unique), `f` (foreign key) or `c` (check). */
  type: 'p' | 'u' | 'f' | 'c';
  columns: string[];
  /** The referenced table of a foreign key, as `schema.table` (`null` otherwise). */
  referencedTable: string | null;
  /** The referenced columns of a foreign key, in the order of `columns`. */
  referencedColumns: string[];
  /** `confdeltype` / `confupdtype` of a foreign key: `a`, `r`, `c`, `n` or `d`. */
  onDelete: string;
  onUpdate: string;
};

/** An index of a table (`pg_index`). */
export type LilypadIndexInfo = {
  name: string;
  unique: boolean;
  primary: boolean;
  /** The access method, e.g. `btree`. */
  method: string;
  /** Its key columns, in order (`null` for an expression). */
  columns: (string | null)[];
  partial: boolean;
  expressions: boolean;
  /** Whether it implements a constraint (a primary key, a unique or exclusion constraint). */
  constraint: boolean;
};

/** A job of `cron.job` (pg_cron), as far as the role of the check can see it. */
export type LilypadCronJobInfo = {
  /** `jobid` (`null` if the table has no such column). */
  id: number | null;
  /** `jobname` (`null` for a job without a name, or a pg_cron without names). */
  name: string | null;
  schedule: string;
  command: string;
  active: boolean;
  /** The database the job runs in (`null` if `cron.job` has no such column: the pg_cron one). */
  database: string | null;
};

/**
 * A table that is not in the options (another config or service sharing the changelog, or a table
 * removed from the config) whose changelog triggers record a key column that is missing, or whose
 * type the trigger function refuses (the rule of `lilypadSafeKeyTypeSql`).
 */
type LilypadBlockedChangelogTable = {
  /** `schema.table`. */
  table: string;
  /** The column its triggers record (their first argument), `null` if they have no argument. */
  column: string | null;
  /** The type of that column (`format_type`), `null` if the column does not exist. */
  type: string | null;
};

/** The settings the check reads for the role of the application. */
const LILYPAD_ROLE_SETTINGS = [
  'statement_timeout',
  'idle_session_timeout',
  'session_replication_role',
  'default_transaction_isolation',
  'default_transaction_read_only',
] as const;

export type LilypadRoleSettingName = (typeof LILYPAD_ROLE_SETTINGS)[number];

/** A setting of the session of the check (`pg_settings`). */
export type LilypadSettingInfo = {
  /** `setting`: in its unit for a duration (ms for the timeouts), e.g. `30000`. */
  value: string;
  /**
   * Where it comes from (`source`): `default`, `configuration file`, `database`, `user`,
   * `database user`, `client`...
   */
  source: string;
};

/** A row of `pg_db_role_setting` that applies to this database. */
type LilypadRoleSettingRow = {
  /** The role, or `null` for every role (`ALTER DATABASE ... SET`, `ALTER ROLE ALL SET`). */
  role: string | null;
  /** Whether it applies to this database only (else to every database). */
  inDatabase: boolean;
  /** Its `name=value` entries (`setconfig`), the values as they were written, e.g. `30s`. */
  config: string[];
};

/** A changelog function (the trigger function, or its prune function). */
export type LilypadFunctionInfo = {
  /** The role that owns it, as which it runs (`SECURITY DEFINER`). */
  owner: string;
  securityDefiner: boolean;
  /** Its settings (`proconfig`), e.g. `search_path=pg_catalog, pg_temp`. */
  config: string[];
  /** Whether `PUBLIC` may execute it. */
  publicExecute: boolean;
  /** The privileges it runs with that its owner lacks, e.g. `INSERT on the changelog`. */
  ownerLacks: string[];
};

/** A role other than its owner granted a write of the changelog. */
type LilypadChangelogWriter = {
  /** Quoted, or `PUBLIC`. */
  role: string;
  /** Among `INSERT`, `UPDATE`, `DELETE` and `TRUNCATE`, on the table or some of its columns. */
  privileges: string[];
};

/**
 * What the role of the application may do with a table, from the columns of its description (every
 * column of the table without one).
 */
export type LilypadTablePrivileges = {
  /** `USAGE` on the schema of the table. */
  schemaUsage: boolean;
  /** The columns it may not `SELECT`. */
  missingSelect: string[];
  /** Whether it may write the table at all (`INSERT` or `UPDATE` of a column, or `DELETE`). */
  canWrite: boolean;
  /** The columns it may not `INSERT` (not the generated primary key). */
  missingInsert: string[];
  /** The columns it may not `UPDATE` (not the primary key). */
  missingUpdate: string[];
  /** `DELETE` on the table. */
  delete: boolean;
  /** The sequence of a serial generated primary key it may not use (`null`: none, or allowed). */
  missingSequence: string | null;
};

/** What `checkLilypadSchema` reads from the catalogs, before it evaluates it. */
export type LilypadSchemaFacts = {
  /** `server_version_num`, e.g. `160002`. */
  version: number;
  /** `current_database()`. */
  database: string;
  /** The session of the check: the role it connects as, and its settings. */
  session: {
    /** `current_user`. */
    role: string;
    /** The settings of {@link LILYPAD_ROLE_SETTINGS} (absent: the role may not read it). */
    settings: Partial<Record<LilypadRoleSettingName, LilypadSettingInfo>>;
  };
  /** The role of the application: `appRole`, else the role of the session. */
  appRole: {
    name: string;
    exists: boolean;
    superuser: boolean;
    bypassRls: boolean;
  };
  /** The settings of roles and databases that apply to this database (`pg_db_role_setting`). */
  roleSettings: LilypadRoleSettingRow[];
  server: {
    /** `pg_is_in_recovery()`: a standby. */
    inRecovery: boolean;
    /** `pg_notification_queue_usage()`, from 0 to 1. */
    notifyQueueUsage: number;
  };
  changelog: {
    hasTable: boolean;
    hasSchemaColumn: boolean;
    hasFunction: boolean;
    functionComment: string | null;
    /** The source of the trigger function (`null` if it does not exist). */
    functionSource: string | null;
    /** The schema of the changelog table (`null` if it does not exist). */
    schema: string | null;
    /** Whether the function that the `prune` option of the trigger calls exists. */
    hasPruneFunction: boolean;
    /** The role that owns the changelog table (`null` if it does not exist). */
    owner: string | null;
    /**
     * The roles other than its owner granted a write of the changelog (`INSERT`, `UPDATE`, `DELETE`
     * or `TRUNCATE`), `PUBLIC` included.
     */
    writers: LilypadChangelogWriter[];
    /**
     * The roles that may write the changelog through a membership (quoted): members of its owner,
     * or of `pg_write_all_data`; not the superusers, nor the predefined `pg_*` roles.
     */
    memberWriters: string[];
    /** Row-level security on the changelog (`relrowsecurity`, `relforcerowsecurity`). */
    rowSecurity: boolean;
    forceRowSecurity: boolean;
    /** Whether `row_id` is `NOT NULL` (as before version 3): recording a `TRUNCATE` fails. */
    rowIdNotNull: boolean;
    /** Whether a valid, non-partial index starts with `(table_name, xid)`, or with `changed_at`. */
    hasTableXidIndex: boolean;
    hasChangedAtIndex: boolean;
    /** The trigger function and the prune function (`null` if they do not exist). */
    recordFunction: LilypadFunctionInfo | null;
    pruneFunction: LilypadFunctionInfo | null;
    /**
     * What the role of the application may read of the changelog (`null` if the table or the role
     * does not exist): `USAGE` on its schema, `SELECT` on the columns the caches read.
     */
    appPrivileges: { schemaUsage: boolean; select: boolean } | null;
    /** How old the oldest row is, in ms (`null` if the table is empty, missing or unreadable). */
    oldestRowAge: number | null;
    /**
     * The rows deleted from the changelog since the statistics were reset
     * (`pg_stat_user_tables.n_tup_del`): something prunes it, possibly a job the check cannot see.
     */
    deletedRows: number;
    /**
     * The tables outside the options whose enabled changelog triggers read a key that the trigger
     * function refuses (see {@link LilypadBlockedChangelogTable}): their writes fail once the current
     * version is installed. Empty without the trigger function.
     */
    blockedTables: LilypadBlockedChangelogTable[];
  };
  cron: {
    /** Whether pg_cron can be installed on the server (`pg_available_extensions`). */
    available: boolean;
    /** Whether it is installed in this database. */
    installed: boolean;
    /**
     * The database pg_cron runs its jobs in (`cron.database_name`): `null` if pg_cron is not
     * loaded, or if the role of the check cannot read the setting.
     */
    database: string | null;
    /**
     * The jobs of `cron.job` (`null` without it, or if it cannot be read). Row-level security
     * hides the jobs of the other roles, except from a superuser.
     */
    jobs: LilypadCronJobInfo[] | null;
  };
  /** For each table of the options, in order: `schema` is `null` if the table does not exist. */
  tables: LilypadTableFacts[];
};

/**
 * What the check reads of a table. Its columns, constraints and indexes are read for the tables
 * whose shape is checked (absent otherwise).
 */
export type LilypadTableFacts = {
  schema: string | null;
  /** The schema of a missing `schema.table`, when it does not exist either. */
  missingSchema?: string | undefined;
  triggers: LilypadTriggerInfo[];
  /**
   * The type of the primary key column (`format_type`) when the changelog triggers refuse to record
   * it: an enum or base type not owned by a superuser, or whose output function or a json/jsonb cast
   * function is not owned by a superuser (nor built in), a user-defined (non-built-in) composite,
   * range or multirange type, or an array or domain over one (the rule of `lilypadSafeKeyTypeSql`).
   * `null` for a safe key (a built-in type, a base or enum type whose type, output function and json
   * cast functions are owned by superusers, or an array/domain of one), or when the column does not
   * exist.
   */
  keyUserType?: string | null | undefined;
  /** Whether the primary key column does not exist (renamed or dropped after the triggers). */
  keyColumnMissing?: boolean | undefined;
  /** A partition (`relispartition`). */
  isPartition?: boolean | undefined;
  /** Whether it has partitions or inheritance children (`pg_inherits`). */
  hasChildren?: boolean | undefined;
  /** Whether row-level security applies to the role of the application (`null`: unknown). */
  rowSecurity?: boolean | null | undefined;
  /** Whether a subscription of logical replication writes it (`null`: unknown). */
  subscribed?: boolean | null | undefined;
  /** What the role of the application may do with it (`null`: the role does not exist). */
  appPrivileges?: LilypadTablePrivileges | null | undefined;
  columns?: LilypadColumnInfo[] | undefined;
  constraints?: LilypadConstraintInfo[] | undefined;
  indexes?: LilypadIndexInfo[] | undefined;
};

/** A `json` column: postgres.js parses it, unless the type is not registered yet. */
function parseJsonColumn(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/**
 * The arguments of a trigger, from `encode(tgargs, 'escape')`: each one ends with a zero byte, and
 * the zero bytes, the bytes with the high bit set (UTF-8 beyond ASCII) and the backslashes are
 * escaped (`\000`, `\303\251`, `\\`).
 */
export function decodeLilypadTriggerArgs(escaped: string): string[] {
  const bytes: number[] = [];
  for (let index = 0; index < escaped.length; index++) {
    if (escaped[index] !== '\\') {
      bytes.push(escaped.charCodeAt(index));
    } else if (escaped[index + 1] === '\\') {
      bytes.push(0x5c);
      index++;
    } else {
      bytes.push(Number.parseInt(escaped.slice(index + 1, index + 4), 8));
      index += 3;
    }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes)).split('\0').slice(0, -1);
}

/** A changelog table and its trigger function. */
export type LilypadChangelogTarget = {
  table: string;
  /** The changelog table's name when it is not the default, for the generated SQL. */
  custom: string | undefined;
  functionSignature: string;
};

/** The changelog table and trigger function the options designate, or `undefined` if not checked. */
export function changelogTarget(
  options: LilypadSchemaCheckOptions
): LilypadChangelogTarget | undefined {
  if (options.changelog === false) {
    return undefined;
  }
  const table = options.changelog?.table ?? LILYPAD_DEFAULT_CHANGELOG_TABLE;
  return {
    table,
    custom: table === LILYPAD_DEFAULT_CHANGELOG_TABLE ? undefined : table,
    functionSignature: `${quoteIdentifier(triggerFunctionName(table))}()`,
  };
}

/** The facts that do not depend on the cached tables: the database, the changelog, pg_cron. */
type LilypadDatabaseFacts = Omit<LilypadSchemaFacts, 'tables'>;

/**
 * The changelog whose facts are read, and whose SQL the fixes install: the checked one, or else
 * `changelogTable` (the default table without it), whose facts only tell the fixes what is installed.
 */
export function readChangelogTarget(options: LilypadSchemaCheckOptions): LilypadChangelogTarget {
  return (
    changelogTarget(options) ??
    changelogTarget({ tables: [], changelog: { table: options.changelogTable } })!
  );
}

async function readDatabaseFacts(
  gate: LilypadDbGate,
  options: LilypadSchemaCheckOptions
): Promise<LilypadDatabaseFacts> {
  const sql = gate.sql;
  const changelog = readChangelogTarget(options);
  const quotedChangelog = quoteIdentifier(changelog.table);
  const pruneSignature = `${quoteIdentifier(pruneFunctionName(changelog.table))}()`;
  const tableRefs = options.tables.map(({ table }) => quoteIdentifier(table));

  const recordSignature = changelog.functionSignature;
  const recordNeeds = sql`ARRAY[
    CASE WHEN NOT has_table_privilege(p.proowner, cl.oid, 'INSERT') THEN 'INSERT on the changelog' END,
    CASE WHEN NOT has_schema_privilege(p.proowner, cl.relnamespace, 'USAGE')
      THEN 'USAGE on the schema of the changelog' END,
    -- Nested CASE: pg_get_serial_sequence() throws for a missing column
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_attribute WHERE attrelid = cl.oid AND attname = 'id' AND NOT attisdropped
    ) THEN CASE WHEN NOT has_sequence_privilege(
      p.proowner, pg_get_serial_sequence(cl.oid::regclass::text, 'id'), 'USAGE'
    ) THEN 'USAGE on the sequence of its id column' END END,
    CASE WHEN NOT has_function_privilege(p.proowner, to_regprocedure(${pruneSignature}::text), 'EXECUTE')
      THEN 'EXECUTE on the prune function' END
  ]`;
  const pruneNeeds = sql`ARRAY[
    CASE WHEN NOT has_table_privilege(p.proowner, cl.oid, 'SELECT') THEN 'SELECT on the changelog' END,
    CASE WHEN NOT has_table_privilege(p.proowner, cl.oid, 'UPDATE') THEN 'UPDATE on the changelog' END,
    CASE WHEN NOT has_table_privilege(p.proowner, cl.oid, 'DELETE') THEN 'DELETE on the changelog' END,
    CASE WHEN NOT has_schema_privilege(p.proowner, cl.relnamespace, 'USAGE')
      THEN 'USAGE on the schema of the changelog' END
  ]`;

  // A changelog function: its owner, its settings, whether PUBLIC may execute it (a NULL proacl
  // is the default, which grants it), and the privileges it runs with that its owner lacks
  const functionInfo = (signature: string, needs: typeof recordNeeds) => sql`
    (
      SELECT json_build_object(
        'owner', r.rolname,
        'securityDefiner', p.prosecdef,
        'config', coalesce(p.proconfig, '{}'::text[]),
        'publicExecute', EXISTS (
          SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl
          WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
        ),
        'ownerLacks', array_remove(${needs}, NULL)
      )
      FROM pg_proc p
      JOIN pg_roles r ON r.oid = p.proowner
      LEFT JOIN pg_class cl ON cl.oid = to_regclass(${quotedChangelog}::text)
      WHERE p.oid = to_regprocedure(${signature}::text)
    )`;
  // pg_settings leaves out the settings the role may not read, where current_setting() throws. The
  // role of the application is resolved to its oid: the has_*_privilege() of an oid that does not
  // exist return NULL, those of a name throw
  const [database] = await sql`
    WITH app AS (
      SELECT r.oid, r.rolname, r.rolsuper, r.rolbypassrls
      FROM (SELECT coalesce(${options.appRole ?? null}::text, current_user::text) AS name) AS wanted
      LEFT JOIN pg_roles r ON r.rolname = wanted.name
    )
    SELECT
      current_setting('server_version_num')::int AS version,
      current_database() AS database,
      current_user AS role,
      -- As they apply to this session: the server, database and role settings, and what the
      -- connection sets (durations in ms, their unit)
      (
        SELECT json_object_agg(name, json_build_object('value', setting, 'source', source))
        FROM pg_settings WHERE name = ANY(${textArrayLiteral([...LILYPAD_ROLE_SETTINGS])}::text[])
      ) AS session_settings,
      coalesce(${options.appRole ?? null}::text, current_user::text) AS app_role,
      app.oid IS NOT NULL AS app_role_exists,
      coalesce(app.rolsuper, false) AS app_role_superuser,
      coalesce(app.rolbypassrls, false) AS app_role_bypass_rls,
      (
        SELECT coalesce(json_agg(json_build_object(
          'role', r.rolname, 'inDatabase', s.setdatabase <> 0, 'config', s.setconfig
        ) ORDER BY s.setdatabase DESC, r.rolname), '[]'::json)
        FROM pg_db_role_setting s
        LEFT JOIN pg_roles r ON r.oid = s.setrole
        WHERE s.setdatabase = 0
          OR s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
      ) AS role_settings,
      pg_is_in_recovery() AS in_recovery,
      pg_notification_queue_usage()::float8 AS notify_queue_usage,
      to_regclass(${quotedChangelog}::text) IS NOT NULL AS has_changelog_table,
      (
        SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.oid = to_regclass(${quotedChangelog}::text)
      ) AS changelog_schema,
      to_regprocedure(${pruneSignature}::text) IS NOT NULL AS has_prune_function,
      (
        SELECT pg_get_userbyid(c.relowner) FROM pg_class c
        WHERE c.oid = to_regclass(${quotedChangelog}::text)
      ) AS changelog_owner,
      (
        SELECT coalesce(json_agg(json_build_object(
          'role', writer.name, 'privileges', writer.privileges
        ) ORDER BY writer.name), '[]'::json) FROM (
          SELECT
            CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(r.rolname) END AS name,
            array_agg(DISTINCT acl.privilege_type ORDER BY acl.privilege_type) AS privileges
          FROM pg_class c
          -- The grants of the table, and those of its columns (an INSERT of some columns is enough)
          CROSS JOIN LATERAL (
            SELECT * FROM aclexplode(c.relacl)
            UNION ALL
            SELECT column_acl.* FROM pg_attribute a, aclexplode(a.attacl) AS column_acl
            WHERE a.attrelid = c.oid
          ) AS acl
          LEFT JOIN pg_roles r ON r.oid = acl.grantee
          WHERE c.oid = to_regclass(${quotedChangelog}::text)
            AND acl.grantee <> c.relowner
            AND acl.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
          GROUP BY 1
        ) AS writer
      ) AS changelog_writers,
      -- The roles that write it through a membership: of its owner, or of pg_write_all_data
      -- (MEMBER: with its privileges, or SET ROLE). Not the superusers (trusted), nor the
      -- predefined roles
      (
        SELECT coalesce(json_agg(quote_ident(r.rolname) ORDER BY r.rolname), '[]'::json)
        FROM pg_class c, pg_roles r
        WHERE c.oid = to_regclass(${quotedChangelog}::text)
          AND r.oid <> c.relowner AND NOT r.rolsuper AND r.rolname !~ '^pg_'
          AND (
            pg_has_role(r.oid, c.relowner, 'MEMBER')
            OR pg_has_role(r.oid, 'pg_write_all_data', 'MEMBER')
          )
      ) AS changelog_member_writers,
      coalesce((
        SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass(${quotedChangelog}::text)
      ), false) AS changelog_row_security,
      coalesce((
        SELECT c.relforcerowsecurity FROM pg_class c
        WHERE c.oid = to_regclass(${quotedChangelog}::text)
      ), false) AS changelog_force_row_security,
      EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = to_regclass(${quotedChangelog}::text)
          AND attname = 'row_id' AND attnotnull AND NOT attisdropped
      ) AS changelog_row_id_not_null,
      -- An index whose key starts with these columns (int2vector subscripts start at 0)
      EXISTS (
        SELECT 1 FROM pg_index ix
        JOIN pg_attribute a0 ON a0.attrelid = ix.indrelid AND a0.attnum = ix.indkey[0]
        JOIN pg_attribute a1 ON a1.attrelid = ix.indrelid AND a1.attnum = ix.indkey[1]
        WHERE ix.indrelid = to_regclass(${quotedChangelog}::text)
          AND ix.indisvalid AND ix.indpred IS NULL
          AND a0.attname = 'table_name' AND a1.attname = 'xid'
      ) AS changelog_table_xid_index,
      EXISTS (
        SELECT 1 FROM pg_index ix
        JOIN pg_attribute a0 ON a0.attrelid = ix.indrelid AND a0.attnum = ix.indkey[0]
        WHERE ix.indrelid = to_regclass(${quotedChangelog}::text)
          AND ix.indisvalid AND ix.indpred IS NULL AND a0.attname = 'changed_at'
      ) AS changelog_changed_at_index,
      ${functionInfo(recordSignature, recordNeeds)} AS record_function,
      ${functionInfo(pruneSignature, pruneNeeds)} AS prune_function,
      -- What the caches read: USAGE on the schema, SELECT on the columns of the reader's query
      (
        SELECT json_build_object(
          'schemaUsage', has_schema_privilege(app.oid, c.relnamespace, 'USAGE'),
          'select', NOT EXISTS (
            SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
              AND a.attname IN ('id', 'xid', 'table_schema', 'table_name', 'row_id', 'op', 'changed_at')
              AND NOT has_column_privilege(app.oid, c.oid, a.attnum, 'SELECT')
          )
        )
        FROM pg_class c
        WHERE c.oid = to_regclass(${quotedChangelog}::text) AND app.oid IS NOT NULL
      ) AS changelog_app_privileges,
      coalesce((
        SELECT n_tup_del FROM pg_stat_user_tables WHERE relid = to_regclass(${quotedChangelog}::text)
      ), 0)::float8 AS deleted_rows,
      EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') AS cron_available,
      EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') AS cron_installed,
      (SELECT setting FROM pg_settings WHERE name = 'cron.database_name') AS cron_database,
      -- Not to_regclass('cron.job'): it throws without USAGE on the schema (readCronJobs catches it)
      EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'cron' AND c.relname = 'job'
      ) AS has_cron_jobs,
      EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = to_regclass(${quotedChangelog}::text)
          AND attname = 'table_schema' AND NOT attisdropped
      ) AS has_schema_column,
      to_regprocedure(${changelog.functionSignature}::text) IS NOT NULL AS has_function,
      obj_description(to_regprocedure(${changelog.functionSignature}::text), 'pg_proc') AS function_comment,
      (
        SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(${changelog.functionSignature}::text)
      ) AS function_source,
      -- The tables outside the options whose enabled changelog statement triggers on INSERT, UPDATE
      -- or DELETE (those that read the key: 28 = INSERT | DELETE | UPDATE) record a missing column, or
      -- one of a type the trigger function refuses (lilypadSafeKeyTypeSql). The recorded column is
      -- the first argument (tgargs ends each one with a zero byte); none without an argument
      (
        SELECT coalesce(json_agg(json_build_object(
          'table', blocked.table_name, 'column', blocked.key_column, 'type', blocked.key_type
        ) ORDER BY blocked.table_name, blocked.key_column), '[]'::json)
        FROM (
          SELECT DISTINCT
            n.nspname || '.' || c.relname AS table_name,
            arg.key_column,
            CASE WHEN a.attnum IS NOT NULL
              THEN pg_catalog.format_type(a.atttypid, a.atttypmod) END AS key_type
          FROM pg_catalog.pg_trigger tr
          JOIN pg_catalog.pg_class c ON c.oid = tr.tgrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          CROSS JOIN LATERAL (
            SELECT CASE WHEN tr.tgnargs > 0 THEN pg_catalog.convert_from(
              substring(tr.tgargs FROM 1 FOR greatest(position(decode('00', 'hex') IN tr.tgargs) - 1, 0)),
              pg_catalog.getdatabaseencoding()
            ) END AS key_column
          ) AS arg
          LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = tr.tgrelid
            AND a.attname = arg.key_column::pg_catalog.name AND a.attnum > 0 AND NOT a.attisdropped
          WHERE tr.tgfoid = to_regprocedure(${changelog.functionSignature}::text)::oid
            AND NOT tr.tgisinternal
            AND tr.tgenabled IN ('O', 'A')
            AND (tr.tgtype & 1) = 0
            AND (tr.tgtype & 28) <> 0
            AND NOT EXISTS (
              SELECT 1 FROM unnest(${textArrayLiteral(tableRefs)}::text[]) AS requested(ref)
              WHERE to_regclass(requested.ref) = tr.tgrelid
            )
            AND (a.attnum IS NULL OR NOT (${sql.unsafe(lilypadSafeKeyTypeSql('a.atttypid'))}))
        ) AS blocked
      ) AS blocked_changelog_tables
    FROM app
  `;
  if (!database) {
    throw new Error('Reading the database settings returned no row.');
  }

  // How the changelog is pruned, only when it is checked. These reads are best effort: a role
  // that cannot read them leaves the facts unknown instead of failing the whole check.
  let oldestRowAge: number | null = null;
  let jobs: LilypadCronJobInfo[] | null = null;
  if (options.changelog !== false && options.changelog?.checkPruning !== false) {
    if (database.has_changelog_table) {
      oldestRowAge = await sql`
        SELECT (extract(epoch FROM clock_timestamp() - min(changed_at)) * 1000)::float8 AS age
        FROM ${sql(changelog.table)}
      `.then(
        ([row]) => (row?.age as number | null | undefined) ?? null,
        () => null
      );
    }
    if (database.has_cron_jobs) {
      jobs = await readCronJobs(gate);
    }
  }

  return {
    version: database.version as number,
    database: database.database as string,
    session: {
      role: database.role as string,
      settings: parseJsonColumn(database.session_settings) ?? {},
    },
    appRole: {
      name: database.app_role as string,
      exists: database.app_role_exists as boolean,
      superuser: database.app_role_superuser as boolean,
      bypassRls: database.app_role_bypass_rls as boolean,
    },
    roleSettings: parseJsonColumn(database.role_settings) as LilypadRoleSettingRow[],
    server: {
      inRecovery: database.in_recovery as boolean,
      notifyQueueUsage: database.notify_queue_usage as number,
    },
    changelog: {
      hasTable: database.has_changelog_table as boolean,
      hasSchemaColumn: database.has_schema_column as boolean,
      hasFunction: database.has_function as boolean,
      functionComment: database.function_comment as string | null,
      functionSource: database.function_source as string | null,
      schema: database.changelog_schema as string | null,
      hasPruneFunction: database.has_prune_function as boolean,
      owner: database.changelog_owner as string | null,
      writers: parseJsonColumn(database.changelog_writers) as LilypadChangelogWriter[],
      memberWriters: parseJsonColumn(database.changelog_member_writers) as string[],
      rowSecurity: database.changelog_row_security as boolean,
      forceRowSecurity: database.changelog_force_row_security as boolean,
      rowIdNotNull: database.changelog_row_id_not_null as boolean,
      hasTableXidIndex: database.changelog_table_xid_index as boolean,
      hasChangedAtIndex: database.changelog_changed_at_index as boolean,
      recordFunction: (parseJsonColumn(database.record_function) ??
        null) as LilypadFunctionInfo | null,
      pruneFunction: (parseJsonColumn(database.prune_function) ??
        null) as LilypadFunctionInfo | null,
      appPrivileges: (parseJsonColumn(database.changelog_app_privileges) ?? null) as {
        schemaUsage: boolean;
        select: boolean;
      } | null,
      oldestRowAge,
      deletedRows: database.deleted_rows as number,
      blockedTables: parseJsonColumn(
        database.blocked_changelog_tables
      ) as LilypadBlockedChangelogTable[],
    },
    cron: {
      available: database.cron_available as boolean,
      installed: database.cron_installed as boolean,
      database: database.cron_database as string | null,
      jobs,
    },
  };
}

/**
 * For each table of the options, in order, its schema, its triggers, and, when its shape is checked,
 * its columns, constraints and indexes: one query for all.
 */
async function readTableFacts(
  gate: LilypadDbGate,
  options: LilypadSchemaCheckOptions
): Promise<LilypadSchemaFacts['tables']> {
  const sql = gate.sql;
  const changelog = readChangelogTarget(options);
  const tableRefs = options.tables.map(({ table }) => quoteIdentifier(table));
  const primaryKeys = options.tables.map(({ primaryKey }) => primaryKey);
  // For the privileges: the columns of each table's description (null: every column of the
  // table), and whether its primary key is generated
  const described = JSON.stringify(
    options.tables.map(({ shape }) => ({
      cols: shape ? Object.keys(shape.cols) : null,
      generated: shape?.generatedPrimaryKey === true,
    }))
  );
  const withShape = options.tables.some((table) => table.shape !== undefined);
  const shapeColumns = withShape
    ? sql`,
      (
        SELECT coalesce(json_agg(json_build_object(
          'name', a.attname,
          'type', format_type(a.atttypid, a.atttypmod),
          'category', ty.typcategory,
          'baseType', CASE WHEN ty.typtype = 'd' THEN (
            WITH RECURSIVE base AS (
              SELECT ty.typtype, ty.typbasetype, ty.oid
              UNION ALL
              SELECT b.typtype, b.typbasetype, b.oid
              FROM base JOIN pg_type b ON b.oid = base.typbasetype
              WHERE base.typtype = 'd'
            )
            SELECT format_type(base.oid, NULL) FROM base WHERE base.typtype <> 'd'
          ) END,
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
      ) AS indexes`
    : sql``;
  const found =
    tableRefs.length === 0
      ? []
      : await sql`
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
          'name', tr.tgname,
          'always', tr.tgenabled = 'A',
          'source', p.prosrc,
          'oldTable', tr.tgoldtable,
          'newTable', tr.tgnewtable
        )), '[]'::json)
        FROM pg_trigger tr JOIN pg_proc p ON p.oid = tr.tgfoid
        WHERE tr.tgrelid = t.oid AND NOT tr.tgisinternal
      ) AS triggers,
      -- Whether the primary key column is missing (renamed or dropped). The name is cast to the name
      -- type, so it is clipped to 63 bytes as the trigger's %I is.
      NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = t.oid AND a.attname = requested.primary_key::pg_catalog.name
          AND a.attnum > 0 AND NOT a.attisdropped
      ) AS key_column_missing,
      -- The type of the primary key column when it is not safe to record, i.e. when converting it
      -- with to_jsonb (as the changelog owner) could run a non-superuser's code. The safety rule is
      -- the one the trigger function applies (lilypadSafeKeyTypeSql, the single source of truth): a
      -- walk with no result counts as unsafe (coalesce to false there). Null when safe, or when the
      -- column is missing.
      (
        SELECT CASE WHEN NOT (${sql.unsafe(lilypadSafeKeyTypeSql('a.atttypid'))})
          THEN pg_catalog.format_type(a.atttypid, a.atttypmod) END
        FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = t.oid AND a.attname = requested.primary_key::pg_catalog.name
          AND a.attnum > 0 AND NOT a.attisdropped
      ) AS key_user_type,
      t.relispartition AS is_partition,
      EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhparent = t.oid) AS has_children,
      -- Row-level security applies to the role of the application: not a superuser nor BYPASSRLS,
      -- and not the owner, unless FORCE (NULL when the role does not exist)
      CASE WHEN app.oid IS NOT NULL THEN
        t.relrowsecurity AND NOT app.rolsuper AND NOT app.rolbypassrls
          AND (t.relforcerowsecurity OR t.relowner <> app.oid)
      END AS row_security,
      CASE WHEN app.oid IS NOT NULL THEN (
        SELECT json_build_object(
          'schemaUsage', has_schema_privilege(app.oid, t.relnamespace, 'USAGE'),
          'missingSelect', coalesce(json_agg(a.attname ORDER BY a.attnum)
            FILTER (WHERE NOT has_column_privilege(app.oid, t.oid, a.attnum, 'SELECT')), '[]'::json),
          'canWrite', has_any_column_privilege(app.oid, t.oid, 'INSERT')
            OR has_any_column_privilege(app.oid, t.oid, 'UPDATE')
            OR has_table_privilege(app.oid, t.oid, 'DELETE'),
          'missingInsert', coalesce(json_agg(a.attname ORDER BY a.attnum) FILTER (
            WHERE NOT (described.generated AND a.attname = requested.primary_key)
              AND NOT has_column_privilege(app.oid, t.oid, a.attnum, 'INSERT')
          ), '[]'::json),
          'missingUpdate', coalesce(json_agg(a.attname ORDER BY a.attnum) FILTER (
            WHERE a.attname <> requested.primary_key
              AND NOT has_column_privilege(app.oid, t.oid, a.attnum, 'UPDATE')
          ), '[]'::json),
          'delete', has_table_privilege(app.oid, t.oid, 'DELETE'),
          -- The sequence of a serial generated key (an identity column needs no privilege)
          'missingSequence', (
            SELECT CASE WHEN NOT has_sequence_privilege(app.oid, seq.name, 'USAGE') THEN seq.name END
            FROM (
              SELECT pg_get_serial_sequence(t.oid::regclass::text, k.attname) AS name
              FROM pg_attribute k
              WHERE described.generated AND k.attrelid = t.oid
                AND k.attname = requested.primary_key::pg_catalog.name
                AND k.attnum > 0 AND NOT k.attisdropped AND k.attidentity = ''
            ) AS seq
            WHERE seq.name IS NOT NULL
          )
        )
        FROM pg_attribute a
        WHERE a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
          AND (described.cols IS NULL OR a.attname = ANY(described.cols))
      ) END AS app_privileges
      ${shapeColumns}
    FROM unnest(${textArrayLiteral(tableRefs)}::text[], ${textArrayLiteral(primaryKeys)}::text[])
      WITH ORDINALITY AS requested(ref, primary_key, position)
    JOIN pg_class t ON t.oid = to_regclass(requested.ref)
    JOIN pg_namespace n ON n.oid = t.relnamespace
    CROSS JOIN LATERAL (
      SELECT
        CASE WHEN json_typeof(d -> 'cols') = 'array' THEN ARRAY(
          SELECT json_array_elements_text(d -> 'cols')
        )::pg_catalog.name[] END AS cols,
        (d ->> 'generated')::boolean AS generated
      FROM (SELECT ${described}::json -> (requested.position::int - 1) AS d) AS item
    ) AS described
    CROSS JOIN (
      SELECT r.oid, r.rolsuper, r.rolbypassrls
      FROM (SELECT coalesce(${options.appRole ?? null}::text, current_user::text) AS name) AS wanted
      LEFT JOIN pg_roles r ON r.rolname = wanted.name
    ) AS app
  `;
  // The tables a subscription of logical replication writes: best effort (pg_subscription_rel)
  const subscribed: Set<number> | null =
    found.length === 0
      ? new Set()
      : await sql`
          SELECT requested.position
          FROM unnest(${textArrayLiteral(tableRefs)}::text[]) WITH ORDINALITY AS requested(ref, position)
          JOIN pg_subscription_rel s ON s.srrelid = to_regclass(requested.ref)
        `.then(
          (rows) => new Set(rows.map((row) => Number(row.position))),
          () => null
        );
  const byPosition = new Map(found.map((row) => [Number(row.position), row]));
  // The schemas of the missing `schema.table`, and which of them exist
  const schemaOf = (table: string) => {
    const parts = table.split('.');
    return parts.length === 2 ? parts[0] : undefined;
  };
  const missingSchemas = [
    ...new Set(
      options.tables.flatMap(({ table }, index) => {
        const schema = byPosition.has(index + 1) ? undefined : schemaOf(table);
        return schema === undefined ? [] : [schema];
      })
    ),
  ];
  const existingSchemas = new Set(
    missingSchemas.length === 0
      ? []
      : (
          await sql`
            SELECT nspname FROM pg_namespace
            WHERE nspname = ANY(${textArrayLiteral(missingSchemas)}::text[])
          `
        ).map((row) => row.nspname as string)
  );
  const tables: LilypadSchemaFacts['tables'] = options.tables.map((table, index) => {
    const row = byPosition.get(index + 1);
    if (!row) {
      const schema = schemaOf(table.table);
      return {
        schema: null,
        triggers: [],
        ...(schema !== undefined && !existingSchemas.has(schema) && { missingSchema: schema }),
      };
    }
    const triggers = parseJsonColumn(row.triggers) as (Omit<LilypadTriggerInfo, 'args'> & {
      args: string;
    })[];
    const facts: LilypadTableFacts = {
      schema: row.schema_name as string,
      triggers: triggers.map((trigger) => ({
        ...trigger,
        args: decodeLilypadTriggerArgs(trigger.args),
      })),
      keyUserType: (row.key_user_type as string | null | undefined) ?? null,
      keyColumnMissing: (row.key_column_missing as boolean | undefined) ?? false,
      isPartition: row.is_partition as boolean,
      hasChildren: row.has_children as boolean,
      rowSecurity: row.row_security as boolean | null,
      subscribed: subscribed === null ? null : subscribed.has(index + 1),
      appPrivileges: (parseJsonColumn(row.app_privileges) ?? null) as LilypadTablePrivileges | null,
    };
    if (table.shape !== undefined) {
      facts.columns = parseJsonColumn(row.columns) as LilypadColumnInfo[];
      facts.constraints = parseJsonColumn(row.constraints) as LilypadConstraintInfo[];
      facts.indexes = parseJsonColumn(row.indexes) as LilypadIndexInfo[];
    }
    return facts;
  });

  return tables;
}

/**
 * Reads from the catalogs what {@link evaluateLilypadSchema} needs. It changes nothing.
 *
 * @throws If the catalogs cannot be read (e.g. the database is unreachable).
 */
export async function readLilypadSchemaFacts(
  gate: LilypadDbGate,
  options: LilypadSchemaCheckOptions
): Promise<LilypadSchemaFacts> {
  const [database, tables] = await Promise.all([
    readDatabaseFacts(gate, options),
    readTableFacts(gate, options),
  ]);
  return { ...database, tables };
}

/**
 * The jobs of `cron.job`, or `null` if they cannot be read. Read as JSON, so that the columns
 * that older versions of pg_cron lack (`jobname`, `database`) are simply absent.
 */
async function readCronJobs(gate: LilypadDbGate): Promise<LilypadCronJobInfo[] | null> {
  try {
    const [row] = await gate.sql`
      SELECT coalesce(json_agg(row_to_json(j)), '[]'::json) AS jobs FROM cron.job j
    `;
    const jobs = parseJsonColumn(row?.jobs) as Record<string, unknown>[] | undefined;
    return (jobs ?? []).map((job) => ({
      id: typeof job.jobid === 'number' ? job.jobid : null,
      name: typeof job.jobname === 'string' ? job.jobname : null,
      schedule: typeof job.schedule === 'string' ? job.schedule : '',
      command: typeof job.command === 'string' ? job.command : '',
      active: job.active !== false,
      database: typeof job.database === 'string' ? job.database : null,
    }));
  } catch {
    return null;
  }
}
