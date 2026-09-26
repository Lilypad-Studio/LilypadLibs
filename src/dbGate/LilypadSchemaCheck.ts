import type { LilypadDbGate } from '@/dbGate/LilypadDbGate';
import {
  LILYPAD_CHANGELOG_NEW_ROWS,
  LILYPAD_CHANGELOG_OLD_ROWS,
  LILYPAD_CHANGELOG_VERSION,
  LILYPAD_CHANGELOG_VERSION_PREFIX,
  LILYPAD_DEFAULT_CHANGELOG_TABLE,
  installedLilypadChangelogPrune,
  lilypadChangelogPruneScheduleSql,
  lilypadChangelogSql,
  lilypadChangelogTriggerSql,
  olderThanCondition,
  pruneFunctionName,
  quoteIdentifier,
  triggerFunctionName,
  type LilypadChangelogPruneOptions,
} from '@/dbGate/LilypadChangelog';
import { assertNumberOption } from '@/internal/LilypadValidation';

/**
 * How the old changelog rows are deleted:
 * - `detect`: the check looks for the `prune` option of the trigger and for a pg_cron job that
 *   deletes them, and suggests the best one for the database if it finds neither;
 * - `external`: a job the database cannot show deletes them (e.g. `pruneLilypadChangelog` called
 *   from a scheduled function): nothing is suggested, only the age of the oldest row is checked.
 */
export type LilypadChangelogPruning = 'detect' | 'external';

export type LilypadSchemaCheckOptions = {
  /** The cached tables, as in their `LilypadDbSchema` (`tableName`, `primaryKey`). */
  tables: { table: string; primaryKey: string }[];
  /**
   * Checks the changelog table, its trigger function, that each table has the changelog trigger
   * (the `changelog` strategy), and how the changelog is pruned. `false` skips these checks.
   * Defaults to `{}`: the default changelog table.
   */
  changelog?:
    | {
        table?: string;
        /** How the old rows are deleted (see {@link LilypadChangelogPruning}). Defaults to `detect`. */
        pruning?: LilypadChangelogPruning;
        /**
         * The shortest retention the caches accept, in ms: the largest `maxGap` and `lookback` of
         * the caches that read this changelog. A pruning found with a retention that is not longer
         * is an error. Defaults to 1 hour (the default `maxGap`).
         */
        minRetention?: number;
      }
    | false;
  /**
   * Checks that each table has a trigger that sends notifications on this channel (the `listen`
   * strategy). The trigger may be the changelog trigger or one of your own: its function must call
   * `pg_notify` with the channel name as a literal. Defaults to `false`: not checked.
   *
   * The SQL that fixes a missing or outdated changelog notifies on this channel, or, with `false`,
   * on the channel the installed trigger function notifies on (none if it sends none).
   */
  notifyChannel?: string | false;
};

export type LilypadSchemaProblemCode =
  /** PostgreSQL is older than 13: the changelog needs `xid8`. */
  | 'unsupported-version'
  /** The cached table does not exist (as seen with the `search_path` of the gate). */
  | 'missing-table'
  /** The changelog table or its trigger function does not exist. */
  | 'missing-changelog'
  /** The changelog table or its trigger function was installed by an older version of the library. */
  | 'outdated-changelog'
  /**
   * The enabled changelog triggers of the table do not record each of INSERT, UPDATE and DELETE:
   * row triggers, or statement triggers with their transition tables.
   */
  | 'missing-changelog-trigger'
  /** The changelog trigger of the table records another column than the primary key. */
  | 'wrong-trigger-primary-key'
  /**
   * `TRUNCATE` of the table is not recorded (or not notified, with `notifyChannel`): it fires no
   * row trigger, so the caches would keep the removed rows.
   */
  | 'missing-truncate-trigger'
  /**
   * No enabled trigger of the table sends notifications on the channel, or not for each of INSERT,
   * UPDATE and DELETE.
   */
  | 'missing-notify-trigger'
  /**
   * A warning: nothing is known to delete the old changelog rows. Neither the `prune` option of
   * the trigger nor a pg_cron job was found, no row was ever deleted from the changelog, and
   * `pruning` is not `external`. The fix is the best pruning for the database.
   */
  | 'no-changelog-pruning'
  /**
   * A warning: the oldest changelog row is older than the retention (or 24 hours, if unknown)
   * plus 7 days, so the pruning does not run, or does not keep up.
   */
  | 'unpruned-changelog'
  /**
   * The pruning found deletes rows that are not older than `minRetention`: a cache could miss
   * changes without knowing it.
   */
  | 'short-changelog-retention';

