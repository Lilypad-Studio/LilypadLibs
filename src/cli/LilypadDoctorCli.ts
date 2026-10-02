import { readFileSync } from 'node:fs';
import { parseArgs, parseEnv } from 'node:util';
import { runLilypadInitCli, type LilypadInitDependencies } from '@/cli/LilypadInitCli';
import type { LilypadDbConfig } from '@/dbConfig/LilypadDbConfig';
import { loadLilypadDbConfig } from '@/dbGate/loadLilypadDbConfig';
import { formatLilypadSchemaFixSql } from '@/dbGate/LilypadSchemaCheck';
import {
  runLilypadDoctor,
  type LilypadDoctorOptions,
  type LilypadDoctorReport,
} from '@/dbGate/LilypadDoctor';

const USAGE = `Usage: lilypad-doctor [options]
       lilypad-doctor init [--config <name|path>] [--empty] [--force]

init creates a config file to start from (see lilypad-doctor init --help).

Without a command, it checks the database against a config (see defineLilypadDb): the tables,
their columns, keys, foreign keys, indexes and checks, the triggers of the sync strategies, the
changelog and how it is pruned, and the statement_timeout of the role it connects as. It only reads
the catalogs, and prints the SQL that fixes what it finds.

Options:
  --config <name|path>  The config: a name finds lilypad.<name>.config.{ts,mts,mjs,js} in the
                        working directory; without it, lilypad.config.* (the "default" config)
  --url <connection>    The database (default: the DATABASE_URL environment variable)
  --url-env <name>      The environment variable that holds the database URL, instead of
                        DATABASE_URL
  --env-file <path>     Read environment variables from this file (e.g. .env); repeatable, the
                        later files win, and the variables already set win over every file
  --sql                 Print only the SQL that fixes the problems (for a migration)
  --json                Print the result as JSON
  --fail-on-warnings    Exit with 1 on warnings too, not only on errors (e.g. in CI)
  -h, --help            Print this help

A TypeScript config needs Node.js 22.18 or later (or NODE_OPTIONS=--experimental-strip-types).

Exit code: 0 when the database matches the config (warnings may be printed, unless
--fail-on-warnings), 1 when it does not (or has warnings, with --fail-on-warnings), 2 when the
check could not run (invalid arguments, config not found, unreachable database).`;

/** Where the command writes. */
export type LilypadDoctorOutput = {
  log(message: string): void;
  error(message: string): void;
};

export type LilypadDoctorArgs =
  | { help: true }
  | {
      help: false;
      json: boolean;
      sql: boolean;
      /** Whether a warning fails the check too (exit code 1). */
      failOnWarnings: boolean;
      connectionString: string;
      /** The name or path of the config (`undefined`: the default one). */
      config?: string | undefined;
    };

/** Reads the variables of an env file (`--env-file`), replaceable in tests. */
export type LilypadEnvFileReader = (path: string) => Record<string, string | undefined>;

// The types of Node.js 22.12 declare `object`: it holds the variables, as strings
const readEnvFile: LilypadEnvFileReader = (path) =>
  parseEnv(readFileSync(path, 'utf8')) as Record<string, string>;

/**
 * The options of the command line, or the help.
 *
 * @throws With a message for the user when an argument is not valid.
 */
