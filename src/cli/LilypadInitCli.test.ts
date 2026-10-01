import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { lilypadInitTarget, runLilypadInitCli } from './LilypadInitCli';
import { runLilypadDoctorCli } from './LilypadDoctorCli';
import { lilypadDbConfigTemplate } from './lilypadDbConfigTemplate';
import { isLilypadDbConfig, type LilypadDbConfig } from '@/dbConfig/LilypadDbConfig';

const cwd = resolve('/app');

function output() {
  return { log: vi.fn(), error: vi.fn() };
}

/** An in-memory file system, with these files already there. */
function files(...existing: string[]) {
  const written = new Map<string, string>(existing.map((file) => [resolve(cwd, file), '']));
  return {
    written,
    deps: {
      cwd,
      exists: (path: string) => written.has(path),
      writeFile: (path: string, content: string) => void written.set(path, content),
    },
  };
}

describe('lilypadInitTarget', () => {
  const none = () => false;

  it.each<[string | undefined, string, string]>([
    [undefined, 'lilypad.config.ts', 'default'],
    ['default', 'lilypad.config.ts', 'default'],
    ['analytics', 'lilypad.analytics.config.ts', 'analytics'],
    ['./db/lilypad.analytics.config.mjs', 'db/lilypad.analytics.config.mjs', 'analytics'],
    ['./db/lilypad.config.js', 'db/lilypad.config.js', 'default'],
    ['./db/database.mts', 'db/database.mts', 'default'],
  ])('should create for %s the file %s, of the config %s', (config, file, name) => {
    expect(lilypadInitTarget(config, cwd, none)).toEqual({
      path: resolve(cwd, file),
      name,
      existing: [],
    });
  });

  it('should find the files of the same config with any extension', () => {
    const exists = (path: string) => path === resolve(cwd, 'lilypad.analytics.config.mjs');

    expect(lilypadInitTarget('analytics', cwd, exists).existing).toEqual([
      resolve(cwd, 'lilypad.analytics.config.mjs'),
    ]);
  });

  it('should find the files of the same config next to a path named as a config', () => {
    const existing = resolve(cwd, 'db/lilypad.config.ts');
    const exists = (path: string) => path === existing;

    expect(lilypadInitTarget('./db/lilypad.config.mjs', cwd, exists).existing).toEqual([existing]);
    expect(lilypadInitTarget('./db/database.mjs', cwd, exists).existing).toEqual([]);
  });

  it('should take lilypad.default.config.* for a file of its own, which only its path loads', () => {
    const path = resolve(cwd, 'lilypad.default.config.ts');
    const others = [path, resolve(cwd, 'lilypad.config.ts')];

    // The loader looks for the default config in lilypad.config.*: both files may stay
    expect(
      lilypadInitTarget('./lilypad.default.config.ts', cwd, (file) => others.includes(file))
    ).toEqual({ path, name: 'default', existing: [path] });
  });

  it('should overwrite lilypad.default.config.ts with --force', () => {
    const out = output();
    const fs = files('lilypad.default.config.ts');
    const deps = {
      ...fs.deps,
      // As writeFileSync with the `wx` flag: an existing file is replaced only with `overwrite`
      writeFile: (path: string, content: string, overwrite: boolean) => {
        if (!overwrite && fs.written.has(path)) {
          throw new Error(`EEXIST: file already exists, open '${path}'`);
        }
        fs.written.set(path, content);
      },
    };

    expect(
      runLilypadInitCli(['--config', './lilypad.default.config.ts', '--force'], out, deps)
    ).toBe(0);

    expect(fs.written.get(resolve(cwd, 'lilypad.default.config.ts'))).toContain('defineLilypadDb');
  });

  it('should reject a path that Node.js cannot load as a module', () => {
    expect(() => lilypadInitTarget('./db/config.json', cwd, none)).toThrow(
      'must end with .ts, .mts, .mjs or .js'
    );
  });
});

