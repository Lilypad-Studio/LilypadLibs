import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isLilypadDbConfig, type LilypadDbConfig } from '@/dbConfig/LilypadDbConfig';
import { LILYPAD_DEFAULT_DB_CONFIG_NAME } from '@/dbConfig/LilypadDbConfigDefaults';

/** The extensions of the config files, in the order they are looked for. */
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
 * @throws If there is no such file.
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
  const found = candidates.map((file) => resolve(cwd, file)).find((path) => existsSync(path));
  if (!found) {
    throw new Error(
      `No config "${reference}" in ${cwd}: expected one of ${candidates.join(', ')}.`
    );
  }
  return found;
}

/**
 * Loads a config file: its default export (or its `config` export) must be a config made with
 * `defineLilypadDb`. A config found by name must have that name.
 *
 * A TypeScript config is loaded by Node.js itself (type stripping: Node.js 22.18 or later, or
 * `--experimental-strip-types`): it may use only erasable syntax, and its relative imports need
 * their extension (`./tables/users.ts`). Otherwise, write it as `.mjs`.
 *
 * @param options.config - The name of the config (`default` when absent), or the path of its file.
 * @param options.cwd - Where the config files are looked for. Defaults to the working directory.
 * @throws If the file does not exist, cannot be loaded, or exports no config.
 */
export async function loadLilypadDbConfig(
  options: { config?: string; cwd?: string } = {}
): Promise<{ path: string; config: LilypadDbConfig }> {
  const path = findLilypadDbConfig(options.config, options.cwd ?? process.cwd());
  let module: Record<string, unknown>;
  try {
    module = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ERR_UNKNOWN_FILE_EXTENSION') {
      throw new Error(
        `Node.js ${process.version} cannot load the TypeScript config ${path}: use Node.js 22.18 or later, run it with NODE_OPTIONS=--experimental-strip-types, or write the config as .mjs.`,
        { cause: error }
      );
    }
    throw new Error(`Could not load the config ${path}: ${String(error)}`, { cause: error });
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
