import { describe, it, expect } from 'vitest';
import { mergeChangelogSections } from './merge-changelog-sections';

/** A version as `changeset version` writes it, with .changeset/changelog.mjs. */
const written = `# Changelog

## 0.8.0

### Minor Changes

#### Upgrading

| Change   | What to do |
| -------- | ---------- |
| First    | Do this    |

#### Fixed

- Fix one
  continued

#### Upgrading

| Change | What to do |
| --- | --- |
| Second | Do that |

#### Added

- Feature

#### Fixed

- Fix two

### Patch Changes

#### Fixed

- Fix three

## 0.7.0

### Minor Changes

#### Upgrading

| Change | What to do |
| --- | --- |
| Old | Untouched |

#### Fixed

- Old fix
`;

const merged = `# Changelog

## 0.8.0

### Upgrading

| Change   | What to do |
| -------- | ---------- |
| First    | Do this    |
| Second | Do that |

### Added

- Feature

### Fixed

- Fix one
  continued
- Fix two
- Fix three

## 0.7.0

### Minor Changes

#### Upgrading

| Change | What to do |
| --- | --- |
| Old | Untouched |

#### Fixed

- Old fix
`;

describe('mergeChangelogSections', () => {
  it('should merge the sections of the newest version only, in the house order', () => {
    expect(mergeChangelogSections(written)).toBe(merged);
  });

  it('should change nothing when run again', () => {
    expect(mergeChangelogSections(merged)).toBe(merged);
  });

  it('should keep a table whose header differs, and text outside the sections', () => {
    const changelog = `## 1.0.0

### Patch Changes

A summary without a section.

#### Upgrading

| Change | What to do |
| --- | --- |
| A | B |

#### Upgrading

| Other | Header |
| --- | --- |
| C | D |
`;

    expect(mergeChangelogSections(changelog)).toBe(`## 1.0.0

A summary without a section.

### Upgrading

| Change | What to do |
| --- | --- |
| A | B |

| Other | Header |
| --- | --- |
| C | D |
`);
  });

  it('should leave a changelog without a version as it is', () => {
    expect(mergeChangelogSections('# Changelog\n')).toBe('# Changelog\n');
  });
});
