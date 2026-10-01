import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LilypadDbCache, type LilypadDbCacheSyncOverrides } from './LilypadDbCache';
import type { LilypadDbGate, LilypadDbListener } from '@/dbGate/LilypadDbGate';
import { LilypadTimeoutError } from '@/flow/LilypadFlowControl';
import { LilypadDisposedError } from '@/internal/LilypadDisposedError';
import {
  defineLilypadDb,
  defineLilypadTable,
  type LilypadDbConfigInput,
  type LilypadDbTableInputBase,
  type LilypadDbTableSync,
} from '@/dbConfig/LilypadDbConfig';

// The changelog is read through this mock: the queries themselves are covered by the integration tests
const changelog = vi.hoisted(() => {
  const read = vi.fn();
  // The shared reader reads every table in one query: delegated here to one read per table
  const batch = vi.fn(
    async (
      gate: unknown,
      options: { requests: { tableName: string; since: unknown }[]; changelogTable?: string }
    ) => {
      const results = (await Promise.all(
        options.requests.map((request) =>
          read(gate, { ...request, changelogTable: options.changelogTable })
        )
      )) as { changes: unknown[]; cursor: { xmax: bigint; xip: bigint[] } }[];
      return { changes: results.map((result) => result.changes), cursor: results[0]?.cursor };
    }
  );
  return { read, batch };
});
vi.mock('@/dbGate/LilypadChangelog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/dbGate/LilypadChangelog')>()),
  readLilypadChanges: changelog.read,
  readLilypadChangesBatch: changelog.batch,
}));

/** The rows of a `getAll`, which returns them keyed by primary key. */
const rowsOf = async <T>(rows: Promise<Map<unknown, T>>): Promise<T[]> => [
  ...(await rows).values(),
];

/** The cursor of a read that saw every transaction below `xmax`. */
const at = (xmax: bigint, xip: bigint[] = []) => ({ xmax, xip });

/** The options of `selectByPrimaryKeys`: the signal of the timeout of the query. */
const withSignal = { signal: expect.any(AbortSignal) as unknown };

type Item = { id: string; name: string };

const itemsInput = defineLilypadTable<Item, 'id'>({
  tableName: 'items',
  primaryKey: 'id',
  cols: { id: { type: 'string' }, name: { type: 'string' } },
});

/** A config with the `items` table, with this sync and these changes of its description. */
function itemsDb(
  sync?: LilypadDbTableSync,
  changes: Partial<typeof itemsInput> = {},
  config: Omit<LilypadDbConfigInput<Record<string, LilypadDbTableInputBase>>, 'tables'> = {}
) {
  return defineLilypadDb({
    ...config,
    tables: { items: defineLilypadTable<Item, 'id'>({ ...itemsInput, ...changes, sync }) },
  });
}

/** The `items` table of {@link itemsDb}. */
const itemsTable = (...args: Parameters<typeof itemsDb>) => itemsDb(...args).tables.items;

/**
 * An in-memory stand-in for LilypadDbGate: the cache only uses these methods.
 */
