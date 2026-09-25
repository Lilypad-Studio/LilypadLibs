import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import LilypadDbCache from './LilypadDbCache';
import type {
  LilypadDbGate,
  LilypadDbSchema,
  ListenerCallbackIdentifier,
} from '@/dbGate/LilypadDbGate';
import type { LilypadLibLogger } from '@/logger/LilypadLogger';
import { LilypadSchemaCheckError } from '@/dbGate/LilypadSchemaCheck';

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
      )) as { changes: unknown[]; cursor: bigint }[];
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

// The schema check is mocked too: its queries are covered by the integration tests
const schemaCheck = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock('@/dbGate/LilypadSchemaCheck', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/dbGate/LilypadSchemaCheck')>()),
  checkLilypadSchema: schemaCheck.check,
}));

const schemaOk = (schemaName: string | null = 'public') => ({
  ok: true,
  problems: [],
  tables: [{ table: 'items', schema: schemaName }],
});

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
  let lastXid = 1000n;

  const mocks = {
    selectAllFromTable: vi.fn(async () => [...rows.values()]),
    selectFromTableByPrimaryKey: vi.fn(
      async (_schema: unknown, key: string) => rows.get(String(key)) ?? null
    ),
    selectFromTableByPrimaryKeys: vi.fn(async (_schema: unknown, keys: string[]) =>
      keys.flatMap((key) => rows.get(String(key)) ?? [])
    ),
    insertToTableDetailed: vi.fn(async (_schema: unknown, item: Partial<Item>) => {
      const row = { ...item, id: item.id ?? `generated-${++generatedIds}` } as Item;
      rows.set(row.id, row);
      return { row, xid: ++lastXid };
    }),
    updateToTableDetailed: vi.fn(async (_schema: unknown, item: Item) => {
      rows.set(item.id, item);
      return { row: item as Item | null, xid: ++lastXid };
    }),
    deleteFromTableDetailed: vi.fn(async (_schema: unknown, key: string) => {
      rows.delete(key);
      return { xid: ++lastXid };
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
    schemaCheck.check.mockReset();
    schemaCheck.check.mockResolvedValue(schemaOk());
  });

  const createCache = (options: Record<string, unknown> = {}) =>
    LilypadDbCache.create<string, Item>({
      ttl: 60000,
      dbGate: { gate: fake.gate, schema },
      ...options,
    });

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

    it('should leave the cache to onNotification with applyChanges: false', async () => {
      const callback = vi.fn();
      const cache = await createCache({
        sync: { strategy: 'listen', applyChanges: false, onNotification: callback },
      });

      await fake.notify({ table: 'items', id: '1', op: 'UPDATE' });

      expect(callback).toHaveBeenCalledWith({ table: 'items', id: '1', op: 'UPDATE' });
      expect(cache.getComprehensive('1').type).toBe('miss');
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

    it('should reject when the fetch fails', async () => {
      const cache = await createCache();
      fake.mocks.selectFromTableByPrimaryKey.mockRejectedValueOnce(new Error('query failed'));

      await expect(cache.getOrFetch('1')).rejects.toThrow('query failed');
    });

    it('should return the fallback of errorFn when the fetch fails', async () => {
      const cache = await createCache();
      fake.mocks.selectFromTableByPrimaryKey.mockRejectedValueOnce(new Error('query failed'));

      const result = await cache.getOrFetchDetailed('1', { errorFn: () => null });

      expect(result).toEqual({ value: null, status: 'MISS', refreshFailed: true });
    });

    it('should expire the entry on invalidate, without a query', async () => {
      const cache = await createCache();
      await cache.getOrFetch('1');

      cache.invalidate('1');

      expect(cache.getComprehensive('1').type).toBe('expired');
      expect(fake.mocks.selectFromTableByPrimaryKey).toHaveBeenCalledOnce();
    });

    it('should re-fetch the key on refresh, and reject when the query fails', async () => {
      const cache = await createCache();
      await cache.getOrFetch('1');
      fake.rows.set('1', { id: '1', name: 'ONE' });

      await expect(cache.refresh('1')).resolves.toEqual({ id: '1', name: 'ONE' });
      expect(cache.get('1')).toEqual({ id: '1', name: 'ONE' });

      fake.mocks.selectFromTableByPrimaryKey.mockRejectedValueOnce(new Error('query failed'));
      await expect(cache.refresh('1')).rejects.toThrow('query failed');
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

      expect(fake.mocks.updateToTableDetailed).toHaveBeenCalledOnce();
    });

    it('should cache the row returned by the database after an update', async () => {
      const cache = await createCache();
      fake.mocks.updateToTableDetailed.mockResolvedValueOnce({
        row: { id: '1', name: 'sanitized' },
        xid: 1n,
      });

      await cache.sqlUpdate({ id: '1', name: 'raw' });

      expect(cache.get('1')).toEqual({ id: '1', name: 'sanitized' });
    });

    it('should cache a deleted row as null', async () => {
      const cache = await createCache();
      await cache.getOrFetch('1');

      await cache.sqlDelete('1');

      expect(fake.mocks.deleteFromTableDetailed).toHaveBeenCalledWith(schema, '1');
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

    it('should run one more query for the notifications received during a refresh', async () => {
      const cache = await createCache();
      await cache.getOrFetch('1');
      const firstRead = deferred<Item | null>();
      const secondRead = deferred<Item | null>();
      fake.mocks.selectFromTableByPrimaryKey
        .mockReturnValueOnce(firstRead.promise)
        .mockReturnValueOnce(secondRead.promise);

      const refreshes = [
        fake.notify({ table: 'items', id: '1', op: 'UPDATE' }),
        fake.notify({ table: 'items', id: '1', op: 'UPDATE' }),
        fake.notify({ table: 'items', id: '1', op: 'UPDATE' }),
      ];
      firstRead.resolve({ id: '1', name: 'first' });
      await vi.waitFor(() =>
        expect(fake.mocks.selectFromTableByPrimaryKey).toHaveBeenCalledTimes(3)
      );
      secondRead.resolve({ id: '1', name: 'second' });
      await Promise.all(refreshes);

      // The fetch of getOrFetch, the running refresh, and one queued for the other two
      expect(fake.mocks.selectFromTableByPrimaryKey).toHaveBeenCalledTimes(3);
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
      const listener = [...fake.listeners.values()][0]!;

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

    it('should keep a row in getAll when its refresh after a notification fails', async () => {
      const cache = await createCache();
      await cache.getAll();
      fake.mocks.selectFromTableByPrimaryKey.mockRejectedValueOnce(new Error('query failed'));

      await fake.notify({ table: 'items', id: '1', op: 'UPDATE' });

      expect(await cache.getAll()).toEqual([
        { id: '1', name: 'one' },
        { id: '2', name: 'two' },
      ]);
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
      const cache = await LilypadDbCache.create<string, Item, 'id'>({
        ttl: 60000,
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

      const second = await LilypadDbCache.create<string, Item>({
        ttl: 30000,
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
        changelogTable: 'lilypad_cache_changes',
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

    it('should keep every row in getAll after a write read back from the changelog', async () => {
      fake = createFakeGate(['1', '2', '3', '4', '5'].map((id) => ({ id, name: `row ${id}` })));
      const writer = await createChangelogCache();
      const reader = await createChangelogCache();
      expect(await writer.getAll()).toHaveLength(5);
      expect(await reader.getAll()).toHaveLength(5);

      await writer.sqlUpdate({ id: '1', name: 'renamed' });
      changelog.read.mockResolvedValue({
        changes: [{ id: '9', xid: 100n, rowId: '1', op: 'UPDATE' }],
        cursor: 101n,
      });
      await vi.advanceTimersByTimeAsync(1000);

      for (const cache of [writer, reader]) {
        const items = await cache.getAll();
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
        cursor: 101n,
      });
      let resolveLoad!: (rows: Item[]) => void;
      fake.mocks.selectAllFromTable.mockReturnValueOnce(
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
        cursor: 102n,
      });
      await vi.advanceTimersByTimeAsync(1000);
      await cache.getOrFetch('2');
      resolveLoad(loadedRows);

      const items = await loading;
      expect(items).toHaveLength(3);
      expect(items).toContainEqual({ id: '1', name: 'ONE' });
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
        cache.name,
        'Error reading the changelog:',
        expect.any(Error)
      );
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
    const noChanges = { changes: [], cursor: 100n };
    /** How many rows each kind of query has read. */
    const queries = () => ({
      table: fake.mocks.selectAllFromTable.mock.calls.length,
      byKey: fake.mocks.selectFromTableByPrimaryKey.mock.calls.length,
      byKeys: fake.mocks.selectFromTableByPrimaryKeys.mock.calls.map(([, keys]) => keys),
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
      const { xid } = await fake.mocks.updateToTableDetailed.mock.results[0]!.value;
      changelog.read.mockResolvedValue({
        changes: [{ id: '9', xid, rowId: '1', op: 'UPDATE' }],
        cursor: 100n,
      });
      await vi.advanceTimersByTimeAsync(1000);

      for (const cache of [writer, reader]) {
        const items = await cache.getAll();
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
        cursor: 101n,
      });

      await vi.advanceTimersByTimeAsync(1000);
      const items = await cache.getAll();

      expect(items).toHaveLength(9);
      expect(queries()).toEqual({ table: 1, byKey: 0, byKeys: [['9']] });
    });

    it('should keep the rows past their TTL without a query while the sync is trusted', async () => {
      const cache = await createChangelogCache();
      await cache.getAll();

      await vi.advanceTimersByTimeAsync(61_000);

      expect(await cache.getAll()).toHaveLength(8);
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
      cache.set('1', { id: '1', name: 'short-lived' }, 1000);

      await vi.advanceTimersByTimeAsync(2000);
      const items = await cache.getAll();

      expect(items).toHaveLength(8);
      expect(items).toContainEqual({ id: '1', name: 'row 1' });
      expect(queries()).toEqual({ table: 1, byKey: 0, byKeys: [['1']] });
    });

    it('should fetch only the requested keys with getAll(keys)', async () => {
      const cache = await createCache({ sync: { strategy: 'none' } });

      expect(await cache.getAll(['2', '2', 'missing'])).toEqual([{ id: '2', name: 'row 2' }]);
      expect(await cache.getAll(['2'])).toEqual([{ id: '2', name: 'row 2' }]);
      expect(queries()).toEqual({ table: 0, byKey: 0, byKeys: [['2', 'missing']] });
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

      const fetchOne = () => fake.mocks.selectFromTableByPrimaryKey(schema, '1');
      expect((await second.getOrSetDetailed('1', fetchOne)).status).toBe('L2-HIT');
      await vi.advanceTimersByTimeAsync(61_000);
      await second.getOrFetch('1');

      // The copy of the shared level may be older than a change: it is fetched again
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
          cursor: 101n,
        });

        await vi.advanceTimersByTimeAsync(1000);

        expect(await cache.getAll()).toEqual([]);
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
          cursor: 102n,
        });

        await vi.advanceTimersByTimeAsync(1000);

        expect(await cache.getAll()).toEqual([{ id: '20', name: 'after' }]);
      });

      it('should apply a TRUNCATE notification', async () => {
        const cache = await createCache();
        await cache.getAll();
        fake.rows.clear();

        await fake.notify({ schema: 'public', table: 'items', op: 'TRUNCATE' });

        expect(cache.get('1')).toBeUndefined();
        expect(await cache.getAll()).toEqual([]);
      });

      it('should not cache a row read before a TRUNCATE', async () => {
        const cache = await createCache();
        let resolveRead!: (row: Item | null) => void;
        fake.mocks.selectFromTableByPrimaryKey.mockReturnValueOnce(
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
        const { xid } = await fake.mocks.updateToTableDetailed.mock.results[0]!.value;

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
          fake.mocks.insertToTableDetailed.mock.results[0]!.value,
          fake.mocks.updateToTableDetailed.mock.results[0]!.value,
        ]);
        changelog.read.mockResolvedValueOnce({
          changes: [
            { id: '20', xid: created.xid, rowId: '9', op: 'INSERT' },
            { id: '21', xid: updated.xid, rowId: '9', op: 'UPDATE' },
          ],
          cursor: 100n,
        });

        await vi.advanceTimersByTimeAsync(1000);

        expect(await cache.getAll()).toContainEqual({ id: '9', name: 'renamed' });
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
        fake.mocks.updateToTableDetailed.mockReturnValueOnce(
          new Promise((resolve) => (resolveWrite = resolve))
        );
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
        fake.mocks.selectFromTableByPrimaryKey.mockReturnValueOnce(
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

  describe('schema verification', () => {
    const missingTrigger = {
      ok: false,
      problems: [
        {
          code: 'missing-changelog-trigger',
          table: 'items',
          message: 'The table "items" has no changelog trigger: its changes are not recorded.',
          fix: 'CREATE TRIGGER items_lilypad_changes ...',
        },
      ],
      tables: [{ table: 'items', schema: 'public' }],
    };
    const createLogger = () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() });

    beforeEach(() => {
      changelog.read.mockReset();
      changelog.read.mockResolvedValue({ changes: [], cursor: 100n });
    });

    it('should check the notification trigger before LISTEN with the listen strategy', async () => {
      await createCache();

      expect(schemaCheck.check).toHaveBeenCalledWith(fake.gate, {
        tables: [{ table: 'items', primaryKey: 'id' }],
        changelog: false,
        notifyChannel: 'cache_events',
      });
      expect(schemaCheck.check.mock.invocationCallOrder[0]!).toBeLessThan(
        fake.mocks.addListener.mock.invocationCallOrder[0]!
      );
    });

    it('should check the changelog once, on the first read, with the changelog strategy', async () => {
      const cache = await createCache({
        sync: { strategy: 'changelog', pollInterval: 0, table: 'my_changes' },
      });
      expect(schemaCheck.check).not.toHaveBeenCalled();

      await cache.getOrFetch('1');
      await cache.getOrFetch('2');

      expect(schemaCheck.check).toHaveBeenCalledOnce();
      expect(schemaCheck.check).toHaveBeenCalledWith(fake.gate, {
        tables: [{ table: 'items', primaryKey: 'id' }],
        changelog: { table: 'my_changes' },
        notifyChannel: false,
      });
    });

    it('should not delay changelog reads for the check', async () => {
      schemaCheck.check.mockReturnValue(new Promise(() => {}));
      const cache = await createCache({ sync: { strategy: 'changelog', pollInterval: 0 } });

      await expect(cache.getOrFetch('1')).resolves.toEqual({ id: '1', name: 'one' });
    });

    it('should warn once with the problems and the SQL that fixes them', async () => {
      schemaCheck.check.mockResolvedValue(missingTrigger);
      const logger = createLogger();
      const cache = await createCache({
        sync: { strategy: 'changelog', pollInterval: 0 },
        logger,
      });

      await cache.getOrFetch('1');
      await cache.getOrFetch('2');
      await vi.waitFor(() => expect(logger.warn).toHaveBeenCalled());

      expect(logger.warn).toHaveBeenCalledOnce();
      const [id, message] = logger.warn.mock.calls[0]!;
      expect(id).toBe(cache.name);
      expect(message).toContain('LilypadDbCache "items" (sync: changelog)');
      expect(message).toContain('has no changelog trigger');
      expect(message).toContain('CREATE TRIGGER items_lilypad_changes ...');
    });

    it('should warn on the console without a logger', async () => {
      schemaCheck.check.mockResolvedValue(missingTrigger);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await createCache();

        expect(warn).toHaveBeenCalledWith(expect.stringContaining('has no changelog trigger'));
      } finally {
        warn.mockRestore();
      }
    });

    it('should keep working when the check fails', async () => {
      schemaCheck.check.mockRejectedValue(new Error('permission denied for pg_trigger'));
      const logger = createLogger();
      const cache = await createCache({ logger });

      expect(fake.mocks.addListener).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledWith(
        cache.name,
        'LilypadDbCache "items" (sync: listen): could not check the database schema:',
        expect.any(Error)
      );
    });

    it('should reject create with verify: throw, before connecting', async () => {
      schemaCheck.check.mockResolvedValue(missingTrigger);

      const creating = createCache({ sync: { strategy: 'listen', verify: 'throw' } });

      await expect(creating).rejects.toThrow(LilypadSchemaCheckError);
      await expect(creating).rejects.toMatchObject({ problems: missingTrigger.problems });
      expect(fake.mocks.addListener).not.toHaveBeenCalled();
    });

    it('should check in create with verify: throw, even with the changelog strategy', async () => {
      await createCache({ sync: { strategy: 'changelog', pollInterval: 0, verify: 'throw' } });

      expect(schemaCheck.check).toHaveBeenCalledOnce();
    });

    it('should not check with verify: off or the none strategy', async () => {
      const cache = await createCache({ sync: { strategy: 'listen', verify: 'off' } });
      const other = await createCache({ sync: { strategy: 'none' } });
      await cache.getOrFetch('1');
      await other.getOrFetch('1');

      expect(schemaCheck.check).not.toHaveBeenCalled();
    });

    it('should ignore the notifications of a table of the same name in another schema', async () => {
      const cache = await createCache();
      await cache.getOrFetch('1');

      await fake.notify({ schema: 'archive', table: 'items', id: '1', op: 'DELETE' });
      expect(cache.get('1')).toEqual({ id: '1', name: 'one' });

      await fake.notify({ schema: 'public', table: 'items', id: '1', op: 'DELETE' });
      expect(cache.get('1')).toBeNull();
    });

    it('should apply notifications without a schema to the table in any schema', async () => {
      const cache = await createCache();
      await cache.getOrFetch('1');

      await fake.notify({ table: 'items', id: '1', op: 'DELETE' });

      expect(cache.get('1')).toBeNull();
    });

    it('should take the schema from a qualified table name, even without a check', async () => {
      const cache = await LilypadDbCache.create<string, Item>({
        ttl: 60000,
        dbGate: { gate: fake.gate, schema: { ...schema, tableName: 'app.items' } },
        sync: { strategy: 'listen', verify: 'off' },
      });
      await cache.getOrFetch('1');

      await fake.notify({ schema: 'public', table: 'items', id: '1', op: 'DELETE' });
      expect(cache.get('1')).toEqual({ id: '1', name: 'one' });

      await fake.notify({ schema: 'app', table: 'items', id: '1', op: 'DELETE' });
      expect(cache.get('1')).toBeNull();
    });

    it('should read the changelog of the qualified table name', async () => {
      const cache = await LilypadDbCache.create<string, Item>({
        ttl: 60000,
        dbGate: { gate: fake.gate, schema: { ...schema, tableName: 'app.items' } },
        sync: { strategy: 'changelog', pollInterval: 0 },
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

      expect(first).toHaveLength(10);
      expect(second.map((row) => row.id).sort()).toEqual(first.map((row) => row.id).sort());
    });
  });

  describe('getAll(keys) in parallel', () => {
    it('should not mix up key sets that join to the same string', async () => {
      fake = createFakeGate([
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
        { id: 'a,b', name: 'AB' },
      ]);
      const cache = await createCache({ sync: { strategy: 'none' } });

      const [joined, separate] = await Promise.all([
        cache.getAll(['a,b']),
        cache.getAll(['a', 'b']),
      ]);

      expect(joined.map((row) => row.id)).toEqual(['a,b']);
      expect(separate.map((row) => row.id)).toEqual(['a', 'b']);
    });

    it('should share the query of a key already being fetched', async () => {
      const cache = await createCache({ sync: { strategy: 'none' } });

      await Promise.all([cache.getAll(['1', '2']), cache.getAll(['2'])]);

      expect(fake.mocks.selectFromTableByPrimaryKeys).toHaveBeenCalledOnce();
    });
  });

  describe('changelog failures and reads in flight', () => {
    const createChangelogCache = (sync: Record<string, unknown> = {}) =>
      createCache({ sync: { strategy: 'changelog', pollInterval: 1000, ...sync } });

    beforeEach(() => {
      vi.useFakeTimers();
      changelog.read.mockReset();
      changelog.read.mockResolvedValue({ changes: [], cursor: 100n });
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
      await cache.getAll(['2']); // first read of the changelog
      let release!: (row: Item | null) => void;
      fake.mocks.selectFromTableByPrimaryKey.mockReturnValueOnce(
        new Promise((resolve) => (release = resolve))
      );
      const pending = cache.getOrFetch('1');
      changelog.read.mockResolvedValueOnce({
        changes: [{ id: '1', xid: 100n, rowId: '1', op: 'UPDATE' }],
        cursor: 101n,
      });

      // The changelog read of a later read applies the change while the fetch is in flight
      await vi.advanceTimersByTimeAsync(1000);
      await cache.getAll(['2']);
      release({ id: '1', name: 'before the change' });
      await pending;

      expect(cache.getComprehensive('1').type).toBe('miss');
      expect(fake.mocks.selectFromTableByPrimaryKey).toHaveBeenCalledOnce();
    });

    it('should read the changelog of every cache of the gate in one query', async () => {
      const first = await createChangelogCache();
      const second = await LilypadDbCache.create<string, Item>({
        ttl: 60000,
        name: 'items-2',
        dbGate: { gate: fake.gate, schema },
        sync: { strategy: 'changelog', pollInterval: 1000 },
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
    const numericSchema: LilypadDbSchema<NumericItem, 'id'> = {
      tableName: 'items',
      primaryKey: 'id',
      cols: { id: { type: 'number' }, name: { type: 'string' } },
    };

    it('should convert the ids of notifications to numbers for a number column', async () => {
      const cache = await LilypadDbCache.create<number, NumericItem, 'id'>({
        dbGate: { gate: fake.gate, schema: numericSchema },
      });

      await fake.notify({ table: 'items', id: '42', op: 'DELETE' });

      expect([...cache.bulkGet({}).keys()]).toEqual([42]);
      await cache.dispose();
    });
  });

  describe('disposed cache', () => {
    it('should reject reads', async () => {
      const cache = await createCache();
      await cache.dispose();

      await expect(cache.getAll()).rejects.toThrow('is disposed');
      await expect(cache.getOrFetch('1')).rejects.toThrow('is disposed');
    });
  });
});
