import {
  isLilypadDbConfig,
  type LilypadDbConfig,
  type LilypadDbRow,
  type LilypadDbTableDefinitionBase,
  type LilypadDbTableName,
} from '@/dbConfig/LilypadDbConfig';
import type { LilypadDbPartialRow } from '@/dbConfig/LilypadDbSchema';

/**
 * The functions applied to the rows of a table. They are not part of the config file, which
 * describes the database only: the application binds them to the config with
 * {@link bindLilypadDbHooks}, so that `lilypad-doctor` loads the config without the application
 * code they import.
 *
 * @typeParam T - The row type.
 */
export type LilypadDbTableHooks<T> = {
  /**
   * Transforms the data of inserts and updates, before the columns of `cols` are picked from it.
   * Its result replaces the data: omitting a property removes it from the write.
   */
  readonly write?: ((data: LilypadDbPartialRow<T>) => LilypadDbPartialRow<T>) | undefined;
  /**
   * Builds a row from what the database returned. It receives the whole row (`SELECT *`, and
   * `RETURNING *` for the writes), since it may read columns that are not in `cols`, and can
   * return `null` to leave the row out of the results.
   */
  readonly select?: ((row: Record<string, unknown>) => T | null) | undefined;
};

/** The hooks of a table, whatever its row type. */
export type LilypadDbTableHooksBase = {
  readonly write?: ((data: never) => unknown) | undefined;
  readonly select?: ((row: Record<string, unknown>) => unknown) | undefined;
};

/** The hooks of some tables of a config, by key, typed with the rows of each table. */
export type LilypadDbHooks<C extends LilypadDbConfig> = {
  readonly [N in LilypadDbTableName<C>]?: LilypadDbTableHooks<LilypadDbRow<C, N>> | undefined;
};

const OWNER = 'bindLilypadDbHooks';
const HOOK_NAMES = new Set(['write', 'select']);

/**
 * Binds functions to the tables of a config (see {@link LilypadDbTableHooks}). It returns a copy
 * of the config (same name, same settings, same tables) whose tables carry them: create the gate
 * with it, and use it as you would use the config.
 *
 * The config file stays free of application code, so `lilypad-doctor` can load it with Node.js
 * alone. The functions are bound once, in the module that creates the gate, and follow the table
 * everywhere: a gate created with the bound config also applies them to the definitions of the
 * original one (`db.tables.users`).
 *
 * Binding a config that already has hooks replaces the hooks given, and keeps the others (an
 * `undefined` hook is not given).
 *
 * @example
 * ```typescript
 * // src/db.ts
 * import db from '../lilypad.config';
 * import { rowToEvent, sanitizeEvent } from './events';
 *
 * export const appDb = bindLilypadDbHooks(db, {
 *   events: { write: sanitizeEvent, select: rowToEvent },
 * });
 * export const gate = await LilypadDbGate.create({ connectionString, config: appDb });
 * ```
 *
 * @throws If `config` is not a config made with `defineLilypadDb`, names no such table, or if a
 * hook is not a function.
 */
export function bindLilypadDbHooks<C extends LilypadDbConfig>(
  config: C,
  hooks: LilypadDbHooks<C>
): C {
  if (!isLilypadDbConfig(config)) {
    throw new Error(
      `${OWNER}: the config must be made with defineLilypadDb (e.g. the default export of lilypad.config.ts).`
    );
  }
  if (typeof hooks !== 'object' || hooks === null) {
    throw new Error(`${OWNER}: the hooks must be an object: { <table key>: { write?, select? } }.`);
  }
  const tables: Record<string, LilypadDbTableDefinitionBase> = { ...config.tables };
  for (const [key, tableHooks] of Object.entries(hooks as Record<string, unknown>)) {
    const definition = Object.hasOwn(config.tables, key) ? config.tables[key] : undefined;
    if (!definition) {
      throw new Error(`${OWNER}: the config "${config.name}" has no table "${key}".`);
    }
    if (tableHooks === undefined) {
      continue;
    }
    if (typeof tableHooks !== 'object' || tableHooks === null) {
      throw new Error(`${OWNER}: the hooks of "${key}" must be an object: { write?, select? }.`);
    }
    const given: Record<string, unknown> = {};
    for (const [name, hook] of Object.entries(tableHooks)) {
      if (!HOOK_NAMES.has(name)) {
        throw new Error(
          `${OWNER}: "${key}.${name}" is not a hook: the hooks of a table are write and select.`
        );
      }
      if (hook !== undefined && typeof hook !== 'function') {
        throw new Error(`${OWNER}: "${key}.${name}" must be a function.`);
      }
      // An undefined hook is a missing one: it keeps the hook bound before
      if (hook !== undefined) {
        given[name] = hook;
      }
    }
    // No hook: the table stays as it is (an empty `hooks` would hide those of the gate's config)
    if (Object.keys(given).length === 0) {
      continue;
    }
    tables[key] = Object.freeze({
      ...definition,
      hooks: Object.freeze({ ...definition.hooks, ...(given as LilypadDbTableHooksBase) }),
    });
  }
  return Object.freeze({ ...config, tables: Object.freeze(tables) });
}
