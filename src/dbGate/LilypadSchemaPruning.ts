import {
  installedLilypadChangelogPrune,
  lilypadChangelogPruneScheduleSql,
  olderThanCondition,
  pruneFunctionName,
  quoteIdentifier,
  type LilypadChangelogPruneOptions,
} from '@/dbGate/LilypadChangelog';
import type { LilypadChangelogPruning } from '@/dbConfig/LilypadDbConfig';
import type { LilypadChangelogTarget, LilypadSchemaFacts } from '@/dbGate/LilypadSchemaFacts';
import type { LilypadSchemaCheckOptions, LilypadSchemaProblem } from '@/dbGate/LilypadSchemaTypes';
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
  [/^(y|yrs?|years?)$/, 365 * DAY],
  [/^(w|weeks?)$/, 7 * DAY],
  [/^(d|days?)$/, DAY],
  [/^(h|hrs?|hours?)$/, HOUR],
  [/^(mons?|months?)$/, 30 * DAY],
  [/^(m|mins?|minutes?)$/, MINUTE],
  [/^(s|secs?|seconds?)$/, 1000],
  [/^(ms|msecs?|milliseconds?)$/, 1],
];

/**
 * The duration of an interval literal (`24 hours`, `1 day 12:00:00`), or `undefined` when any part
 * of it is not understood (an ISO 8601 `P1M`, a sign, `ago`, an unknown unit): an unknown retention
 * is accepted, where a misread one could be reported as too short.
 */
function parseInterval(text: string): number | undefined {
  const parts = text.trim().toLowerCase().split(/\s+/);
  let total = 0;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    const clock = /^(\d+):(\d{2})(?::(\d{2}(?:\.\d+)?))?$/.exec(part);
    if (clock) {
      total += Number(clock[1]) * HOUR + Number(clock[2]) * MINUTE + Number(clock[3] ?? 0) * 1000;
      continue;
    }
    // `24 hours` or `24hours`
    const joined = /^(\d+(?:\.\d+)?)([a-z]+)?$/.exec(part);
    const amount = joined?.[1];
    const unit = joined?.[2] ?? parts[++index];
    const size =
      unit === undefined ? undefined : INTERVAL_UNITS.find(([pattern]) => pattern.test(unit))?.[1];
    if (amount === undefined || size === undefined) {
      return undefined;
    }
    total += Number(amount) * size;
  }
  return parts[0] === '' ? undefined : total;
}

/** Whether the text ends with a character of an identifier (a `$` or `E` there is part of it). */
const ENDS_IN_IDENTIFIER = /[\w$]$/;
/** A dollar quote delimiter: `$$` or `$tag$` (sticky: read at `lastIndex`). */
const DOLLAR_QUOTE = /\$(?:[A-Za-z_]\w*)?\$/y;
/** A `DO` statement up to its body: `DO`, or `DO LANGUAGE x`. */
const DO_STATEMENT = /^do(?:\s+language\s+\w+)?$/i;

/**
 * The statements of a SQL command, as the pruning check reads them: split at the semicolons outside
 * the literals and quoted identifiers, which are kept as they are, without their comments (replaced
 * with a space; PostgreSQL nests the block comments). An escape string (`E'...'`, whose `\'` does
 * not end it) and a dollar-quoted string become `''`, except the dollar-quoted body of a `DO`
 * block, which is code: its statements, read the same way, stay in the `DO` statement. `undefined`
 * when a comment, a literal (dollar-quoted too) or a quoted identifier is not closed, or the body of
 * a `DO` block is not understood: the command is not understood.
 */
function commandStatements(command: string): string[] | undefined {
  const statements: string[] = [];
  let current = '';
  let index = 0;
  while (index < command.length) {
    const char = command[index]!;
    if (char === "'" || char === '"') {
      const escapes =
        char === "'" && /[eE]$/.test(current) && !ENDS_IN_IDENTIFIER.test(current.slice(0, -1));
      let end = index + 1;
      for (;;) {
        if (end >= command.length) {
          return undefined;
        }
        if (escapes && command[end] === '\\') {
          end += 2;
        } else if (command[end] !== char) {
          end++;
        } else if (command[end + 1] === char) {
          end += 2;
        } else {
          break;
        }
      }
      current = escapes ? `${current.slice(0, -1)}''` : current + command.slice(index, end + 1);
      index = end + 1;
    } else if (command.startsWith('--', index)) {
      const end = command.indexOf('\n', index);
      current += ' ';
      index = end === -1 ? command.length : end;
    } else if (command.startsWith('/*', index)) {
      let depth = 0;
      do {
        if (index >= command.length) {
          return undefined;
        }
        if (command.startsWith('/*', index)) {
          depth++;
          index += 2;
        } else if (command.startsWith('*/', index)) {
          depth--;
          index += 2;
        } else {
          index++;
        }
      } while (depth > 0);
      current += ' ';
    } else if (char === ';') {
      statements.push(current);
      current = '';
      index++;
    } else {
      DOLLAR_QUOTE.lastIndex = index;
      const delimiter =
        char !== '$' || ENDS_IN_IDENTIFIER.test(current)
          ? undefined
          : DOLLAR_QUOTE.exec(command)?.[0];
      if (delimiter === undefined) {
        current += char;
        index++;
        continue;
      }
      const start = index + delimiter.length;
      const end = command.indexOf(delimiter, start);
      if (end === -1) {
        return undefined;
      }
      if (DO_STATEMENT.test(current.trim())) {
        // The body of a DO block is code: read the same way, in the DO statement
        const body = commandStatements(command.slice(start, end));
        if (body === undefined) {
          return undefined;
        }
        current += ` ${body.join('; ')} `;
      } else {
        // Any other dollar-quoted string is a literal
        current += "''";
      }
      index = end + delimiter.length;
    }
  }
  statements.push(current);
  return statements.map((statement) => statement.trim()).filter((statement) => statement !== '');
}