/**
 * `error`: the caches can serve stale data, and `LilypadDbCache.create` rejects with
 * `verify: 'throw'`. `warning`: they work, but something needs attention; it is only logged.
 */
export type LilypadSchemaProblemSeverity = 'error' | 'warning';

export type LilypadSchemaProblem = {
  code: LilypadSchemaProblemCode;
  severity: LilypadSchemaProblemSeverity;
  /** The cached table concerned, for the per-table problems. */
  table?: string;
  message: string;
  /** SQL that fixes the problem, to run in a migration. */
  fix?: string;
};

export type LilypadSchemaCheckResult = {
  /** Whether there is no error (there may be warnings). */
  ok: boolean;
  problems: LilypadSchemaProblem[];
  /** The schema each table resolves to (`null` if the table does not exist). */
  tables: { table: string; schema: string | null }[];
};

/**
 * Thrown by `LilypadDbCache.create` with `verify: 'throw'` when the database is not set up (the
 * check found errors). Its `problems` include the warnings.
 */
export class LilypadSchemaCheckError extends Error {
  readonly problems: LilypadSchemaProblem[];

  constructor(subject: string, problems: LilypadSchemaProblem[]) {
    super(formatLilypadSchemaProblems(subject, problems));
    this.name = 'LilypadSchemaCheckError';
    this.problems = problems;
  }
}

/** A readable report of the problems, followed by the SQL that fixes them. */
export function formatLilypadSchemaProblems(
  subject: string,
  problems: LilypadSchemaProblem[]
): string {
  const lines = [
    problems.some((problem) => problem.severity === 'error')
      ? `${subject}: the database is not set up.`
      : `${subject}: the database is set up, with warnings.`,
  ];
  for (const problem of problems) {
    lines.push(`- ${problem.severity === 'warning' ? 'Warning: ' : ''}${problem.message}`);
  }
  const fixes = [...new Set(problems.flatMap((problem) => (problem.fix ? [problem.fix] : [])))];
  if (fixes.length > 0) {
    lines.push('Run this SQL in a migration to fix it:', ...fixes);
  }
  return lines.join('\n');
}

// pg_trigger.tgtype bits
const TRIGGER_TYPE_ROW = 1;
const TRIGGER_TYPE_INSERT = 4;
const TRIGGER_TYPE_DELETE = 8;
const TRIGGER_TYPE_UPDATE = 16;
const TRIGGER_TYPE_TRUNCATE = 32;
const ROW_EVENTS = TRIGGER_TYPE_INSERT | TRIGGER_TYPE_UPDATE | TRIGGER_TYPE_DELETE;
const ROW_EVENT_NAMES: [number, string][] = [
  [TRIGGER_TYPE_INSERT, 'INSERT'],
  [TRIGGER_TYPE_UPDATE, 'UPDATE'],
  [TRIGGER_TYPE_DELETE, 'DELETE'],
];
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

/**
 * The row events whose changes a trigger of the changelog function records: all its events for a
 * row trigger (versions 3 and earlier), and for a statement trigger the events whose transition
 * tables it declares under the names the function reads.
 */
function recordedEvents(trigger: LilypadTriggerInfo): number {
  if (!trigger.changelog || !trigger.enabled) {
    return 0;
  }
  const events = trigger.type & ROW_EVENTS;
  if ((trigger.type & TRIGGER_TYPE_ROW) !== 0) {
    return events;
  }
  const hasOld = trigger.oldTable === LILYPAD_CHANGELOG_OLD_ROWS;
  const hasNew = trigger.newTable === LILYPAD_CHANGELOG_NEW_ROWS;
  let recorded = 0;
  if ((events & TRIGGER_TYPE_INSERT) !== 0 && hasNew) {
    recorded |= TRIGGER_TYPE_INSERT;
  }
  if ((events & TRIGGER_TYPE_UPDATE) !== 0 && hasOld && hasNew) {
    recorded |= TRIGGER_TYPE_UPDATE;
  }
  if ((events & TRIGGER_TYPE_DELETE) !== 0 && hasOld) {
    recorded |= TRIGGER_TYPE_DELETE;
  }
  return recorded;
}

