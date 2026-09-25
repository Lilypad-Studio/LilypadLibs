import type { LilypadDbGate } from '@/dbGate/LilypadDbGate';
import {
  LILYPAD_CHANGELOG_VERSION,
  LILYPAD_CHANGELOG_VERSION_PREFIX,
  LILYPAD_DEFAULT_CHANGELOG_TABLE,
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
  /** The table has no enabled changelog trigger firing on each INSERT, UPDATE and DELETE row. */
  | 'missing-changelog-trigger'
  /** The changelog trigger of the table records another column than the primary key. */
  | 'wrong-trigger-primary-key'
  /** No trigger of the table sends notifications on the channel. */
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
const CHANGELOG_TRIGGER_TYPE =
  TRIGGER_TYPE_ROW | TRIGGER_TYPE_INSERT | TRIGGER_TYPE_DELETE | TRIGGER_TYPE_UPDATE;

type TriggerInfo = {
  /** Whether it calls the changelog trigger function. */
  changelog: boolean | null;
  /** Its arguments, as `encode(tgargs, 'escape')`: each one ends with `\000`. */
  args: string;
  type: number;
  enabled: boolean;
  source: string;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  const sql = gate.sql;
  const changelogTable =
    options.changelog === false
      ? undefined
      : (options.changelog?.table ?? LILYPAD_DEFAULT_CHANGELOG_TABLE);
  const notifyChannel = options.notifyChannel ?? false;
  // The changelog table's name when it is not the default, for the generated SQL
  const customChangelogTable =
    changelogTable === LILYPAD_DEFAULT_CHANGELOG_TABLE ? undefined : changelogTable;
  const functionSignature = `${quoteIdentifier(
    triggerFunctionName(changelogTable ?? LILYPAD_DEFAULT_CHANGELOG_TABLE)
  )}()`;
  const problems: LilypadSchemaProblem[] = [];

  const [database] = await sql`
    SELECT
      current_setting('server_version_num')::int AS version,
      to_regclass(${quoteIdentifier(changelogTable ?? LILYPAD_DEFAULT_CHANGELOG_TABLE)}::text)
        IS NOT NULL AS has_changelog_table,
      EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = to_regclass(${quoteIdentifier(changelogTable ?? LILYPAD_DEFAULT_CHANGELOG_TABLE)}::text)
          AND attname = 'table_schema' AND NOT attisdropped
      ) AS has_schema_column,
      to_regprocedure(${functionSignature}::text) IS NOT NULL AS has_function,
      obj_description(to_regprocedure(${functionSignature}::text), 'pg_proc') AS function_comment
  `;

  if ((database.version as number) < 130000) {
    problems.push({
      code: 'unsupported-version',
      message: `PostgreSQL ${database.version} is too old: the changelog needs PostgreSQL 13 or later.`,
    });
  }

  if (changelogTable !== undefined) {
    const changelogSql = lilypadChangelogSql({ table: customChangelogTable });
    if (!database.has_changelog_table || !database.has_function) {
      problems.push({
        code: 'missing-changelog',
        message: !database.has_changelog_table
          ? `The changelog table "${changelogTable}" does not exist.`
          : `The changelog trigger function ${functionSignature} does not exist.`,
        fix: changelogSql,
      });
    }
    const comment = (database.function_comment as string | null) ?? '';
    const version = comment.startsWith(LILYPAD_CHANGELOG_VERSION_PREFIX)
      ? Number(comment.slice(LILYPAD_CHANGELOG_VERSION_PREFIX.length))
      : 1;
    if (
      (database.has_changelog_table && !database.has_schema_column) ||
      (database.has_function && version < LILYPAD_CHANGELOG_VERSION)
    ) {
      problems.push({
        code: 'outdated-changelog',
        message: `The changelog "${changelogTable}" was installed by an older version of the library (version ${version}, expected ${LILYPAD_CHANGELOG_VERSION}).`,
        fix: changelogSql,
      });
    }
  }

  const tables: LilypadSchemaCheckResult['tables'] = [];
  for (const { table, primaryKey } of options.tables) {
    const [found] = await sql`
      SELECT
        n.nspname AS schema_name,
        (
          SELECT coalesce(json_agg(json_build_object(
            'changelog', tr.tgfoid = to_regprocedure(${functionSignature}::text)::oid,
            'args', encode(tr.tgargs, 'escape'),
            'type', tr.tgtype,
            'enabled', tr.tgenabled <> 'D',
            'source', p.prosrc
          )), '[]'::json)
          FROM pg_trigger tr JOIN pg_proc p ON p.oid = tr.tgfoid
          WHERE tr.tgrelid = t.oid AND NOT tr.tgisinternal
        ) AS triggers
      FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE t.oid = to_regclass(${quoteIdentifier(table)}::text)
    `;
    if (!found) {
      tables.push({ table, schema: null });
      problems.push({
        code: 'missing-table',
        table,
        message: `The table "${table}" does not exist.`,
      });
      continue;
    }
    tables.push({ table, schema: found.schema_name as string });
    const triggers = (
      typeof found.triggers === 'string' ? JSON.parse(found.triggers) : found.triggers
    ) as TriggerInfo[];

    if (changelogTable !== undefined) {
      const fix = lilypadChangelogTriggerSql({
        table,
        primaryKey,
        changelogTable: customChangelogTable,
      });
      const working = triggers.filter(
        (trigger) =>
          trigger.changelog &&
          trigger.enabled &&
          (trigger.type & CHANGELOG_TRIGGER_TYPE) === CHANGELOG_TRIGGER_TYPE
      );
      if (working.length === 0) {
        problems.push({
          code: 'missing-changelog-trigger',
          table,
          message: triggers.some((trigger) => trigger.changelog)
            ? `The changelog trigger of "${table}" is disabled or does not fire on each INSERT, UPDATE and DELETE row.`
            : `The table "${table}" has no changelog trigger: its changes are not recorded.`,
          fix,
        });
      } else if (!working.some((trigger) => trigger.args.split('\\000')[0] === primaryKey)) {
        problems.push({
          code: 'wrong-trigger-primary-key',
          table,
          message: `The changelog trigger of "${table}" records the column "${working[0].args.split('\\000')[0]}", not the primary key "${primaryKey}".`,
          fix,
        });
      }
    }

    if (notifyChannel !== false) {
      const notifies = new RegExp(
        `pg_notify\\s*\\(\\s*'${escapeRegExp(notifyChannel.replace(/'/g, "''"))}'`,
        'i'
      );
      const notifying = triggers.some(
        (trigger) =>
          trigger.enabled &&
          (trigger.type & TRIGGER_TYPE_ROW) !== 0 &&
          notifies.test(trigger.source)
      );
      if (!notifying) {
        problems.push({
          code: 'missing-notify-trigger',
          table,
          message: `No trigger of "${table}" sends notifications on the "${notifyChannel}" channel: the cache is not told about changes made elsewhere.`,
          fix:
            lilypadChangelogSql({ table: customChangelogTable, notifyChannel }) +
            lilypadChangelogTriggerSql({ table, primaryKey, changelogTable: customChangelogTable }),
        });
      }
    }
  }

  return { ok: problems.length === 0, problems, tables };
}
