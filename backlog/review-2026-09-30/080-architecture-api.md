# Review the architecture and the public API as a whole

## Goal

Review the public surface and the module layering of the whole library as a senior reviewer/API designer, report the findings in chat, then ask the user whether to apply the fixes now or queue them as focused fix tasks.

## Context

- Project: `@lilypad-studio/libs` 0.7.0, an internal TypeScript library used by Lilypad Studio's own apps (its audience is the studio's developers). ESM only, Node.js >= 22.12; every entry except `db` must also run in edge runtimes. Modules: in-memory cache with an optional shared level (L2), PostgreSQL gateway on postgres.js 3.4 (optional peer) with a database-backed cache synced by LISTEN/NOTIFY or a trigger-written changelog, logger, flow control, serializer, singletons, and the `lilypad-doctor` CLI. Repo rules: `CLAUDE.md` ("Public surface"); per-module invariants: `docs/architecture.md`.
- Baseline: commit `a3cfaf4`. If the scope changed since (`git diff a3cfaf4 --stat -- src/entries src/index.ts tsdown.config.ts typedoc.json`), say so at the top of the report and review the current code: earlier units may have applied fixes.
- Compatibility constraints: breaking changes to the public API, the config format (`lilypad.config.*`) and the CLI are acceptable when they clearly improve the design, provided each is recorded in a changeset `#### Upgrading` row (`/write-changeset`). Changelog SQL installed in databases: any change bumps `LILYPAD_CHANGELOG_VERSION` (5); raising `LILYPAD_CHANGELOG_MIN_COMPATIBLE_VERSION` (4) is allowed. L2 shared entries: any change bumps `SHARED_FORMAT_VERSION`. Every entry except `db` must stay edge-compatible. House conventions: exported classes keep the `Lilypad` prefix, named exports only, object types declared with `type`.
- Scope:
  - `src/entries/*.ts` (`cache`, `db`, `flow`, `logger`, `platform`, `schema`, `serializer`, `singleton`), `src/index.ts`, `tsdown.config.ts` (the entries), `typedoc.json` (`entryPoints`)
  - The exported declarations of every module reached from those entries: read signatures, option types, errors and doc comments, not the implementations (units 010-070 review those).
  - `README.md` and `docs/*.md` (`how-it-works.md`, `installing.md`, `nextjs-vercel.md`, `architecture.md`, `releasing.md`), only to check that the documented APIs, option names, defaults, units and examples match the code. No prose review.
