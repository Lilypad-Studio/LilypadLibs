import { describe, it, expect } from 'vitest';
import {
  installedLilypadChangelogPrune,
  LILYPAD_CHANGELOG_VERSION,
  lilypadChangelogPruneScheduleSql,
  lilypadChangelogSql,
  lilypadChangelogTriggerSql,
  pruneLilypadChangelog,
} from './LilypadChangelog';
import type { LilypadDbGate } from './LilypadDbGate';

// The SQL itself runs against PostgreSQL in LilypadDbGate.integration.test.ts
describe('lilypadChangelogSql prune option', () => {
  it('should not prune by default, and drop the prune function of an earlier installation', () => {
    const sql = lilypadChangelogSql();

    expect(sql).not.toContain('PERFORM "lilypad_cache_changes_prune"()');
    expect(sql).toContain('DROP FUNCTION IF EXISTS "lilypad_cache_changes_prune"();');
    expect(installedLilypadChangelogPrune(sql)).toBe(false);
  });

  it('should call the prune function before each return of the trigger function', () => {
    const sql = lilypadChangelogSql({ prune: { olderThan: 86_400_000 } });

    expect(sql).toContain('CREATE OR REPLACE FUNCTION %s() RETURNS void AS %L');
    expect(sql).toContain(`'"lilypad_cache_changes_prune"', format($body$`);
    expect(sql).toContain('make_interval(secs => 86400)');
    expect(sql).toContain('LIMIT 1000');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).not.toContain('DROP FUNCTION');
    // The TRUNCATE and statement branches
    expect(sql.match(/PERFORM "lilypad_cache_changes_prune"\(\);/g)).toHaveLength(2);
    expect(sql).toContain('IF random() * 20 < 1 AND');
  });

  it('should record its options in the trigger function, for the schema check', () => {
    const prune = { olderThan: 1_500, every: 3, batchSize: 50 };

    expect(installedLilypadChangelogPrune(lilypadChangelogSql({ prune }))).toEqual(prune);
    expect(
      installedLilypadChangelogPrune(lilypadChangelogSql({ prune: { olderThan: 60_000 } }))
    ).toEqual({ olderThan: 60_000, every: 20, batchSize: 1000 });
  });

  it('should search pg_temp last, so that a temporary table cannot stand for the changelog', () => {
    const sql = lilypadChangelogSql({ prune: { olderThan: 86_400_000 } });

    expect(sql).toContain('SECURITY DEFINER SET search_path = pg_catalog, pg_temp');
    expect(sql).not.toContain('FROM CURRENT');
  });

  it('should name the prune function after the changelog table', () => {
    const sql = lilypadChangelogSql({
      changelogTable: 'archive.changes',
      prune: { olderThan: 60_000 },
    });

    expect(sql).toContain('PERFORM "archive_changes_prune"();');
    // Qualified with its schema by the migration, in the DO block that creates the function
    expect(sql).toContain(`WHERE c.oid = '"archive"."changes"'::regclass`);
    expect(sql).toContain('DELETE FROM %1$s WHERE id IN');
    expect(sql).toContain(`'"archive_changes_prune"', format($body$`);
  });

  it('should refuse the `table` option of earlier versions, which the trigger helper uses for the cached table', () => {
    // @ts-expect-error: the option is `changelogTable`
    expect(() => lilypadChangelogSql({ table: 'accounts' })).toThrow(
      'the `table` option is now `changelogTable`'
    );
  });

  it.each([
    [{ olderThan: 0 }, 'prune.olderThan'],
    [{ olderThan: Number.NaN }, 'prune.olderThan'],
    [{ olderThan: 60_000, every: 0 }, 'prune.every'],
    [{ olderThan: 60_000, every: 1.5 }, 'prune.every'],
    [{ olderThan: 60_000, batchSize: 0 }, 'prune.batchSize'],
  ])('should reject the prune options %o', (prune, name) => {
    expect(() => lilypadChangelogSql({ prune })).toThrow(name);
  });
});

describe('lilypadChangelogPruneScheduleSql', () => {
  it('should schedule a daily job that deletes the old rows of the changelog, qualified with its schema', () => {
    const sql = lilypadChangelogPruneScheduleSql({ olderThan: 86_400_000 });

    expect(sql).toContain(
      `SELECT cron.schedule('lilypad_cache_changes_prune', '0 3 * * *', format(`
    );
    expect(sql).toContain(
      `'DELETE FROM %I.%I WHERE changed_at < clock_timestamp() - make_interval(secs => 86400)'`
    );
    expect(sql).toContain(`WHERE c.oid = '"lilypad_cache_changes"'::regclass;`);
  });

  it('should take the schedule, the job name and the changelog table', () => {
    const sql = lilypadChangelogPruneScheduleSql({
      olderThan: 3_600_000,
      schedule: '*/10 * * * *',
      jobName: "app's prune",
      changelogTable: 'app.changes',
    });

    expect(sql).toContain(`cron.schedule('app''s prune', '*/10 * * * *'`);
    expect(sql).toContain(`'"app"."changes"'::regclass`);
  });

  it('should schedule the job in another database', () => {
    const sql = lilypadChangelogPruneScheduleSql({
      olderThan: 86_400_000,
      changelogTable: 'public.lilypad_cache_changes',
      database: 'app',
    });

    expect(sql).toBe(
      `SELECT cron.schedule_in_database('public_lilypad_cache_changes_prune', '0 3 * * *', 'DELETE FROM "public"."lilypad_cache_changes" WHERE changed_at < clock_timestamp() - make_interval(secs => 86400)', 'app');\n`
    );
  });

  it('should reject an invalid retention', () => {
    expect(() => lilypadChangelogPruneScheduleSql({ olderThan: -1 })).toThrow('olderThan');
  });
});

