import type {
  LilypadChangelogPruning,
  LilypadDbResolvedForeignKey,
  LilypadDbResolvedIndex,
  LilypadDbResolvedUniqueKey,
} from '@/dbConfig/LilypadDbConfig';
import type { LilypadDbCheck, LilypadDbColumn } from '@/dbConfig/LilypadDbSchema';

/**
 * The types shared by the modules of the schema check (`LilypadSchemaCheck.ts`, `...Facts.ts`,
 * `...Shape.ts`, `...Pruning.ts`): its options, its problems and its result.
 */

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
   * or one of your own: its function must call `pg_notify` with the channel name as a literal,
   * spelled exactly as the caches listen to it (case included).
   * Defaults to `false`: not checked.
   *
   * The changelog trigger function notifies on one channel, the same in every fix that installs it:
   * this one, or, with `false`, the channel the installed function notifies on (none if it sends
   * none) when no table needs another, else the `notifyChannel` of the first table that needs one.
   * A table that needs yet another channel gets no fix: it needs a notifying trigger of its own.
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
   * A warning: roles other than its owner may write the changelog, and record changes that every
   * cache trusts (e.g. make a row look deleted). Since version 7, the triggers write it as its
   * owner: the writing roles need no privilege on it.
   */
  | 'writable-changelog'
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
  /**
   * The database the `fix` must run in, when it is not the checked one (e.g. the one pg_cron runs
   * in): `lilypad-doctor --sql` leaves it out of the migration, as a comment.
   */
  fixDatabase?: string | undefined;
};

export type LilypadSchemaCheckResult = {
  /** Whether there is no error (there may be warnings). */
  ok: boolean;
  problems: LilypadSchemaProblem[];
  /** The schema each table resolves to (`null` if the table does not exist). */
  tables: { table: string; schema: string | null }[];
};

/**
 * The shape of a table, compared with the database by the schema check: its columns, keys,
 * indexes and checks. A table definition of a config (`db.tables.users`) is one.
 */
export type LilypadSchemaTableShape = {
  cols: Readonly<Record<string, LilypadDbColumn>>;
  generatedPrimaryKey?: boolean | undefined;
  unique: readonly LilypadDbResolvedUniqueKey[];
  foreignKeys: readonly LilypadDbResolvedForeignKey[];
  indexes: readonly LilypadDbResolvedIndex[];
  checks: readonly LilypadDbCheck[];
  /** Also reports what the database has and the shape lacks (as warnings). */
  strict: boolean;
};
