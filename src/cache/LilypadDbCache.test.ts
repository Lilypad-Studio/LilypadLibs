import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import LilypadDbCache from './LilypadDbCache';
import type {
  LilypadDbGate,
  LilypadDbSchema,
  ListenerCallbackIdentifier,
} from '@/dbGate/LilypadDbGate';
import type { LilypadLibLogger } from '@/logger/LilypadLogger';

// The changelog is read through this mock: the queries themselves are covered by the integration tests
const changelog = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/dbGate/LilypadChangelog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/dbGate/LilypadChangelog')>()),
  readLilypadChanges: changelog.read,
}));

type Item = { id: string; name: string };

const schema: LilypadDbSchema<Item> = {
  tableName: 'items',
  primaryKey: 'id',
  cols: { id: { type: 'string' }, name: { type: 'string' } },
};

/**
 * An in-memory stand-in for LilypadDbGate: the cache only uses these methods.
 */
function createFakeGate(initialRows: Item[] = []) {
  const rows = new Map(initialRows.map((row) => [row.id, row]));
  const listeners = new Map<string, ListenerCallbackIdentifier>();
  let generatedIds = 0;

  const mocks = {
    selectAllFromTable: vi.fn(async () => [...rows.values()]),
    selectFromTableByPrimaryKey: vi.fn(
      async (_schema: unknown, key: string) => rows.get(String(key)) ?? null
    ),
    insertToTable: vi.fn(async (_schema: unknown, item: Partial<Item>) => {
      const row = { ...item, id: item.id ?? `generated-${++generatedIds}` } as Item;
      rows.set(row.id, row);
      return row;
    }),
    updateToTable: vi.fn(async (_schema: unknown, item: Item) => {
      rows.set(item.id, item);
      return item;
    }),
    deleteFromTable: vi.fn(async (_schema: unknown, key: string) => {
      rows.delete(key);
    }),
    addListener: vi.fn(async (listener: ListenerCallbackIdentifier) => {
      listeners.set(listener.callbackId, listener);
    }),
    removeListener: vi.fn(async (_channel: string, callbackId: string) =>
      listeners.delete(callbackId)
    ),
  };

  /** Delivers a notification to every registered listener, as LilypadDbGate would. */
  const notify = async (payload: unknown) => {
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
    for (const listener of listeners.values()) {
      await listener.callback(raw);
    }
  };

  return { gate: mocks as unknown as LilypadDbGate, mocks, rows, listeners, notify };
}

type FakeGate = ReturnType<typeof createFakeGate>;

