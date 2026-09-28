import {
  installedLilypadChangelogPrune,
  lilypadChangelogPruneScheduleSql,
  olderThanCondition,
  pruneFunctionName,
  quoteIdentifier,
  type LilypadChangelogPruneOptions,
} from '@/dbGate/LilypadChangelog';
import type { changelogTarget, LilypadSchemaFacts } from '@/dbGate/LilypadSchemaFacts';
import type {
  LilypadChangelogPruning,
  LilypadSchemaCheckOptions,
  LilypadSchemaProblem,
} from '@/dbGate/LilypadSchemaCheck';
import { assertNumberOption } from '@/internal/LilypadValidation';

/**
 * How the changelog is pruned: the `prune` option of its trigger and the pg_cron jobs that delete
 * from it, their retention, and the best pruning to suggest when none is found. `lilypad-doctor`
 * checks it whenever a table of the config reads the changelog.
 */

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
export function evaluatePruning(
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
    const suggestion = suggestPruning(
      facts,
      changelog,
      recommended,
      changelogSql,
      options?.pruning ?? 'detect'
    );
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
        `${suggestion.message} If a job of your own deletes them (e.g. pruneLilypadChangelog from a scheduled function), set pruning: 'external'.` +
        (options?.pruning === 'trigger' || options?.pruning === 'cron'
          ? ''
          : ` To choose the suggested pruning, set pruning: 'trigger' or 'cron'.`),
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
 * `pruning: 'trigger'` or `'cron'` asks for one of them whatever the database.
 */
function suggestPruning(
  facts: LilypadSchemaFacts,
  changelog: NonNullable<ReturnType<typeof changelogTarget>>,
  olderThan: number,
  changelogSql: (prune: LilypadChangelogPruneOptions | false) => string,
  pruning: LilypadChangelogPruning
): { message: string; fix: string; prune?: LilypadChangelogPruneOptions | undefined } {
  const { cron } = facts;
  const retention = formatDuration(olderThan);
  const trigger = `The fix makes the changelog trigger delete the rows older than ${retention} as it records changes (the prune option of lilypadChangelogSql).`;
  if (pruning === 'trigger') {
    const prune = { olderThan };
    return { message: trigger, fix: changelogSql(prune), prune };
  }
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
  // pg_cron runs in another database: the job is scheduled there, and runs in this one. With
  // `detect`, only if the table can be qualified with its schema (the job has the search_path of
  // its role); else the trigger, which needs neither
  const qualified = changelog.table.includes('.');
  const schema = qualified ? undefined : facts.changelog.schema;
  if (cron.database !== null && (schema || qualified || pruning === 'cron')) {
    return {
      message:
        `pg_cron runs in the database "${cron.database}": the fix, to run there, schedules a daily job that deletes the rows older than ${retention} in this one.` +
        (schema || qualified
          ? ''
          : ` Qualify the changelog table with its schema if it is not on the search_path of the role of the job.`) +
        (pruning === 'cron'
          ? ''
          : ` If you cannot run SQL there (e.g. on a managed host), make the changelog trigger delete them as it records changes, from this database: lilypadChangelogSql({ prune: { olderThan: ${olderThan} } }).`),
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
  // Where pg_cron runs is unknown (e.g. `cron.database_name` is hidden from the role): this one
  if (pruning === 'cron') {
    const table = qualified ? changelog.table : `${schema ?? '<schema>'}.${changelog.table}`;
    return {
      message:
        `The fix installs pg_cron and schedules a daily job that deletes the rows older than ${retention}.` +
        (cron.available ? '' : ' pg_cron is not available on this server yet.') +
        ` pg_cron runs in the one database set by cron.database_name, which must be this one, "${facts.database}" (on a managed host such as Neon, set it in the settings of the host first).` +
        ` If it is another one, schedule the job from there instead: lilypadChangelogPruneScheduleSql({ olderThan: ${olderThan}, changelogTable: '${table}', database: '${facts.database}' }).`,
      fix:
        'CREATE EXTENSION IF NOT EXISTS pg_cron;\n' +
        lilypadChangelogPruneScheduleSql({ olderThan, changelogTable: changelog.custom }),
    };
  }
  const prune = { olderThan };
  return {
    message:
      trigger +
      (cron.available
        ? ` pg_cron is available on this server: if it is enabled (shared_preload_libraries), a pg_cron job keeps the deletions out of the writes: lilypadChangelogPruneScheduleSql({ olderThan: ${olderThan} }).`
        : ''),
    fix: changelogSql(prune),
    prune,
  };
}
