import { describe, it, expect } from 'vitest';
import {
  defineLilypadDb,
  defineLilypadTable,
  isLilypadDbConfig,
  isLilypadDbTableDefinition,
  resolveLilypadDbTable,
  type LilypadDbTableInputBase,
} from './LilypadDbConfig';
import { bindLilypadDbHooks } from './LilypadDbHooks';
import type { LilypadDbPartialRow } from '@/dbConfig/LilypadDbSchema';

type Org = { id: number; name: string };
type Event = { id: string; title: string };

const orgs = defineLilypadTable<Org, 'id'>({
  tableName: 'orgs',
  primaryKey: 'id',
  cols: { id: { type: 'number' }, name: { type: 'string' } },
});
const events = defineLilypadTable<Event, 'id'>({
  tableName: 'events',
  primaryKey: 'id',
  cols: { id: { type: 'string' }, title: { type: 'string' } },
  sync: { strategy: 'changelog', pollInterval: 1000 },
});

const db = defineLilypadDb({ name: 'app', notifyChannel: 'app_events', tables: { orgs, events } });

const trimTitle = (data: LilypadDbPartialRow<Event>): LilypadDbPartialRow<Event> => ({
  ...data,
  title: data.title?.trim(),
});
const toEvent = (row: Record<string, unknown>): Event | null =>
  typeof row.title === 'string' ? { id: String(row.id), title: row.title } : null;

describe('bindLilypadDbHooks', () => {
  it('should return a copy of the config whose tables carry the hooks', () => {
    const appDb = bindLilypadDbHooks(db, { events: { write: trimTitle, select: toEvent } });

    expect(isLilypadDbConfig(appDb)).toBe(true);
    expect(Object.isFrozen(appDb)).toBe(true);
    expect(appDb).toMatchObject({
      name: 'app',
      notifyChannel: 'app_events',
      changelog: db.changelog,
      strict: false,
    });
    expect(isLilypadDbTableDefinition(appDb.tables.events)).toBe(true);
    expect(appDb.tables.events.hooks).toEqual({ write: trimTitle, select: toEvent });
    expect(appDb.tables.events).toMatchObject({
      key: 'events',
      qualifiedName: 'public.events',
      sync: { strategy: 'changelog', pollInterval: 1000 },
      db: db.tables.events.db,
    });
    // A table without hooks is kept as it is
    expect(appDb.tables.orgs).toBe(db.tables.orgs);
  });

  it('should leave the original config untouched', () => {
    bindLilypadDbHooks(db, { events: { select: toEvent } });

    expect(db.tables.events.hooks).toBeUndefined();
  });

  it('should replace the hooks given and keep the others when binding again', () => {
    const upper = (row: Record<string, unknown>): Event => ({
      id: String(row.id),
      title: String(row.title).toUpperCase(),
    });
    const first = bindLilypadDbHooks(db, { events: { write: trimTitle, select: toEvent } });

    const second = bindLilypadDbHooks(first, { events: { select: upper } });

    expect(second.tables.events.hooks).toEqual({ write: trimTitle, select: upper });
    expect(first.tables.events.hooks?.select).toBe(toEvent);
  });

  it('should keep a hook bound before when it is given as undefined', () => {
    const first = bindLilypadDbHooks(db, { events: { write: trimTitle, select: toEvent } });

    const second = bindLilypadDbHooks(first, { events: { write: undefined, select: toEvent } });

    expect(second.tables.events.hooks).toEqual({ write: trimTitle, select: toEvent });
    expect(second.tables.events.hooks?.write).toBe(trimTitle);
  });

  it('should leave a table given no hook as it is', () => {
    const appDb = bindLilypadDbHooks(db, { events: { select: toEvent } });

    const none = bindLilypadDbHooks(db, { events: {}, orgs: { write: undefined } });

    expect(none.tables.events).toBe(db.tables.events);
    expect(none.tables.orgs).toBe(db.tables.orgs);
    // An empty `hooks` would hide those of the gate's config
    expect(resolveLilypadDbTable('Test', none.tables.events, appDb).hooks?.select).toBe(toEvent);
  });

  it('should type the hooks with the rows of each table', () => {
    const bound = bindLilypadDbHooks(db, {
      // @ts-expect-error: the rows of events have no `name`
      events: { select: (row) => ({ id: String(row.id), name: 'x' }) },
    });
    // @ts-expect-error: not a table of the config
    expect(() => bindLilypadDbHooks(db, { users: {} })).toThrow('has no table "users"');
    expect(bound.tables.events.hooks?.select).toBeTypeOf('function');
  });

  it.each<[string, unknown, unknown, string]>([
    [
      'a config not made by defineLilypadDb',
      { tables: {} },
      {},
      'the config must be made with defineLilypadDb',
    ],
    ['hooks that are not an object', db, null, 'the hooks must be an object'],
    ['an unknown table', db, { users: {} }, 'the config "app" has no table "users"'],
    [
      'a table name inherited from Object',
      db,
      { toString: {} },
      'the config "app" has no table "toString"',
    ],
    [
      'table hooks that are not an object',
      db,
      { events: toEvent },
      'the hooks of "events" must be an object',
    ],
    [
      'an unknown hook',
      db,
      { events: { selectSanitizationFn: toEvent } },
      '"events.selectSanitizationFn" is not a hook',
    ],
    [
      'a hook that is not a function',
      db,
      { events: { select: 'toEvent' } },
      '"events.select" must be a function',
    ],
  ])('should reject %s', (_case, config, hooks, message) => {
    expect(() => bindLilypadDbHooks(config as typeof db, hooks as never)).toThrow(
      `bindLilypadDbHooks: ${message}`
    );
  });
});

