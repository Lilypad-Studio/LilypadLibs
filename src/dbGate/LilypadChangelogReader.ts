import type { LilypadDbGate } from '@/dbGate/LilypadDbGate';
import {
  LILYPAD_DEFAULT_CHANGELOG_TABLE,
  readLilypadChangesBatch,
  type LilypadChange,
  type LilypadChangelogCursor,
  type LilypadChangesRequest,
} from '@/dbGate/LilypadChangelog';

/** The result of a read of the changelog for one subscriber. */
export type LilypadChangelogReadResult = {
  changes: LilypadChange[];
  /** The cursor for the next read. */
  cursor: LilypadChangelogCursor;
  /** When the read started. */
  readAt: number;
};

export type LilypadChangelogSubscriber = {
  /** What to read for this subscriber, called when a read starts. */
  request(readAt: number): LilypadChangesRequest;
  /** Applies the changes read for the request. Its errors are its own: they are ignored here. */
  apply(result: LilypadChangelogReadResult, request: LilypadChangesRequest): Promise<void> | void;
};

/**
 * Reads the changelog for every cache of a gate in one query: when a cache needs a read, the
 * tables of all the subscribed caches are read together, so that N cached tables cost one query
 * per poll instead of N.
 */
export class LilypadChangelogReader {
  private subscribers = new Set<LilypadChangelogSubscriber>();
  private current?: { included: Set<LilypadChangelogSubscriber>; promise: Promise<void> };
  /** A read queued after the current one, for subscribers that the current one does not include. */
  private queued?: Promise<void>;

  constructor(
    private readonly gate: LilypadDbGate,
    private readonly changelogTable: string
  ) {}

  /** @returns The function that unsubscribes. */
  subscribe(subscriber: LilypadChangelogSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /**
   * Reads the changelog for every subscriber, and resolves once `subscriber` has applied its
   * changes. A read already running that includes `subscriber` is shared.
   *
   * @throws If the changelog cannot be read.
   */
  read(subscriber: LilypadChangelogSubscriber): Promise<void> {
    const current = this.current;
    if (!current) {
      return this.start();
    }
    if (current.included.has(subscriber)) {
      return current.promise;
    }
    const noop = () => {};
    this.queued ??= current.promise.then(noop, noop).then(() => {
      this.queued = undefined;
      return this.start();
    });
    return this.queued;
  }

  private start(): Promise<void> {
    const included = new Set(this.subscribers);
    const promise = this.readAll([...included]).finally(() => {
      if (this.current?.promise === promise) {
        this.current = undefined;
      }
    });
    this.current = { included, promise };
    return promise;
  }

  private async readAll(subscribers: LilypadChangelogSubscriber[]): Promise<void> {
    if (subscribers.length === 0) {
      return;
    }
    const readAt = Date.now();
    const requests = subscribers.map((subscriber) => subscriber.request(readAt));
    const { changes, cursor } = await readLilypadChangesBatch(this.gate, {
      requests,
      changelogTable: this.changelogTable,
    });
    await Promise.allSettled(
      subscribers.map(async (subscriber, index) =>
        subscriber.apply({ changes: changes[index] ?? [], cursor, readAt }, requests[index]!)
      )
    );
  }
}

const readers = new WeakMap<LilypadDbGate, Map<string, LilypadChangelogReader>>();

/** The reader shared by the caches of a gate that use this changelog table. */
export function getLilypadChangelogReader(
  gate: LilypadDbGate,
  changelogTable: string = LILYPAD_DEFAULT_CHANGELOG_TABLE
): LilypadChangelogReader {
  let gateReaders = readers.get(gate);
  if (!gateReaders) {
    gateReaders = new Map();
    readers.set(gate, gateReaders);
  }
  let reader = gateReaders.get(changelogTable);
  if (!reader) {
    reader = new LilypadChangelogReader(gate, changelogTable);
    gateReaders.set(changelogTable, reader);
  }
  return reader;
}
