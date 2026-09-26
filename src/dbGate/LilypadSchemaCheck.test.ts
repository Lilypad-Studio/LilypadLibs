import { describe, it, expect } from 'vitest';
import {
  evaluateLilypadSchema,
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

const notifySource = (channel: string) => `BEGIN PERFORM pg_notify('${channel}', payload); END`;

function facts(overrides: Partial<LilypadSchemaFacts> = {}): LilypadSchemaFacts {
  return {
    version: 160000,
    changelog: {
      hasTable: true,
      hasSchemaColumn: true,
      hasFunction: true,
      functionComment: 'lilypad-changelog:3',
    },
    tables: [{ schema: 'public', triggers: [changelogRow, changelogTruncate] }],
    ...overrides,
  };
}

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
    const result = evaluateLilypadSchema(
      facts({
        changelog: {
          hasTable: false,
          hasSchemaColumn: false,
          hasFunction: false,
          functionComment: null,
        },
      }),
      changelogOptions
    );

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
  ])('should report a missing changelog trigger with %s', (_case, triggers) => {
    const result = evaluateLilypadSchema(
      facts({ tables: [{ schema: 'public', triggers }] }),
      changelogOptions
    );

    expect(codes(result)).toEqual(['missing-changelog-trigger']);
    expect(result.problems[0]!.fix).toContain('CREATE TRIGGER "items_lilypad_changes"');
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
