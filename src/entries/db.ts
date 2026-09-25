/**
 * `@lilypad/libs/db`: the PostgreSQL gateway and the database-backed cache. Node.js only: it needs
 * TCP connections (postgres.js).
 */
export { LilypadDbGate, lilypadServerlessPool } from '../dbGate/LilypadDbGate';
export type {
  LilypadDbGateOptions,
  LilypadDbPoolOptions,
  LilypadDbSchema,
  LilypadDbColumnType,
  LilypadDbInsertData,
  LilypadDbUpdateData,
  ListenerCallbackIdentifier,
} from '../dbGate/LilypadDbGate';

export { default as LilypadDbCache } from '../cache/LilypadDbCache';
export type {
  LilypadDbCacheDefaultNotificationPayload,
  LilypadDbCacheDefaultListenerOptions,
  LilypadDbCacheSync,
  LilypadDbCacheSchemaVerification,
} from '../cache/LilypadDbCache';

export {
  LILYPAD_DEFAULT_CHANGELOG_TABLE,
  lilypadChangelogSql,
  lilypadChangelogTriggerSql,
  pruneLilypadChangelog,
  readLilypadChanges,
} from '../dbGate/LilypadChangelog';
export type { LilypadChange, LilypadChangelogSqlOptions } from '../dbGate/LilypadChangelog';

export { checkLilypadSchema, LilypadSchemaCheckError } from '../dbGate/LilypadSchemaCheck';
export type {
  LilypadSchemaCheckOptions,
  LilypadSchemaCheckResult,
  LilypadSchemaProblem,
  LilypadSchemaProblemCode,
} from '../dbGate/LilypadSchemaCheck';
