---
name: db-modules
description: Multi-file checklists for the database modules of @lilypad-studio/libs (sync strategies, PostgreSQL types, changelog and L2 format versions). Applies when working in src/cache, src/dbCache, src/dbGate, src/dbConfig or src/cli.
paths:
  - 'src/cache/**'
  - 'src/dbCache/**'
  - 'src/dbGate/**'
  - 'src/dbConfig/**'
  - 'src/cli/**'
user-invocable: false
---

Read the matching section of `docs/architecture.md` (and `docs/how-it-works.md` §4.6–4.11) before changing these modules. The changes below touch several files at once: miss one and the build, lint or tests may still pass.

## A new sync strategy

1. The type: a new member of the `LilypadDbTableSync` union in `src/dbConfig/LilypadDbConfig.ts` (next to `LilypadDbTableListenSync` / `LilypadDbTableChangelogSync`), exported from `src/entries/schema.ts`.
2. The validation: `assertSync` in `src/dbConfig/LilypadDbConfigValidation.ts` (the `assertOneOf` set of `strategy`, and the checks of its options).
3. The class: in `src/dbCache/sync/`, implementing `LilypadDbSyncStrategy` (`LilypadDbSyncTypes.ts`); `beforeRead()` is awaited inline by the cache.
4. The wiring: the `if/else` on `tableSync.strategy` in the constructor of `src/dbCache/LilypadDbCache.ts`, and the overrides of `LilypadDbCacheSyncOverrides` if it takes any.
5. The check: `lilypadSchemaCheckOptions` in `src/dbGate/LilypadDoctor.ts` (which triggers, channel or changelog the strategy needs from the database).
6. The init template: the `sync` comment of `src/cli/lilypadDbConfigTemplate.ts`.
7. The docs (`docs/architecture.md`, `docs/how-it-works.md` §4.10) and a changeset (`/write-changeset`).

## A new PostgreSQL type

`src/dbConfig/LilypadPgTypes.ts` is the only place that knows the PostgreSQL types: add it to `PG_TYPES` (with the column type postgres.js returns it as). A new column type also goes in `LilypadDbColumnValues` and `LILYPAD_DB_COLUMN_TYPES`. A spelling that `format_type` writes otherwise (a default modifier such as `numeric(10,0)`, an array syntax) is handled in `normalizeLilypadPgType`, and in `LilypadPgTypeOf` for the types. Test it in `LilypadPgTypes.test.ts` (plus an `@ts-expect-error` case in `LilypadDbConfig.test.ts` if the typing of the columns changes), and check what `format_type` writes for it on PostgreSQL (the shape spellings test of `LilypadDbGate.integration.test.ts`).

## Changing the changelog SQL

- Bump `LILYPAD_CHANGELOG_VERSION` in `src/dbGate/LilypadChangelog.ts` (written into the function COMMENT with `LILYPAD_CHANGELOG_VERSION_PREFIX`; `lilypad-doctor` compares it).
- Raise `LILYPAD_CHANGELOG_MIN_COMPATIBLE_VERSION` when an install of an older version no longer works with the new code (the schema check then reports an error instead of a warning).
- Update `LilypadChangelog.test.ts` and `LilypadSchemaCheck.test.ts`, then run `npm run test:integration` (Docker).
- The changeset tells users to reinstall the changelog SQL (an `#### Upgrading` row).

## Changing the shared (L2) entries

- Bump `SHARED_FORMAT_VERSION` in `src/cache/LilypadSharedLevel.ts`: it builds the `lilypad:<v>:` keys and the `{ lilypad: <v> }` envelope, so the instances of two versions never read each other's entries.
- Update the key literals (`lilypad:2:`) in `src/cache/LilypadCache.shared.test.ts` and `src/dbCache/LilypadDbCache.test.ts`.

<!-- verified against code: 2026-10-01 -->
