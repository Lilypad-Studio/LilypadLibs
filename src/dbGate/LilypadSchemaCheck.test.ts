import { describe, it, expect } from 'vitest';
import { lilypadChangelogPruneScheduleSql, lilypadChangelogSql } from './LilypadChangelog';
import {
  evaluateLilypadSchema,
  formatLilypadSchemaProblems,
  lilypadCommandDeletesFrom,
  lilypadPruneCommandRetention,
  type LilypadCronJobInfo,
  type LilypadSchemaCheckOptions,
  type LilypadSchemaFacts,
  type LilypadTriggerInfo,
} from './LilypadSchemaCheck';

// pg_trigger.tgtype: ROW = 1, INSERT = 4, DELETE = 8, UPDATE = 16, TRUNCATE = 32
const ROW_TRIGGER = 1 | 4 | 8 | 16;
const TRUNCATE_TRIGGER = 32;

const changelogRow: LilypadTriggerInfo = {
  changelog: true,
  args: 'id\\000',
  type: ROW_TRIGGER,
  enabled: true,
  source: '',
};
const changelogTruncate: LilypadTriggerInfo = { ...changelogRow, type: TRUNCATE_TRIGGER };
/** The statement triggers installed by version 4, one per event, with their transition tables. */
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
      functionComment: 'lilypad-changelog:4',
      functionSource: null,
      schema: 'public',
      hasPruneFunction: false,
      oldestRowAge: 60_000,
      deletedRows: 0,
    },
    cron: { available: true, installed: true, database: 'app', jobs: [pruneJob] },
    tables: [{ schema: 'public', triggers: [changelogRow, changelogTruncate] }],
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
    expect(codes(evaluateLilypadSchema(facts({ version: 120000 }), changelogOptions))).toContain(
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
      expect(fix(result)).not.toContain('PERFORM "lilypad_cache_changes_prune"()');
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
    ['a disabled trigger', [{ ...changelogRow, enabled: false }, changelogTruncate]],
    ['a trigger without DELETE', [{ ...changelogRow, type: 1 | 4 | 16 }, changelogTruncate]],
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
            triggers: [{ ...changelogRow, args: 'uuid\\000' }, changelogTruncate],
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
      { ...changelogStatements[2]!, args: 'uuid\\000' },
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
      facts({ tables: [{ schema: 'public', triggers: [changelogRow] }] }),
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
      args: '',
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
        functionSource: lilypadChangelogSql({ prune: { olderThan, every: 10, batchSize: 500 } }),
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

      expect(result.problems[0]!.fix).toContain('PERFORM "lilypad_cache_changes_prune"()');
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
      expect(result.problems[0]!.fix).toBe(
        '-- Run in the database "postgres", where pg_cron runs:\n' +
          'CREATE EXTENSION IF NOT EXISTS pg_cron;\n' +
          lilypadChangelogPruneScheduleSql({
            olderThan: DAY,
            changelogTable: 'public.lilypad_cache_changes',
            database: 'app',
          })
      );
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
      expect(result.problems[0]!.fix).toContain('PERFORM "lilypad_cache_changes_prune"()');
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
    ['current_date - 7', undefined],
  ])('should read %s', (condition, expected) => {
    expect(
      lilypadPruneCommandRetention(
        `DELETE FROM lilypad_cache_changes WHERE changed_at < ${condition}`
      )
    ).toBe(expected);
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
