import { describe, it, expect, vi, beforeEach } from 'vitest';
import LilypadDbCache from './LilypadDbCache';
import type {
  LilypadDbGate,
  LilypadDbSchema,
  ListenerCallbackIdentifier,
} from '@/dbGate/LilypadDbGate';

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
    it('should update the entry on INSERT and UPDATE notifications', async () => {
      const cache = await createCache();
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

      await fake.notify({ table: 'items', id: '1', op: 'UPDATE' });

      expect(valueSeenByCallback).toEqual({ id: '1', name: 'one' });
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
});
