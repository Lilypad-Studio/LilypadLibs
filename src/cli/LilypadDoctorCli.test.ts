import { describe, it, expect, vi } from 'vitest';
import { parseLilypadDoctorArgs, runLilypadDoctorCli } from './LilypadDoctorCli';
import type { LilypadDoctorReport } from '@/dbGate/LilypadDoctor';

const url = 'postgres://user:password@localhost/app';

function output() {
  return { log: vi.fn(), error: vi.fn() };
}

const report = (ok: boolean): LilypadDoctorReport => ({
  ok,
  problems: ok
    ? []
    : [{ code: 'missing-table', severity: 'error', table: 'users', message: 'missing' }],
  tables: [{ table: 'users', schema: ok ? 'public' : null }],
  text: ok ? 'lilypad-doctor: the database is set up.' : 'lilypad-doctor: not set up',
});

describe('parseLilypadDoctorArgs', () => {
  it('should read the tables, their primary keys and the changelog options', () => {
    const parsed = parseLilypadDoctorArgs(
      [
        '--url',
        url,
        '--table',
        'users',
        '--table',
        'archive.orders:order_id',
        '--changelog-table',
        'audit.changes',
        '--pruning',
        'cron',
        '--min-retention',
        '7200000',
        '--notify-channel',
        'cache_events',
      ],
      {}
    );

    expect(parsed).toEqual({
      help: false,
      json: false,
      options: {
        connectionString: url,
        tables: [
          { table: 'users', primaryKey: 'id' },
          { table: 'archive.orders', primaryKey: 'order_id' },
        ],
        changelog: { table: 'audit.changes', pruning: 'cron', minRetention: 7_200_000 },
        notifyChannel: 'cache_events',
      },
    });
  });

  it('should take the connection string from DATABASE_URL, and skip the changelog on request', () => {
    const parsed = parseLilypadDoctorArgs(['--no-changelog'], { DATABASE_URL: url });

    expect(parsed).toMatchObject({
      help: false,
      options: { connectionString: url, tables: [], changelog: false, notifyChannel: false },
    });
  });

  it.each([
    [[], 'Pass --url'],
    [['--url', url, '--pruning', 'weekly'], '--pruning must be one of'],
    [['--url', url, '--min-retention', 'soon'], '--min-retention must be'],
    [['--url', url, '--no-changelog', '--changelog-table', 'c'], 'cannot be used together'],
    [['--url', url, '--unknown'], "Unknown option '--unknown'"],
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

    await expect(runLilypadDoctorCli([], {}, out, run)).resolves.toBe(2);
    expect(out.error).toHaveBeenCalledWith(expect.stringContaining('Usage: lilypad-doctor'));
    expect(run).not.toHaveBeenCalled();
  });

  it('should exit with 0 when the database is set up, and 1 when it is not', async () => {
    const out = output();

    await expect(
      runLilypadDoctorCli(['--url', url], {}, out, async () => report(true))
    ).resolves.toBe(0);
    await expect(
      runLilypadDoctorCli(['--url', url], {}, out, async () => report(false))
    ).resolves.toBe(1);
    expect(out.log).toHaveBeenCalledWith('lilypad-doctor: the database is set up.');
    expect(out.error).toHaveBeenCalledWith('lilypad-doctor: not set up');
  });

  it('should print the result as JSON with --json', async () => {
    const out = output();

    await runLilypadDoctorCli(['--url', url, '--json'], {}, out, async () => report(false));

    const printed = JSON.parse(out.log.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(printed).toMatchObject({ ok: false, problems: [{ code: 'missing-table' }] });
    expect(printed).not.toHaveProperty('text');
  });

  it('should exit with 2 when the database cannot be reached', async () => {
    const out = output();

    await expect(
      runLilypadDoctorCli(['--url', url], {}, out, async () => {
        throw new Error('connect ECONNREFUSED');
      })
    ).resolves.toBe(2);
    expect(out.error).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
  });
});
