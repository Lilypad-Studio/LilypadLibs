import type {
  LilypadDbCacheChangelogSync,
  LilypadDbSyncHost,
  LilypadDbSyncStrategy,
} from '@/cache/dbSync/LilypadDbSyncTypes';
import type { LilypadCacheKey } from '@/cache/LilypadCacheTypes';
import type {
  LilypadChange,
  LilypadChangelogCursor,
  LilypadChangesRequest,
} from '@/dbGate/LilypadChangelog';
import {
  getLilypadChangelogReader,
  type LilypadChangelogReadResult,
  type LilypadChangelogReader,
  type LilypadChangelogSubscriber,
} from '@/dbGate/LilypadChangelogReader';
import { LILYPAD_DEFAULT_MAX_GAP } from '@/dbConfig/LilypadDbConfigDefaults';
import { LilypadBackoff } from '@/internal/LilypadBackoff';
import { runInBackground } from '@/platform/LilypadPlatform';

/**
 * Above this number of changed keys in one read, the table is expired as a whole instead of key by
 * key: following each key would remove each one from the shared level, on every instance.
 */
const LILYPAD_BULK_CHANGE_THRESHOLD = 1000;

/**
 * The changes to apply, in order: whether the table was emptied, and the last change of each row
 * after the last `TRUNCATE`. The changes of a row are ordered by the lock of the row, so its last
 * change says what it is now; the changes of a row made before a `TRUNCATE` no longer matter.
 */
export function lilypadNetChanges(changes: LilypadChange[]): {
  truncated: boolean;
  rows: Map<string, Exclude<LilypadChange, { op: 'TRUNCATE' }>>;
} {
  let truncated = false;
  const rows = new Map<string, Exclude<LilypadChange, { op: 'TRUNCATE' }>>();
  for (const change of changes) {
    if (change.op === 'TRUNCATE') {
      truncated = true;
      rows.clear();
    } else {
      // Deleted first, so that the map keeps the order of the last changes
      rows.delete(change.rowId);
      rows.set(change.rowId, change);
    }
  }
  return { truncated, rows };
}

/**
 * The `changelog` strategy: before a read, at most once per `pollInterval`, the cache reads the
 * changes of its table (with the other caches of the gate, see `LilypadChangelogReader`) and
 * applies them without a query.
 *
 * Its chain of reads is unbroken while each read starts from the cursor of the previous one, and
 * the previous one is at most `maxGap` old; otherwise it reads a `lookback` and expires every
 * entry. It trusts that it sees every change while the chain is unbroken and its last read was
 * applied less than `pollInterval` ago (two with `poll: 'background'`, whose reads do not wait):
 * a change committed since is only applied by the next read.
 */
export class LilypadChangelogSync<K extends LilypadCacheKey> implements LilypadDbSyncStrategy {
  readonly seesOwnWrites = true;
  private readonly reader: LilypadChangelogReader;
  private readonly subscriber: LilypadChangelogSubscriber;
  private readonly unsubscribe: () => void;
  private cursor?: LilypadChangelogCursor | undefined;
  private lastRead = 0;
  /**
   * When the last read was applied (`performance.now()`): from its end, not its start, so that a
   * read awaited just before counts as current whatever its duration.
   */
  private lastApplied = -Infinity;
  /** Since when the chain of reads is unbroken. */
  private chainStartedAt?: number | undefined;
  private readonly backoff: LilypadBackoff;

  constructor(
    private readonly host: LilypadDbSyncHost<K>,
    private readonly options: LilypadDbCacheChangelogSync
  ) {
    this.backoff = new LilypadBackoff(() => Math.max(options.pollInterval, 1000));
    this.reader = getLilypadChangelogReader(host.gate, options.table);
    this.subscriber = {
      request: (readAt) => this.request(readAt),
      apply: (result, request) => this.apply(result, 'cursor' in request.since),
    };
    this.unsubscribe = this.reader.subscribe(this.subscriber);
  }

  private get maxGap(): number {
    return this.options.maxGap ?? LILYPAD_DEFAULT_MAX_GAP;
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  beforeRead(): Promise<void> | undefined {
    const now = Date.now();
    if (now - this.lastRead < this.options.pollInterval || !this.backoff.ready()) {
      return undefined;
    }
    const reading = this.read();
    if (this.options.poll === 'background') {
      runInBackground(this.host.platform, reading, () => {});
      return undefined;
    }
    return reading;
  }

  trustedSince(): number | undefined {
    const { poll, pollInterval } = this.options;
    // A read that fails, or that no read triggers (`get` does not read), leaves changes unapplied
    const current =
      performance.now() - this.lastApplied <= (poll === 'background' ? 2 : 1) * pollInterval;
    if (this.cursor === undefined || Date.now() - this.lastRead > this.maxGap || !current) {
      return undefined;
    }
    return this.chainStartedAt;
  }

  /** Reads the changelog; errors are logged, and the next read waits for a backoff. */
  private read(): Promise<void> {
    return this.reader.read(this.subscriber).catch((error: unknown) => {
      this.backoff.fail();
      this.host.log('error', 'Error reading the changelog:', error);
    });
  }

  /** What to read: the changes since the cursor, or a lookback if the chain is broken. */
  private request(readAt: number): LilypadChangesRequest {
    const tableName = this.host.tableName;
    if (this.cursor !== undefined && readAt - this.lastRead <= this.maxGap) {
      return { tableName, since: { cursor: this.cursor } };
    }
    return { tableName, since: { lookback: this.options.lookback ?? this.host.defaultLookback() } };
  }

  /**
   * Applies a read of the changelog. Its errors are logged: the other caches read with it must not
   * be affected. Each change is returned by one read only (see `LilypadChangelogCursor`).
   *
   * @param trusted - Whether the read started from the cursor of this cache.
   */
  private async apply(
    { changes, cursor, readAt }: LilypadChangelogReadResult,
    trusted: boolean
  ): Promise<void> {
    const { host } = this;
    if (host.isDisposed()) {
      return;
    }
    try {
      if (!trusted) {
        // First read, or too long since the last one: the local entries may have missed changes,
        // and the recent changes are applied below to the shared level too
        host.expireEverything();
        // Every change committed from now on is returned by the next reads
        this.chainStartedAt = readAt;
      }
      const { truncated, rows } = lilypadNetChanges(changes);
      const changedKeys = new Set<K>();
      let wholeCache = truncated;
      if (truncated) {
        for (const key of host.applyTruncate('lazy')) {
          changedKeys.add(key);
        }
      }
      if (rows.size > LILYPAD_BULK_CHANGE_THRESHOLD) {
        // Too many rows to follow one by one: one expiration and one event for the whole table
        host.applyBulkChange();
        changedKeys.clear();
        wholeCache = true;
      } else {
        for (const change of rows.values()) {
          changedKeys.add(await host.applyChange(change.op, change.rowId, 'lazy', change.xid));
        }
      }
      host.forgetOwnWritesCoveredBy(cursor);
      this.cursor = cursor;
      this.lastRead = readAt;
      this.lastApplied = performance.now();
      this.backoff.succeed();
      host.emitInvalidation('changelog', [...changedKeys], { wholeCache });
    } catch (error) {
      // The cursor is kept: the next read, after a backoff, returns these changes again
      this.backoff.fail();
      host.log('error', 'Error applying the changelog:', error);
    }
  }

  dispose(): Promise<void> {
    this.unsubscribe();
    return Promise.resolve();
  }
}
