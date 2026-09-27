#!/usr/bin/env node
import "./chunks/LilypadDbSchema-Aqkz2mc3.mjs";
import { n as runLilypadDoctor, o as lilypadDbConfigFileNames, s as loadLilypadDbConfig } from "./chunks/LilypadDoctor-CnFyP25Z.mjs";
import { existsSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
//#region src/cli/lilypadDbConfigTemplate.ts
/** The comment at the top of the file. */
function header(typescript) {
	return [
		"// The database config of @lilypad/libs: the tables the application uses, and what the database",
		"// must provide for them. The application imports it to create its gates and caches;",
		"// `npx lilypad-doctor` checks the database against it, and prints the SQL that fixes what differs.",
		"//",
		"// Node.js loads it without a bundler: import only '@lilypad/libs/schema' and relative files with",
		typescript ? "// their extension (e.g. './db/users.ts'). Import the row types with `import type` (erased before" : "// their extension (e.g. './db/users.mjs'), without path aliases.",
		...typescript ? ["// loading, so path aliases work there: import type { User } from '@/types/user')."] : [],
		"// Keep the application code out of it: bind the functions applied to the rows where the",
		"// application creates its gate, with bindLilypadDbHooks(db, { example: { write, select } })."
	].join("\n");
}
/** The lines of the example table, from `const example = ...` to its end. */
function exampleTable(typescript) {
	return [
		...typescript ? [
			"/** A row of the `example` table, as the application reads it. */",
			"type Example = {",
			"  id: number;",
			"  name: string;",
			"  createdAt: Date;",
			"};",
			"",
			"const example = defineLilypadTable<Example, 'id'>({"
		] : ["const example = defineLilypadTable({"],
		"  tableName: 'example', // or 'schema.example'",
		"  primaryKey: 'id',",
		"  generatedPrimaryKey: true, // the database generates the id",
		"  cols: {",
		"    id: { type: 'number', pgType: 'int4' },",
		"    name: { type: 'string', pgType: 'text', nullable: false, unique: true },",
		"    createdAt: { type: 'date', pgType: 'timestamptz', nullable: false, default: { sql: 'now()' } },",
		"  },",
		"  // unique: [{ columns: ['name', 'createdAt'] }],",
		"  // foreignKeys: [{ columns: ['ownerId'], references: { table: 'owners', onDelete: 'cascade' } }],",
		"  // indexes: [{ columns: ['createdAt'] }],",
		`  // checks: [{ name: 'example_name_check', expression: "name <> ''" }],`,
		"  // How LilypadDbCache follows the changes made elsewhere: listen (long-running servers),",
		"  // { strategy: 'changelog', pollInterval: 5_000 } (serverless platforms), or { strategy: 'none' }",
		"  sync: { strategy: 'listen' },",
		"});"
	];
}
/**
* The content of a new config file: an example table (or none), and the options of the config
* with their defaults, as comments.
*/
function lilypadDbConfigTemplate({ name, typescript, empty }) {
	const table = exampleTable(typescript);
	return [
		header(typescript),
		empty ? "import { defineLilypadDb } from '@lilypad/libs/schema';" : "import { defineLilypadDb, defineLilypadTable } from '@lilypad/libs/schema';",
		"",
		...empty ? [
			"// Describe each table with defineLilypadTable (imported from the same module), e.g.:",
			"//",
			...table.map((line) => line === "" ? "//" : `// ${line}`)
		] : table,
		"",
		"export default defineLilypadDb({",
		...name === "default" ? [] : [`  name: '${name}',`],
		"  // defaultSchema: 'public', // the schema of the tables whose name is not qualified",
		"  // notifyChannel: 'cache_events', // the channel of the 'listen' tables",
		"  // changelog: { table: 'lilypad_cache_changes', pruning: 'detect' }, // for the 'changelog' tables",
		"  // strict: false, // true: lilypad-doctor also reports what the database has and the config lacks",
		empty ? "  tables: {}," : "  tables: { example },",
		"});",
		""
	].join("\n");
}
//#endregion
//#region src/cli/LilypadInitCli.ts
const LILYPAD_INIT_USAGE = `Usage: lilypad-doctor init [options]

Creates a config file (see defineLilypadDb), with an example table and the options of the config.

Options:
  --config <name|path>  A name creates lilypad.<name>.config.ts in the working directory; a path
                        creates that file (.ts, .mts, .mjs or .js). Without it: lilypad.config.ts
  --empty               No example table (it is left as a comment)
  --force               Overwrite the file if it exists
  -h, --help            Print this help

Exit code: 0 when the file is created, 2 otherwise (invalid arguments, the file exists).`;
const CONFIG_NAME = /^[A-Za-z0-9_-]+$/;
const EXTENSIONS = /* @__PURE__ */ new Set([
	".ts",
	".mts",
	".mjs",
	".js"
]);
/** `lilypad.config.<ext>` or `lilypad.<name>.config.<ext>`: the name a path gives its config. */
const CONFIG_FILE = /^lilypad\.(?:([A-Za-z0-9_-]+)\.)?config\.(?:ts|mts|mjs|js)$/;
/**
* The file `init` creates for `--config` (a name, a path, or nothing for the default config).
*
* @throws With a message for the user when the path has an extension Node.js cannot load.
*/
function lilypadInitTarget(config, cwd, exists) {
	const reference = config ?? "default";
	if (CONFIG_NAME.test(reference)) {
		const candidates = lilypadDbConfigFileNames(reference).map((file) => resolve(cwd, file));
		return {
			path: candidates[0],
			name: reference,
			existing: candidates.filter((candidate) => exists(candidate))
		};
	}
	const path = isAbsolute(reference) ? reference : resolve(cwd, reference);
	if (!EXTENSIONS.has(extname(path))) throw new Error(`The config file must end with .ts, .mts, .mjs or .js (got ${reference}).`);
	return {
		path,
		name: CONFIG_FILE.exec(basename(path))?.[1] ?? "default",
		existing: exists(path) ? [path] : []
	};
}
/**
* Runs `lilypad-doctor init` with these arguments.
*
* @returns The exit code: 0 when the file is created, 2 otherwise.
*/
function runLilypadInitCli(argv, output, { cwd = process.cwd(), exists = existsSync, writeFile = (path, content) => writeFileSync(path, content) } = {}) {
	let values;
	let target;
	try {
		({values} = parseArgs({
			args: argv,
			strict: true,
			allowPositionals: false,
			options: {
				config: { type: "string" },
				empty: { type: "boolean" },
				force: { type: "boolean" },
				help: {
					type: "boolean",
					short: "h"
				}
			}
		}));
		if (values.help) {
			output.log(LILYPAD_INIT_USAGE);
			return 0;
		}
		if (values.config !== void 0 && values.config.trim() === "") throw new Error("--config needs the name or the path of a config.");
		target = lilypadInitTarget(values.config, cwd, exists);
	} catch (error) {
		output.error(`${error instanceof Error ? error.message : String(error)}\n\n${LILYPAD_INIT_USAGE}`);
		return 2;
	}
	const shown = (path) => relative(cwd, path) || path;
	const others = target.existing.filter((path) => path !== target.path);
	if (target.existing.length > 0 && !values.force) {
		output.error(`lilypad-doctor init: ${target.existing.map(shown).join(", ")} already exists: pass --force to overwrite ${shown(target.path)}.`);
		return 2;
	}
	const content = lilypadDbConfigTemplate({
		name: target.name,
		typescript: [".ts", ".mts"].includes(extname(target.path)),
		empty: values.empty ?? false
	});
	try {
		writeFile(target.path, content);
	} catch (error) {
		output.error(`lilypad-doctor init: could not write ${shown(target.path)}: ${error instanceof Error ? error.message : String(error)}`);
		return 2;
	}
	const check = target.name === "default" && values.config === void 0 ? "npx lilypad-doctor" : `npx lilypad-doctor --config ${values.config ?? target.name}`;
	output.log([
		`Created ${shown(target.path)}.`,
		...others.length > 0 ? [`Warning: ${others.map(shown).join(", ")} defines the same config: remove it.`] : [],
		...extname(target.path) === ".js" ? ["A .js config is an ES module: the package.json needs \"type\": \"module\" (or use .mjs)."] : [],
		"Describe your tables in it, import it where the application creates its gates and caches,",
		`then check the database with: ${check} --url "$DATABASE_URL"`
	].join("\n"));
	return 0;
}
//#endregion
//#region src/cli/LilypadDoctorCli.ts
const USAGE = `Usage: lilypad-doctor [options]
       lilypad-doctor init [--config <name|path>] [--empty] [--force]

init creates a config file to start from (see lilypad-doctor init --help).

Without a command, it checks the database against a config (see defineLilypadDb): the tables,
their columns, keys, foreign keys, indexes and checks, the triggers of the sync strategies, the
changelog and how it is pruned. It only reads the catalogs, and prints the SQL that fixes what it
finds.

Options:
  --config <name|path>  The config: a name finds lilypad.<name>.config.{ts,mts,mjs,js} in the
                        working directory; without it, lilypad.config.* (the "default" config)
  --url <connection>    The database (default: the DATABASE_URL environment variable)
  --sql                 Print only the SQL that fixes the problems (for a migration)
  --json                Print the result as JSON
  -h, --help            Print this help

A TypeScript config needs Node.js 22.18 or later (or NODE_OPTIONS=--experimental-strip-types).

Exit code: 0 when the database matches the config (warnings may be printed), 1 when it does not,
2 when the check could not run (invalid arguments, config not found, unreachable database).`;
/**
* The options of the command line, or the help.
*
* @throws With a message for the user when an argument is not valid.
*/
function parseLilypadDoctorArgs(argv, env) {
	const { values } = parseArgs({
		args: argv,
		strict: true,
		allowPositionals: false,
		options: {
			config: { type: "string" },
			url: { type: "string" },
			sql: { type: "boolean" },
			json: { type: "boolean" },
			help: {
				type: "boolean",
				short: "h"
			}
		}
	});
	if (values.help) return { help: true };
	const connectionString = values.url ?? env.DATABASE_URL;
	if (!connectionString) throw new Error("Pass --url, or set DATABASE_URL.");
	if (values.sql && values.json) throw new Error("--sql and --json cannot be used together.");
	if (values.config !== void 0 && values.config.trim() === "") throw new Error("--config needs the name or the path of a config.");
	return {
		help: false,
		json: values.json ?? false,
		sql: values.sql ?? false,
		connectionString,
		config: values.config
	};
}
/** The SQL that fixes the problems, once each, in the order of the problems. */
function fixSql(report) {
	return [...new Set(report.problems.flatMap((problem) => problem.fix ? [problem.fix] : []))].join("\n");
}
/**
* Runs `lilypad-doctor` with these arguments: `init ...` creates a config file, anything else
* checks the database.
*
* @returns The exit code: 0 without errors (there may be warnings), 1 with errors, 2 when the
* check could not run (invalid arguments, config not found, unreachable database).
*/
async function runLilypadDoctorCli(argv, env, output, { run = runLilypadDoctor, load = loadLilypadDbConfig, init } = {}) {
	if (argv[0] === "init") return runLilypadInitCli(argv.slice(1), output, init);
	let parsed;
	try {
		parsed = parseLilypadDoctorArgs(argv, env);
	} catch (error) {
		output.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
		return 2;
	}
	if (parsed.help) {
		output.log(USAGE);
		return 0;
	}
	let config;
	try {
		({config} = await load({ config: parsed.config }));
	} catch (error) {
		output.error(`lilypad-doctor: ${error instanceof Error ? error.message : String(error)}`);
		return 2;
	}
	try {
		const report = await run({
			connectionString: parsed.connectionString,
			config
		});
		if (parsed.json) {
			const { text: _text, assertOk: _assertOk, ...result } = report;
			output.log(JSON.stringify(result, null, 2));
		} else if (parsed.sql) {
			const sql = fixSql(report);
			output.log(sql === "" ? "-- lilypad-doctor: nothing to fix." : sql);
		} else if (report.ok) output.log(report.text);
		else output.error(report.text);
		return report.ok ? 0 : 1;
	} catch (error) {
		output.error(`lilypad-doctor: could not check the database: ${error instanceof Error ? error.message : String(error)}`);
		return 2;
	}
}
//#endregion
//#region src/cli/lilypad-doctor.ts
/**
* `npx lilypad-doctor`: checks the database against a config; `npx lilypad-doctor init` creates a
* config file. See `runLilypadDoctorCli` for the options, or run it with `--help`.
*/
runLilypadDoctorCli(process.argv.slice(2), process.env, console).then((code) => {
	process.exitCode = code;
});
//#endregion
export {};

//# sourceMappingURL=lilypad-doctor.mjs.map