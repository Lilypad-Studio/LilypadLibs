import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { edgeFolders, nodeOnlyFolders } from '../../edge.config.ts';

const srcDir = resolve(__dirname, '..');

/** The entries of the package (`src/entries/*.ts`), by name. */
const entries = readdirSync(join(srcDir, 'entries'))
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
  .map((file) => file.slice(0, -'.ts'.length));

/** Resolves a relative or `@/` import of a source file to the imported source file. */
function resolveImport(fromFile: string, specifier: string): string | undefined {
  let base: string;
  if (specifier.startsWith('@/')) {
    base = join(srcDir, specifier.slice(2));
  } else if (specifier.startsWith('.')) {
    base = join(dirname(fromFile), specifier);
  } else {
    return undefined;
  }
  return [`${base}.ts`, join(base, 'index.ts')].find((file) => existsSync(file));
}

/**
 * The modules a source imports at run time: static imports and re-exports (`import type` and
 * `export type` are erased at build time, so they are skipped), side-effect imports, and dynamic
 * `import()` of a string (`typeof import('x')` is a type, so it is skipped). Under
 * `verbatimModuleSyntax`, `import { type X } from 'x'` is kept as `import {} from 'x'`: it counts.
 */
function importSpecifiers(source: string): string[] {
  const patterns = [
    /^\s*(?:import|export)(?!\s+type\s)\s[^;]*?from\s+['"]([^'"]+)['"]/gms,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /(?<!typeof\s+)\bimport\s*\(\s*['"]([^'"]+)['"]\s*[,)]/g,
  ];
  return patterns.flatMap((pattern) =>
    [...source.matchAll(pattern)].map(([, specifier]) => specifier!)
  );
}

/** The external modules reached from a source file, following its run-time imports. */
function externalImports(entryFile: string): Set<string> {
  const external = new Set<string>();
  const visited = new Set<string>();
  const visit = (file: string) => {
    if (visited.has(file)) {
      return;
    }
    visited.add(file);
    for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
      if (!specifier.startsWith('.') && !specifier.startsWith('@/')) {
        external.add(specifier);
        continue;
      }
      // An import the walk cannot follow would hide everything behind it
      const resolved = resolveImport(file, specifier);
      if (!resolved) {
        throw new Error(`${file}: unresolved import "${specifier}"`);
      }
      visit(resolved);
    }
  };
  visit(entryFile);
  return external;
}

describe('package entries', () => {
  it('should find the run-time imports of a source, whatever their form', () => {
    const source = [
      "import { a } from './a';",
      "import type { B } from 'postgres';",
      "import { type C } from 'type-only-specifiers';",
      "export * from './star';",
      "export type { D } from 'erased';",
      "import 'side-effect';",
      "const e = await import('dynamic');",
      "const f = await import('with-options', { with: { type: 'json' } });",
      "type G = typeof import('type-position');",
      'import {',
      '  h,',
      "} from 'multi-line';",
    ].join('\n');

    expect(importSpecifiers(source).sort()).toEqual([
      './a',
      './star',
      'dynamic',
      'multi-line',
      'side-effect',
      'type-only-specifiers',
      'with-options',
    ]);
  });

  it('should list every module folder of src/ as edge-compatible or Node.js-only', () => {
    const folders = readdirSync(srcDir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory() && dirent.name !== 'entries')
      .map((dirent) => dirent.name);

    expect(folders.sort()).toEqual([...edgeFolders, ...nodeOnlyFolders].sort());
  });

  it.each([
    'index',
    ...entries.filter((entry) => entry !== 'db').map((entry) => `entries/${entry}`),
  ])('should keep "%s" free of Node.js-only and database imports', (entry) => {
    const imports = externalImports(join(srcDir, `${entry}.ts`));

    expect([...imports]).toEqual([]);
  });

  it('should limit the external imports of the "db" entry to postgres and a few Node.js modules', () => {
    const imports = externalImports(join(srcDir, 'entries', 'db.ts'));

    expect([...imports].sort()).toEqual([
      'node:crypto',
      'node:fs',
      'node:path',
      'node:url',
      'postgres',
    ]);
  });

  it('should export the errors a module throws from its entry, as the same classes', async () => {
    const [cache, db, flow] = await Promise.all([
      import('./cache'),
      import('./db'),
      import('./flow'),
    ]);

    expect(cache.LilypadTimeoutError).toBe(flow.LilypadTimeoutError);
    expect(db.LilypadTimeoutError).toBe(flow.LilypadTimeoutError);
    expect(db.LilypadCacheCooldownError).toBe(cache.LilypadCacheCooldownError);
    expect(db.LilypadDisposedError).toBe(cache.LilypadDisposedError);
  });
});
