import { o as isLilypadDbConfig } from "./LilypadDbSchema-DgMfYKbD.mjs";
//#region src/dbConfig/LilypadDbHooks.ts
const OWNER = "bindLilypadDbHooks";
const HOOK_NAMES = /* @__PURE__ */ new Set(["write", "select"]);
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
* Binding a config that already has hooks replaces the hooks given, and keeps the others.
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
function bindLilypadDbHooks(config, hooks) {
	if (!isLilypadDbConfig(config)) throw new Error(`${OWNER}: the config must be made with defineLilypadDb (e.g. the default export of lilypad.config.ts).`);
	if (typeof hooks !== "object" || hooks === null) throw new Error(`${OWNER}: the hooks must be an object: { <table key>: { write?, select? } }.`);
	const tables = { ...config.tables };
	for (const [key, tableHooks] of Object.entries(hooks)) {
		const definition = Object.hasOwn(config.tables, key) ? config.tables[key] : void 0;
		if (!definition) throw new Error(`${OWNER}: the config "${config.name}" has no table "${key}".`);
		if (tableHooks === void 0) continue;
		if (typeof tableHooks !== "object" || tableHooks === null) throw new Error(`${OWNER}: the hooks of "${key}" must be an object: { write?, select? }.`);
		for (const [name, hook] of Object.entries(tableHooks)) {
			if (!HOOK_NAMES.has(name)) throw new Error(`${OWNER}: "${key}.${name}" is not a hook: the hooks of a table are write and select.`);
			if (hook !== void 0 && typeof hook !== "function") throw new Error(`${OWNER}: "${key}.${name}" must be a function.`);
		}
		tables[key] = Object.freeze({
			...definition,
			hooks: Object.freeze({
				...definition.hooks,
				...tableHooks
			})
		});
	}
	return Object.freeze({
		...config,
		tables: Object.freeze(tables)
	});
}
//#endregion
export { bindLilypadDbHooks as t };

//# sourceMappingURL=schema-6Wc929rg.mjs.map