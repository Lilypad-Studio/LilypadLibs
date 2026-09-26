import { describe, it, expect } from 'vitest';
import {
  installedLilypadChangelogPrune,
  lilypadChangelogPruneScheduleSql,
  lilypadChangelogSql,
} from './LilypadChangelog';

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

    expect(sql).toContain('CREATE OR REPLACE FUNCTION "lilypad_cache_changes_prune"()');
    expect(sql).toContain('make_interval(secs => 86400)');
    expect(sql).toContain('LIMIT 1000');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).not.toContain('DROP FUNCTION');
    // The TRUNCATE, statement and row branches
    expect(sql.match(/PERFORM "lilypad_cache_changes_prune"\(\);/g)).toHaveLength(3);
    expect(sql).toContain('IF random() * 20 < 1 AND');
  });

  it('should record its options in the trigger function, for the schema check', () => {
    const prune = { olderThan: 1_500, every: 3, batchSize: 50 };

    expect(installedLilypadChangelogPrune(lilypadChangelogSql({ prune }))).toEqual(prune);
    expect(
      installedLilypadChangelogPrune(lilypadChangelogSql({ prune: { olderThan: 60_000 } }))
    ).toEqual({ olderThan: 60_000, every: 20, batchSize: 1000 });
  });

  it('should name the prune function after the changelog table', () => {
    const sql = lilypadChangelogSql({ table: 'archive.changes', prune: { olderThan: 60_000 } });

    expect(sql).toContain('FUNCTION "archive_changes_prune"()');
    expect(sql).toContain('DELETE FROM "archive"."changes"');
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
