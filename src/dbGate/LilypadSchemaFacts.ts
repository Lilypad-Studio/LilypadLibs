import type { LilypadDbGate } from '@/dbGate/LilypadDbGate';
import {
  LILYPAD_DEFAULT_CHANGELOG_TABLE,
  pruneFunctionName,
  quoteIdentifier,
  textArrayLiteral,
  triggerFunctionName,
} from '@/dbGate/LilypadChangelog';
import type { LilypadSchemaCheckOptions } from '@/dbGate/LilypadSchemaCheck';

/**
 * What the schema check reads from the catalogs (`readLilypadSchemaFacts`), before it evaluates it
 * (`evaluateLilypadSchema`). It only reads: it changes nothing.
 */

export type LilypadTriggerInfo = {
  /** Whether it calls the changelog trigger function. */
  changelog: boolean | null;
  /** Its arguments, as `encode(tgargs, 'escape')`: each one ends with `\000`. */
  args: string;
  type: number;
  /** Whether it fires in normal operation (not disabled, nor `ENABLE REPLICA` only). */
  enabled: boolean;
  source: string;
  /** The names of its transition tables (`REFERENCING OLD TABLE / NEW TABLE`), if any. */
  oldTable?: string | null;
  newTable?: string | null;
};

/** A column of a table (`pg_attribute`). */
export type LilypadColumnInfo = {
  name: string;
  /** `format_type(atttypid, atttypmod)`, e.g. `character varying(64)`, `integer[]`. */
  type: string;
  /** `pg_type.typcategory`, e.g. `N` (numeric), `S` (string), `A` (array). */
  category: string;
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

/** What `checkLilypadSchema` reads from the catalogs, before it evaluates it. */
export type LilypadSchemaFacts = {
  /** `server_version_num`, e.g. `160002`. */
  version: number;
  /** `current_database()`. */
  database: string;
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
    /** How old the oldest row is, in ms (`null` if the table is empty, missing or unreadable). */
    oldestRowAge: number | null;
    /**
     * The rows deleted from the changelog since the statistics were reset
     * (`pg_stat_user_tables.n_tup_del`): something prunes it, possibly a job the check cannot see.
     */
    deletedRows: number;
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
  triggers: LilypadTriggerInfo[];
  columns?: LilypadColumnInfo[];
  constraints?: LilypadConstraintInfo[];
  indexes?: LilypadIndexInfo[];
};

/** A `json` column: postgres.js parses it, unless the type is not registered yet. */
function parseJsonColumn(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/** The changelog table and trigger function the options designate, or `undefined` if not checked. */
export function changelogTarget(options: LilypadSchemaCheckOptions) {
  if (options.changelog === false) {
    return undefined;
  }
  const table = options.changelog?.table ?? LILYPAD_DEFAULT_CHANGELOG_TABLE;
  return {
    table,
    // The changelog table's name when it is not the default, for the generated SQL
    custom: table === LILYPAD_DEFAULT_CHANGELOG_TABLE ? undefined : table,
    functionSignature: `${quoteIdentifier(triggerFunctionName(table))}()`,
  };
}

/** The facts that do not depend on the cached tables: the database, the changelog, pg_cron. */
type LilypadDatabaseFacts = Omit<LilypadSchemaFacts, 'tables'>;

/** The changelog whose facts are read: without one to check, the default one (its facts are then ignored). */
function readChangelogTarget(options: LilypadSchemaCheckOptions) {
  return changelogTarget(options) ?? changelogTarget({ tables: [] })!;
}

async function readDatabaseFacts(
  gate: LilypadDbGate,
  options: LilypadSchemaCheckOptions
): Promise<LilypadDatabaseFacts> {
  const sql = gate.sql;
  const changelog = readChangelogTarget(options);
  const quotedChangelog = quoteIdentifier(changelog.table);
  const pruneSignature = `${quoteIdentifier(pruneFunctionName(changelog.table))}()`;

  // pg_settings leaves out the settings the role may not read, where current_setting() throws
  const [database] = await sql`
    SELECT
      current_setting('server_version_num')::int AS version,
      current_database() AS database,
      to_regclass(${quotedChangelog}::text) IS NOT NULL AS has_changelog_table,
      (
        SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.oid = to_regclass(${quotedChangelog}::text)
      ) AS changelog_schema,
      to_regprocedure(${pruneSignature}::text) IS NOT NULL AS has_prune_function,
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
    changelog: {
      hasTable: database.has_changelog_table as boolean,
      hasSchemaColumn: database.has_schema_column as boolean,
      hasFunction: database.has_function as boolean,
      functionComment: database.function_comment as string | null,
      functionSource: database.function_source as string | null,
      schema: database.changelog_schema as string | null,
      hasPruneFunction: database.has_prune_function as boolean,
      oldestRowAge,
      deletedRows: database.deleted_rows as number,
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
  const withShape = options.tables.some((table) => table.shape !== undefined);
  const shapeColumns = withShape
    ? sql`,
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
  const tables: LilypadSchemaFacts['tables'] = options.tables.map((table, index) => {
    const row = byPosition.get(index + 1);
    if (!row) {
      return { schema: null, triggers: [] };
    }
    const facts: LilypadTableFacts = {
      schema: row.schema_name as string,
      triggers: parseJsonColumn(row.triggers) as LilypadTriggerInfo[],
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