export function parseLilypadDoctorArgs(
  argv: string[],
  env: Record<string, string | undefined>,
  readEnv: LilypadEnvFileReader = readEnvFile
): LilypadDoctorArgs {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      config: { type: 'string' },
      url: { type: 'string' },
      'url-env': { type: 'string' },
      'env-file': { type: 'string', multiple: true },
      sql: { type: 'boolean' },
      json: { type: 'boolean' },
      'fail-on-warnings': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    return { help: true };
  }
  if (values.sql && values.json) {
    throw new Error('--sql and --json cannot be used together.');
  }
  if (values.config?.trim() === '') {
    throw new Error('--config needs the name or the path of a config.');
  }
  const urlEnv = values['url-env'];
  if (values.url !== undefined && urlEnv !== undefined) {
    throw new Error('--url and --url-env cannot be used together.');
  }
  if (urlEnv?.trim() === '') {
    throw new Error('--url-env needs the name of an environment variable.');
  }
  const envFiles = values['env-file'] ?? [];
  const fromFiles: Record<string, string | undefined> = {};
  for (const path of envFiles) {
    let read: Record<string, string | undefined>;
    try {
      read = readEnv(path);
    } catch (error) {
      throw new Error(
        `Cannot read the env file ${path}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
    Object.assign(fromFiles, read);
  }
  const name = urlEnv ?? 'DATABASE_URL';
  // As with node --env-file, a variable already set wins over the files.
  const connectionString = values.url ?? env[name] ?? fromFiles[name];
  if (!connectionString) {
    const from =
      envFiles.length > 0 ? ` (neither in the environment nor in ${envFiles.join(', ')})` : '';
    throw new Error(
      urlEnv === undefined
        ? `Pass --url, or set DATABASE_URL${from}.`
        : `The environment variable ${urlEnv} is not set${from}.`
    );
  }
  return {
    help: false,
    json: values.json ?? false,
    sql: values.sql ?? false,
    failOnWarnings: values['fail-on-warnings'] ?? false,
    connectionString,
    config: values.config,
  };
}

/** What the command uses, replaceable in tests. */
export type LilypadDoctorCliDependencies = {
  run?: ((options: LilypadDoctorOptions) => Promise<LilypadDoctorReport>) | undefined;
  load?:
    | ((options: {
        config?: string | undefined;
      }) => Promise<{ path: string; config: LilypadDbConfig }>)
    | undefined;
  /** Reads the files of `--env-file`. */
  readEnv?: LilypadEnvFileReader | undefined;
  /** The file system of `init`. */
  init?: LilypadInitDependencies | undefined;
};

/**
 * Runs `lilypad-doctor` with these arguments: `init ...` creates a config file, anything else
 * checks the database.
 *
 * @returns The exit code: 0 without errors (there may be warnings, unless `--fail-on-warnings`),
 * 1 with errors (or warnings, with `--fail-on-warnings`), 2 when the check could not run (invalid
 * arguments, config not found, unreachable database).
 */
export async function runLilypadDoctorCli(
  argv: string[],
  env: Record<string, string | undefined>,
  output: LilypadDoctorOutput,
  {
    run = runLilypadDoctor,
    load = loadLilypadDbConfig,
    readEnv,
    init,
  }: LilypadDoctorCliDependencies = {}
): Promise<number> {
  if (argv[0] === 'init') {
    return runLilypadInitCli(argv.slice(1), output, init);
  }
  let parsed: LilypadDoctorArgs;
  try {
    parsed = parseLilypadDoctorArgs(argv, env, readEnv);
  } catch (error) {
    output.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.help) {
    output.log(USAGE);
    return 0;
  }
  let config: LilypadDbConfig;
  try {
    ({ config } = await load({ config: parsed.config }));
  } catch (error) {
    output.error(`lilypad-doctor: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  try {
    const report = await run({ connectionString: parsed.connectionString, config });
    const passed = parsed.failOnWarnings ? report.problems.length === 0 : report.ok;
    if (parsed.json) {
      const { text: _text, assertOk: _assertOk, ...result } = report;
      output.log(JSON.stringify(result, null, 2));
    } else if (parsed.sql) {
      const sql = formatLilypadSchemaFixSql(report.problems);
      output.log(sql === '' ? '-- lilypad-doctor: nothing to fix.' : sql);
    } else if (passed) {
      output.log(report.text);
    } else {
      output.error(report.text);
    }
    return passed ? 0 : 1;
  } catch (error) {
    output.error(
      `lilypad-doctor: could not check the database: ${error instanceof Error ? error.message : String(error)}`
    );
    return 2;
  }
}
