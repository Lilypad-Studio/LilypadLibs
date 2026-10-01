import { describe, it, expect } from 'vitest';
import { defineLilypadDb } from '@/dbConfig/LilypadDbConfig';
import { lilypadSchemaCheckOptions } from './LilypadDoctor';
import {
  LILYPAD_CHANGELOG_VERSION,
  lilypadChangelogPruneScheduleSql,
  lilypadChangelogSql,
  lilypadChangelogTriggerSql,
} from './LilypadChangelog';
import {
  evaluateLilypadSchema,
  formatLilypadSchemaFixSql,
  formatLilypadSchemaProblems,
} from './LilypadSchemaCheck';
import type {
  LilypadCronJobInfo,
  LilypadSchemaFacts,
  LilypadTriggerInfo,
} from './LilypadSchemaFacts';
import { lilypadCommandDeletesFrom, lilypadPruneCommandRetention } from './LilypadSchemaPruning';
import type { LilypadSchemaCheckOptions, LilypadSchemaTableShape } from './LilypadSchemaTypes';

// pg_trigger.tgtype: ROW = 1, INSERT = 4, DELETE = 8, UPDATE = 16, TRUNCATE = 32
const ROW_TRIGGER = 1 | 4 | 8 | 16;
const TRUNCATE_TRIGGER = 32;

const changelogRow: LilypadTriggerInfo = {
  changelog: true,
  args: ['id'],
  type: ROW_TRIGGER,
  enabled: true,
  source: '',
};
const changelogTruncate: LilypadTriggerInfo = { ...changelogRow, type: TRUNCATE_TRIGGER };
/** The statement triggers of the changelog, one per event, with their transition tables. */
const changelogStatements: LilypadTriggerInfo[] = [
  { ...changelogRow, type: 4, newTable: 'lilypad_new' },
  { ...changelogRow, type: 16, oldTable: 'lilypad_old', newTable: 'lilypad_new' },
  { ...changelogRow, type: 8, oldTable: 'lilypad_old' },
];

const notifySource = (channel: string) => `BEGIN PERFORM pg_notify('${channel}', payload); END`;

/** The job scheduled by lilypadChangelogPruneScheduleSql({ olderThan: 24 h }). */
const pruneJob: LilypadCronJobInfo = {
  id: 1,
  name: 'lilypad_cache_changes_prune',
  schedule: '0 3 * * *',
  command:
    'DELETE FROM public.lilypad_cache_changes WHERE changed_at < clock_timestamp() - make_interval(secs => 86400)',
  active: true,
  database: 'app',
};

/** A complete installation, pruned by a pg_cron job. */
function facts(overrides: Partial<LilypadSchemaFacts> = {}): LilypadSchemaFacts {
  return {
    version: 160000,
    database: 'app',
    changelog: {
      hasTable: true,
      hasSchemaColumn: true,
      hasFunction: true,
      functionComment: `lilypad-changelog:${LILYPAD_CHANGELOG_VERSION}`,
      functionSource: null,
      schema: 'public',
      hasPruneFunction: false,
      writers: null,
      oldestRowAge: 60_000,
      deletedRows: 0,
    },
    cron: { available: true, installed: true, database: 'app', jobs: [pruneJob] },
    tables: [{ schema: 'public', triggers: [...changelogStatements, changelogTruncate] }],
    ...overrides,
  };
}

/** The changelog facts of a database without the changelog. */
const noChangelog: LilypadSchemaFacts['changelog'] = {
  hasTable: false,
  hasSchemaColumn: false,
  hasFunction: false,
  functionComment: null,
  functionSource: null,
  schema: null,
  hasPruneFunction: false,
  writers: null,
  oldestRowAge: null,
  deletedRows: 0,
};

const changelogOptions: LilypadSchemaCheckOptions = {
  tables: [{ table: 'items', primaryKey: 'id' }],
};
const listenOptions: LilypadSchemaCheckOptions = {
  tables: [{ table: 'items', primaryKey: 'id' }],
  changelog: false,
  notifyChannel: 'cache_events',
};

const codes = (result: ReturnType<typeof evaluateLilypadSchema>) =>
  result.problems.map((problem) => problem.code);

