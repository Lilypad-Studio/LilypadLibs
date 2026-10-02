import { LILYPAD_DEFAULT_MAX_STATEMENT_TIMEOUT } from '@/dbConfig/LilypadDbConfigDefaults';
import type { LilypadDbGate } from '@/dbGate/LilypadDbGate';
import { assertNumberOption } from '@/internal/LilypadValidation';
import {
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
import { evaluatePruning, formatDuration } from '@/dbGate/LilypadSchemaPruning';
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

/** The changelog version whose trigger function runs as its owner (`SECURITY DEFINER`). */
const CHANGELOG_OWNER_VERSION = 7;
/**
 * The changelog version whose trigger function refuses a missing key column or a key of an unsafe
 * type (`lilypadSafeKeyTypeSql`): from it on, the writes of such a table fail already.
 */
const CHANGELOG_KEY_GUARD_VERSION = 9;

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
 * A call of `pg_notify` up to its first argument: the name in any case (PostgreSQL folds the
 * unquoted names), but not the channel that follows, which `LISTEN` matches exactly.
 */
const NOTIFY_CALL = String.raw`[Pp][Gg]_[Nn][Oo][Tt][Ii][Ff][Yy]\s*\(\s*`;

/**
 * The channel on which an installed changelog function sends notifications (its first
 * `pg_notify`, in the `TRUNCATE` branch, where the literal is not escaped for `format()`), or
 * `false` if it sends none.
 */
function installedNotifyChannel(source: string | null): string | false {
  const match = source ? new RegExp(`${NOTIFY_CALL}'((?:[^']|'')*)'`).exec(source) : null;
  return match?.[1] !== undefined ? match[1].replace(/''/g, "'") : false;
}

/**
 * Checks that the database has what `LilypadDbCache` needs to learn about changes: the changelog
 * table, its trigger function and a trigger on each cached table, or a trigger that sends
 * notifications; and the `statement_timeout` of the role it connects as (see
 * `maxStatementTimeout`). It only reads the catalogs: it changes nothing.
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
  // The version of the installed trigger function, or `undefined` if it does not exist
  const installedVersion = installedChangelogVersion(facts.changelog);
  // Installed by a newer version of the library: the fixes of this one would install its older SQL
  // over it, under the services of the newer version that share the database. Also without the
  // changelog strategy: the notify fixes install the changelog SQL too
  const newerInstall =
    installedVersion !== undefined && installedVersion > LILYPAD_CHANGELOG_VERSION;
  const problems: LilypadSchemaProblem[] = [];

  if (facts.version < 160000) {
    problems.push({
      code: 'unsupported-version',
      severity: 'error',
      message: `PostgreSQL ${facts.version} is too old: the library needs PostgreSQL 16 or later.`,
    });
  }
  if (newerInstall) {
    problems.push({
      code: 'newer-changelog',
      severity: 'warning',
      message: `The changelog "${fixChangelog.table}" was installed by a newer version of the library (version ${installedVersion}, this one knows ${LILYPAD_CHANGELOG_VERSION}): upgrade @lilypad-studio/libs.`,
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
  // `force`: the fix keeps an installed retention, even below one hour (the pruning check reports it)
  const sqlWith = (prune: LilypadChangelogPruneOptions | false) =>
    lilypadChangelogSql({
      changelogTable: fixChangelog.custom,
      notifyChannel: fixChannel,
      prune: prune && { ...prune, force: true },
    });
  // The problems whose fix touches the changelog, its triggers or its privileges, with the part of
  // the fix that does not (if any): while a table blocks them (see `blockedTables`), they are
  // withheld
  const changelogFixes = new Map<LilypadSchemaProblem, string | undefined>();
  const touchesChangelog = (problem: LilypadSchemaProblem, kept?: string): LilypadSchemaProblem => {
    if (problem.fix !== undefined) {
      changelogFixes.set(problem, kept);
    }
    return problem;
  };
  // The tables whose key the changelog triggers would refuse (an unsafe type, or a missing column)
  const blockedTables: string[] = [];

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
  for (const problem of pruning.problems) {
    // Not the one-off DELETE of `unpruned-changelog`: the other fixes install the changelog SQL or
    // schedule a job against the changelog
    if (problem.code !== 'unpruned-changelog') {
      touchesChangelog(problem);
    }
  }
  // The SQL that installs the changelog, in every fix that needs it
  const changelogSql = sqlWith(pruning.prune);
  // Whether a changelog problem carries it: the fixes of the tables then leave it out
  let changelogFixed = false;
  if (changelog) {
    const { hasTable, hasSchemaColumn, hasFunction } = facts.changelog;
    if (!hasTable || !hasFunction) {
      problems.push(
        touchesChangelog({
          code: 'missing-changelog',
          severity: 'error',
          message: !hasTable
            ? `The changelog table "${changelog.table}" does not exist.`
            : `The changelog trigger function ${changelog.functionSignature} does not exist.`,
          fix: changelogSql,
        })
      );
      changelogFixed = true;
    }
    // A comment of another origin, or edited by hand: the oldest version
    const version = installedVersion ?? 1;
    if ((hasTable && !hasSchemaColumn) || (hasFunction && version < LILYPAD_CHANGELOG_VERSION)) {
      problems.push(
        touchesChangelog({
          code: 'outdated-changelog',
          severity: 'error',
          message:
            version < LILYPAD_CHANGELOG_VERSION
              ? `The changelog "${changelog.table}" was installed by an older version of the library (version ${version}, expected ${LILYPAD_CHANGELOG_VERSION}).`
              : // Dropped by hand: the reader filters on it
                `The changelog table "${changelog.table}" has no table_schema column: the caches cannot read it.`,
          fix: changelogSql,
        })
      );
      changelogFixed = true;
    }
    if (hasTable && facts.changelog.writers !== null) {
      problems.push(
        touchesChangelog({
          code: 'writable-changelog',
          severity: 'warning',
          message: `Roles other than its owner may write the changelog "${changelog.table}" (${facts.changelog.writers}): they can record changes that every cache trusts, such as a row deleted. The triggers of version ${LILYPAD_CHANGELOG_VERSION} write it as its owner, so the writing roles need no privilege on it.`,
          // After the changelog SQL, when a fix installs it: the triggers of older versions need it
          fix: `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ${quoteIdentifier(changelog.table)} FROM ${facts.changelog.writers};\n`,
        })
      );
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
      const createFix =
        createTable &&
        (missingSchema !== undefined
          ? `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(missingSchema)};\n`
          : '') + createTable;
      const missingTable: LilypadSchemaProblem = {
        code: 'missing-table',
        severity: 'error',
        table,
        message:
          missingSchema !== undefined
            ? `The table "${table}" does not exist, nor its schema "${missingSchema}".`
            : `The table "${table}" does not exist.`,
        ...(createFix !== undefined && { fix: `${createFix}\n${tableTriggers}`.trimEnd() }),
      };
      // Without its triggers, the table can still be created
      problems.push(tableTriggers ? touchesChangelog(missingTable, createFix) : missingTable);
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

    // The notifications, first: a fix that installs the changelog triggers makes the key go through
    // them (see below). Reported after the changelog triggers
    let notifyProblem: LilypadSchemaProblem | undefined;
    if (tableChannel !== false) {
      const notifies = new RegExp(
        `${NOTIFY_CALL}'${escapeRegExp(tableChannel.replace(/'/g, "''"))}'`
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
        notifyProblem = {
          code: 'missing-notify-trigger',
          severity: 'error',
          table,
          message: `No trigger of "${table}" sends notifications on the "${tableChannel}" channel: the cache is not told about changes made elsewhere.${ownTrigger}`,
          fix,
        };
      } else if (notifiedEvents !== ROW_EVENTS) {
        notifyProblem = {
          code: 'missing-notify-trigger',
          severity: 'error',
          table,
          message: `The triggers of "${table}" send notifications on the "${tableChannel}" channel only on ${eventNames(notifiedEvents)}: the cache is not told about ${eventNames(ROW_EVENTS & ~notifiedEvents)} made elsewhere.${ownTrigger}`,
          fix,
        };
      } else if (
        !triggers.some((trigger) => firesOnTruncate(trigger) && notifies.test(trigger.source))
      ) {
        notifyProblem = {
          code: 'missing-truncate-trigger',
          severity: 'error',
          table,
          message: `No trigger of "${table}" sends a notification on the "${tableChannel}" channel for TRUNCATE: the caches would keep the removed rows.${ownTrigger}`,
          fix,
        };
      }
    }

    // The changelog triggers evaluate the key column as their owner, and refuse a missing one or a
    // type not proven safe, which fails the write: on a changelog table, and on a listen table that
    // the changelog triggers notify, or that the fix of its notifications gives them
    const hasChangelogTriggers = triggers.some((trigger) => recordedEvents(trigger) !== 0);
    const recordsKey =
      needsChangelog || hasChangelogTriggers || (notifyFixable && notifyProblem !== undefined);
    if (recordsKey && (typeof found.keyUserType === 'string' || found.keyColumnMissing === true)) {
      blockedTables.push(table);
    }

    // A missing key column (renamed or dropped): the changelog trigger has nothing to record. The
    // shape check reports it only when the shape describes the key column, so report it here unless
    // it does (a shape that omits the key column would otherwise hide it).
    if (recordsKey && found.keyColumnMissing && !(shape && Object.hasOwn(shape.cols, primaryKey))) {
      problems.push({
        code: 'missing-column',
        severity: 'error',
        table,
        message: `The primary key column "${primaryKey}" of "${table}" does not exist (renamed or dropped?): the changelog trigger cannot record it.`,
      });
    }

    if (recordsKey && typeof found.keyUserType === 'string') {
      problems.push({
        code: 'unsupported-key-type',
        severity: 'error',
        table,
        message: unsupportedKeyMessage(
          `The primary key "${primaryKey}" of "${table}"`,
          found.keyUserType,
          hasChangelogTriggers,
          installedVersion
        ),
      });
    }

    if (needsChangelog) {
      const fix = triggerSql;
      // The events may be split across several triggers (one statement trigger per event)
      const working = triggers.filter((trigger) => recordedEvents(trigger) !== 0);
      const recorded = working.reduce((events, trigger) => events | recordedEvents(trigger), 0);
      const recordedColumn = (trigger: LilypadTriggerInfo) => trigger.args[0];
      const wrongColumn = working.find((trigger) => recordedColumn(trigger) !== primaryKey);
      if (recorded !== ROW_EVENTS) {
        problems.push(
          touchesChangelog({
            code: 'missing-changelog-trigger',
            severity: 'error',
            table,
            message: triggers.some((trigger) => trigger.changelog)
              ? `The changelog triggers of "${table}" do not record ${eventNames(ROW_EVENTS & ~recorded)}: they are missing, disabled, lack their transition tables, or are the row trigger of an older version.`
              : `The table "${table}" has no changelog trigger: its changes are not recorded.`,
            fix,
          })
        );
      } else if (wrongColumn) {
        problems.push(
          touchesChangelog({
            code: 'wrong-trigger-primary-key',
            severity: 'error',
            table,
            message: `The changelog trigger of "${table}" records the column "${recordedColumn(wrongColumn)}", not the primary key "${primaryKey}".`,
            fix,
          })
        );
      } else if (!triggers.some((trigger) => trigger.changelog && firesOnTruncate(trigger))) {
        problems.push(
          touchesChangelog({
            code: 'missing-truncate-trigger',
            severity: 'error',
            table,
            message: `The changelog does not record TRUNCATE of "${table}": the caches would keep the removed rows.`,
            fix,
          })
        );
      }
    }

    if (notifyProblem) {
      problems.push(touchesChangelog(notifyProblem));
    }
  });

  // The tables outside the options whose changelog triggers read a key the trigger function refuses
  // (another config or service sharing the changelog, or a table removed from the config): the
  // fixes that install the current version would fail every write of them too
  for (const { table, column, type } of facts.changelog.blockedTables) {
    const outside = `"${table}" (not in this config, but its changelog triggers record into this changelog)`;
    if (!blockedTables.includes(table)) {
      blockedTables.push(table);
    }
    problems.push({
      code: type === null ? 'missing-column' : 'unsupported-key-type',
      severity: 'error',
      table,
      message:
        type !== null
          ? unsupportedKeyMessage(
              `The key column "${column ?? ''}" of ${outside}`,
              type,
              true,
              installedVersion
            )
          : `${column === null ? `The changelog triggers of ${outside} name no key column` : `The key column "${column}" that the changelog triggers of ${outside} record does not exist (renamed or dropped?)`}: the changelog triggers cannot record it, and every write of the table fails${installedVersion !== undefined && installedVersion < CHANGELOG_KEY_GUARD_VERSION ? ` once version ${LILYPAD_CHANGELOG_VERSION} is installed` : ''}. Reinstall its triggers with its primary key (lilypadChangelogTriggerSql), or drop them.`,
    });
  }

  problems.push(...deferred, ...pruning.problems, ...evaluateStatementTimeout(facts, options));
  // Every fix of the changelog, its triggers and its privileges is withheld while a table blocks
  // them (any of them could make the triggers refuse its key, and fail its writes), or while a newer
  // version installed the changelog (they would install the older SQL of this one)
  const withholdReasons: string[] = [];
  if (blockedTables.length > 0) {
    const blockedBy = blockedTables.map((table) => `"${table}"`).join(', ');
    withholdReasons.push(
      `the primary key of ${blockedBy} is changed (see unsupported-key-type / missing-column)`
    );
  }
  if (newerInstall) {
    withholdReasons.push('the library is upgraded (see newer-changelog)');
  }
  if (withholdReasons.length === 0) {
    return { ok: !problems.some((problem) => problem.severity === 'error'), problems, tables };
  }
  const until = withholdReasons.join(' and ');
  const withheld = problems.map((problem): LilypadSchemaProblem => {
    if (!changelogFixes.has(problem)) {
      return problem;
    }
    const kept = changelogFixes.get(problem);
    const { fix: _fix, fixDatabase: _fixDatabase, ...rest } = problem;
    return {
      ...rest,
      message: `${problem.message} ${kept === undefined ? 'Its fix is' : 'The changelog triggers of its fix are'} withheld until ${until}; run the check again then.`,
      ...(kept !== undefined && { fix: kept }),
    };
  });
  return {
    ok: !withheld.some((problem) => problem.severity === 'error'),
    problems: withheld,
    tables,
  };
}

/** Where a setting comes from, for a message (`pg_settings.source`). */
const SETTING_SOURCES: Record<string, string> = {
  default: 'the default of PostgreSQL',
  'configuration file': 'the configuration of the server',
  database: 'the database',
  user: 'the role',
  'database user': 'the role in this database',
  client: 'the connection',
};

/**
 * `long-statement-timeout`: the `statement_timeout` of the session of the check is off, or longer
 * than `maxStatementTimeout`. No fix: the role of the check may not be the role of the application
 * (e.g. a migration role, whose long statements a timeout would cancel).
 */
function evaluateStatementTimeout(
  facts: LilypadSchemaFacts,
  options: LilypadSchemaCheckOptions
): LilypadSchemaProblem[] {
  const max = options.maxStatementTimeout ?? LILYPAD_DEFAULT_MAX_STATEMENT_TIMEOUT;
  if (max === false) {
    return [];
  }
  assertNumberOption('checkLilypadSchema', 'maxStatementTimeout', max, 'positive-delay');
  const { role, statementTimeout, statementTimeoutSource: source } = facts.session;
  if (statementTimeout === null || (statementTimeout > 0 && statementTimeout <= max)) {
    return [];
  }
  const from = source === null ? '' : `, from ${SETTING_SOURCES[source] ?? `the ${source}`}`;
  const found =
    statementTimeout === 0
      ? `has no statement_timeout (0${from})`
      : `has a statement_timeout of ${formatDuration(statementTimeout)} (${statementTimeout} ms${from}), longer than ${formatDuration(max)} (maxStatementTimeout)`;
  // Within maxStatementTimeout, or the suggested setting would be reported too
  const suggested = Math.min(30_000, max);
  const setting = suggested % 1000 === 0 ? `${suggested / 1000}s` : `${suggested}ms`;
  return [
    {
      code: 'long-statement-timeout',
      severity: 'warning',
      message:
        `The role "${role}" that the check connects as ${found}: a query stuck on a lock or a dead connection holds its connection of the pool, and its caller, for as long as it lasts (the gate sets no timeout by default, and the caches stop waiting, not their queries).` +
        ` If the application connects as this role, bound its queries: ALTER ROLE ${quoteIdentifier(role)} SET statement_timeout = '${setting}'; (behind a pooler, the role the pooler connects as).` +
        ' If it connects as another role (check that one), or bounds its queries with the statementTimeout of its gate, set maxStatementTimeout: false in the config (or in the options of checkLilypadSchema).',
    },
  ];
}

/**
 * The message of `unsupported-key-type`.
 *
 * @param key - The key and its table, e.g. `The primary key "id" of "users"`.
 * @param hasChangelogTriggers - Whether the table has the changelog triggers already.
 * @param installedVersion - The version of the installed trigger function (`undefined`: none).
 */
function unsupportedKeyMessage(
  key: string,
  type: string,
  hasChangelogTriggers: boolean,
  installedVersion: number | undefined
): string {
  const unsafe = `its type, output function or a json cast function is not owned by a superuser, or it is a user-defined composite, range or multirange type, or an array or domain over one`;
  const safeTypes = `a built-in type (integer, bigint, uuid, text...), a type of a superuser-installed extension (e.g. citext), or a domain over one`;
  return installedVersion === undefined || installedVersion >= CHANGELOG_KEY_GUARD_VERSION
    ? `${key} has the type ${type}, which the changelog triggers cannot convert as their owner (${unsafe}), so the writes of the table fail${hasChangelogTriggers ? '' : ' once its changelog triggers are installed'}. Use ${safeTypes}.`
    : // An installed function of an older version converts it (as the writer before version 7, as
      // the owner since): the triggers of the current version would refuse it
      `${key} has the type ${type}, which the changelog triggers of version ${LILYPAD_CHANGELOG_VERSION} refuse to convert as their owner (${unsafe}): once version ${LILYPAD_CHANGELOG_VERSION} is installed, every write of the table fails.` +
        (hasChangelogTriggers && installedVersion >= CHANGELOG_OWNER_VERSION
          ? ` The installed triggers (version ${installedVersion}) convert it with the changelog owner's privileges, so a non-superuser may be able to run code as that owner.`
          : '') +
        ` Change the key to ${safeTypes} before installing version ${LILYPAD_CHANGELOG_VERSION} (lilypadChangelogSql, lilypadChangelogTriggerSql).`;
}

/**
 * The version of the installed trigger function, from its comment (`undefined` if it does not
 * exist). A function without a valid version comment (another origin, or edited by hand) is the
 * oldest version.
 */
function installedChangelogVersion(changelog: LilypadSchemaFacts['changelog']): number | undefined {
  if (!changelog.hasFunction) {
    return undefined;
  }
  const comment = changelog.functionComment ?? '';
  const parsed = comment.startsWith(LILYPAD_CHANGELOG_VERSION_PREFIX)
    ? Number(comment.slice(LILYPAD_CHANGELOG_VERSION_PREFIX.length))
    : Number.NaN;
  return Number.isInteger(parsed) ? parsed : 1;
}
