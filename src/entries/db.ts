/**
 * `@lilypad-studio/libs/db`: the PostgreSQL gateway and the database-backed cache. Node.js only: it needs
 * TCP connections (postgres.js), which must be installed next to the library.
 */
export { LilypadDbGate, lilypadServerlessPool } from '../dbGate/LilypadDbGate';
export type {
  LilypadDbGateOptions,
  LilypadDbListener,
  LilypadDbPoolOptions,
} from '../dbGate/LilypadDbGate';
export { LilypadDbTable } from '../dbGate/LilypadDbTable';
export { LilypadDisposedError } from '../cache/LilypadCacheTypes';

export { LilypadDbCache } from '../cache/LilypadDbCache';
export type {
  LilypadDbCacheBaseOptions,
  LilypadDbCacheGateNamedOptions,
  LilypadDbCacheNamedOptions,
  LilypadDbCacheOptions,
  LilypadDbCacheSyncOverrides,
  LilypadDbKey,
  LilypadDbNotification,
} from '../cache/LilypadDbCache';

export * from './schema';
export { loadLilypadDbConfig, lilypadDbConfigFileNames } from '../dbConfig/loadLilypadDbConfig';

export {
  LILYPAD_DEFAULT_CHANGELOG_TABLE,
  LILYPAD_DEFAULT_NOTIFY_BULK_THRESHOLD,
  LILYPAD_MIN_CHANGELOG_RETENTION,
  lilypadChangelogPruneScheduleSql,
  lilypadChangelogSql,
  lilypadChangelogTriggerSql,
  pruneLilypadChangelog,
  readLilypadChanges,
} from '../dbGate/LilypadChangelog';
export type {
  LilypadChange,
  LilypadChangelogCursor,
  LilypadChangelogPruneOptions,
  LilypadChangelogPruneScheduleOptions,
  LilypadChangelogSqlOptions,
  LilypadChangesRequest,
} from '../dbGate/LilypadChangelog';

export { checkLilypadSchema, LilypadSchemaCheckError } from '../dbGate/LilypadSchemaCheck';
export { normalizeLilypadPgType } from '../dbConfig/LilypadPgTypes';
export { lilypadSchemaCheckOptions, runLilypadDoctor } from '../dbGate/LilypadDoctor';
export type { LilypadDoctorOptions, LilypadDoctorReport } from '../dbGate/LilypadDoctor';
export type {
  LilypadSchemaCheckOptions,
  LilypadSchemaCheckResult,
  LilypadSchemaCheckTable,
  LilypadSchemaProblem,
  LilypadSchemaProblemCode,
  LilypadSchemaProblemSeverity,
  LilypadSchemaTableShape,
} from '../dbGate/LilypadSchemaTypes';
