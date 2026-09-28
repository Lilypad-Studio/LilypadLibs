import { describe, it, expect } from 'vitest';
import { defineLilypadDb, defineLilypadTable } from '@/dbConfig/LilypadDbConfig';
import type {
  LilypadColumnInfo,
  LilypadConstraintInfo,
  LilypadIndexInfo,
  LilypadTableFacts,
} from './LilypadSchemaFacts';
import {
  evaluateLilypadTableShape,
  lilypadCreateTableSql,
  type LilypadSchemaTableShape,
} from './LilypadSchemaShape';

type Org = { id: number; name: string };
type User = { id: number; orgId: number; email: string; bio: string | null };

const db = defineLilypadDb({
  tables: {
    orgs: defineLilypadTable<Org, 'id'>({
      tableName: 'orgs',
      primaryKey: 'id',
      cols: { id: { type: 'number', pgType: 'int4' }, name: { type: 'string', pgType: 'text' } },
    }),
    users: defineLilypadTable<User, 'id'>({
      tableName: 'users',
      primaryKey: 'id',
      generatedPrimaryKey: true,
      cols: {
        id: { type: 'number', pgType: 'int4' },
        orgId: {
          type: 'number',
          pgType: 'int4',
          nullable: false,
          references: { table: 'orgs', onDelete: 'cascade' },
        },
        email: { type: 'string', pgType: 'varchar(255)', nullable: false, unique: true },
        bio: { type: 'string', pgType: 'text', nullable: true, default: { sql: "''" } },
      },
      indexes: [{ columns: ['orgId'] }],
      checks: [{ name: 'users_email_check', expression: "email LIKE '%@%'" }],
    }),
  },
});
const shape: LilypadSchemaTableShape = db.tables.users;

const column = (name: string, type: string, overrides: Partial<LilypadColumnInfo> = {}) => ({
  name,
  type,
  category: /int|numeric|real|double/.test(type) ? 'N' : 'S',
  notNull: false,
  hasDefault: false,
  identity: false,
  generated: false,
  ...overrides,
});

const constraint = (
  name: string,
  type: LilypadConstraintInfo['type'],
  columns: string[],
  overrides: Partial<LilypadConstraintInfo> = {}
): LilypadConstraintInfo => ({
  name,
  type,
  columns,
  referencedTable: null,
  referencedColumns: [],
  onDelete: ' ',
  onUpdate: ' ',
  ...overrides,
});

const index = (
  name: string,
  columns: (string | null)[],
  overrides: Partial<LilypadIndexInfo> = {}
): LilypadIndexInfo => ({
  name,
  unique: false,
  primary: false,
  method: 'btree',
  columns,
  partial: false,
  expressions: false,
  constraint: false,
  ...overrides,
});

/** The users table exactly as the shape describes it. */
function usersFacts(overrides: Partial<LilypadTableFacts> = {}): LilypadTableFacts {
  return {
    schema: 'public',
    triggers: [],
    columns: [
      column('id', 'integer', { notNull: true, identity: true }),
      column('orgId', 'integer', { notNull: true }),
      column('email', 'character varying(255)', { notNull: true }),
      column('bio', 'text', { hasDefault: true }),
    ],
    constraints: [
      constraint('users_pkey', 'p', ['id']),
      constraint('users_email_key', 'u', ['email']),
      constraint('users_orgId_fkey', 'f', ['orgId'], {
        referencedTable: 'public.orgs',
        referencedColumns: ['id'],
        onDelete: 'c',
        onUpdate: 'a',
      }),
      constraint('users_email_check', 'c', ['email']),
    ],
    indexes: [
      index('users_pkey', ['id'], { unique: true, primary: true, constraint: true }),
      index('users_email_key', ['email'], { unique: true, constraint: true }),
      index('users_orgId_idx', ['orgId']),
    ],
    ...overrides,
  };
}

const evaluate = (facts: LilypadTableFacts, tableShape: LilypadSchemaTableShape = shape) =>
  evaluateLilypadTableShape('public.users', 'id', tableShape, facts);
const codes = ({ problems, deferred }: ReturnType<typeof evaluate>) =>
  [...problems, ...deferred].map((problem) => `${problem.severity}:${problem.code}`);

