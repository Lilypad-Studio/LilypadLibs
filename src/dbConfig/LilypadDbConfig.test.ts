import { describe, it, expect } from 'vitest';
import {
  defineLilypadDb,
  defineLilypadTable,
  isLilypadDbConfig,
  isLilypadDbTableDefinition,
  resolveLilypadDbTable,
  type LilypadDbRow,
  type LilypadDbTableInputBase,
} from './LilypadDbConfig';

type Org = { id: number; name: string };
type User = { id: string; orgId: number; email: string; managerId: string | null };

const orgs = defineLilypadTable<Org, 'id'>({
  tableName: 'orgs',
  primaryKey: 'id',
  cols: { id: { type: 'number', pgType: 'int4' }, name: { type: 'string' } },
});

const users = defineLilypadTable<User, 'id'>({
  tableName: 'users',
  primaryKey: 'id',
  cols: {
    id: { type: 'string', pgType: 'uuid', default: { sql: 'gen_random_uuid()' } },
    orgId: { type: 'number', references: { table: 'orgs', onDelete: 'cascade' } },
    email: { type: 'string', unique: true },
    managerId: { type: 'string', nullable: true },
  },
  foreignKeys: [{ columns: ['managerId'], references: { table: 'users', onDelete: 'set null' } }],
  unique: [{ name: 'users_org_email', columns: ['orgId', 'email'] }],
  indexes: [{ columns: ['orgId'] }, { columns: ['email'], using: 'hash' }],
  checks: [{ name: 'users_email_check', expression: "email LIKE '%@%'" }],
  sync: { strategy: 'changelog', pollInterval: 1000 },
});

