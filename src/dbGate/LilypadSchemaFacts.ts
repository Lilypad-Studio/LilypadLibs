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
  tables: { schema: string | null; triggers: LilypadTriggerInfo[] }[];
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

/** For each table of the options, in order, its schema and its triggers: one query for all. */
async function readTableFacts(
  gate: LilypadDbGate,
  options: LilypadSchemaCheckOptions
): Promise<LilypadSchemaFacts['tables']> {
  const sql = gate.sql;
  const changelog = readChangelogTarget(options);
  const tableRefs = options.tables.map(({ table }) => quoteIdentifier(table));
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
    FROM unnest(${textArrayLiteral(tableRefs)}::text[]) WITH ORDINALITY AS requested(ref, position)
    JOIN pg_class t ON t.oid = to_regclass(requested.ref)
    JOIN pg_namespace n ON n.oid = t.relnamespace
  `;
  const byPosition = new Map(found.map((row) => [Number(row.position), row]));
  const tables: LilypadSchemaFacts['tables'] = options.tables.map((_, index) => {
    const row = byPosition.get(index + 1);
    return row
      ? {
          schema: row.schema_name as string,
          triggers: parseJsonColumn(row.triggers) as LilypadTriggerInfo[],
        }
      : { schema: null, triggers: [] };
  });

  return tables;
}

/** How long the caches of a gate share the facts of the database (see `shareDatabaseFacts`). */
const SHARED_FACTS_LIFETIME = 60_000;
const sharedFacts = new WeakMap<
  LilypadDbGate,
  Map<string, { readAt: number; facts: Promise<LilypadDatabaseFacts> }>
>();

/**
 * The facts of the database, shared by the checks of the caches of a gate made within a minute:
 * N caches read them once. A failed read is not shared.
 */
function sharedDatabaseFacts(
  gate: LilypadDbGate,
  options: LilypadSchemaCheckOptions
): Promise<LilypadDatabaseFacts> {
  let gateFacts = sharedFacts.get(gate);
  if (!gateFacts) {
    gateFacts = new Map();
    sharedFacts.set(gate, gateFacts);
  }
  // The facts of the pruning are read only when it is checked
  const key = JSON.stringify([
    readChangelogTarget(options).table,
    options.changelog !== false && options.changelog?.checkPruning !== false,
  ]);
  const now = Date.now();
  const shared = gateFacts.get(key);
  if (shared && now - shared.readAt < SHARED_FACTS_LIFETIME) {
    return shared.facts;
  }
  const facts = readDatabaseFacts(gate, options);
  const entry = { readAt: now, facts };
  gateFacts.set(key, entry);
  facts.catch(() => {
    if (gateFacts.get(key) === entry) {
      gateFacts.delete(key);
    }
  });
  return facts;
}

/** How `checkLilypadSchema` is called by the library itself. */
export type LilypadSchemaCheckContext = {
  /**
   * Reuses the facts of the database read by another check of the same gate less than a minute
   * ago (the caches of a gate check the same changelog).
   */
  shareDatabaseFacts?: boolean;
};

/**
 * Reads from the catalogs what {@link evaluateLilypadSchema} needs. It changes nothing.
 *
 * @throws If the catalogs cannot be read (e.g. the database is unreachable).
 */
export async function readLilypadSchemaFacts(
  gate: LilypadDbGate,
  options: LilypadSchemaCheckOptions,
  context: LilypadSchemaCheckContext = {}
): Promise<LilypadSchemaFacts> {
  const [database, tables] = await Promise.all([
    context.shareDatabaseFacts
      ? sharedDatabaseFacts(gate, options)
      : readDatabaseFacts(gate, options),
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
