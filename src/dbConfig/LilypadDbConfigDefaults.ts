/** The defaults of the database configs (see `defineLilypadDb`). */

export const LILYPAD_DEFAULT_CHANGELOG_TABLE = 'lilypad_cache_changes';
export const LILYPAD_DEFAULT_NOTIFY_CHANNEL = 'cache_events';
/** The name of the config of `lilypad.config.*`: the others are `lilypad.<name>.config.*`. */
export const LILYPAD_DEFAULT_DB_CONFIG_NAME = 'default';
export const LILYPAD_DEFAULT_DB_SCHEMA = 'public';
/** The default `maxGap` of the `changelog` strategy, and the default `minRetention` of the changelog. */
export const LILYPAD_DEFAULT_MAX_GAP: number = 60 * 60 * 1000; // 1 hour
