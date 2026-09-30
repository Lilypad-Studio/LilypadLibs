import { existsSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { lilypadDbConfigTemplate } from '@/cli/lilypadDbConfigTemplate';
import { LILYPAD_DEFAULT_DB_CONFIG_NAME } from '@/dbConfig/LilypadDbConfigDefaults';
import { lilypadDbConfigFileNames } from '@/dbConfig/loadLilypadDbConfig';

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
const EXTENSIONS = new Set(['.ts', '.mts', '.mjs', '.js']);
/** `lilypad.config.<ext>` or `lilypad.<name>.config.<ext>`: the name a path gives its config. */
const CONFIG_FILE = /^lilypad\.(?:([A-Za-z0-9_-]+)\.)?config\.(?:ts|mts|mjs|js)$/;

/** Where the command writes, and the file system it uses (replaceable in tests). */
export type LilypadInitDependencies = {
  cwd?: string | undefined;
  exists?: ((path: string) => boolean) | undefined;
  writeFile?: ((path: string, content: string) => void) | undefined;
};

export type LilypadInitTarget = {
  /** The file to create. */
  path: string;
  /** The name of the config it defines. */
  name: string;
  /** The files that already define this config (any extension), which `--force` does not remove. */
  existing: string[];
};

/**
 * The file `init` creates for `--config` (a name, a path, or nothing for the default config).
 *
 * @throws With a message for the user when the path has an extension Node.js cannot load.
 */
export function lilypadInitTarget(
  config: string | undefined,
  cwd: string,
  exists: (path: string) => boolean
): LilypadInitTarget {
  const reference = config ?? LILYPAD_DEFAULT_DB_CONFIG_NAME;
  if (CONFIG_NAME.test(reference)) {
    const candidates = lilypadDbConfigFileNames(reference).map((file) => resolve(cwd, file));
    return {
      path: candidates[0]!,
      name: reference,
      existing: candidates.filter((candidate) => exists(candidate)),
    };
  }
  const path = isAbsolute(reference) ? reference : resolve(cwd, reference);
  if (!EXTENSIONS.has(extname(path))) {
    throw new Error(`The config file must end with .ts, .mts, .mjs or .js (got ${reference}).`);
  }
  const match = CONFIG_FILE.exec(basename(path));
  const name = match?.[1] ?? LILYPAD_DEFAULT_DB_CONFIG_NAME;
  // A file named as a config: the loader refuses two files of it in one folder
  const siblings = match
    ? lilypadDbConfigFileNames(name).map((file) => resolve(dirname(path), file))
    : [path];
  return { path, name, existing: siblings.filter((sibling) => exists(sibling)) };
}

/**
 * Runs `lilypad-doctor init` with these arguments.
 *
 * @returns The exit code: 0 when the file is created, 2 otherwise.
 */
export function runLilypadInitCli(
  argv: string[],
  output: { log(message: string): void; error(message: string): void },
  {
    cwd = process.cwd(),
    exists = existsSync,
    writeFile = (path, content) => writeFileSync(path, content),
  }: LilypadInitDependencies = {}
): number {
  let values: {
    config?: string | undefined;
    empty?: boolean | undefined;
    force?: boolean | undefined;
    help?: boolean | undefined;
  };
  let target: LilypadInitTarget;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        config: { type: 'string' },
        empty: { type: 'boolean' },
        force: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
    if (values.help) {
      output.log(LILYPAD_INIT_USAGE);
      return 0;
    }
    if (values.config?.trim() === '') {
      throw new Error('--config needs the name or the path of a config.');
    }
    target = lilypadInitTarget(values.config, cwd, exists);
  } catch (error) {
    output.error(
      `${error instanceof Error ? error.message : String(error)}\n\n${LILYPAD_INIT_USAGE}`
    );
    return 2;
  }

  const shown = (path: string) => relative(cwd, path) || path;
  const others = target.existing.filter((path) => path !== target.path);
  if (target.existing.length > 0 && !values.force) {
    output.error(
      `lilypad-doctor init: ${target.existing.map(shown).join(', ')} already exists: pass --force to overwrite ${shown(target.path)}.`
    );
    return 2;
  }
  const content = lilypadDbConfigTemplate({
    name: target.name,
    typescript: ['.ts', '.mts'].includes(extname(target.path)),
    empty: values.empty ?? false,
  });
  try {
    writeFile(target.path, content);
  } catch (error) {
    output.error(
      `lilypad-doctor init: could not write ${shown(target.path)}: ${error instanceof Error ? error.message : String(error)}`
    );
    return 2;
  }
  const check =
    target.name === LILYPAD_DEFAULT_DB_CONFIG_NAME && values.config === undefined
      ? 'npx lilypad-doctor'
      : `npx lilypad-doctor --config ${values.config ?? target.name}`;
  output.log(
    [
      `Created ${shown(target.path)}.`,
      ...(others.length > 0
        ? [`Warning: ${others.map(shown).join(', ')} defines the same config: remove it.`]
        : []),
      ...(extname(target.path) === '.js'
        ? ['A .js config is an ES module: the package.json needs "type": "module" (or use .mjs).']
        : []),
      'Describe your tables in it, import it where the application creates its gates and caches,',
      `then check the database with: ${check} --url "$DATABASE_URL"`,
    ].join('\n')
  );
  return 0;
}
