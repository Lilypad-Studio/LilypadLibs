import { afterEach, describe, it, expect, vi } from 'vitest';
import { LilypadDbGate, lilypadServerlessPool } from './LilypadDbGate';
import { LilypadDisposedError } from '@/internal/LilypadDisposedError';
import { defineLilypadDb, defineLilypadTable } from '@/dbConfig/LilypadDbConfig';
import { bindLilypadDbHooks } from '@/dbConfig/LilypadDbHooks';
import { LilypadDbTable } from './LilypadDbTable';
import { pruneLilypadChangelog, readLilypadChanges } from './LilypadChangelog';

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

  // A pooler (PgBouncer) refuses the startup parameter: every query would fail
  it('should send no statement timeout by default, only the one given', async () => {
    const gate = await LilypadDbGate.create({ connectionString: unreachable });
    const unbounded = await LilypadDbGate.create({
      connectionString: unreachable,
      statementTimeout: false,
    });
    const bounded = await LilypadDbGate.create({
      connectionString: unreachable,
      statementTimeout: 10_000,
    });

    expect(gate.sql.options.connection).not.toHaveProperty('statement_timeout');
    expect(unbounded.sql.options.connection).not.toHaveProperty('statement_timeout');
    expect(bounded.sql.options.connection).toMatchObject({ statement_timeout: 10_000 });
    await Promise.all([gate.close(), unbounded.close(), bounded.close()]);
  });

  it.each(['connectionString', 'listenerConnectionString'] as const)(
    'should reject a malformed %s without its password in the error',
    async (option) => {
      const malformed = 'postgres://user:s3cr3t@[bad/db';
      const error: unknown = await LilypadDbGate.create({
        connectionString: unreachable,
        [option]: malformed,
      }).catch((error: unknown) => error);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        `LilypadDbGate: ${option} is not a valid URL (Invalid URL).`
      );
      expect(JSON.stringify(error)).not.toContain('s3cr3t');
      expect((error as Error).cause).toBeUndefined();
    }
  );

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

    it('should close the gate it created when a listener of `listen` fails', async () => {
      const close = vi.spyOn(LilypadDbGate.prototype, 'close');
      try {
        await expect(
          LilypadDbGate.create({
            connectionString: unreachable,
            listen: [{ channel: '', callbackId: 'cb', callback: () => {} }],
          })
        ).rejects.toThrow('the channel must be a non-empty string');

        // Its connection pools are released: the caller never receives the gate to close it
        expect(close).toHaveBeenCalledOnce();
        await expect(close.mock.results[0]!.value).resolves.toBeUndefined();
      } finally {
        close.mockRestore();
      }
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

    it('should count LISTEN as healthy without heartbeat only once it is active', async () => {
      const gate = await LilypadDbGate.create({
        connectionString: unreachable,
        listenHeartbeat: false,
      });
      let resolveListen!: (meta: { unlisten: () => Promise<void> }) => void;
      vi.spyOn(gate.sql, 'listen').mockImplementation(
        ((_channel: string, _fn: unknown, onlisten: () => void) =>
          new Promise((resolve) => {
            resolveListen = (meta) => {
              onlisten();
              resolve(meta);
            };
          })) as unknown as typeof gate.sql.listen
      );

      const adding = gate.addListener({ channel: 'c', callbackId: 'a', callback: () => {} });

      expect(gate.isListenHealthy()).toBe(false);
      resolveListen({ unlisten: async () => {} });
      await adding;
      expect(gate.isListenHealthy()).toBe(true);
      await gate.close();
    });
  });

  describe('listeners of a failed LISTEN', () => {
    it('should ignore the notifications and reconnections of a LISTEN that failed', async () => {
      const gate = await LilypadDbGate.create({
        connectionString: unreachable,
        listenHeartbeat: false,
      });
      // postgres.js keeps the listener of a failed LISTEN, and listens to it again on every
      // reconnection: these are the callbacks it keeps
      const registered: { fn: (payload: string) => void; onlisten: () => void }[] = [];
      let fail = true;
      vi.spyOn(gate.sql, 'listen').mockImplementation(((
        _channel: string,
        fn: (payload: string) => void,
        onlisten: () => void
      ) => {
        registered.push({ fn, onlisten });
        if (fail) {
          return Promise.reject(new Error('connection refused'));
        }
        // Like postgres.js, after LISTEN has run
        return Promise.resolve().then(() => {
          onlisten();
          return { state: {}, unlisten: async () => {} };
        });
      }) as unknown as typeof gate.sql.listen);
      const callback = vi.fn();
      const onReconnect = vi.fn();
      const listener = { channel: 'c', callbackId: 'a', callback, onReconnect };

      await expect(gate.addListener(listener)).rejects.toThrow('connection refused');
      fail = false;
      await gate.addListener(listener);
      const [failed, current] = registered;
      // The failed LISTEN is listened to again, then the connection is lost and re-established
      failed!.onlisten();
      failed!.onlisten();
      failed!.fn('payload');
      current!.fn('payload');
      await vi.waitFor(() => expect(callback).toHaveBeenCalled());

      expect(callback).toHaveBeenCalledOnce();
      expect(onReconnect).not.toHaveBeenCalled();
      current!.onlisten();
      await vi.waitFor(() => expect(onReconnect).toHaveBeenCalledOnce());
      await gate.close();
    });
  });

  describe('singleton', () => {
    it('should warn when an existing singleton is created again with other listeners', async () => {
      const warn = vi.fn();
      const gate = await LilypadDbGate.create({
        connectionString: unreachable,
        singleton: 'gate-listeners',
      });

      const again = await LilypadDbGate.create({
        connectionString: unreachable,
        singleton: 'gate-listeners',
        logger: { warn },
        listen: [{ channel: 'c', callbackId: 'a', callback: () => {} }],
      });

      const withoutListeners = await LilypadDbGate.create({
        connectionString: unreachable,
        singleton: 'gate-listeners',
        logger: { warn },
        listen: [],
      });

      expect(again).toBe(gate);
      expect(withoutListeners).toBe(gate);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]![0]).toContain('different connection options, config or listeners');
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
    await expect(
      readLilypadChanges(gate, { tableName: 'items', since: { lookback: 60_000 } })
    ).rejects.toThrow(LilypadDisposedError);
    await expect(pruneLilypadChangelog(gate, { olderThan: 86_400_000 })).rejects.toThrow(
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

    it('should check the definition given to the constructor, and apply the hooks of the gate', async () => {
      const select = (row: Record<string, unknown>) => ({ id: Number(row.id) });
      const appDb = bindLilypadDbHooks(db, { items: { select } });
      const gate = await LilypadDbGate.create({ connectionString: unreachable, config: appDb });
      const schema = { tableName: 'items', primaryKey: 'id' as const, cols: { id: {} } };

      expect(new LilypadDbTable(gate, db.tables.items).definition.hooks?.select).toBe(select);
      // @ts-expect-error: a table must come from defineLilypadDb
      expect(() => new LilypadDbTable(gate, schema)).toThrow(
        'LilypadDbTable: the table must be a table of a config made with defineLilypadDb'
      );
      await gate.close();
    });
  });

  it.each([
    [{ statementTimeout: 2 ** 31 }, 'statementTimeout must be'],
    [{ statementTimeout: Number.NaN }, 'statementTimeout must be'],
    // postgres.js would open no connection, and every query would wait forever
    [{ pool: { max: 0 } }, 'pool.max must be'],
    [{ pool: { max: 1.5 } }, 'pool.max must be'],
    [{ pool: { idleTimeout: Number.NaN } }, 'pool.idleTimeout must be'],
    [{ pool: { connectTimeout: -1 } }, 'pool.connectTimeout must be'],
    [{ pool: { maxLifetime: Infinity } }, 'pool.maxLifetime must be'],
  ])('should reject the options %o', async (options, message) => {
    await expect(
      LilypadDbGate.create({ connectionString: unreachable, ...options })
    ).rejects.toThrow(message);
  });

  it('should accept the pool timeouts of 0, which postgres.js takes for never', async () => {
    const gate = await LilypadDbGate.create({
      connectionString: unreachable,
      pool: { idleTimeout: 0, connectTimeout: 0, maxLifetime: 0 },
    });

    expect(gate.sql.options).toMatchObject({
      idle_timeout: 0,
      connect_timeout: 0,
      max_lifetime: 0,
    });
    await gate.close();
  });

  it.each([['a'.repeat(64)], ['']])(
    'should reject a listener on the channel %j, whose notifications would never arrive',
    async (channel) => {
      const gate = await LilypadDbGate.create({ connectionString: unreachable });

      await expect(
        gate.addListener({ channel, callbackId: 'a', callback: () => {} })
      ).rejects.toThrow('LilypadDbGate: the channel');
      await gate.close();
    }
  );

  it('should reject a listenHeartbeat that a timer cannot hold', async () => {
    await expect(
      LilypadDbGate.create({ connectionString: unreachable, listenHeartbeat: 2 ** 31 })
    ).rejects.toThrow('listenHeartbeat must be');
  });
});