/** The names of the row events, e.g. `INSERT, DELETE`. */
function eventNames(events: number): string {
  return ROW_EVENT_NAMES.filter(([bit]) => (events & bit) !== 0)
    .map(([, name]) => name)
    .join(', ');
}

/** An enabled statement-level trigger on TRUNCATE. */
function firesOnTruncate(trigger: LilypadTriggerInfo): boolean {
  return (
    trigger.enabled &&
    (trigger.type & TRIGGER_TYPE_ROW) === 0 &&
    (trigger.type & TRIGGER_TYPE_TRUNCATE) !== 0
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The channel on which an installed changelog function sends notifications (its first
 * `pg_notify`, in the `TRUNCATE` branch, where the literal is not escaped for `format()`), or
 * `false` if it sends none.
 */
function installedNotifyChannel(source: string | null): string | false {
  const match = source ? /pg_notify\s*\(\s*'((?:[^']|'')*)'/i.exec(source) : null;
  return match?.[1] !== undefined ? match[1].replace(/''/g, "'") : false;
}

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
function changelogTarget(options: LilypadSchemaCheckOptions) {
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

const MINUTE = 60_000;
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
function formatDuration(ms: number): string {
  const units: [number, string][] = [
    [DAY, 'day'],
    [HOUR, 'hour'],
    [MINUTE, 'minute'],
    [1000, 'second'],
  ];
  for (const [size, name] of units) {
    if (ms >= size * (size === DAY ? 2 : 1)) {
      const amount = Math.round((ms / size) * 10) / 10;
      return `${amount} ${name}${amount === 1 ? '' : 's'}`;
    }
  }
  return `${Math.round(ms)} ms`;
}

// The units of an interval literal, most specific first where their names overlap
const INTERVAL_UNITS: [RegExp, number][] = [
  [/^(w|weeks?)$/, 7 * DAY],
  [/^(d|days?)$/, DAY],
  [/^(h|hrs?|hours?)$/, HOUR],
  [/^(mons?|months?)$/, 30 * DAY],
  [/^(m|mins?|minutes?)$/, MINUTE],
  [/^(s|secs?|seconds?)$/, 1000],
];

/** The duration of an interval literal (`24 hours`, `1 day 12:00:00`), or `undefined`. */
function parseInterval(text: string): number | undefined {
  let total = 0;
  let matched = false;
  for (const [, hours, minutes, seconds] of text.matchAll(/(\d+):(\d{2})(?::(\d{2}))?/g)) {
    total += Number(hours) * HOUR + Number(minutes) * MINUTE + Number(seconds ?? 0) * 1000;
    matched = true;
  }
  for (const [, amount, unit] of text.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
    const size = INTERVAL_UNITS.find(([pattern]) => pattern.test(unit!.toLowerCase()))?.[1];
    if (size !== undefined) {
      total += Number(amount) * size;
      matched = true;
    }
  }
  return matched ? total : undefined;
}

/**
 * The retention of a pruning command, from `make_interval(secs => ...)` (the SQL of the library)
 * or an interval literal (`interval '7 days'`, `'1 day'::interval`); `undefined` if not found.
 */
export function lilypadPruneCommandRetention(command: string): number | undefined {
  const seconds = /make_interval\s*\(\s*secs\s*=>\s*'?(\d+(?:\.\d+)?)'?\s*\)/i.exec(command);
  if (seconds) {
    return Number(seconds[1]) * 1000;
  }
  const literal = /interval\s*'([^']*)'|'([^']*)'\s*::\s*interval/i.exec(command);
  const text = literal?.[1] ?? literal?.[2];
  return text === undefined ? undefined : parseInterval(text);
}

/**
 * Whether a command deletes rows from the changelog table: a `DELETE FROM` of the same table name,
 * in the same schema when both name one. Case and quotes are ignored.
 */
export function lilypadCommandDeletesFrom(command: string, changelogTable: string): boolean {
  const target = changelogTable.replace(/"/g, '').toLowerCase().split('.');
  for (const [, name] of command.matchAll(/\bdelete\s+from\s+(?:only\s+)?([\w$."]+)/gi)) {
    const parts = name!.replace(/"/g, '').toLowerCase().split('.');
    if (
      parts.at(-1) === target.at(-1) &&
      (parts.length === 1 || target.length === 1 || parts.at(-2) === target.at(-2))
    ) {
      return true;
    }
  }
  return false;
}

/** A way the changelog is known to be pruned. */
type DetectedPruning = {
  /** For the messages, e.g. `the pg_cron job "x"`. */
  by: string;
  retention: number | undefined;
  /** The SQL that makes it prune with another retention. */
  fixWith: (olderThan: number) => string;
};

/**
 * The pruning problems of the changelog, and the `prune` option that the SQL fixing the changelog
 * must install: the installed one, or the one suggested when the trigger is the best pruning.
 */
function evaluatePruning(
  facts: LilypadSchemaFacts,
  changelog: NonNullable<ReturnType<typeof changelogTarget>>,
  options: Exclude<LilypadSchemaCheckOptions['changelog'], false>,
  changelogSql: (prune: LilypadChangelogPruneOptions | false) => string
): { problems: LilypadSchemaProblem[]; prune: LilypadChangelogPruneOptions | false } {
  const minRetention = options?.minRetention ?? DEFAULT_MIN_RETENTION;
  assertNumberOption('checkLilypadSchema', 'changelog.minRetention', minRetention, 'positive');
  const recommended = Math.max(DAY, 4 * minRetention);
  const installed = installedLilypadChangelogPrune(facts.changelog.functionSource);
  const problems: LilypadSchemaProblem[] = [];
  const detected: DetectedPruning[] = [];

  if (installed && facts.changelog.hasFunction) {
    if (!facts.changelog.hasPruneFunction) {
      problems.push({
        code: 'missing-changelog',
        severity: 'error',
        message: `The changelog trigger function prunes with ${pruneFunctionName(changelog.table)}(), which does not exist: the writes that prune fail.`,
        fix: changelogSql(installed),
      });
    }
    detected.push({
      by: 'the prune option of the changelog trigger',
      retention: installed.olderThan,
      fixWith: (olderThan) => changelogSql({ ...installed, olderThan }),
    });
  }

  // The jobs of this database that delete from the changelog table
  const cronJobs = (facts.cron.jobs ?? []).filter(
    (job) =>
      (job.database === null || job.database === facts.database) &&
      lilypadCommandDeletesFrom(job.command, changelog.table)
  );
  for (const job of cronJobs.filter((job) => job.active)) {
    const by =
      job.name !== null ? `the pg_cron job "${job.name}"` : `the pg_cron job ${job.id ?? ''}`;
    detected.push({
      by,
      retention: lilypadPruneCommandRetention(job.command),
      fixWith: (olderThan) =>
        (job.name === null && job.id !== null ? `SELECT cron.unschedule(${job.id});\n` : '') +
        lilypadChangelogPruneScheduleSql({
          olderThan,
          schedule: job.schedule || undefined,
          changelogTable: changelog.custom,
          jobName: job.name ?? undefined,
        }),
    });
  }

  for (const { by, retention, fixWith } of detected) {
    if (retention !== undefined && retention <= minRetention) {
      problems.push({
        code: 'short-changelog-retention',
        severity: 'error',
        message: `${capitalize(by)} deletes the changelog rows older than ${formatDuration(retention)}, but the caches need them for ${formatDuration(minRetention)} (their maxGap and lookback): a cache could miss changes without knowing it. Keep them far longer, e.g. ${formatDuration(recommended)}.`,
        fix: fixWith(recommended),
      });
    }
  }

  const age = facts.changelog.oldestRowAge;
  const external = options?.pruning === 'external' || facts.changelog.deletedRows > 0;
  let prune = installed;
  if (detected.length === 0 && !external) {
    const suggestion = suggestPruning(facts, changelog, recommended, changelogSql);
    const inactive = cronJobs.find((job) => !job.active);
    problems.push({
      code: 'no-changelog-pruning',
      severity: 'warning',
      message:
        `Nothing deletes the old rows of the changelog "${changelog.table}"` +
        (age !== null && age > DAY ? ` (the oldest is ${formatDuration(age)} old)` : '') +
        `: it grows with every change. ` +
        (inactive
          ? `The pg_cron job "${inactive.name ?? inactive.id ?? ''}" deletes them, but is inactive. `
          : '') +
        `${suggestion.message} If a job of your own deletes them (e.g. pruneLilypadChangelog from a scheduled function), set pruning: 'external'.`,
      fix: suggestion.fix,
    });
    prune = suggestion.prune ?? installed;
  } else if (age !== null) {
    const retentions = detected.flatMap(({ retention }) =>
      retention !== undefined ? [retention] : []
    );
    const retention = retentions.length > 0 ? Math.max(...retentions) : recommended;
    if (age > retention + UNPRUNED_MARGIN) {
      const by = detected.map((pruning) => pruning.by).join(' and ');
      problems.push({
        code: 'unpruned-changelog',
        severity: 'warning',
        message:
          `The oldest row of the changelog "${changelog.table}" is ${formatDuration(age)} old: ` +
          (by
            ? `${by} does not run, or does not keep up.`
            : `its pruning does not run, or does not keep up.`) +
          (installed
            ? ' The trigger deletes at most batchSize rows on one statement in every: raise batchSize or lower every if the statements change more rows on average.'
            : '') +
          ' The fix deletes the old rows once.',
        // Never fewer rows than the caches need, even if the pruning found keeps too few
        fix: `DELETE FROM ${quoteIdentifier(changelog.table)} WHERE ${olderThanCondition(Math.max(retention, recommended))};\n`,
      });
    }
  }
  return { problems, prune };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The best pruning for the database: a pg_cron job, which keeps the deletions out of the writes,
 * when pg_cron is known to run; otherwise the `prune` option of the trigger, which needs nothing.
 */
function suggestPruning(
  facts: LilypadSchemaFacts,
  changelog: NonNullable<ReturnType<typeof changelogTarget>>,
  olderThan: number,
  changelogSql: (prune: LilypadChangelogPruneOptions | false) => string
): { message: string; fix: string; prune?: LilypadChangelogPruneOptions } {
  const { cron } = facts;
  const retention = formatDuration(olderThan);
  if (cron.installed || cron.database === facts.database) {
    return {
      message: cron.installed
        ? `pg_cron is installed, with no job of this role that deletes them (the jobs of the other roles are not visible): the fix schedules a daily one, which deletes the rows older than ${retention}.`
        : `pg_cron runs in this database: the fix installs it and schedules a daily job that deletes the rows older than ${retention}.`,
      fix:
        (cron.installed ? '' : 'CREATE EXTENSION IF NOT EXISTS pg_cron;\n') +
        lilypadChangelogPruneScheduleSql({ olderThan, changelogTable: changelog.custom }),
    };
  }
  // pg_cron runs in another database: the job is scheduled there, and runs in this one
  const schema = changelog.table.includes('.') ? undefined : facts.changelog.schema;
  if (cron.database !== null && (schema || changelog.table.includes('.'))) {
    return {
      message: `pg_cron runs in the database "${cron.database}": the fix, to run there, schedules a daily job that deletes the rows older than ${retention} in this one.`,
      fix:
        `-- Run in the database "${cron.database}", where pg_cron runs:\n` +
        'CREATE EXTENSION IF NOT EXISTS pg_cron;\n' +
        lilypadChangelogPruneScheduleSql({
          olderThan,
          changelogTable: schema ? `${schema}.${changelog.table}` : changelog.table,
          database: facts.database,
        }),
    };
  }
  const prune = { olderThan };
  return {
    message:
      `The fix makes the changelog trigger delete the rows older than ${retention} as it records changes (the prune option of lilypadChangelogSql).` +
      (cron.available
        ? ` pg_cron is available on this server: if it is enabled (shared_preload_libraries), a pg_cron job keeps the deletions out of the writes: lilypadChangelogPruneScheduleSql({ olderThan: ${olderThan} }).`
        : ''),
    fix: changelogSql(prune),
    prune,
  };
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
  const sql = gate.sql;
  // Without a changelog to check, the default one is read anyway: its facts are then ignored
  const changelog = changelogTarget(options) ?? changelogTarget({ tables: [] })!;
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

  const tables: LilypadSchemaFacts['tables'] = [];
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
    tables.push(
      found
        ? {
            schema: found.schema_name as string,
            triggers: parseJsonColumn(found.triggers) as LilypadTriggerInfo[],
          }
        : { schema: null, triggers: [] }
    );
  }

  // How the changelog is pruned, only when it is checked. These reads are best effort: a role
  // that cannot read them leaves the facts unknown instead of failing the whole check.
  let oldestRowAge: number | null = null;
  let jobs: LilypadCronJobInfo[] | null = null;
  if (options.changelog !== false) {
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
    tables,
  };
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

/**
 * Checks that the database has what `LilypadDbCache` needs to learn about changes: the changelog
 * table, its trigger function and a trigger on each cached table, or a trigger that sends
 * notifications. It only reads the catalogs: it changes nothing.
 *
 * @returns The problems found, each with a message and, when the library can generate it, the SQL
 * that fixes it (`ok` is true when there is none).
 * @throws If the catalogs cannot be read (e.g. the database is unreachable).
 */
export async function checkLilypadSchema(
  gate: LilypadDbGate,
  options: LilypadSchemaCheckOptions
): Promise<LilypadSchemaCheckResult> {
  return evaluateLilypadSchema(await readLilypadSchemaFacts(gate, options), options);
}

/**
 * The problems of the facts read by {@link readLilypadSchemaFacts}, for these options. It is pure:
 * it reads no database.
 */
export function evaluateLilypadSchema(
  facts: LilypadSchemaFacts,
  options: LilypadSchemaCheckOptions
): LilypadSchemaCheckResult {
  const changelog = changelogTarget(options);
  const notifyChannel = options.notifyChannel ?? false;
  const installedPrune = installedLilypadChangelogPrune(facts.changelog.functionSource);
  const problems: LilypadSchemaProblem[] = [];

  if (facts.version < 130000) {
    problems.push({
      code: 'unsupported-version',
      severity: 'error',
      message: `PostgreSQL ${facts.version} is too old: the changelog needs PostgreSQL 13 or later.`,
    });
  }

  // Reported after the other problems, which the caches need first
  let pruningProblems: LilypadSchemaProblem[] = [];
  if (changelog) {
    // The fix notifies on the channel the check requires, or else on the one the installed function
    // notifies on: a changelog installed with `notifyChannel: false` must not start notifying, nor
    // one shared with `listen` caches stop
    const channel =
      notifyChannel !== false
        ? notifyChannel
        : installedNotifyChannel(facts.changelog.functionSource);
    const sqlWith = (prune: LilypadChangelogPruneOptions | false) =>
      lilypadChangelogSql({ table: changelog.custom, notifyChannel: channel, prune });
    // The SQL that fixes the changelog keeps the installed pruning, or installs the suggested one
    const pruning = evaluatePruning(facts, changelog, options.changelog || undefined, sqlWith);
    pruningProblems = pruning.problems;
    const changelogSql = sqlWith(pruning.prune);
    const { hasTable, hasSchemaColumn, hasFunction, functionComment } = facts.changelog;
    if (!hasTable || !hasFunction) {
      problems.push({
        code: 'missing-changelog',
        severity: 'error',
        message: !hasTable
          ? `The changelog table "${changelog.table}" does not exist.`
          : `The changelog trigger function ${changelog.functionSignature} does not exist.`,
        fix: changelogSql,
      });
    }
    const comment = functionComment ?? '';
    const version = comment.startsWith(LILYPAD_CHANGELOG_VERSION_PREFIX)
      ? Number(comment.slice(LILYPAD_CHANGELOG_VERSION_PREFIX.length))
      : 1;
    if ((hasTable && !hasSchemaColumn) || (hasFunction && version < LILYPAD_CHANGELOG_VERSION)) {
      problems.push({
        code: 'outdated-changelog',
        severity: 'error',
        message: `The changelog "${changelog.table}" was installed by an older version of the library (version ${version}, expected ${LILYPAD_CHANGELOG_VERSION}).`,
        fix: changelogSql,
      });
    }
  }

  const tables: LilypadSchemaCheckResult['tables'] = [];
  options.tables.forEach(({ table, primaryKey }, index) => {
    const found = facts.tables[index];
    if (!found || found.schema === null) {
      tables.push({ table, schema: null });
      problems.push({
        code: 'missing-table',
        severity: 'error',
        table,
        message: `The table "${table}" does not exist.`,
      });
      return;
    }
    tables.push({ table, schema: found.schema });
    const triggers = found.triggers;

    if (changelog) {
      const fix = lilypadChangelogTriggerSql({
        table,
        primaryKey,
        changelogTable: changelog.custom,
      });
      // The events may be split across several triggers (one statement trigger per event)
      const working = triggers.filter((trigger) => recordedEvents(trigger) !== 0);
      const recorded = working.reduce((events, trigger) => events | recordedEvents(trigger), 0);
      const recordedColumn = (trigger: LilypadTriggerInfo) => trigger.args.split('\\000')[0];
      const wrongColumn = working.find((trigger) => recordedColumn(trigger) !== primaryKey);
      if (recorded !== ROW_EVENTS) {
        problems.push({
          code: 'missing-changelog-trigger',
          severity: 'error',
          table,
          message: triggers.some((trigger) => trigger.changelog)
            ? `The changelog triggers of "${table}" do not record ${eventNames(ROW_EVENTS & ~recorded)}: they are missing, disabled, or lack their transition tables.`
            : `The table "${table}" has no changelog trigger: its changes are not recorded.`,
          fix,
        });
      } else if (wrongColumn) {
        problems.push({
          code: 'wrong-trigger-primary-key',
          severity: 'error',
          table,
          message: `The changelog trigger of "${table}" records the column "${recordedColumn(wrongColumn)}", not the primary key "${primaryKey}".`,
          fix,
        });
      } else if (!triggers.some((trigger) => trigger.changelog && firesOnTruncate(trigger))) {
        problems.push({
          code: 'missing-truncate-trigger',
          severity: 'error',
          table,
          message: `The changelog does not record TRUNCATE of "${table}": the caches would keep the removed rows.`,
          fix,
        });
      }
    }

    if (notifyChannel !== false) {
      const notifies = new RegExp(
        `pg_notify\\s*\\(\\s*'${escapeRegExp(notifyChannel.replace(/'/g, "''"))}'`,
        'i'
      );
      // The row events notified by any enabled trigger: they may be split across several triggers.
      // A statement trigger notifies each row only if it is a changelog trigger (version 4).
      const notifiedEvents = triggers
        .filter((trigger) => trigger.enabled && notifies.test(trigger.source))
        .reduce(
          (events, trigger) =>
            events |
            ((trigger.type & TRIGGER_TYPE_ROW) !== 0
              ? trigger.type & ROW_EVENTS
              : recordedEvents(trigger)),
          0
        );
      const fix =
        lilypadChangelogSql({ table: changelog?.custom, notifyChannel, prune: installedPrune }) +
        lilypadChangelogTriggerSql({ table, primaryKey, changelogTable: changelog?.custom });
      if (notifiedEvents === 0) {
        problems.push({
          code: 'missing-notify-trigger',
          severity: 'error',
          table,
          message: `No trigger of "${table}" sends notifications on the "${notifyChannel}" channel: the cache is not told about changes made elsewhere.`,
          fix,
        });
      } else if (notifiedEvents !== ROW_EVENTS) {
        problems.push({
          code: 'missing-notify-trigger',
          severity: 'error',
          table,
          message: `The triggers of "${table}" send notifications on the "${notifyChannel}" channel only on ${eventNames(notifiedEvents)}: the cache is not told about ${eventNames(ROW_EVENTS & ~notifiedEvents)} made elsewhere.`,
          fix,
        });
      } else if (
        !triggers.some((trigger) => firesOnTruncate(trigger) && notifies.test(trigger.source))
      ) {
        problems.push({
          code: 'missing-truncate-trigger',
          severity: 'error',
          table,
          message: `No trigger of "${table}" sends a notification on the "${notifyChannel}" channel for TRUNCATE: the caches would keep the removed rows.`,
          fix,
        });
      }
    }
  });

  problems.push(...pruningProblems);
  return { ok: !problems.some((problem) => problem.severity === 'error'), problems, tables };
}
