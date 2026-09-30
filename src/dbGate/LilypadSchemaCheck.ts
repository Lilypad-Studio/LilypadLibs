import type { LilypadChangelogPruning } from '@/dbConfig/LilypadDbConfig';
import type { LilypadDbGate } from '@/dbGate/LilypadDbGate';
import {
  LILYPAD_CHANGELOG_MIN_COMPATIBLE_VERSION,
  LILYPAD_CHANGELOG_NEW_ROWS,
  LILYPAD_CHANGELOG_OLD_ROWS,
  LILYPAD_CHANGELOG_VERSION,
  LILYPAD_CHANGELOG_VERSION_PREFIX,
  installedLilypadChangelogPrune,
  lilypadChangelogSql,
  lilypadChangelogTriggerSql,
  type LilypadChangelogPruneOptions,
} from '@/dbGate/LilypadChangelog';
import {
  changelogTarget,
  readChangelogTarget,
  readLilypadSchemaFacts,
  type LilypadSchemaFacts,
  type LilypadTriggerInfo,
} from '@/dbGate/LilypadSchemaFacts';
import { evaluatePruning } from '@/dbGate/LilypadSchemaPruning';
import {
  evaluateLilypadTableShape,
  lilypadCreateTableSql,
  lilypadMissingTableForeignKeys,
  type LilypadSchemaTableShape,
} from '@/dbGate/LilypadSchemaShape';

export type { LilypadChangelogPruning } from '@/dbConfig/LilypadDbConfig';
export {
  readLilypadSchemaFacts,
  type LilypadCronJobInfo,
  type LilypadSchemaFacts,
  type LilypadTriggerInfo,
} from '@/dbGate/LilypadSchemaFacts';
export { normalizeLilypadPgType } from '@/dbConfig/LilypadPgTypes';
export type { LilypadSchemaTableShape } from '@/dbGate/LilypadSchemaShape';
export {
  lilypadCommandDeletesFrom,
  lilypadPruneCommandRetention,
} from '@/dbGate/LilypadSchemaPruning';

/** A table to check, and what it needs. */
export type LilypadSchemaCheckTable = {
  /** `table`, or `schema.table` (as the tables of a config are named). */
  table: string;
  primaryKey: string;
  /**
   * Whether the table needs the changelog triggers (the `changelog` strategy). Defaults to true
   * when the options check the changelog.
   */
  changelog?: boolean | undefined;
  /**
   * The channel on which the table needs notifying triggers (the `listen` strategy), or `false`.
   * Defaults to the `notifyChannel` of the options.
   */
  notifyChannel?: string | false | undefined;
  /**
   * The columns, keys, indexes and checks the table must have (a table definition of a config is
   * one). Without it, only the table and its triggers are checked.
   */
  shape?: LilypadSchemaTableShape | undefined;
};

export type LilypadSchemaCheckOptions = {
  tables: LilypadSchemaCheckTable[];
  /**
   * Checks the changelog table, its trigger function, that the tables that need it have the
   * changelog trigger (the `changelog` strategy), and how the changelog is pruned. `false` skips
   * these checks. Defaults to `{}`: the default changelog table.
   */
  changelog?:
    | {
        table?: string | undefined;
        /** How the old rows are deleted (see {@link LilypadChangelogPruning}). Defaults to `detect`. */
        pruning?: LilypadChangelogPruning | undefined;
        /**
         * The shortest retention the caches accept, in ms: the largest `maxGap` and `lookback` of
         * the caches that read this changelog. A pruning found with a retention that is not longer
         * is an error. Defaults to 1 hour (the default `maxGap`).
         */
        minRetention?: number | undefined;
        /**
         * Whether to check how the changelog is pruned (reads `cron.job` and the age of the oldest
         * row). Defaults to true.
         */
        checkPruning?: boolean | undefined;
      }
    | false
    | undefined;
  /**
   * With `changelog: false`, the changelog table whose trigger function the SQL that fixes the
   * notifying triggers installs (it notifies too). Defaults to `lilypad_cache_changes`.
   */
  changelogTable?: string | undefined;
  /**
   * Checks that the tables have a trigger that sends notifications on this channel (the `listen`
   * strategy), unless a table sets its own `notifyChannel`. The trigger may be the changelog trigger
   * or one of your own: its function must call `pg_notify` with the channel name as a literal.
   * Defaults to `false`: not checked.
   *
   * The SQL that fixes a missing or outdated changelog notifies on this channel, or, with `false`,
   * on the channel the installed trigger function notifies on (none if it sends none).
   */
  notifyChannel?: string | false | undefined;
};

