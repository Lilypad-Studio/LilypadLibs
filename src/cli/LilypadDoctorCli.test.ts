import { describe, it, expect, vi } from 'vitest';
import { parseLilypadDoctorArgs, runLilypadDoctorCli } from './LilypadDoctorCli';
import type { LilypadDoctorReport } from '@/dbGate/LilypadDoctor';
import { defineLilypadDb, defineLilypadTable } from '@/dbConfig/LilypadDbConfig';

const url = 'postgres://user:password@localhost/app';

function output() {
  return { log: vi.fn(), error: vi.fn() };
}

const config = defineLilypadDb({
  tables: {
    users: defineLilypadTable<{ id: number }, 'id'>({
      tableName: 'users',
      primaryKey: 'id',
      cols: { id: { type: 'number' } },
    }),
  },
});
const load = vi.fn(async () => ({ path: '/app/lilypad.config.ts', config }));

const report = (ok: boolean): LilypadDoctorReport => ({
  ok,
  config: 'default',
  problems: ok
    ? []
    : [
        {
          code: 'missing-table',
          severity: 'error',
          table: 'public.users',
          message: 'missing',
          fix: 'CREATE TABLE users ();',
        },
        {
          code: 'missing-index',
          severity: 'warning',
          table: 'public.users',
          message: 'no index',
          fix: 'CREATE INDEX ON users (id);',
        },
      ],
  tables: [{ table: 'public.users', schema: ok ? 'public' : null }],
  text: ok ? 'lilypad-doctor: the database is set up.' : 'lilypad-doctor: not set up',
  assertOk: () => {},
});

describe('parseLilypadDoctorArgs', () => {
  it('should read the config, the connection string and the output format', () => {
    expect(parseLilypadDoctorArgs(['--url', url, '--config', 'analytics', '--sql'], {})).toEqual({
      help: false,
      json: false,
      sql: true,
      connectionString: url,
      config: 'analytics',
    });
  });

  it('should take the connection string from DATABASE_URL, and the default config', () => {
    expect(parseLilypadDoctorArgs([], { DATABASE_URL: url })).toEqual({
      help: false,
      json: false,
      sql: false,
      connectionString: url,
      config: undefined,
    });
  });

  it.each([
    [[], 'Pass --url'],
    [['--url', url, '--sql', '--json'], 'cannot be used together'],
    [['--url', url, '--config', ' '], '--config needs'],
    [['--url', url, '--table', 'users'], "Unknown option '--table'"],
  ])('should reject %o', (argv, message) => {
    expect(() => parseLilypadDoctorArgs(argv, {})).toThrow(message);
  });
});

describe('runLilypadDoctorCli', () => {
  it('should print the help and exit with 0', async () => {
    const out = output();

    await expect(runLilypadDoctorCli(['--help'], {}, out)).resolves.toBe(0);
    expect(out.log).toHaveBeenCalledWith(expect.stringContaining('Usage: lilypad-doctor'));
  });

  it('should exit with 2 and the usage on invalid arguments, without checking', async () => {
    const out = output();
    const run = vi.fn();

    await expect(runLilypadDoctorCli([], {}, out, { run, load })).resolves.toBe(2);
    expect(out.error).toHaveBeenCalledWith(expect.stringContaining('Usage: lilypad-doctor'));
    expect(run).not.toHaveBeenCalled();
  });

  it('should load the config named by --config, and check the database against it', async () => {
    const out = output();
    const run = vi.fn(async () => report(true));

    await expect(
      runLilypadDoctorCli(['--url', url, '--config', 'analytics'], {}, out, { run, load })
    ).resolves.toBe(0);
    expect(load).toHaveBeenCalledWith({ config: 'analytics' });
    expect(run).toHaveBeenCalledWith({ connectionString: url, config });
  });

  it('should exit with 2 when the config cannot be loaded, without checking', async () => {
    const out = output();
    const run = vi.fn();
    const failing = async () => {
      throw new Error('No config "analytics" in /app');
    };

    await expect(
      runLilypadDoctorCli(['--url', url, '--config', 'analytics'], {}, out, { run, load: failing })
    ).resolves.toBe(2);
    expect(out.error).toHaveBeenCalledWith('lilypad-doctor: No config "analytics" in /app');
    expect(run).not.toHaveBeenCalled();
  });

  it('should exit with 0 when the database is set up, and 1 when it is not', async () => {
    const out = output();

    await expect(
      runLilypadDoctorCli(['--url', url], {}, out, { run: async () => report(true), load })
    ).resolves.toBe(0);
    await expect(
      runLilypadDoctorCli(['--url', url], {}, out, { run: async () => report(false), load })
    ).resolves.toBe(1);
    expect(out.log).toHaveBeenCalledWith('lilypad-doctor: the database is set up.');
    expect(out.error).toHaveBeenCalledWith('lilypad-doctor: not set up');
  });

  it('should print the result as JSON with --json', async () => {
    const out = output();

    await runLilypadDoctorCli(['--url', url, '--json'], {}, out, {
      run: async () => report(false),
      load,
    });

    const printed = JSON.parse(out.log.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(printed).toMatchObject({
      ok: false,
      config: 'default',
      problems: [{ code: 'missing-table' }, { code: 'missing-index' }],
    });
    expect(printed).not.toHaveProperty('text');
  });

  it('should print only the SQL of the fixes with --sql', async () => {
    const out = output();

    await expect(
      runLilypadDoctorCli(['--url', url, '--sql'], {}, out, {
        run: async () => report(false),
        load,
      })
    ).resolves.toBe(1);
    await runLilypadDoctorCli(['--url', url, '--sql'], {}, out, {
      run: async () => report(true),
      load,
    });

    expect(out.log.mock.calls).toEqual([
      ['CREATE TABLE users ();\nCREATE INDEX ON users (id);'],
      ['-- lilypad-doctor: nothing to fix.'],
    ]);
  });

  it('should exit with 2 when the database cannot be reached', async () => {
    const out = output();

    await expect(
      runLilypadDoctorCli(['--url', url], {}, out, {
        run: async () => {
          throw new Error('connect ECONNREFUSED');
        },
        load,
      })
    ).resolves.toBe(2);
    expect(out.error).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
  });
});
