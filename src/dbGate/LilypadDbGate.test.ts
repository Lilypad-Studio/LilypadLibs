import { afterEach, describe, it, expect, vi } from 'vitest';
import { LilypadDbGate, lilypadServerlessPool } from './LilypadDbGate';
import { LilypadDisposedError } from '@/cache/LilypadCacheTypes';
import { defineLilypadDb, defineLilypadTable } from '@/dbConfig/LilypadDbConfig';
import { bindLilypadDbHooks } from '@/dbConfig/LilypadDbHooks';
import { LilypadDbTable } from './LilypadDbTable';

const db = defineLilypadDb({
  tables: {
    items: defineLilypadTable<{ id: number }, 'id'>({
      tableName: 'items',
      primaryKey: 'id',
      cols: { id: { type: 'number' } },
    }),
  },
});

// Nothing listens on this port: any connection attempt would fail
const unreachable = 'postgres://user:password@127.0.0.1:1/db';

describe('LilypadDbGate (without database)', () => {
  it('should not connect when created without listeners', async () => {
    const gate = await LilypadDbGate.create({
      connectionString: unreachable,
      pool: { connectTimeout: 1_000 },
    });

    await expect(gate.close()).resolves.toBeUndefined();
  });

  it('should pass the pool options to postgres.js, in seconds', async () => {
    const gate = await LilypadDbGate.create({
      connectionString: unreachable,
      pool: lilypadServerlessPool,
    });

    expect(gate.sql.options).toMatchObject({ max: 3, idle_timeout: 5, connect_timeout: 10 });
    await gate.close();
  });

  it('should keep the postgres.js defaults for the pool options not given', async () => {
    const gate = await LilypadDbGate.create({ connectionString: unreachable, pool: { max: 2 } });

    expect(gate.sql.options.max).toBe(2);
    expect(gate.sql.options.connect_timeout).toBe(30);
    await gate.close();
  });

  it('should bound the queries with a statement timeout of 30 seconds by default', async () => {
    const gate = await LilypadDbGate.create({ connectionString: unreachable });
    const unbounded = await LilypadDbGate.create({
      connectionString: unreachable,
      statementTimeout: false,
    });

    expect(gate.sql.options.connection).toMatchObject({ statement_timeout: 30_000 });
    expect(unbounded.sql.options.connection).not.toHaveProperty('statement_timeout');
    await Promise.all([gate.close(), unbounded.close()]);
  });

  describe('close', () => {
    it('should return the same promise when called again, and reject later queries', async () => {
      const gate = await LilypadDbGate.create({ connectionString: unreachable });

      const closing = gate.close();

      expect(gate.close()).toBe(closing);
      await closing;
      expect(gate.closed).toBe(true);
      await expect(gate.table(db.tables.items).selectByPrimaryKey(1)).rejects.toThrow('is closed');
      await expect(
        gate.addListener({ channel: 'c', callbackId: 'a', callback: () => {} })
      ).rejects.toThrow('is closed');
      await expect(gate.removeListener('c', 'a')).resolves.toBe(false);
    });
  });

  describe('heartbeat', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** A gate whose LISTEN calls are answered by the test, without a database. */
    async function createListeningGate() {
      const gate = await LilypadDbGate.create({
        connectionString: unreachable,
        listenHeartbeat: 1000,
      });
      const heartbeatListens: {
        resolve: (meta: { unlisten: () => Promise<void> }) => void;
        reject: (error: Error) => void;
      }[] = [];
      const heartbeatUnlisten = vi.fn(async () => {});
      const listen = vi.spyOn(gate.sql, 'listen').mockImplementation(((channel: string) => {
        if (channel.startsWith('lilypad_heartbeat_')) {
          return new Promise((resolve, reject) => heartbeatListens.push({ resolve, reject }));
        }
        return Promise.resolve({ state: {}, unlisten: async () => {} });
      }) as unknown as typeof gate.sql.listen);
      return { gate, heartbeatListens, heartbeatUnlisten, listen };
    }

    it('should not start the heartbeat when the last listener is removed while it starts', async () => {
      const { gate, heartbeatListens, heartbeatUnlisten } = await createListeningGate();

      const adding = gate.addListener({ channel: 'c', callbackId: 'a', callback: () => {} });
      await vi.waitFor(() => expect(heartbeatListens).toHaveLength(1));
      const removing = gate.removeListener('c', 'a');
      heartbeatListens[0]!.resolve({ unlisten: heartbeatUnlisten });
      await Promise.all([adding, removing]);

      expect(gate['heartbeat']?.running).toBe(false);
      expect(heartbeatUnlisten).toHaveBeenCalledOnce();
      await gate.close();
    });

    it('should retry a heartbeat that could not start, after a backoff', async () => {
      vi.useFakeTimers();
      const { gate, heartbeatListens, heartbeatUnlisten } = await createListeningGate();
      const adding = gate.addListener({ channel: 'c', callbackId: 'a', callback: () => {} });
      await vi.waitFor(() => expect(heartbeatListens).toHaveLength(1));
      heartbeatListens[0]!.reject(new Error('listen failed'));
      await adding;

      expect(gate.isListenHealthy()).toBe(false);
      expect(heartbeatListens).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(gate.isListenHealthy()).toBe(false);
      expect(heartbeatListens).toHaveLength(2);
      heartbeatListens[1]!.resolve({ unlisten: heartbeatUnlisten });
      await vi.advanceTimersByTimeAsync(0);

      expect(gate.isListenHealthy()).toBe(true);
      await gate.close();
    });
  });
});

