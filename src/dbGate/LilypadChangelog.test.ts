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

    expect(sql).not.toContain('PERFORM %3$s()');
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
    // The TRUNCATE and statement branches, qualified by the DO block that creates the function
    expect(sql.match(/PERFORM %3\$s\(\);/g)).toHaveLength(2);
    expect(sql).toContain(', changelog, quote_literal(changelog), prune)');
    expect(sql).toContain('IF random() * 20 < 1 AND');
  });

  it('should record its options in the trigger function, for the schema check', () => {
    const prune = { olderThan: 1_500, every: 3, batchSize: 50 };

    expect(
      installedLilypadChangelogPrune(lilypadChangelogSql({ prune: { ...prune, force: true } }))
    ).toEqual(prune);
    expect(
      installedLilypadChangelogPrune(lilypadChangelogSql({ prune: { olderThan: 3_600_000 } }))
    ).toEqual({ olderThan: 3_600_000, every: 20, batchSize: 1000 });
  });

  it('should search pg_temp last, so that a temporary table cannot stand for the changelog', () => {
    const sql = lilypadChangelogSql({ prune: { olderThan: 86_400_000 } });

    expect(sql).toContain('SECURITY DEFINER SET search_path = pg_catalog, pg_temp');
    expect(sql).not.toContain('FROM CURRENT');
  });

  it('should make the trigger function run as its owner, with the changelog qualified', () => {
    const plain = lilypadChangelogSql();
    const pruned = lilypadChangelogSql({ prune: { olderThan: 86_400_000 } });

    for (const sql of [plain, pruned]) {
      // Only pg_catalog: a schema writable by others could hold a better overload of a function
      expect(sql).toContain(
        `'CREATE OR REPLACE FUNCTION %s() RETURNS trigger AS %L LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp'`
      );
      expect(sql).toContain(`WHERE c.oid = '"lilypad_cache_changes"'::regclass`);
      // The placeholders of the changelog are the arguments of one format()
      expect(sql).toContain('INSERT INTO %1$s (');
      // The % of the body, escaped for that format()
      expect(sql).toContain('to_jsonb(n.%%1$I)');
      expect(sql).toContain(', changelog, quote_literal(changelog)');
      expect(sql).not.toContain('__lilypad_');
      expect(sql).not.toContain('INSERT INTO "lilypad_cache_changes"');
      expect(sql).toContain(`IS 'lilypad-changelog:${LILYPAD_CHANGELOG_VERSION}'`);
    }
    expect(pruned).toContain(`WHERE p.oid = '"lilypad_cache_changes_prune"()'::regprocedure`);
    expect(plain).not.toContain('%3$s');
  });

  it('should refuse a channel that contains a placeholder of the trigger function', () => {
    expect(() => lilypadChangelogSql({ notifyChannel: 'x__lilypad_prune__' })).toThrow(
      'contains "__lilypad_"'
    );
  });

  it('should leave the writes of the changelog and the functions to the triggers', () => {
    const plain = lilypadChangelogSql();
    const pruned = lilypadChangelogSql({ prune: { olderThan: 86_400_000 } });

    for (const sql of [plain, pruned]) {
      expect(sql).toContain(
        'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "lilypad_cache_changes" FROM PUBLIC;'
      );
      expect(sql).toContain(
        'REVOKE EXECUTE ON FUNCTION "lilypad_cache_changes_record"() FROM PUBLIC;'
      );
    }
    expect(pruned).toContain(
      'REVOKE EXECUTE ON FUNCTION "lilypad_cache_changes_prune"() FROM PUBLIC;'
    );
  });

  it('should guard the key type before converting it, after the row-trigger check', () => {
    const sql = lilypadChangelogSql();

    // The guard raises for an unsafe key type
    expect(sql).toContain('has an unsafe type');
    const rowReturn = sql.indexOf("IF TG_LEVEL = 'ROW' THEN");
    const guard = sql.indexOf('INTO key_type');
    const firstToJsonb = sql.indexOf('to_jsonb(n.%%1$I)');
    expect(rowReturn).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(rowReturn);
    expect(firstToJsonb).toBeGreaterThan(guard);
    // The catalog relations the guard reads are qualified with pg_catalog
    for (const relation of [
      'pg_catalog.pg_attribute',
      'pg_catalog.pg_type',
      'pg_catalog.pg_roles',
      'pg_catalog.pg_cast',
      'pg_catalog.pg_proc',
    ]) {
      expect(sql).toContain(relation);
    }
    // Fails closed: a missing key column raises too
    expect(sql).toContain('does not exist (renamed or dropped?)');
    // The key name is clipped like %I
    expect(sql).toContain('TG_ARGV[0]::pg_catalog.name');
  });

  it('should name the prune function after the changelog table', () => {
    const sql = lilypadChangelogSql({
      changelogTable: 'archive.changes',
      prune: { olderThan: 3_600_000 },
    });

    expect(sql).toContain(`WHERE p.oid = '"archive_changes_prune"()'::regprocedure`);
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
    // The names of the tables are arguments of the format() of the body of the trigger function
    expect(sql).toContain('format($$');
    expect(sql).toContain('EXECUTE format($record$');
    expect(sql).toContain('EXECUTE format($notify_$');
  });

  it('should leave the SQL of ordinary names as it is', () => {
    const sql = lilypadChangelogSql();

    expect(sql).toContain('DO $lilypad$');
    expect(sql).toContain('format($$');
    expect(sql).toContain('EXECUTE format($record$');
    expect(sql).toContain('EXECUTE format($notify$');
  });
});

