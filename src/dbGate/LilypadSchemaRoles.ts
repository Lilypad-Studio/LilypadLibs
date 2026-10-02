import type { LilypadDbTableAccess } from '@/dbConfig/LilypadDbConfig';
import { LILYPAD_DEFAULT_MAX_STATEMENT_TIMEOUT } from '@/dbConfig/LilypadDbConfigDefaults';
import { dollarQuote, quoteIdentifier, quoteLiteral } from '@/dbGate/LilypadChangelog';
import type {
  LilypadRoleSettingName,
  LilypadSchemaFacts,
  LilypadSettingInfo,
  LilypadTableFacts,
  LilypadTablePrivileges,
} from '@/dbGate/LilypadSchemaFacts';
import { formatDuration } from '@/dbGate/LilypadSchemaPruning';
import type {
  LilypadSchemaCheckOptions,
  LilypadSchemaProblem,
  LilypadSchemaTableShape,
} from '@/dbGate/LilypadSchemaTypes';
import { assertNumberOption } from '@/internal/LilypadValidation';

/**
 * The checks of the role of the application (`appRole`, else the role of the session of the
 * check): that it exists, its privileges, the row-level security that applies to it, and its
 * settings. They are pure: they read only the facts.
 */

/** A role or database name, quoted as one identifier (it may contain a dot). */
export function quoteRole(role: string): string {
  return `"${role.replace(/"/g, '""')}"`;
}

/**
 * The `GRANT` of a privilege on a table to a role: on these columns, or on the whole table
 * (`null`). The fixes of `missing-privilege` and the role that `missing-app-role` creates share it.
 */
function grantSql(
  privilege: string,
  table: string,
  columns: string[] | null,
  role: string
): string {
  const list =
    columns === null ? '' : ` (${columns.map((name) => quoteIdentifier(name)).join(', ')})`;
  return `GRANT ${privilege}${list} ON ${quoteIdentifier(table)} TO ${role};\n`;
}

/** The `statement_timeout` suggested for the role: 30 s, or `maxStatementTimeout` if shorter. */
function suggestedStatementTimeout(max: number): string {
  const suggested = Math.min(30_000, max);
  return suggested % 1000 === 0 ? `${suggested / 1000}s` : `${suggested}ms`;
}

/** Where a setting comes from, for a message (`pg_settings.source`). */
const SETTING_SOURCES: Record<string, string> = {
  default: 'the default of PostgreSQL',
  'configuration file': 'the configuration of the server',
  database: 'the database',
  user: 'the role',
  'database user': 'the role in this database',
  global: 'every role (ALTER ROLE ALL)',
  client: 'the connection',
};

/**
 * The sources of a setting of the session that apply to every role too: the others (the role, the
 * connection) hide what another role gets.
 */
const SHARED_SOURCES = new Set([
  'default',
  'environment variable',
  'configuration file',
  'command line',
  'global',
  'database',
  'override',
]);

/** Whether the role of the application is the role of the session of the check. */
function isSessionRole(facts: LilypadSchemaFacts): boolean {
  return facts.appRole.name === facts.session.role;
}

/** The role of the application, as the subject of a message. */
function roleSubject(facts: LilypadSchemaFacts): string {
  return isSessionRole(facts)
    ? `The role "${facts.appRole.name}" that the check connects as`
    : `The role "${facts.appRole.name}" of the application (appRole)`;
}

/**
 * The value of a setting for the role of the application: the setting of the session when it is
 * that role (with what the connection sets), else, as PostgreSQL applies them at login, the
 * setting of the role in this database, of the role, of this database, of every role, and then of
 * the server (`null`: unknown, when the session's own comes from its role or connection).
 */
