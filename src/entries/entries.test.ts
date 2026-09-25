import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const srcDir = resolve(__dirname, '..');

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
 * The external modules reached from a source file, following its value imports
 * (`import type` is erased at build time, so it is skipped).
 */
function externalImports(entryFile: string): Set<string> {
  const external = new Set<string>();
  const visited = new Set<string>();
  const visit = (file: string) => {
    if (visited.has(file)) {
      return;
    }
    visited.add(file);
    const source = readFileSync(file, 'utf8');
    const statements = source.matchAll(
      /^\s*(import|export)(\s+type)?\s[^;]*?from\s+['"]([^'"]+)['"]/gms
    );
    for (const [, , typeOnly, specifier] of statements) {
      if (typeOnly) {
        continue;
      }
      const resolved = resolveImport(file, specifier);
      if (resolved) {
        visit(resolved);
      } else if (!specifier.startsWith('.') && !specifier.startsWith('@/')) {
        external.add(specifier);
      }
    }
  };
  visit(entryFile);
  return external;
}

describe('package entries', () => {
  it.each(['logger', 'cache', 'flow', 'serializer', 'singleton', 'platform'])(
    'should keep the "%s" entry free of Node.js-only and database imports',
    (entry) => {
      const imports = externalImports(join(srcDir, 'entries', `${entry}.ts`));

      expect([...imports]).toEqual([]);
    }
  );

  it('should limit the external imports of the "db" entry to postgres and node:crypto', () => {
    const imports = externalImports(join(srcDir, 'entries', 'db.ts'));

    expect([...imports].sort()).toEqual(['node:crypto', 'postgres']);
  });
});
