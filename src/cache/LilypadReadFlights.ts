/**
 * The reads of the source in flight, by normalized key, so that concurrent reads of a key share one
 * query.
 *
 * A caller joins a read only if the read started after the last change of the key (its ticket is
 * above the ticket the key has now): a read started before an invalidation, a removal or a newer
 * write may return the old value, so the caller starts a new read instead. The superseded reads
 * are still counted by {@link has} until they settle, since the fences of the cache must keep
 * discarding their results.
 */
export class LilypadReadFlights<T> {
  private joinable = new Map<string, { ticket: number; promise: Promise<T> }>();
  private counts = new Map<string, number>();

  /**
   * The read of the key in flight that started after `currentTicket` (the ticket of the key now),
   * or `undefined`.
   */
  join(normalizedKey: string, currentTicket: number): Promise<T> | undefined {
    const flight = this.joinable.get(normalizedKey);
    return flight && flight.ticket > currentTicket ? flight.promise : undefined;
  }

  /**
   * Registers a read of these keys, started with `ticket`: it becomes the one they join. It must
   * be called before `promise` is returned to the callers, so that it is forgotten before their
   * continuations run.
   */
  start(normalizedKeys: Iterable<string>, ticket: number, promise: Promise<T>): void {
    const keys = [...normalizedKeys];
    for (const key of keys) {
      this.joinable.set(key, { ticket, promise });
      this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    }
    const settle = () => {
      for (const key of keys) {
        if (this.joinable.get(key)?.promise === promise) {
          this.joinable.delete(key);
        }
        const count = (this.counts.get(key) ?? 1) - 1;
        if (count > 0) {
          this.counts.set(key, count);
        } else {
          this.counts.delete(key);
        }
      }
    };
    void promise.then(settle, settle);
  }

  /** Whether a read of the key is in flight, joinable or superseded. */
  has(normalizedKey: string): boolean {
    return this.counts.has(normalizedKey);
  }
}
