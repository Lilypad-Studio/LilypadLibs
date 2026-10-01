import { LILYPAD_DEFAULT_CHANGELOG_TABLE } from '@/dbConfig/LilypadDbConfigDefaults';
import type { LilypadDbGate } from '@/dbGate/LilypadDbGate';
import {
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
    /**
     * The roles other than its owner that may write the changelog (`INSERT`, `UPDATE`, `DELETE`
     * or `TRUNCATE`), quoted and separated by commas, `PUBLIC` included: `null` if none.
     */
    writers: string | null;
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
  /** The schema of a missing `schema.table`, when it does not exist either. */
  missingSchema?: string | undefined;
  triggers: LilypadTriggerInfo[];
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
      (
        SELECT string_agg(writer.name, ', ' ORDER BY writer.name) FROM (
          SELECT DISTINCT CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(r.rolname) END AS name
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
        ) AS writer
      ) AS changelog_writers,
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
      writers: database.changelog_writers as string | null,
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
