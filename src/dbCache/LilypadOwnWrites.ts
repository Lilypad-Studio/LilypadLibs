import { lilypadCursorCovers, type LilypadChangelogCursor } from '@/dbGate/LilypadChangelog';

/** How long the writes of an instance are remembered, to recognize their changes. */
const OWN_WRITE_RETENTION = 10 * 60 * 1000;
/**
 * The most transactions remembered per key. A key written again and again is never older than the
 * retention, and the changes of some of its writes may never come back (a notification lost, or
 * received before the write returned): forgetting one only costs a query when it does come back.
 */
const MAX_XIDS_PER_KEY = 32;

/**
 * The writes of a `LilypadDbCache` instance, by normalized key: their transaction ids, and the
 * ticket of the entry the last one stored. While the entry holds that ticket, the changes of these
 * writes are already reflected in it, and coming back through the sync they need no query.
 */
export class LilypadOwnWrites {
  /** `at`: when the last write of the key was recorded (`performance.now()`). */
  private writes = new Map<string, { ticket: number; xids: Set<bigint>; at: number }>();

  /** Remembers a write of the key by transaction `xid`, whose result the entry `ticket` holds. */
  record(normalizedKey: string, xid: bigint, ticket: number): void {
    const now = performance.now();
    // In the order of the last write, so the oldest come first
    for (const [key, own] of this.writes) {
      if (now - own.at <= OWN_WRITE_RETENTION) {
        break;
      }
      this.writes.delete(key);
    }
    const xids = this.writes.get(normalizedKey)?.xids ?? new Set<bigint>();
    xids.add(xid);
    if (xids.size > MAX_XIDS_PER_KEY) {
      // The oldest first: a Set keeps the insertion order
      xids.delete(xids.values().next().value!);
    }
    this.writes.delete(normalizedKey);
    this.writes.set(normalizedKey, { ticket, xids, at: now });
  }

  /**
   * Whether a change of the key by transaction `xid` is a write of this instance, and the entry
   * (whose ticket is `entryTicket`) still holds the result of the last write of this instance:
   * that result is at least as recent as the change. The write is forgotten either way.
   */
  consume(normalizedKey: string, xid: bigint, entryTicket: number | undefined): boolean {
    const own = this.writes.get(normalizedKey);
    if (!own?.xids.delete(xid)) {
      return false;
    }
    if (own.xids.size === 0) {
      this.writes.delete(normalizedKey);
    }
    return entryTicket === own.ticket;
  }

  /** Forgets the writes whose changes a read of the changelog from this cursor no longer returns. */
  forgetCoveredBy(cursor: LilypadChangelogCursor): void {
    for (const [normalizedKey, own] of this.writes) {
      for (const xid of own.xids) {
        if (lilypadCursorCovers(cursor, xid)) {
          own.xids.delete(xid);
        }
      }
      if (own.xids.size === 0) {
        this.writes.delete(normalizedKey);
      }
    }
  }

  clear(): void {
    this.writes.clear();
  }
}
