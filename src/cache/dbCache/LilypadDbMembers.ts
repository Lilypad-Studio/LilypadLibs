import type { LilypadCacheKey } from '@/cache/LilypadCacheTypes';

type Member<K> = { key: K; ticket: number };

/**
 * The keys of the rows of a table, as far as a `LilypadDbCache` knows: each load of the table sets
 * them, and the writes, the fetches and the changes keep them up to date, so that `getAll` returns
 * every row while querying only those it does not hold up to date. They are tracked once the table
 * has been loaded.
 *
 * Each member carries the ticket of what told it (a load, a stored value, a change): a load that
 * started before a member was added or removed does not undo it.
 */
export class LilypadDbMembers<K extends LilypadCacheKey> {
  private members = new Map<string, Member<K>>();
  /** When the last load of the table started, if one completed (and nothing voided it since). */
  private loadedAt?: number;
  /** Loads started before this ticket (before a `TRUNCATE`) no longer tell which rows exist. */
  private floor = 0;

  /** Whether a load completed, so that the members are tracked. */
  get tracked(): boolean {
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

  /**
   * Follows a value stored in the cache: a row is a member, `null` is not. A value older than
   * what the member already knows is ignored.
   */
  follow(normalizedKey: string, key: K, isRow: boolean, ticket: number) {
    if (!this.tracked) {
      return;
    }
    const member = this.members.get(normalizedKey);
    if (member && member.ticket > ticket) {
      return;
    }
    if (isRow) {
      this.members.set(normalizedKey, { key, ticket });
    } else {
      this.members.delete(normalizedKey);
    }
  }

  /** Notes a row that exists in the table, without fetching it. */
  add(normalizedKey: string, key: K, ticket: number) {
    if (this.tracked) {
      this.members.set(normalizedKey, { key, ticket });
    }
  }

  delete(normalizedKey: string) {
    this.members.delete(normalizedKey);
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
  ) {
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
    this.members = members;
    this.loadedAt = startedAt;
  }

  /**
   * Forgets every member: the table was emptied, or changed too much to follow.
   *
   * @param floor - A ticket taken now: loads started before no longer tell which rows exist.
   * @param empty - The table is known to be empty; otherwise the next `getAll` loads it again.
   */
  forget(floor: number, empty: boolean) {
    this.floor = floor;
    this.members.clear();
    if (!empty) {
      this.loadedAt = undefined;
    }
  }

  /**
   * Whether the rows of the table are known: loaded since the sync became trusted, or, without a
   * trusted sync, less than `ttl` ago.
   */
  isLoaded(trustedSince: number | undefined, ttl: number): boolean {
    if (this.loadedAt === undefined) {
      return false;
    }
    if (trustedSince !== undefined && this.loadedAt >= trustedSince) {
      return true;
    }
    return Date.now() < this.loadedAt + ttl;
  }

  clear() {
    this.members.clear();
  }
}
