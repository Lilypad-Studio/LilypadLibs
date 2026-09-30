/**
 * `@lilypad-studio/libs/schema`: the database configs (`defineLilypadDb`, `defineLilypadTable`), the
 * description of the tables, and `bindLilypadDbHooks`, with which the application binds its
 * functions to a config. Runs in Node.js and in edge runtimes, without postgres.js: a config file
 * imports only this entry, so that the application and `lilypad-doctor` can both load it.
 */
export {
  defineLilypadDb,
  defineLilypadTable,
  isLilypadDbConfig,
  isLilypadDbTableDefinition,
} from '../dbConfig/LilypadDbConfig';
export type {
  LilypadChangelogPruning,
  LilypadDbConfig,
  LilypadDbConfigInput,
  LilypadDbConfigSettings,
  LilypadDbPrimaryKey,
  LilypadDbResolvedForeignKey,
  LilypadDbResolvedIndex,
  LilypadDbResolvedUniqueKey,
  LilypadDbRow,
  LilypadDbTableChangelogSync,
  LilypadDbTableDefinition,
  LilypadDbTableDefinitionBase,
  LilypadDbTableDraft,
  LilypadDbTableInput,
  LilypadDbTableInputBase,
  LilypadDbTableListenSync,
  LilypadDbTableName,
  LilypadDbTableSync,
  LilypadDbTableTrustedSync,
} from '../dbConfig/LilypadDbConfig';
export { bindLilypadDbHooks } from '../dbConfig/LilypadDbHooks';
export type {
  LilypadDbHooks,
  LilypadDbTableHooks,
  LilypadDbTableHooksBase,
} from '../dbConfig/LilypadDbHooks';
export { LILYPAD_DEFAULT_DB_CONFIG_NAME } from '../dbConfig/LilypadDbConfigDefaults';
export { lilypadColumnTypesOfPgType } from '../dbConfig/LilypadPgTypes';
export type {
  LilypadDbColumnType,
  LilypadDbColumnTypeOf,
  LilypadDbColumnValues,
  LilypadPgTypeOf,
} from '../dbConfig/LilypadPgTypes';
export {
  LilypadDbEmptyWriteError,
  LilypadDbMissingPrimaryKeyError,
  LilypadDbNotFoundError,
} from '../dbConfig/LilypadDbSchema';
export type {
  LilypadDbCheck,
  LilypadDbColumn,
  LilypadDbColumnDefault,
  LilypadDbColumnFor,
  LilypadDbColumnName,
  LilypadDbColumnReference,
  LilypadDbDeleteResult,
  LilypadDbForeignKey,
  LilypadDbIndex,
  LilypadDbIndexMethod,
  LilypadDbInsertData,
  LilypadDbPartialRow,
  LilypadDbReference,
  LilypadDbReferentialAction,
  LilypadDbSchema,
  LilypadDbUniqueKey,
  LilypadDbUpdateData,
  LilypadDbWriteResult,
} from '../dbConfig/LilypadDbSchema';