export type LilypadSchemaProblemCode =
  /** PostgreSQL is older than 13: the changelog needs `xid8`. */
  | 'unsupported-version'
  /** The cached table does not exist (as seen with the `search_path` of the gate). */
  | 'missing-table'
  /** The changelog table or its trigger function does not exist. */
  | 'missing-changelog'
  /**
   * The changelog table or its trigger function was installed by an older version of the library:
   * an error if the caches cannot read it correctly, a warning if it only lacks an improvement.
   */
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
   * `pruning` is not `external`. The fix is the best pruning for the database, or the one
   * `pruning` asks for (`trigger` or `cron`).
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
  | 'short-changelog-retention'
  /** A column of the description does not exist. */
  | 'missing-column'
  /**
   * The type of a column is not its `pgType` (an error), or does not fit its `type` (a warning:
   * e.g. a `numeric` column declared as `number`, which postgres.js returns as a string).
   */
  | 'column-type-mismatch'
  /** A column accepts `NULL` although declared not nullable, or the reverse. */
  | 'column-nullability-mismatch'
  /** A column declared with a default (or the generated primary key) has none. */
  | 'missing-column-default'
  /**
   * The primary key of the description is not the primary key of the table: an error if it is not
   * unique, a warning if a unique index and `NOT NULL` make it a key anyway.
   */
  | 'wrong-primary-key'
  /** No unique constraint or index covers exactly the columns of a unique key. */
  | 'missing-unique-key'
  /** A foreign key of the description does not exist (same columns, same referenced table). */
  | 'missing-foreign-key'
  /** A foreign key exists with other `ON DELETE` / `ON UPDATE` actions. */
  | 'foreign-key-mismatch'
  /** An index does not exist: an error for a unique index, a warning otherwise. */
  | 'missing-index'
  /** A check of the description does not exist (found by its name). */
  | 'missing-check'
  /**
   * A warning: a `NOT NULL` column without a default is not in the description, so the inserts
   * of the library fail.
   */
  | 'undeclared-required-column'
  /** A warning of `strict`: a column of the table is not in the description. */
  | 'undeclared-column'
  /** A warning of `strict`: a unique key, foreign key or check is not in the description. */
  | 'undeclared-constraint'
  /** A warning of `strict`: an index is not in the description. */
  | 'undeclared-index';

/**
 * `error`: the database is not what the config describes (the caches may serve stale data, the
 * queries may fail), and `lilypad-doctor` exits with 1. `warning`: it works, but something needs
 * attention.
 */
export type LilypadSchemaProblemSeverity = 'error' | 'warning';

export type LilypadSchemaProblem = {
  code: LilypadSchemaProblemCode;
  severity: LilypadSchemaProblemSeverity;
  /** The cached table concerned, for the per-table problems. */
  table?: string | undefined;
  message: string;
  /** SQL that fixes the problem, to run in a migration. */
  fix?: string | undefined;
};

export type LilypadSchemaCheckResult = {
  /** Whether there is no error (there may be warnings). */
  ok: boolean;
  problems: LilypadSchemaProblem[];
  /** The schema each table resolves to (`null` if the table does not exist). */
  tables: { table: string; schema: string | null }[];
};

/**
 * Thrown by `assertOk()` of a `lilypad-doctor` report when the database is not set up (the check
 * found errors). Its `problems` include the warnings.
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
/**
 * The row events whose changes a trigger of the changelog function records: for a statement
 * trigger, the events whose transition tables it declares under the names the function reads. A
 * row trigger (installed by version 3 and earlier) records nothing: the function no longer serves
 * it.
 */
