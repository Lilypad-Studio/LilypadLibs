import type { LilypadDbGate } from '@/dbGate/LilypadDbGate';
import {
  LILYPAD_CHANGELOG_NEW_ROWS,
  LILYPAD_CHANGELOG_OLD_ROWS,
  LILYPAD_CHANGELOG_VERSION,
  LILYPAD_CHANGELOG_VERSION_PREFIX,
  LILYPAD_DEFAULT_CHANGELOG_TABLE,
  installedLilypadChangelogPrune,
  lilypadChangelogSql,
  lilypadChangelogTriggerSql,
  quoteIdentifier,
  triggerFunctionName,
} from '@/dbGate/LilypadChangelog';

export type LilypadSchemaCheckOptions = {
  /** The cached tables, as in their `LilypadDbSchema` (`tableName`, `primaryKey`). */
  tables: { table: string; primaryKey: string }[];
  /**
   * Checks the changelog table, its trigger function, and that each table has the changelog
   * trigger (the `changelog` strategy). `false` skips these checks. Defaults to `{}`: the default
   * changelog table.
   */
  changelog?: { table?: string } | false;
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
  | 'missing-notify-trigger';

export type LilypadSchemaProblem = {
  code: LilypadSchemaProblemCode;
  /** The cached table concerned, for the per-table problems. */
  table?: string;
  message: string;
  /** SQL that fixes the problem, to run in a migration. */
  fix?: string;
};

export type LilypadSchemaCheckResult = {
  ok: boolean;
  problems: LilypadSchemaProblem[];
  /** The schema each table resolves to (`null` if the table does not exist). */
  tables: { table: string; schema: string | null }[];
};

/** Thrown by `LilypadDbCache.create` with `verify: 'throw'` when the database is not set up. */
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
  const lines = [`${subject}: the database is not set up.`];
  for (const problem of problems) {
    lines.push(`- ${problem.message}`);
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

/** What `checkLilypadSchema` reads from the catalogs, before it evaluates it. */
export type LilypadSchemaFacts = {
  /** `server_version_num`, e.g. `160002`. */
  version: number;
  changelog: {
    hasTable: boolean;
    hasSchemaColumn: boolean;
    hasFunction: boolean;
    functionComment: string | null;
    /** The source of the trigger function (`null` if it does not exist). */
    functionSource: string | null;
  };
  /** For each table of the options, in order: `schema` is `null` if the table does not exist. */
  tables: { schema: string | null; triggers: LilypadTriggerInfo[] }[];
};

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

  const [database] = await sql`
    SELECT
      current_setting('server_version_num')::int AS version,
      to_regclass(${quotedChangelog}::text) IS NOT NULL AS has_changelog_table,
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
            triggers: (typeof found.triggers === 'string'
              ? JSON.parse(found.triggers)
              : found.triggers) as LilypadTriggerInfo[],
          }
        : { schema: null, triggers: [] }
    );
  }

  return {
    version: database.version as number,
    changelog: {
      hasTable: database.has_changelog_table as boolean,
      hasSchemaColumn: database.has_schema_column as boolean,
      hasFunction: database.has_function as boolean,
      functionComment: database.function_comment as string | null,
      functionSource: database.function_source as string | null,
    },
    tables,
  };
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
  // The SQL that fixes the changelog keeps the pruning of the installed trigger function
  const prune = installedLilypadChangelogPrune(facts.changelog.functionSource);
  const problems: LilypadSchemaProblem[] = [];

  if (facts.version < 130000) {
    problems.push({
      code: 'unsupported-version',
      message: `PostgreSQL ${facts.version} is too old: the changelog needs PostgreSQL 13 or later.`,
    });
  }

  if (changelog) {
    // The fix notifies on the channel the check requires, or else on the one the installed function
    // notifies on: a changelog installed with `notifyChannel: false` must not start notifying, nor
    // one shared with `listen` caches stop
    const changelogSql = lilypadChangelogSql({
      table: changelog.custom,
      notifyChannel:
        notifyChannel !== false
          ? notifyChannel
          : installedNotifyChannel(facts.changelog.functionSource),
      prune,
    });
    const { hasTable, hasSchemaColumn, hasFunction, functionComment } = facts.changelog;
    if (!hasTable || !hasFunction) {
      problems.push({
        code: 'missing-changelog',
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
          table,
          message: triggers.some((trigger) => trigger.changelog)
            ? `The changelog triggers of "${table}" do not record ${eventNames(ROW_EVENTS & ~recorded)}: they are missing, disabled, or lack their transition tables.`
            : `The table "${table}" has no changelog trigger: its changes are not recorded.`,
          fix,
        });
      } else if (wrongColumn) {
        problems.push({
          code: 'wrong-trigger-primary-key',
          table,
          message: `The changelog trigger of "${table}" records the column "${recordedColumn(wrongColumn)}", not the primary key "${primaryKey}".`,
          fix,
        });
      } else if (!triggers.some((trigger) => trigger.changelog && firesOnTruncate(trigger))) {
        problems.push({
          code: 'missing-truncate-trigger',
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
        lilypadChangelogSql({ table: changelog?.custom, notifyChannel, prune }) +
        lilypadChangelogTriggerSql({ table, primaryKey, changelogTable: changelog?.custom });
      if (notifiedEvents === 0) {
        problems.push({
          code: 'missing-notify-trigger',
          table,
          message: `No trigger of "${table}" sends notifications on the "${notifyChannel}" channel: the cache is not told about changes made elsewhere.`,
          fix,
        });
      } else if (notifiedEvents !== ROW_EVENTS) {
        problems.push({
          code: 'missing-notify-trigger',
          table,
          message: `The triggers of "${table}" send notifications on the "${notifyChannel}" channel only on ${eventNames(notifiedEvents)}: the cache is not told about ${eventNames(ROW_EVENTS & ~notifiedEvents)} made elsewhere.`,
          fix,
        });
      } else if (
        !triggers.some((trigger) => firesOnTruncate(trigger) && notifies.test(trigger.source))
      ) {
        problems.push({
          code: 'missing-truncate-trigger',
          table,
          message: `No trigger of "${table}" sends a notification on the "${notifyChannel}" channel for TRUNCATE: the caches would keep the removed rows.`,
          fix,
        });
      }
    }
  });

  return { ok: problems.length === 0, problems, tables };
}
