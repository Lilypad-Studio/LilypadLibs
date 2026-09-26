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
  LilypadDbPoolOptions,
  LilypadDbSchema,
  LilypadDbUpdateData,
  LilypadDbWriteResult,
  ListenerCallbackIdentifier,
} from '../dbGate/LilypadDbGate';

export { LilypadDbCache } from '../cache/LilypadDbCache';
export type {
  LilypadDbCacheChangelogSync,
  LilypadDbCacheDefaultNotificationPayload,
  LilypadDbCacheListenSync,
  LilypadDbCacheOptions,
  LilypadDbCacheSchemaVerification,
  LilypadDbCacheSync,
  LilypadDbCacheTrustedSyncOptions,
  LilypadDbKey,
} from '../cache/LilypadDbCache';

export {
  LILYPAD_DEFAULT_CHANGELOG_TABLE,
  lilypadChangelogSql,
  lilypadChangelogTriggerSql,
  lilypadCursorCovers,
  pruneLilypadChangelog,
  readLilypadChanges,
  readLilypadChangesBatch,
} from '../dbGate/LilypadChangelog';
export type {
  LilypadChange,
  LilypadChangelogCursor,
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
