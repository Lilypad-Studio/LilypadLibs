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
      maxStatementTimeout: 60_000,
    });
    expect(
      defineLilypadDb({ maxStatementTimeout: false, tables: { orgs } }).maxStatementTimeout
    ).toBe(false);
    expect(db.appRole).toBeUndefined();
    expect(defineLilypadDb({ appRole: 'app_user', tables: { orgs } }).appRole).toBe('app_user');
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

  it('should resolve a name of the config in another schema to its only table of that name', () => {
    const { tables } = defineLilypadDb({
      tables: {
        archived: { tableName: 'archive.orgs', primaryKey: 'code', cols: { code: {} } },
        members: {
          tableName: 'members',
          primaryKey: 'id',
          cols: { id: {}, orgCode: { references: { table: 'orgs' } } },
        },
      },
    });

    expect(tables.members.foreignKeys[0]!.references).toEqual({
      table: 'archive.orgs',
      columns: ['code'],
    });
  });

  it('should reject a name that several schemas share, none of them the default one', () => {
    expect(() =>
      defineLilypadDb({
        tables: {
          archived: { tableName: 'archive.orgs', primaryKey: 'id', cols: { id: {} } },
          audited: { tableName: 'audit.orgs', primaryKey: 'code', cols: { code: {} } },
          members: {
            tableName: 'members',
            primaryKey: 'id',
            cols: { id: {}, orgId: { references: { table: 'orgs' } } },
          },
        },
      })
    ).toThrow(
      'defineLilypadDb: the table "members" (column "orgId") references "orgs", which is a table of several schemas (archive.orgs, audit.orgs): qualify it.'
    );
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

    // The spellings of PostgreSQL that the types know without a `type`
    const spellings = defineLilypadTable<
      {
        id: number;
        amount: string;
        price: string;
        flag: string;
        code: string;
        padded: string;
        sizes: number[];
        counts: number[];
        grid: number[];
      },
      'id'
    >({
      tableName: 'spellings',
      primaryKey: 'id',
      cols: {
        id: { pgType: 'int4' },
        amount: { pgType: 'numeric(10)' },
        price: { pgType: 'dec(10,2)' },
        flag: { pgType: 'bit' },
        code: { pgType: 'char varying(10)' },
        padded: { pgType: 'bpchar' },
        sizes: { pgType: 'int[3]' },
        counts: { pgType: 'integer array' },
        grid: { pgType: 'int array[4]' },
      },
    });
    defineLilypadTable<{ id: number; price: number }, 'id'>({
      tableName: 'prices',
      primaryKey: 'id',
      // @ts-expect-error: postgres.js returns a numeric as a string
      cols: { id: { pgType: 'int4' }, price: { pgType: 'dec(10,2)' } },
    });

    defineLilypadTable<{ id: number; note?: string }, 'id'>({
      tableName: 'notes',
      primaryKey: 'id',
      // @ts-expect-error: an optional property of the row type needs its column too
      cols: { id: { pgType: 'int4' } },
    });

    expect(defineLilypadDb({ tables: { table } }).tables.table.cols.id.type).toBe('number');
    expect(defineLilypadDb({ tables: { spellings } }).tables.spellings.cols).toMatchObject({
      amount: { type: 'string' },
      price: { type: 'string' },
      flag: { type: 'string' },
      code: { type: 'string' },
      padded: { type: 'string' },
      sizes: { type: 'array' },
      counts: { type: 'array' },
      grid: { type: 'array' },
    });
  });

  it('should freeze the definitions, with copies of what they take from the input', () => {
    const email: { type: 'string'; unique: boolean } = { type: 'string', unique: true };
    const input = defineLilypadTable<User, 'id'>({ ...users, cols: { ...users.cols, email } });
    const { users: definition } = defineLilypadDb({ tables: { orgs, users: input } }).tables;

    expect(Object.isFrozen(definition.cols)).toBe(true);
    expect(Object.isFrozen(definition.cols.email)).toBe(true);
    expect(Object.isFrozen(definition.cols.orgId.references)).toBe(true);
    expect(Object.isFrozen(definition.cols.id.default)).toBe(true);
    const lists = [
      definition.unique,
      definition.foreignKeys,
      definition.indexes,
      definition.checks,
    ];
    for (const list of lists) {
      expect(Object.isFrozen(list)).toBe(true);
      expect(list.every((item) => Object.isFrozen(item))).toBe(true);
    }
    expect(Object.isFrozen(definition.foreignKeys[0]!.columns)).toBe(true);
    expect(Object.isFrozen(definition.foreignKeys[0]!.references)).toBe(true);
    expect(Object.isFrozen(definition.foreignKeys[0]!.references.columns)).toBe(true);
    expect(Object.isFrozen(definition.indexes[0]!.columns)).toBe(true);

    email.unique = false;

    expect(definition.cols.email.unique).toBe(true);
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
    ['a misspelled option', { notifyChanel: 'events' }, 'notifyChanel is not an option'],
    ['a changelog that is not an object', { changelog: null }, 'changelog must be an object'],
    [
      'a misspelled changelog option',
      { changelog: { tabel: 'x' } },
      'changelog.tabel is not an option',
    ],
    ['a strict flag that is not a boolean', { strict: 'yes' }, 'strict must be a boolean'],
    ['a maxStatementTimeout of 0', { maxStatementTimeout: 0 }, 'maxStatementTimeout must be'],
    ['a maxStatementTimeout of true', { maxStatementTimeout: true }, 'maxStatementTimeout must be'],
    ['an empty appRole', { appRole: '' }, 'appRole must be a non-empty string'],
    ['an appRole longer than 63 bytes', { appRole: 'r'.repeat(64) }, 'longer than 63 bytes'],
    ['a schema with a dot', { defaultSchema: 'a.b' }, 'defaultSchema must not contain a dot'],
    ['a channel longer than 63 bytes', { notifyChannel: 'c'.repeat(64) }, 'longer than 63 bytes'],
    [
      'a channel that postgres.js cannot listen to',
      { notifyChannel: 'constructor' },
      'notifyChannel cannot be "constructor"',
    ],
    [
      'a channel that the changelog SQL reserves',
      { notifyChannel: 'app__lilypad_events' },
      'notifyChannel cannot contain "__lilypad_"',
    ],
    [
      'a changelog table with two dots',
      { changelog: { table: 'a.b.c' } },
      'changelog.table must be "table" or "schema.table"',
    ],
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
    [
      'a misspelled option',
      { generatedPrimarykey: true } as never,
      'tables.orgs.generatedPrimarykey is not an option',
    ],
    [
      'a misspelled column option',
      { cols: { id: { nullabel: true } as never } },
      'tables.orgs.cols.id.nullabel is not an option',
    ],
    [
      'an option of another strategy',
      { sync: { strategy: 'listen', pollInterval: 5 } as never },
      'tables.orgs.sync.pollInterval is not an option',
    ],
    [
      'a sync without strategy',
      { sync: { pollInterval: 5 } as never },
      'sync.strategy is required',
    ],
    ['a sync that is not an object', { sync: null as never }, 'sync must be an object'],
    ['a check that is not an object', { checks: [null as never] }, 'checks[0] must be an object'],
    ['unique keys that are not a list', { unique: 'id' as never }, 'unique must be an array'],
    [
      'a unique flag that is not a boolean',
      { cols: { id: { unique: 'no' as never } } },
      'cols.id.unique must be a boolean',
    ],
    [
      'a generatedPrimaryKey that is not a boolean',
      { generatedPrimaryKey: 1 as never },
      'generatedPrimaryKey must be a boolean',
    ],
    [
      'a default with another option',
      { cols: { id: { default: { sql: 'now()', when: 'insert' } as never } } },
      'default must be true or',
    ],
    ['a column listed twice', { unique: [{ columns: ['id', 'id'] }] }, 'names "id" twice'],
    ['a column name with a dot', { cols: { 'a.b': {} } }, 'cols.a.b must not contain a dot'],
    ['a table name longer than 63 bytes', { tableName: 't'.repeat(64) }, 'longer than 63 bytes'],
    [
      'a referenced column listed twice',
      {
        foreignKeys: [
          { columns: ['id', 'name'], references: { table: 'x', columns: ['id', 'id'] } },
        ],
      },
      'references.columns names "id" twice',
    ],
    [
      'an applyChanges that is not a boolean',
      { sync: { strategy: 'listen', applyChanges: 'no' as never } },
      'sync.applyChanges must be a boolean',
    ],
    [
      'an index flag that is not a boolean',
      { indexes: [{ columns: ['id'], unique: 1 as never }] },
      'indexes[0].unique must be a boolean',
    ],
    [
      'a constraint name with a dot',
      { unique: [{ name: 'a.b', columns: ['id'] }] },
      'unique[0].name must not contain a dot',
    ],
    [
      'an index name longer than 63 bytes',
      { indexes: [{ name: 'i'.repeat(64), columns: ['id'] }] },
      'indexes[0].name "' + 'i'.repeat(64) + '" is longer than 63 bytes',
    ],
    [
      'a referenced table name longer than 63 bytes',
      { cols: { id: { references: { table: `app.${'r'.repeat(64)}`, column: 'id' } } } },
      'cols.id.references.table "' + 'r'.repeat(64) + '" is longer than 63 bytes',
    ],
    [
      'a referenced column with a dot',
      { cols: { id: { references: { table: 'x', column: 'a.b' } } } },
      'references.column must not contain a dot',
    ],
    ['an empty column name', { cols: { '': {} } }, 'tables.orgs.cols. must be a non-empty string'],
    [
      'a type that does not fit a pgType spelled dec',
      { cols: { id: { type: 'number', pgType: 'dec(10,2)' } } },
      'cols.id.type "number" does not fit its pgType "dec(10,2)"',
    ],
    [
      'a type that does not fit an array spelled with ARRAY',
      { cols: { id: { type: 'string', pgType: 'text ARRAY' } } },
      'cols.id.type "string" does not fit its pgType "text ARRAY"',
    ],
    ['columns given as a list', { cols: [{}] as never }, 'cols must describe at least one column'],
    [
      'a column that is not an object',
      { cols: { id: null as never } },
      'cols.id must be an object',
    ],
    ['a column given as a list', { cols: { id: [] as never } }, 'cols.id must be an object'],
    [
      'referenced columns that are not a list',
      { foreignKeys: [{ columns: ['id'], references: { table: 'x', columns: 'id' as never } }] },
      'foreignKeys[0].references.columns must list column names',
    ],
    [
      'an option of the sync none',
      { sync: { strategy: 'none', maxAge: 1 } as never },
      'tables.orgs.sync.maxAge is not an option',
    ],
  ])('should reject a table with %s', (_case, changes, message) => {
    expect(() =>
      defineLilypadDb({ tables: { orgs: { ...(orgs as LilypadDbTableInputBase), ...changes } } })
    ).toThrow(message);
  });

  it.each<[string, unknown, string]>([
    ['tables that are not an object', null, 'defineLilypadDb: tables must be an object'],
    ['tables given as a list', [orgs], 'defineLilypadDb: tables must be an object'],
    ['a table that is not an object', { orgs: null }, 'tables.orgs must be a table'],
    ['a table given as a list', { orgs: [orgs] }, 'tables.orgs must be a table'],
  ])('should reject %s', (_case, tables, message) => {
    expect(() => defineLilypadDb({ tables: tables as never })).toThrow(message);
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

  it.each<[string, Partial<LilypadDbTableInputBase>]>([
    [
      'a column',
      {
        cols: { ...users.cols, orgId: { references: { table: 'orgs', column: 'uid' } } },
      },
    ],
    [
      'a foreign key',
      { foreignKeys: [{ columns: ['orgId'], references: { table: 'orgs', columns: ['uid'] } }] },
    ],
  ])(
    'should reject %s that references an unknown column of a table of the config',
    (_case, changes) => {
      expect(() =>
        defineLilypadDb({
          tables: { orgs, users: { ...(users as LilypadDbTableInputBase), ...changes } },
        })
      ).toThrow('references the column "uid" of "orgs", which is not a column of that table');
    }
  );

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
