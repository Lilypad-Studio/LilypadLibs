import type { LilypadDbConfig } from '@/dbConfig/LilypadDbConfig';
import { LILYPAD_DEFAULT_MAX_GAP } from '@/dbConfig/LilypadDbConfigDefaults';
import { LilypadDbGate } from '@/dbGate/LilypadDbGate';
import {
  checkLilypadSchema,
  formatLilypadSchemaProblems,
  LilypadSchemaCheckError,
} from '@/dbGate/LilypadSchemaCheck';
import type {
  LilypadSchemaCheckOptions,
  LilypadSchemaCheckResult,
} from '@/dbGate/LilypadSchemaTypes';

export type LilypadDoctorOptions = {
  /** The connection string of the database to check. */
  connectionString: string;
  /** The config the database must match (see `defineLilypadDb`, `loadLilypadDbConfig`). */
  config: LilypadDbConfig;
};

export type LilypadDoctorReport = LilypadSchemaCheckResult & {
  /** The name of the config checked. */
  config: string;
  /** The report, readable, with the SQL that fixes the problems. */
  text: string;
  /** @throws {LilypadSchemaCheckError} If the check found errors. */
  assertOk: () => void;
};

/**
 * What the schema check must verify for a config: each table with its shape (columns, keys,
 * indexes, checks), the changelog triggers of the `changelog` tables, the notifying triggers of the
 * `listen` tables, and the changelog and its pruning when a table reads it. The retention the
 * pruning must keep is the largest of `changelog.minRetention` and the `maxGap` and `lookback` of
 * the `changelog` tables.
 */
export function lilypadSchemaCheckOptions(config: LilypadDbConfig): LilypadSchemaCheckOptions {
  const definitions = Object.values(config.tables);
  const changelogSyncs = definitions.flatMap((definition) =>
    definition.sync.strategy === 'changelog' ? [definition.sync] : []
  );
  const minRetention = Math.max(
    config.changelog.minRetention,
    ...changelogSyncs.map((sync) =>
      Math.max(sync.maxGap ?? LILYPAD_DEFAULT_MAX_GAP, sync.lookback ?? 0)
    )
  );
  return {
    tables: definitions.map((definition) => ({
      table: definition.qualifiedName,
      primaryKey: String(definition.primaryKey),
      changelog: definition.sync.strategy === 'changelog',
      notifyChannel: definition.sync.strategy === 'listen' ? config.notifyChannel : false,
      shape: definition,
    })),
    changelog:
      changelogSyncs.length === 0
        ? false
        : {
            table: config.changelog.table,
            pruning: config.changelog.pruning,
            minRetention,
            checkPruning: true,
          },
    // When no table reads the changelog, the fixes of the listen tables install the config's
    changelogTable: config.changelog.table,
    notifyChannel: false,
  };
}

/**
 * Checks the database against a config: every table (its columns, keys, indexes and checks), the
 * triggers each sync strategy needs, the changelog and how it is pruned. It connects with its own
 * gate (one connection), reads the catalogs only, and closes it. `npx lilypad-doctor` runs it from
 * the command line, e.g. in a deployment step.
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
    const result = await checkLilypadSchema(gate, lilypadSchemaCheckOptions(options.config));
    const subject = `lilypad-doctor (config "${options.config.name}")`;
    return {
      ...result,
      config: options.config.name,
      text:
        result.problems.length === 0
          ? `${subject}: the database is set up.`
          : formatLilypadSchemaProblems(subject, result.problems),
      assertOk: () => {
        if (!result.ok) {
          throw new LilypadSchemaCheckError(subject, result.problems);
        }
      },
    };
  } finally {
    await gate.close();
  }
}