describe('lilypadChangelogSql names of a long changelog table', () => {
  const objectNames = (sql: string) => ({
    functions: [...sql.matchAll(/'"([^"]+)"'(?:, format|,\n)/g)].map((match) => match[1]!),
    indexes: [...sql.matchAll(/CREATE INDEX IF NOT EXISTS "([^"]+)"/g)].map((match) => match[1]!),
  });

  it('should give distinct names of at most 63 bytes to its functions and indexes from 62 characters', () => {
    const changelogTable = 'c'.repeat(62);
    const { functions, indexes } = objectNames(
      lilypadChangelogSql({ changelogTable, prune: { olderThan: 86_400_000 } })
    );

    expect(functions).toHaveLength(2);
    expect(indexes).toHaveLength(2);
    for (const names of [functions, indexes]) {
      expect(new Set(names).size).toBe(2);
      for (const name of names) {
        expect(name.length).toBeLessThanOrEqual(63);
      }
    }
    // The trigger SQL and the schema check name the same function
    expect(
      lilypadChangelogTriggerSql({ table: 'items', primaryKey: 'id', changelogTable })
    ).toContain(`EXECUTE FUNCTION "${functions[1]!}"('id')`);
  });

  it('should drop the one index that earlier versions created under the truncated name', () => {
    const changelogTable = 'c'.repeat(62);
    const sql = lilypadChangelogSql({ changelogTable });
    const { indexes } = objectNames(sql);

    expect(sql).toContain(`DROP INDEX IF EXISTS "${'c'.repeat(62)}_";`);
    expect(indexes).not.toContain(`${'c'.repeat(62)}_`);
    // In the schema of the changelog
    expect(lilypadChangelogSql({ changelogTable: `archive.${'c'.repeat(54)}` })).toContain(
      `DROP INDEX IF EXISTS "archive"."archive_${'c'.repeat(54)}_";`
    );
    expect(lilypadChangelogSql({ changelogTable: 'c'.repeat(61) })).not.toContain('DROP INDEX');
  });

  it('should name the pg_cron job after the whole changelog name, as earlier versions did', () => {
    const changelogTable = 'c'.repeat(62);

    expect(lilypadChangelogPruneScheduleSql({ olderThan: 86_400_000, changelogTable })).toContain(
      `cron.schedule('${changelogTable}_prune'`
    );
  });

  it('should keep the names that PostgreSQL truncates distinctly, as earlier versions installed them', () => {
    const changelogTable = 'c'.repeat(61);
    const sql = lilypadChangelogSql({ changelogTable, prune: { olderThan: 86_400_000 } });

    expect(sql).toContain(`'"${changelogTable}_record"'`);
    expect(sql).toContain(`'"${changelogTable}_prune"'`);
    expect(sql).toContain(`CREATE INDEX IF NOT EXISTS "${changelogTable}_changed_at_idx"`);
  });
});

describe('lilypadChangelogSql notification channel', () => {
  it.each([['a'.repeat(64)], ['é'.repeat(32)], ['']])(
    'should reject the channel %j, on which pg_notify fails every write',
    (notifyChannel) => {
      expect(() => lilypadChangelogSql({ notifyChannel })).toThrow(
        'lilypadChangelogSql: the channel'
      );
    }
  );

  it('should accept a channel of 63 bytes', () => {
    expect(lilypadChangelogSql({ notifyChannel: 'a'.repeat(63) })).toContain(
      `pg_notify('${'a'.repeat(63)}'`
    );
  });
});

describe('the retention of the changelog SQL', () => {
  it('should reject a prune retention below one hour, unless forced', () => {
    // Seconds instead of milliseconds: 86 seconds
    expect(() => lilypadChangelogSql({ prune: { olderThan: 86_400 } })).toThrow(
      'prune.olderThan is 86400 ms, less than one hour'
    );
    expect(lilypadChangelogSql({ prune: { olderThan: 86_400, force: true } })).toContain(
      'olderThan=86400 '
    );
    expect(lilypadChangelogSql({ prune: { olderThan: 3_600_000 } })).toContain(
      'olderThan=3600000 '
    );
  });

  it('should reject a scheduled retention below one hour, unless forced', () => {
    expect(() => lilypadChangelogPruneScheduleSql({ olderThan: 86_400 })).toThrow(
      'lilypadChangelogPruneScheduleSql: olderThan is 86400 ms, less than one hour'
    );
    expect(lilypadChangelogPruneScheduleSql({ olderThan: 86_400, force: true })).toContain(
      'make_interval(secs => 86.4)'
    );
  });
});
