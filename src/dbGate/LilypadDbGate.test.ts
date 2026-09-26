import { afterEach, describe, it, expect, vi } from 'vitest';
import { LilypadDbGate, lilypadServerlessPool } from './LilypadDbGate';

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
      const schema = { tableName: 'items', primaryKey: 'id' as const, cols: { id: {} } };

      const closing = gate.close();

      expect(gate.close()).toBe(closing);
      await closing;
      expect(gate.closed).toBe(true);
      await expect(gate.selectFromTableByPrimaryKey(schema, 1)).rejects.toThrow('is closed');
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