describe('runLilypadInitCli', () => {
  it('should create lilypad.config.ts with an example table', () => {
    const out = output();
    const fs = files();

    expect(runLilypadInitCli([], out, fs.deps)).toBe(0);

    const content = fs.written.get(resolve(cwd, 'lilypad.config.ts'))!;
    expect(content).toContain("const example = defineLilypadTable<Example, 'id'>({");
    expect(content).toContain('tables: { example },');
    expect(content).not.toMatch(/^ {2}name: '/m); // no name option: the default config
    expect(out.log).toHaveBeenCalledWith(expect.stringContaining('Created lilypad.config.ts.'));
    expect(out.log).toHaveBeenCalledWith(
      expect.stringContaining('npx lilypad-doctor --url "$DATABASE_URL"')
    );
  });

  it('should name a config created by name, and tell how to check it', () => {
    const out = output();
    const fs = files();

    expect(runLilypadInitCli(['--config', 'analytics', '--empty'], out, fs.deps)).toBe(0);

    const content = fs.written.get(resolve(cwd, 'lilypad.analytics.config.ts'))!;
    expect(content).toContain("name: 'analytics',");
    expect(content).toContain('tables: {},');
    expect(content).toContain("import { defineLilypadDb } from '@lilypad-studio/libs/schema';");
    expect(out.log).toHaveBeenCalledWith(
      expect.stringContaining('npx lilypad-doctor --config analytics --url')
    );
  });

  it('should write JavaScript for a .mjs or .js path', () => {
    const out = output();
    const fs = files();

    expect(runLilypadInitCli(['--config', './lilypad.config.js'], out, fs.deps)).toBe(0);

    const content = fs.written.get(resolve(cwd, 'lilypad.config.js'))!;
    expect(content).toContain('const example = defineLilypadTable({');
    expect(content).not.toContain('type Example');
    expect(out.log).toHaveBeenCalledWith(expect.stringContaining('"type": "module"'));
  });

  it('should not overwrite an existing config without --force', () => {
    const out = output();
    const fs = files('lilypad.config.ts');

    expect(runLilypadInitCli([], out, fs.deps)).toBe(2);
    expect(out.error).toHaveBeenCalledWith(
      'lilypad-doctor init: lilypad.config.ts already exists: pass --force to overwrite it.'
    );
    expect(fs.written.get(resolve(cwd, 'lilypad.config.ts'))).toBe('');
  });

  it('should overwrite with --force', () => {
    const out = output();
    const fs = files('lilypad.config.ts');

    expect(runLilypadInitCli(['--force'], out, fs.deps)).toBe(0);

    expect(fs.written.get(resolve(cwd, 'lilypad.config.ts'))).toContain('defineLilypadDb');
  });

  it.each([[[]], [['--force']]])(
    'should refuse %o next to another file of the same config, which the loader would refuse with it',
    (argv) => {
      const out = output();
      const fs = files('lilypad.config.ts', 'lilypad.config.mjs');

      expect(runLilypadInitCli(argv, out, fs.deps)).toBe(2);
      expect(out.error).toHaveBeenCalledWith(
        'lilypad-doctor init: lilypad.config.mjs already defines the config "default": remove it first (--force only overwrites lilypad.config.ts).'
      );
      expect(fs.written.get(resolve(cwd, 'lilypad.config.ts'))).toBe('');
    }
  );

  it.each([
    [['--config', './config.json'], 'must end with'],
    [['--config', ''], '--config needs'],
    [['--table', 'users'], "Unknown option '--table'"],
  ])('should exit with 2 on %o', (argv, message) => {
    const out = output();

    expect(runLilypadInitCli(argv, out, files().deps)).toBe(2);
    expect(out.error).toHaveBeenCalledWith(expect.stringContaining(message));
  });

  it('should exit with 2 when the file cannot be written', () => {
    const out = output();
    const deps = {
      ...files().deps,
      writeFile: () => {
        throw new Error('EACCES: permission denied');
      },
    };

    expect(runLilypadInitCli([], out, deps)).toBe(2);
    expect(out.error).toHaveBeenCalledWith(
      'lilypad-doctor init: could not write lilypad.config.ts: EACCES: permission denied'
    );
  });

  it('should not replace a file created after the check, nor one --force was not asked for', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lilypad-init-'));
    try {
      const file = join(dir, 'lilypad.config.ts');
      writeFileSync(file, 'mine');
      const out = output();
      // The check does not see the file: e.g. created in between, or a link to a missing file
      const deps = { cwd: dir, exists: () => false };

      expect(runLilypadInitCli([], out, deps)).toBe(2);
      expect(readFileSync(file, 'utf8')).toBe('mine');
      expect(out.error).toHaveBeenCalledWith(expect.stringContaining('EEXIST'));

      expect(runLilypadInitCli(['--force'], output(), { cwd: dir })).toBe(0);
      expect(readFileSync(file, 'utf8')).not.toBe('mine');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should be the init command of lilypad-doctor, which needs no database', async () => {
    const out = output();
    const fs = files();

    await expect(runLilypadDoctorCli(['init'], {}, out, { init: fs.deps })).resolves.toBe(0);
    await expect(runLilypadDoctorCli(['init', '--help'], {}, out)).resolves.toBe(0);

    expect(fs.written.has(resolve(cwd, 'lilypad.config.ts'))).toBe(true);
    expect(out.log).toHaveBeenCalledWith(expect.stringContaining('Usage: lilypad-doctor init'));
  });
});

describe('lilypadDbConfigTemplate', () => {
  let dir: string;
  // The templates import the package: here, its source
  const schemaEntry = pathToFileURL(resolve(__dirname, '../entries/schema.ts')).href;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lilypad-template-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['TypeScript', 'ts', true, false],
    ['TypeScript, empty', 'ts', true, true],
    ['JavaScript', 'mjs', false, false],
    ['JavaScript, empty', 'mjs', false, true],
  ])('should define a valid config (%s)', async (_case, extension, typescript, empty) => {
    const file = join(dir, `lilypad.template-${extension}-${String(empty)}.config.${extension}`);
    const content = lilypadDbConfigTemplate({ name: 'template', typescript, empty });
    writeFileSync(
      file,
      content.replaceAll("from '@lilypad-studio/libs/schema'", `from '${schemaEntry}'`)
    );

    const module = (await import(pathToFileURL(file).href)) as { default: LilypadDbConfig };

    expect(isLilypadDbConfig(module.default)).toBe(true);
    expect(module.default.name).toBe('template');
    expect(Object.keys(module.default.tables)).toEqual(empty ? [] : ['example']);
    if (!empty) {
      // eslint-disable-next-line vitest/no-conditional-expect -- the empty template has no table
      expect(module.default.tables.example).toMatchObject({
        qualifiedName: 'public.example',
        primaryKey: 'id',
        generatedPrimaryKey: true,
        unique: [{ columns: ['name'] }],
        sync: { strategy: 'listen' },
      });
    }
  });
});