function createFakeGate(initialRows: Item[] = []) {
  const rows = new Map(initialRows.map((row) => [row.id, row]));
  const listeners = new Map<string, LilypadDbListener>();
  let generatedIds = 0;
  let lastXid = 1000n;

  // The CRUD methods of the table handle (gate.table(schema)) and the listener methods of the gate
  const mocks = {
    selectAll: vi.fn(async () => [...rows.values()]),
    selectByPrimaryKey: vi.fn(async (key: string) => rows.get(String(key)) ?? null),
    selectByPrimaryKeys: vi.fn(async (keys: string[]) =>
      keys.flatMap((key) => rows.get(String(key)) ?? [])
    ),
    insert: vi.fn(async (item: Partial<Item>) => {
      const row = { ...item, id: item.id ?? `generated-${++generatedIds}` } as Item;
      rows.set(row.id, row);
      return { row, xid: ++lastXid };
    }),
    update: vi.fn(async (item: Item) => {
      rows.set(item.id, item);
      return { row: item, xid: ++lastXid };
    }),
    delete: vi.fn(async (key: string) => {
      const deleted = rows.delete(key);
      return { deleted, xid: ++lastXid };
    }),
    addListener: vi.fn(async (listener: LilypadDbListener) => {
      listeners.set(listener.callbackId, listener);
    }),
    removeListener: vi.fn(async (_channel: string, callbackId: string) =>
      listeners.delete(callbackId)
    ),
    isListenHealthy: vi.fn(() => listeners.size > 0),
  };

  /** Delivers a notification to every registered listener, as LilypadDbGate would. */
  const notify = async (payload: unknown) => {
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
    for (const listener of listeners.values()) {
      await listener.callback(raw);
    }
  };

  const gate = {
    addListener: mocks.addListener,
    removeListener: mocks.removeListener,
    isListenHealthy: mocks.isListenHealthy,
    table: () => mocks,
  };
  return { gate: gate as unknown as LilypadDbGate, mocks, rows, listeners, notify };
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

  /**
   * A cache of `items`: the `sync` option is the sync of the table in its config, except
   * `onNotification`, an option of the cache.
   */
  const createCache = (options: Record<string, unknown> = {}) => {
    const { sync, ...rest } = options as { sync?: Record<string, unknown> };
    const { onNotification, ...tableSync } = sync ?? {};
    return LilypadDbCache.create({
      ttl: 60000,
      gate: fake.gate,
      table: itemsTable(sync && (tableSync as LilypadDbTableSync)),
      ...(onNotification !== undefined && {
        sync: { onNotification: onNotification as LilypadDbCacheSyncOverrides['onNotification'] },
      }),
      ...rest,
    });
  };

  describe('creation and disposal', () => {
    it('should register the default listener on the cache_events channel', async () => {
      await createCache();

      expect(fake.mocks.addListener).toHaveBeenCalledOnce();
      expect([...fake.listeners.values()][0]!.channel).toBe('cache_events');
    });

    it('should not register a listener when the default listener is disabled', async () => {
      await createCache({ sync: { strategy: 'none' } });

      expect(fake.mocks.addListener).not.toHaveBeenCalled();
    });

    it('should reject when the default listener cannot be registered', async () => {
      fake.mocks.addListener.mockRejectedValueOnce(new Error('database unreachable'));

      await expect(createCache()).rejects.toThrow('database unreachable');
    });

    it('should share one listener among the caches of a gate, and parse each notification once', async () => {
      const first = await createCache();
      const second = await createCache();
      const parse = vi.spyOn(JSON, 'parse');
      await first.getOrFetch('1');
      await second.getOrFetch('1');
      fake.rows.set('1', { id: '1', name: 'ONE' });

      await fake.notify({ table: 'items', id: '1', op: 'UPDATE' });

      expect(fake.listeners.size).toBe(1);
      expect(parse).toHaveBeenCalledOnce();
      expect(first.get('1')).toEqual({ id: '1', name: 'ONE' });
      expect(second.get('1')).toEqual({ id: '1', name: 'ONE' });
      parse.mockRestore();

      // The listener is removed with the last cache only
      await first.dispose();
      expect(fake.listeners.size).toBe(1);
      await second.dispose();
      expect(fake.listeners.size).toBe(0);
    });

    it('should remove its listener when disposed', async () => {
      const cache = await createCache();

      await cache.dispose();

      expect(fake.mocks.removeListener).toHaveBeenCalledOnce();
      expect(fake.listeners.size).toBe(0);
    });

    it('should return the same singleton until it is disposed', async () => {
      const options = { singleton: 'LilypadDbCache.test-singleton' };
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

      fake.rows.delete('1');
      await fake.notify({ table: 'items', id: '1', op: 'DELETE' });

      expect(cache.get('1')).toBeNull();
    });

    it('should ignore notifications for other tables, without id, or not JSON', async () => {
      await createCache();

      await fake.notify({ table: 'other', id: '1', op: 'UPDATE' });
      await fake.notify({ table: 'items', op: 'UPDATE' });
      await fake.notify('not json');

      expect(fake.mocks.selectByPrimaryKey).not.toHaveBeenCalled();
    });

    it('should leave the cache to onNotification with applyChanges: false', async () => {
      const callback = vi.fn();
      const cache = await createCache({
        sync: { strategy: 'listen', applyChanges: false, onNotification: callback },
      });

      await fake.notify({ table: 'items', id: '1', op: 'UPDATE' });

      expect(callback).toHaveBeenCalledWith({ table: 'items', id: '1', op: 'UPDATE' });
      expect(cache.peek('1').type).toBe('miss');
    });

    it('should update the entry before onNotification by default', async () => {
      let valueSeenByCallback: unknown;
      const cache = await createCache({
        sync: {
          strategy: 'listen',
          onNotification: () => {
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
    it('should not cache as missing the keys of rows whose primary key the select hook changed', async () => {
      const logger = { warn: vi.fn() };
      const cache = await createCache({ logger });
      fake.mocks.selectByPrimaryKeys.mockResolvedValueOnce([{ id: 'renamed-1', name: 'one' }]);

      expect(await rowsOf(cache.getManyOrFetch(['1']))).toEqual([]);

      // Not `null`: the row of the key exists
      expect(cache.peek('1').type).toBe('miss');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('the keys without a row are expired, not cached as missing'),
        expect.anything()
      );
    });

    it('should expire a notified row whose primary key the select hook changed', async () => {
      const cache = await createCache({ logger: { warn: vi.fn() } });
      await cache.getOrFetch('1');
      fake.mocks.selectByPrimaryKeys.mockResolvedValueOnce([{ id: 'renamed-1', name: 'ONE' }]);

      await fake.notify({ table: 'items', id: '1', op: 'UPDATE' });

      // Not kept fresh with the row read before the change
      expect(cache.peek('1').type).toBe('expired');
    });

    it('should leave out the rows loaded without a primary key', async () => {
      const logger = { warn: vi.fn() };
      const cache = await createCache({ logger });
      fake.mocks.selectAll.mockResolvedValueOnce([
        { id: '1', name: 'one' },
        { name: 'no key' } as Item,
      ]);

      expect(await rowsOf(cache.getAll())).toEqual([{ id: '1', name: 'one' }]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('1 rows loaded have no primary key'),
        expect.anything()
      );
    });

    it('should return all rows, excluding the deleted ones', async () => {
      const cache = await createCache();
      await cache.getAll();
      fake.rows.delete('2');
      await fake.notify({ table: 'items', id: '2', op: 'DELETE' });

      const items = await rowsOf(cache.getAll());

      expect(items).toEqual([{ id: '1', name: 'one' }]);
    });

    it('should share one query between concurrent getOrFetch calls', async () => {
      const cache = await createCache();

      const [first, second] = await Promise.all([cache.getOrFetch('1'), cache.getOrFetch('1')]);

      expect(first).toEqual({ id: '1', name: 'one' });
      expect(second).toBe(first);
      expect(fake.mocks.selectByPrimaryKey).toHaveBeenCalledOnce();
    });

    it('should cache a missing row as null', async () => {
      const cache = await createCache();

      expect(await cache.getOrFetch('missing')).toBeNull();
      expect(await cache.getOrFetch('missing')).toBeNull();
      expect(fake.mocks.selectByPrimaryKey).toHaveBeenCalledOnce();
    });

    it('should reject when the fetch fails', async () => {
      const cache = await createCache();
      fake.mocks.selectByPrimaryKey.mockRejectedValueOnce(new Error('query failed'));

      await expect(cache.getOrFetch('1')).rejects.toThrow('query failed');
    });

    it('should return the fallback of onError when the fetch fails', async () => {
      const cache = await createCache();
      fake.mocks.selectByPrimaryKey.mockRejectedValueOnce(new Error('query failed'));

      const result = await cache.getOrFetchDetailed('1', { onError: { fallback: () => null } });

      expect(result).toEqual({ value: null, status: 'MISS', refreshFailed: true });
    });

    it('should expire the entry on invalidate, without a query', async () => {
      const cache = await createCache();
      await cache.getOrFetch('1');

      cache.invalidate('1');

      expect(cache.peek('1').type).toBe('expired');
      expect(fake.mocks.selectByPrimaryKey).toHaveBeenCalledOnce();
    });

    it('should re-fetch the key on refresh, and reject when the query fails', async () => {
      const cache = await createCache();
      await cache.getOrFetch('1');
      fake.rows.set('1', { id: '1', name: 'ONE' });

      await expect(cache.refresh('1')).resolves.toEqual({ id: '1', name: 'ONE' });
      expect(cache.get('1')).toEqual({ id: '1', name: 'ONE' });

      fake.mocks.selectByPrimaryKey.mockRejectedValueOnce(new Error('query failed'));
      await expect(cache.refresh('1')).rejects.toThrow('query failed');
    });
  });

  describe('writes', () => {
    it('should cache a created row under the primary key generated by the database', async () => {
      const cache = await createCache();

      const created = await cache.sqlCreate({ name: 'new' });

      expect(created).toEqual({ id: 'generated-1', name: 'new' });
      expect(cache.get('generated-1')).toEqual(created);
    });

    it('should write updates even when the cached item looks identical', async () => {
      const cache = await createCache();
      await cache.getOrFetch('1');

      await cache.sqlUpdate({ id: '1', name: 'one' });

      expect(fake.mocks.update).toHaveBeenCalledOnce();
    });

    it('should cache the row returned by the database after an update', async () => {
      const cache = await createCache();
      fake.mocks.update.mockResolvedValueOnce({
        row: { id: '1', name: 'sanitized' },
        xid: 1n,
      });

      await cache.sqlUpdate({ id: '1', name: 'raw' });

      expect(cache.get('1')).toEqual({ id: '1', name: 'sanitized' });
    });

    it('should cache a deleted row as null', async () => {
      const cache = await createCache();
      await cache.getOrFetch('1');

      await expect(cache.sqlDelete('1')).resolves.toBe(true);

      expect(fake.mocks.delete).toHaveBeenCalledWith('1');
      expect(cache.get('1')).toBeNull();
      await expect(cache.sqlDelete('1')).resolves.toBe(false);
    });

    it('should return, without caching it, a created row that has no primary key', async () => {
      const logger = { warn: vi.fn() };
      const cache = await createCache({ logger });
      fake.mocks.insert.mockResolvedValueOnce({
        row: { name: 'no key' } as Item,
        xid: 1n,
      });

      await expect(cache.sqlCreate({ name: 'no key' })).resolves.toEqual({
        name: 'no key',
      });

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('has no primary key "id"'), {
        source: 'items',
      });
      expect(cache['engine'].entries().size).toBe(0);
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

      expect(fake.mocks.selectByPrimaryKey).not.toHaveBeenCalled();
      expect(await rowsOf(cache.getAll())).toContainEqual({ id: '3', name: 'three' });
      expect(fake.mocks.selectAll).toHaveBeenCalledTimes(2);
    });

    it('should refresh a key whose fetch is in flight', async () => {
      const cache = await createCache();
      const staleRead = deferred<Item | null>();
      fake.mocks.selectByPrimaryKey.mockReturnValueOnce(staleRead.promise);
      const fetching = cache.getOrFetch('1');

      fake.rows.set('1', { id: '1', name: 'ONE' });
      await fake.notify({ table: 'items', id: '1', op: 'UPDATE' });
      staleRead.resolve({ id: '1', name: 'one' }); // read before the update
      await fetching;

      expect(cache.get('1')).toEqual({ id: '1', name: 'ONE' });
    });

    it('should re-read the keys notified together in one query', async () => {
      const cache = await createCache();
      await cache.getOrFetch('1');
      await cache.getOrFetch('2');
      fake.rows.set('1', { id: '1', name: 'ONE' });
      fake.rows.set('2', { id: '2', name: 'TWO' });

      await Promise.all([
        fake.notify({ table: 'items', id: '1', op: 'UPDATE' }),
        fake.notify({ table: 'items', id: '2', op: 'UPDATE' }),
        fake.notify({ table: 'items', id: '1', op: 'UPDATE' }),
      ]);

      expect(fake.mocks.selectByPrimaryKeys).toHaveBeenCalledExactlyOnceWith(
        ['1', '2'],
        withSignal
      );
      // Only the reads of getOrFetch
      expect(fake.mocks.selectByPrimaryKey).toHaveBeenCalledTimes(2);
      expect(cache.get('1')).toEqual({ id: '1', name: 'ONE' });
      expect(cache.get('2')).toEqual({ id: '2', name: 'TWO' });
    });

    it('should read again a key notified while the query of its batch runs', async () => {
      const cache = await createCache();
      await cache.getOrFetch('1');
      const firstRead = deferred<Item[]>();
      fake.mocks.selectByPrimaryKeys.mockReturnValueOnce(firstRead.promise);

      const first = fake.notify({ table: 'items', id: '1', op: 'UPDATE' });
      await vi.waitFor(() => expect(fake.mocks.selectByPrimaryKeys).toHaveBeenCalledOnce());
      fake.rows.set('1', { id: '1', name: 'second' });
      const second = fake.notify({ table: 'items', id: '1', op: 'UPDATE' });
      await vi.waitFor(() => expect(fake.mocks.selectByPrimaryKeys).toHaveBeenCalledTimes(2));
      // The first query read the row before the second change
      firstRead.resolve([{ id: '1', name: 'first' }]);
      await Promise.all([first, second]);

      expect(cache.get('1')).toEqual({ id: '1', name: 'second' });
    });

    it('should expire the keys of a batch whose query fails', async () => {
      const logger = { error: vi.fn() };
      const cache = await createCache({ logger });
      await cache.getOrFetch('1');
      fake.mocks.selectByPrimaryKeys.mockRejectedValueOnce(new Error('db down'));

      await fake.notify({ table: 'items', id: '1', op: 'UPDATE' });

      expect(cache.peek('1').type).toBe('expired');
      expect(logger.error).toHaveBeenCalledOnce();
    });

    it('should reflect a deleted row even for a protected key', async () => {
      const cache = await createCache();
      await cache.getOrFetch('1');
      await cache.getOrFetch('2');
      cache.addProtectedKeys(['1', '2']);

      fake.rows.delete('1');
      await fake.notify({ table: 'items', id: '1', op: 'DELETE' });
      await cache.sqlDelete('2');

      expect(cache.get('1')).toBeNull();
      expect(cache.get('2')).toBeNull();
    });

    it('should expire every entry and force a bulk sync when LISTEN reconnects', async () => {
      const cache = await createCache();
      await cache.getAll();
      const listener = [...fake.listeners.values()][0]!;

      await listener.onReconnect?.();

      expect(cache.peek('1').type).toBe('expired');
      await cache.getAll();
      expect(fake.mocks.selectAll).toHaveBeenCalledTimes(2);
    });

    it('should load the table again after a LISTEN reconnection, even when it was empty', async () => {
      fake.rows.clear();
      const cache = await createCache();
      expect(await rowsOf(cache.getAll())).toEqual([]);
      // Inserted while LISTEN was down: its notification is lost
      fake.rows.set('3', { id: '3', name: 'three' });

      await [...fake.listeners.values()][0]!.onReconnect?.();

      expect(await rowsOf(cache.getAll())).toEqual([{ id: '3', name: 'three' }]);
    });

    it('should not adopt a shared copy produced before a LISTEN reconnection', async () => {
      const shared = new Map<string, unknown>();
      const store = {
        get: async (key: string) => structuredClone(shared.get(key) ?? null),
        set: async (key: string, value: unknown) => void shared.set(key, structuredClone(value)),
        delete: async (key: string) => void shared.delete(key),
      };
      const first = await createCache({ shared: { store } });
      const second = await createCache({ shared: { store } });
      await first.getOrFetch('1');
      await new Promise((resolve) => setTimeout(resolve, 2));
      // Changed while LISTEN was down, for every instance: the shared copy was not removed
      fake.rows.set('1', { id: '1', name: 'ONE' });

      await [...fake.listeners.values()][0]!.onReconnect?.();

      expect(await second.getOrFetch('1')).toEqual({ id: '1', name: 'ONE' });
    });

    it('should send a whole-cache event when LISTEN reconnects', async () => {
      const onInvalidate = vi.fn();
      await createCache({ platform: { onInvalidate } });

      await [...fake.listeners.values()][0]!.onReconnect?.();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(onInvalidate).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ source: 'notification', keys: [], tags: ['lilypad:items'] })
      );
    });

    it('should keep the key type of cached entries for numeric ids', async () => {
      const cache = await createCache();
      await cache.getOrFetch('1');
      fake.rows.set('1', { id: '1', name: 'ONE' });

      await fake.notify({ table: 'items', id: 1, op: 'UPDATE' });

      expect(cache.get('1')).toEqual({ id: '1', name: 'ONE' });
      expect([...cache['engine'].entries().keys()]).toEqual(['1']);
    });

    it('should ignore payloads that are not objects', async () => {
      await createCache();

      await expect(fake.notify('null')).resolves.toBeUndefined();
      await expect(fake.notify('42')).resolves.toBeUndefined();
      expect(fake.mocks.selectByPrimaryKey).not.toHaveBeenCalled();
    });

    it('should keep a row in getAll when its refresh after a notification fails', async () => {
      const cache = await createCache();
      await cache.getAll();
      fake.mocks.selectByPrimaryKey.mockRejectedValueOnce(new Error('query failed'));

      await fake.notify({ table: 'items', id: '1', op: 'UPDATE' });

      expect(await rowsOf(cache.getAll())).toEqual([
        { id: '1', name: 'one' },
        { id: '2', name: 'two' },
      ]);
    });

    it('should reject getAll when the table cannot be loaded', async () => {
      const cache = await createCache();
      fake.mocks.selectAll.mockRejectedValueOnce(new Error('database unreachable'));

      await expect(cache.getAll()).rejects.toThrow('database unreachable');
    });
  });

  describe('typing and singletons', () => {
    it('should require the primary key to update, with a declared primary key', async () => {
      const cache = await LilypadDbCache.create({
        ttl: 60000,
        gate: fake.gate,
        table: itemsTable(),
      });

      await cache.sqlUpdate({ id: '1', name: 'renamed' }); // partial update: no full item needed
      // @ts-expect-error: an update needs the primary key
      await expect(cache.sqlUpdate({ name: 'no id' })).rejects.toThrow(
        'Primary key "id" is missing in the item data for table "items".'
      );
    });

    it('should warn when a singleton is requested with a different TTL', async () => {
      const logger = { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() };
      const options = { singleton: 'LilypadDbCache.test-mismatch' };
      const first = await createCache(options);

      const second = await LilypadDbCache.create({
        ttl: 30000,
        gate: fake.gate,
        table: itemsTable(),
        logger: logger,
        ...options,
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
      changelog.read.mockResolvedValue({ changes: [], cursor: at(100n) });
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
      expect(changelog.read).toHaveBeenCalledExactlyOnceWith(fake.gate, {
        tableName: 'public.items',
        since: { lookback: 120_000 }, // TTL + staleWhileRevalidate + 1 minute
        changelogTable: 'lilypad_cache_changes',
      });

      await cache.getOrFetch('1');

      await vi.advanceTimersByTimeAsync(1000);
      await cache.getOrFetch('1');
      expect(changelog.read).toHaveBeenLastCalledWith(
        fake.gate,
        expect.objectContaining({ since: { cursor: at(100n) } })
      );
    });

    it('should expire the changed keys it holds, so that the next read fetches them', async () => {
      const cache = await createChangelogCache();
      await cache.getOrFetch('1');
      fake.rows.set('1', { id: '1', name: 'ONE' });
      changelog.read.mockResolvedValueOnce({
        changes: [{ id: '5', xid: 100n, rowId: '1', op: 'UPDATE' }],
        cursor: at(101n),
      });

      await vi.advanceTimersByTimeAsync(1000);
      const value = await cache.getOrFetch('1');

      expect(value).toEqual({ id: '1', name: 'ONE' });
      expect(fake.mocks.selectByPrimaryKey).toHaveBeenCalledTimes(2);
    });

    it('should not query the changed rows it does not hold, but reload them with getAll', async () => {
      const cache = await createChangelogCache();
      await cache.getAll();
      fake.rows.set('3', { id: '3', name: 'three' });
      changelog.read.mockResolvedValueOnce({
        changes: [{ id: '6', xid: 100n, rowId: '3', op: 'INSERT' }],
        cursor: at(101n),
      });

      await vi.advanceTimersByTimeAsync(1000);
      const items = await rowsOf(cache.getAll());

      expect(fake.mocks.selectByPrimaryKey).not.toHaveBeenCalled();
      expect(items).toContainEqual({ id: '3', name: 'three' });
    });

    it('should keep every row in getAll after a write read back from the changelog', async () => {
      fake = createFakeGate(['1', '2', '3', '4', '5'].map((id) => ({ id, name: `row ${id}` })));
      const writer = await createChangelogCache();
      const reader = await createChangelogCache();
      expect(await rowsOf(writer.getAll())).toHaveLength(5);
      expect(await rowsOf(reader.getAll())).toHaveLength(5);

      await writer.sqlUpdate({ id: '1', name: 'renamed' });
      changelog.read.mockResolvedValue({
        changes: [{ id: '9', xid: 100n, rowId: '1', op: 'UPDATE' }],
        cursor: at(101n),
      });
      await vi.advanceTimersByTimeAsync(1000);

      for (const cache of [writer, reader]) {
        const items = await rowsOf(cache.getAll());
        expect(items).toHaveLength(5);
        expect(items).toContainEqual({ id: '1', name: 'renamed' });
      }
    });

    it('should keep in getAll a row changed while the table is loading', async () => {
      const cache = await createChangelogCache();
      await cache.getAll();
      // An insert forces the next bulk sync
      fake.rows.set('3', { id: '3', name: 'three' });
      changelog.read.mockResolvedValueOnce({
        changes: [{ id: '10', xid: 100n, rowId: '3', op: 'INSERT' }],
        cursor: at(101n),
      });
      let resolveLoad!: (rows: Item[]) => void;
      fake.mocks.selectAll.mockReturnValueOnce(
        new Promise<Item[]>((resolve) => (resolveLoad = resolve))
      );
      await vi.advanceTimersByTimeAsync(1000);
      const loading = cache.getAll();
      await vi.advanceTimersByTimeAsync(0);

      // Row 1 changes while the table is loading: another read applies the change
      const loadedRows = [...fake.rows.values()];
      fake.rows.set('1', { id: '1', name: 'ONE' });
      changelog.read.mockResolvedValueOnce({
        changes: [{ id: '11', xid: 101n, rowId: '1', op: 'UPDATE' }],
        cursor: at(102n),
      });
      await vi.advanceTimersByTimeAsync(1000);
      await cache.getOrFetch('2');
      resolveLoad(loadedRows);

      const items = await rowsOf(loading);
      expect(items).toHaveLength(3);
      expect(items).toContainEqual({ id: '1', name: 'ONE' });
    });

    it('should cache the deleted rows as null', async () => {
      const cache = await createChangelogCache();
      await cache.getOrFetch('1');
      changelog.read.mockResolvedValueOnce({
        changes: [{ id: '7', xid: 100n, rowId: '1', op: 'DELETE' }],
        cursor: at(101n),
      });

      await vi.advanceTimersByTimeAsync(1000);

      expect(await cache.getOrFetch('1')).toBeNull();
    });

    it('should create no entry for the deleted rows it does not hold', async () => {
      const store = {
        get: vi.fn(async () => null),
        set: vi.fn(async () => {}),
        delete: vi.fn(async () => {}),
      };
      const cache = await createChangelogCache({}, { maxEntries: 2, shared: { store } });
      await cache.getOrFetch('1');
      await cache.getOrFetch('2');
      await cache.getAll();
      store.set.mockClear();
      changelog.read.mockResolvedValueOnce({
        changes: Array.from({ length: 50 }, (_, index) => ({
          id: String(index),
          xid: 100n,
          rowId: `gone-${index}`,
          op: 'DELETE',
        })),
        cursor: at(101n),
      });

      await vi.advanceTimersByTimeAsync(1000);
      await cache.getOrFetch('1');

      // The rows it holds are not evicted, and nothing is written to the shared level
      expect(cache.peek('1').type).toBe('hit');
      expect(cache.peek('2').type).toBe('hit');
      expect(cache.peek('gone-0').type).toBe('miss');
      expect(store.set).not.toHaveBeenCalled();
      expect(store.delete).toHaveBeenCalledWith('lilypad:2:items:v:gone-0');
    });

    it('should apply the changes again, after a backoff, when applying them failed', async () => {
      const logger = { error: vi.fn() };
      const cache = await createChangelogCache({}, { logger });
      await cache.getOrFetch('1');
      changelog.read.mockResolvedValue({
        changes: [{ id: '7', xid: 100n, rowId: '1', op: 'UPDATE' }],
        cursor: at(101n),
      });
      const internals = cache['engine'] as unknown as { markInvalid: (key: string) => void };
      const markInvalid = vi.spyOn(internals, 'markInvalid').mockImplementationOnce(() => {
        throw new Error('apply failed');
      });

      await vi.advanceTimersByTimeAsync(1000);
      await cache.getOrFetch('2');
      await cache.getOrFetch('2');
      expect(changelog.read).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledWith('Error applying the changelog:', {
        source: 'items',
        error: expect.any(Error),
      });

      await vi.advanceTimersByTimeAsync(1000);
      await cache.getOrFetch('2');
      // Read again from the same cursor: the change is applied this time
      expect(changelog.read).toHaveBeenLastCalledWith(
        fake.gate,
        expect.objectContaining({ since: { cursor: at(100n) } })
      );
      expect(markInvalid).toHaveBeenCalledTimes(2);
      expect(cache.peek('1').type).toBe('expired');
    });

    it('should read again from the transactions still running at the previous read', async () => {
      const cache = await createChangelogCache();
      await cache.getOrFetch('1');
      // Transaction 95 was still running: the next read must include it
      changelog.read.mockResolvedValueOnce({ changes: [], cursor: at(101n, [95n]) });

      await vi.advanceTimersByTimeAsync(1000);
      await cache.getOrFetch('2');
      await vi.advanceTimersByTimeAsync(1000);
      await cache.getOrFetch('2');

      expect(changelog.read).toHaveBeenLastCalledWith(
        fake.gate,
        expect.objectContaining({ since: { cursor: at(101n, [95n]) } })
      );
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
      expect(fake.mocks.selectByPrimaryKey).toHaveBeenCalledTimes(2);
    });

    it('should read on the first read, however soon after the start of the clock', async () => {
      expect(performance.now()).toBeLessThan(1000);
      const cache = await createChangelogCache();

      await cache.getOrFetch('1');

      expect(changelog.read).toHaveBeenCalledOnce();
    });

    it('should keep reading the changelog when the wall clock steps back', async () => {
      const cache = await createChangelogCache();
      await cache.getOrFetch('1');

      vi.setSystemTime(Date.now() - 3_600_000);
      await vi.advanceTimersByTimeAsync(1000);
      await cache.getOrFetch('1');

      expect(changelog.read).toHaveBeenCalledTimes(2);
      expect(changelog.read).toHaveBeenLastCalledWith(
        fake.gate,
        expect.objectContaining({ since: { cursor: at(100n) } })
      );
    });

    it('should stop trusting the cursor after maxGap when the wall clock steps back', async () => {
      // A pollInterval above maxGap, so that only the gap stops the trust
      const cache = await createChangelogCache({ pollInterval: 10_000, maxGap: 5000 });
      await cache.getOrFetch('1');
      const sync = cache['sync'];
      expect(sync.trustedSince()).toBeDefined();

      vi.setSystemTime(Date.now() - 3_600_000);
      await vi.advanceTimersByTimeAsync(6000);
      expect(sync.trustedSince()).toBeUndefined();

      await vi.advanceTimersByTimeAsync(4000);
      await cache.getOrFetch('1');
      expect(changelog.read).toHaveBeenCalledTimes(2);
      expect(changelog.read).toHaveBeenLastCalledWith(
        fake.gate,
        expect.objectContaining({ since: { lookback: 120_000 } })
      );
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
      expect(logger.error).toHaveBeenCalledWith('Error reading the changelog:', {
        source: cache.name,
        error: expect.any(Error),
      });
    });

    it('should wait for a stuck changelog read at most fetchTimeout, and apply it once it completes', async () => {
      const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
      const cache = await createChangelogCache({}, { logger, fetchTimeout: 2000 });
      await cache.getOrFetch('1');
      fake.rows.set('1', { id: '1', name: 'ONE' });
      // The next read hangs until released (a lock on the changelog, a full pool, a dead connection)
      let release!: (result: unknown) => void;
      changelog.read.mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve;
        })
      );
      await vi.advanceTimersByTimeAsync(1000);

      // eslint-disable-next-line vitest/valid-expect -- awaited once the fake timers have advanced
      const assertion = expect(cache.getOrFetch('1')).resolves.toEqual({ id: '1', name: 'one' });
      await vi.advanceTimersByTimeAsync(2000);
      await assertion;
      expect(logger.error).toHaveBeenCalledWith('Error reading the changelog:', {
        source: cache.name,
        error: expect.any(LilypadTimeoutError),
      });

      // Within the backoff, a read does not wait for the stuck one
      await expect(cache.getOrFetch('1')).resolves.toEqual({ id: '1', name: 'one' });
      expect(changelog.read).toHaveBeenCalledTimes(2);

      // The stuck read completes: its changes are applied
      release({ changes: [{ id: '5', xid: 100n, rowId: '1', op: 'UPDATE' }], cursor: at(101n) });
      await vi.advanceTimersByTimeAsync(0);
      expect(cache.get('1')).toBeUndefined();
      await expect(cache.getOrFetch('1')).resolves.toEqual({ id: '1', name: 'ONE' });
    });
  });

  describe('database traffic', () => {
    /** Enough rows that a few changed ones are fetched by key instead of reloading the table. */
    const manyRows = (count: number): Item[] =>
      Array.from({ length: count }, (_, index) => ({
        id: String(index + 1),
        name: `row ${index + 1}`,
      }));
    const createChangelogCache = (
      sync: Record<string, unknown> = {},
      options: Record<string, unknown> = {}
    ) => createCache({ sync: { strategy: 'changelog', pollInterval: 1000, ...sync }, ...options });
    const noChanges = { changes: [], cursor: at(100n) };
    /** How many rows each kind of query has read. */
    const queries = () => ({
      table: fake.mocks.selectAll.mock.calls.length,
      byKey: fake.mocks.selectByPrimaryKey.mock.calls.length,
      byKeys: fake.mocks.selectByPrimaryKeys.mock.calls.map(([keys]) => keys),
    });

    beforeEach(() => {
      vi.useFakeTimers();
      fake = createFakeGate(manyRows(8));
      changelog.read.mockReset();
      changelog.read.mockResolvedValue(noChanges);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should fetch only the changed row after a write, and nothing on the writing instance', async () => {
      const writer = await createChangelogCache();
      const reader = await createChangelogCache();
      await writer.getAll();
      await reader.getAll();

      await writer.sqlUpdate({ id: '1', name: 'renamed' });
      const { xid } = await fake.mocks.update.mock.results[0]!.value;
      changelog.read.mockResolvedValue({
        changes: [{ id: '9', xid, rowId: '1', op: 'UPDATE' }],
        cursor: at(100n),
      });
      await vi.advanceTimersByTimeAsync(1000);

      for (const cache of [writer, reader]) {
        const items = await rowsOf(cache.getAll());
        expect(items).toHaveLength(8);
        expect(items).toContainEqual({ id: '1', name: 'renamed' });
      }
      expect(queries()).toEqual({ table: 2, byKey: 0, byKeys: [['1']] });
    });

    it('should fetch a row inserted elsewhere without reloading the table', async () => {
      const cache = await createChangelogCache();
      await cache.getAll();
      fake.rows.set('9', { id: '9', name: 'new' });
      changelog.read.mockResolvedValueOnce({
        changes: [{ id: '10', xid: 100n, rowId: '9', op: 'INSERT' }],
        cursor: at(101n),
      });

      await vi.advanceTimersByTimeAsync(1000);
      const items = await rowsOf(cache.getAll());

      expect(items).toHaveLength(9);
      expect(queries()).toEqual({ table: 1, byKey: 0, byKeys: [['9']] });
    });

    it('should keep the rows past their TTL without a query while the sync is trusted', async () => {
      const cache = await createChangelogCache();
      await cache.getAll();

      await vi.advanceTimersByTimeAsync(61_000);

      expect(await rowsOf(cache.getAll())).toHaveLength(8);
      expect(await cache.getOrFetch('1')).toEqual({ id: '1', name: 'row 1' });
      expect(cache.get('2')).toEqual({ id: '2', name: 'row 2' });
      expect(queries()).toEqual({ table: 1, byKey: 0, byKeys: [] });
    });

    it('should query the rows again once they reach maxAge', async () => {
      const cache = await createChangelogCache({ maxAge: 90_000 });
      await cache.getAll();

      await vi.advanceTimersByTimeAsync(61_000);
      await cache.getAll();
      expect(queries().table).toBe(1);

      await vi.advanceTimersByTimeAsync(30_000);
      await cache.getAll();
      expect(queries().table).toBe(2);
    });

    it('should query the rows again after the TTL with the none strategy', async () => {
      const cache = await createCache({ sync: { strategy: 'none' } });
      await cache.getAll();

      await vi.advanceTimersByTimeAsync(61_000);
      await cache.getAll();

      expect(queries().table).toBe(2);
    });

    it('should return a row cached with a shorter TTL, fetching only that row', async () => {
      const cache = await createCache({ sync: { strategy: 'none' } });
      await cache.getAll();
      cache['engine'].set('1', { id: '1', name: 'short-lived' }, 1000);

      await vi.advanceTimersByTimeAsync(2000);
      const items = await rowsOf(cache.getAll());

      expect(items).toHaveLength(8);
      expect(items).toContainEqual({ id: '1', name: 'row 1' });
      expect(queries()).toEqual({ table: 1, byKey: 0, byKeys: [['1']] });
    });

    it('should fetch only the requested keys with getManyOrFetch(keys)', async () => {
      const cache = await createCache({ sync: { strategy: 'none' } });

      expect(await rowsOf(cache.getManyOrFetch(['2', '2', 'missing']))).toEqual([
        { id: '2', name: 'row 2' },
      ]);
      expect(await rowsOf(cache.getManyOrFetch(['2']))).toEqual([{ id: '2', name: 'row 2' }]);
      expect(queries()).toEqual({ table: 0, byKey: 0, byKeys: [['2', 'missing']] });
    });

    it('should take the keys of getManyOrFetch as any iterable, read once', async () => {
      const cache = await createCache({ sync: { strategy: 'none' } });
      function* keys() {
        yield '1';
        yield '2';
      }

      expect(await rowsOf(cache.getManyOrFetch(keys()))).toEqual([
        { id: '1', name: 'row 1' },
        { id: '2', name: 'row 2' },
      ]);
      expect(await rowsOf(cache.getManyOrFetch(new Set(['1', '2'])))).toHaveLength(2);
      expect(queries()).toEqual({ table: 0, byKey: 0, byKeys: [['1', '2']] });
    });

    it('should not keep a shared copy longer than the lookback, whatever the TTL of the read', async () => {
      const store = {
        get: vi.fn(async () => null),
        set: vi.fn(async (_key: string, _value: unknown, _options?: { ttl?: number }) => {}),
        delete: vi.fn(async () => {}),
      };
      const cache = await createChangelogCache({}, { shared: { store } });
      const custom = await createChangelogCache(
        { lookback: 30_000 },
        { shared: { store }, name: 'custom' }
      );

      await cache.getOrFetch('1', { ttl: 24 * 60 * 60 * 1000, staleWhileRevalidate: 60_000 });
      await custom.getOrFetch('1', { ttl: 24 * 60 * 60 * 1000 });
      await vi.advanceTimersByTimeAsync(0);

      // A lookback read removes the shared copies of the changes it reads, within the lookback only
      expect(store.set.mock.calls.map(([key, , options]) => [key, options])).toEqual([
        ['lilypad:2:items:v:1', expect.objectContaining({ ttl: 120 })], // TTL + 1 minute
        ['lilypad:2:custom:v:1', expect.objectContaining({ ttl: 30 })],
      ]);
    });

    it('should not keep past its TTL a row copied from the shared level', async () => {
      const shared = new Map<string, unknown>();
      const store = {
        get: async (key: string) => structuredClone(shared.get(key) ?? null),
        set: async (key: string, value: unknown) => void shared.set(key, structuredClone(value)),
        delete: async (key: string) => void shared.delete(key),
      };
      const first = await createChangelogCache({}, { shared: { store } });
      const second = await createChangelogCache({}, { shared: { store } });
      await first.getOrFetch('1');
      await vi.advanceTimersByTimeAsync(0);

      const fetchOne = () => fake.mocks.selectByPrimaryKey('1');
      expect((await second['engine'].getOrSetDetailed('1', fetchOne)).status).toBe('L2-HIT');
      await vi.advanceTimersByTimeAsync(61_000);
      await second.getOrFetch('1');

      // The copy of the shared level may be older than a change: it is fetched again
      expect(queries().byKey).toBe(2);
    });

    it('should not adopt an older shared copy of a changed row once its row read since is evicted', async () => {
      const shared = new Map<string, unknown>();
      const store = {
        get: async (key: string) => structuredClone(shared.get(key) ?? null),
        set: async (key: string, value: unknown) => void shared.set(key, structuredClone(value)),
        // The removal fails (or another instance writes its old copy again)
        delete: async () => {},
      };
      const cache = await createChangelogCache({}, { shared: { store }, maxEntries: 1 });
      await cache.getOrFetch('1');
      await vi.advanceTimersByTimeAsync(1000);

      fake.rows.set('1', { id: '1', name: 'ONE' });
      changelog.read.mockResolvedValueOnce({
        changes: [{ id: '5', xid: 100n, rowId: '1', op: 'UPDATE' }],
        cursor: at(101n),
      });
      // Applies the change, then reads the row for this instance only (not the shared level)
      expect(await rowsOf(cache.getManyOrFetch(['1']))).toEqual([{ id: '1', name: 'ONE' }]);
      await cache.getManyOrFetch(['2']); // evicts '1'

      // The entry read after the change carried its mark: the copy read before it is refused
      expect(await cache.getOrFetch('1')).toEqual({ id: '1', name: 'ONE' });
      expect(queries().byKey).toBe(2);
    });

    describe('TRUNCATE', () => {
      it('should empty the table read from the changelog without reloading it', async () => {
        const onInvalidate = vi.fn();
        const cache = await createChangelogCache({}, { platform: { onInvalidate } });
        await cache.getAll();
        fake.rows.clear();
        changelog.read.mockResolvedValueOnce({
          changes: [{ id: '11', xid: 100n, rowId: null, op: 'TRUNCATE' }],
          cursor: at(101n),
        });

        await vi.advanceTimersByTimeAsync(1000);

        expect(await rowsOf(cache.getAll())).toEqual([]);
        expect(await cache.getOrFetch('1')).toBeNull();
        expect(queries()).toEqual({ table: 1, byKey: 1, byKeys: [] });
        await vi.advanceTimersByTimeAsync(0);
        expect(onInvalidate).toHaveBeenCalledWith(
          expect.objectContaining({
            source: 'changelog',
            tags: expect.arrayContaining(['lilypad:items']),
          })
        );
      });

      it('should apply the inserts that follow a TRUNCATE', async () => {
        const cache = await createChangelogCache();
        await cache.getAll();
        fake.rows.clear();
        fake.rows.set('20', { id: '20', name: 'after' });
        changelog.read.mockResolvedValueOnce({
          changes: [
            { id: '11', xid: 100n, rowId: null, op: 'TRUNCATE' },
            { id: '12', xid: 101n, rowId: '20', op: 'INSERT' },
          ],
          cursor: at(102n),
        });

        await vi.advanceTimersByTimeAsync(1000);

        expect(await rowsOf(cache.getAll())).toEqual([{ id: '20', name: 'after' }]);
      });

      it('should apply a TRUNCATE notification', async () => {
        const cache = await createCache();
        await cache.getAll();
        fake.rows.clear();

        await fake.notify({ schema: 'public', table: 'items', op: 'TRUNCATE' });

        expect(cache.get('1')).toBeUndefined();
        expect(await rowsOf(cache.getAll())).toEqual([]);
      });

      it('should not cache a row read before a TRUNCATE', async () => {
        const cache = await createCache();
        let resolveRead!: (row: Item | null) => void;
        fake.mocks.selectByPrimaryKey.mockReturnValueOnce(
          new Promise<Item | null>((resolve) => (resolveRead = resolve))
        );
        const fetching = cache.getOrFetch('1');

        await fake.notify({ table: 'items', op: 'TRUNCATE' });
        resolveRead({ id: '1', name: 'row 1' });
        await fetching;

        expect(cache.get('1')).toBeUndefined();
      });
    });

    describe('writes of this instance', () => {
      it('should not fetch again a row it wrote when its notification arrives', async () => {
        const cache = await createCache();
        await cache.sqlUpdate({ id: '1', name: 'renamed' });
        const { xid } = await fake.mocks.update.mock.results[0]!.value;

        await fake.notify({ table: 'items', id: '1', op: 'UPDATE', xid: String(xid) });

        expect(queries().byKey).toBe(0);
        expect(cache.get('1')).toEqual({ id: '1', name: 'renamed' });
      });

      it('should skip the changes of several writes of the same row', async () => {
        const cache = await createChangelogCache();
        await cache.getAll();
        await cache.sqlCreate({ id: '9', name: 'new' });
        await cache.sqlUpdate({ id: '9', name: 'renamed' });
        const [created, updated] = await Promise.all([
          fake.mocks.insert.mock.results[0]!.value,
          fake.mocks.update.mock.results[0]!.value,
        ]);
        changelog.read.mockResolvedValueOnce({
          changes: [
            { id: '20', xid: created.xid, rowId: '9', op: 'INSERT' },
            { id: '21', xid: updated.xid, rowId: '9', op: 'UPDATE' },
          ],
          cursor: at(100n),
        });

        await vi.advanceTimersByTimeAsync(1000);

        expect(await rowsOf(cache.getAll())).toContainEqual({ id: '9', name: 'renamed' });
        expect(queries()).toEqual({ table: 1, byKey: 0, byKeys: [] });
      });

      it('should fetch the row when the change is not the one of its write', async () => {
        const cache = await createCache();
        await cache.sqlUpdate({ id: '1', name: 'renamed' });
        fake.rows.set('1', { id: '1', name: 'changed elsewhere' });

        await fake.notify({ table: 'items', id: '1', op: 'UPDATE', xid: '1' });

        expect(cache.get('1')).toEqual({ id: '1', name: 'changed elsewhere' });
      });

      it('should not cache a written row when the entry changed during the write', async () => {
        const cache = await createCache({ sync: { strategy: 'none' } });
        let resolveWrite!: (result: { row: Item; xid: bigint }) => void;
        fake.mocks.update.mockReturnValueOnce(new Promise((resolve) => (resolveWrite = resolve)));
        const writing = cache.sqlUpdate({ id: '1', name: 'renamed' });

        // A read during the write may see the row before or after it
        await cache.getOrFetch('1');
        resolveWrite({ row: { id: '1', name: 'renamed' }, xid: 5n });
        await writing;

        expect(cache.get('1')).toBeUndefined();
        expect(await cache.getOrFetch('1')).toEqual({ id: '1', name: 'row 1' });
      });

      it('should not let a read started before the write overwrite it', async () => {
        const cache = await createCache({ sync: { strategy: 'none' } });
        let resolveRead!: (row: Item | null) => void;
        fake.mocks.selectByPrimaryKey.mockReturnValueOnce(
          new Promise<Item | null>((resolve) => (resolveRead = resolve))
        );
        const fetching = cache.getOrFetch('1');

        await cache.sqlUpdate({ id: '1', name: 'renamed' });
        resolveRead({ id: '1', name: 'row 1' });
        await fetching;

        expect(cache.get('1')).toEqual({ id: '1', name: 'renamed' });
      });
    });
  });

  describe('config', () => {
    beforeEach(() => {
      changelog.read.mockReset();
      changelog.read.mockResolvedValue({ changes: [], cursor: at(100n) });
    });

    it('should find a table by name in the config given, or in the config of the gate', async () => {
      const db = itemsDb({ strategy: 'none' });
      const gate = Object.assign(Object.create(fake.gate) as LilypadDbGate, { config: db });

      const fromConfig = await LilypadDbCache.create({
        gate: fake.gate,
        config: db,
        table: 'items',
      });
      const fromGate = await LilypadDbCache.create({
        gate: gate as LilypadDbGate<typeof db>,
        table: 'items',
      });

      expect(await fromConfig.getOrFetch('1')).toEqual({ id: '1', name: 'one' });
      expect(await fromGate.getOrFetch('2')).toEqual({ id: '2', name: 'two' });
      const typeChecks = () => {
        // @ts-expect-error: not a table of the config
        void LilypadDbCache.create({ gate: fake.gate, config: db, table: 'missing' });
      };
      expect(typeChecks).toBeTypeOf('function');
    });

    it('should reject a table that is not in the config, or given by name without one', async () => {
      const db = itemsDb();

      await expect(
        // @ts-expect-error: not a table of the config
        LilypadDbCache.create({ gate: fake.gate, config: db, table: 'missing' })
      ).rejects.toThrow('the config "default" has no table "missing"');
      await expect(
        LilypadDbCache.create({ gate: fake.gate, table: 'items' as never })
      ).rejects.toThrow('there is no config to find it in');
      await expect(
        LilypadDbCache.create({ gate: fake.gate, table: itemsInput as never })
      ).rejects.toThrow('must be a table of a config made with defineLilypadDb');
    });

    it('should not check the database: the fake gate cannot run the queries of a check', async () => {
      // The fake gate has no `sql`: a query of the catalogs would reject
      const cache = await createCache({ sync: { strategy: 'changelog', pollInterval: 0 } });
      const listening = await createCache({ name: 'items-2' });

      expect(await cache.getOrFetch('1')).toEqual({ id: '1', name: 'one' });
      expect(await listening.getOrFetch('1')).toEqual({ id: '1', name: 'one' });
      expect(fake.gate).not.toHaveProperty('sql');
    });

    it('should listen on the notification channel of the config', async () => {
      await LilypadDbCache.create({
        ttl: 60000,
        gate: fake.gate,
        table: itemsTable(undefined, {}, { notifyChannel: 'app_events' }),
      });

      expect([...fake.listeners.values()][0]!.channel).toBe('app_events');
    });

    it('should read the changelog table of the config', async () => {
      const cache = await LilypadDbCache.create({
        ttl: 60000,
        gate: fake.gate,
        table: itemsTable(
          { strategy: 'changelog', pollInterval: 0 },
          {},
          { changelog: { table: 'my_changes' } }
        ),
      });

      await cache.getOrFetch('1');

      expect(changelog.read).toHaveBeenCalledWith(
        fake.gate,
        expect.objectContaining({ tableName: 'public.items', changelogTable: 'my_changes' })
      );
    });

    it('should let the options of the cache change the sync of the table', async () => {
      const cache = await LilypadDbCache.create({
        ttl: 60000,
        gate: fake.gate,
        table: itemsTable({ strategy: 'listen' }),
        sync: { connect: 'lazy' },
      });
      expect(fake.mocks.addListener).not.toHaveBeenCalled();

      await cache.getOrFetch('1');

      expect(fake.mocks.addListener).toHaveBeenCalledOnce();
    });

    it('should ignore the notifications of a table of the same name in another schema', async () => {
      const cache = await createCache();
      await cache.getOrFetch('1');

      await fake.notify({ schema: 'archive', table: 'items', id: '1', op: 'DELETE' });
      expect(cache.get('1')).toEqual({ id: '1', name: 'one' });

      fake.rows.delete('1');
      await fake.notify({ schema: 'public', table: 'items', id: '1', op: 'DELETE' });
      expect(cache.get('1')).toBeNull();
    });

    it('should apply notifications without a schema to the table in any schema', async () => {
      const cache = await createCache();
      await cache.getOrFetch('1');

      fake.rows.delete('1');
      await fake.notify({ table: 'items', id: '1', op: 'DELETE' });

      expect(cache.get('1')).toBeNull();
    });

    it.each([
      ['a qualified table name', itemsTable(undefined, { tableName: 'app.items' })],
      ['schemaName', itemsTable(undefined, { schemaName: 'app' })],
      ['the default schema of the config', itemsTable(undefined, {}, { defaultSchema: 'app' })],
    ])('should take the schema of the table from %s', async (_case, table) => {
      const cache = await LilypadDbCache.create({ ttl: 60000, gate: fake.gate, table });
      await cache.getOrFetch('1');

      await fake.notify({ schema: 'public', table: 'items', id: '1', op: 'DELETE' });
      expect(cache.get('1')).toEqual({ id: '1', name: 'one' });

      fake.rows.delete('1');
      await fake.notify({ schema: 'app', table: 'items', id: '1', op: 'DELETE' });
      expect(cache.get('1')).toBeNull();
    });

    it('should read the changelog of the qualified table name', async () => {
      const cache = await LilypadDbCache.create({
        ttl: 60000,
        gate: fake.gate,
        table: itemsTable({ strategy: 'changelog', pollInterval: 0 }, { tableName: 'app.items' }),
      });

      await cache.getOrFetch('1');

      expect(changelog.read).toHaveBeenCalledWith(
        fake.gate,
        expect.objectContaining({ tableName: 'app.items' })
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

    it('should retry a failed lazy LISTEN after a backoff, not at every read', async () => {
      vi.useFakeTimers();
      try {
        const cache = await createCache({ sync: { strategy: 'listen', connect: 'lazy' } });
        fake.mocks.addListener.mockRejectedValueOnce(new Error('database unreachable'));

        await cache.getOrFetch('1');
        await cache.getOrFetch('2');
        expect(fake.mocks.addListener).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1000);
        await cache.getOrFetch('2');
        expect(fake.mocks.addListener).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
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

  describe('getAll with maxEntries', () => {
    it('should return every row even when the table does not fit in the cache', async () => {
      fake = createFakeGate(
        Array.from({ length: 10 }, (_, index) => ({ id: String(index), name: `n${index}` }))
      );
      const cache = await createCache({ sync: { strategy: 'none' }, maxEntries: 4 });

      const first = await cache.getAll();
      const second = await cache.getAll();

      expect(first.size).toBe(10);
      expect([...second.keys()].sort()).toEqual([...first.keys()].sort());
    });
  });

  it('should stop the batches of getManyOrFetch once it times out', async () => {
    vi.useFakeTimers();
    try {
      const cache = await createCache({ bulkSync: { timeout: 1000 } });
      // A query that never answers
      fake.mocks.selectByPrimaryKeys.mockReturnValueOnce(new Promise<Item[]>(() => {}));

      const reading = cache.getManyOrFetch(['1']);
      // eslint-disable-next-line vitest/valid-expect -- awaited once the fake timers have advanced
      const assertion = expect(reading).rejects.toBeInstanceOf(LilypadTimeoutError);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;

      const [, options] = fake.mocks.selectByPrimaryKeys.mock.calls[0] as unknown as [
        string[],
        { signal: AbortSignal },
      ];
      expect(options.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('getManyOrFetch in parallel', () => {
    it('should not mix up key sets that join to the same string', async () => {
      fake = createFakeGate([
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
        { id: 'a,b', name: 'AB' },
      ]);
      const cache = await createCache({ sync: { strategy: 'none' } });

      const [joined, separate] = await Promise.all([
        cache.getManyOrFetch(['a,b']),
        cache.getManyOrFetch(['a', 'b']),
      ]);

      expect([...joined.keys()]).toEqual(['a,b']);
      expect([...separate.keys()]).toEqual(['a', 'b']);
    });

    it('should share the query of a key already being fetched', async () => {
      const cache = await createCache({ sync: { strategy: 'none' } });

      await Promise.all([cache.getManyOrFetch(['1', '2']), cache.getManyOrFetch(['2'])]);

      expect(fake.mocks.selectByPrimaryKeys).toHaveBeenCalledOnce();
    });
  });

  describe('changelog failures and reads in flight', () => {
    const createChangelogCache = (sync: Record<string, unknown> = {}) =>
      createCache({ sync: { strategy: 'changelog', pollInterval: 1000, ...sync } });

    beforeEach(() => {
      vi.useFakeTimers();
      changelog.read.mockReset();
      changelog.read.mockResolvedValue({ changes: [], cursor: at(100n) });
      changelog.batch.mockClear();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should back off after a failed read instead of retrying at every read', async () => {
      changelog.read.mockRejectedValue(new Error('no changelog table'));
      const cache = await createChangelogCache();

      await cache.getOrFetch('1');
      await vi.advanceTimersByTimeAsync(1000);
      await cache.getOrFetch('1');
      expect(changelog.read).toHaveBeenCalledTimes(2);

      // Second failure: the next attempt waits 2 s
      await vi.advanceTimersByTimeAsync(1000);
      await cache.getOrFetch('1');
      expect(changelog.read).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1000);
      await cache.getOrFetch('1');
      expect(changelog.read).toHaveBeenCalledTimes(3);
    });

    it('should discard a read in flight when its row changes, without a query', async () => {
      const cache = await createChangelogCache();
      await cache.getManyOrFetch(['2']); // first read of the changelog
      let release!: (row: Item | null) => void;
      fake.mocks.selectByPrimaryKey.mockReturnValueOnce(
        new Promise((resolve) => (release = resolve))
      );
      const pending = cache.getOrFetch('1');
      changelog.read.mockResolvedValueOnce({
        changes: [{ id: '1', xid: 100n, rowId: '1', op: 'UPDATE' }],
        cursor: at(101n),
      });

      // The changelog read of a later read applies the change while the fetch is in flight
      await vi.advanceTimersByTimeAsync(1000);
      await cache.getManyOrFetch(['2']);
      release({ id: '1', name: 'before the change' });
      await pending;

      expect(cache.peek('1').type).toBe('miss');
      expect(fake.mocks.selectByPrimaryKey).toHaveBeenCalledOnce();
    });

    it('should read the changelog of every cache of the gate in one query', async () => {
      const first = await createChangelogCache();
      const second = await LilypadDbCache.create({
        ttl: 60000,
        name: 'items-2',
        gate: fake.gate,
        table: itemsTable({ strategy: 'changelog', pollInterval: 1000 }),
      });

      await first.getOrFetch('1');
      await second.getOrFetch('1');

      expect(changelog.batch).toHaveBeenCalledOnce();
      expect(changelog.batch.mock.calls[0]![1].requests).toHaveLength(2);
      await second.dispose();
    });
  });

  describe('numeric primary keys', () => {
    type NumericItem = { id: number; name: string };
    const numericInput = defineLilypadTable<NumericItem, 'id'>({
      tableName: 'items',
      primaryKey: 'id',
      cols: { id: { type: 'number' }, name: { type: 'string' } },
    });
    const numericTable = (input: typeof numericInput) =>
      defineLilypadDb({ tables: { items: input } }).tables.items;

    it('should convert the ids of notifications to numbers for a number column', async () => {
      const cache = await LilypadDbCache.create({
        gate: fake.gate,
        table: numericTable(numericInput),
      });
      await cache.getAll();

      await fake.notify({ table: 'items', id: '42', op: 'INSERT' });

      expect(cache['members'].keys()).toContain(42);
      await cache.dispose();
    });

    it('should convert the ids to numbers once it has read numeric keys, without a column type', async () => {
      const numericFake = createFakeGate([{ id: 7, name: 'seven' } as unknown as Item]);
      const cache = await LilypadDbCache.create({
        gate: numericFake.gate,
        table: numericTable({ ...numericInput, cols: { id: {}, name: {} } }),
      });
      await cache.getAll();

      await numericFake.notify({ table: 'items', id: '42', op: 'INSERT' });

      expect(cache['members'].keys()).toContain(42);
      await cache.dispose();
    });

    it('should key the rows of getManyOrFetch as first given, when a key is given twice', async () => {
      const numericFake = createFakeGate();
      numericFake.mocks.selectByPrimaryKeys.mockResolvedValueOnce([
        { id: 7, name: 'seven' } as unknown as Item,
      ]);
      const cache = await LilypadDbCache.create({
        gate: numericFake.gate,
        table: numericTable(numericInput),
      });

      const rows = await cache.getManyOrFetch([7, '7' as unknown as number]);

      expect([...rows.keys()]).toEqual([7]);
      await cache.dispose();
    });
  });

  describe('disposed cache', () => {
    it('should reject reads and writes', async () => {
      const cache = await createCache();
      await cache.dispose();

      await expect(cache.getAll()).rejects.toThrow('is disposed');
      await expect(cache.getOrFetch('1')).rejects.toThrow('is disposed');
      expect(() => cache.get('1')).toThrow('is disposed');
      expect(() => cache.refresh('1')).toThrow('is disposed');
      await expect(cache.sqlCreate({ id: '3', name: 'three' })).rejects.toThrow('is disposed');
      await expect(cache.sqlDelete('1')).rejects.toThrow('is disposed');
      expect(fake.mocks.insert).not.toHaveBeenCalled();
    });

    it('should not cache the result of a write that completes after dispose', async () => {
      const cache = await createCache();
      let finishWrite!: () => void;
      fake.mocks.update.mockImplementationOnce(async (item) => {
        await new Promise<void>((resolve) => (finishWrite = resolve));
        return { row: item, xid: 2000n };
      });
      const writing = cache.sqlUpdate({ id: '1', name: 'renamed' });

      await cache.dispose();
      finishWrite();

      await expect(writing).resolves.toEqual({ id: '1', name: 'renamed' });
      expect(cache['engine'].store.size).toBe(0);
    });

    it('should not run a refresh queued before dispose', async () => {
      const cache = await createCache();
      let finishQuery!: () => void;
      fake.mocks.selectByPrimaryKey.mockImplementationOnce(async (key) => {
        await new Promise<void>((resolve) => (finishQuery = resolve));
        return fake.rows.get(key) ?? null;
      });
      const running = cache.refresh('1');
      const queued = cache.refresh('1');

      await cache.dispose();
      finishQuery();

      await expect(running).resolves.toEqual({ id: '1', name: 'one' });
      await expect(queued).rejects.toThrow('is disposed');
      expect(fake.mocks.selectByPrimaryKey).toHaveBeenCalledOnce();
    });

    it('should remove the listener of a lazy LISTEN still starting when disposed', async () => {
      const cache = await createCache({ sync: { strategy: 'listen', connect: 'lazy' } });
      const reading = cache.getOrFetch('1').catch(() => null);

      await cache.dispose();
      await reading;
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(fake.listeners.size).toBe(0);
    });

    it('should ignore the notifications received after dispose', async () => {
      const cache = await createCache();
      const listener = [...fake.listeners.values()][0]!;
      await cache.dispose();

      await listener.callback(JSON.stringify({ table: 'items', id: '1', op: 'UPDATE' }));

      expect(fake.mocks.selectByPrimaryKey).not.toHaveBeenCalled();
    });
  });

  describe('public API', () => {
    it('should not expose the writes of LilypadCache, whose values would not come from the table', async () => {
      const cache = await createCache();
      const typeChecks = () => {
        // @ts-expect-error a DbCache has no public set
        cache.set('1', { id: '1', name: 'not in the table' });
        // @ts-expect-error a DbCache has no public getOrSet
        void cache.getOrSet('1', async () => null);
        // @ts-expect-error a DbCache has no public bulkSet
        cache.bulkSet([]);
        // @ts-expect-error a DbCache has no public bulkSync
        void cache.bulkSync();
      };

      expect(typeChecks).toBeTypeOf('function');
      expect(cache.name).toBe('items');
    });
  });

  describe('untrusted notifications', () => {
    it('should read the row again on a DELETE notification, instead of trusting it', async () => {
      const cache = await createCache();
      await cache.getOrFetch('1');

      // Anyone can NOTIFY: the row still exists
      await fake.notify({ table: 'items', id: '1', op: 'DELETE' });

      expect(cache.get('1')).toEqual({ id: '1', name: 'one' });
      expect(fake.mocks.selectByPrimaryKeys).toHaveBeenCalledWith(['1'], withSignal);
    });

    it('should not cache anything for a DELETE notification of a key it does not hold', async () => {
      const cache = await createCache();

      await fake.notify({ table: 'items', id: '1', op: 'DELETE' });

      expect(cache.peek('1').type).toBe('miss');
      await expect(cache.getOrFetch('1')).resolves.toEqual({ id: '1', name: 'one' });
    });

    it('should load the table again after a TRUNCATE notification, instead of trusting it', async () => {
      const cache = await createCache();
      await cache.getAll();

      await fake.notify({ table: 'items', op: 'TRUNCATE' });

      await expect(rowsOf(cache.getAll())).resolves.toHaveLength(2);
      expect(fake.mocks.selectAll).toHaveBeenCalledTimes(2);
    });

    it('should not fail getAll for good on a notified id that the database rejects', async () => {
      fake = createFakeGate(
        ['1', '2', '3', '4', '5', '6', '7', '8'].map((id) => ({ id, name: `row ${id}` }))
      );
      const cache = await createCache({ logger: { error: vi.fn() } });
      await cache.getAll();
      // An id no row can have, which the database refuses (e.g. text for an integer key)
      fake.mocks.selectByPrimaryKeys.mockImplementation(async (keys: string[]) => {
        if (keys.includes('not-a-key')) {
          throw new Error('invalid input syntax for type integer: "not-a-key"');
        }
        return keys.flatMap((key) => fake.rows.get(String(key)) ?? []);
      });

      await fake.notify({ table: 'items', id: 'not-a-key', op: 'INSERT' });

      // The fetch of the members fails: the table is loaded instead, which forgets the id
      expect(await rowsOf(cache.getAll())).toHaveLength(8);
      expect(await rowsOf(cache.getAll())).toHaveLength(8);
      expect(fake.mocks.selectAll).toHaveBeenCalledTimes(2);
    });

    it('should ignore notifications with an unknown operation or malformed fields', async () => {
      const logger = { warn: vi.fn() };
      const cache = await createCache({ logger });
      await cache.getOrFetch('1');

      await fake.notify({ table: 'items', id: '1', op: 'MERGE' });
      await fake.notify({ table: 'items', id: '1', op: 'UPDATE', xid: 42 });
      await fake.notify({ table: 'items', id: { nested: true }, op: 'UPDATE' });

      expect(fake.mocks.selectByPrimaryKey).toHaveBeenCalledOnce();
      // One warning a minute at most: anyone can send them
      expect(logger.warn).toHaveBeenCalledOnce();
    });
  });

  describe('trust in LISTEN', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should query a row again after its TTL while the LISTEN heartbeat is missing', async () => {
      const cache = await createCache();
      await cache.getOrFetch('1');
      fake.mocks.isListenHealthy.mockReturnValue(false);

      await vi.advanceTimersByTimeAsync(61_000);
      await cache.getOrFetch('1');

      expect(fake.mocks.selectByPrimaryKey).toHaveBeenCalledTimes(2);
    });

    it('should keep a row past its TTL without a query while the heartbeat is recent', async () => {
      const cache = await createCache();
      await cache.getOrFetch('1');

      await vi.advanceTimersByTimeAsync(61_000);
      await cache.getOrFetch('1');

      expect(fake.mocks.selectByPrimaryKey).toHaveBeenCalledOnce();
    });

    it('should peek a row kept past its TTL as a hit, as get returns it', async () => {
      const cache = await createCache();
      await cache.getOrFetch('1');

      await vi.advanceTimersByTimeAsync(61_000);

      expect(cache.peek('1').type).toBe('hit');
      expect(cache.get('1')).toEqual({ id: '1', name: 'one' });
    });
  });

  describe('own writes and the changelog cursor', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      changelog.read.mockReset();
      changelog.read.mockResolvedValue({ changes: [], cursor: at(100n) });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should still recognize a write whose transaction was running at the previous read', async () => {
      const onInvalidate = vi.fn();
      const cache = await createCache({
        sync: { strategy: 'changelog', pollInterval: 1000 },
        platform: { onInvalidate },
      });
      await cache.getOrFetch('1');
      await cache.sqlUpdate({ id: '1', name: 'renamed' }); // transaction 1001

      // A read that still sees transaction 1001 running, then the read that returns its change
      changelog.read.mockResolvedValueOnce({ changes: [], cursor: at(1002n, [1001n]) });
      await vi.advanceTimersByTimeAsync(1000);
      await cache.getOrFetch('2');
      changelog.read.mockResolvedValueOnce({
        changes: [{ id: '9', xid: 1001n, rowId: '1', op: 'UPDATE' }],
        cursor: at(1003n),
      });
      await vi.advanceTimersByTimeAsync(1000);
      await cache.getOrFetch('2');

      expect(cache.get('1')).toEqual({ id: '1', name: 'renamed' });
      expect(fake.mocks.selectByPrimaryKey).toHaveBeenCalledTimes(2); // '1' and '2' only
    });
  });

  describe('reads after a change', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      changelog.read.mockReset();
      changelog.read.mockResolvedValue({ changes: [], cursor: at(100n) });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should not return a row read before a change applied from the changelog', async () => {
      const cache = await createCache({ sync: { strategy: 'changelog', pollInterval: 1000 } });
      await cache.getOrFetch('2'); // the first read of the changelog
      // A slow read of '1', which sees the row before the change
      let release!: () => void;
      fake.mocks.selectByPrimaryKey.mockImplementationOnce(async (key) => {
        const row = fake.rows.get(String(key)) ?? null;
        await new Promise<void>((resolve) => (release = resolve));
        return row;
      });
      const slow = cache.getOrFetch('1');
      fake.rows.set('1', { id: '1', name: 'changed' });
      changelog.read.mockResolvedValueOnce({
        changes: [{ id: '5', xid: 2000n, rowId: '1', op: 'UPDATE' }],
        cursor: at(2001n),
      });
      await vi.advanceTimersByTimeAsync(1000);

      // This read applies the change first: it must not join the slow read
      const after = cache.getOrFetch('1');
      release();

      await expect(slow).resolves.toEqual({ id: '1', name: 'one' });
      await expect(after).resolves.toEqual({ id: '1', name: 'changed' });
      expect(cache.get('1')).toEqual({ id: '1', name: 'changed' });
    });

    it('should not return the rows of getManyOrFetch read before an invalidation', async () => {
      const cache = await createCache({ sync: { strategy: 'none' } });
      let release!: () => void;
      fake.mocks.selectByPrimaryKeys.mockImplementationOnce(async (keys) => {
        const rows = keys.flatMap((key) => fake.rows.get(String(key)) ?? []);
        await new Promise<void>((resolve) => (release = resolve));
        return rows;
      });
      const slow = cache.getManyOrFetch(['1']);
      fake.rows.set('1', { id: '1', name: 'changed' });
      cache.invalidate('1');

      const after = cache.getManyOrFetch(['1']);
      release();

      expect(await rowsOf(after)).toEqual([{ id: '1', name: 'changed' }]);
      // The slow query is not cached: the fresh entry is the row read after the invalidation
      await slow;
      expect(cache.get('1')).toEqual({ id: '1', name: 'changed' });
      expect(fake.mocks.selectByPrimaryKeys).toHaveBeenCalledTimes(2);
    });

    it('should still share a query of getManyOrFetch when nothing changed', async () => {
      const cache = await createCache({ sync: { strategy: 'none' } });

      await Promise.all([cache.getManyOrFetch(['1']), cache.getManyOrFetch(['1'])]);

      expect(fake.mocks.selectByPrimaryKeys).toHaveBeenCalledOnce();
    });
  });

  describe('large changes', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      changelog.read.mockReset();
      changelog.read.mockResolvedValue({ changes: [], cursor: at(100n) });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** A shared store that counts its operations. */
    const countingStore = () => ({
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    });

    it('should expire the whole table on a BULK notification, with one event', async () => {
      const onInvalidate = vi.fn();
      const cache = await createCache({ platform: { onInvalidate } });
      await cache.getAll();

      await fake.notify({ schema: 'public', table: 'items', op: 'BULK', xid: '5000' });
      await vi.advanceTimersByTimeAsync(0);

      expect(cache.peek('1').type).toBe('expired');
      expect(fake.mocks.selectByPrimaryKeys).not.toHaveBeenCalled();
      expect(onInvalidate).toHaveBeenCalledOnce();
      expect(onInvalidate.mock.calls[0]![0]).toMatchObject({ source: 'notification', keys: [] });
      // The rows of the table are not known any more: the next getAll loads it again
      await cache.getAll();
      expect(fake.mocks.selectAll).toHaveBeenCalledTimes(2);
    });

    it('should expire the table as a whole when a changelog read changes too many keys', async () => {
      const onInvalidate = vi.fn();
      const store = countingStore();
      const cache = await createCache({
        name: 'items',
        shared: { store },
        platform: { onInvalidate },
        sync: { strategy: 'changelog', pollInterval: 1000 },
      });
      await cache.getOrFetch('1');
      store.delete.mockClear();
      changelog.read.mockResolvedValueOnce({
        changes: Array.from({ length: 1001 }, (_, index) => ({
          id: String(index),
          xid: 3000n,
          rowId: `bulk-${index}`,
          op: 'UPDATE',
        })),
        cursor: at(3001n),
      });

      await vi.advanceTimersByTimeAsync(1000);
      await cache.getOrFetch('2');
      await vi.advanceTimersByTimeAsync(0);

      expect(cache.peek('1').type).toBe('expired');
      // No removal from the shared level per key, and one event for the whole cache
      expect(store.delete).not.toHaveBeenCalled();
      const events = onInvalidate.mock.calls.map(([event]) => event as { source: string });
      expect(events.filter((event) => event.source === 'changelog')).toEqual([
        expect.objectContaining({ keys: [] }),
      ]);
    });

    it('should apply only the last change of each row read from the changelog', async () => {
      const onInvalidate = vi.fn();
      const store = countingStore();
      const cache = await createCache({
        name: 'items',
        shared: { store },
        platform: { onInvalidate },
        sync: { strategy: 'changelog', pollInterval: 1000 },
      });
      await cache.getOrFetch('1');
      store.delete.mockClear();
      changelog.read.mockResolvedValueOnce({
        changes: [
          { id: '1', xid: 3000n, rowId: '1', op: 'UPDATE' },
          { id: '2', xid: 3001n, rowId: '9', op: 'UPDATE' },
          { id: '3', xid: 3002n, rowId: '9', op: 'UPDATE' },
          { id: '4', xid: 3003n, rowId: '1', op: 'DELETE' },
        ],
        cursor: at(3004n),
      });

      await vi.advanceTimersByTimeAsync(1000);
      await cache.getOrFetch('2');
      await vi.advanceTimersByTimeAsync(0);

      // '1' is deleted in the end, and the key not held is removed from the shared level once
      expect(cache.peek('1')).toMatchObject({ type: 'hit', value: null });
      expect(store.delete).toHaveBeenCalledTimes(1);
      const event = onInvalidate.mock.calls
        .map(([invalidation]) => invalidation as { source: string; keys: string[] })
        .find((invalidation) => invalidation.source === 'changelog');
      expect(event?.keys).toEqual(['9', '1']);
    });

    it('should only expire the notified keys beyond the eager budget', async () => {
      const ids = Array.from({ length: 1002 }, (_, index) => `n${index}`);
      for (const id of ids) {
        fake.rows.set(id, { id, name: id });
      }
      const cache = await createCache();
      await cache.getAll();

      for (const id of ids) {
        await fake.notify({ table: 'items', id, op: 'UPDATE' });
      }

      // One query per notification up to the budget of the second, then none
      expect(fake.mocks.selectByPrimaryKeys).toHaveBeenCalledTimes(1000);
      expect(cache.peek('n1001').type).toBe('expired');
      expect(cache.peek('n0').type).toBe('hit');
    });

    it('should apply a flood of notifications as one change of the whole table per second', async () => {
      const onInvalidate = vi.fn();
      const store = countingStore();
      const logger = { warn: vi.fn() };
      const cache = await createCache({
        name: 'items',
        shared: { store },
        platform: { onInvalidate },
        logger,
      });
      await cache.getOrFetch('1');
      await vi.advanceTimersByTimeAsync(0);
      store.delete.mockClear();
      // Keys this instance does not hold: each one costs a removal from the shared level and an event
      const flood = (from: number, count: number) =>
        Promise.all(
          Array.from({ length: count }, (_, index) =>
            fake.notify({ table: 'items', id: `forged-${from + index}`, op: 'UPDATE' })
          )
        );

      await flood(0, 2000);
      await vi.advanceTimersByTimeAsync(0);
      expect(store.delete).toHaveBeenCalledTimes(2000);
      expect(cache.peek('1').type).toBe('hit');

      await flood(2000, 5000);
      await vi.advanceTimersByTimeAsync(0);
      const wholeTable = () =>
        onInvalidate.mock.calls.filter(
          ([event]) => (event as { keys: string[] }).keys.length === 0
        );
      expect(store.delete).toHaveBeenCalledTimes(2000);
      expect(wholeTable()).toHaveLength(1);
      expect(cache.peek('1').type).toBe('expired');

      // The notifications left after the first change of the table: once more, at the end of the second
      await vi.advanceTimersByTimeAsync(1000);
      expect(wholeTable()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(5000);
      expect(wholeTable()).toHaveLength(2);
      expect(onInvalidate).toHaveBeenCalledTimes(2002);

      // One warning a minute at most, whatever the length of the flood
      await flood(7000, 2001);
      await vi.advanceTimersByTimeAsync(0);
      expect(logger.warn).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(60_000);
      await flood(9001, 2001);
      expect(logger.warn).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenLastCalledWith(
        expect.stringContaining('(and in 1 more second since the last warning)'),
        expect.anything()
      );
    });

    it('should apply at most one TRUNCATE or BULK notification at once per second', async () => {
      const onInvalidate = vi.fn();
      const cache = await createCache({ platform: { onInvalidate } });
      await cache.getOrFetch('1');

      for (let index = 0; index < 100; index++) {
        await fake.notify({ table: 'items', op: index % 2 === 0 ? 'TRUNCATE' : 'BULK' });
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(onInvalidate).toHaveBeenCalledOnce();

      await cache.getOrFetch('1');
      expect(cache.peek('1').type).toBe('hit');
      await vi.advanceTimersByTimeAsync(1000);
      expect(onInvalidate).toHaveBeenCalledTimes(2);
      expect(cache.peek('1').type).toBe('expired');
      await cache.dispose();
    });

    it('should not apply the change of the table due after dispose', async () => {
      const onInvalidate = vi.fn();
      const cache = await createCache({ platform: { onInvalidate } });
      await fake.notify({ table: 'items', op: 'BULK' });
      await fake.notify({ table: 'items', op: 'BULK' });

      await cache.dispose();
      await vi.advanceTimersByTimeAsync(1000);

      expect(onInvalidate).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('disposal and gate sharing', () => {
    it('should make a second dispose wait until the listener is removed', async () => {
      const cache = await createCache();
      let release!: () => void;
      fake.mocks.removeListener.mockImplementationOnce(async (_channel, callbackId) => {
        await new Promise<void>((resolve) => (release = resolve));
        return fake.listeners.delete(callbackId);
      });

      const first = cache.dispose();
      const second = cache.dispose();
      let settled = false;
      void second.then(() => (settled = true));
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(second).toBe(first);
      expect(settled).toBe(false);
      release();
      await second;
      expect(fake.listeners.size).toBe(0);
    });
  });

  describe('trust in the changelog', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      changelog.read.mockReset();
      changelog.read.mockResolvedValue({ changes: [], cursor: at(100n) });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Row 1 changed elsewhere: the next read of the changelog returns it. */
    const changeRowOne = () => {
      fake.rows.set('1', { id: '1', name: 'ONE' });
      changelog.read.mockResolvedValue({
        changes: [{ id: '5', xid: 100n, rowId: '1', op: 'UPDATE' }],
        cursor: at(101n),
      });
    };

    it('should not keep a row past its TTL in get when no read applied the changes since', async () => {
      const cache = await createCache({ sync: { strategy: 'changelog', pollInterval: 1000 } });
      await cache.getOrFetch('1');
      changeRowOne();

      await vi.advanceTimersByTimeAsync(30 * 60_000);

      expect(cache.get('1')).toBeUndefined();
      expect(cache.peek('1').type).toBe('expired');
      expect(await cache.getOrFetch('1')).toEqual({ id: '1', name: 'ONE' });
    });

    it('should query a row again after its TTL while the changelog cannot be read', async () => {
      const cache = await createCache({ sync: { strategy: 'changelog', pollInterval: 1000 } });
      await cache.getOrFetch('1');
      changelog.read.mockRejectedValue(new Error('changelog unreadable'));

      await vi.advanceTimersByTimeAsync(61_000);
      await cache.getOrFetch('1');

      expect(fake.mocks.selectByPrimaryKey).toHaveBeenCalledTimes(2);
    });

    it('should keep a row past its TTL with background reads made within two intervals', async () => {
      const cache = await createCache({
        sync: { strategy: 'changelog', pollInterval: 1000, poll: 'background' },
      });
      await cache.getOrFetch('1');
      // The first read, which did not wait, expired every entry: the row is fetched again
      await vi.advanceTimersByTimeAsync(1000);
      await cache.getOrFetch('1');
      fake.mocks.selectByPrimaryKey.mockClear();

      for (let second = 0; second < 61; second++) {
        await vi.advanceTimersByTimeAsync(1000);
        await cache.getOrFetch('1');
      }

      expect(fake.mocks.selectByPrimaryKey).not.toHaveBeenCalled();
    });
  });

  describe('changes during a load of the table', () => {
    /** Makes the next load of the table wait: it returns the rows of the table now. */
    const holdNextLoad = () => {
      const snapshot = [...fake.rows.values()];
      let release!: () => void;
      fake.mocks.selectAll.mockReturnValueOnce(
        new Promise<Item[]>((resolve) => (release = () => resolve(snapshot)))
      );
      return () => release();
    };

    beforeEach(() => {
      vi.useFakeTimers();
      changelog.read.mockReset();
      changelog.read.mockResolvedValue({ changes: [], cursor: at(100n) });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should return the new row of an UPDATE notified during the first load', async () => {
      const cache = await createCache();
      const release = holdNextLoad();
      const loading = cache.getAll();
      await vi.advanceTimersByTimeAsync(0);

      fake.rows.set('1', { id: '1', name: 'ONE' });
      await fake.notify({ table: 'items', id: '1', op: 'UPDATE' });
      release();

      expect((await loading).get('1')).toEqual({ id: '1', name: 'ONE' });
      await vi.advanceTimersByTimeAsync(120_000); // renewed: LISTEN is trusted
      expect(cache.get('1')).toEqual({ id: '1', name: 'ONE' });
      expect((await cache.getAll()).get('1')).toEqual({ id: '1', name: 'ONE' });
    });

    it('should return in the next getAll a row inserted during the first load', async () => {
      const cache = await createCache();
      const release = holdNextLoad();
      const loading = cache.getAll();
      await vi.advanceTimersByTimeAsync(0);

      fake.rows.set('3', { id: '3', name: 'three' });
      await fake.notify({ table: 'items', id: '3', op: 'INSERT' });
      release();
      await loading;

      expect((await cache.getAll()).get('3')).toEqual({ id: '3', name: 'three' });
      expect(fake.mocks.selectAll).toHaveBeenCalledOnce();
    });

    it('should not re-read the ids notified during a load that it does not hold', async () => {
      const cache = await createCache();
      const release = holdNextLoad();
      const loading = cache.getAll();
      await vi.advanceTimersByTimeAsync(0);

      await fake.notify({ table: 'items', id: 'forged', op: 'UPDATE' });
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.mocks.selectByPrimaryKeys).not.toHaveBeenCalled();
      release();

      // getAll checks the row noted by the notification once, as outside a load
      expect([...(await loading).keys()].sort()).toEqual(['1', '2']);
      expect(fake.mocks.selectByPrimaryKeys).toHaveBeenCalledExactlyOnceWith(
        ['forged'],
        withSignal
      );
    });

    it('should return every row of a first load during which many ids were notified', async () => {
      const cache = await createCache();
      const release = holdNextLoad();
      const loading = cache.getAll();
      await vi.advanceTimersByTimeAsync(0);

      for (let index = 0; index < 1001; index++) {
        await fake.notify({ table: 'items', id: `unknown-${index}`, op: 'INSERT' });
      }
      release();

      expect([...(await loading).keys()]).toEqual(expect.arrayContaining(['1', '2']));
    });

    it('should load the table again when a change of the whole table voids its load', async () => {
      const cache = await createCache();
      const release = holdNextLoad();
      const loading = cache.getAll();
      await vi.advanceTimersByTimeAsync(0);

      // A statement changed many rows while the table was loading: the load may predate it
      fake.rows.set('3', { id: '3', name: 'three' });
      await fake.notify({ table: 'items', op: 'BULK' });
      release();

      expect([...(await loading).keys()].sort()).toEqual(['1', '2', '3']);
      expect(fake.mocks.selectAll).toHaveBeenCalledTimes(2);
    });

    it('should return the rows of the second load as read when a change of the whole table voids it too', async () => {
      const cache = await createCache();
      const releaseFirst = holdNextLoad();
      const loading = cache.getAll();
      await vi.advanceTimersByTimeAsync(0);
      await fake.notify({ table: 'items', op: 'BULK' });
      fake.rows.set('3', { id: '3', name: 'three' });
      const releaseSecond = holdNextLoad();

      releaseFirst();
      // The second load starts, in the next second of the notification budget
      await vi.advanceTimersByTimeAsync(1000);
      await fake.notify({ table: 'items', op: 'BULK' });
      releaseSecond();

      // It started during the call: its rows are a state of the table since the call started
      expect([...(await loading).keys()].sort()).toEqual(['1', '2', '3']);
      expect(fake.mocks.selectAll).toHaveBeenCalledTimes(2);
    });

    /** A cache of 8 rows, loaded, then told of a row it must fetch by key in the next getAll. */
    const cacheWithNotedRow = async (options: Record<string, unknown> = {}) => {
      fake = createFakeGate(
        ['1', '2', '3', '4', '5', '6', '7', '8'].map((id) => ({ id, name: `row ${id}` }))
      );
      const cache = await createCache({ logger: { error: vi.fn() }, ...options });
      await cache.getAll();
      await fake.notify({ table: 'items', id: '9', op: 'INSERT' });
      return cache;
    };

    it('should not load the table instead when the fetch by key times out', async () => {
      const cache = await cacheWithNotedRow({ bulkSync: { timeout: 1000 } });
      fake.mocks.selectByPrimaryKeys.mockReturnValueOnce(new Promise<Item[]>(() => {}));

      // eslint-disable-next-line vitest/valid-expect -- awaited once the fake timers have advanced
      const assertion = expect(cache.getAll()).rejects.toBeInstanceOf(LilypadTimeoutError);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;

      expect(fake.mocks.selectAll).toHaveBeenCalledOnce();
    });

    it('should not load the table instead once the gate is closed', async () => {
      const cache = await cacheWithNotedRow();
      const closed = new LilypadDisposedError('LilypadDbGate "test"', 'closed');
      fake.mocks.selectByPrimaryKeys.mockRejectedValueOnce(closed);

      await expect(cache.getAll()).rejects.toBe(closed);
      expect(fake.mocks.selectAll).toHaveBeenCalledOnce();
    });

    it('should not load the table again when the fetch after its own load fails', async () => {
      const cache = await createCache({ logger: { error: vi.fn() } });
      const release = holdNextLoad();
      const loading = cache.getAll();
      await vi.advanceTimersByTimeAsync(0);

      // Noted during the load: fetched by key after it, and that fetch fails
      await fake.notify({ table: 'items', id: 'not-a-key', op: 'INSERT' });
      const failure = new Error('invalid input syntax for type integer: "not-a-key"');
      fake.mocks.selectByPrimaryKeys.mockRejectedValueOnce(failure);
      release();

      await expect(loading).rejects.toBe(failure);
      expect(fake.mocks.selectAll).toHaveBeenCalledOnce();
    });

    it('should leave no fence after a load evicted rows beyond maxEntries', async () => {
      fake = createFakeGate(['1', '2', '3', '4', '5'].map((id) => ({ id, name: `row ${id}` })));
      const cache = await createCache({ maxEntries: 2 });

      expect(await rowsOf(cache.getAll())).toHaveLength(5);
      expect(cache['engine']['fences'].size).toBe(0);
    });

    it('should not load the table twice for a change read from the changelog during its load', async () => {
      fake = createFakeGate(['1', '2', '3', '4'].map((id) => ({ id, name: `row ${id}` })));
      const cache = await createCache({ sync: { strategy: 'changelog', pollInterval: 1000 } });
      const release = holdNextLoad();
      const loading = cache.getAll();
      await vi.advanceTimersByTimeAsync(0);

      // Rows 1 and 2 change while the table is loading: another read applies the changes
      fake.rows.set('1', { id: '1', name: 'ONE' });
      fake.rows.set('2', { id: '2', name: 'TWO' });
      changelog.read.mockResolvedValueOnce({
        changes: [
          { id: '9', xid: 100n, rowId: '1', op: 'UPDATE' },
          { id: '10', xid: 100n, rowId: '2', op: 'UPDATE' },
        ],
        cursor: at(101n),
      });
      await vi.advanceTimersByTimeAsync(1000);
      await cache.getOrFetch('3');
      release();

      const rows = await loading;
      expect(rows.get('1')).toEqual({ id: '1', name: 'ONE' });
      expect(rows.get('2')).toEqual({ id: '2', name: 'TWO' });
      expect(cache.get('1')).toEqual({ id: '1', name: 'ONE' });
      // The changed rows are fetched by key: the load is not repeated
      expect(fake.mocks.selectAll).toHaveBeenCalledOnce();
      expect(fake.mocks.selectByPrimaryKeys).toHaveBeenCalledExactlyOnceWith(
        ['1', '2'],
        withSignal
      );
    });
  });

  describe('changes during a write', () => {
    /** Makes the next call of this mock wait until `finish` gives its result. */
    const hold = <R>(mock: { mockReturnValueOnce(value: Promise<R>): unknown }) => {
      let finish!: (result: R) => void;
      mock.mockReturnValueOnce(new Promise<R>((resolve) => (finish = resolve)));
      return (result: R) => finish(result);
    };

    beforeEach(() => {
      vi.useFakeTimers();
      changelog.read.mockReset();
      changelog.read.mockResolvedValue({ changes: [], cursor: at(100n) });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should not cache its row over a newer change notified before the write returned', async () => {
      const cache = await createCache();
      const finish = hold<{ row: Item; xid: bigint }>(fake.mocks.update);
      const writing = cache.sqlUpdate({ id: '1', name: 'mine' });
      await vi.advanceTimersByTimeAsync(0);

      // Transaction 1001 committed the write; 1002 changed the row after it
      fake.rows.set('1', { id: '1', name: 'theirs' });
      await fake.notify({ table: 'items', id: '1', op: 'UPDATE', xid: '1002' });
      finish({ row: { id: '1', name: 'mine' }, xid: 1001n });
      await writing;
      await fake.notify({ table: 'items', id: '1', op: 'UPDATE', xid: '1001' });

      expect(await cache.getOrFetch('1')).toEqual({ id: '1', name: 'theirs' });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(cache.get('1')).toEqual({ id: '1', name: 'theirs' });
    });

    it('should not cache a created row over a newer change notified before the insert returned', async () => {
      const cache = await createCache();
      const finish = hold<{ row: Item; xid: bigint }>(fake.mocks.insert);
      const creating = cache.sqlCreate({ id: '9', name: 'mine' });
      await vi.advanceTimersByTimeAsync(0);

      fake.rows.set('9', { id: '9', name: 'theirs' });
      await fake.notify({ table: 'items', id: '9', op: 'UPDATE', xid: '1002' });
      finish({ row: { id: '9', name: 'mine' }, xid: 1001n });

      await expect(creating).resolves.toEqual({ id: '9', name: 'mine' });
      expect(await cache.getOrFetch('9')).toEqual({ id: '9', name: 'theirs' });
    });

    it('should not cache a deletion over a row inserted again before the write returned', async () => {
      const cache = await createCache();
      const finish = hold<{ deleted: boolean; xid: bigint }>(fake.mocks.delete);
      const deleting = cache.sqlDelete('1');
      await vi.advanceTimersByTimeAsync(0);

      fake.rows.set('1', { id: '1', name: 'again' });
      await fake.notify({ table: 'items', id: '1', op: 'INSERT', xid: '1002' });
      finish({ deleted: true, xid: 1001n });

      await expect(deleting).resolves.toBe(true);
      expect(await cache.getOrFetch('1')).toEqual({ id: '1', name: 'again' });
    });

    it('should not cache its row over a change read from the changelog during the write', async () => {
      const cache = await createCache({ sync: { strategy: 'changelog', pollInterval: 1000 } });
      await cache.getOrFetch('2');
      const finish = hold<{ row: Item; xid: bigint }>(fake.mocks.update);
      const writing = cache.sqlUpdate({ id: '1', name: 'mine' });
      await vi.advanceTimersByTimeAsync(0);

      fake.rows.set('1', { id: '1', name: 'theirs' });
      changelog.read.mockResolvedValueOnce({
        changes: [{ id: '9', xid: 1002n, rowId: '1', op: 'UPDATE' }],
        cursor: at(1003n),
      });
      await vi.advanceTimersByTimeAsync(1000);
      await cache.getOrFetch('2');
      finish({ row: { id: '1', name: 'mine' }, xid: 1001n });
      await writing;

      expect(await cache.getOrFetch('1')).toEqual({ id: '1', name: 'theirs' });
    });

    it('should not keep an outdated row when its own change is notified before the write returned', async () => {
      const cache = await createCache();
      await cache.getOrFetch('1');
      const finish = hold<{ row: Item; xid: bigint }>(fake.mocks.update);
      const writing = cache.sqlUpdate({ id: '1', name: 'mine' });
      await vi.advanceTimersByTimeAsync(0);

      // The notification of the write arrives first: its transaction is not known yet
      fake.rows.set('1', { id: '1', name: 'mine' });
      await fake.notify({ table: 'items', id: '1', op: 'UPDATE', xid: '1001' });
      finish({ row: { id: '1', name: 'mine' }, xid: 1001n });
      await writing;

      expect(await cache.getOrFetch('1')).toEqual({ id: '1', name: 'mine' });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(cache.get('1')).toEqual({ id: '1', name: 'mine' });
    });

    it('should still cache its row when no change came during the write', async () => {
      const cache = await createCache();

      await cache.sqlUpdate({ id: '1', name: 'mine' });

      expect(cache.get('1')).toEqual({ id: '1', name: 'mine' });
      expect(fake.mocks.selectByPrimaryKey).not.toHaveBeenCalled();
    });
  });

  describe('bounded bookkeeping', () => {
    it('should not remember its writes with applyChanges: false, which never applies them', async () => {
      const cache = await createCache({ sync: { strategy: 'listen', applyChanges: false } });

      await cache.sqlUpdate({ id: '1', name: 'renamed' });

      expect(cache['ownWrites']['writes'].size).toBe(0);
    });

    it('should forget the rows notified beyond a quarter of the table, and load it again', async () => {
      const cache = await createCache();
      await cache.getAll();

      for (let index = 0; index < 1001; index++) {
        await fake.notify({ table: 'items', id: `unknown-${index}`, op: 'INSERT' });
      }

      expect(cache['members'].size).toBeLessThan(1000);
      expect(await rowsOf(cache.getAll())).toHaveLength(2);
      expect(fake.mocks.selectAll).toHaveBeenCalledTimes(2);
    });

    it('should not charge the eager budget again for a key already in the batch', async () => {
      const cache = await createCache();
      await cache.getAll();

      const notified = [
        ...Array.from({ length: 1000 }, () =>
          fake.notify({ table: 'items', id: '1', op: 'UPDATE' })
        ),
        fake.notify({ table: 'items', id: '2', op: 'UPDATE' }),
      ];
      await Promise.all(notified);

      expect(fake.mocks.selectByPrimaryKeys).toHaveBeenCalledExactlyOnceWith(
        ['1', '2'],
        withSignal
      );
      expect(cache.peek('2').type).toBe('hit');
    });
  });
});
