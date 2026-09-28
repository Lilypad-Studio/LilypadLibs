// Loads the installed package the way an application does: every subpath of its `exports` with
// `import` and with `require()` (Node.js 22.12+ loads ES modules with it), then runs the command.
// CI runs it on the packed tarball, with the lowest Node.js version of `engines`.
//
// Usage: copy it into a project where the package is installed (a copy left in this repository
// would import the package from the repository itself), then node smoke-test.mjs
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const name = '@lilypad-studio/libs';
const require = createRequire(`${process.cwd()}/`);
const manifestPath = require.resolve(`${name}/package.json`);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const subpaths = Object.keys(manifest.exports).filter((subpath) => subpath !== './package.json');
for (const subpath of subpaths) {
  const specifier = subpath === '.' ? name : `${name}/${subpath.slice(2)}`;
  const imported = await import(specifier);
  const required = require(specifier);
  // Named exports only (`platform` exports types only: its module is empty)
  if (imported.default !== undefined) {
    throw new Error(`${specifier}: unexpected default export`);
  }
  // One copy of each module: `instanceof` works whatever the importer
  for (const [key, value] of Object.entries(imported)) {
    if (required[key] !== value) {
      throw new Error(`${specifier}: require() and import give two copies of ${key}`);
    }
  }
  console.log(`ok ${specifier} (${Object.keys(imported).length} exports)`);
}

const command = join(dirname(manifestPath), manifest.bin['lilypad-doctor']);
const help = execFileSync(process.execPath, [command, '--help'], { encoding: 'utf8' });
console.log(`ok lilypad-doctor --help (${help.split('\n')[0]})`);