describe('LilypadDbCache', () => {
  let fake: FakeGate;

  beforeEach(() => {
    fake = createFakeGate([
      { id: '1', name: 'one' },
      { id: '2', name: 'two' },
    ]);
  });

  const createCache = (options: Record<string, unknown> = {}) =>
    LilypadDbCache.create<string, Item>(60000, {
      dbGate: { gate: fake.gate, schema },
      ...options,
    });

  describe('creation and disposal', () => {
    it('should register the default listener on the cache_events channel', async () => {
      await createCache();

      expect(fake.mocks.addListener).toHaveBeenCalledOnce();
      expect([...fake.listeners.values()][0].channel).toBe('cache_events');
    });

    it('should not register a listener when the default listener is disabled', async () => {
      await createCache({ useDefaultDbListener: false });

      expect(fake.mocks.addListener).not.toHaveBeenCalled();
    });

    it('should reject when the default listener cannot be registered', async () => {
      fake.mocks.addListener.mockRejectedValueOnce(new Error('database unreachable'));

      await expect(createCache()).rejects.toThrow('database unreachable');
    });

    it('should give each cache on the same table its own listener', async () => {
      await createCache();
      await createCache();

      expect(fake.listeners.size).toBe(2);
    });

    it('should remove its listener when disposed', async () => {
      const cache = await createCache();

      await cache.dispose();

      expect(fake.mocks.removeListener).toHaveBeenCalledOnce();
      expect(fake.listeners.size).toBe(0);
    });

    it('should return the same singleton until it is disposed', async () => {
      const options = { singleton: true, singletonIdentifier: 'LilypadDbCache.test-singleton' };
      const first = await createCache(options);
      const second = await createCache(options);

      expect(second).toBe(first);

      await first.dispose();
      const third = await createCache(options);

      expect(third).not.toBe(first);
      await third.dispose();
    });
  });

  describe('default listener', () => {
    it('should refresh cached entries on INSERT and UPDATE notifications', async () => {
      const cache = await createCache();
      await cache.getOrFetch('3'); // cached as null: the row does not exist yet
      fake.rows.set('3', { id: '3', name: 'three' });

      await fake.notify({ table: 'items', id: '3', op: 'INSERT' });

      expect(cache.get('3')).toEqual({ id: '3', name: 'three' });

      fake.rows.set('3', { id: '3', name: 'THREE' });
      await fake.notify({ table: 'items', id: '3', op: 'UPDATE' });

      expect(cache.get('3')).toEqual({ id: '3', name: 'THREE' });
    });

    it('should set the entry to null on DELETE notifications', async () => {
      const cache = await createCache();
      await cache.getOrFetch('1');

      await fake.notify({ table: 'items', id: '1', op: 'DELETE' });

      expect(cache.get('1')).toBeNull();
    });

    it('should ignore notifications for other tables, without id, or not JSON', async () => {
      await createCache();

      await fake.notify({ table: 'other', id: '1', op: 'UPDATE' });
      await fake.notify({ table: 'items', op: 'UPDATE' });
      await fake.notify('not json');

      expect(fake.mocks.selectFromTableByPrimaryKey).not.toHaveBeenCalled();
    });

    it('should leave the cache to the callback by default', async () => {
      const callback = vi.fn();
      const cache = await createCache({
        useDefaultDbListener: true,
        defaultListenerOptions: { callback },
      });

      await fake.notify({ table: 'items', id: '1', op: 'UPDATE' });

      expect(callback).toHaveBeenCalledWith({ table: 'items', id: '1', op: 'UPDATE' });
      expect(cache.getComprehensive('1').type).toBe('miss');
    });

    it('should update the entry before the callback when requested', async () => {
      let valueSeenByCallback: unknown;
      const cache = await createCache({
        useDefaultDbListener: true,
        defaultListenerOptions: {
          automaticallyInvalidateDataBeforeCallback: true,
          callback: () => {
            valueSeenByCallback = cache.get('1');
          },
        },
      });
      await cache.getOrFetch('1');
      fake.rows.set('1', { id: '1', name: 'ONE' });

      await fake.notify({ table: 'items', id: '1', op: 'UPDATE' });

      expect(valueSeenByCallback).toEqual({ id: '1', name: 'ONE' });
    });
  });

  describe('reads', () => {
    it('should return all rows, excluding the deleted ones', async () => {
      const cache = await createCache();
      await cache.getAll();
      await fake.notify({ table: 'items', id: '2', op: 'DELETE' });

      const items = await cache.getAll();

      expect(items).toEqual([{ id: '1', name: 'one' }]);
    });

    it('should share one query between concurrent getOrFetch calls', async () => {
      const cache = await createCache();

      const [first, second] = await Promise.all([cache.getOrFetch('1'), cache.getOrFetch('1')]);

      expect(first).toEqual({ id: '1', name: 'one' });
      expect(second).toBe(first);
      expect(fake.mocks.selectFromTableByPrimaryKey).toHaveBeenCalledOnce();
    });

    it('should cache a missing row as null', async () => {
      const cache = await createCache();

      expect(await cache.getOrFetch('missing')).toBeNull();
      expect(await cache.getOrFetch('missing')).toBeNull();
      expect(fake.mocks.selectFromTableByPrimaryKey).toHaveBeenCalledOnce();
    });

    it('should return undefined when the fetch fails', async () => {
      const cache = await createCache();
      fake.mocks.selectFromTableByPrimaryKey.mockRejectedValueOnce(new Error('query failed'));

      expect(await cache.getOrFetch('1')).toBeUndefined();
    });

    it('should expire the entry when the update after an invalidation fails', async () => {
      const cache = await createCache();
      await cache.getOrFetch('1');
      fake.mocks.selectFromTableByPrimaryKey.mockRejectedValueOnce(new Error('query failed'));

      await cache.invalidate('1');

      expect(cache.getComprehensive('1').type).toBe('expired');
    });
  });

  describe('writes', () => {
    it('should cache a created row under the primary key generated by the database', async () => {
      const cache = await createCache();

      const created = await cache.sqlCreate({ name: 'new' } as Item);

      expect(created).toEqual({ id: 'generated-1', name: 'new' });
      expect(cache.get('generated-1')).toEqual(created);
    });

    it('should write updates even when the cached item looks identical', async () => {
      const cache = await createCache();
      await cache.getOrFetch('1');

      await cache.sqlUpdate({ id: '1', name: 'one' });

      expect(fake.mocks.updateToTable).toHaveBeenCalledOnce();
    });

    it('should cache the row returned by the database after an update', async () => {
      const cache = await createCache();
      fake.mocks.updateToTable.mockResolvedValueOnce({ id: '1', name: 'sanitized' });

      await cache.sqlUpdate({ id: '1', name: 'raw' });

      expect(cache.get('1')).toEqual({ id: '1', name: 'sanitized' });
    });

    it('should cache a deleted row as null', async () => {
      const cache = await createCache();
      await cache.getOrFetch('1');

      await cache.sqlDelete('1');

      expect(fake.mocks.deleteFromTable).toHaveBeenCalledWith(schema, '1');
      expect(cache.get('1')).toBeNull();
    });
  });

  describe('consistency with the database', () => {
    /** A query result whose resolution the test controls. */
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((r) => (resolve = r));
      return { promise, resolve };
    }

    it('should not query rows that are not cached, but include them in the next getAll', async () => {
      const cache = await createCache();
      await cache.getAll();
      fake.rows.set('3', { id: '3', name: 'three' });

      await fake.notify({ table: 'items', id: '3', op: 'INSERT' });

      expect(fake.mocks.selectFromTableByPrimaryKey).not.toHaveBeenCalled();
      expect(await cache.getAll()).toContainEqual({ id: '3', name: 'three' });
      expect(fake.mocks.selectAllFromTable).toHaveBeenCalledTimes(2);
    });

    it('should refresh a key whose fetch is in flight', async () => {
      const cache = await createCache();
      const staleRead = deferred<Item | null>();
      fake.mocks.selectFromTableByPrimaryKey.mockReturnValueOnce(staleRead.promise);
      const fetching = cache.getOrFetch('1');

      fake.rows.set('1', { id: '1', name: 'ONE' });
      await fake.notify({ table: 'items', id: '1', op: 'UPDATE' });
      staleRead.resolve({ id: '1', name: 'one' }); // read before the update
      await fetching;

      expect(cache.get('1')).toEqual({ id: '1', name: 'ONE' });
    });

    it('should keep the newest row when refreshes complete out of order', async () => {
      const cache = await createCache();
      await cache.getOrFetch('1');
      const firstRead = deferred<Item | null>();
      const secondRead = deferred<Item | null>();
      fake.mocks.selectFromTableByPrimaryKey
        .mockReturnValueOnce(firstRead.promise)
        .mockReturnValueOnce(secondRead.promise);

      const firstRefresh = fake.notify({ table: 'items', id: '1', op: 'UPDATE' });
      const secondRefresh = fake.notify({ table: 'items', id: '1', op: 'UPDATE' });
      secondRead.resolve({ id: '1', name: 'second' });
      await secondRefresh;
      firstRead.resolve({ id: '1', name: 'first' });
      await firstRefresh;

      expect(cache.get('1')).toEqual({ id: '1', name: 'second' });
    });

    it('should reflect a deleted row even for a protected key', async () => {
      const cache = await createCache();
      await cache.getOrFetch('1');
      await cache.getOrFetch('2');
      cache.addProtectedKeys(['1', '2']);

      await fake.notify({ table: 'items', id: '1', op: 'DELETE' });
      await cache.sqlDelete('2');

      expect(cache.get('1')).toBeNull();
      expect(cache.get('2')).toBeNull();
    });

    it('should expire every entry and force a bulk sync when LISTEN reconnects', async () => {
      const cache = await createCache();
      await cache.getAll();
      const listener = [...fake.listeners.values()][0];

      await listener.onReconnect?.();

      expect(cache.getComprehensive('1').type).toBe('expired');
      await cache.getAll();
      expect(fake.mocks.selectAllFromTable).toHaveBeenCalledTimes(2);
    });

    it('should keep the key type of cached entries for numeric ids', async () => {
      const cache = await createCache();
      await cache.getOrFetch('1');
      fake.rows.set('1', { id: '1', name: 'ONE' });

      await fake.notify({ table: 'items', id: 1, op: 'UPDATE' });

      expect(cache.get('1')).toEqual({ id: '1', name: 'ONE' });
      expect([...cache.bulkGet({}).keys()]).toEqual(['1']);
    });

    it('should ignore payloads that are not objects', async () => {
      await createCache();

      await expect(fake.notify('null')).resolves.toBeUndefined();
      await expect(fake.notify('42')).resolves.toBeUndefined();
      expect(fake.mocks.selectFromTableByPrimaryKey).not.toHaveBeenCalled();
    });

    it('should reject getAll when the table cannot be loaded', async () => {
      const cache = await createCache();
      fake.mocks.selectAllFromTable.mockRejectedValueOnce(new Error('database unreachable'));

      await expect(cache.getAll()).rejects.toThrow('database unreachable');
    });
  });

  describe('typing and singletons', () => {
    it('should require the primary key to update, with a declared primary key', async () => {
      const typedSchema: LilypadDbSchema<Item, 'id'> = { ...schema, primaryKey: 'id' };
      const cache = await LilypadDbCache.create<string, Item, 'id'>(60000, {
        dbGate: { gate: fake.gate, schema: typedSchema },
      });

      await cache.sqlUpdate({ id: '1', name: 'renamed' }); // partial update: no full item needed
      // @ts-expect-error: an update needs the primary key
      await expect(cache.sqlUpdate({ name: 'no id' })).rejects.toThrow(
        'Primary key "id" is missing in the item data for table "items".'
      );
    });

    it('should warn when a singleton is requested with a different TTL', async () => {
      const logger = { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() };
      const options = { singleton: true, singletonIdentifier: 'LilypadDbCache.test-mismatch' };
      const first = await createCache(options);

      const second = await LilypadDbCache.create<string, Item>(30000, {
        dbGate: { gate: fake.gate, schema },
        logger: logger as unknown as LilypadLibLogger,
        ...(options as { singleton: true; singletonIdentifier: string }),
      });

      expect(second).toBe(first);
      expect(logger.warn).toHaveBeenCalledOnce();
      await first.dispose();
    });
  });

  describe('changelog sync', () => {
    const createChangelogCache = (
      sync: Record<string, unknown> = {},
      options: Record<string, unknown> = {}
    ) => createCache({ sync: { strategy: 'changelog', pollInterval: 1000, ...sync }, ...options });

    beforeEach(() => {
      vi.useFakeTimers();
      changelog.read.mockReset();
      changelog.read.mockResolvedValue({ changes: [], cursor: 100n });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should not register a database listener', async () => {
      await createChangelogCache();

      expect(fake.mocks.addListener).not.toHaveBeenCalled();
    });

    it('should read with a lookback first, then from the cursor once per interval', async () => {
      const cache = await createChangelogCache();

      await cache.getOrFetch('1');
      expect(changelog.read).toHaveBeenCalledWith(fake.gate, {
        tableName: 'items',
        since: { lookback: 120_000 }, // TTL + staleWhileRevalidate + 1 minute
        changelogTable: undefined,
      });

      await cache.getOrFetch('1');
      expect(changelog.read).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(1000);
      await cache.getOrFetch('1');
      expect(changelog.read).toHaveBeenLastCalledWith(
        fake.gate,
        expect.objectContaining({ since: { cursor: 100n } })
      );
    });

    it('should expire the changed keys it holds, so that the next read fetches them', async () => {
      const cache = await createChangelogCache();
      await cache.getOrFetch('1');
      fake.rows.set('1', { id: '1', name: 'ONE' });
      changelog.read.mockResolvedValueOnce({
        changes: [{ id: '5', xid: 100n, rowId: '1', op: 'UPDATE' }],
        cursor: 101n,
      });

      await vi.advanceTimersByTimeAsync(1000);
      const value = await cache.getOrFetch('1');

      expect(value).toEqual({ id: '1', name: 'ONE' });
      expect(fake.mocks.selectFromTableByPrimaryKey).toHaveBeenCalledTimes(2);
    });

    it('should not query the changed rows it does not hold, but reload them with getAll', async () => {
      const cache = await createChangelogCache();
      await cache.getAll();
      fake.rows.set('3', { id: '3', name: 'three' });
      changelog.read.mockResolvedValueOnce({
        changes: [{ id: '6', xid: 100n, rowId: '3', op: 'INSERT' }],
        cursor: 101n,
      });

      await vi.advanceTimersByTimeAsync(1000);
      const items = await cache.getAll();

      expect(fake.mocks.selectFromTableByPrimaryKey).not.toHaveBeenCalled();
      expect(items).toContainEqual({ id: '3', name: 'three' });
    });

    it('should cache the deleted rows as null', async () => {
      const cache = await createChangelogCache();
      await cache.getOrFetch('1');
      changelog.read.mockResolvedValueOnce({
        changes: [{ id: '7', xid: 100n, rowId: '1', op: 'DELETE' }],
        cursor: 101n,
      });

      await vi.advanceTimersByTimeAsync(1000);

      expect(await cache.getOrFetch('1')).toBeNull();
    });

    it('should apply each change once, even when a later read returns it again', async () => {
      const onInvalidate = vi.fn();
      const cache = await createChangelogCache({}, { platform: { onInvalidate } });
      await cache.getOrFetch('1');
      const change = { id: '8', xid: 100n, rowId: '1', op: 'UPDATE' as const };
      // The cursor stays at 100: an older transaction is still running
      changelog.read.mockResolvedValue({ changes: [change], cursor: 100n });

      await vi.advanceTimersByTimeAsync(1000);
      await cache.getOrFetch('2');
      await vi.advanceTimersByTimeAsync(1000);
      await cache.getOrFetch('2');
      await vi.advanceTimersByTimeAsync(0);

      const changelogEvents = onInvalidate.mock.calls.filter(
        ([event]) => event.source === 'changelog'
      );
      expect(changelogEvents).toEqual([
        [
          {
            source: 'changelog',
            cache: 'items',
            keys: ['1'],
            tags: ['lilypad:items', 'lilypad:items:1'],
          },
        ],
      ]);
    });

    it('should stop trusting the cursor after maxGap', async () => {
      const cache = await createChangelogCache({ maxGap: 5000 });
      await cache.getOrFetch('1');

      await vi.advanceTimersByTimeAsync(6000);
      await cache.getOrFetch('1');

      expect(changelog.read).toHaveBeenLastCalledWith(
        fake.gate,
        expect.objectContaining({ since: { lookback: 120_000 } })
      );
      expect(fake.mocks.selectFromTableByPrimaryKey).toHaveBeenCalledTimes(2);
    });

    it('should not wait for the changelog with poll: background', async () => {
      changelog.read.mockReturnValue(new Promise(() => {}));
      const cache = await createChangelogCache({ poll: 'background' });

      await expect(cache.getOrFetch('1')).resolves.toEqual({ id: '1', name: 'one' });
    });

    it('should keep serving reads when the changelog cannot be read', async () => {
      const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
      changelog.read.mockRejectedValue(new Error('no changelog table'));
      const cache = await createChangelogCache({}, { logger });

      await expect(cache.getOrFetch('1')).resolves.toEqual({ id: '1', name: 'one' });
      expect(logger.error).toHaveBeenCalledWith(
        cache.id,
        'Error reading the changelog:',
        expect.any(Error)
      );
    });
  });

  describe('lazy listen', () => {
    it('should start LISTEN on the first read instead of on creation', async () => {
      const cache = await createCache({ sync: { strategy: 'listen', connect: 'lazy' } });
      expect(fake.mocks.addListener).not.toHaveBeenCalled();

      await cache.getOrFetch('1');
      await cache.getOrFetch('2');

      expect(fake.mocks.addListener).toHaveBeenCalledOnce();
    });

    it('should retry a failed lazy LISTEN on the next read', async () => {
      const cache = await createCache({ sync: { strategy: 'listen', connect: 'lazy' } });
      fake.mocks.addListener.mockRejectedValueOnce(new Error('database unreachable'));

      await cache.getOrFetch('1');
      await cache.getOrFetch('2');

      expect(fake.mocks.addListener).toHaveBeenCalledTimes(2);
    });
  });

  describe('invalidation events of writes', () => {
    it('should send the writes of this instance as write events', async () => {
      const onInvalidate = vi.fn();
      const cache = await createCache({ platform: { onInvalidate } });

      await cache.sqlUpdate({ id: '1', name: 'renamed' });
      await cache.sqlDelete('2');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(onInvalidate.mock.calls.map(([event]) => [event.source, event.keys])).toEqual([
        ['write', ['1']],
        ['write', ['2']],
      ]);
    });
  });
});