describe('LilypadDbGate close', () => {
  it('should reject an invalid timeout and stay open', async () => {
    const gate = await LilypadDbGate.create({ connectionString: unreachable });

    expect(() => gate.close({ timeout: -1 })).toThrow('close timeout must be');
    expect(gate.closed).toBe(false);

    // It can still be closed properly
    await gate[Symbol.asyncDispose]();
    expect(gate.closed).toBe(true);
  });

  it('should reject the queries of a closed gate with a LilypadDisposedError', async () => {
    const gate = await LilypadDbGate.create({ connectionString: unreachable });
    await gate.close();

    await expect(gate.table(db.tables.items).selectByPrimaryKey(1)).rejects.toThrow(
      LilypadDisposedError
    );
  });

  describe('tables', () => {
    it('should find a table of its config by name, and take the table of any config', async () => {
      const other = defineLilypadDb({
        name: 'other',
        tables: { events: { tableName: 'events', primaryKey: 'id', cols: { id: {} } } },
      });
      const gate = await LilypadDbGate.create({ connectionString: unreachable, config: db });

      const byName = gate.table('items');
      const fromOther = gate.table(other.tables.events);

      expect(byName).toBeInstanceOf(LilypadDbTable);
      expect(byName.definition).toBe(db.tables.items);
      expect(fromOther.definition).toBe(other.tables.events);
      await gate.close();
    });

    it('should apply the hooks of its config to the definitions of the original config', async () => {
      const select = (row: Record<string, unknown>) => ({ id: Number(row.id) });
      const appDb = bindLilypadDbHooks(db, { items: { select } });
      const gate = await LilypadDbGate.create({ connectionString: unreachable, config: appDb });
      const bare = await LilypadDbGate.create({ connectionString: unreachable, config: db });

      expect(gate.table('items').definition.hooks?.select).toBe(select);
      expect(gate.table(db.tables.items).definition.hooks?.select).toBe(select);
      expect(gate.table(db.tables.items).definition.qualifiedName).toBe('public.items');
      expect(bare.table(appDb.tables.items).definition).toBe(appDb.tables.items);
      expect(bare.table(db.tables.items).definition.hooks).toBeUndefined();
      await Promise.all([gate.close(), bare.close()]);
    });

    it('should reject a table name without a config, or not in the config', async () => {
      const gate = await LilypadDbGate.create({ connectionString: unreachable, config: db });
      const bare = await LilypadDbGate.create({ connectionString: unreachable });

      // @ts-expect-error: not a table of the config
      expect(() => gate.table('missing')).toThrow('the config "default" has no table "missing"');
      // @ts-expect-error: the gate has no config
      expect(() => bare.table('items')).toThrow('there is no config to find it in');
      await Promise.all([gate.close(), bare.close()]);
    });

    it('should reject a description that is not a table of a config', async () => {
      const gate = await LilypadDbGate.create({ connectionString: unreachable });
      const schema = { tableName: 'items', primaryKey: 'id' as const, cols: { id: {} } };

      // @ts-expect-error: a table must come from defineLilypadDb
      expect(() => gate.table(schema)).toThrow(
        'must be a table of a config made with defineLilypadDb'
      );
      await gate.close();
    });
  });

  it('should reject a listenHeartbeat that a timer cannot hold', async () => {
    await expect(
      LilypadDbGate.create({ connectionString: unreachable, listenHeartbeat: 2 ** 31 })
    ).rejects.toThrow('listenHeartbeat must be');
  });
});
