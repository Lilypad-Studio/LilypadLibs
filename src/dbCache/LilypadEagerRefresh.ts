import type { LilypadCacheKey } from '@/cache/LilypadCacheTypes';

/**
 * The most keys that notifications make an instance re-read per second. Anyone can send a
 * notification: beyond this budget, the notified keys are only expired, and read again when the
 * application asks for them, so that a flood of notifications cannot flood the database.
 */
const EAGER_REFRESHES_PER_SECOND = 1000;

/**
 * The re-reads of the keys of a `LilypadDbCache` after notifications: a change of many rows
 * notifies each of them, and one query per row would flood the pool, so the keys notified together
 * are gathered into one batch, read once the notifications received together have been handled (a
 * microtask later). The query of a batch starts after the notifications of its keys: it sees their
 * changes, even when an older read of the key is still running.
 */
export class LilypadEagerRefresh<K extends LilypadCacheKey> {
  /** The batch gathering keys, until its microtask runs. */
  private batch?: { keys: Map<string, K>; done: Promise<void> } | undefined;
  /** The keys of the batches pending or running, with their number. */
  private reads = new Map<string, number>();
  /** The keys taken from the budget in the current second (`performance.now()`). */
  private window = { start: -Infinity, count: 0 };

  /**
   * @param read - Reads the keys of a batch and caches them. It must not reject: a failed read
   * expires its keys instead.
   */
  constructor(private readonly read: (keys: K[]) => Promise<void>) {}

  /** Whether a batch that reads the key is pending or running. */
  has(normalizedKey: string): boolean {
    return this.reads.has(normalizedKey);
  }

  /**
   * Adds the key to the batch being gathered, within the budget of this second.
   *
   * @returns The end of the batch, or `undefined` when the budget is spent: the caller expires the
   * key instead.
   */
  refresh(normalizedKey: string, key: K): Promise<void> | undefined {
    let batch = this.batch;
    if (batch?.keys.has(normalizedKey)) {
      return batch.done;
    }
    if (!this.takeBudget()) {
      return undefined;
    }
    if (!batch) {
      const keys = new Map<string, K>();
      const done = new Promise<void>((resolve) => {
        queueMicrotask(() => {
          if (this.batch?.keys === keys) {
            this.batch = undefined;
          }
          resolve(this.run(keys));
        });
      });
      batch = { keys, done };
      this.batch = batch;
    }
    batch.keys.set(normalizedKey, key);
    this.reads.set(normalizedKey, (this.reads.get(normalizedKey) ?? 0) + 1);
    return batch.done;
  }

  /** Takes one key of the budget: `false` once the budget of this second is spent. */
  private takeBudget(): boolean {
    const now = performance.now();
    if (now - this.window.start >= 1000) {
      this.window = { start: now, count: 0 };
    }
    this.window.count++;
    return this.window.count <= EAGER_REFRESHES_PER_SECOND;
  }

  private async run(keys: Map<string, K>): Promise<void> {
    try {
      await this.read([...keys.values()]);
    } finally {
      for (const normalizedKey of keys.keys()) {
        const count = (this.reads.get(normalizedKey) ?? 1) - 1;
        if (count > 0) {
          this.reads.set(normalizedKey, count);
        } else {
          this.reads.delete(normalizedKey);
        }
      }
    }
  }
}
