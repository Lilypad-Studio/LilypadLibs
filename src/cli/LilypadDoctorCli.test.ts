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
      failOnWarnings: false,
      connectionString: url,
      config: 'analytics',
    });
  });

  it('should take the connection string from DATABASE_URL, and the default config', () => {
    expect(parseLilypadDoctorArgs([], { DATABASE_URL: url })).toEqual({
      help: false,
      json: false,
      sql: false,
      failOnWarnings: false,
      connectionString: url,
      config: undefined,
    });
  });

  const files: Record<string, Record<string, string>> = {
    '.env': { POSTGRES_URL: url, DATABASE_URL: 'postgres://from/env' },
    '.env.local': { POSTGRES_URL: 'postgres://from/local' },
  };
  const readEnv = (path: string) => {
    const variables = files[path];
    if (!variables) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
    return variables;
  };
  const connectionOf = (argv: string[], env: Record<string, string | undefined> = {}) => {
    const parsed = parseLilypadDoctorArgs(argv, env, readEnv);
    return parsed.help ? undefined : parsed.connectionString;
  };

  it('should take the connection string from the variable named by --url-env', () => {
    expect(connectionOf(['--url-env', 'POSTGRES_URL'], { POSTGRES_URL: url })).toBe(url);
  });

  it('should read the variables of --env-file, the later files winning', () => {
    expect(connectionOf(['--env-file', '.env'])).toBe('postgres://from/env');
    expect(connectionOf(['--env-file', '.env', '--url-env', 'POSTGRES_URL'])).toBe(url);
    expect(
      connectionOf(['--env-file', '.env', '--env-file', '.env.local', '--url-env', 'POSTGRES_URL'])
    ).toBe('postgres://from/local');
  });

  it('should prefer the environment and --url to the env files', () => {
    expect(connectionOf(['--env-file', '.env'], { DATABASE_URL: url })).toBe(url);
    expect(connectionOf(['--env-file', '.env', '--url', 'postgres://flag'])).toBe(
      'postgres://flag'
    );
  });

  it.each([
    [['--env-file', 'missing.env'], 'Cannot read the env file missing.env: ENOENT'],
    [
      ['--env-file', '.env.local'],
      'Pass --url, or set DATABASE_URL (neither in the environment nor in .env.local).',
    ],
    [['--url-env', 'OTHER_URL'], 'The environment variable OTHER_URL is not set.'],
    [['--url', url, '--url-env', 'POSTGRES_URL'], 'cannot be used together'],
    [['--url-env', ' '], '--url-env needs'],
  ])('should reject %o', (argv, message) => {
    expect(() => parseLilypadDoctorArgs(argv, {}, readEnv)).toThrow(message);
  });

  it.each([
    [[], 'Pass --url'],
    [['--url', url, '--sql', '--json'], 'cannot be used together'],
    [['--url', url, '--config', ' '], '--config needs'],
    // The invalid flags first, before the database URL
    [['--sql', '--json'], '--sql and --json cannot be used together.'],
    [['--config', ''], '--config needs'],
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

  it('should read the connection string from the env file given by --env-file', async () => {
    const out = output();
    const run = vi.fn(async () => report(true));
    const readEnv = vi.fn(() => ({ POSTGRES_URL: url }));

    await expect(
      runLilypadDoctorCli(['--env-file', '.env', '--url-env', 'POSTGRES_URL'], {}, out, {
        run,
        load,
        readEnv,
      })
    ).resolves.toBe(0);
    expect(readEnv).toHaveBeenCalledWith('.env');
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

  it('should exit with 1 on warnings with --fail-on-warnings', async () => {
    const out = output();
    const warned: LilypadDoctorReport = {
      ...report(true),
      problems: [
        {
          code: 'missing-index',
          severity: 'warning',
          table: 'public.users',
          message: 'no index',
          fix: 'CREATE INDEX ON users (id);',
        },
      ],
      text: 'lilypad-doctor: the database is set up, with warnings.',
    };
    const run = async () => warned;

    await expect(runLilypadDoctorCli(['--url', url], {}, out, { run, load })).resolves.toBe(0);
    expect(out.log).toHaveBeenCalledWith(warned.text);
    await expect(
      runLilypadDoctorCli(['--url', url, '--fail-on-warnings'], {}, out, { run, load })
    ).resolves.toBe(1);
    expect(out.error).toHaveBeenCalledWith(warned.text);
    await expect(
      runLilypadDoctorCli(['--url', url, '--fail-on-warnings', '--json'], {}, out, { run, load })
    ).resolves.toBe(1);
    await expect(
      runLilypadDoctorCli(['--url', url, '--fail-on-warnings'], {}, out, {
        run: async () => report(true),
        load,
      })
    ).resolves.toBe(0);
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
