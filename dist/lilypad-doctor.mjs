#!/usr/bin/env node
import { n as runLilypadDoctor, s as loadLilypadDbConfig } from "./chunks/LilypadDoctor-Bnq8Cqh4.mjs";
import { parseArgs } from "node:util";
//#region src/cli/LilypadDoctorCli.ts
const USAGE = `Usage: lilypad-doctor [options]

Checks the database against a config (see defineLilypadDb): the tables, their columns, keys,
foreign keys, indexes and checks, the triggers of the sync strategies, the changelog and how it is
pruned. It only reads the catalogs, and prints the SQL that fixes what it finds.

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
* Runs `lilypad-doctor` with these arguments.
*
* @returns The exit code: 0 without errors (there may be warnings), 1 with errors, 2 when the
* check could not run (invalid arguments, config not found, unreachable database).
*/
async function runLilypadDoctorCli(argv, env, output, { run = runLilypadDoctor, load = loadLilypadDbConfig } = {}) {
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
* `npx lilypad-doctor`: checks that the database has what the `LilypadDbCache` instances need.
* See `runLilypadDoctorCli` for the options, or run it with `--help`.
*/
runLilypadDoctorCli(process.argv.slice(2), process.env, console).then((code) => {
	process.exitCode = code;
});
//#endregion
export {};

//# sourceMappingURL=lilypad-doctor.mjs.map