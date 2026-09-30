import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  findLilypadDbConfig,
  lilypadConfigLoadHint,
  lilypadDbConfigFileNames,
  loadLilypadDbConfig,
} from './loadLilypadDbConfig';

/** A module whose default export passes for a config of this name (the mark of defineLilypadDb). */
const configModule = (name: string, exportName = 'default') =>
  `const config = { [Symbol.for('lilypad.dbConfig')]: true, name: ${JSON.stringify(name)}, tables: {} };\n` +
  (exportName === 'default' ? 'export default config;\n' : `export { config as ${exportName} };\n`);

describe('loadLilypadDbConfig', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lilypad-config-'));
    writeFileSync(join(dir, 'lilypad.config.mjs'), configModule('default'));
    writeFileSync(join(dir, 'lilypad.analytics.config.js'), configModule('analytics', 'config'));
    writeFileSync(join(dir, 'lilypad.misnamed.config.mjs'), configModule('other'));
    writeFileSync(join(dir, 'custom.mjs'), configModule('custom'));
    writeFileSync(join(dir, 'not-a-config.mjs'), 'export default { name: "plain" };\n');
    writeFileSync(join(dir, 'broken.mjs'), 'export default (;\n');
    writeFileSync(join(dir, 'app-code.mjs'), "throw new Error('server-only');\n");
    writeFileSync(join(dir, 'throws-null.mjs'), 'throw null;\n');
    writeFileSync(join(dir, 'lilypad.twice.config.mjs'), configModule('twice'));
    writeFileSync(join(dir, 'lilypad.twice.config.js'), configModule('twice'));
    // Written as ESM: `.js` files are loaded as modules by the "type" of this package.json
    writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('should name the files of the default config and of the others', () => {
    expect(lilypadDbConfigFileNames('default')).toEqual([
      'lilypad.config.ts',
      'lilypad.config.mts',
      'lilypad.config.mjs',
      'lilypad.config.js',
    ]);
    expect(lilypadDbConfigFileNames('analytics')[0]).toBe('lilypad.analytics.config.ts');
  });

  it('should load the default config without a name', async () => {
    const { path, config } = await loadLilypadDbConfig({ cwd: dir });

    expect(path).toBe(join(dir, 'lilypad.config.mjs'));
    expect(config.name).toBe('default');
  });

  it('should load another config by name, from its default or its `config` export', async () => {
    const { path, config } = await loadLilypadDbConfig({ config: 'analytics', cwd: dir });

    expect(path).toBe(join(dir, 'lilypad.analytics.config.js'));
    expect(config.name).toBe('analytics');
  });

  it('should load a config by path, whatever its name', async () => {
    const { config } = await loadLilypadDbConfig({ config: './custom.mjs', cwd: dir });

    expect(config.name).toBe('custom');
  });

  it.each([
    ['a missing name', { config: 'missing' }, 'No config "missing"'],
    ['a missing path', { config: './missing.mjs' }, 'does not exist'],
    [
      'a file named differently',
      { config: 'misnamed' },
      'is named "other", but it was looked for as "misnamed"',
    ],
    [
      'a module without a config',
      { config: './not-a-config.mjs' },
      'must export a config made with defineLilypadDb',
    ],
    ['a module that does not load', { config: './broken.mjs' }, 'Could not load the config'],
    ['a module that throws null', { config: './throws-null.mjs' }, 'Could not load the config'],
    ['a config of two files', { config: 'twice' }, 'Several files of the config "twice"'],
  ])('should reject %s', async (_case, options, message) => {
    await expect(loadLilypadDbConfig({ ...options, cwd: dir })).rejects.toThrow(message);
  });

  it('should explain what a config may import when it does not load', async () => {
    const loading = loadLilypadDbConfig({ config: './app-code.mjs', cwd: dir });

    await expect(loading).rejects.toThrow('Could not load the config');
    await expect(loading).rejects.toThrow('server-only');
    await expect(loading).rejects.toThrow('bind the functions of the application to it');
  });

  // Vitest resolves the imports more leniently than Node.js: the errors are built as Node.js throws them
  it.each([
    [
      'a type imported as a value',
      new SyntaxError(
        "The requested module './types.ts' does not provide an export named 'Permission'"
      ),
      'A type is imported without `import type`',
    ],
    [
      'an import without its extension',
      Object.assign(new Error("Cannot find module './types'"), { code: 'ERR_MODULE_NOT_FOUND' }),
      'Node.js loads the config without a bundler',
    ],
    [
      'a JSON import without its attribute',
      Object.assign(new TypeError('needs an import attribute of "type: json"'), {
        code: 'ERR_IMPORT_ATTRIBUTE_MISSING',
      }),
      'Node.js loads the config without a bundler',
    ],
  ])('should explain how to fix %s', (_case, error, cause) => {
    const hint = lilypadConfigLoadHint(error);

    expect(hint.startsWith(cause)).toBe(true);
    expect(hint).toContain('bindLilypadDbHooks');
  });

  it('should find a config file by name in order of extension', () => {
    expect(findLilypadDbConfig(undefined, dir)).toBe(join(dir, 'lilypad.config.mjs'));
    expect(() => findLilypadDbConfig('none', dir)).toThrow(
      'expected one of lilypad.none.config.ts, lilypad.none.config.mts'
    );
    expect(() => findLilypadDbConfig('twice', dir)).toThrow(
      'lilypad.twice.config.mjs, lilypad.twice.config.js. Keep only one.'
    );
  });
});
