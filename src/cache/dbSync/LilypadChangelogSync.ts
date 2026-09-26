import type {
  LilypadDbCacheChangelogSync,
  LilypadDbSyncHost,
  LilypadDbSyncStrategy,
} from '@/cache/dbSync/LilypadDbSyncTypes';
import type { LilypadSchemaVerifier } from '@/cache/dbSync/LilypadSchemaVerifier';
import type { LilypadCacheKey } from '@/cache/LilypadCacheTypes';
import type { LilypadChangelogCursor, LilypadChangesRequest } from '@/dbGate/LilypadChangelog';
import {
  getLilypadChangelogReader,
  type LilypadChangelogReadResult,
  type LilypadChangelogReader,
  type LilypadChangelogSubscriber,
} from '@/dbGate/LilypadChangelogReader';
import { LilypadBackoff } from '@/internal/LilypadBackoff';
import { runInBackground } from '@/platform/LilypadPlatform';

export const DEFAULT_MAX_GAP = 60 * 60 * 1000; // 1 hour

/**
 * The `changelog` strategy: before a read, at most once per `pollInterval`, the cache reads the
 * changes of its table (with the other caches of the gate, see `LilypadChangelogReader`) and
 * applies them without a query.
 *
 * It trusts that it sees every change while its chain of reads is unbroken: each read starts from
 * the cursor of the previous one, and the previous one is at most `maxGap` old. Otherwise it reads
 * a `lookback` and expires every entry.
 */
export class LilypadChangelogSync<K extends LilypadCacheKey> implements LilypadDbSyncStrategy {
  readonly seesOwnWrites = true;
  private readonly reader: LilypadChangelogReader;
  private readonly subscriber: LilypadChangelogSubscriber;
  private readonly unsubscribe: () => void;
  private cursor?: LilypadChangelogCursor;
  private lastRead = 0;
  /** Since when the chain of reads is unbroken. */
  private chainStartedAt?: number;
  private readonly backoff: LilypadBackoff;

  constructor(
    private readonly host: LilypadDbSyncHost<K>,
    private readonly options: LilypadDbCacheChangelogSync,
    private readonly verifier: LilypadSchemaVerifier
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
    return this.options.maxGap ?? DEFAULT_MAX_GAP;
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  beforeRead(): Promise<void> | undefined {
    const now = Date.now();
    if (now - this.lastRead < this.options.pollInterval || !this.backoff.ready(now)) {
      return undefined;
    }
    this.verifier.checkInBackground(now);
    const reading = this.read();
    if (this.options.poll === 'background') {
      runInBackground(this.host.platform, reading, () => {});
      return undefined;
    }
    return reading;
  }

  trustedSince(): number | undefined {
    if (this.cursor === undefined || Date.now() - this.lastRead > this.maxGap) {
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
      const changedKeys: K[] = [];
      let truncated = false;
      for (const change of changes) {
        if (change.op === 'TRUNCATE') {
          changedKeys.push(...host.applyTruncate('lazy'));
          truncated = true;
        } else {
          changedKeys.push(await host.applyChange(change.op, change.rowId, 'lazy', change.xid));
        }
      }
      host.forgetOwnWritesCoveredBy(cursor);
      this.cursor = cursor;
      this.lastRead = readAt;
      this.backoff.succeed();
      host.emitInvalidation('changelog', changedKeys, { wholeCache: truncated });
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
