// Merges the sections of the newest version of CHANGELOG.md. `changeset version` writes each
// changeset as it is (.changeset/changelog.mjs), under `### Minor Changes` and `### Patch Changes`:
// a version made of several changesets would list several `#### Upgrading` tables and `#### Fixed`
// lists. This leaves one section per kind of change (`### Upgrading` with a single table,
// `### Added`, `### Changed`, `### Fixed`), in that order. Running it again changes nothing.
//
// Usage: node scripts/merge-changelog-sections.ts [CHANGELOG.md] (the `version` script of
// package.json, which the release workflow runs instead of `changeset version`)
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const houseOrder = ['Upgrading', 'Added', 'Changed', 'Fixed'];

/** The cells of a table row, trimmed: `| a | b |` is `['a', 'b']`. */
function tableCells(row: string): string[] {
  return row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** The header row of the table that ends `lines`, if `lines` ends with a table. */
function lastTableHeader(lines: readonly string[]): string | undefined {
  let index = lines.length - 1;
  while (index > 0 && lines[index - 1]!.startsWith('|')) {
    index--;
  }
  return lines[index]?.startsWith('|') ? lines[index] : undefined;
}

/** Removes the blank lines at both ends of a block. */
function trimBlankLines(block: readonly string[]): string[] {
  let start = 0;
  let end = block.length;
  while (start < end && block[start]!.trim() === '') {
    start++;
  }
  while (end > start && block[end - 1]!.trim() === '') {
    end--;
  }
  return block.slice(start, end);
}

/**
 * Joins the blocks of one section: a table that follows a table with the same header adds its
 * rows to it, and a list that follows a list continues it.
 */
function mergeBlocks(blocks: readonly (readonly string[])[]): string[] {
  const merged: string[] = [];
  for (const block of blocks.map(trimBlankLines).filter((lines) => lines.length > 0)) {
    const header = lastTableHeader(merged);
    const last = merged.at(-1);
    if (
      header !== undefined &&
      block[0]!.startsWith('|') &&
      tableCells(header).join('|') === tableCells(block[0]!).join('|') &&
      /^\|[\s|:-]+\|$/.test(block[1]?.trim() ?? '')
    ) {
      merged.push(...block.slice(2));
    } else if (last !== undefined && /^[-*] /.test(block[0]!) && /^([-*] | )/.test(last)) {
      merged.push(...block);
    } else {
      if (last !== undefined) {
        merged.push('');
      }
      merged.push(...block);
    }
  }
  return merged;
}

/** CHANGELOG.md with the sections of its newest version merged. */
export function mergeChangelogSections(changelog: string): string {
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => line.startsWith('## '));
  if (start === -1) {
    return changelog;
  }
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  const end = next === -1 ? lines.length : next;

  const preface: string[] = [];
  const sections = new Map<string, string[][]>();
  let current: string[] = preface;
  for (const line of lines.slice(start + 1, end)) {
    if (/^### (Major|Minor|Patch) Changes\s*$/.test(line)) {
      current = preface;
      continue;
    }
    const heading = /^#{3,4} (.+?)\s*$/.exec(line);
    if (heading) {
      current = [];
      const name = heading[1]!;
      sections.set(name, [...(sections.get(name) ?? []), current]);
      continue;
    }
    current.push(line);
  }

  const rank = (name: string) => {
    const index = houseOrder.indexOf(name);
    return index === -1 ? houseOrder.length : index;
  };
  const names = [...sections.keys()].sort((a, b) => rank(a) - rank(b));

  const version: string[] = [lines[start]!, ''];
  const intro = trimBlankLines(preface);
  if (intro.length > 0) {
    version.push(...intro, '');
  }
  for (const name of names) {
    const body = mergeBlocks(sections.get(name)!);
    if (body.length > 0) {
      version.push(`### ${name}`, '', ...body, '');
    }
  }

  return [...lines.slice(0, start), ...version, ...lines.slice(end)].join('\n');
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  const path = process.argv[2] ?? 'CHANGELOG.md';
  writeFileSync(path, mergeChangelogSections(readFileSync(path, 'utf8')));
}
