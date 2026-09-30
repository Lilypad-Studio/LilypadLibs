import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isLilypadDbConfig, type LilypadDbConfig } from '@/dbConfig/LilypadDbConfig';
import { LILYPAD_DEFAULT_DB_CONFIG_NAME } from '@/dbConfig/LilypadDbConfigDefaults';

/** The extensions of the config files. */
const EXTENSIONS = ['ts', 'mts', 'mjs', 'js'];
const CONFIG_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * The file names of a config: `lilypad.config.<ext>` for the default one, `lilypad.<name>.config.<ext>`
 * for the others.
 */
export function lilypadDbConfigFileNames(name: string): string[] {
  const base =
    name === LILYPAD_DEFAULT_DB_CONFIG_NAME ? 'lilypad.config' : `lilypad.${name}.config`;
  return EXTENSIONS.map((extension) => `${base}.${extension}`);
}

/**
 * The file of a config: `config` is the name of a config (`default` when absent), looked for in
 * `cwd`, or the path of a file.
 *
 * @throws If there is no such file, or if several files have that name (e.g. `lilypad.config.ts`
 * and `lilypad.config.mjs`).
 */
export function findLilypadDbConfig(config: string | undefined, cwd: string): string {
  const reference = config ?? LILYPAD_DEFAULT_DB_CONFIG_NAME;
  if (!CONFIG_NAME.test(reference)) {
    const path = isAbsolute(reference) ? reference : resolve(cwd, reference);
    if (!existsSync(path)) {
      throw new Error(`The config file ${path} does not exist.`);
    }
    return path;
  }
  const candidates = lilypadDbConfigFileNames(reference);
  const found = candidates.filter((file) => existsSync(resolve(cwd, file)));
  const [file, ...others] = found;
  if (file === undefined) {
    throw new Error(
      `No config "${reference}" in ${cwd}: expected one of ${candidates.join(', ')}.`
    );
  }
  if (others.length > 0) {
    throw new Error(
      `Several files of the config "${reference}" in ${cwd}: ${found.join(', ')}. Keep only one.`
    );
  }
  return resolve(cwd, file);
}

/** The errors of a module that Node.js cannot resolve without a bundler. */
const RESOLUTION_ERRORS = new Set([
  'ERR_MODULE_NOT_FOUND',
  'ERR_UNSUPPORTED_DIR_IMPORT',
  'ERR_IMPORT_ATTRIBUTE_MISSING',
  'ERR_IMPORT_ASSERTION_TYPE_MISSING',
]);

/** What to change in a config that Node.js could not load, from its error. */
export function lilypadConfigLoadHint(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : '';
  const cause = message.includes('does not provide an export named')
    ? 'A type is imported without `import type`: the type stripping of Node.js keeps the import, which then fails (`verbatimModuleSyntax` in tsconfig.json reports them). '
    : typeof code === 'string' && RESOLUTION_ERRORS.has(code)
      ? "Node.js loads the config without a bundler: path aliases, relative imports without their extension, and JSON imports without `with { type: 'json' }` do not resolve. "
      : '';
  return `${cause}A config should import only '@lilypad-studio/libs/schema', its own files, and types (\`import type\`, erased before loading): bind the functions of the application to it with bindLilypadDbHooks where the application creates its gate.`;
}

/**
 * Loads a config file: its default export (or its `config` export) must be a config made with
 * `defineLilypadDb`. A config found by name must have that name.
 *
 * A TypeScript config is loaded by Node.js itself (type stripping: Node.js 22.18 or later, or
 * `--experimental-strip-types`): it may use only erasable syntax, its relative imports need
 * their extension (`./tables/users.ts`), and its types must be imported with `import type`.
 * Otherwise, write it as `.mjs`.
 *
 * @param options.config - The name of the config (`default` when absent), or the path of its file.
 * @param options.cwd - Where the config files are looked for. Defaults to the working directory.
 * @throws If the file does not exist, cannot be loaded, or exports no config.
 */
export async function loadLilypadDbConfig(
  options: { config?: string | undefined; cwd?: string | undefined } = {}
): Promise<{ path: string; config: LilypadDbConfig }> {
  const path = findLilypadDbConfig(options.config, options.cwd ?? process.cwd());
  let module: Record<string, unknown>;
  try {
    module = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ERR_UNKNOWN_FILE_EXTENSION') {
      throw new Error(
        `Node.js ${process.version} cannot load the TypeScript config ${path}: use Node.js 22.18 or later, run it with NODE_OPTIONS=--experimental-strip-types, or write the config as .mjs.`,
        { cause: error }
      );
    }
    throw new Error(
      `Could not load the config ${path}: ${String(error)}
${lilypadConfigLoadHint(error)}`,
      {
        cause: error,
      }
    );
  }
  const config = [module.default, module.config].find(isLilypadDbConfig);
  if (!config) {
    throw new Error(
      `The config ${path} must export a config made with defineLilypadDb (export default defineLilypadDb({ ... })).`
    );
  }
  const expected = options.config ?? LILYPAD_DEFAULT_DB_CONFIG_NAME;
  if (CONFIG_NAME.test(expected) && config.name !== expected) {
    throw new Error(
      `The config ${path} is named "${config.name}", but it was looked for as "${expected}": set name: '${expected}' in defineLilypadDb, or rename the file.`
    );
  }
  return { path, config };
}
