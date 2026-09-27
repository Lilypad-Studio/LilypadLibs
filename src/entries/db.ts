/**
 * `@lilypad/libs/db`: the PostgreSQL gateway and the database-backed cache. Node.js only: it needs
 * TCP connections (postgres.js), which must be installed next to the library.
 */
export { LilypadDbGate, lilypadServerlessPool } from '../dbGate/LilypadDbGate';
export type {
  LilypadDbGateOptions,
  LilypadDbListener,
  LilypadDbPoolOptions,
} from '../dbGate/LilypadDbGate';
export { LilypadDbTable } from '../dbGate/LilypadDbTable';
export {
  LilypadDbEmptyWriteError,
  LilypadDbMissingPrimaryKeyError,
  LilypadDbNotFoundError,
} from '../dbGate/LilypadDbSchema';
export type {
  LilypadDbColumn,
  LilypadDbColumnType,
  LilypadDbDeleteResult,
  LilypadDbInsertData,
  LilypadDbSchema,
  LilypadDbUpdateData,
  LilypadDbWriteResult,
} from '../dbGate/LilypadDbSchema';
export { LilypadDisposedError } from '../cache/LilypadCacheTypes';

export { LilypadDbCache } from '../cache/LilypadDbCache';
export type {
  LilypadDbCacheChangelogSync,
  LilypadDbCacheListenSync,
  LilypadDbCacheOptions,
  LilypadDbCacheSchemaVerification,
  LilypadDbCacheSync,
  LilypadDbCacheTrustedSyncOptions,
  LilypadDbKey,
  LilypadDbNotification,
} from '../cache/LilypadDbCache';

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
export { runLilypadDoctor } from '../dbGate/LilypadDoctor';
export type { LilypadDoctorOptions, LilypadDoctorReport } from '../dbGate/LilypadDoctor';
export type {
  LilypadChangelogPruning,
  LilypadSchemaCheckOptions,
  LilypadSchemaCheckResult,
  LilypadSchemaProblem,
  LilypadSchemaProblemCode,
  LilypadSchemaProblemSeverity,
} from '../dbGate/LilypadSchemaCheck';
