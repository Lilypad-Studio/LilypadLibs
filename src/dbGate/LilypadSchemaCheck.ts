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
  quoteIdentifier,
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
} from '@/dbGate/LilypadSchemaShape';
import type {
  LilypadSchemaCheckOptions,
  LilypadSchemaCheckResult,
  LilypadSchemaProblem,
} from '@/dbGate/LilypadSchemaTypes';

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

/**
 * The fixes of the problems, once each, in the order of the problems: first those of the checked
 * database (`undefined`), then those to run in another one (`fixDatabase`), by database.
 */
function groupedFixes(problems: LilypadSchemaProblem[]): Map<string | undefined, string[]> {
  const groups = new Map<string | undefined, Set<string>>([[undefined, new Set()]]);
  for (const { fix, fixDatabase } of problems) {
    if (fix) {
      const group = groups.get(fixDatabase) ?? new Set();
      groups.set(fixDatabase, group.add(fix));
    }
  }
  return new Map([...groups].map(([database, fixes]) => [database, [...fixes]]));
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
  for (const [database, fixes] of groupedFixes(problems)) {
    if (fixes.length > 0) {
      lines.push(
        database === undefined
          ? 'Run this SQL in a migration to fix it:'
          : `Run this SQL in the database "${database}":`,
        ...fixes
      );
    }
  }
  return lines.join('\n');
}

/**
 * The SQL that fixes the problems in the checked database, for a migration (`lilypad-doctor
 * --sql`): the fixes to run in another database follow as comments. Empty without any fix.
 */
