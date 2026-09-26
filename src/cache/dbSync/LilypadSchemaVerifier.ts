import type { LilypadDbCacheSchemaVerification } from '@/cache/dbSync/LilypadDbSyncTypes';
import { LILYPAD_DEFAULT_NOTIFY_CHANNEL } from '@/dbGate/LilypadChangelog';
import type { LilypadDbGate } from '@/dbGate/LilypadDbGate';
import {
  checkLilypadSchema,
  formatLilypadSchemaProblems,
  LilypadSchemaCheckError,
  type LilypadChangelogPruning,
} from '@/dbGate/LilypadSchemaCheck';
import { LilypadBackoff } from '@/internal/LilypadBackoff';
import type { LilypadLibLogLevel } from '@/logger/LilypadLibLogger';
import { runInBackground, type LilypadPlatform } from '@/platform/LilypadPlatform';

export type LilypadSchemaVerifierOptions = {
  gate: LilypadDbGate;
  tableName: string;
  primaryKey: string;
  strategy: 'listen' | 'changelog' | 'none';
  /** The changelog table, with the `changelog` strategy. */
  changelogTable?: string;
  /** How the changelog is pruned, with the `changelog` strategy. */
  pruning?: LilypadChangelogPruning;
  /** The shortest retention of the changelog the cache accepts: its `maxGap` and `lookback`. */
  minRetention?: number;
  mode: LilypadDbCacheSchemaVerification;
  platform?: LilypadPlatform;
  log: (level: LilypadLibLogLevel, ...message: unknown[]) => void;
  /** Whether the logger has a `warn` method; otherwise problems go to `console.warn`. */
  canWarn: () => boolean;
  /** Receives the schema the table resolves to. */
  onSchema: (schema: string) => void;
};

/**
 * Checks once that the database has the triggers a sync strategy needs, and resolves the schema of
 * the table. With `warn` it never rejects: problems and failures are logged. With `throw` it rejects
 * if the check found errors; warnings (e.g. a changelog that nothing prunes) are logged. A check that could not
 * run (e.g. the database was unreachable) is forgotten, so that a later read runs it again after a
 * backoff; a check that found problems is not repeated.
 */
export class LilypadSchemaVerifier {
  private check?: Promise<void>;
  private readonly backoff = new LilypadBackoff(() => 1000);

  constructor(private readonly options: LilypadSchemaVerifierOptions) {}

  get mode(): LilypadDbCacheSchemaVerification {
    return this.options.strategy === 'none' ? 'off' : this.options.mode;
  }

  /** @throws A `LilypadSchemaCheckError` with `throw`, or the error of the check. */
  verify(): Promise<void> {
    const mode = this.mode;
    if (mode === 'off') {
      return Promise.resolve();
    }
    if (!this.check) {
      // Reset in a callback, not in run: the check must be registered before it can be forgotten
      const check: Promise<void> = this.run(mode).then((ran) => {
        if (!ran && this.check === check) {
          this.check = undefined;
        }
      });
      this.check = check;
    }
    return this.check;
  }

  /**
   * Runs the check in the background, unless it has already run, is running, or failed less than
   * a backoff ago. Reads call it to retry a check that could not run.
   */
  checkInBackground(now: number = Date.now()): void {
    if (this.check || !this.backoff.ready(now) || this.mode === 'off') {
      return;
    }
    // Only diagnostics: reads do not wait for it
    runInBackground(this.options.platform, this.verify(), () => {});
  }

  /** @returns `false` if the check could not run (with `warn`; `throw` rejects). */
  private async run(mode: 'warn' | 'throw'): Promise<boolean> {
    const { gate, tableName, primaryKey, strategy, changelogTable, pruning, minRetention, log } =
      this.options;
    const subject = `LilypadDbCache "${tableName}" (sync: ${strategy})`;
    try {
      const result = await checkLilypadSchema(gate, {
        tables: [{ table: tableName, primaryKey }],
        changelog:
          strategy === 'changelog' ? { table: changelogTable, pruning, minRetention } : false,
        notifyChannel: strategy === 'listen' ? LILYPAD_DEFAULT_NOTIFY_CHANNEL : false,
      });
      const schema = result.tables[0]?.schema;
      if (schema) {
        this.options.onSchema(schema);
      }
      this.backoff.succeed();
      if (result.problems.length === 0) {
        return true;
      }
      if (mode === 'throw' && !result.ok) {
        throw new LilypadSchemaCheckError(subject, result.problems);
      }
      const message = formatLilypadSchemaProblems(subject, result.problems);
      if (this.options.canWarn()) {
        log('warn', message);
      } else {
        // A missing trigger would otherwise go unnoticed: the cache just stays stale
        console.warn(message);
      }
      return true;
    } catch (error) {
      if (mode === 'throw') {
        throw error;
      }
      this.backoff.fail();
      log('warn', `${subject}: could not check the database schema:`, error);
      return false;
    }
  }
}
