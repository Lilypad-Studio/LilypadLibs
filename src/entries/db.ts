/**
 * `@lilypad/libs/db`: the PostgreSQL gateway and the database-backed cache. Node.js only: it needs
 * TCP connections (postgres.js), which must be installed next to the library.
 */
export {
  LilypadDbGate,
  LilypadDbNotFoundError,
  lilypadServerlessPool,
} from '../dbGate/LilypadDbGate';
export type {
  LilypadDbColumn,
  LilypadDbColumnType,
  LilypadDbDeleteResult,
  LilypadDbGateOptions,
  LilypadDbInsertData,
  LilypadDbListener,
  LilypadDbPoolOptions,
  LilypadDbSchema,
  LilypadDbUpdateData,
  LilypadDbWriteResult,
} from '../dbGate/LilypadDbGate';

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
export type {
  LilypadSchemaCheckOptions,
  LilypadSchemaCheckResult,
  LilypadSchemaProblem,
  LilypadSchemaProblemCode,
} from '../dbGate/LilypadSchemaCheck';