export function formatLilypadSchemaFixSql(problems: LilypadSchemaProblem[]): string {
  const parts: string[] = [];
  for (const [database, fixes] of groupedFixes(problems)) {
    if (database === undefined) {
      parts.push(...fixes);
    } else if (fixes.length > 0) {
      const commented = fixes.join('\n').trimEnd().replace(/^/gm, '-- ');
      parts.push(`-- Run in the database "${database}", not in this one:\n${commented}\n`);
    }
  }
  return parts.join('\n');
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
  const installedChannel = installedNotifyChannel(facts.changelog.functionSource);
  const problems: LilypadSchemaProblem[] = [];

  if (facts.version < 130000) {
    problems.push({
      code: 'unsupported-version',
      severity: 'error',
      message: `PostgreSQL ${facts.version} is too old: the changelog needs PostgreSQL 13 or later.`,
    });
  }

  // The trigger function notifies on one channel, the same in every fix that installs it: the one
  // the check requires, else the installed one when no table needs another (a changelog installed
  // with `notifyChannel: false` must not start notifying, nor one shared with `listen` caches
  // stop), else the channel of the first table that needs one
  const tableChannels = options.tables.flatMap(({ notifyChannel: channel = notifyChannel }) =>
    channel === false ? [] : [channel]
  );
  const fixChannel =
    notifyChannel !== false
      ? notifyChannel
      : tableChannels.length === 0 ||
          (installedChannel !== false && tableChannels.includes(installedChannel))
        ? installedChannel
        : tableChannels[0]!;
  const sqlWith = (prune: LilypadChangelogPruneOptions | false) =>
    lilypadChangelogSql({ changelogTable: fixChangelog.custom, notifyChannel: fixChannel, prune });

  // Reported after the other problems, which the caches need first. Without the pruning check,
  // the fixes keep the installed pruning; with it, they install the suggested one
  const pruning =
    changelog && !(options.changelog && options.changelog.checkPruning === false)
      ? evaluatePruning(
          facts,
          changelog,
          options.changelog === false ? undefined : options.changelog,
          sqlWith
        )
      : { problems: [], prune: installedPrune };
  // The SQL that installs the changelog, in every fix that needs it
  const changelogSql = sqlWith(pruning.prune);
  // Whether a changelog problem carries it: the fixes of the tables then leave it out
  let changelogFixed = false;
  if (changelog) {
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
      changelogFixed = true;
    }
    const comment = functionComment ?? '';
    const parsed = comment.startsWith(LILYPAD_CHANGELOG_VERSION_PREFIX)
      ? Number(comment.slice(LILYPAD_CHANGELOG_VERSION_PREFIX.length))
      : Number.NaN;
    // A comment of another origin, or edited by hand: the oldest version
    const version = Number.isInteger(parsed) ? parsed : 1;
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
      changelogFixed = true;
    }
  }

  const tables: LilypadSchemaCheckResult['tables'] = [];
  // The foreign keys to create, after every table (see LilypadShapeProblems)
  const deferred: LilypadSchemaProblem[] = [];
  options.tables.forEach((requirement, index) => {
    const { table, primaryKey, shape } = requirement;
    const needsChangelog = changelog !== undefined && requirement.changelog !== false;
    const tableChannel = requirement.notifyChannel ?? notifyChannel;
    // The changelog function notifies on one channel: the fixes cannot give the table another one
    const notifyFixable = tableChannel !== false && tableChannel === fixChannel;
    const triggerSql = lilypadChangelogTriggerSql({
      table,
      primaryKey,
      changelogTable: fixChangelog.custom,
    });
    const found = facts.tables[index];
    // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- a missing table has no facts
    if (!found || found.schema === null) {
      tables.push({ table, schema: null });
      // Its schema, the table, then the triggers it needs, with the changelog SQL when they notify
      // (the changelog check installs it otherwise)
      const createTable = shape && lilypadCreateTableSql(table, primaryKey, shape);
      const missingSchema = found?.missingSchema;
      const tableTriggers =
        needsChangelog || notifyFixable
          ? (notifyFixable && !changelogFixed ? changelogSql : '') + triggerSql
          : '';
      problems.push({
        code: 'missing-table',
        severity: 'error',
        table,
        message:
          missingSchema !== undefined
            ? `The table "${table}" does not exist, nor its schema "${missingSchema}".`
            : `The table "${table}" does not exist.`,
        ...(createTable !== undefined && {
          fix: (
            (missingSchema !== undefined
              ? `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(missingSchema)};\n`
              : '') + `${createTable}\n${tableTriggers}`
          ).trimEnd(),
        }),
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
      const fix = triggerSql;
      // The events may be split across several triggers (one statement trigger per event)
      const working = triggers.filter((trigger) => recordedEvents(trigger) !== 0);
      const recorded = working.reduce((events, trigger) => events | recordedEvents(trigger), 0);
      const recordedColumn = (trigger: LilypadTriggerInfo) => trigger.args[0];
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
      const fix = notifyFixable ? (changelogFixed ? '' : changelogSql) + triggerSql : undefined;
      // Without a fix: the changelog function notifies on the channel of other tables
      const ownTrigger = notifyFixable
        ? ''
        : ` The changelog trigger function notifies on one channel ("${String(fixChannel)}"): give "${table}" a notifying trigger of its own.`;
      if (notifiedEvents === 0) {
        problems.push({
          code: 'missing-notify-trigger',
          severity: 'error',
          table,
          message: `No trigger of "${table}" sends notifications on the "${tableChannel}" channel: the cache is not told about changes made elsewhere.${ownTrigger}`,
          fix,
        });
      } else if (notifiedEvents !== ROW_EVENTS) {
        problems.push({
          code: 'missing-notify-trigger',
          severity: 'error',
          table,
          message: `The triggers of "${table}" send notifications on the "${tableChannel}" channel only on ${eventNames(notifiedEvents)}: the cache is not told about ${eventNames(ROW_EVENTS & ~notifiedEvents)} made elsewhere.${ownTrigger}`,
          fix,
        });
      } else if (
        !triggers.some((trigger) => firesOnTruncate(trigger) && notifies.test(trigger.source))
      ) {
        problems.push({
          code: 'missing-truncate-trigger',
          severity: 'error',
          table,
          message: `No trigger of "${table}" sends a notification on the "${tableChannel}" channel for TRUNCATE: the caches would keep the removed rows.${ownTrigger}`,
          fix,
        });
      }
    }
  });

  problems.push(...deferred, ...pruning.problems);
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
