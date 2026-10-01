import type { LilypadCacheKey } from '@/cache/LilypadCacheTypes';

type Member<K> = { key: K; ticket: number };

/** Beyond this share of the rows to fetch, `getAll` loads the whole table in one query instead. */
export const LILYPAD_FULL_LOAD_RATIO = 0.25;
/** The fewest members noted from changes that are kept unverified, whatever the size of the table. */
const MIN_UNVERIFIED = 1000;

/**
 * The keys of the rows of a table, as far as a `LilypadDbCache` knows: each load of the table sets
 * them, and the writes, the fetches and the changes keep them up to date, so that `getAll` returns
 * every row while querying only those it does not hold up to date. They are tracked once the table
 * has been loaded, and while a load runs (what changes meanwhile is newer than the load).
 *
 * Each member carries the ticket of what told it (a load, a stored value, a change): a load that
 * started before a member was added or removed does not undo it.
 */
export class LilypadDbMembers<K extends LilypadCacheKey> {
  private members = new Map<string, Member<K>>();
  /**
   * The members noted from a change (`add`), not yet seen in a load or a stored value: anyone can
   * send a notification, so their number is bounded.
   */
  private unverified = new Set<string>();
  /** When the last load of the table started, if one completed (and nothing voided it since). */
  private loadedAt?: number | undefined;
  /** The loads of the table running. */
  private loading = 0;
  /** Loads started before this ticket (before a `TRUNCATE`) no longer tell which rows exist. */
  private floor = 0;

  /** Whether a load completed or is running, so that the members are tracked. */
  get tracked(): boolean {
    return this.loadedAt !== undefined || this.loading > 0;
  }

  /**
   * Whether the members are the rows of the table: a load completed, and no change of the whole
   * table voided it since (a `forget` without `empty`, or, during the first load, any `forget`).
   */
  get known(): boolean {
    return this.loadedAt !== undefined;
  }

  get size(): number {
    return this.members.size;
  }

  /** The key of a known row, as stored (it keeps its type). */
  keyOf(normalizedKey: string): K | undefined {
    return this.members.get(normalizedKey)?.key;
  }

  keys(): K[] {
    return [...this.members.values()].map((member) => member.key);
  }

  /** A load of the table starts: the members are tracked until it ends (`endLoad`). */
  beginLoad(): void {
    this.loading++;
  }

  endLoad(): void {
    this.loading--;
  }

  /**
   * Follows a value stored in the cache: a row is a member, `null` is not. A value older than
   * what the member already knows is ignored.
   */
  follow(normalizedKey: string, key: K, isRow: boolean, ticket: number): void {
    if (!this.tracked) {
      return;
    }
    const member = this.members.get(normalizedKey);
    if (member && member.ticket > ticket) {
      return;
    }
    this.unverified.delete(normalizedKey);
    if (isRow) {
      this.members.set(normalizedKey, { key, ticket });
    } else {
      this.members.delete(normalizedKey);
    }
  }

  /**
   * Notes a row that exists in the table, without fetching it. Beyond a quarter of the table (and
   * at least {@link MIN_UNVERIFIED}), the rows noted this way are forgotten instead: `getAll` would
   * load the whole table rather than fetch them anyway. Not while a load runs: it would void the
   * load, whose `getAll` would then load the table again; the next `add` after it checks again.
   *
   * @param ticket - A ticket taken now.
   */
  add(normalizedKey: string, key: K, ticket: number): void {
    if (!this.tracked) {
      return;
    }
    if (!this.members.has(normalizedKey)) {
      this.unverified.add(normalizedKey);
    }
    this.members.set(normalizedKey, { key, ticket });
    if (
      this.loading === 0 &&
      this.unverified.size > Math.max(MIN_UNVERIFIED, this.members.size * LILYPAD_FULL_LOAD_RATIO)
    ) {
      this.forget(ticket, false);
    }
  }

  delete(normalizedKey: string): void {
    this.members.delete(normalizedKey);
    this.unverified.delete(normalizedKey);
  }

  /**
   * Replaces the members with the result of a load started with `ticket` at `startedAt`, keeping
   * what changed after the load started: rows added since, and rows deleted since.
   *
   * @param deletedSince - Whether the key was cached as deleted after the load started.
   */
  replace(
    loaded: Iterable<readonly [string, K]>,
    ticket: number,
    startedAt: number,
    deletedSince: (normalizedKey: string) => boolean
  ): void {
    if (ticket < this.floor) {
      return;
    }
    const members = new Map<string, Member<K>>();
    for (const [normalizedKey, key] of loaded) {
      if (deletedSince(normalizedKey)) {
        continue;
      }
      const member = this.members.get(normalizedKey);
      members.set(normalizedKey, member && member.ticket > ticket ? member : { key, ticket });
    }
    for (const [normalizedKey, member] of this.members) {
      if (member.ticket > ticket && !members.has(normalizedKey)) {
        members.set(normalizedKey, member);
      }
    }
    // The loaded rows are verified; the rows noted since the load started are still to fetch
    for (const normalizedKey of this.unverified) {
      if ((members.get(normalizedKey)?.ticket ?? 0) <= ticket) {
        this.unverified.delete(normalizedKey);
      }
    }
    this.members = members;
    this.loadedAt = startedAt;
  }

  /**
   * Forgets every member: the table was emptied, or changed too much to follow.
   *
   * @param floor - A ticket taken now: loads started before no longer tell which rows exist.
   * @param empty - The table is known to be empty; otherwise the next `getAll` loads it again.
   */
  forget(floor: number, empty: boolean): void {
    this.floor = floor;
    this.members.clear();
    this.unverified.clear();
    if (!empty) {
      this.loadedAt = undefined;
    }
  }

  /**
   * Whether the rows of the table are known: loaded since the sync became trusted, or, without a
   * trusted sync, less than `ttl` ago. A load made before the sync became trusted again (after a
   * reconnection, or a gap in the reads of the changelog) may miss the rows inserted in between.
   */
  isLoaded(trustedSince: number | undefined, ttl: number): boolean {
    if (this.loadedAt === undefined) {
      return false;
    }
    if (trustedSince !== undefined) {
      return this.loadedAt >= trustedSince;
    }
    return Date.now() < this.loadedAt + ttl;
  }

  clear(): void {
    this.members.clear();
    this.unverified.clear();
  }
}
