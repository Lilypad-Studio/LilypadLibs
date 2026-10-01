import type { LilypadDbGate } from '@/dbGate/LilypadDbGate';
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

/** The changelog version whose trigger function runs as its owner (`SECURITY DEFINER`). */
const CHANGELOG_OWNER_VERSION = 7;

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
      const unsafe = `its type, output function or a json cast function is not owned by a superuser, or it is a user-defined composite, range or multirange type, or an array or domain over one`;
      const safeTypes = `a built-in type (integer, bigint, uuid, text...), a type of a superuser-installed extension (e.g. citext), or a domain over one`;
      problems.push({
        code: 'unsupported-key-type',
        severity: 'error',
        table,
        message:
          installedVersion === undefined || installedVersion >= LILYPAD_CHANGELOG_VERSION
            ? `The primary key "${primaryKey}" of "${table}" has the type ${found.keyUserType}, which the changelog triggers cannot convert as their owner (${unsafe}), so the writes of the table fail${hasChangelogTriggers ? '' : ' once its changelog triggers are installed'}. Use ${safeTypes}.`
            : // An installed function of an older version converts it (as the writer before version
              // 7, as the owner since): the triggers of the current version would refuse it
              `The primary key "${primaryKey}" of "${table}" has the type ${found.keyUserType}, which the changelog triggers of version ${LILYPAD_CHANGELOG_VERSION} refuse to convert as their owner (${unsafe}): once version ${LILYPAD_CHANGELOG_VERSION} is installed, every write of the table fails.` +
              (hasChangelogTriggers && installedVersion >= CHANGELOG_OWNER_VERSION
                ? ` The installed triggers (version ${installedVersion}) convert it with the changelog owner's privileges, so a non-superuser may be able to run code as that owner.`
                : '') +
              ` Change the key to ${safeTypes} before installing version ${LILYPAD_CHANGELOG_VERSION} (lilypadChangelogSql, lilypadChangelogTriggerSql).`,
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

  problems.push(...deferred, ...pruning.problems);
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