describe('evaluateLilypadSchema', () => {
  it('should find no problem in a complete installation', () => {
    const result = evaluateLilypadSchema(facts(), changelogOptions);

    expect(result).toEqual({
      ok: true,
      problems: [],
      tables: [{ table: 'items', schema: 'public' }],
    });
  });

  it('should report an unsupported version', () => {
    expect(codes(evaluateLilypadSchema(facts({ version: 150000 }), changelogOptions))).toContain(
      'unsupported-version'
    );
  });

  it('should report a missing changelog table or function, with the SQL that creates it', () => {
    const result = evaluateLilypadSchema(facts({ changelog: noChangelog }), changelogOptions);

    expect(codes(result)).toEqual(['missing-changelog']);
    expect(result.problems[0]!.fix).toContain('CREATE TABLE IF NOT EXISTS "lilypad_cache_changes"');
  });

  it.each([
    ['without the schema column', { hasSchemaColumn: false }],
    ['with a function of version 2', { functionComment: 'lilypad-changelog:2' }],
    ['with a function without version', { functionComment: null }],
  ])('should report an outdated changelog %s', (_case, changelog) => {
    const result = evaluateLilypadSchema(
      facts({ changelog: { ...facts().changelog, ...changelog } }),
      changelogOptions
    );

    expect(codes(result)).toEqual(['outdated-changelog']);
    expect(result.problems[0]!.severity).toBe('error');
    expect(result.ok).toBe(false);
  });

  describe('a changelog installed by a newer version', () => {
    const newer = {
      ...facts().changelog,
      functionComment: `lilypad-changelog:${LILYPAD_CHANGELOG_VERSION + 1}`,
    };

    it('should only warn, the caches still read it', () => {
      const result = evaluateLilypadSchema(facts({ changelog: newer }), changelogOptions);

      expect(codes(result)).toEqual(['newer-changelog']);
      expect(result.problems[0]!.severity).toBe('warning');
      expect(result.problems[0]!.message).toContain(
        `(version ${LILYPAD_CHANGELOG_VERSION + 1}, this one knows ${LILYPAD_CHANGELOG_VERSION}): upgrade @lilypad-studio/libs`
      );
      expect(result.ok).toBe(true);
    });

    it('should withhold every fix that would install the older SQL of this version', () => {
      const shape: LilypadSchemaTableShape = {
        cols: { id: { pgType: 'integer' } },
        unique: [],
        foreignKeys: [],
        indexes: [],
        checks: [],
        strict: false,
      };
      const result = evaluateLilypadSchema(
        facts({
          changelog: { ...newer, writers: 'app' },
          cron: { available: false, installed: false, database: null, jobs: null },
          tables: [
            { schema: 'public', triggers: [] },
            { schema: null, triggers: [] },
          ],
        }),
        {
          tables: [
            { table: 'items', primaryKey: 'id' },
            { table: 'orders', primaryKey: 'id', shape, notifyChannel: 'cache_events' },
          ],
        }
      );

      expect(codes(result)).toEqual([
        'newer-changelog',
        'writable-changelog',
        'missing-changelog-trigger',
        'missing-table',
        'no-changelog-pruning',
      ]);
      const withheld =
        'withheld until the library is upgraded (see newer-changelog); run the check again then.';
      const sql = formatLilypadSchemaFixSql(result.problems);
      expect(sql).not.toContain('lilypad-changelog:');
      expect(sql).not.toContain('CREATE TRIGGER');
      expect(sql).not.toContain('REVOKE');
      const missing = result.problems.find((p) => p.code === 'missing-table')!;
      expect(missing.fix).toContain('CREATE TABLE');
      expect(missing.message).toContain(`The changelog triggers of its fix are ${withheld}`);
      for (const code of [
        'writable-changelog',
        'missing-changelog-trigger',
        'no-changelog-pruning',
      ]) {
        const problem = result.problems.find((p) => p.code === code)!;
        expect(problem.fix).toBeUndefined();
        expect(problem.message).toContain(`Its fix is ${withheld}`);
      }
    });

    it('should withhold the notify fixes of a listen-only config too', () => {
      const result = evaluateLilypadSchema(
        facts({ changelog: newer, tables: [{ schema: 'public', triggers: [] }] }),
        listenOptions
      );

      expect(codes(result)).toEqual(['newer-changelog', 'missing-notify-trigger']);
      expect(result.problems[1]!.fix).toBeUndefined();
      expect(formatLilypadSchemaFixSql(result.problems)).toBe('');
    });

    it('should still report a changelog table that lost its schema column', () => {
      const result = evaluateLilypadSchema(
        facts({ changelog: { ...newer, hasSchemaColumn: false } }),
        changelogOptions
      );

      expect(codes(result)).toEqual(['newer-changelog', 'outdated-changelog']);
      expect(result.problems[1]!.message).toContain('has no table_schema column');
      expect(result.problems[1]!.fix).toBeUndefined();
      expect(result.ok).toBe(false);
    });

    it('should give both reasons when a key also blocks the fixes', () => {
      const result = evaluateLilypadSchema(
        facts({
          changelog: newer,
          tables: [{ schema: 'public', triggers: [], keyUserType: 'item_status' }],
        }),
        changelogOptions
      );

      const trigger = result.problems.find((p) => p.code === 'missing-changelog-trigger')!;
      expect(trigger.fix).toBeUndefined();
      expect(trigger.message).toContain(
        'withheld until the primary key of "items" is changed (see unsupported-key-type / missing-column) and the library is upgraded (see newer-changelog); run the check again then.'
      );
    });
  });

  it.each([4, 6, 7, LILYPAD_CHANGELOG_VERSION - 1])(
    'should report a changelog of version %i as an error, with the SQL of this version',
    (version) => {
      const result = evaluateLilypadSchema(
        facts({
          changelog: { ...facts().changelog, functionComment: `lilypad-changelog:${version}` },
        }),
        changelogOptions
      );

      expect(codes(result)).toEqual(['outdated-changelog']);
      expect(result.problems[0]!.severity).toBe('error');
      expect(result.problems[0]!.message).toContain(
        `(version ${version}, expected ${LILYPAD_CHANGELOG_VERSION}).`
      );
      expect(result.problems[0]!.fix).toBe(lilypadChangelogSql({ notifyChannel: false }));
      expect(result.ok).toBe(false);
    }
  );

  it.each(['lilypad-changelog:abc', 'lilypad-changelog:6.5', 'my own function'])(
    'should take a changelog whose comment is %j for the oldest version',
    (functionComment) => {
      const result = evaluateLilypadSchema(
        facts({ changelog: { ...facts().changelog, functionComment } }),
        changelogOptions
      );

      expect(codes(result)).toEqual(['outdated-changelog']);
      expect(result.problems[0]!.message).toContain('(version 1, expected');
      expect(result.ok).toBe(false);
    }
  );

  it('should report a primary key of a user-defined type that the changelog cannot record', () => {
    const result = evaluateLilypadSchema(
      facts({
        tables: [
          {
            schema: 'public',
            triggers: [...changelogStatements, changelogTruncate],
            keyUserType: 'item_status',
          },
        ],
      }),
      changelogOptions
    );

    expect(codes(result)).toContain('unsupported-key-type');
    const problem = result.problems.find((p) => p.code === 'unsupported-key-type')!;
    expect(problem.severity).toBe('error');
    expect(problem.table).toBe('items');
    expect(problem.message).toContain('item_status');
    expect(problem.message).toContain('the writes of the table fail');
    expect(result.ok).toBe(false);
  });

  it('should say an older install still converts the key as the owner', () => {
    const result = evaluateLilypadSchema(
      facts({
        changelog: { ...facts().changelog, functionComment: 'lilypad-changelog:8' },
        tables: [
          {
            schema: 'public',
            triggers: [...changelogStatements, changelogTruncate],
            keyUserType: 'item_status',
          },
        ],
      }),
      changelogOptions
    );

    const problem = result.problems.find((p) => p.code === 'unsupported-key-type')!;
    expect(problem.severity).toBe('error');
    expect(problem.message).toContain('version 8');
    expect(problem.message).toContain("changelog owner's privileges");
    expect(problem.message).toContain(
      `once version ${LILYPAD_CHANGELOG_VERSION} is installed, every write of the table fails`
    );
    expect(problem.message).toContain(`before installing version ${LILYPAD_CHANGELOG_VERSION}`);
  });

  it('should tell an install older than version 7 to change the key before version 9', () => {
    const result = evaluateLilypadSchema(
      facts({
        changelog: { ...facts().changelog, functionComment: 'lilypad-changelog:5' },
        tables: [
          {
            schema: 'public',
            triggers: [...changelogStatements, changelogTruncate],
            keyUserType: 'item_status',
          },
        ],
      }),
      changelogOptions
    );

    const problem = result.problems.find((p) => p.code === 'unsupported-key-type')!;
    expect(problem.message).toContain(
      `once version ${LILYPAD_CHANGELOG_VERSION} is installed, every write of the table fails`
    );
    expect(problem.message).toContain(`before installing version ${LILYPAD_CHANGELOG_VERSION}`);
    // Before version 7, the trigger function ran with the privileges of the writing role
    expect(problem.message).not.toContain("changelog owner's privileges");
  });

  it('should not claim that an older install converts the key of a table it has no trigger on', () => {
    const result = evaluateLilypadSchema(
      facts({
        changelog: { ...facts().changelog, functionComment: 'lilypad-changelog:8' },
        tables: [{ schema: 'public', triggers: [], keyUserType: 'item_status' }],
      }),
      listenOptions
    );

    const problem = result.problems.find((p) => p.code === 'unsupported-key-type')!;
    expect(problem.message).toContain(`once version ${LILYPAD_CHANGELOG_VERSION} is installed`);
    expect(problem.message).not.toContain("changelog owner's privileges");
  });

  describe('a key that the changelog triggers refuse', () => {
    const withheld =
      'withheld until the primary key of "items" is changed (see unsupported-key-type / missing-column); run the check again then.';
    const notifying = (trigger: LilypadTriggerInfo) => ({
      ...trigger,
      source: notifySource('cache_events'),
    });
    /** `items` recorded by the changelog triggers, `orders` without any trigger. */
    const twoTables = (
      items: Partial<LilypadSchemaFacts['tables'][0]>,
      changelog: Partial<LilypadSchemaFacts['changelog']> = {},
      triggers = [...changelogStatements, changelogTruncate]
    ) =>
      facts({
        changelog: { ...facts().changelog, ...changelog },
        tables: [
          { schema: 'public', triggers, ...items },
          { schema: 'public', triggers: [] },
        ],
      });
    const twoTableOptions = (options: LilypadSchemaCheckOptions) => ({
      ...options,
      tables: [...options.tables, { table: 'orders', primaryKey: 'id' }],
    });
    const outdated = { functionComment: 'lilypad-changelog:5', writers: 'app' };

    it('should withhold the changelog SQL, its triggers and the REVOKE of an older install', () => {
      const result = evaluateLilypadSchema(
        twoTables({ keyUserType: 'item_status' }, outdated),
        twoTableOptions(changelogOptions)
      );

      expect(codes(result)).toEqual([
        'outdated-changelog',
        'writable-changelog',
        'unsupported-key-type',
        'missing-changelog-trigger',
      ]);
      expect(result.ok).toBe(false);
      expect(formatLilypadSchemaFixSql(result.problems)).toBe('');
      for (const problem of [result.problems[0]!, result.problems[1]!, result.problems[3]!]) {
        expect(problem.fix).toBeUndefined();
        expect(problem.message).toContain(`Its fix is ${withheld}`);
      }
    });

    it('should keep the fixes of a config without such a key', () => {
      const result = evaluateLilypadSchema(
        twoTables({}, outdated),
        twoTableOptions(changelogOptions)
      );

      expect(codes(result)).toEqual([
        'outdated-changelog',
        'writable-changelog',
        'missing-changelog-trigger',
      ]);
      const sql = formatLilypadSchemaFixSql(result.problems);
      expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE');
      expect(sql).toContain(lilypadChangelogSql({ notifyChannel: false }));
      expect(sql).toContain(lilypadChangelogTriggerSql({ table: 'orders', primaryKey: 'id' }));
      expect(result.problems.every((p) => !p.message.includes('withheld'))).toBe(true);
    });

    it('should withhold the notify fixes of a listen-only config', () => {
      const result = evaluateLilypadSchema(
        twoTables(
          { keyUserType: 'item_status' },
          {},
          [...changelogStatements, changelogTruncate].map(notifying)
        ),
        twoTableOptions(listenOptions)
      );

      expect(codes(result)).toEqual(['unsupported-key-type', 'missing-notify-trigger']);
      expect(result.problems[1]!.table).toBe('orders');
      expect(result.problems[1]!.fix).toBeUndefined();
      expect(result.problems[1]!.message).toContain(`Its fix is ${withheld}`);
      expect(formatLilypadSchemaFixSql(result.problems)).toBe('');
    });

    it('should withhold the notify fix that would give the changelog triggers to the table', () => {
      const result = evaluateLilypadSchema(
        facts({ tables: [{ schema: 'public', triggers: [], keyUserType: 'item_status' }] }),
        listenOptions
      );

      expect(codes(result)).toEqual(['unsupported-key-type', 'missing-notify-trigger']);
      expect(result.problems[0]!.message).toContain(
        'the writes of the table fail once its changelog triggers are installed'
      );
      expect(result.problems[1]!.fix).toBeUndefined();
    });

    it('should withhold the trigger fixes of every table when the changelog table was dropped', () => {
      const result = evaluateLilypadSchema(
        twoTables({ keyColumnMissing: true }, { hasTable: false }),
        twoTableOptions(changelogOptions)
      );

      expect(codes(result)).toEqual([
        'missing-changelog',
        'missing-column',
        'missing-changelog-trigger',
      ]);
      expect(result.problems[2]!.table).toBe('orders');
      expect(formatLilypadSchemaFixSql(result.problems)).toBe('');
    });

    it('should still create a missing table, without its changelog triggers', () => {
      const shape: LilypadSchemaTableShape = {
        cols: { id: { pgType: 'integer' } },
        unique: [],
        foreignKeys: [],
        indexes: [],
        checks: [],
        strict: false,
      };
      const result = evaluateLilypadSchema(
        facts({
          tables: [
            {
              schema: 'public',
              triggers: [...changelogStatements, changelogTruncate],
              keyUserType: 'item_status',
            },
            { schema: null, triggers: [] },
          ],
        }),
        { tables: [...changelogOptions.tables, { table: 'orders', primaryKey: 'id', shape }] }
      );

      const missing = result.problems.find((p) => p.code === 'missing-table')!;
      expect(missing.fix).toContain('CREATE TABLE');
      expect(missing.fix).not.toContain('CREATE TRIGGER');
      expect(missing.message).toContain(`The changelog triggers of its fix are ${withheld}`);
    });

    it('should withhold the pruning that installs or schedules against the changelog', () => {
      const result = evaluateLilypadSchema(
        facts({
          cron: { available: false, installed: false, database: null, jobs: null },
          tables: [
            {
              schema: 'public',
              triggers: [...changelogStatements, changelogTruncate],
              keyUserType: 'item_status',
            },
          ],
        }),
        changelogOptions
      );

      const pruning = result.problems.find((p) => p.code === 'no-changelog-pruning')!;
      expect(pruning.fix).toBeUndefined();
      expect(pruning.message).toContain(`Its fix is ${withheld}`);
      expect(result.problems.every((p) => p.fix !== '')).toBe(true);
    });

    it('should report the key of a table recorded by the changelog triggers that notify it', () => {
      const result = evaluateLilypadSchema(
        facts({
          tables: [
            {
              schema: 'public',
              triggers: [...changelogStatements, changelogTruncate].map(notifying),
              keyUserType: 'item_status',
            },
          ],
        }),
        listenOptions
      );

      expect(codes(result)).toEqual(['unsupported-key-type']);
      expect(result.problems[0]!.message).toContain('the writes of the table fail.');
    });

    it('should report a missing key column that the changelog triggers notifying it read', () => {
      const result = evaluateLilypadSchema(
        facts({
          tables: [
            {
              schema: 'public',
              triggers: [...changelogStatements, changelogTruncate].map(notifying),
              keyColumnMissing: true,
            },
          ],
        }),
        listenOptions
      );

      expect(codes(result)).toEqual(['missing-column']);
    });

    it('should not report the key of a table notified by triggers of its own', () => {
      const ownNotifiers: LilypadTriggerInfo[] = [
        { changelog: false, args: [], type: ROW_TRIGGER, enabled: true, source: '' },
        { changelog: false, args: [], type: TRUNCATE_TRIGGER, enabled: true, source: '' },
      ].map(notifying);
      const result = evaluateLilypadSchema(
        facts({
          tables: [
            {
              schema: 'public',
              triggers: ownNotifiers,
              keyUserType: 'item_status',
              keyColumnMissing: true,
            },
          ],
        }),
        listenOptions
      );

      expect(result.ok).toBe(true);
    });
  });

  it('should report a primary key column that does not exist (changelog-only table)', () => {
    const result = evaluateLilypadSchema(
      facts({
        tables: [
          {
            schema: 'public',
            triggers: [...changelogStatements, changelogTruncate],
            keyColumnMissing: true,
          },
        ],
      }),
      changelogOptions
    );

    const problem = result.problems.find((p) => p.code === 'missing-column')!;
    expect(problem.severity).toBe('error');
    expect(problem.table).toBe('items');
    expect(problem.message).toContain('does not exist');
    expect(result.ok).toBe(false);
  });

  it('should report a missing key column even when a shape omits it', () => {
    // A shape whose cols do not describe the key column would otherwise hide it
    const shapeWithoutKey: LilypadSchemaTableShape = {
      cols: { other: {} },
      unique: [],
      foreignKeys: [],
      indexes: [],
      checks: [],
      strict: false,
    };
    const result = evaluateLilypadSchema(
      facts({
        tables: [
          {
            schema: 'public',
            triggers: [...changelogStatements, changelogTruncate],
            keyColumnMissing: true,
          },
        ],
      }),
      { tables: [{ table: 'items', primaryKey: 'id', shape: shapeWithoutKey }] }
    );

    expect(codes(result)).toContain('missing-column');
  });

  it('should not report a built-in primary key type', () => {
    const result = evaluateLilypadSchema(
      facts({
        tables: [
          {
            schema: 'public',
            triggers: [...changelogStatements, changelogTruncate],
            keyUserType: null,
          },
        ],
      }),
      changelogOptions
    );

    expect(codes(result)).not.toContain('unsupported-key-type');
  });

  it('should warn about the roles other than its owner that can write the changelog', () => {
    const result = evaluateLilypadSchema(
      facts({ changelog: { ...facts().changelog, writers: 'PUBLIC, "app role"' } }),
      changelogOptions
    );

    expect(codes(result)).toEqual(['writable-changelog']);
    expect(result.ok).toBe(true);
    expect(result.problems[0]!.message).toContain('(PUBLIC, "app role")');
    expect(result.problems[0]!.fix).toBe(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "lilypad_cache_changes" FROM PUBLIC, "app role";\n'
    );
  });

  it('should revoke the writes of the changelog after installing its current version', () => {
    const result = evaluateLilypadSchema(
      facts({
        changelog: {
          ...facts().changelog,
          functionComment: 'lilypad-changelog:6',
          writers: 'app',
        },
      }),
      changelogOptions
    );

    // Revoked first, the triggers of version 6 would fail the writes of these roles
    expect(codes(result)).toEqual(['outdated-changelog', 'writable-changelog']);
    const sql = formatLilypadSchemaFixSql(result.problems);
    expect(sql.indexOf('TRUNCATE ON "lilypad_cache_changes" FROM app;')).toBeGreaterThan(
      sql.indexOf('SECURITY DEFINER SET search_path')
    );
  });

  describe('notifications of the changelog fix', () => {
    const missing = facts({ changelog: noChangelog });
    const outdated = (functionSource: string) =>
      facts({
        changelog: {
          ...facts().changelog,
          functionComment: 'lilypad-changelog:3',
          functionSource,
          hasPruneFunction: true,
        },
      });
    const fix = (result: ReturnType<typeof evaluateLilypadSchema>) => result.problems[0]!.fix!;

    it('should create a changelog that sends no notification when they are not checked', () => {
      const result = evaluateLilypadSchema(missing, changelogOptions);

      expect(fix(result)).toContain('COMMENT ON FUNCTION');
      expect(fix(result)).not.toContain('pg_notify');
    });

    it('should create a changelog that notifies on the checked channel', () => {
      const result = evaluateLilypadSchema(missing, {
        ...changelogOptions,
        notifyChannel: 'cache_events',
      });

      expect(codes(result)).toContain('missing-changelog');
      expect(fix(result)).toContain("pg_notify('cache_events'");
    });

    it('should keep an outdated changelog without notifications', () => {
      const result = evaluateLilypadSchema(
        outdated('BEGIN INSERT INTO changes; END'),
        changelogOptions
      );

      expect(codes(result)).toEqual(['outdated-changelog']);
      expect(fix(result)).not.toContain('pg_notify');
    });

    it('should keep the channel an outdated changelog notifies on', () => {
      const result = evaluateLilypadSchema(outdated(notifySource("app''events")), changelogOptions);

      expect(codes(result)).toEqual(['outdated-changelog']);
      expect(fix(result)).toContain("pg_notify('app''events'");
    });

    it('should keep the pruning of an outdated changelog', () => {
      const prune = { olderThan: 86_400_000, every: 5, batchSize: 200 };
      const result = evaluateLilypadSchema(
        outdated(lilypadChangelogSql({ notifyChannel: false, prune })),
        changelogOptions
      );

      expect(codes(result)).toEqual(['outdated-changelog']);
      expect(fix(result)).toBe(lilypadChangelogSql({ notifyChannel: false, prune }));
    });

    it('should not start pruning an outdated changelog that did not', () => {
      const result = evaluateLilypadSchema(
        outdated(notifySource('cache_events')),
        changelogOptions
      );

      expect(fix(result)).toContain('DROP FUNCTION IF EXISTS "lilypad_cache_changes_prune"()');
      expect(fix(result)).not.toContain('PERFORM %3$s()');
    });
  });

  it('should report a missing table', () => {
    const result = evaluateLilypadSchema(
      facts({ tables: [{ schema: null, triggers: [] }] }),
      changelogOptions
    );

    expect(codes(result)).toEqual(['missing-table']);
    expect(result.tables).toEqual([{ table: 'items', schema: null }]);
  });

  it.each([
    ['no trigger', []],
    [
      'a disabled trigger',
      [
        { ...changelogStatements[0]!, enabled: false },
        ...changelogStatements.slice(1),
        changelogTruncate,
      ],
    ],
    ['a trigger without DELETE', [...changelogStatements.slice(0, 2), changelogTruncate]],
    ['the row trigger of version 3', [changelogRow, changelogTruncate]],
    [
      'statement triggers without UPDATE',
      [changelogStatements[0]!, changelogStatements[2]!, changelogTruncate],
    ],
    [
      'a statement trigger without its transition tables',
      [
        changelogStatements[0]!,
        { ...changelogStatements[1]!, oldTable: null },
        changelogStatements[2]!,
        changelogTruncate,
      ],
    ],
  ])('should report a missing changelog trigger with %s', (_case, triggers) => {
    const result = evaluateLilypadSchema(
      facts({ tables: [{ schema: 'public', triggers }] }),
      changelogOptions
    );

    expect(codes(result)).toEqual(['missing-changelog-trigger']);
    expect(result.problems[0]!.fix).toContain('CREATE TRIGGER "items_lilypad_update"');
  });

  it('should accept the statement triggers of version 4', () => {
    const result = evaluateLilypadSchema(
      facts({
        tables: [{ schema: 'public', triggers: [...changelogStatements, changelogTruncate] }],
      }),
      changelogOptions
    );

    expect(result.ok).toBe(true);
  });

  it('should name the events that no changelog trigger records', () => {
    const result = evaluateLilypadSchema(
      facts({
        tables: [{ schema: 'public', triggers: [changelogStatements[0]!, changelogTruncate] }],
      }),
      changelogOptions
    );

    expect(result.problems[0]!.message).toContain('do not record UPDATE, DELETE');
  });

  it('should report a changelog trigger that records another column', () => {
    const result = evaluateLilypadSchema(
      facts({
        tables: [
          {
            schema: 'public',
            triggers: [
              ...changelogStatements.map((trigger) => ({ ...trigger, args: ['uuid'] })),
              changelogTruncate,
            ],
          },
        ],
      }),
      changelogOptions
    );

    expect(codes(result)).toEqual(['wrong-trigger-primary-key']);
    expect(result.problems[0]!.message).toContain('"uuid"');
  });

  it('should report a statement trigger that records another column', () => {
    const triggers = [
      ...changelogStatements.slice(0, 2),
      { ...changelogStatements[2]!, args: ['uuid'] },
      changelogTruncate,
    ];
    const result = evaluateLilypadSchema(
      facts({ tables: [{ schema: 'public', triggers }] }),
      changelogOptions
    );

    expect(codes(result)).toEqual(['wrong-trigger-primary-key']);
    expect(result.problems[0]!.message).toContain('"uuid"');
  });

  it('should report a table whose TRUNCATE is not recorded', () => {
    const result = evaluateLilypadSchema(
      facts({ tables: [{ schema: 'public', triggers: changelogStatements }] }),
      changelogOptions
    );

    expect(codes(result)).toEqual(['missing-truncate-trigger']);
  });

  it('should generate the SQL for a custom changelog table', () => {
    const result = evaluateLilypadSchema(facts({ tables: [{ schema: 'public', triggers: [] }] }), {
      ...changelogOptions,
      changelog: { table: 'audit.changes' },
    });

    expect(result.problems[0]!.fix).toContain('"audit_changes_record"(\'id\')');
  });

  describe('notifications', () => {
    const notifier = (channel: string, type: number): LilypadTriggerInfo => ({
      changelog: false,
      args: [],
      type,
      enabled: true,
      source: notifySource(channel),
    });

    it('should accept notifying triggers split across several triggers', () => {
      const result = evaluateLilypadSchema(
        facts({
          tables: [
            {
              schema: 'public',
              triggers: [
                notifier('cache_events', 1 | 4 | 16),
                notifier('cache_events', 1 | 8),
                notifier('cache_events', TRUNCATE_TRIGGER),
              ],
            },
          ],
        }),
        listenOptions
      );

      expect(result.ok).toBe(true);
    });

    it('should accept the statement triggers of a changelog that notifies', () => {
      const notifying = (trigger: LilypadTriggerInfo) => ({
        ...trigger,
        source: notifySource('cache_events'),
      });
      const result = evaluateLilypadSchema(
        facts({
          tables: [
            {
              schema: 'public',
              triggers: [...changelogStatements, changelogTruncate].map(notifying),
            },
          ],
        }),
        listenOptions
      );

      expect(result.ok).toBe(true);
    });

    it('should not count a statement trigger that is not a changelog trigger', () => {
      const result = evaluateLilypadSchema(
        facts({
          tables: [
            {
              schema: 'public',
              triggers: [
                { ...notifier('cache_events', 4 | 8 | 16), newTable: 'lilypad_new' },
                notifier('cache_events', TRUNCATE_TRIGGER),
              ],
            },
          ],
        }),
        listenOptions
      );

      expect(codes(result)).toEqual(['missing-notify-trigger']);
    });

    it('should report the row events that no trigger notifies', () => {
      const result = evaluateLilypadSchema(
        facts({ tables: [{ schema: 'public', triggers: [notifier('cache_events', 1 | 4)] }] }),
        listenOptions
      );

      expect(codes(result)).toEqual(['missing-notify-trigger']);
      expect(result.problems[0]!.message).toContain('only on INSERT');
      expect(result.problems[0]!.message).toContain('UPDATE, DELETE');
    });

    it('should not count the triggers that notify another channel, or are disabled', () => {
      const result = evaluateLilypadSchema(
        facts({
          tables: [
            {
              schema: 'public',
              triggers: [
                notifier('other_events', ROW_TRIGGER),
                { ...notifier('cache_events', ROW_TRIGGER), enabled: false },
              ],
            },
          ],
        }),
        listenOptions
      );

      expect(codes(result)).toEqual(['missing-notify-trigger']);
    });

    it('should match a channel name with regular expression characters and quotes literally', () => {
      const channel = "cache.events'x";
      const escaped = channel.replace(/'/g, "''");
      const matching = { ...notifier(channel, ROW_TRIGGER), source: notifySource(escaped) };
      const lookalike = { ...notifier('cacheXevents', ROW_TRIGGER) };

      const accepted = evaluateLilypadSchema(
        facts({
          tables: [
            {
              schema: 'public',
              triggers: [matching, { ...matching, type: TRUNCATE_TRIGGER }],
            },
          ],
        }),
        { ...listenOptions, notifyChannel: channel }
      );
      const rejected = evaluateLilypadSchema(
        facts({ tables: [{ schema: 'public', triggers: [lookalike] }] }),
        { ...listenOptions, notifyChannel: 'cache.events' }
      );

      expect(accepted.ok).toBe(true);
      expect(codes(rejected)).toEqual(['missing-notify-trigger']);
    });

    it('should match the channel with its case, and pg_notify in any case', () => {
      const triggers = (source: string) => [
        { ...notifier('cache_events', ROW_TRIGGER), source },
        { ...notifier('cache_events', TRUNCATE_TRIGGER), source },
      ];
      const check = (source: string) =>
        evaluateLilypadSchema(
          facts({ tables: [{ schema: 'public', triggers: triggers(source) }] }),
          listenOptions
        );

      // LISTEN "cache_events" never receives the notifications of 'Cache_Events'
      expect(codes(check(notifySource('Cache_Events')))).toEqual(['missing-notify-trigger']);
      expect(check("BEGIN PERFORM PG_NOTIFY('cache_events', payload); END").ok).toBe(true);
    });

    it('should report a TRUNCATE that is not notified', () => {
      const result = evaluateLilypadSchema(
        facts({
          tables: [{ schema: 'public', triggers: [notifier('cache_events', ROW_TRIGGER)] }],
        }),
        listenOptions
      );

      expect(codes(result)).toEqual(['missing-truncate-trigger']);
    });
  });
});

describe('the pruning of the changelog', () => {
  const HOUR = 60 * 60_000;
  const DAY = 24 * HOUR;
  /** A database where nothing prunes the changelog, with these pg_cron facts. */
  const unpruned = (cron: Partial<LilypadSchemaFacts['cron']> = {}, changelog = {}) =>
    facts({
      cron: { available: false, installed: false, database: null, jobs: null, ...cron },
      changelog: { ...facts().changelog, ...changelog },
    });
  const triggerPrune = (olderThan: number, hasPruneFunction = true) =>
    unpruned(
      {},
      {
        functionSource: lilypadChangelogSql({
          prune: { olderThan, every: 10, batchSize: 500, force: true },
        }),
        hasPruneFunction,
      }
    );

  it('should find nothing to report with a pg_cron job of 24 hours', () => {
    const result = evaluateLilypadSchema(facts(), changelogOptions);

    expect(result.problems).toEqual([]);
  });

  describe('when nothing prunes it', () => {
    it('should suggest the prune option of the trigger without pg_cron, as a warning', () => {
      const result = evaluateLilypadSchema(unpruned(), changelogOptions);

      expect(result.ok).toBe(true);
      expect(result.problems).toEqual([
        expect.objectContaining({ code: 'no-changelog-pruning', severity: 'warning' }),
      ]);
      expect(result.problems[0]!.fix).toBe(
        lilypadChangelogSql({ notifyChannel: false, prune: { olderThan: DAY } })
      );
      expect(result.problems[0]!.message).toContain("pruning: 'external'");
      expect(result.problems[0]!.message).not.toContain('pg_cron is available');
    });

    it('should keep the notifications of the changelog in the suggested SQL', () => {
      const result = evaluateLilypadSchema(
        unpruned({}, { functionSource: notifySource('cache_events') }),
        changelogOptions
      );

      expect(result.problems[0]!.fix).toBe(
        lilypadChangelogSql({ notifyChannel: 'cache_events', prune: { olderThan: DAY } })
      );
    });

    it('should mention pg_cron when the server has it, but it is not known to run', () => {
      const result = evaluateLilypadSchema(unpruned({ available: true }), changelogOptions);

      expect(result.problems[0]!.fix).toContain('PERFORM %3$s()');
      expect(result.problems[0]!.message).toContain('pg_cron is available on this server');
    });

    it('should suggest a pg_cron job where pg_cron is installed', () => {
      const result = evaluateLilypadSchema(
        unpruned({ available: true, installed: true, database: 'app', jobs: [] }),
        changelogOptions
      );

      expect(result.problems[0]!.fix).toBe(lilypadChangelogPruneScheduleSql({ olderThan: DAY }));
      expect(result.problems[0]!.message).toContain('the jobs of the other roles are not visible');
    });

    it('should say that the jobs could not be read, rather than that there is none', () => {
      const result = evaluateLilypadSchema(
        unpruned({ available: true, installed: true, database: 'app', jobs: null }),
        changelogOptions
      );

      expect(result.problems[0]!.fix).toBe(lilypadChangelogPruneScheduleSql({ olderThan: DAY }));
      expect(result.problems[0]!.message).toContain('the role of the check cannot read its jobs');
      expect(result.problems[0]!.message).not.toContain('with no job of this role');
    });

    it('should install pg_cron where it runs but is not installed yet', () => {
      const result = evaluateLilypadSchema(
        unpruned({ available: true, database: 'app' }),
        changelogOptions
      );

      expect(result.problems[0]!.fix).toBe(
        'CREATE EXTENSION IF NOT EXISTS pg_cron;\n' +
          lilypadChangelogPruneScheduleSql({ olderThan: DAY })
      );
    });

    it('should schedule the job from the database pg_cron runs in', () => {
      const result = evaluateLilypadSchema(
        unpruned({ available: true, database: 'postgres' }),
        changelogOptions
      );

      expect(result.problems[0]!.message).toContain('pg_cron runs in the database "postgres"');
      // The alternative when the pg_cron database cannot be reached
      expect(result.problems[0]!.message).toContain(
        `lilypadChangelogSql({ prune: { olderThan: ${DAY} } })`
      );
      expect(result.problems[0]!.fixDatabase).toBe('postgres');
      expect(result.problems[0]!.fix).toBe(
        'CREATE EXTENSION IF NOT EXISTS pg_cron;\n' +
          lilypadChangelogPruneScheduleSql({
            olderThan: DAY,
            changelogTable: 'public.lilypad_cache_changes',
            database: 'app',
          })
      );
    });

    it('should keep the fix of the pg_cron database out of the migration of this one', () => {
      const facts = unpruned({ available: true, database: 'postgres' });
      facts.tables = [{ schema: 'public', triggers: [] }];
      const { problems } = evaluateLilypadSchema(facts, changelogOptions);
      expect(problems.map((problem) => problem.code)).toEqual([
        'missing-changelog-trigger',
        'no-changelog-pruning',
      ]);
      const cronFix = problems.find((problem) => problem.fixDatabase === 'postgres')!.fix!;

      const sql = formatLilypadSchemaFixSql(problems);
      expect(sql.startsWith(problems[0]!.fix!)).toBe(true);
      expect(sql).toContain('-- Run in the database "postgres", not in this one:\n');
      expect(sql).toContain('-- CREATE EXTENSION IF NOT EXISTS pg_cron;\n');
      expect(sql).not.toContain(`\n${cronFix}`);

      const text = formatLilypadSchemaProblems('lilypad-doctor', problems);
      expect(text).toContain('Run this SQL in a migration to fix it:');
      expect(text).toContain(`Run this SQL in the database "postgres":\n${cronFix}`);
    });

    it('should tell how to choose the suggestion', () => {
      const result = evaluateLilypadSchema(unpruned(), changelogOptions);

      expect(result.problems[0]!.message).toContain("set pruning: 'trigger' or 'cron'");
    });

    describe("with pruning: 'trigger'", () => {
      const options = { ...changelogOptions, changelog: { pruning: 'trigger' as const } };

      it.each([
        ['pg_cron is installed', { available: true, installed: true, database: 'app', jobs: [] }],
        ['pg_cron runs in another database', { available: true, database: 'postgres' }],
        ['pg_cron is available', { available: true }],
      ])('should suggest the prune option of the trigger when %s', (_, cron) => {
        const result = evaluateLilypadSchema(unpruned(cron), options);

        expect(codes(result)).toEqual(['no-changelog-pruning']);
        expect(result.problems[0]!.fix).toBe(
          lilypadChangelogSql({ notifyChannel: false, prune: { olderThan: DAY } })
        );
        expect(result.problems[0]!.message).not.toContain('pg_cron');
        expect(result.problems[0]!.message).not.toContain("set pruning: 'trigger' or 'cron'");
      });

      it('should install the changelog with the prune option when it is missing', () => {
        const result = evaluateLilypadSchema(
          facts({
            changelog: noChangelog,
            cron: { available: true, installed: true, database: 'app', jobs: [] },
          }),
          options
        );

        expect(codes(result)).toEqual(['missing-changelog', 'no-changelog-pruning']);
        expect(result.problems[0]!.fix).toContain('PERFORM %3$s()');
      });

      it('should still accept a pg_cron job found', () => {
        expect(evaluateLilypadSchema(facts(), options).problems).toEqual([]);
      });
    });

    describe("with pruning: 'cron'", () => {
      const options = { ...changelogOptions, changelog: { pruning: 'cron' as const } };

      it('should suggest a job in this database when it cannot tell where pg_cron runs', () => {
        const result = evaluateLilypadSchema(unpruned({ available: true }), options);

        expect(codes(result)).toEqual(['no-changelog-pruning']);
        expect(result.problems[0]!.fix).toBe(
          'CREATE EXTENSION IF NOT EXISTS pg_cron;\n' +
            lilypadChangelogPruneScheduleSql({ olderThan: DAY })
        );
        expect(result.problems[0]!.message).toContain('must be this one, "app"');
        expect(result.problems[0]!.message).toContain(
          `lilypadChangelogPruneScheduleSql({ olderThan: ${DAY}, changelogTable: 'public.lilypad_cache_changes', database: 'app' })`
        );
        expect(result.problems[0]!.message).not.toContain('lilypadChangelogSql');
        expect(result.problems[0]!.message).not.toContain('not available');
      });

      it('should say when the server does not have pg_cron', () => {
        const result = evaluateLilypadSchema(unpruned(), options);

        expect(result.problems[0]!.fix).toContain('CREATE EXTENSION IF NOT EXISTS pg_cron;\n');
        expect(result.problems[0]!.message).toContain('pg_cron is not available on this server');
      });

      it('should schedule from the database pg_cron runs in, without the trigger alternative', () => {
        const result = evaluateLilypadSchema(
          unpruned({ available: true, database: 'postgres' }),
          options
        );

        expect(result.problems[0]!.message).not.toContain('lilypadChangelogSql');
        expect(result.problems[0]!.fixDatabase).toBe('postgres');
      });

      it('should schedule from there even if the schema of the changelog is unknown', () => {
        const result = evaluateLilypadSchema(
          facts({
            changelog: noChangelog,
            cron: { available: true, installed: false, database: 'postgres', jobs: null },
          }),
          options
        );

        expect(codes(result)).toEqual(['missing-changelog', 'no-changelog-pruning']);
        // The changelog is installed without the prune option
        expect(result.problems[0]!.fix).not.toContain('PERFORM %3$s()');
        expect(result.problems[1]!.fix).toContain(
          lilypadChangelogPruneScheduleSql({
            olderThan: DAY,
            changelogTable: 'lilypad_cache_changes',
            database: 'app',
          })
        );
        expect(result.problems[1]!.message).toContain('Qualify the changelog table');
      });
    });

    it('should install the changelog with the suggested pruning when it is missing', () => {
      const result = evaluateLilypadSchema(
        facts({
          changelog: noChangelog,
          cron: { available: false, installed: false, database: null, jobs: null },
        }),
        changelogOptions
      );

      expect(codes(result)).toEqual(['missing-changelog', 'no-changelog-pruning']);
      // One SQL does both: the report shows it once
      expect(result.problems[0]!.fix).toBe(result.problems[1]!.fix);
      expect(result.problems[0]!.fix).toContain('PERFORM %3$s()');
    });

    it('should recommend a retention far longer than the one the caches need', () => {
      const result = evaluateLilypadSchema(unpruned(), {
        ...changelogOptions,
        changelog: { minRetention: 12 * HOUR },
      });

      expect(result.problems[0]!.fix).toBe(
        lilypadChangelogSql({ notifyChannel: false, prune: { olderThan: 2 * DAY } })
      );
    });

    it('should say how old the oldest row is', () => {
      const result = evaluateLilypadSchema(
        unpruned({}, { oldestRowAge: 40 * DAY }),
        changelogOptions
      );

      expect(codes(result)).toEqual(['no-changelog-pruning']);
      expect(result.problems[0]!.message).toContain('the oldest is 40 days old');
    });

    it('should mention an inactive pg_cron job', () => {
      const result = evaluateLilypadSchema(
        facts({ cron: { ...facts().cron, jobs: [{ ...pruneJob, active: false }] } }),
        changelogOptions
      );

      expect(codes(result)).toEqual(['no-changelog-pruning']);
      expect(result.problems[0]!.message).toContain('"lilypad_cache_changes_prune" deletes them');
    });

    it('should ignore a job of another database, or of another table', () => {
      const result = evaluateLilypadSchema(
        facts({
          cron: {
            ...facts().cron,
            jobs: [
              { ...pruneJob, database: 'other' },
              { ...pruneJob, command: 'DELETE FROM public.sessions WHERE expires_at < now()' },
            ],
          },
        }),
        changelogOptions
      );

      expect(codes(result)).toEqual(['no-changelog-pruning']);
    });
  });

  describe('when something prunes it that the check cannot see', () => {
    it("should suggest nothing with pruning: 'external'", () => {
      const result = evaluateLilypadSchema(unpruned(), {
        ...changelogOptions,
        changelog: { pruning: 'external' },
      });

      expect(result.problems).toEqual([]);
    });

    it('should suggest nothing once rows were deleted from the changelog', () => {
      const result = evaluateLilypadSchema(unpruned({}, { deletedRows: 1200 }), changelogOptions);

      expect(result.problems).toEqual([]);
    });

    it('should still report a changelog whose oldest row is far older than 24 hours', () => {
      const result = evaluateLilypadSchema(unpruned({}, { oldestRowAge: 9 * DAY }), {
        ...changelogOptions,
        changelog: { pruning: 'external' },
      });

      expect(result.ok).toBe(true);
      expect(result.problems).toEqual([
        expect.objectContaining({ code: 'unpruned-changelog', severity: 'warning' }),
      ]);
      expect(result.problems[0]!.message).toContain('9 days old');
      expect(result.problems[0]!.fix).toBe(
        'DELETE FROM "lilypad_cache_changes" WHERE changed_at < clock_timestamp() - make_interval(secs => 86400);\n'
      );
    });
  });

  describe('when the prune option of the trigger prunes it', () => {
    it('should find nothing to report with a retention of 24 hours', () => {
      const result = evaluateLilypadSchema(triggerPrune(DAY), changelogOptions);

      expect(result.problems).toEqual([]);
    });

    it('should report a retention the caches do not accept, as an error', () => {
      const result = evaluateLilypadSchema(triggerPrune(30 * 60_000), changelogOptions);

      expect(result.ok).toBe(false);
      expect(codes(result)).toEqual(['short-changelog-retention']);
      expect(result.problems[0]!.message).toContain(
        'The prune option of the changelog trigger deletes the changelog rows older than 30 minutes'
      );
      // The same option (and the notifications of the installed function), with a longer retention
      expect(result.problems[0]!.fix).toBe(
        lilypadChangelogSql({ prune: { olderThan: DAY, every: 10, batchSize: 500 } })
      );
    });

    it('should skip the pruning checks with checkPruning: false, keeping the installed pruning in the fix', () => {
      const outdated = {
        ...triggerPrune(30 * 60_000),
        changelog: {
          ...triggerPrune(30 * 60_000).changelog,
          functionComment: 'lilypad-changelog:2',
        },
      };

      const result = evaluateLilypadSchema(outdated, {
        ...changelogOptions,
        changelog: { checkPruning: false },
      });

      // No short-changelog-retention: only the problem that the caches need solved
      expect(codes(result)).toEqual(['outdated-changelog']);
      expect(result.problems[0]!.fix).toContain('lilypad-prune: olderThan=1800000');
    });

    it('should compare the retention with the minRetention of the caches', () => {
      const result = evaluateLilypadSchema(triggerPrune(DAY), {
        ...changelogOptions,
        changelog: { minRetention: 2 * DAY },
      });

      expect(codes(result)).toEqual(['short-changelog-retention']);
    });

    it('should report a trigger that calls a missing prune function', () => {
      const result = evaluateLilypadSchema(triggerPrune(DAY, false), changelogOptions);

      expect(codes(result)).toEqual(['missing-changelog']);
      expect(result.problems[0]!.message).toContain('lilypad_cache_changes_prune()');
    });

    it('should tell how to keep up when the oldest row is too old', () => {
      const result = evaluateLilypadSchema(
        unpruned(
          {},
          {
            functionSource: lilypadChangelogSql({ prune: { olderThan: DAY } }),
            hasPruneFunction: true,
            oldestRowAge: 10 * DAY,
          }
        ),
        changelogOptions
      );

      expect(codes(result)).toEqual(['unpruned-changelog']);
      expect(result.problems[0]!.message).toContain('raise batchSize or lower every');
    });
  });

  describe('when a pg_cron job prunes it', () => {
    const withJob = (job: Partial<LilypadCronJobInfo>, changelog = {}) =>
      facts({
        cron: { ...facts().cron, jobs: [{ ...pruneJob, ...job }] },
        changelog: { ...facts().changelog, ...changelog },
      });

    it('should report a job whose retention the caches do not accept, and keep its schedule', () => {
      const result = evaluateLilypadSchema(
        withJob({
          schedule: '*/10 * * * *',
          command: "DELETE FROM lilypad_cache_changes WHERE changed_at < now() - interval '1 hour'",
        }),
        changelogOptions
      );

      expect(codes(result)).toEqual(['short-changelog-retention']);
      expect(result.problems[0]!.message).toContain(
        'The pg_cron job "lilypad_cache_changes_prune" deletes the changelog rows older than 1 hour'
      );
      expect(result.problems[0]!.fix).toBe(
        lilypadChangelogPruneScheduleSql({
          olderThan: DAY,
          schedule: '*/10 * * * *',
          jobName: 'lilypad_cache_changes_prune',
        })
      );
    });

    it('should read the retention of the statement of a job that deletes from the changelog', () => {
      const result = evaluateLilypadSchema(
        withJob({
          command:
            "DELETE FROM sessions WHERE expires_at < now() - interval '30 minutes'; DELETE FROM lilypad_cache_changes WHERE changed_at < now() - interval '7 days'",
        }),
        changelogOptions
      );

      expect(result.problems).toEqual([]);
    });

    it('should report the short retention of a job that does more, without scheduling it again', () => {
      const result = evaluateLilypadSchema(
        withJob({
          command:
            "DELETE FROM lilypad_cache_changes WHERE changed_at < now() - interval '30 minutes'; VACUUM lilypad_cache_changes",
        }),
        changelogOptions
      );

      expect(codes(result)).toEqual(['short-changelog-retention']);
      // Scheduled again, the job would lose its VACUUM
      expect(result.problems[0]!.fix).toBeUndefined();
      expect(result.problems[0]!.message).toContain('change its interval there');
    });

    it('should reschedule a job of the library with a short retention', () => {
      const result = evaluateLilypadSchema(
        withJob({
          command:
            'DELETE FROM "public"."lilypad_cache_changes" WHERE changed_at < clock_timestamp() - make_interval(secs => 1800);',
        }),
        changelogOptions
      );

      expect(codes(result)).toEqual(['short-changelog-retention']);
      expect(result.problems[0]!.fix).toContain(
        "SELECT cron.schedule('lilypad_cache_changes_prune'"
      );
    });

    it('should not reschedule a job whose DELETE has another condition', () => {
      const result = evaluateLilypadSchema(
        withJob({
          command:
            "DELETE FROM lilypad_cache_changes WHERE changed_at < now() - interval '30 minutes' AND table_name = 'users'",
        }),
        changelogOptions
      );

      expect(codes(result)).toEqual(['short-changelog-retention']);
      // Scheduled again, the job would delete the rows of every table
      expect(result.problems[0]!.fix).toBeUndefined();
    });

    it('should not read the retention of a DELETE in a CTE, whose job does more', () => {
      const result = evaluateLilypadSchema(
        withJob({
          command:
            "WITH gone AS (DELETE FROM lilypad_cache_changes WHERE changed_at < now() - interval '30 minutes' RETURNING *) INSERT INTO archive SELECT * FROM gone",
        }),
        changelogOptions
      );

      expect(result.problems).toEqual([]);
    });

    it('should not take the job of a changelog of the same name in another schema', () => {
      const result = evaluateLilypadSchema(
        withJob({
          command:
            "DELETE FROM archive.lilypad_cache_changes WHERE changed_at < now() - interval '30 minutes'",
        }),
        changelogOptions
      );

      // Not a short retention of this changelog, whose fix would take over the other job
      expect(codes(result)).toEqual(['no-changelog-pruning']);
    });

    it('should accept a job whose retention it cannot read', () => {
      const result = evaluateLilypadSchema(
        withJob({
          command: 'DELETE FROM lilypad_cache_changes WHERE changed_at < current_date - 7',
        }),
        changelogOptions
      );

      expect(result.problems).toEqual([]);
    });

    it('should accept a job of pg_cron without a database column', () => {
      const result = evaluateLilypadSchema(withJob({ database: null }), changelogOptions);

      expect(result.problems).toEqual([]);
    });

    it('should report a job that does not run, from the age of the oldest row', () => {
      const result = evaluateLilypadSchema(
        withJob({}, { oldestRowAge: 8 * DAY + HOUR }),
        changelogOptions
      );

      expect(codes(result)).toEqual(['unpruned-changelog']);
      expect(result.problems[0]!.message).toContain(
        'the pg_cron job "lilypad_cache_changes_prune" does not run, or does not keep up'
      );
    });

    it('should leave a weekly job its week', () => {
      const result = evaluateLilypadSchema(
        withJob({}, { oldestRowAge: 7 * DAY }),
        changelogOptions
      );

      expect(result.problems).toEqual([]);
    });
  });

  it('should not check the pruning without a changelog to check', () => {
    const result = evaluateLilypadSchema(unpruned(), { ...changelogOptions, changelog: false });

    expect(result.problems).toEqual([]);
  });

  it('should reject an invalid minRetention', () => {
    expect(() =>
      evaluateLilypadSchema(facts(), { ...changelogOptions, changelog: { minRetention: NaN } })
    ).toThrow('changelog.minRetention');
  });
});

describe('lilypadPruneCommandRetention', () => {
  it.each([
    ['make_interval(secs => 86400)', 86_400_000],
    ["now() - interval '7 days'", 7 * 86_400_000],
    ["now() - '36 hours'::interval", 36 * 3_600_000],
    ["now() - INTERVAL '1 day 12:30:00'", 86_400_000 + 12.5 * 3_600_000],
    ["now() - interval '90 min'", 90 * 60_000],
    ["now() - interval '1 mon'", 30 * 86_400_000],
    ["now() - interval '2w'", 14 * 86_400_000],
    ["now() - interval '1 year'", 365 * 86_400_000],
    ["now() - interval '90 minutes 500 ms'", 90 * 60_000 + 500],
    ['current_date - 7', undefined],
    // Not understood, so unknown: never misread as a shorter retention
    ["now() - interval 'P1M'", undefined],
    ["now() - interval 'P1DT2H'", undefined],
    ["now() - interval '1 decade 30 minutes'", undefined],
    ["now() - interval '-1 day'", undefined],
    ["now() - interval '1 day ago'", undefined],
    ["now() - interval ''", undefined],
    // A comment is not the condition
    ["now() - interval '7 days' -- interval '1 minute'", 7 * 86_400_000],
    ["/* interval '1 minute' */ now() - interval '7 days'", 7 * 86_400_000],
    ["now() - interval '7 days' /* /* nested */ interval '1 minute' */", 7 * 86_400_000],
    ["now() - interval '7 days';", 7 * 86_400_000],
    // Two intervals: either may be the retention
    ["now() - interval '1 year' AND changed_at > now() - interval '1 minute'", undefined],
  ])('should read %s', (condition, expected) => {
    expect(
      lilypadPruneCommandRetention(
        `DELETE FROM lilypad_cache_changes WHERE changed_at < ${condition}`,
        'lilypad_cache_changes'
      )
    ).toBe(expected);
  });

  it.each([
    [
      'the DELETE of the changelog among other statements',
      "DELETE FROM sessions WHERE expires_at < now() - interval '1 minute'; DELETE FROM lilypad_cache_changes WHERE changed_at < now() - interval '7 days'",
      7 * 86_400_000,
    ],
    [
      'two statements that delete from the changelog',
      "DELETE FROM lilypad_cache_changes WHERE op = 'TRUNCATE'; DELETE FROM lilypad_cache_changes WHERE changed_at < now() - interval '7 days'",
      undefined,
    ],
    [
      // The -- of a dollar-quoted string is no comment: two intervals
      'a dollar-quoted string',
      "DELETE FROM lilypad_cache_changes WHERE changed_at < now() - interval '7 days' AND note <> $$--$$ OR changed_at < now() - interval '1 minute'",
      undefined,
    ],
    [
      'a DELETE in a DO block',
      "DO $$ BEGIN DELETE FROM lilypad_cache_changes WHERE changed_at < now() - interval '1 hour'; END $$",
      undefined,
    ],
    [
      // The escape string is ' -- ': the rest of the line is not a comment
      'a condition after an escape string',
      "DELETE FROM lilypad_cache_changes WHERE op <> E'\\' -- ' AND changed_at < now() - interval '30 minutes'",
      30 * 60_000,
    ],
  ])('should read %s', (_case, command, expected) => {
    expect(lilypadPruneCommandRetention(command, 'lilypad_cache_changes')).toBe(expected);
  });
});

describe('lilypadCommandDeletesFrom', () => {
  it.each([
    ['DELETE FROM lilypad_cache_changes WHERE true', 'lilypad_cache_changes', true],
    ['delete from "public"."lilypad_cache_changes" where true', 'lilypad_cache_changes', true],
    ['DELETE FROM ONLY app.changes WHERE true', 'app.changes', true],
    ['DELETE FROM app.changes WHERE true', 'other.changes', false],
    ['DELETE FROM lilypad_cache_changes_old WHERE true', 'lilypad_cache_changes', false],
    ['SELECT * FROM lilypad_cache_changes', 'lilypad_cache_changes', false],
    // Comments delete nothing
    ['SELECT 1 -- DELETE FROM lilypad_cache_changes', 'lilypad_cache_changes', false],
    ['SELECT 1 /* DELETE FROM lilypad_cache_changes */', 'lilypad_cache_changes', false],
    ["SELECT '-- not a comment'; DELETE FROM lilypad_cache_changes", 'lilypad_cache_changes', true],
    // Names as PostgreSQL reads them: quoted ones keep their case and may hold spaces and quotes
    ['DELETE FROM public."My Changes" WHERE true', 'public.My Changes', true],
    ['DELETE FROM "a""b" WHERE true', 'a"b', true],
    ['DELETE FROM Lilypad_Cache_Changes WHERE true', 'lilypad_cache_changes', true],
    ['DELETE FROM mychanges WHERE true', 'MyChanges', false],
    ['DELETE FROM "MYCHANGES" WHERE true', 'MyChanges', false],
    ['WITH gone AS (DELETE FROM changes RETURNING id) SELECT 1', 'changes', true],
    // PostgreSQL nests the block comments, and a command left open is not understood
    ['SELECT 1 /* a /* b */ DELETE FROM lilypad_cache_changes */', 'lilypad_cache_changes', false],
    ['SELECT 1 /* DELETE FROM lilypad_cache_changes', 'lilypad_cache_changes', false],
    ["SELECT 'x; DELETE FROM lilypad_cache_changes", 'lilypad_cache_changes', false],
    // The body of a DO block is code, any other dollar-quoted string a literal
    ['DO $$ BEGIN DELETE FROM lilypad_cache_changes; END $$', 'lilypad_cache_changes', true],
    ['DO $body$ BEGIN DELETE FROM a$b; END $body$', 'a$b', true],
    [
      'DO LANGUAGE plpgsql $$ BEGIN DELETE FROM lilypad_cache_changes; END $$',
      'lilypad_cache_changes',
      true,
    ],
    ['SELECT $$DELETE FROM lilypad_cache_changes$$', 'lilypad_cache_changes', false],
    ['SELECT $$ DELETE FROM lilypad_cache_changes', 'lilypad_cache_changes', false],
    [
      "DO $$ BEGIN DELETE FROM lilypad_cache_changes WHERE 'x; END $$",
      'lilypad_cache_changes',
      false,
    ],
  ])('%s (%s): %s', (command, table, expected) => {
    expect(lilypadCommandDeletesFrom(command, table)).toBe(expected);
  });
});

describe('formatLilypadSchemaProblems', () => {
  it('should tell errors from warnings', () => {
    const warning = {
      code: 'no-changelog-pruning' as const,
      severity: 'warning' as const,
      message: 'Nothing deletes the old rows.',
      fix: 'SELECT 1;',
    };

    expect(formatLilypadSchemaProblems('Cache', [warning])).toBe(
      'Cache: the database is set up, with warnings.\n- Warning: Nothing deletes the old rows.\nRun this SQL in a migration to fix it:\nSELECT 1;'
    );
    expect(
      formatLilypadSchemaProblems('Cache', [
        { code: 'missing-table', severity: 'error', message: 'No table.' },
        warning,
      ])
    ).toMatch(/^Cache: the database is not set up\.\n- No table\.\n- Warning: /);
  });
});

describe('evaluateLilypadSchema with the tables of a config', () => {
  const orgs = {
    tableName: 'orgs',
    primaryKey: 'id',
    cols: { id: { pgType: 'int4' } },
    sync: { strategy: 'listen' },
  } as const;
  const db = defineLilypadDb({
    changelog: { pruning: 'external', minRetention: 2 * 3_600_000 },
    tables: {
      orgs,
      users: {
        tableName: 'users',
        primaryKey: 'id',
        cols: {
          id: { pgType: 'int4' },
          orgId: { pgType: 'int4', references: { table: 'orgs' } },
        },
        sync: { strategy: 'changelog', pollInterval: 1000, maxGap: 3 * 3_600_000 },
      },
      logs: {
        tableName: 'logs',
        primaryKey: 'id',
        cols: { id: {} },
        sync: { strategy: 'none' },
      },
    },
  });
  const options = lilypadSchemaCheckOptions(db);

  it('should check each table for what its sync needs, with its shape', () => {
    expect(options).toEqual({
      tables: [
        {
          table: 'public.orgs',
          primaryKey: 'id',
          changelog: false,
          notifyChannel: 'cache_events',
          shape: db.tables.orgs,
        },
        {
          table: 'public.users',
          primaryKey: 'id',
          changelog: true,
          notifyChannel: false,
          shape: db.tables.users,
        },
        {
          table: 'public.logs',
          primaryKey: 'id',
          changelog: false,
          notifyChannel: false,
          shape: db.tables.logs,
        },
      ],
      // The longest of minRetention and the maxGap of the changelog tables
      changelog: {
        table: 'lilypad_cache_changes',
        pruning: 'external',
        minRetention: 3 * 3_600_000,
        checkPruning: true,
      },
      changelogTable: 'lilypad_cache_changes',
      notifyChannel: false,
    });
    expect(lilypadSchemaCheckOptions(defineLilypadDb({ tables: { orgs: orgs } })).changelog).toBe(
      false
    );
  });

  it('should install the changelog of the config in the fixes of listen tables alone', () => {
    const listenOnly = defineLilypadDb({
      changelog: { table: 'app_changes' },
      tables: { orgs: orgs },
    });
    const listenOptions = lilypadSchemaCheckOptions(listenOnly);
    const result = evaluateLilypadSchema(
      facts({ changelog: noChangelog, tables: [{ schema: 'public', triggers: [] }] }),
      listenOptions
    );

    expect(listenOptions.changelog).toBe(false);
    expect(result.problems.map((problem) => problem.code)).toEqual(['missing-notify-trigger']);
    expect(result.problems[0]!.fix).toContain('CREATE TABLE IF NOT EXISTS "app_changes"');
    expect(result.problems[0]!.fix).toContain('app_changes_record');
    expect(result.problems[0]!.fix).not.toContain('lilypad_cache_changes');
  });

  it('should require the changelog trigger or the notifying trigger per table', () => {
    const shaped = (columns: string[]) => ({
      columns: columns.map((name) => ({
        name,
        type: 'integer',
        category: 'N',
        notNull: name === 'id',
        hasDefault: false,
        identity: false,
        generated: false,
      })),
      constraints: [
        {
          name: 'pkey',
          type: 'p' as const,
          columns: ['id'],
          referencedTable: null,
          referencedColumns: [],
          onDelete: ' ',
          onUpdate: ' ',
        },
      ],
      indexes: [],
    });
    const result = evaluateLilypadSchema(
      facts({
        tables: [
          { schema: 'public', triggers: [], ...shaped(['id']) },
          { schema: 'public', triggers: [], ...shaped(['id', 'orgId']) },
          { schema: 'public', triggers: [], ...shaped(['id']) },
        ],
      }),
      options
    );

    expect(result.problems.map((problem) => [problem.table, problem.code])).toEqual([
      ['public.orgs', 'missing-notify-trigger'],
      ['public.users', 'missing-changelog-trigger'],
      ['public.users', 'missing-foreign-key'],
    ]);
  });

  it('should create a missing table with its triggers, and its foreign keys after every table', () => {
    const result = evaluateLilypadSchema(
      facts({
        tables: [
          { schema: null, triggers: [] },
          { schema: null, triggers: [] },
          { schema: null, triggers: [] },
        ],
      }),
      options
    );

    expect(result.problems.map((problem) => [problem.table, problem.code])).toEqual([
      ['public.orgs', 'missing-table'],
      ['public.users', 'missing-table'],
      ['public.logs', 'missing-table'],
      ['public.users', 'missing-foreign-key'],
    ]);
    const [orgs, users, logs, foreignKey] = result.problems;
    expect(orgs!.fix).toMatch(/^CREATE TABLE "public"\."orgs" \(\n {2}"id" int4 NOT NULL,/);
    // Without the changelog check for a listen table, the changelog (which notifies) comes along
    expect(orgs!.fix).toContain("pg_notify('cache_events'");
    expect(users!.fix).toContain('CREATE TABLE "public"."users"');
    expect(users!.fix).toContain('lilypad_cache_changes_record');
    // No pgType for its column: the table cannot be generated
    expect(logs!.fix).toBeUndefined();
    expect(foreignKey!.fix).toBe(
      'ALTER TABLE "public"."users" ADD FOREIGN KEY ("orgId") REFERENCES "public"."orgs" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;'
    );
  });

  it('should create the schema of a missing table when it does not exist either', () => {
    const result = evaluateLilypadSchema(
      facts({
        tables: [
          { schema: null, triggers: [], missingSchema: 'public' },
          { schema: null, triggers: [] },
          { schema: null, triggers: [] },
        ],
      }),
      options
    );

    expect(result.problems[0]!.message).toBe(
      'The table "public.orgs" does not exist, nor its schema "public".'
    );
    expect(result.problems[0]!.fix).toMatch(
      /^CREATE SCHEMA IF NOT EXISTS "public";\nCREATE TABLE "public"\."orgs"/
    );
    expect(result.problems[1]!.fix).toMatch(/^CREATE TABLE "public"\."users"/);
  });

  it('should install one changelog, with the pruning and the channel the tables need, in every fix', () => {
    // A listen table and a changelog table, on a database without the changelog nor pg_cron
    const mixed = defineLilypadDb({
      tables: {
        orgs,
        items: {
          tableName: 'items',
          primaryKey: 'id',
          cols: { id: { pgType: 'int4' } },
          sync: { strategy: 'changelog', pollInterval: 1000 },
        },
      },
    });
    const result = evaluateLilypadSchema(
      facts({
        changelog: noChangelog,
        cron: { available: false, installed: false, database: null, jobs: null },
        tables: [
          { schema: 'public', triggers: [] },
          { schema: 'public', triggers: [] },
        ],
      }),
      lilypadSchemaCheckOptions(mixed)
    );

    expect(result.problems.map((problem) => problem.code)).toEqual([
      'missing-changelog',
      'missing-notify-trigger',
      'missing-changelog-trigger',
      'no-changelog-pruning',
    ]);
    const changelogSql = lilypadChangelogSql({
      notifyChannel: 'cache_events',
      prune: { olderThan: 24 * 3_600_000 },
    });
    expect(result.problems[0]!.fix).toBe(changelogSql);
    expect(result.problems[3]!.fix).toBe(changelogSql);
    // Installed once, before: the fixes of the tables do not install it again without its pruning
    expect(result.problems[1]!.fix).toBe(
      lilypadChangelogTriggerSql({ table: 'public.orgs', primaryKey: 'id' })
    );
  });

  it('should not fix the notifications of a table on another channel than the changelog one', () => {
    const result = evaluateLilypadSchema(
      facts({
        changelog: noChangelog,
        tables: [
          { schema: 'public', triggers: [] },
          { schema: 'public', triggers: [] },
        ],
      }),
      {
        tables: [
          { table: 'a', primaryKey: 'id', notifyChannel: 'one' },
          { table: 'b', primaryKey: 'id', notifyChannel: 'two' },
        ],
        changelog: false,
      }
    );

    expect(result.problems.map((problem) => problem.code)).toEqual([
      'missing-notify-trigger',
      'missing-notify-trigger',
    ]);
    expect(result.problems[0]!.fix).toContain("pg_notify('one'");
    expect(result.problems[1]!.fix).toBeUndefined();
    expect(result.problems[1]!.message).toContain(
      'The changelog trigger function notifies on one channel ("one"): give "b" a notifying trigger of its own.'
    );
  });
});