describe('defineLilypadDb', () => {
  it('should resolve the tables: names, schemas, sync, and the settings of the config', () => {
    const db = defineLilypadDb({ tables: { orgs, users } });

    expect(isLilypadDbConfig(db)).toBe(true);
    expect(db).toMatchObject({
      name: 'default',
      defaultSchema: 'public',
      notifyChannel: 'cache_events',
      changelog: { table: 'lilypad_cache_changes', pruning: 'detect', minRetention: 3_600_000 },
      strict: false,
    });
    expect(isLilypadDbTableDefinition(db.tables.users)).toBe(true);
    expect(db.tables.orgs).toMatchObject({
      key: 'orgs',
      tableName: 'orgs',
      schemaName: 'public',
      qualifiedName: 'public.orgs',
      sync: { strategy: 'listen' },
      db: {
        name: 'default',
        notifyChannel: 'cache_events',
        changelogTable: 'lilypad_cache_changes',
      },
    });
    expect(db.tables.users.sync).toEqual({ strategy: 'changelog', pollInterval: 1000 });
    expect(Object.isFrozen(db.tables.users)).toBe(true);
  });

  it('should gather the keys, foreign keys and indexes, with their defaults', () => {
    const { tables } = defineLilypadDb({ tables: { orgs, users } });

    expect(tables.users.unique).toEqual([
      { columns: ['email'] },
      { name: 'users_org_email', columns: ['orgId', 'email'] },
    ]);
    expect(tables.users.foreignKeys).toEqual([
      {
        columns: ['orgId'],
        references: { table: 'public.orgs', columns: ['id'] },
        onDelete: 'cascade',
        onUpdate: 'no action',
      },
      {
        name: undefined,
        columns: ['managerId'],
        references: { table: 'public.users', columns: ['id'] },
        onDelete: 'set null',
        onUpdate: 'no action',
      },
    ]);
    expect(tables.users.indexes).toEqual([
      { name: undefined, columns: ['orgId'], unique: false, using: 'btree' },
      { name: undefined, columns: ['email'], unique: false, using: 'hash' },
    ]);
    expect(tables.users.checks).toEqual([
      { name: 'users_email_check', expression: "email LIKE '%@%'" },
    ]);
  });

  it('should resolve the references to tables outside the config against the default schema', () => {
    const { tables } = defineLilypadDb({
      defaultSchema: 'app',
      tables: {
        items: {
          tableName: 'items',
          primaryKey: 'id',
          cols: {
            id: {},
            ownerId: { references: { table: 'auth.users', column: 'uid' } },
            countryCode: { references: { table: 'countries', column: 'code' } },
          },
        },
      },
    });

    expect(tables.items.qualifiedName).toBe('app.items');
    expect(tables.items.foreignKeys.map((foreignKey) => foreignKey.references)).toEqual([
      { table: 'auth.users', columns: ['uid'] },
      { table: 'app.countries', columns: ['code'] },
    ]);
  });

  it('should resolve a name shared by several schemas to the table of the default schema', () => {
    const { tables } = defineLilypadDb({
      tables: {
        archived: { tableName: 'archive.orgs', primaryKey: 'code', cols: { code: {} } },
        orgs,
        members: {
          tableName: 'members',
          primaryKey: 'id',
          cols: { id: {}, orgId: { references: { table: 'orgs' } } },
        },
      },
    });

    expect(tables.members.foreignKeys[0]!.references).toEqual({
      table: 'public.orgs',
      columns: ['id'],
    });
  });

  it('should take the schema from a qualified name or from schemaName', () => {
    const { tables } = defineLilypadDb({
      tables: {
        a: { tableName: 'billing.a', primaryKey: 'id', cols: { id: {} } },
        b: { tableName: 'b', schemaName: 'audit', primaryKey: 'id', cols: { id: {} } },
      },
    });

    expect(tables.a).toMatchObject({ tableName: 'a', schemaName: 'billing' });
    expect(tables.b).toMatchObject({ tableName: 'b', schemaName: 'audit' });
  });

  it('should apply strict per table, over the config', () => {
    const { tables } = defineLilypadDb({
      strict: true,
      tables: { orgs, loose: { ...orgs, tableName: 'loose', strict: false } },
    });

    expect(tables.orgs.strict).toBe(true);
    expect(tables.loose.strict).toBe(false);
  });

  it('should infer the row types of the tables', () => {
    const db = defineLilypadDb({
      tables: {
        orgs,
        users,
        plain: { tableName: 'plain', primaryKey: 'id', cols: { id: {}, n: {} } },
      },
    });
    const user: LilypadDbRow<typeof db, 'users'> = {
      id: 'u1',
      orgId: 1,
      email: 'a@b.c',
      managerId: null,
    };
    const plain: LilypadDbRow<typeof db, 'plain'> = { id: 1, n: 'anything' };
    // @ts-expect-error: not a column of the row type
    const wrong: LilypadDbRow<typeof db, 'users'> = { ...user, extra: true };

    expect([user, plain, wrong]).toHaveLength(3);
    expect(db.tables.plain.primaryKey).toBe('id');
  });

  it('should give each column the type of its pgType, unless it declares one', () => {
    const { tables } = defineLilypadDb({
      tables: {
        items: {
          tableName: 'items',
          primaryKey: 'id',
          cols: {
            id: { pgType: 'int4' },
            big: { pgType: 'int8' },
            code: { type: 'string', pgType: 'int8' },
            role: { type: 'string', pgType: 'user_role' },
            mood: { pgType: 'mood' },
            loose: {},
          },
        },
      },
    });

    expect(tables.items.cols).toEqual({
      id: { type: 'number', pgType: 'int4' },
      big: { type: 'bigint', pgType: 'int8' },
      code: { type: 'string', pgType: 'int8' },
      role: { type: 'string', pgType: 'user_role' },
      mood: { pgType: 'mood' },
      loose: {},
    });
  });

  it('should check the columns against the row type', () => {
    type Row = {
      id: number;
      big: string;
      at: Date | null;
      tags: string[];
      data: { a: number };
      role: 'admin' | 'user';
      iso: string;
      free: unknown;
    };
    const table = defineLilypadTable<Row, 'id'>({
      tableName: 'rows',
      primaryKey: 'id',
      cols: {
        id: { pgType: 'serial' },
        big: { pgType: 'int8' },
        at: { pgType: 'timestamp(3) with time zone', nullable: true },
        tags: { pgType: 'text[]' },
        data: { pgType: 'jsonb' },
        role: { type: 'string', pgType: 'user_role' },
        iso: { pgType: 'timestamptz', converted: true },
        free: { pgType: 'bytea', converted: true },
      },
    });

    defineLilypadTable<Row, 'id'>({
      ...table,
      // @ts-expect-error: postgres.js returns an int8 as a string
      cols: { ...table.cols, id: { pgType: 'int8' } },
    });
    defineLilypadTable<Row, 'id'>({
      ...table,
      // @ts-expect-error: an int4 is not a string
      cols: { ...table.cols, big: { pgType: 'int4' } },
    });
    defineLilypadTable<Row, 'id'>({
      ...table,
      // @ts-expect-error: a string is not a number
      cols: { ...table.cols, id: { type: 'string' } },
    });
    defineLilypadTable<Row, 'id'>({
      ...table,
      // @ts-expect-error: the type of an enum must be declared
      cols: { ...table.cols, role: { pgType: 'user_role' } },
    });
    defineLilypadTable<Row, 'id'>({
      ...table,
      // @ts-expect-error: a timestamptz is a Date, unless the hooks convert it
      cols: { ...table.cols, iso: { pgType: 'timestamptz' } },
    });

    expect(defineLilypadDb({ tables: { table } }).tables.table.cols.id.type).toBe('number');
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['a name with a dot', { name: 'a.b' }, 'name must contain only'],
    [
      'an unknown pruning',
      { changelog: { pruning: 'weekly' } },
      'changelog.pruning must be one of',
    ],
    ['a negative retention', { changelog: { minRetention: -1 } }, 'changelog.minRetention must be'],
    ['an empty notify channel', { notifyChannel: '' }, 'notifyChannel must be a non-empty string'],
  ])('should reject %s', (_case, config, message) => {
    expect(() => defineLilypadDb({ ...config, tables: { orgs } })).toThrow(message);
  });

  it.each<[string, Partial<LilypadDbTableInputBase>, string]>([
    [
      'a primary key that is not a column',
      { primaryKey: 'uid' },
      'primaryKey "uid" is not a column',
    ],
    ['no columns', { cols: {} }, 'cols must describe at least one column'],
    ['a table name with two dots', { tableName: 'a.b.c' }, 'must be "table" or "schema.table"'],
    [
      'a schema given twice',
      { tableName: 'app.orgs', schemaName: 'app' },
      'give the schema in tableName or in schemaName',
    ],
    [
      'an unknown column type',
      { cols: { id: { type: 'uuid' as never } } },
      'cols.id.type must be one of',
    ],
    [
      'a type that does not fit the pgType',
      { cols: { id: { type: 'string', pgType: 'int4' } } },
      'cols.id.type "string" does not fit its pgType "int4", which postgres.js returns as number: declare "number", or leave type out.',
    ],
    [
      'a converted flag that is not a boolean',
      { cols: { id: { converted: 'yes' as never } } },
      'cols.id.converted must be a boolean',
    ],
    [
      'a default that is not SQL',
      { cols: { id: { default: 0 as never } } },
      'default must be true or',
    ],
    ['a unique key on an unknown column', { unique: [{ columns: ['nope'] }] }, 'names "nope"'],
    ['an index without columns', { indexes: [{ columns: [] }] }, 'must list at least one column'],
    [
      'an unknown index method',
      { indexes: [{ columns: ['id'], using: 'bloom' as never }] },
      'using must be one of',
    ],
    [
      'an unknown action',
      {
        foreignKeys: [
          {
            columns: ['id'],
            references: { table: 'x', columns: ['id'], onDelete: 'drop' as never },
          },
        ],
      },
      'onDelete must be one of',
    ],
    [
      'two checks of the same name',
      { checks: [{ name: 'c' }, { name: 'c' }] },
      'two checks named "c"',
    ],
    [
      'a changelog sync without pollInterval',
      { sync: { strategy: 'changelog' } as never },
      'pollInterval is required',
    ],
    [
      'a negative maxGap',
      { sync: { strategy: 'changelog', pollInterval: 0, maxGap: -1 } },
      'sync.maxGap must be',
    ],
    [
      'an unknown strategy',
      { sync: { strategy: 'poll' } as never },
      'sync.strategy must be one of',
    ],
  ])('should reject a table with %s', (_case, changes, message) => {
    expect(() =>
      defineLilypadDb({ tables: { orgs: { ...(orgs as LilypadDbTableInputBase), ...changes } } })
    ).toThrow(message);
  });

  it('should reject two keys for the same table', () => {
    expect(() =>
      defineLilypadDb({
        tables: { orgs, again: { ...orgs, tableName: 'public.orgs' } },
      })
    ).toThrow('tables.orgs and tables.again are both the table "public.orgs"');
  });

  it('should reject a foreign key whose columns do not match the referenced ones', () => {
    expect(() =>
      defineLilypadDb({
        tables: {
          orgs,
          users: {
            ...(users as LilypadDbTableInputBase),
            foreignKeys: [{ columns: ['orgId', 'email'], references: { table: 'orgs' } }],
          },
        },
      })
    ).toThrow('has 2 columns, but references 1');
  });

  it('should require the referenced columns of a table outside the config', () => {
    expect(() =>
      defineLilypadDb({
        tables: {
          items: {
            tableName: 'items',
            primaryKey: 'id',
            cols: { id: { references: { table: 'elsewhere' } } },
          },
        },
      })
    ).toThrow(
      'references "elsewhere", which is not a table of the config: give the referenced columns'
    );
  });
});

describe('resolveLilypadDbTable', () => {
  const db = defineLilypadDb({ tables: { orgs } });

  it('should take a definition, or the key of a table of the config', () => {
    expect(resolveLilypadDbTable('Test', db.tables.orgs, undefined)).toBe(db.tables.orgs);
    expect(resolveLilypadDbTable('Test', 'orgs', db)).toBe(db.tables.orgs);
  });

  it('should reject a name without a config, an unknown name, or a plain description', () => {
    expect(() => resolveLilypadDbTable('Test', 'orgs', undefined)).toThrow(
      'Test: the table "orgs" is given by name, but there is no config'
    );
    expect(() => resolveLilypadDbTable('Test', 'toString', db)).toThrow(
      'the config "default" has no table "toString"'
    );
    expect(() => resolveLilypadDbTable('Test', orgs, db)).toThrow(
      'must be a table of a config made with defineLilypadDb'
    );
  });
});