function recordedEvents(trigger: LilypadTriggerInfo): number {
  if (!trigger.changelog || !trigger.enabled || (trigger.type & TRIGGER_TYPE_ROW) !== 0) {
    return 0;
  }
  const events = trigger.type & ROW_EVENTS;
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
  // The changelog that the fixes install: the checked one, or else `changelogTable`
  const fixChangelog = readChangelogTarget(options);
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
    // Without the pruning check, the SQL that fixes the changelog keeps the installed pruning
    const pruning =
      options.changelog && options.changelog.checkPruning === false
        ? { problems: [], prune: installedPrune }
        : evaluatePruning(
            facts,
            changelog,
            options.changelog === false ? undefined : options.changelog,
            sqlWith
          );
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
      const compatible =
        (!hasTable || hasSchemaColumn) && version >= LILYPAD_CHANGELOG_MIN_COMPATIBLE_VERSION;
      problems.push({
        code: 'outdated-changelog',
        severity: compatible ? 'warning' : 'error',
        message:
          `The changelog "${changelog.table}" was installed by an older version of the library (version ${version}, expected ${LILYPAD_CHANGELOG_VERSION})` +
          (compatible ? `: the caches read it, but ${outdatedChangelogReason(version)}.` : '.'),
        fix: changelogSql,
      });
    }
  }

  const tables: LilypadSchemaCheckResult['tables'] = [];
  // The foreign keys to create, after every table (see LilypadShapeProblems)
  const deferred: LilypadSchemaProblem[] = [];
  options.tables.forEach((requirement, index) => {
    const { table, primaryKey, shape } = requirement;
    const needsChangelog = changelog !== undefined && requirement.changelog !== false;
    const tableChannel = requirement.notifyChannel ?? notifyChannel;
    const found = facts.tables[index];
    // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- a missing table has no facts
    if (!found || found.schema === null) {
      tables.push({ table, schema: null });
      // The table, then the triggers it needs
      const createTable = shape && lilypadCreateTableSql(table, primaryKey, shape);
      // Without the changelog check, its SQL (which notifies) is not in the fix of another problem
      const triggerSql =
        needsChangelog || tableChannel !== false
          ? (needsChangelog
              ? ''
              : lilypadChangelogSql({
                  table: fixChangelog.custom,
                  notifyChannel: tableChannel,
                  prune: installedPrune,
                })) +
            lilypadChangelogTriggerSql({ table, primaryKey, changelogTable: fixChangelog.custom })
          : '';
      problems.push({
        code: 'missing-table',
        severity: 'error',
        table,
        message: `The table "${table}" does not exist.`,
        ...(createTable !== undefined && { fix: `${createTable}\n${triggerSql}`.trimEnd() }),
      });
      if (shape) {
        deferred.push(...lilypadMissingTableForeignKeys(table, shape));
      }
      return;
    }
    tables.push({ table, schema: found.schema });
    const triggers = found.triggers;

    if (shape && found.columns) {
      const shapeProblems = evaluateLilypadTableShape(table, primaryKey, shape, found);
      problems.push(...shapeProblems.problems);
      deferred.push(...shapeProblems.deferred);
    }

    if (needsChangelog) {
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
            ? `The changelog triggers of "${table}" do not record ${eventNames(ROW_EVENTS & ~recorded)}: they are missing, disabled, lack their transition tables, or are the row trigger of an older version.`
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

    if (tableChannel !== false) {
      const notifies = new RegExp(
        `pg_notify\\s*\\(\\s*'${escapeRegExp(tableChannel.replace(/'/g, "''"))}'`,
        'i'
      );
      // The row events notified by any enabled trigger: they may be split across several triggers.
      // A statement trigger notifies each row only if it is a changelog trigger, and a row trigger
      // only if it is one of your own (the changelog function no longer serves row triggers).
      const notifiedEvents = triggers
        .filter((trigger) => trigger.enabled && notifies.test(trigger.source))
        .reduce(
          (events, trigger) =>
            events |
            ((trigger.type & TRIGGER_TYPE_ROW) !== 0
              ? trigger.changelog
                ? 0
                : trigger.type & ROW_EVENTS
              : recordedEvents(trigger)),
          0
        );
      const fix =
        lilypadChangelogSql({
          table: fixChangelog.custom,
          notifyChannel: tableChannel,
          prune: installedPrune,
        }) + lilypadChangelogTriggerSql({ table, primaryKey, changelogTable: fixChangelog.custom });
      if (notifiedEvents === 0) {
        problems.push({
          code: 'missing-notify-trigger',
          severity: 'error',
          table,
          message: `No trigger of "${table}" sends notifications on the "${tableChannel}" channel: the cache is not told about changes made elsewhere.`,
          fix,
        });
      } else if (notifiedEvents !== ROW_EVENTS) {
        problems.push({
          code: 'missing-notify-trigger',
          severity: 'error',
          table,
          message: `The triggers of "${table}" send notifications on the "${tableChannel}" channel only on ${eventNames(notifiedEvents)}: the cache is not told about ${eventNames(ROW_EVENTS & ~notifiedEvents)} made elsewhere.`,
          fix,
        });
      } else if (
        !triggers.some((trigger) => firesOnTruncate(trigger) && notifies.test(trigger.source))
      ) {
        problems.push({
          code: 'missing-truncate-trigger',
          severity: 'error',
          table,
          message: `No trigger of "${table}" sends a notification on the "${tableChannel}" channel for TRUNCATE: the caches would keep the removed rows.`,
          fix,
        });
      }
    }
  });

  problems.push(...deferred, ...pruningProblems);
  return { ok: !problems.some((problem) => problem.severity === 'error'), problems, tables };
}

/** What a changelog of a compatible older version lacks (see `LILYPAD_CHANGELOG_VERSION`). */
function outdatedChangelogReason(version: number): string {
  const beforeVersion6 =
    'its prune function (`prune` option) can be made to run the code of any role with the privileges of its owner, the triggers of a long table name record only TRUNCATE, and a name containing `$` breaks its SQL';
  return version < 5
    ? `a statement that changes many rows notifies each of them instead of sending one BULK notification; ${beforeVersion6}`
    : beforeVersion6;
}
