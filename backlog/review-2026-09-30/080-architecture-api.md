# Review the architecture and the public API as a whole

## Goal

Review the public surface and the module layering of the whole library as a senior reviewer/API designer and write the report into `backlog/review-2026-09-30/900-synthesis.md`, replacing the placeholder under `### 080-architecture-api`. This is a review only: change nothing else, not even the other sections of that file.

## Context

- Project: `@lilypad-studio/libs` 0.7.0, an internal TypeScript library used by Lilypad Studio's own apps (its audience is the studio's developers). ESM only, Node.js >= 22.12; every entry except `db` must also run in edge runtimes. Modules: in-memory cache with an optional shared level (L2), PostgreSQL gateway on postgres.js 3.4 (optional peer) with a database-backed cache synced by LISTEN/NOTIFY or a trigger-written changelog, logger, flow control, serializer, singletons, and the `lilypad-doctor` CLI. Repo rules: `CLAUDE.md` ("Public surface"); per-module invariants: `docs/architecture.md`.
- Baseline: commit `a3cfaf4`. If the scope changed since (`git diff a3cfaf4 --stat -- src/entries src/index.ts tsdown.config.ts typedoc.json`), say so at the top of the report and review the current code.
- Compatibility constraints: breaking changes to the public API, the config format (`lilypad.config.*`) and the CLI are acceptable when they clearly improve the design, provided each is recorded in a changeset `#### Upgrading` row (`/write-changeset`). Changelog SQL installed in databases: any change bumps `LILYPAD_CHANGELOG_VERSION` (5); raising `LILYPAD_CHANGELOG_MIN_COMPATIBLE_VERSION` (4) is allowed. L2 shared entries: any change bumps `SHARED_FORMAT_VERSION`. Every entry except `db` must stay edge-compatible. House conventions: exported classes keep the `Lilypad` prefix, named exports only, object types declared with `type`.
- Scope:
  - `src/entries/*.ts` (`cache`, `db`, `flow`, `logger`, `platform`, `schema`, `serializer`, `singleton`), `src/index.ts`, `tsdown.config.ts` (the entries), `typedoc.json` (`entryPoints`)
  - The exported declarations of every module reached from those entries: read signatures, option types, errors and doc comments, not the implementations (units 010-070 review those).
  - `README.md` and `docs/*.md` (`how-it-works.md`, `installing.md`, `nextjs-vercel.md`, `architecture.md`, `releasing.md`), only to check that the documented APIs, option names, defaults, units and examples match the code. No prose review.