describe('evaluateLilypadTableShape', () => {
  it('should find nothing to report in a table that matches its description', () => {
    expect(codes(evaluate(usersFacts()))).toEqual([]);
  });

  it('should report a missing column, with the SQL that adds it', () => {
    const facts = usersFacts();
    facts.columns = facts.columns!.filter((installed) => installed.name !== 'bio');

    const { problems } = evaluate(facts);

    expect(problems).toEqual([
      {
        code: 'missing-column',
        severity: 'error',
        table: 'public.users',
        message: 'The column "bio" of "public.users" does not exist.',
        fix: `ALTER TABLE "public"."users" ADD COLUMN "bio" text DEFAULT '';`,
      },
    ]);
  });

  it('should compare the pgType exactly, and the type loosely', () => {
    const facts = usersFacts();
    facts.columns![2] = column('email', 'text', { notNull: true });
    const loose = defineLilypadDb({
      tables: {
        t: {
          tableName: 't',
          primaryKey: 'id',
          cols: { id: { type: 'number' }, amount: { type: 'number' }, at: { type: 'date' } },
        },
      },
    }).tables.t;
    const looseFacts: LilypadTableFacts = {
      schema: 'public',
      triggers: [],
      columns: [
        column('id', 'integer', { notNull: true }),
        column('amount', 'numeric(10,2)', { category: 'N' }),
        column('at', 'time without time zone', { category: 'D' }),
      ],
      constraints: [constraint('t_pkey', 'p', ['id'])],
      indexes: [],
    };

    const { problems } = evaluate(facts);
    const looseProblems = evaluateLilypadTableShape('public.t', 'id', loose, looseFacts).problems;

    expect(problems).toMatchObject([
      {
        code: 'column-type-mismatch',
        severity: 'error',
        message: 'The column "email" of "public.users" is text, not character varying(255).',
        fix: 'ALTER TABLE "public"."users" ALTER COLUMN "email" TYPE varchar(255);',
      },
    ]);
    expect(looseProblems.map((problem) => [problem.severity, problem.message])).toEqual([
      [
        'warning',
        'The column "amount" of "public.t" is numeric(10,2), declared as number: postgres.js reads it as string (declare string or bigint).',
      ],
      [
        'warning',
        'The column "at" of "public.t" is time without time zone, declared as date: postgres.js reads it as string (declare string).',
      ],
    ]);
  });

  it('should report the nullability and the defaults that differ', () => {
    const facts = usersFacts();
    facts.columns = [
      column('id', 'integer', { notNull: true }), // not generated
      column('orgId', 'integer'), // accepts NULL
      column('email', 'character varying(255)', { notNull: true }),
      column('bio', 'text', { notNull: true }), // NOT NULL, no default
    ];

    const { problems } = evaluate(facts);

    expect(problems.map((problem) => [problem.code, problem.fix])).toEqual([
      ['missing-column-default', undefined],
      [
        'column-nullability-mismatch',
        'ALTER TABLE "public"."users" ALTER COLUMN "orgId" SET NOT NULL;',
      ],
      [
        'column-nullability-mismatch',
        'ALTER TABLE "public"."users" ALTER COLUMN "bio" DROP NOT NULL;',
      ],
      ['missing-column-default', `ALTER TABLE "public"."users" ALTER COLUMN "bio" SET DEFAULT '';`],
    ]);
    expect(problems[0]!.message).toContain('declared generated (generatedPrimaryKey)');
  });

  it('should warn about a required column that the description lacks, even without strict', () => {
    const facts = usersFacts();
    facts.columns!.push(column('tenant', 'text', { notNull: true }), column('note', 'text'));

    expect(codes(evaluate(facts))).toEqual(['warning:undeclared-required-column']);
  });

  it.each<[string, Partial<LilypadTableFacts>, string[]]>([
    [
      'no primary key',
      { constraints: [], indexes: [] },
      [
        'error:wrong-primary-key',
        'error:missing-unique-key',
        'warning:missing-index',
        'error:missing-check',
        'error:missing-foreign-key',
      ],
    ],
    [
      'a unique index on the key instead',
      {
        constraints: usersFacts().constraints!.filter((installed) => installed.type !== 'p'),
        indexes: [
          ...usersFacts().indexes!.slice(1),
          index('users_id_key', ['id'], { unique: true }),
        ],
      },
      ['warning:wrong-primary-key'],
    ],
  ])('should report %s', (_case, overrides, expected) => {
    expect(codes(evaluate(usersFacts(overrides)))).toEqual(expected);
  });

  it('should add the primary key only to a table without one', () => {
    const { problems } = evaluate(usersFacts({ constraints: [], indexes: [] }));

    expect(problems[0]).toMatchObject({
      code: 'wrong-primary-key',
      message: 'The key "id" of "public.users" is not unique: it has no primary key.',
      fix: 'ALTER TABLE "public"."users" ADD PRIMARY KEY ("id");',
    });
  });

  it('should accept a unique key made by a unique index, in any column order', () => {
    const twoColumns = { ...shape, unique: [{ columns: ['orgId', 'email'] }] };
    const facts = usersFacts();
    facts.indexes!.push(index('users_email_org', ['email', 'orgId'], { unique: true }));

    expect(codes(evaluate(facts, twoColumns))).toEqual([]);
    facts.indexes![3] = { ...facts.indexes![3]!, partial: true };
    expect(evaluate(facts, twoColumns).problems).toMatchObject([
      {
        code: 'missing-unique-key',
        fix: 'ALTER TABLE "public"."users" ADD UNIQUE ("orgId", "email");',
      },
    ]);
  });

  it('should report a missing foreign key after the table problems, and one with other actions', () => {
    const facts = usersFacts();
    const foreignKey = facts.constraints![2]!;

    facts.constraints![2] = { ...foreignKey, referencedTable: 'public.other' };
    const missing = evaluate(facts);
    facts.constraints![2] = { ...foreignKey, onDelete: 'r' };
    const mismatch = evaluate(facts);

    expect(missing.problems).toEqual([]);
    expect(missing.deferred).toEqual([
      {
        code: 'missing-foreign-key',
        severity: 'error',
        table: 'public.users',
        message: 'The foreign key (orgId) → public.orgs (id) of "public.users" does not exist.',
        fix: 'ALTER TABLE "public"."users" ADD FOREIGN KEY ("orgId") REFERENCES "public"."orgs" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;',
      },
    ]);
    expect(mismatch.problems).toEqual([
      {
        code: 'foreign-key-mismatch',
        severity: 'error',
        table: 'public.users',
        message:
          'The foreign key (orgId) → public.orgs (id) of "public.users" is ON DELETE RESTRICT ON UPDATE NO ACTION, not ON DELETE CASCADE ON UPDATE NO ACTION.',
        fix:
          'ALTER TABLE "public"."users" DROP CONSTRAINT "users_orgId_fkey";\n' +
          'ALTER TABLE "public"."users" ADD CONSTRAINT "users_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "public"."orgs" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;',
      },
    ]);
  });

  it('should require an index with the same columns in order and the same method', () => {
    const facts = usersFacts();
    facts.indexes![2] = index('users_orgId_idx', ['orgId'], { method: 'hash' });

    expect(evaluate(facts).problems).toEqual([
      {
        code: 'missing-index',
        severity: 'warning',
        table: 'public.users',
        message: 'The btree index on (orgId) of "public.users" does not exist.',
        fix: 'CREATE INDEX ON "public"."users" ("orgId");',
      },
    ]);
  });

  it('should find a check by name, and create it when its expression is known', () => {
    const facts = usersFacts();
    facts.constraints = facts.constraints!.filter((installed) => installed.type !== 'c');

    expect(evaluate(facts).problems).toMatchObject([
      {
        code: 'missing-check',
        fix: `ALTER TABLE "public"."users" ADD CONSTRAINT "users_email_check" CHECK (email LIKE '%@%');`,
      },
    ]);
  });

  it('should report what the description lacks with strict only', () => {
    const facts = usersFacts();
    facts.columns!.push(column('note', 'text'));
    facts.constraints!.push(
      constraint('users_note_check', 'c', ['note']),
      constraint('users_note_key', 'u', ['note']),
      constraint('users_self_fkey', 'f', ['id'], {
        referencedTable: 'public.users',
        referencedColumns: ['id'],
        onDelete: 'a',
        onUpdate: 'a',
      })
    );
    facts.indexes!.push(
      index('users_note_key', ['note'], { unique: true, constraint: true }),
      index('users_lower_email', [null], { expressions: true })
    );

    expect(codes(evaluate(facts))).toEqual([]);
    expect(
      evaluate(facts, { ...shape, strict: true }).problems.map((problem) => problem.message)
    ).toEqual([
      'The column "note" (text) of "public.users" is not in `cols`.',
      'The check "users_note_check" of "public.users" is not in its description.',
      'The unique key (note) of "public.users" is not in its description.',
      'The foreign key (id) → public.users (id) of "public.users" is not in its description.',
      'The index "users_lower_email" (btree: <expression>) of "public.users" is not in its description.',
    ]);
  });
});

describe('lilypadCreateTableSql', () => {
  it('should create the table with its keys, checks and indexes, without its foreign keys', () => {
    expect(lilypadCreateTableSql('public.users', 'id', shape)).toBe(
      [
        'CREATE TABLE "public"."users" (',
        '  "id" int4 GENERATED BY DEFAULT AS IDENTITY NOT NULL,',
        '  "orgId" int4 NOT NULL,',
        '  "email" varchar(255) NOT NULL,',
        `  "bio" text DEFAULT '',`,
        '  PRIMARY KEY ("id"),',
        '  UNIQUE ("email"),',
        `  CONSTRAINT "users_email_check" CHECK (email LIKE '%@%')`,
        ');',
        'CREATE INDEX ON "public"."users" ("orgId");',
      ].join('\n')
    );
  });

  it('should need the pgType of every column', () => {
    const untyped = { ...shape, cols: { ...shape.cols, bio: { type: 'string' as const } } };

    expect(lilypadCreateTableSql('public.users', 'id', untyped)).toBeUndefined();
  });
});