describe('lilypadChangelogSql notifications', () => {
  it('should send one BULK notification above the threshold of rows of a statement', () => {
    const sql = lilypadChangelogSql({ notifyBulkThreshold: 50 });

    expect(sql).toContain('GET DIAGNOSTICS recorded = ROW_COUNT;');
    expect(sql).toContain('IF recorded > 50 THEN');
    expect(sql).toContain("'op', 'BULK'");
    expect(sql).toContain(
      `COMMENT ON FUNCTION "lilypad_cache_changes_record"() IS 'lilypad-changelog:${LILYPAD_CHANGELOG_VERSION}'`
    );
  });

  it('should send no notification at all without a channel', () => {
    const sql = lilypadChangelogSql({ notifyChannel: false });

    expect(sql).not.toContain('pg_notify');
    expect(sql).not.toContain('BULK');
  });

  it('should reject an invalid threshold', () => {
    expect(() => lilypadChangelogSql({ notifyBulkThreshold: 0 })).toThrow('notifyBulkThreshold');
  });
});

describe('pruneLilypadChangelog', () => {
  // Rejected before any query: the gate is never used
  const gate = {} as LilypadDbGate;

  it.each([
    [{ olderThan: Number.NaN }, 'olderThan must be'],
    [{ olderThan: -1 }, 'olderThan must be'],
    [{ olderThan: 86_400_000, batchSize: 0 }, 'batchSize must be'],
    // Seconds instead of milliseconds: 86 seconds
    [{ olderThan: 86_400 }, 'less than one hour'],
  ])('should reject %o', async (options, message) => {
    await expect(pruneLilypadChangelog(gate, options)).rejects.toThrow(message);
  });
});

describe('lilypadChangelogTriggerSql', () => {
  const triggerNames = (sql: string) =>
    [...sql.matchAll(/CREATE TRIGGER "([^"]+)"/g)].map((match) => match[1]!);

  it('should name the triggers after the table', () => {
    expect(
      triggerNames(lilypadChangelogTriggerSql({ table: 'public.users', primaryKey: 'id' }))
    ).toEqual([
      'public_users_lilypad_insert',
      'public_users_lilypad_update',
      'public_users_lilypad_delete',
      'public_users_lilypad_truncate',
    ]);
  });

  it('should keep distinct trigger names that PostgreSQL does not truncate, for a long table name', () => {
    const table = `public.${'x'.repeat(50)}`;
    const sql = lilypadChangelogTriggerSql({ table, primaryKey: 'id' });
    const names = triggerNames(sql);

    expect(new Set(names).size).toBe(4);
    for (const name of names) {
      expect(name.length).toBeLessThanOrEqual(63);
    }
    expect(
      triggerNames(
        lilypadChangelogTriggerSql({ table: `public.${'x'.repeat(51)}`, primaryKey: 'id' })
      )
    ).not.toEqual(names);
    // The names of the earlier versions, which PostgreSQL truncated alike, are dropped
    expect(sql).toContain(`DROP TRIGGER IF EXISTS "public_${'x'.repeat(50)}_lilypad_insert"`);
  });
});

describe('lilypadChangelogSql dollar quotes', () => {
  it('should quote the bodies with tags that the names do not contain', () => {
    const sql = lilypadChangelogSql({
      changelogTable: 'odd$$record$lilypad$function$',
      notifyChannel: 'odd$notify$',
      prune: { olderThan: 86_400_000 },
    });

    expect(sql).toContain('DO $lilypad_$');
    expect(sql).toContain('format($body$');
    expect(sql).toContain('RETURNS trigger AS $_$');
    expect(sql).toContain('EXECUTE format($record_$');
    expect(sql).toContain('EXECUTE format($notify_$');
  });

  it('should leave the SQL of ordinary names as it is', () => {
    const sql = lilypadChangelogSql();

    expect(sql).toContain('RETURNS trigger AS $$');
    expect(sql).toContain('EXECUTE format($record$');
    expect(sql).toContain('EXECUTE format($notify$');
  });
});