// An identifier: quoted (its case kept) or not (folded to lower case, as PostgreSQL does)
const IDENTIFIER = String.raw`(?:"(?:[^"]|"")+"|[\w$]+)`;
const DELETE_FROM = new RegExp(
  String.raw`\bdelete\s+from\s+(?:only\s+)?(${IDENTIFIER}(?:\s*\.\s*${IDENTIFIER})?)`,
  'gi'
);

/** The parts of a name of a command, as PostgreSQL reads them. */
function nameParts(name: string): string[] {
  return [...name.matchAll(new RegExp(IDENTIFIER, 'g'))].map(([part]) =>
    part.startsWith('"') ? part.slice(1, -1).replace(/""/g, '"') : part.toLowerCase()
  );
}

/** `make_interval(secs => ...)` (the SQL of the library), `interval '...'` or `'...'::interval`. */
const INTERVAL =
  /make_interval\s*\(\s*secs\s*=>\s*'?(\d+(?:\.\d+)?)'?\s*\)|\binterval\s*'([^']*)'|'([^']*)'\s*::\s*interval\b/gi;

/**
 * Whether a statement (see `commandStatements`) deletes rows from the changelog table: a
 * `DELETE FROM` of the same table name, in the same schema when both name one. The names are
 * compared as PostgreSQL does: an unquoted name of the command in lower case, the name of the
 * changelog table as it is (the library quotes it).
 */
function statementDeletesFrom(statement: string, changelogTable: string): boolean {
  const target = changelogTable.split('.');
  return [...statement.matchAll(DELETE_FROM)].some(([, name]) => {
    const parts = nameParts(name!);
    return (
      parts.at(-1) === target.at(-1) &&
      (parts.length === 1 || target.length === 1 || parts.at(-2) === target.at(-2))
    );
  });
}

/** Whether a command deletes rows from the changelog table (a command not understood does not). */
export function lilypadCommandDeletesFrom(command: string, changelogTable: string): boolean {
  return (commandStatements(command) ?? []).some((statement) =>
    statementDeletesFrom(statement, changelogTable)
  );
}

/**
 * The retention of a command that prunes the changelog: the interval (`make_interval(secs => ...)`,
 * the SQL of the library, or a literal: `interval '7 days'`, `'1 day'::interval`) of the one
 * statement that deletes from it, a `DELETE` with one interval. `undefined` in any other case, or
 * if the interval is not understood: an interval may be that of another statement or condition.
 */
export function lilypadPruneCommandRetention(
  command: string,
  changelogTable: string
): number | undefined {
  const deleting = (commandStatements(command) ?? []).filter((statement) =>
    statementDeletesFrom(statement, changelogTable)
  );
  const [statement] = deleting;
  if (deleting.length !== 1 || !/^delete\s+from\b/i.test(statement!)) {
    return undefined;
  }
  const intervals = [...statement!.matchAll(INTERVAL)];
  if (intervals.length !== 1) {
    return undefined;
  }
  const [, seconds, literal, cast] = intervals[0]!;
  return seconds !== undefined ? Number(seconds) * 1000 : parseInterval(literal ?? cast ?? '');
}

/**
 * A statement that only deletes the old rows, as the job of the library does: `DELETE FROM <name>
 * WHERE changed_at < <now> - <interval>`, and nothing else. Only a job whose command is this one
 * statement can be scheduled again with another retention without losing part of its command.
 */
const PRUNE_ONLY = new RegExp(
  String.raw`^delete\s+from\s+(?:only\s+)?${IDENTIFIER}(?:\s*\.\s*${IDENTIFIER})?\s+where\s+"?changed_at"?\s*<=?\s*(?:now\s*\(\s*\)|current_timestamp|clock_timestamp\s*\(\s*\))\s*-\s*(?:make_interval\s*\(\s*secs\s*=>\s*'?\d+(?:\.\d+)?'?\s*\)|interval\s*'[^']*'|'[^']*'\s*::\s*interval)$`,
  'i'
);

/** Whether a command is one statement that only deletes the old rows (see `PRUNE_ONLY`). */
function onlyPrunes(command: string): boolean {
  const statements = commandStatements(command);
  return statements?.length === 1 && PRUNE_ONLY.test(statements[0]!);
}

/** A way the changelog is known to be pruned. */
type DetectedPruning = {
  /** For the messages, e.g. `the pg_cron job "x"`. */
  by: string;
  retention: number | undefined;
  /**
   * The SQL that makes it prune with another retention: none for a job whose command does more than
   * delete the old rows (scheduled again, it would lose the rest of its command).
   */
  fixWith: ((olderThan: number) => string) | undefined;
};

/**
 * The pruning problems of the changelog, and the `prune` option that the SQL fixing the changelog
 * must install: the installed one, or the one suggested when the trigger is the best pruning.
 */
export function evaluatePruning(
  facts: LilypadSchemaFacts,
  changelog: LilypadChangelogTarget,
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

  // The jobs of this database that delete from the changelog table: in the schema it resolves to,
  // when a job qualifies the name (not the table of the same name in another schema)
  const jobTarget =
    changelog.table.includes('.') || facts.changelog.schema === null
      ? changelog.table
      : `${facts.changelog.schema}.${changelog.table}`;
  const cronJobs = (facts.cron.jobs ?? []).filter(
    (job) =>
      (job.database === null || job.database === facts.database) &&
      lilypadCommandDeletesFrom(job.command, jobTarget)
  );
  for (const job of cronJobs.filter((job) => job.active)) {
    const by =
      job.name !== null ? `the pg_cron job "${job.name}"` : `the pg_cron job ${job.id ?? ''}`;
    detected.push({
      by,
      retention: lilypadPruneCommandRetention(job.command, jobTarget),
      fixWith: onlyPrunes(job.command)
        ? (olderThan) =>
            (job.name === null && job.id !== null ? `SELECT cron.unschedule(${job.id});\n` : '') +
            lilypadChangelogPruneScheduleSql({
              olderThan,
              schedule: job.schedule || undefined,
              changelogTable: changelog.custom,
              jobName: job.name ?? undefined,
            })
        : undefined,
    });
  }

  for (const { by, retention, fixWith } of detected) {
    if (retention !== undefined && retention <= minRetention) {
      problems.push({
        code: 'short-changelog-retention',
        severity: 'error',
        message:
          `${capitalize(by)} deletes the changelog rows older than ${formatDuration(retention)}, but the caches need them for ${formatDuration(minRetention)} (their maxGap and lookback): a cache could miss changes without knowing it. Keep them far longer, e.g. ${formatDuration(recommended)}.` +
          (fixWith
            ? ''
            : ' Its command does more than delete the old rows: change its interval there (scheduling the job again would drop the rest).'),
        ...(fixWith && { fix: fixWith(recommended) }),
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
      ...(suggestion.fixDatabase !== undefined && { fixDatabase: suggestion.fixDatabase }),
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
  changelog: LilypadChangelogTarget,
  olderThan: number,
  changelogSql: (prune: LilypadChangelogPruneOptions | false) => string,
  pruning: LilypadChangelogPruning
): {
  message: string;
  fix: string;
  /** The database the fix runs in, when it is not this one. */
  fixDatabase?: string | undefined;
  prune?: LilypadChangelogPruneOptions | undefined;
} {
  const { cron } = facts;
  const retention = formatDuration(olderThan);
  const trigger = `The fix makes the changelog trigger delete the rows older than ${retention} as it records changes (the prune option of lilypadChangelogSql).`;
  if (pruning === 'trigger') {
    const prune = { olderThan };
    return { message: trigger, fix: changelogSql(prune), prune };
  }
  if (cron.installed || cron.database === facts.database) {
    return {
      message: !cron.installed
        ? `pg_cron runs in this database: the fix installs it and schedules a daily job that deletes the rows older than ${retention}.`
        : cron.jobs === null
          ? `pg_cron is installed, but the role of the check cannot read its jobs (cron.job, in the schema cron): if none deletes them, the fix schedules a daily one, which deletes the rows older than ${retention}.`
          : `pg_cron is installed, with no job of this role that deletes them (the jobs of the other roles are not visible): the fix schedules a daily one, which deletes the rows older than ${retention}.`,
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
      fixDatabase: cron.database,
      fix:
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