- Interfaces: the eight subpaths of `package.json` `exports` plus the `lilypad-doctor` bin are the whole contract with the applications.
- Out of scope, covered by other tasks: implementation findings of each module (`review-2026-09-30/010-foundations`, `020-logger`, `030-cache-engine`, `040-db-config`, `050-db-gate`, `060-db-cache`, `070-schema-check-cli`), security (`review-2026-09-30/090-security`), the build and package checks as tooling (`review-2026-09-30/100-tooling-ci`).
- Leads to verify (hints from a quick survey, not conclusions):
  - Errors: eight classes, each extending `Error` directly, spread over `src/cache/LilypadCacheTypes.ts` (`LilypadCacheCooldownError`, `LilypadDisposedError`, which the gate also throws), `src/dbConfig/LilypadDbSchema.ts`, `src/dbGate/LilypadSchemaCheck.ts` and `src/flow/LilypadFlowControl.ts`. Check `name`, `cause` support, whether a common base class or a `code` would help callers, and where `LilypadDisposedError` belongs.
  - Construction: a private constructor with static `create()` (the logger synchronous, the gate and `LilypadDbCache` async) vs plain `new` (`LilypadCache`, `LilypadFlowControl`, `LilypadSerializer`). Is the rule consistent and explained?
  - Units: milliseconds everywhere, but `LilypadSharedStore.set` takes a `ttl` in seconds (`src/platform/LilypadPlatform.ts`).
  - `platform` exports types only, while `runInBackground` / `runAfterResponse` stay internal. Would the adapters in `docs/nextjs-vercel.md` benefit from them?
  - `LilypadDbCache.create`: three overloads (a definition; `config` + key; a key of the gate's config), `table` as a definition or a key, `LilypadDbCacheSyncOverrides` merged over the definition's `sync`. Check readability and error messages for wrong calls.
  - Naming across modules: `LilypadCache` `getOrSet` vs `LilypadDbCache` `getOrFetch`; `sqlCreate`/`sqlUpdate`/`sqlDelete` on the cache vs `insert`/`update`/`delete` on the table; `invalidate` vs `delete` vs `expire`.
  - Layering: the description types and the three database errors of `schema` moved to `src/dbConfig/LilypadDbSchema.ts` (`040-db-config`, CFG-11); `src/cache/` holds database code (`LilypadDbCache.ts`, `dbCache/`, `dbSync/`) exported by `db`; `src/cache/dbCache/LilypadOwnWrites.ts` imports from `src/dbGate/`. Would a `src/db/` layout be clearer?
  - `db` re-exports `./schema` and `LilypadDisposedError` a second time. Check duplication and the TypeDoc output.
  - Types that leak internals through exported signatures (engine types, `LilypadCacheTypes.ts` members, postgres.js types in `LilypadDbGate`).
  - Docs drift: README option tables and examples vs the actual option names and defaults (e.g. `statementTimeout`, `listenHeartbeat`, `notifyChannel` default `cache_events`, `bulkSync`).
- Fix tasks folder: `backlog/review-2026-09-30-fixes/080-architecture-api/`. Task format: `backlog/README.md`.

## Instructions

Objectives, in priority order:

1. A public API that is coherent across modules, hard to misuse, and documented as it behaves.
2. A module layout whose dependencies follow the entries (edge vs `db`) and that a new contributor can navigate. Breaking changes are welcome when they really simplify or improve the API without removing functionality, within the compatibility constraints above.

Categories: API consistency, naming, error model, type ergonomics, layering and dependencies, surface size (what is exported but shouldn't be, or missing), docs accuracy.

Read every entry file and the exported declarations they reach. Read implementations only to confirm a behavior the docs or the types promise. Run `npm run build` (publint, arethetypeswrong) and optionally `npm run docs:api` (output in the ignored `api-docs/`) if they help. Change nothing until the user has chosen below.

Rules:

- Report only issues you can point to: file, symbol, line, relevant snippet (or the doc file and section). Anchor on the symbol and snippet, since line numbers drift.
- Confidence for each finding: `confirmed` or `suspected` (say what would confirm it).
- Severity:
  - `blocker`: an API that makes correct use impossible or silently wrong, or documentation that leads to data loss
  - `recommended`: inconsistent or misleading API, docs that contradict the code, layering that causes real coupling
  - `minor`: naming, doc wording, style
- A concrete fix for every finding: the new signature, export list or doc text. Don't propose renames for their own sake.
- Mark a finding `breaking` if its fix changes an API, a format or a behavior that callers or users rely on, and `cross-unit` if its fix touches files outside this unit.
- Group `minor` findings of the same kind into one entry.
- If the surface is sound, say so. Don't pad the report.

Report, in chat. Finding IDs: `API-<n>`:

1. Summary (5-10 lines) and the 3 most important actions.
2. Findings, by severity. Each: ID, severity, confidence, `breaking`/`cross-unit` if they apply, location, problem, fix.
3. Tests to add.
4. Checks run: commands and results, or why none ran.

### Apply or queue

If there are no findings, skip to the closing summary. Otherwise ask the user, listing the finding IDs, with these options:

- **Apply now**: fix every listed finding in this task, in the same commit that deletes it.
- **Queue**: create fix tasks instead; change no source code.
- **Mix**: the user names the IDs to apply now; the rest are queued or, for `minor` ones, dropped.

Whatever the choice:

- `breaking` and `cross-unit` findings are applied only if the user names their IDs explicitly; otherwise they're queued.
- If you can't ask the user (you run as a subagent), stop here and report `needs decision` with the question, the options and the finding list; you'll be resumed with the answer.

Applying a finding: make the fix, and for a bug, add a test that reproduces it. A fix that changes user-facing behavior gets its changeset (`/write-changeset`), with a `#### Upgrading` row if it is `breaking`. Run the build and the tests covering the unit.

Queuing findings: one task per finding, or per group of findings that must change together, in the fix tasks folder, numbered `010`, `020`... after the highest number ever used there (`git log --all --name-only --format= -- backlog/review-2026-09-30-fixes/080-architecture-api`), following `backlog/README.md`:

- Context is self-contained: quote the finding ID, the location, the snippet and the proposed fix. This review leaves no other record.
- "Done when" is verifiable: for a bug, a test that reproduces it and now passes; otherwise a command or an observable behavior. Include `npm run check` (and `npm run test:integration` for database code), and the changeset when the fix changes user-facing behavior.
- `depends-on: [review-2026-09-30/900-integration]` on every task, so none runs before integration has reviewed the queue. Add other `depends-on` only for real dependencies between fix tasks, not mere ordering.
- A `breaking` finding gets `blocked: "needs approval: <the change, one line>"` (quoted: the value contains `: `), so nobody applies it unreviewed.
- `minor` findings: group them by kind into one or two tasks, or drop them with a reason in chat.

End with a short chat summary: applied (IDs, files changed, checks run), queued (IDs → task paths), dropped (IDs, reason).

## Done when

- The report is in chat, with the four sections above; empty ones say "None".
- Every finding has an ID, severity, confidence, a location and a fix.
- Every `blocker` and `recommended` finding is applied (with its test, for a bug), queued in the fix tasks folder, or dropped with a reason in chat.
- Every queued task follows `backlog/README.md`, has a checkable "Done when", and every `depends-on` target exists.
- If this task applied anything: the build and the tests covering the unit pass, and the files it changed are within the unit, its tests, its changeset, or findings the user explicitly named.
- If this task applied nothing: it changed no file outside `backlog/`.
- Build or test artifacts left by the checks are removed.
