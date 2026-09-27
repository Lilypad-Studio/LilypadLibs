#!/usr/bin/env node
import { t as runLilypadDoctor } from "./chunks/LilypadDoctor-BYrsADBf.mjs";
import { parseArgs } from "node:util";
//#region src/cli/LilypadDoctorCli.ts
const USAGE = `Usage: lilypad-doctor [options]

Checks that the database has what the LilypadDbCache instances need: the changelog, its triggers,
the notification triggers, and how the changelog is pruned. It only reads the catalogs.

Options:
  --url <connection string>   The database (default: the DATABASE_URL environment variable)
  --table <table>[:<key>]     A cached table and its primary key (default key: id); repeatable
  --changelog-table <name>    The changelog table, if not lilypad_cache_changes
  --no-changelog              No cache reads a changelog (the listen strategy only)
  --notify-channel <channel>  Also check the triggers that notify this channel (e.g. cache_events)
  --pruning <mode>            detect (default), trigger, cron or external
  --min-retention <ms>        The largest maxGap and lookback of the caches (default: 1 hour)
  --json                      Print the result as JSON
  -h, --help                  Print this help

Exit code: 0 when nothing prevents the caches from working (warnings may be printed), 1 when the
database is not set up, 2 when the check could not run.`;
const PRUNING_MODES = /* @__PURE__ */ new Set([
	"detect",
	"trigger",
	"cron",
	"external"
]);
/** A cached table given as `table` or `table:primaryKey` (the table may be `schema.table`). */
function parseTable(spec) {
	const separator = spec.lastIndexOf(":");
	if (separator <= 0) return {
		table: spec,
		primaryKey: "id"
	};
	return {
		table: spec.slice(0, separator),
		primaryKey: spec.slice(separator + 1) || "id"
	};
}
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
			url: { type: "string" },
			table: {
				type: "string",
				multiple: true
			},
			"changelog-table": { type: "string" },
			"no-changelog": { type: "boolean" },
			"notify-channel": { type: "string" },
			pruning: { type: "string" },
			"min-retention": { type: "string" },
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
	const pruning = values.pruning;
	if (pruning !== void 0 && !PRUNING_MODES.has(pruning)) throw new Error(`--pruning must be one of ${[...PRUNING_MODES].join(", ")}.`);
	const minRetention = values["min-retention"] === void 0 ? void 0 : Number(values["min-retention"]);
	if (minRetention !== void 0 && !(Number.isFinite(minRetention) && minRetention > 0)) throw new Error("--min-retention must be a positive number of milliseconds.");
	if (values["no-changelog"] && values["changelog-table"] !== void 0) throw new Error("--no-changelog and --changelog-table cannot be used together.");
	return {
		help: false,
		json: values.json ?? false,
		options: {
			connectionString,
			tables: (values.table ?? []).map(parseTable),
			changelog: values["no-changelog"] ? false : {
				table: values["changelog-table"],
				pruning,
				minRetention
			},
			notifyChannel: values["notify-channel"] ?? false
		}
	};
}
/**
* Runs `lilypad-doctor` with these arguments.
*
* @returns The exit code: 0 without errors (there may be warnings), 1 with errors, 2 when the
* check could not run (invalid arguments, unreachable database).
*/
async function runLilypadDoctorCli(argv, env, output, run = runLilypadDoctor) {
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
	try {
		const report = await run(parsed.options);
		if (parsed.json) {
			const { text: _text, ...result } = report;
			output.log(JSON.stringify(result, null, 2));
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