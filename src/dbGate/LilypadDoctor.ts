import { LilypadDbGate } from '@/dbGate/LilypadDbGate';
import {
  checkLilypadSchema,
  formatLilypadSchemaProblems,
  type LilypadChangelogPruning,
  type LilypadSchemaCheckResult,
} from '@/dbGate/LilypadSchemaCheck';

export type LilypadDoctorOptions = {
  /** The connection string of the database to check. */
  connectionString: string;
  /** The cached tables, as in their `LilypadDbSchema` (`tableName`, `primaryKey`). */
  tables: { table: string; primaryKey: string }[];
  /**
   * The changelog read by the caches (the `changelog` strategy), or `false` if none reads one.
   * Defaults to `{}`: the default changelog table.
   */
  changelog?:
    | {
        table?: string;
        /** How the old rows are deleted (see {@link LilypadChangelogPruning}). */
        pruning?: LilypadChangelogPruning;
        /** The largest `maxGap` and `lookback` of the caches, in ms. Defaults to 1 hour. */
        minRetention?: number;
      }
    | false;
  /** The channel the `listen` caches listen on (`cache_events`), or `false` (default) if none. */
  notifyChannel?: string | false;
};

export type LilypadDoctorReport = LilypadSchemaCheckResult & {
  /** The report, readable, with the SQL that fixes the problems. */
  text: string;
};

/**
 * Checks everything the caches need from the database, including how the changelog is pruned,
 * which the caches check at runtime only with `sync.checkPruning`. It connects with its own gate
 * (one connection), reads the catalogs only, and closes it. `npx lilypad-doctor` runs it from the
 * command line, e.g. in a deployment step.
 *
 * @throws If the database cannot be reached.
 */
export async function runLilypadDoctor(
  options: LilypadDoctorOptions
): Promise<LilypadDoctorReport> {
  const gate = await LilypadDbGate.create({
    connectionString: options.connectionString,
    pool: { max: 1 },
    listenHeartbeat: false,
  });
  try {
    const changelog = options.changelog ?? {};
    const result = await checkLilypadSchema(gate, {
      tables: options.tables,
      changelog: changelog === false ? false : { ...changelog, checkPruning: true },
      notifyChannel: options.notifyChannel ?? false,
    });
    const subject = 'lilypad-doctor';
    return {
      ...result,
      text:
        result.problems.length === 0
          ? `${subject}: the database is set up.`
          : formatLilypadSchemaProblems(subject, result.problems),
    };
  } finally {
    await gate.close();
  }
}