- Interfaces: the eight subpaths of `package.json` `exports` plus the `lilypad-doctor` bin are the whole contract with the applications.
- Out of scope, covered by other tasks: implementation findings of each module (`review-2026-09-30/010-foundations`, `020-logger`, `030-cache-engine`, `040-db-config`, `050-db-gate`, `060-db-cache`, `070-schema-check-cli`), security (`review-2026-09-30/090-security`), the build and package checks as tooling (`review-2026-09-30/100-tooling-ci`).
- Leads to verify (hints from a quick survey, not conclusions):
  - Errors: eight classes, each extending `Error` directly, spread over `src/cache/LilypadCacheTypes.ts` (`LilypadCacheCooldownError`, `LilypadDisposedError`, which the gate also throws), `src/dbGate/LilypadDbSchema.ts`, `src/dbGate/LilypadSchemaCheck.ts` and `src/flow/LilypadFlowControl.ts`. Check `name`, `cause` support, whether a common base class or a `code` would help callers, and where `LilypadDisposedError` belongs.
  - Construction: a private constructor with static `create()` (the logger synchronous, the gate and `LilypadDbCache` async) vs plain `new` (`LilypadCache`, `LilypadFlowControl`, `LilypadSerializer`). Is the rule consistent and explained?
  - Units: milliseconds everywhere, but `LilypadSharedStore.set` takes a `ttl` in seconds (`src/platform/LilypadPlatform.ts`).
  - `platform` exports types only, while `runInBackground` / `runAfterResponse` stay internal. Would the adapters in `docs/nextjs-vercel.md` benefit from them?
  - `LilypadDbCache.create`: three overloads (a definition; `config` + key; a key of the gate's config), `table` as a definition or a key, `LilypadDbCacheSyncOverrides` merged over the definition's `sync`. Check readability and error messages for wrong calls.
  - Naming across modules: `LilypadCache` `getOrSet` vs `LilypadDbCache` `getOrFetch`; `sqlCreate`/`sqlUpdate`/`sqlDelete` on the cache vs `insert`/`update`/`delete` on the table; `invalidate` vs `delete` vs `expire`.
  - Layering: `src/dbConfig/` (edge) imports `src/dbGate/LilypadDbSchema.ts`; `src/cache/` holds database code (`LilypadDbCache.ts`, `dbCache/`, `dbSync/`) exported by `db`; `src/cache/dbCache/LilypadOwnWrites.ts` imports from `src/dbGate/`. Would a `src/db/` layout be clearer?
  - `db` re-exports `./schema` and `LilypadDisposedError` a second time. Check duplication and the TypeDoc output.
  - Types that leak internals through exported signatures (engine types, `LilypadCacheTypes.ts` members, postgres.js types in `LilypadDbGate`).
  - Docs drift: README option tables and examples vs the actual option names and defaults (e.g. `statementTimeout`, `listenHeartbeat`, `notifyChannel` default `cache_events`, `bulkSync`).

## Instructions

Objectives, in priority order:

1. A public API that is coherent across modules, hard to misuse, and documented as it behaves.
2. A module layout whose dependencies follow the entries (edge vs `db`) and that a new contributor can navigate. Breaking changes are welcome when they really simplify or improve the API without removing functionality, within the compatibility constraints above.

Categories: API consistency, naming, error model, type ergonomics, layering and dependencies, surface size (what is exported but shouldn't be, or missing), docs accuracy.

Read every entry file and the exported declarations they reach. Read implementations only to confirm a behavior the docs or the types promise. Run `npm run build` (publint, arethetypeswrong) and optionally `npm run docs:api` (output in the ignored `api-docs/`) if they help.

Rules:

- Report only issues you can point to: file, symbol, line, relevant snippet (or the doc file and section). Anchor on the symbol and snippet, since line numbers drift.
- Confidence for each finding: `confirmed` or `suspected` (say what would confirm it).
- Severity:
  - `blocker`: an API that makes correct use impossible or silently wrong, or documentation that leads to data loss
  - `recommended`: inconsistent or misleading API, docs that contradict the code, layering that causes real coupling
  - `minor`: naming, doc wording, style
- A concrete fix for every finding: the new signature, export list or doc text. Don't propose renames for their own sake.
- Group `minor` findings of the same kind into one entry.
- If the surface is sound, say so. Don't pad the report.

Report format: Markdown, with `####` sub-headings under the unit's `###` heading. Finding IDs: `API-<n>`:

1. Summary (5-10 lines) and the 3 most important actions.
2. Findings, by severity. Each: ID, severity, confidence, location, problem, fix.
3. Proposed breaking changes: what changes, why, impact, migration (each needs its changeset `Upgrading` row).
4. Tests to add (e.g. type tests with `@ts-expect-error`, entry tests).
5. Impact on other units: findings or proposed changes that touch code outside this scope, with the affected paths.
6. Checks run: commands and results, or why none ran.

## Done when

- The `### 080-architecture-api` section of `backlog/review-2026-09-30/900-synthesis.md` holds the report instead of the placeholder, with the six sections above; empty ones say "None".
- Every finding has an ID, severity, confidence, a location and a fix.
- `git status --porcelain` shows no change outside `backlog/`; build or test artifacts left by the checks are removed.