export function lilypadRoleSetting(
  facts: LilypadSchemaFacts,
  name: LilypadRoleSettingName
): LilypadSettingInfo | null {
  const session = facts.session.settings[name] ?? null;
  if (isSessionRole(facts)) {
    return session;
  }
  const levels: [string | null, boolean, string][] = [
    [facts.appRole.name, true, 'database user'],
    [facts.appRole.name, false, 'user'],
    [null, true, 'database'],
    [null, false, 'global'],
  ];
  for (const [role, inDatabase, source] of levels) {
    const entry = facts.roleSettings
      .find((row) => row.role === role && row.inDatabase === inDatabase)
      ?.config.find((item) => item.startsWith(`${name}=`));
    if (entry !== undefined) {
      return { value: entry.slice(name.length + 1), source };
    }
  }
  return session !== null && SHARED_SOURCES.has(session.source) ? session : null;
}

const DURATION_UNITS: Record<string, number> = {
  us: 0.001,
  ms: 1,
  s: 1000,
  min: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** A duration setting in ms (`30s`, `30000`: its unit is ms), or `null` if not understood. */
export function parseLilypadPgDuration(value: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(us|ms|s|min|h|d)?\s*$/.exec(value);
  if (!match) {
    return null;
  }
  return Number(match[1]) * DURATION_UNITS[match[2] ?? 'ms']!;
}

/** A boolean setting (`on`, `true`, `yes`, `1`...). */
function isOn(value: string): boolean {
  return ['on', 'true', 'yes', '1', 't', 'y'].includes(value.trim().toLowerCase());
}

/** Where a setting comes from, e.g. `, from the role`. */
function fromSource(setting: LilypadSettingInfo): string {
  return `, from ${SETTING_SOURCES[setting.source] ?? `the ${setting.source}`}`;
}

/** The SQL that removes a setting where it comes from, if it comes from a role or a database. */
function resetSql(
  facts: LilypadSchemaFacts,
  setting: LilypadSettingInfo,
  name: string
): string | undefined {
  const role = quoteRole(facts.appRole.name);
  const database = quoteRole(facts.database);
  switch (setting.source) {
    case 'user':
      return `ALTER ROLE ${role} RESET ${name};\n`;
    case 'database user':
      return `ALTER ROLE ${role} IN DATABASE ${database} RESET ${name};\n`;
    case 'database':
      return `ALTER DATABASE ${database} RESET ${name};\n`;
    case 'global':
      return `ALTER ROLE ALL RESET ${name};\n`;
    default:
      return undefined;
  }
}

/**
 * `missing-app-role`: the `appRole` does not exist (the other checks of the role are skipped). Its
 * fix creates it with what the tables of the options need, and nothing more (see
 * {@link appRoleCreateSql}).
 *
 * @param changelogTable - The changelog the caches read (`undefined`: none reads it).
 */
export function evaluateAppRoleExists(
  facts: LilypadSchemaFacts,
  options: LilypadSchemaCheckOptions,
  changelogTable: string | undefined
): LilypadSchemaProblem[] {
  if (facts.appRole.exists) {
    return [];
  }
  const role = quoteRole(facts.appRole.name);
  return [
    {
      code: 'missing-app-role',
      severity: 'error',
      message: `The role "${facts.appRole.name}" (appRole) does not exist. Its fix creates it with only what the tables need (on the tables and the changelog that exist: the fix of a missing table grants it the table it creates, and the next check a changelog created by the same SQL). Set its password outside of the migrations (ALTER ROLE ${role} PASSWORD '...'; or the console of your provider), and connect the application as it. If the application connects as another role, set appRole (or --app-role) to that one instead.`,
      fix: appRoleCreateSql(facts, options, changelogTable),
    },
  ];
}

/**
 * The `GRANT`s of a cached table to the role of the application: `SELECT` of the columns (the whole
 * table: `null`), and, unless its `access` is `read`, the writes of `LilypadDbCache`: `INSERT` (not
 * of a generated key) and `UPDATE` (not of the key) of the columns, `DELETE`, and `USAGE` on the
 * sequences of its serial columns, whose default an insert that leaves them out runs.
 */
function tableGrants(
  role: string,
  table: string,
  primaryKey: string,
  shape: LilypadSchemaTableShape | undefined,
  columns: string[] | null,
  sequences: string[]
): string[] {
  const except = (excluded: boolean) =>
    columns === null ? null : columns.filter((name) => !(excluded && name === primaryKey));
  const nonEmpty = (list: string[] | null) => list === null || list.length > 0;
  const grants: string[] = [];
  if (nonEmpty(columns)) {
    grants.push(grantSql('SELECT', table, columns, role));
  }
  if (shape?.access === 'read') {
    return grants;
  }
  const insert = except(shape?.generatedPrimaryKey === true);
  const update = except(true);
  if (nonEmpty(insert)) {
    grants.push(grantSql('INSERT', table, insert, role));
  }
  if (nonEmpty(update)) {
    grants.push(grantSql('UPDATE', table, update, role));
  }
  grants.push(grantSql('DELETE', table, null, role));
  for (const sequence of sequences) {
    grants.push(`GRANT USAGE ON SEQUENCE ${sequence} TO ${role};\n`);
  }
  return grants;
}

/**
 * The `GRANT`s of a table that a fix creates (`missing-table`), to an `appRole` other than the role
 * of the check (which creates it, and owns it): appended to that fix, so that the role created in
 * the same migration (`missing-app-role`, earlier in the fixes) may use the table at once. The
 * created table has the described columns, and no sequence (a generated key is an identity or a
 * `uuid` default).
 *
 * @param schema - The schema of the table (`undefined`: unqualified, resolved by the `search_path`).
 */
export function lilypadNewTableGrants(
  facts: LilypadSchemaFacts,
  options: LilypadSchemaCheckOptions,
  table: string,
  primaryKey: string,
  shape: LilypadSchemaTableShape,
  schema: string | undefined
): string {
  if (options.appRole === undefined || isSessionRole(facts)) {
    return '';
  }
  const role = quoteRole(facts.appRole.name);
  return [
    ...(schema === undefined ? [] : [`GRANT USAGE ON SCHEMA ${quoteRole(schema)} TO ${role};\n`]),
    ...tableGrants(role, table, primaryKey, shape, Object.keys(shape.cols), []),
  ].join('');
}

/**
 * The SQL that creates the role of the application, if it does not exist yet (roles are shared by
 * the databases of a server, where the migration may run again), with only what the tables of the
 * options need: `USAGE` on their schemas, the {@link tableGrants} of their described columns that
 * exist (of the whole table without a description), `SELECT` on the changelog the caches read, and
 * the `statement_timeout`. Only on the objects that exist: the fixes of the missing tables grant
 * theirs ({@link lilypadNewTableGrants}). No password: the migrations are committed.
 */
function appRoleCreateSql(
  facts: LilypadSchemaFacts,
  options: LilypadSchemaCheckOptions,
  changelogTable: string | undefined
): string {
  const role = quoteRole(facts.appRole.name);
  const create = `
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = ${quoteLiteral(facts.appRole.name)}) THEN
    CREATE ROLE ${role} LOGIN;
  END IF;
END
`;
  const lines = [`DO ${dollarQuote(create)};\n`];
  const max = options.maxStatementTimeout ?? LILYPAD_DEFAULT_MAX_STATEMENT_TIMEOUT;
  if (max !== false) {
    lines.push(`ALTER ROLE ${role} SET statement_timeout = '${suggestedStatementTimeout(max)}';\n`);
  }
  const schemas = new Set<string>();
  const grants: string[] = [];
  options.tables.forEach(({ table, primaryKey, shape }, index) => {
    const found = facts.tables[index];
    // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- a missing table has no facts
    if (!found || found.schema === null) {
      return;
    }
    schemas.add(found.schema);
    // The described columns that exist (the shape check reports the others), or the whole table
    const columns = shape
      ? Object.keys(shape.cols).filter((name) =>
          (found.columns ?? []).some((column) => column.name === name)
        )
      : null;
    grants.push(...tableGrants(role, table, primaryKey, shape, columns, found.sequences ?? []));
  });
  if (changelogTable !== undefined && facts.changelog.hasTable) {
    if (facts.changelog.schema !== null) {
      schemas.add(facts.changelog.schema);
    }
    grants.push(grantSql('SELECT', changelogTable, null, role));
  }
  for (const schema of schemas) {
    lines.push(`GRANT USAGE ON SCHEMA ${quoteRole(schema)} TO ${role};\n`);
  }
  return [...lines, ...grants].join('');
}

/**
 * `privileged-app-role` (with `strict`): the role of the application has more privileges than the
 * tables need: a superuser, `CREATEROLE`, `BYPASSRLS`, or the privileges of the owner of a cached
 * table or of the changelog (whose rows every cache trusts).
 */
export function evaluatePrivilegedAppRole(
  facts: LilypadSchemaFacts,
  options: LilypadSchemaCheckOptions
): LilypadSchemaProblem[] {
  const app = facts.appRole;
  if (options.strict !== true || !app.exists) {
    return [];
  }
  const owned = options.tables.flatMap(({ table }, index) =>
    facts.tables[index]?.ownedByAppRole === true ? [`"${table}"`] : []
  );
  const reasons = [
    ...(app.superuser ? ['is a superuser'] : []),
    ...(app.createRole ? ['may create roles (CREATEROLE)'] : []),
    ...(app.bypassRls ? ['bypasses row-level security (BYPASSRLS)'] : []),
    ...(owned.length > 0 ? [`has the privileges of the owner of ${owned.join(', ')}`] : []),
    ...(facts.changelog.hasTable && facts.changelog.appPrivileges?.owner === true
      ? ['has the privileges of the owner of the changelog, whose rows every cache trusts']
      : []),
  ];
  if (reasons.length === 0) {
    return [];
  }
  return [
    {
      code: 'privileged-app-role',
      severity: 'warning',
      message: `${roleSubject(facts)} ${reasons.join(', ')}: a bug or an injection in the application can do as much (drop or alter the tables, write the changelog). Give the application a role of its own: set appRole to a new name (e.g. app_user) and run lilypad-doctor --sql, whose fix creates it with only what the tables need.`,
    },
  ];
}

/**
 * `missing-privilege` and `row-level-security` of a cached table, for the role of the application.
 *
 * @param table - The table as the options name it.
 * @param described - Whether the columns checked are those of a description (else every column).
 */
export function evaluateTableAccess(
  facts: LilypadSchemaFacts,
  table: string,
  found: LilypadTableFacts,
  described: boolean,
  access: LilypadDbTableAccess = 'write'
): LilypadSchemaProblem[] {
  if (!facts.appRole.exists) {
    return [];
  }
  const problems: LilypadSchemaProblem[] = [];
  if (found.appPrivileges) {
    problems.push(
      ...privilegeProblems(facts, table, found, found.appPrivileges, described, access)
    );
  }
  if (found.rowSecurity === true) {
    problems.push({
      code: 'row-level-security',
      severity: 'warning',
      table,
      message: `Row-level security applies to the role "${facts.appRole.name}" on "${table}": the caches load the rows its policies show it, and serve them to every caller (and to the other instances, through the shared level). Cache it with a role its policies do not filter (its owner without FORCE ROW LEVEL SECURITY, or a role with BYPASSRLS), or do not cache it.`,
    });
  }
  return problems;
}

/** `missing-privilege` of a cached table: what the caches read, and what their writes need. */
function privilegeProblems(
  facts: LilypadSchemaFacts,
  table: string,
  found: LilypadTableFacts,
  privileges: LilypadTablePrivileges,
  described: boolean,
  access: LilypadDbTableAccess
): LilypadSchemaProblem[] {
  const role = quoteRole(facts.appRole.name);
  const columns = (names: string[]) => (described ? names : null);
  const problems: LilypadSchemaProblem[] = [];

  const reads: string[] = [];
  const readFixes: string[] = [];
  if (!privileges.schemaUsage && found.schema !== null) {
    reads.push(`USAGE on the schema "${found.schema}"`);
    readFixes.push(`GRANT USAGE ON SCHEMA ${quoteRole(found.schema)} TO ${role};\n`);
  }
  if (privileges.missingSelect.length > 0) {
    reads.push(
      `SELECT on ${described ? `the columns ${privileges.missingSelect.join(', ')}` : 'the table'}`
    );
    readFixes.push(grantSql('SELECT', table, columns(privileges.missingSelect), role));
  }
  if (reads.length > 0) {
    problems.push({
      code: 'missing-privilege',
      severity: 'error',
      table,
      message: `${roleSubject(facts)} lacks ${reads.join(' and ')} of "${table}": the caches cannot read the table.`,
      fix: readFixes.join(''),
    });
  }

  // Only for a table the application writes (access)
  const writes: string[] = [];
  const writeFixes: string[] = [];
  if (access === 'write') {
    if (privileges.missingInsert.length > 0) {
      writes.push(`INSERT of ${privileges.missingInsert.join(', ')}`);
      writeFixes.push(grantSql('INSERT', table, columns(privileges.missingInsert), role));
    }
    if (privileges.missingUpdate.length > 0) {
      writes.push(`UPDATE of ${privileges.missingUpdate.join(', ')}`);
      writeFixes.push(grantSql('UPDATE', table, columns(privileges.missingUpdate), role));
    }
    if (!privileges.delete) {
      writes.push('DELETE');
      writeFixes.push(grantSql('DELETE', table, null, role));
    }
    if (privileges.missingSequences.length > 0) {
      writes.push(
        `USAGE on the sequences of its serial columns (${privileges.missingSequences.join(', ')})`
      );
      for (const sequence of privileges.missingSequences) {
        writeFixes.push(`GRANT USAGE ON SEQUENCE ${sequence} TO ${role};\n`);
      }
    }
  }
  if (writes.length > 0) {
    problems.push({
      code: 'missing-privilege',
      severity: 'warning',
      table,
      message: `${roleSubject(facts)} lacks ${writes.join(', ')} of "${table}": sqlCreate, sqlUpdate or sqlDelete of its LilypadDbCache fail. If the application only reads the table, set its access: 'read'.`,
      fix: writeFixes.join(''),
    });
  }
  return problems;
}

/**
 * `missing-privilege` of the changelog: the role of the application reads it (the `changelog`
 * strategy), with `USAGE` on its schema and `SELECT` on the columns of the reader.
 */
export function evaluateChangelogAccess(
  facts: LilypadSchemaFacts,
  changelogTable: string
): LilypadSchemaProblem[] {
  const privileges = facts.changelog.appPrivileges;
  if (!facts.appRole.exists || !privileges || (privileges.schemaUsage && privileges.select)) {
    return [];
  }
  const role = quoteRole(facts.appRole.name);
  const lacks: string[] = [];
  const fixes: string[] = [];
  if (!privileges.schemaUsage && facts.changelog.schema !== null) {
    lacks.push(`USAGE on the schema "${facts.changelog.schema}"`);
    fixes.push(`GRANT USAGE ON SCHEMA ${quoteRole(facts.changelog.schema)} TO ${role};\n`);
  }
  if (!privileges.select) {
    lacks.push('SELECT');
    fixes.push(grantSql('SELECT', changelogTable, null, role));
  }
  return [
    {
      code: 'missing-privilege',
      severity: 'error',
      table: changelogTable,
      message: `${roleSubject(facts)} lacks ${lacks.join(' and ')} of the changelog "${changelogTable}": the caches cannot read the changes, and fall back to their TTL.`,
      fix: fixes.join(''),
    },
  ];
}

/** What the config needs from the database, for the settings of the role. */
export type LilypadRoleNeeds = {
  /** Whether a table needs triggers (the `changelog` or `listen` strategy). */
  triggers: boolean;
  /** Whether a table listens (the `listen` strategy). */
  listens: boolean;
  /** Whether something notifies (a `listen` table, or the installed changelog function). */
  notifies: boolean;
  /** Whether the `prune` option of the changelog trigger is installed or suggested. */
  triggerPruning: boolean;
};

/**
 * The settings of the role of the application (`replica-replication-role`, `pruning-isolation`,
 * `idle-session-timeout`, `read-only-database`) and the state of the server (`read-only-database`,
 * `notify-queue-usage`).
 */
export function evaluateRoleSettings(
  facts: LilypadSchemaFacts,
  needs: LilypadRoleNeeds
): LilypadSchemaProblem[] {
  const problems: LilypadSchemaProblem[] = [];
  const subject = roleSubject(facts);
  const role = quoteRole(facts.appRole.name);
  const known = facts.appRole.exists;

  if (needs.triggers) {
    const replica = known ? lilypadRoleSetting(facts, 'session_replication_role') : null;
    const appReplica = replica?.value.trim().toLowerCase() === 'replica';
    if (replica && appReplica) {
      const fix = resetSql(facts, replica, 'session_replication_role');
      problems.push({
        code: 'replica-replication-role',
        severity: 'error',
        message: `${subject} has session_replication_role = replica${fromSource(replica)}: the changelog and notifying triggers do not fire for its writes, so the caches never learn about them (until maxAge).${fix === undefined ? ' Set it back to origin.' : ''}`,
        ...(fix !== undefined && { fix }),
      });
    }
    // The other roles (and the whole database, when the application overrides it)
    const others = facts.roleSettings.flatMap((row) =>
      row.config.some((item) => /^session_replication_role=\s*replica\s*$/i.test(item)) &&
      row.role !== facts.appRole.name &&
      (row.role !== null || !appReplica)
        ? [
            row.role === null
              ? row.inDatabase
                ? 'every role in this database'
                : 'every role (ALTER ROLE ALL)'
              : `"${row.role}"${row.inDatabase ? ' in this database' : ''}`,
          ]
        : []
    );
    if (others.length > 0) {
      problems.push({
        code: 'replica-replication-role',
        severity: 'warning',
        message: `session_replication_role = replica is the default of ${others.join(', ')}: the changelog and notifying triggers do not fire for their writes, so the caches never learn about them (until maxAge). Reset it (ALTER ROLE ... RESET session_replication_role), unless these roles never write the cached tables.`,
      });
    }
  }

  const isolation = known ? lilypadRoleSetting(facts, 'default_transaction_isolation') : null;
  if (
    needs.triggerPruning &&
    isolation &&
    isolation.value.trim().toLowerCase() !== 'read committed'
  ) {
    problems.push({
      code: 'pruning-isolation',
      severity: 'warning',
      message: `${subject} has default_transaction_isolation = '${isolation.value}'${fromSource(isolation)}: the prune option of the changelog trigger prunes only in READ COMMITTED transactions, so its writes never prune the changelog. Prune it with a pg_cron job (pruning: 'cron'), or set ALTER ROLE ${role} SET default_transaction_isolation = 'read committed';`,
    });
  }

  const idle = known ? lilypadRoleSetting(facts, 'idle_session_timeout') : null;
  const idleTimeout = idle ? parseLilypadPgDuration(idle.value) : null;
  if (needs.listens && idle && idleTimeout !== null && idleTimeout > 0) {
    problems.push({
      code: 'idle-session-timeout',
      severity: 'warning',
      message: `${subject} has an idle_session_timeout of ${formatDuration(idleTimeout)}${fromSource(idle)}: PostgreSQL closes the connection that LISTENs while it waits for notifications, and each reconnection expires every entry of the listen caches. ALTER ROLE ${role} SET idle_session_timeout = 0; (or the role of listenerConnectionString, if it differs).`,
    });
  }

  const readOnly = known ? lilypadRoleSetting(facts, 'default_transaction_read_only') : null;
  if (facts.server.inRecovery) {
    problems.push({
      code: 'read-only-database',
      severity: 'warning',
      message:
        'The check runs on a standby (pg_is_in_recovery()): the writes of the library, pg_current_xact_id() and LISTEN need the primary. Connect the gate (and its listenerConnectionString) to the primary, and run the check there.',
    });
  } else if (readOnly && isOn(readOnly.value)) {
    problems.push({
      code: 'read-only-database',
      severity: 'warning',
      message: `${subject} has default_transaction_read_only = on${fromSource(readOnly)}: the writes of LilypadDbCache (sqlCreate, sqlUpdate, sqlDelete) fail. ALTER ROLE ${role} SET default_transaction_read_only = off; unless the application never writes.`,
    });
  }

  if (needs.notifies && facts.server.notifyQueueUsage >= 0.5) {
    problems.push({
      code: 'notify-queue-usage',
      severity: 'warning',
      message: `The NOTIFY queue is ${Math.round(facts.server.notifyQueueUsage * 100)}% full: once full, every transaction that notifies (each write of a cached table) fails at commit. A session that LISTENs but stays in a long transaction keeps the queue from being cleaned up: find it in pg_stat_activity.`,
    });
  }
  return problems;
}

/**
 * `long-statement-timeout`: the `statement_timeout` of the role of the application is off, or
 * longer than `maxStatementTimeout`. No fix: the setting belongs to the role (the message gives the
 * `ALTER ROLE`).
 */
export function evaluateStatementTimeout(
  facts: LilypadSchemaFacts,
  options: LilypadSchemaCheckOptions
): LilypadSchemaProblem[] {
  const max = options.maxStatementTimeout ?? LILYPAD_DEFAULT_MAX_STATEMENT_TIMEOUT;
  if (max === false) {
    return [];
  }
  assertNumberOption('checkLilypadSchema', 'maxStatementTimeout', max, 'positive-delay');
  const setting = facts.appRole.exists ? lilypadRoleSetting(facts, 'statement_timeout') : null;
  const statementTimeout = setting ? parseLilypadPgDuration(setting.value) : null;
  if (
    setting === null ||
    statementTimeout === null ||
    (statementTimeout > 0 && statementTimeout <= max)
  ) {
    return [];
  }
  const from = fromSource(setting);
  const found =
    statementTimeout === 0
      ? `has no statement_timeout (0${from})`
      : `has a statement_timeout of ${formatDuration(statementTimeout)} (${statementTimeout} ms${from}), longer than ${formatDuration(max)} (maxStatementTimeout)`;
  // Within maxStatementTimeout, or the suggested setting would be reported too
  const alterRole = `ALTER ROLE ${quoteRole(facts.appRole.name)} SET statement_timeout = '${suggestedStatementTimeout(max)}';`;
  return [
    {
      code: 'long-statement-timeout',
      severity: 'warning',
      message:
        `${roleSubject(facts)} ${found}: a query stuck on a lock or a dead connection holds its connection of the pool, and its caller, for as long as it lasts (the gate sets no timeout by default, and the caches stop waiting, not their queries).` +
        (isSessionRole(facts)
          ? ` If the application connects as this role, bound its queries: ${alterRole} (behind a pooler, the role the pooler connects as).` +
            ' If it connects as another role, set appRole (or --app-role) to check that one; if it bounds its queries with the statementTimeout of its gate, set maxStatementTimeout: false in the config (or in the options of checkLilypadSchema).'
          : ` Bound its queries: ${alterRole} (or, if it bounds them with the statementTimeout of its gate, set maxStatementTimeout: false in the config).`),
    },
  ];
}
