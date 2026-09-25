import { describe, it, expect } from 'vitest';
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
});