describe('the hooks of a config given to resolveLilypadDbTable', () => {
  const appDb = bindLilypadDbHooks(db, { events: { select: toEvent } });

  it('should give a definition of the original config the hooks of the bound one', () => {
    const resolved = resolveLilypadDbTable('Test', db.tables.events, appDb);

    expect(resolved.hooks).toBe(appDb.tables.events.hooks);
    expect(resolved).toMatchObject({ key: 'events', qualifiedName: 'public.events' });
    expect(isLilypadDbTableDefinition(resolved)).toBe(true);
  });

  it('should keep the hooks of the definition, and ignore the tables of another config', () => {
    const other = defineLilypadDb({ name: 'other', tables: { events } });
    const otherHooks = bindLilypadDbHooks(other, { events: { write: trimTitle } });

    expect(resolveLilypadDbTable('Test', otherHooks.tables.events, appDb)).toBe(
      otherHooks.tables.events
    );
    expect(resolveLilypadDbTable('Test', other.tables.events, appDb)).toBe(other.tables.events);
    expect(resolveLilypadDbTable('Test', db.tables.orgs, appDb)).toBe(db.tables.orgs);
    expect(resolveLilypadDbTable('Test', db.tables.events, undefined)).toBe(db.tables.events);
  });

  it('should find a table given by key in the bound config', () => {
    expect(resolveLilypadDbTable('Test', 'events', appDb).hooks?.select).toBe(toEvent);
  });
});

describe('defineLilypadDb and the functions of a table', () => {
  it.each([
    ['writeSanitizationFn', 'write'],
    ['selectSanitizationFn', 'select'],
    ['hooks', 'write, select'],
  ])('should reject %s, which the application binds instead', (field, hook) => {
    const table = { ...(events as LilypadDbTableInputBase), [field]: () => null };

    expect(() => defineLilypadDb({ tables: { events: table } })).toThrow(
      `defineLilypadDb: tables.events.${field}: a config holds no functions`
    );
    expect(() => defineLilypadDb({ tables: { events: table } })).toThrow(
      `bindLilypadDbHooks(db, { events: { ${hook} } })`
    );
  });
});
