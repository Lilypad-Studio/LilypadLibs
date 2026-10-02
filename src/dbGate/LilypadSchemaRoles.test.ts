import { describe, it, expect } from 'vitest';
import type { LilypadSchemaFacts } from './LilypadSchemaFacts';
import { lilypadRoleSetting, parseLilypadPgDuration } from './LilypadSchemaRoles';

/** The facts that the setting of a role reads: the session of `migrator`, the role `app`. */
const settingFacts = (
  roleSettings: LilypadSchemaFacts['roleSettings'],
  source = 'default',
  sessionRole = 'migrator'
) =>
  ({
    session: { role: sessionRole, settings: { statement_timeout: { value: '0', source } } },
    appRole: { name: 'app', exists: true, superuser: false, bypassRls: false },
    roleSettings,
  }) as LilypadSchemaFacts;

describe('lilypadRoleSetting', () => {
  const role = (inDatabase: boolean, value: string) => ({
    role: 'app',
    inDatabase,
    config: ['search_path=app', `statement_timeout=${value}`],
  });
  const everyRole = (inDatabase: boolean, value: string) => ({
    role: null,
    inDatabase,
    config: [`statement_timeout=${value}`],
  });

  it('should apply the settings as PostgreSQL does at login, the most specific first', () => {
    const all = [
      everyRole(false, '4s'),
      everyRole(true, '3s'),
      role(false, '2s'),
      role(true, '1s'),
    ];

    expect(lilypadRoleSetting(settingFacts(all), 'statement_timeout')).toEqual({
      value: '1s',
      source: 'database user',
    });
    expect(lilypadRoleSetting(settingFacts(all.slice(0, 3)), 'statement_timeout')).toEqual({
      value: '2s',
      source: 'user',
    });
    expect(lilypadRoleSetting(settingFacts(all.slice(0, 2)), 'statement_timeout')).toEqual({
      value: '3s',
      source: 'database',
    });
    expect(lilypadRoleSetting(settingFacts(all.slice(0, 1)), 'statement_timeout')).toEqual({
      value: '4s',
      source: 'global',
    });
  });

  it("should fall back to the session's setting only when it applies to every role", () => {
    expect(lilypadRoleSetting(settingFacts([]), 'statement_timeout')).toEqual({
      value: '0',
      source: 'default',
    });
    expect(
      lilypadRoleSetting(settingFacts([], 'configuration file'), 'statement_timeout')
    ).not.toBeNull();
    // The migration role's own setting, or its connection's
    expect(lilypadRoleSetting(settingFacts([], 'user'), 'statement_timeout')).toBeNull();
    expect(lilypadRoleSetting(settingFacts([], 'client'), 'statement_timeout')).toBeNull();
    expect(lilypadRoleSetting(settingFacts([], 'default'), 'idle_session_timeout')).toBeNull();
  });

  it('should read the session as it is when it is the role of the application', () => {
    expect(
      lilypadRoleSetting(settingFacts([role(true, '1s')], 'client', 'app'), 'statement_timeout')
    ).toEqual({ value: '0', source: 'client' });
  });
});

describe('parseLilypadPgDuration', () => {
  it.each([
    ['30000', 30_000],
    ['0', 0],
    ['30s', 30_000],
    ['1min', 60_000],
    ['2h', 7_200_000],
    ['1d', 86_400_000],
    ['500ms', 500],
    ['1500us', 1.5],
    [' 10 s ', 10_000],
    ['1.5s', 1500],
  ])('should read %s', (value, expected) => {
    expect(parseLilypadPgDuration(value)).toBe(expected);
  });

  it.each(['-1', '10 minutes', 'abc', ''])('should not read %s', (value) => {
    expect(parseLilypadPgDuration(value)).toBeNull();
  });
});
