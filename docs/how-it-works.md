# How @lilypad-studio/libs works

The [README](../README.md) tells you **what** each function does. This document explains **how** the library works inside, and why it is built that way. It starts with the general idea and then zooms in, one level at a time, down to single functions and single lines:

1. [The idea](#1-the-idea): the problem the library solves, in a few paragraphs.
2. [The map](#2-the-map): the modules, how they depend on each other, how the package is cut.
3. [The ideas that recur everywhere](#3-the-ideas-that-recur-everywhere): the handful of techniques you will meet in every file. Read this before the code.
4. [Module by module](#4-module-by-module): the internals of each module, from the simplest to the most complex.
5. [Line by line](#5-line-by-line-five-traces): five scenarios traced through the code, call by call.
6. [Glossary and where to go next](#6-glossary-and-where-to-go-next).

You can stop at any level. Levels 1 to 3 give you a correct mental model of the whole library; levels 4 and 5 are for when you need to change the code.

Links to source lines point to the code as it was when this document was last updated. If a line has moved, search for the function name.

---

## 1. The idea

A server application reads the same data from PostgreSQL again and again: the same user, the same product, the same configuration row, many times per second. Going to the database each time is slow and expensive. Keeping a copy in memory is fast, but raises three hard questions:

- **When is the copy wrong?** Another instance of the application, or a script, or an admin tool may change the row. The copy must learn about it.
- **What happens under concurrency?** A hundred requests may ask for the same missing key at once. A slow query may finish after a faster, newer one. Neither should corrupt the cache.
- **What happens on a serverless platform?** Instances start cold, are suspended as soon as the response is sent, cannot keep timers or connections, and run by the dozen in parallel.

`@lilypad-studio/libs` is mostly an answer to those three questions. Its centre is a **cache that stays correct**: it deduplicates concurrent fetches, orders every write so that an older result can never overwrite a newer one, and learns about database changes through a changelog table or `LISTEN/NOTIFY`. Everything else in the library either supports that cache or is a small, self-contained utility that came along:

```
            ┌──────────────────────────────────────────────────────────┐
  you  ───> │ LilypadDbCache    a cache of one table, kept in sync     │
            │ LilypadCache      the generic cache, public writes       │
            ├──────────────────────────────────────────────────────────┤
            │ LilypadCacheEngine the engine: TTL, single-flight, write  │
            │                   ordering, shared level, SWR            │
            ├───────────────────────────┬──────────────────────────────┤
            │ LilypadFlowControl        │ LilypadDbGate + changelog    │
            │ timeouts, single-flight   │ Postgres access, LISTEN,     │
            │                           │ change tracking              │
            ├───────────────────────────┴──────────────────────────────┤
            │ foundations: logger · platform · singleton registry      │
            └──────────────────────────────────────────────────────────┘
                   side utility, unrelated to the rest: LilypadSerializer
```

Two constraints shape every design decision:

1. **The library must never break its host.** It runs inside someone else's web server. A failing logger, a slow shared store, a dropped database connection or a callback that throws must degrade the library's service, never crash the process or block a response.
2. **The library must not depend on any hosting platform.** It knows nothing about Next.js or Vercel. It declares the few capabilities it can _use_ (background work, a shared cache, an invalidation hook) and the application plugs them in. Without them, it behaves as on a plain long-running Node.js server.

---

## 2. The map

### 2.1 Modules and dependencies

```
src/
├── singleton/LilypadSingleton.ts   process-wide registry on globalThis
├── platform/LilypadPlatform.ts     the platform contract + 4 helpers
├── internal/
│   ├── LilypadValidation.ts        checks of numeric options
│   ├── LilypadDisposedError.ts     thrown by a disposed cache or a closed gate
│   └── LilypadBackoff.ts           exponential backoff of retried operations
├── logger/
│   ├── LilypadLibLogger.ts         the minimal logger type + libLog()
│   ├── LilypadLogger.ts            the full logger (channels, components)
│   ├── LilypadLoggerComponent.ts   base class of the outputs
│   ├── formatLogValue.ts           util.inspect-like formatting, edge-safe
│   └── components/                 Console, JsonConsole, Discord
├── flow/LilypadFlowControl.ts      timeout, retries, rate limit, single-flight
├── serializer/LilypadSerializer.ts key mapping + default elision
├── cache/
│   ├── LilypadCacheTypes.ts        the public types of the caches
│   ├── LilypadCacheEngine.ts       the engine of both caches (internal, composed by both)
│   ├── LilypadReadFlights.ts       the reads in flight that a new read may join
│   ├── LilypadSharedLevel.ts       the shared level (L2): keys, envelopes, locks
│   └── LilypadCache.ts             the generic cache: the engine with public writes
├── dbCache/                        (Node.js only, entry `db`)
│   ├── LilypadDbCache.ts           the table cache (≈950 lines)
│   ├── LilypadDbMembers.ts         the keys of the rows of the table, for getAll
│   ├── LilypadOwnWrites.ts         the writes of this instance, recognized when they come back
│   ├── LilypadEagerRefresh.ts      the batched re-reads of notified keys
│   └── sync/
│       ├── LilypadDbSyncTypes.ts   sync options, the strategy and host interfaces
│       ├── LilypadListenSync.ts    the `listen` strategy
│       ├── LilypadNotificationRouter.ts one listener per gate and channel, for all its caches
│       └── LilypadChangelogSync.ts the `changelog` strategy
├── dbConfig/
│   ├── LilypadDbConfig.ts          defineLilypadDb / defineLilypadTable: the database configs
│   ├── LilypadDbConfigValidation.ts the checks of a config (never of the database)
│   └── LilypadDbHooks.ts           bindLilypadDbHooks: the functions the application binds to a config
├── dbGate/
│   ├── loadLilypadDbConfig.ts      finds and imports a config file (Node.js only)
│   ├── LilypadDbGate.ts            postgres.js wrapper, table handles, LISTEN
│   ├── LilypadDbTable.ts           the CRUD helpers of one table
│   ├── LilypadListenHeartbeat.ts   is the LISTEN connection still delivering?
│   ├── LilypadChangelog.ts         changelog SQL + the cursor read
│   ├── LilypadChangelogReader.ts   one batched read for all caches of a gate
│   ├── LilypadSchemaTypes.ts       the options, problems and result of the check
│   ├── LilypadSchemaFacts.ts       reads the catalogs
│   ├── LilypadSchemaShape.ts       compares a table with its description (pure)
│   ├── LilypadSchemaPruning.ts     how the changelog is pruned (pure)
│   ├── LilypadSchemaCheck.ts       evaluates the facts: triggers, changelog, shapes
│   └── LilypadDoctor.ts            the check of a config (lilypad-doctor)
├── cli/                            the lilypad-doctor command
├── entries/*.ts                    the public subpaths
└── index.ts                        the root entry (everything but db)
```

Who uses whom (arrows point to what is used):

```
LilypadCache ───extends──┐
                         ├──> LilypadCacheEngine ──uses──> LilypadFlowControl, LilypadSharedLevel,
LilypadDbCache ─extends──┘                               platform helpers (runInBackground, ...)
   │
   ├──uses──> a sync strategy: LilypadListenSync | LilypadChangelogSync | lilypadNoSync
   │             │                   │
   │             │                   └──uses──> LilypadChangelogReader ──> readLilypadChangesBatch
   │             └──uses──> LilypadDbGate (addListener, isListenHealthy)
   ├──reads──> a table definition of a config (defineLilypadDb)
   └──uses──> LilypadDbGate ──uses──> postgres.js, node:crypto, LilypadListenHeartbeat

lilypad-doctor ──loads──> a config file ──> runLilypadDoctor ──> checkLilypadSchema
                                             (facts of the catalogs ──> evaluateLilypadSchema)

every module ──logs through──> libLog(logger, level, source, message, detail?)
LilypadLogger, LilypadDbGate, LilypadDbCache ──register in──> the singleton registry
```

Three observations help when reading the code:

- **The two caches share one engine, by composition.** `LilypadCacheEngine` holds the hard concurrency logic, and is internal: its methods are public but it is not exported, and it checks nothing about disposal (it only ignores writes once disposed). `LilypadCache` and `LilypadDbCache` each hold one in a private field, and expose what fits them, after checking that they are not disposed: `LilypadCache` exposes the writes (`set`, `getOrSet`, ...) and owns the bulk sync; `LilypadDbCache` exposes none of them, so that its values always come from its table (a value written with a public `set` would otherwise be renewed past its TTL as if the database had returned it). The engine tells its owner what happens through hooks (`onValueStored`, `onEntriesIncomplete`, `hasReadInFlight`).
- **`LilypadDbCache` delegates how it follows the table to a strategy object.** The cache keeps the data logic (`applyChange`, `applyTruncate`, members, renewal); the strategy decides _when_ changes arrive and _whether_ the cache can trust that it sees them all. The two talk through small interfaces ([`LilypadDbSyncHost`, `LilypadDbSyncStrategy`](../src/dbCache/sync/LilypadDbSyncTypes.ts)).
- **Nothing in the lower layers knows about the upper ones.** `LilypadFlowControl` knows nothing about caches; `LilypadDbGate` knows nothing about caching; `LilypadCacheEngine` knows nothing about databases.

### 2.2 How the package is cut

The package is published as several **subpath entries**, one per module ([src/entries/](../src/entries/)): `@lilypad-studio/libs/logger`, `/cache`, `/flow`, `/serializer`, `/singleton`, `/platform`, `/schema` (the database configs) and `/db`. Each entry file is only a list of re-exports: a class that is not listed there does not ship. Everything is exported by name (no default exports).

The root entry [src/index.ts](../src/index.ts) re-exports every entry **except `db`**. The reason is the edge runtime (Next.js middleware, Vercel Edge Functions): it has no TCP sockets and no `node:*` modules. `db` needs both (postgres.js, and `node:crypto` for hashing connection strings), so it is kept out of the root, and importing `@lilypad-studio/libs` stays edge-safe. `postgres` is an optional **peer** dependency: an application that uses only the edge modules does not install it.

This rule is enforced several times:

- [src/entries/entries.test.ts](../src/entries/entries.test.ts) reads the source of each entry (every file of `src/entries/`, and `src/index.ts`), follows every _run-time_ import (static imports and re-exports, side-effect imports, `import()` of a string; `import type` is skipped, since it disappears at build time) and fails if an edge entry reaches any external module, or if it meets an import it cannot resolve. It also checks that every folder of `src/` is listed as edge-compatible or Node.js-only in [edge.config.ts](../edge.config.ts). The `db` entry may reach exactly `postgres`, `node:crypto`, and `node:fs`, `node:path` and `node:url` (the loader of config files). `/schema` is an edge entry: a config file imports only it, so that the application (edge code included) and the command can both load it.
- [tsconfig.edge.json](../tsconfig.edge.json) typechecks the root entry and every entry except `db` without the types of Node.js: its `lib` is `webworker`, which declares the web APIs of the edge runtimes (`fetch`, `AbortController`, the timers, `console`, `crypto`) and nothing of Node.js or of the DOM, so that `process` or `Buffer` in an edge module fails `npm run typecheck`. The lint names the import in the editor: `@typescript-eslint/no-restricted-imports` forbids `node:*`, `postgres` and the gate in the edge modules, and `no-restricted-syntax` forbids `import()` there (the typecheck resolves `import('postgres')`, since postgres.js has its types).
- The `edge` project of [vitest.config.ts](../vitest.config.ts) runs the tests of the edge modules a second time inside the `edge-runtime` environment. That environment adds the web APIs of the edge runtimes but keeps the Node.js globals, so [vitest.edge-setup.ts](../vitest.edge-setup.ts) removes them (`process`, `Buffer`, `setImmediate`...). This is why the cache uses `globalThis.crypto.randomUUID()` and never `node:crypto`.

The build ([tsdown.config.ts](../tsdown.config.ts)) bundles each entry as ESM (`.mjs`) with type declarations and source maps; Node.js 22.12+ also loads them with `require()`. Rolldown puts the modules shared by several entries in common chunks (`dist/chunks/`), so that there is **one copy of each class** no matter which subpath imported it (a second format would bring a second copy). Without that, `error instanceof LilypadCacheCooldownError` could fail when the error was thrown by a class from another bundle copy.

`dist/` is not committed: the release workflow builds it and publishes the package to GitHub Packages ([releasing.md](releasing.md)). The build also writes the `exports` and the `bin` of `package.json` from the entries, and checks the package with publint and arethetypeswrong; CI checks that the committed `package.json` matches the entries, and installs the packed package on the lowest supported Node.js version to load every entry with `import` and `require()`.

### 2.3 The life of an instance

Every stateful class follows the same lifecycle:

```
create / new ──> use ──> dispose() / close()
     │                        │
     └─ singleton? ──> registry (globalThis) <── release() removes it here
```

- `LilypadLogger`, `LilypadDbGate` and `LilypadDbCache` have **private constructors**; you get an instance from a static `create()`. That gives the class one place to decide whether to build a new instance or return a registered singleton, and (for the async ones) to do async setup such as starting `LISTEN` before handing out the instance.
- `LilypadCache`, `LilypadFlowControl` and `LilypadSerializer` use plain `new`: they need no async setup and are not singletons.
- `dispose()` (caches) and `close()` (gate) release resources and call the `release` function the singleton helper gave them, so that the next `create()` builds a fresh instance. After `dispose()`, every public method of a cache throws, except `dispose()` itself, which can be called again.

---

## 3. The ideas that recur everywhere

These are the patterns you will meet in almost every file. Once you recognise them, most of the code reads as variations on them.

### 3.1 Never crash the host: background work without unhandled rejections

In Node.js, a promise that rejects with no handler attached terminates the process (by default since Node 15). The library starts a lot of work that nobody awaits: log messages, writes to the shared store, background refreshes, invalidation events, listener callbacks, heartbeats. Every one of those goes through a helper that attaches an error handler **before** anything else can happen:

| Helper                                                 | Where                                                    | What it guarantees                                                                                        |
| ------------------------------------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `libLog(logger, level, source, message, detail?)`      | [LilypadLibLogger.ts](../src/logger/LilypadLibLogger.ts) | Calls `logger[level]` if it exists; swallows a sync throw; attaches a `.catch` if the result is a promise |
| `runInBackground(platform, task, onError)`             | [LilypadPlatform.ts](../src/platform/LilypadPlatform.ts) | `task.catch(onError)` first, then hands the _handled_ promise to `platform.background`                    |
| `runAfterResponse(platform, work, onError)`            | [LilypadPlatform.ts](../src/platform/LilypadPlatform.ts) | Same, for work that should start after the response                                                       |
| `sharedStoreOperation(op, fallback, timeout, onError)` | [LilypadPlatform.ts](../src/platform/LilypadPlatform.ts) | Races the operation against a timeout; any failure resolves to `fallback`                                 |
| `runCallbackSafely(channel, id, cb)`                   | [LilypadDbGate.ts](../src/dbGate/LilypadDbGate.ts)       | `Promise.resolve().then(cb).catch(log)`: catches both sync throws and rejections of listener callbacks    |
| the logger's channel methods                           | [LilypadLogger.ts](../src/logger/LilypadLogger.ts)       | Never reject: component errors go to `errorLogging`, then to `console.error`                              |

Notice the detail in `runInBackground`: `platform.background` itself may throw (Next.js `after()` throws outside a request). The `try/catch` around it reports that error, but the task **still runs**, only without the "keep the instance alive" guarantee. The same fallback exists in `runAfterResponse`: if `afterResponse` throws, the work is started immediately instead, and only once, even if `afterResponse` had scheduled it before throwing.

ESLint enforces the other half of the rule: `@typescript-eslint/no-floating-promises` is an error, so every promise in the code is either awaited, returned, or explicitly marked with `void` after its errors were handled.

### 3.2 The platform is optional

`LilypadPlatform` ([LilypadPlatform.ts](../src/platform/LilypadPlatform.ts)) has four optional fields:

- `background(task)`: keep the instance alive until `task` settles (Vercel `waitUntil`, Next.js `after`);
- `afterResponse(work)`: run `work` after the response is sent;
- `shared`: a key-value store shared by all instances (the Vercel Runtime Cache fits it as is);
- `onInvalidate(event)`: tell the application that cached data changed (e.g. to call `revalidateTag`).

The code always reads them with optional chaining (`platform?.background?.(...)`). When one is missing, the library does the natural thing for a long-running server: run the work now, keep no shared level, send no event. The library never imports `next/*` or `@vercel/*`; [docs/nextjs-vercel.md](nextjs-vercel.md) shows the ten-line adapter the application writes.

### 3.3 `undefined` versus `null`

In every cache method:

- `undefined` means **"I don't know"**: not cached, or expired.
- `null` means **"I know it does not exist"**: for a table cache, no row has that primary key.

This is what lets the cache remember negative results, so that repeated lookups of a missing id stop reaching the database. Internally, `LilypadCachedValueType<V>` is `V | null`, and `undefined` never gets stored. Some code relies on the distinction in subtle ways: a `DELETE` read from the changelog is cached as `null` rather than removing the entry (see [3.4](#34-tickets-ordering-asynchronous-writes)), and `LilypadDbCache` uses `null` to remove a key from its list of table rows ([LilypadDbCache.ts](../src/dbCache/LilypadDbCache.ts)).

### 3.4 Tickets: ordering asynchronous writes

This is the most important idea in the library, and the one that makes the cache code look more complicated than a textbook cache.

**The problem.** A read of the source is asynchronous: it starts at one moment, and its result arrives later. Meanwhile, anything can happen to the same key: a `set`, an `invalidate`, a database notification, another fetch. If the slow read simply stored its result when it arrived, it could overwrite a newer value with an older one:

```
time ─────────────────────────────────────────────────────────────>
fetch("a")   starts ─────── reads v1 from DB ─────────────── stores v1   ✗ overwrites v2
set("a", v2)                          stores v2
```

**The solution.** A counter, `lastTicket`, that only goes up ([LilypadCacheEngine.ts](../src/cache/LilypadCacheEngine.ts), `nextTicket()`). Every entry carries the ticket of the write that produced it. Then:

- A **synchronous write** (`set`, `expire`, ...) takes a new ticket at the moment it writes. It always wins.
- An **asynchronous read** takes its ticket **when it starts**, with `beginRead()`. When its result arrives, it stores it through `setIfNewer`, which refuses to store unless the read's ticket is **greater** than the key's current ticket.

```
                      ticket
fetch("a")   starts:    4  ──────────────────────── setIfNewer(ticket 4): 4 <= 5 → discarded ✓
set("a", v2)                    entry.ticket = 5
```

The caller of the slow fetch still receives the value it fetched; it is just not cached. "The key's current ticket" is computed by `currentTicket(normalizedKey)`:

```ts
const entry = this.store.get(normalizedKey);
if (entry) return entry.ticket; // the key has an entry
return Math.max(this.ticketFloor, this.fences.get(normalizedKey) ?? 0); // it has none
```

The second line covers a subtle case: what if the key has **no entry** at all? Then there is no entry ticket to compare with, and two mechanisms fill the gap:

- **`ticketFloor`**: a threshold for every missing key. It is raised when a bulk sync completes (the sync saw the whole source, so a read that started before it is older than what the sync knows) and by `expireEverything()` (the source may have changed in any way).
- **`fences`**: a per-key threshold, set whenever a key **loses its ordering information while a read of it is in flight**. Two cases:
  - a key with no entry is expired: `expireNormalized` sets a fence with a new ticket, since the read may have queried the database before the change;
  - an entry is **removed** (by `delete`, `clear`, `purgeExpired`, `cleanupOnAccess` or a `maxEntries` eviction): `dropEntry` keeps the ticket of the removed entry as the fence. Without it, a read that started before the entry was last written or invalidated would find no entry and no fence once the entry is gone, and would store its older value. This is how an invalidation followed by a purge used to let a pre-change row back into the cache.

  A fence is removed as soon as the key gets an entry (the entry's ticket then does the job) or when no read of the key is in flight any more (`purgeExpired`).

Three consequences worth remembering:

- **Every code path that reads the source and stores the result must go through `beginRead()`.** That is why `setIfNewer` and `storeFetched` are `private`: subclasses can only reach them through the `LilypadCacheRead` object that `beginRead()` returns (`read.store`, `read.storeFetched`). `LilypadDbCache` uses it for single-row fetches, batched fetches and table loads.
- **Expiring an entry takes a new ticket too**. So "invalidate this key" also means "discard any read of this key that is already running", which is exactly what a change notification needs.
- **Removing an entry never lowers the key's ticket** while a read is in flight: the fence takes over.

### 3.5 `expirationTime: 0` means "invalidated"

An entry expires when `Date.now() >= entry.expirationTime` (`isLilypadEntryStale`, [LilypadCacheEngine.ts](../src/cache/LilypadCacheEngine.ts)). Invalidation does not remove the entry: it sets `expirationTime` to `0` and records `invalidatedAt`. One value encodes several rules at once:

- The entry is expired, so `get` returns `undefined` and `getOrSet` fetches again.
- It is **never served stale**: the stale window test is `now < staleUntil(entry, staleWindow)`, which is `0` for an expiration time of `0`, whatever the window (`0 + window` alone would pass with a window longer than the time since the epoch).
- It **keeps its value**, which remains available to `onError: { fallback: 'stale' }` if the next fetch fails.
- `LilypadDbCache.renew` refuses to extend it ([LilypadDbCache.ts](../src/dbCache/LilypadDbCache.ts)).
- `invalidatedAt` lets `adoptShared` refuse copies from the shared level that were produced before the invalidation ([LilypadCacheEngine.ts](../src/cache/LilypadCacheEngine.ts)).

### 3.6 Keys are compared by their string form

Keys can be `string | number`, but the store is a `Map<string, entry>` keyed by `normalizeKey(key) = String(key)`. So `get(7)` and `get('7')` read the same entry. This matters for databases: a notification or a changelog row carries the primary key as text (`'7'`), while the application uses numbers. Each entry keeps the **original** key (`entry.key`), so that `entries()` can return keys with the type they were stored with. `LilypadDbCache.resolveNotifiedKey` ([LilypadDbCache.ts](../src/dbCache/LilypadDbCache.ts)) turns a text id back into the right type.

Inside the engine, you will see pairs of methods such as `delete`/`removeEntry` and `expire`/`expireNormalized`: the public one takes a key, the private one takes an already normalized string, which is what internal loops have. The disposal checks live in the caches that own the engine, so the engine calls its own methods freely.

### 3.7 Single-flight everywhere

"Single-flight" means: while an operation for some identifier is running, later callers join it instead of starting another one. The library applies it at every level:

| What                    | Identifier                                                      | Where                                                        |
| ----------------------- | --------------------------------------------------------------- | ------------------------------------------------------------ |
| `getOrSet` fetches      | each key, if the fetch started after the last change of the key | `LilypadCacheEngine.fetches` (`LilypadReadFlights`)          |
| bulk syncs              | the cache, if the sync started after the last forced one        | `LilypadCache.bulkSyncs` (`LilypadReadFlights`)              |
| async singletons        | the registry key                                                | the promise stored in the registry                           |
| `LISTEN` on a channel   | the channel                                                     | `ChannelListener.ready`                                      |
| batched row fetches     | each key, if the query started after the last change of the key | `LilypadDbCache.rowFetches` (`LilypadReadFlights`)           |
| notifications of a gate | the channel                                                     | `LilypadNotificationRouter` (one listener, one `JSON.parse`) |
| `refresh(key)`          | each key                                                        | `LilypadDbCache.refreshes` (plus one queued)                 |
| changelog reads         | the reader                                                      | `LilypadChangelogReader.current` (plus one queued)           |

The recurring trick is to **store the promise itself** in a map, synchronously, before any `await`, and to remove it when it settles, with a guard like `if (map.get(id) === promise) map.delete(id)` so that a newer promise registered meanwhile is not removed by mistake.

Two of them (`refresh` and the changelog reader) add a **queued** second operation. Joining a read that is already running is not always enough: that read may have queried the database _before_ the change the new caller wants to see. So a call that arrives while a query runs waits for one more query, and every caller arriving after that shares the queued one.

### 3.8 Retries back off

Two operations of `LilypadDbCache` can fail and must be retried later, but not at every read: starting a lazy `LISTEN`, and reading the changelog. Each keeps a `LilypadBackoff` ([LilypadBackoff.ts](../src/internal/LilypadBackoff.ts)): `fail()` schedules the next attempt `base × 2^(failures-1)` later (up to one minute, unless the base itself is longer), `succeed()` resets it, and `ready()` tells whether an attempt may run. It reads the monotonic clock (`performance.now()`) itself: with `Date.now()`, a step back of the system clock would postpone the retry by as much. A database outage therefore does not add a failing query to every request.

---

## 4. Module by module

From the simplest to the most complex. Each section starts with what the module is for, then how it works.

### 4.1 The singleton registry

[src/singleton/LilypadSingleton.ts](../src/singleton/LilypadSingleton.ts), 172 lines.

**Purpose.** In Next.js development, modules are re-evaluated on every hot reload, so a module-level `const gate = ...` would open a new connection pool at every save. And an application can end up with two copies of the library in different bundles. A registry stored on `globalThis` survives both.

**How.**

- The first lines: the two maps live on `globalThis.__lilypadSingletonMap` and `globalThis.__lilypadSingletonSignatureMap` (typed with a local cast rather than `declare global`, which the declarations of the package would add to the global types of the applications), created with `??=` so the first copy of the library creates them and every later copy reuses them. The signatures are in a _separate_ map so that older bundles, which only know the first map, can still share it.
- `getLilypadSingletonInstance`: if registered, return it; otherwise create, register, return. If the registered value is a `Promise`, an async creation is in progress, and a sync caller cannot wait for it, so it throws.
- `getLilypadSingletonInstanceAsync` is the interesting one. It stores the **creation promise** in the map right away (line 86). A concurrent caller finds the promise and returns it; since the function is `async`, returning a promise adopts it, so every caller awaits the same creation. When the creation resolves, the promise is replaced by the instance; if it rejects, the entry is removed (line 100), so the next call retries. Both steps first check `singletonMap.get(identifier) === instancePromise`, in case someone removed or replaced the entry meanwhile.
- **Signatures** (`checkSignature`, [line 29](../src/singleton/LilypadSingleton.ts)): a later call with the same identifier but different options gets the existing instance, and its options are silently ignored. To make this visible, each `create()` passes a string describing its important options. The first one is stored; a different one triggers `onMismatch` (a warning). `LilypadDbGate` hashes its signature with SHA-256, because connection strings contain passwords and the map is global.
- `createLilypadSingletonAble` and `createLilypadSingletonAbleAsync` are the shared bodies of the `create()` methods. They prefix the identifier with the class name and a registry version (`LilypadDbGate@1:main`, built by `lilypadSingletonRegistryKey`), so that a gate and a cache can both be called `main`, and so that two copies of the library with incompatible instances never exchange them, and pass the factory a **release function** (`releaseFor`, [line 118](../src/singleton/LilypadSingleton.ts)). The instance calls it in `close()`/`dispose()`. It removes the registry entry once: calling it again does nothing, so it can never remove a newer instance registered under the same identifier since. For an instance that is not a singleton, it is a no-op.

### 4.2 The platform helpers

[src/platform/LilypadPlatform.ts](../src/platform/LilypadPlatform.ts), 143 lines. Section [3.1](#31-never-crash-the-host-background-work-without-unhandled-rejections) covered `runInBackground` and `runAfterResponse`. The other two:

- `sharedStoreOperation`: `Promise.race` between the operation and a timer that rejects after `timeout` ms. Any error, including the timeout, calls `onError` and resolves to `fallback`. The `finally` clears the timer so it does not keep Node.js alive. This is how "the shared store is never required to answer" is implemented: a read that fails looks exactly like a miss.
- `toTtlSeconds`: the library works in milliseconds, but the Vercel Runtime Cache takes TTLs in seconds. It rounds up, with a minimum of 1 s, so that a short TTL never becomes `0` (which a store could read as "forever"). A value that is not finite gives 1 s too: an early expiry is only a miss.

The options of every class are checked by `assertNumberOption` ([LilypadValidation.ts](../src/internal/LilypadValidation.ts)): a duration must be a finite number (positive, or non-negative where `0` means "disabled"), a size a positive integer. Without it, a `NaN` slips through every comparison silently: `now - last < NaN` is always false, so a `pollInterval` of `NaN` would read the changelog at every request.

### 4.3 Logging

There are two different things here, and it helps to keep them apart:

- **`LilypadLibLogger`**, the logger the _other modules_ accept: any object with some of the methods `error`, `warn`, `info`, `debug`. `console` qualifies, so does pino, so does a `LilypadLogger`.
- **`LilypadLogger`**, a full logger you _can_ use in your application, with named channels and pluggable outputs.

#### libLog

[LilypadLibLogger.ts](../src/logger/LilypadLibLogger.ts). Every module logs through it, always as `libLog(this.logger, 'error', this.name, 'message', error)`. The argument after the level is the source: the instance name (or the class name, before an instance exists), so logs from several caches can be told apart. The function looks up `logger[level]`, returns if it is missing, and calls it with `method.call(logger, message, meta)` (so that `this` is right for class-based loggers), where `meta` is `{ source, error }` for an `Error` and `{ source, detail }` for any other value. If the result looks like a promise, it attaches an empty `.catch`. `lilypadPinoLogger(pino)` adapts pino, which takes the fields first: it calls `pino[level]({ source, err, detail }, message)`. A logger can therefore be missing, partial, throwing or rejecting, and the module never notices.

#### LilypadLogger

[LilypadLogger.ts](../src/logger/LilypadLogger.ts), 340 lines.

**The shape.** You choose channel names (`'error' | 'warn' | 'info' | 'debug'` by default), and each becomes a method: `logger.info(...)`. TypeScript cannot add methods to a class from a type parameter, so the class is `LilypadLogger<T>` and the type you use is `LilypadLoggerType<T> = LilypadLogger<T> & ChannelMethods<T>`; `create()` returns the latter.

**Construction**:

1. Rejects channel names that would overwrite a property of the logger (line 152). `key in this` catches inherited names such as `constructor` or `toString`; the fields are listed by hand because, depending on the compilation target, class fields may not exist yet at that point of the constructor. `then` is reserved because an object with a `then` method is a "thenable": returning the logger from an `async` function would call it instead of resolving to the logger.
2. Copies the component arrays (so that `register()` does not mutate the caller's arrays).
3. For each channel, builds two closures and assigns the second one as a method of the instance (line 245):
   - `send(message, context, fromErrorLogging)` builds a `LilypadLogRecord` (formatted message, raw parts, timestamp, logger name, context, and the name, message and stack of the `Error` parts, read by `lilypadErrorSummary`, which never throws), with the values of the redacted keys (the `redact` option, by default `LILYPAD_DEFAULT_REDACTED_KEYS`) replaced in the message and in a copy of the context. It calls every component's `write()` with `Promise.allSettled`, so that one failing component neither stops the others nor hides their errors, and passes each failure to `reportComponentError` (to `console.error` only for a message logged by `errorLogging`: `fromErrorLogging`). The formatting itself is inside the `try`, because even formatting must never make the promise reject.
   - `logFn(...message)` (line 233) is the channel method. It reads `context()` **synchronously**, before any `await`, so that an `AsyncLocalStorage` store of the caller's request is still active. It adds the task to `_pending` (for `flush()`), and to `#reports` while `errorLogging` runs synchronously (below), hands it to `runInBackground` (for `platform.background`), and returns nothing.

`reportComponentError` tries `errorLogging` (which may be synchronous or async), and falls back to `console.error` if there is none or if it fails too. This is the one place where the library writes to the console on its own, because there is nowhere else left to report. `errorLogging` is wrapped by `report`, which sets `#reports` to a fresh array while it runs synchronously: the messages it logs on the same logger are marked (`fromErrorLogging`, so that a failing component cannot loop through it) and collected, and the report waits for them.

`flush()` is one `await Promise.all(_pending)`, which reads the set when it is called: a message logged later does not hold it, so a steady stream of messages cannot keep it pending forever. The messages `errorLogging` logs synchronously about a failure are still waited for (not those it logs after an `await`), since the message that failed waits for its report, and the report for them.

#### Components

[LilypadLoggerComponent.ts](../src/logger/LilypadLoggerComponent.ts). A component has one extension point, the abstract `write(record)`, and a helper, `formatRecord(record)`, which formats a record as `<ISO time> - [name] [TYPE]: <message> <context JSON>`:

- `LilypadConsoleLogger` writes `formatRecord(record)` to `console.error`/`warn`/`log` by channel name;
- `LilypadJsonConsoleLogger` writes one JSON object per line, with the context fields at the top level and the `Error` parts under `errors`;
- `LilypadDiscordLogger` queues `formatRecord(record)` (below).

`safeJson` is `JSON.stringify` over `toLogJson` (below), without redaction (the context is already redacted), and returns `"[Unserializable]"` if it still throws.

#### formatLogValue

[formatLogValue.ts](../src/logger/formatLogValue.ts). Node's `util.inspect` is not available in edge runtimes, so this is a small re-implementation. One walker, `walk`, normalizes a value into a small tree (strings, scalars, markers such as `[Circular]` or `[Redacted]`, dates, arrays, maps, sets, objects, errors); two renderers turn that tree into the two outputs: `formatLogValue` (the text of a message) and `toLogJson` (the JSON-safe, redacted copy of the context, and the JSON of `LilypadJsonConsoleLogger`). The walker carries a `depth` (the text form abbreviates beyond 4 levels to `[Object]`/`[Array]`, the JSON form beyond 64), a `seen` set for cycles, and the set of redacted keys (compared ignoring case, `-` and `_`), whose values become `[Redacted]`. In JSON mode it follows `toJSON` as `JSON.stringify` would, then redacts what it returns, so that a key cannot reach the JSON output unredacted through `toJSON`. Top-level strings are printed as is. The `seen` set is emptied on the way back up (`finally { seen.delete(value) }`), so an object that appears twice _side by side_ is printed twice, and only a real cycle prints `[Circular]`. Errors print their stack, then their own enumerable properties (this is how the `code` and `detail` of a Postgres error show up), then `[cause]:` recursively. Each property read is in its own `try`, because a getter can throw, including the `name`, `message`, `stack` and `cause` of an error (a failing `Error.prepareStackTrace` throws from `stack`). A typed array (a `Buffer`) is read by index, like an array: listing the keys of a large one would take seconds.

#### LilypadDiscordLogger

[DiscordLogger.ts](../src/logger/components/DiscordLogger.ts), 252 lines. Posting one HTTP request per log line would hit Discord's rate limit immediately, so the component is a small queue with batching:

- `write()` formats the record and `enqueue()` returns a promise that is resolved or rejected **later**, when the batch containing the message is sent. It pushes `{ content, resolve, reject }` onto the queue, drops the oldest messages beyond `maxQueueSize` (resolving them, since rejecting 100 dropped messages would flood `errorLogging`), and kicks `flush()`.
- `flush()` is guarded by a `flushing` flag, so only one loop runs. The loop waits until `nextRequestAt`, takes a batch and sends it, until the queue is empty.
- `takeBatch()` first prepends a notice if messages were dropped, then takes as many messages as fit in Discord's 2000 characters (always at least one).
- `sendBatch()` posts, sets `nextRequestAt = now + minRequestInterval`, cancels the unread response body (otherwise the connection stays busy until garbage collection), retries a `429` after `retry-after` (unless it is longer than 30 s: the batch then fails at once, instead of holding the queue and `logger.flush()`), and finally resolves the messages of the batch. On a failure, it rejects only one of them, with an error that counts the messages lost and has the original error as `cause`: it flows back through the logger to `errorLogging` once per batch, not once per message.
- `post()` sets `allowed_mentions: { parse: [] }` so that a logged `@everyone` pings no one, and a 5 s `AbortSignal.timeout`.

### 4.4 LilypadFlowControl

[src/flow/LilypadFlowControl.ts](../src/flow/LilypadFlowControl.ts). Four independent tools, composed by `executeFn`. The constructor checks its numeric options with `assertNumberOption` (a `NaN` timeout would make every call time out at once). The class is **not generic**: each method takes the type of its own `fn`, so one instance can run executions of different types (the cache runs table loads and key queries through the same bulk flow control).

- **`executeWithTimeout(fn, timeout)`**: creates an `AbortController`, and races `fn(signal)` against a timer. When the timer fires, it rejects with the `LilypadTimeoutError`, then aborts the controller **with** that error. In that order: the abort listeners run synchronously, and an `fn` that rejects from one with an error of its own would otherwise win the race. JavaScript cannot stop a running promise, so the signal is how `fn` learns it should stop, and how the cache learns that a late result must not be stored (it checks `signal.aborted`).
- **`executeWithRetries({ executionFn, retries, backOffTime })`**: checks `retries` (a `NaN` would never reach `attempts >= retries`), then runs a `while (true)` loop that returns on success, and on failure either sleeps and retries (default backoff `2^attempt × 100` ms, at most 30 s) or, after the last attempt, rethrows. An invalid `backOffTime` result rejects with the attempt's error as `cause`.
- **`rateLimit(key)`**: remembers the last execution time per key (on `performance.now()`, a monotonic clock) and throws `LilypadRateLimitError` if the new one comes too soon. The map is pruned when it passes 1000 keys. It is deliberately **synchronous**, see below.
- **`singleFlight(key, fn)`**: returns the promise of the execution of `key` in flight, or calls `fn` and registers its promise (synchronously), removing it once settled.

`executeFn` chains them in this order:

```ts
assertNumberOption(..., timeout); assertNumberOption(..., retries); // 0. invalid options reject first
if (!this.isInFlight(id)) this.rateLimit(`${consumer}#${id}`); // 1. rate limit a new execution only
return this.singleFlight(id, () =>                               // 2. join, or start and register
  this.executeWithRetries({                                      // 3. retries around timeouts
    executionFn: () => this.executeWithTimeout(fn, timeout), ...
  })
);
```

Between the lookup and the registration of the promise there is **no `await`**. That is the whole correctness argument of single-flight: two calls cannot both see "nothing in flight" and both start, because JavaScript runs this block without interruption. It is also why `rateLimit` must stay synchronous.

A consequence the cache relies on: callers who join an execution share **everything** from the first caller, including its timeout and its outcome. The cache's fetches follow the same rule, although they are shared through `LilypadReadFlights` rather than `singleFlight`: the shared fetch only logs a failure and rethrows it, and the per-caller fallback is chosen afterwards, outside the shared fetch (see [4.6](#failures-errorreturn-and-the-cooldown)).

### 4.5 LilypadSerializer

[src/serializer/LilypadSerializer.ts](../src/serializer/LilypadSerializer.ts), 129 lines. Unrelated to the rest of the library: it maps objects of shape `FROM` to a compact shape `TO` and back, leaving out values equal to their default.

The runtime is trivial: `serialize` loops over the keys, skips values equal to the default (with `equality`, or `===`), calls the key's `serialize` function and writes the result under the `target` key; `deserialize` does the reverse and fills `undefined` with a `structuredClone` of the default, so that deserialized items never share a default array.

The interesting part is the **types** (lines 1-44). The key mapping `KeyMap` must be a bijection: every `TO` key used once, no two `FROM` keys on the same `TO` key.

- `IsSurjective<B, M>`: `keyof B extends M[keyof M]`, every key of `TO` is some target.
- `IsInjective<M>`: for each key `K`, the inverse record `InvertRecord<M>[M[K]]` (the union of all keys that map to the same target) must be exactly `K`. The `[X] extends [K]` brackets prevent TypeScript from distributing over the union. A key whose target is itself a union (`'x' | 'y'`) is rejected too (`IsUnion`): its runtime `target` would write only one of them.
- If the mapping is not a bijection, `target` is typed `never`, so the options object does not compile.

The `@ts-expect-error` tests in `LilypadSerializer.test.ts` check these types; they run under `npm run typecheck`, not under vitest.

### 4.6 The cache engine: LilypadCacheEngine

[src/cache/LilypadCacheEngine.ts](../src/cache/LilypadCacheEngine.ts), about 1260 lines, with its types in [LilypadCacheTypes.ts](../src/cache/LilypadCacheTypes.ts) and the shared level in [LilypadSharedLevel.ts](../src/cache/LilypadSharedLevel.ts). This is the heart of the library. Read [3.4](#34-tickets-ordering-asynchronous-writes) and [3.5](#35-expirationtime-0-means-invalidated) first.

[LilypadCache.ts](../src/cache/LilypadCache.ts) is the public face of the engine: each method checks that the cache is not disposed (a `LilypadDisposedError` otherwise) and calls the engine. It also owns the **bulk sync** (`bulkSync`, `getAll`, `invalidateBulkSync`), which `LilypadDbCache` does not need: it follows the engine through the hooks `onValueStored` (an entry that expires before the sync forces the next one), `onEntriesIncomplete` (evictions, `clear`, the `delete` of a fresh entry, `expireEverything`) and `hasReadInFlight` (every key, while a sync waits for its data).

#### What the engine holds

The fields fall into four groups:

| Group      | Fields                                                    | Role                                                                                       |
| ---------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Data       | `store: Map<string, entry>`, `protectedKeys`              | The entries, by normalized key; keys that `delete`/`clear`/eviction skip                   |
| Ordering   | `lastTicket`, `ticketFloor`, `fences`                     | See [3.4](#34-tickets-ordering-asynchronous-writes)                                        |
| Resilience | `failures`, `refreshing`, `sharedNotBefore`               | Cooldown after a failed fetch, background refreshes in progress, oldest acceptable L2 copy |
| Machinery  | `flowControl`, `shared`, `platform`, `logger`, `disposed` | The timeout of the fetches; the shared level                                               |

`LilypadCache` holds the fields of the bulk sync: `bulkSyncExpirationTime`, `bulkSyncInvalidationTicket` (see [3.4](#34-tickets-ordering-asynchronous-writes)), `bulkSyncs` (the syncs in flight), `bulkSyncsReading` (the syncs waiting for their data) and `bulkSyncFlowControl` (their timeout).

An entry ([`LilypadCacheEntry`, LilypadCacheTypes.ts:150](../src/cache/LilypadCacheTypes.ts)) is:

```ts
{
  key,            // the key as the caller passed it (number stays number)
  value,          // V | null
  expirationTime, // ms timestamp; 0 = invalidated
  fetchedAt,      // when the value was produced (for L2 copies: when *some* instance fetched it)
  ticket,         // ordering, see 3.4
  origin,         // 'source' (fetch or write) | 'fallback' (fallbackResult) | 'shared' (adopted from L2)
  invalidatedAt?, // set by expire(), kept by the next entries of the key for a while
}
```

`origin` is used in three places: `freshHit` reports a `fallback` as `refreshFailed`; `LilypadDbCache` only renews `source` entries, and ignores `fallback` entries when tracking the table's rows.

The constructor validates every numeric option, resolves the shared level (throwing if there is no store or no `name`), creates its flow control (5 s timeout for fetches, no retries, no rate limit; `LilypadCache` creates the one of its bulk syncs, 30 s), and starts the cleanup interval if asked, calling `unref()` so that the timer does not keep Node.js alive.

#### The write path

Every write funnels into one private method, `writeEntry`, which returns whether it stored the entry:

```
set(key, v, ttl) ──────────────> writeLocal ──(new ticket)──┐
setIfNewer(... ticket) ──(ticket check)──────────────────────┤
adoptShared(... ticket) ──(ticket check)─────────────────────┼──> writeEntry(entry, newValue)
expireNormalized ──(new ticket, exp=0)───────────────────────┘         │
                                                                       ├─ disposed? store nothing, return false
                                                                       ├─ with maxEntries: delete + set (move to the end = most recent)
                                                                       ├─ fences.delete(key)   (the entry's ticket now orders reads)
                                                                       ├─ if newValue: onValueStored(entry)   (hook of the owner)
                                                                       │               invalidate bulk sync if the entry expires before it
                                                                       └─ evictOverflow()
```

Four details:

- **The disposed check.** A fetch that was in flight when `dispose()` was called will still complete and try to store its value. The `disposed` flag makes `writeEntry` a no-op, and since the shared level is written only for an entry that was stored (`set`, `storeFetched`), a disposed cache writes nothing to L2 either.
- **LRU with a `Set`.** With `maxEntries`, `evictionOrder` holds the keys that can be evicted (not protected), least recently used first: a JavaScript `Set` iterates in insertion order, and deleting and re-adding a key moves it to the end. `markUsed()` does that on writes and reads. `evictOverflow()` removes the first keys of `evictionOrder` until the size fits, through `dropEntry` so that a read in flight keeps its fence. Protected keys stay out of it (`addProtectedKeys` removes them, `removeProtectedKeys` puts them back), so an eviction never scans them. Loops that write while iterating still iterate a **copy** of the store (`[...this.store]`).
- **Bulk sync consistency.** `entries()` returns "everything in the cache" and trusts it to be the whole source while the bulk sync is fresh. So anything that makes an entry disappear or expire early while the sync is fresh must invalidate the sync: an entry written with a shorter TTL (here), an eviction, `clear()`, the `delete` of a fresh entry. The entries written while a sync runs are kept as they are, so the sync is not fresh beyond the first of them to expire.
- **One removal path.** `delete`, `clear`, `purgeExpired`, the bulk sync and `get(key, { removeExpired })` all remove through `removeEntry`, which checks the protected keys and calls `dropEntry`.

`set` = `writeLocal` (new ticket, origin `source`) + `writeShared` (L2 in the background). `LilypadDbCache` calls it for its own writes. `writeLocal` alone is used for fallbacks, which must not be shared with other instances.

#### The read path: getOrSetDetailed

`getOrSet` is a thin wrapper over `getOrSetDetailed`, which returns `{ value, status, refreshFailed }`. Its lookup order:

```
getOrSetDetailed(key, valueFn, options)
│
├─ assertNotDisposed, cleanupOnAccess
│
├─ unless skipCache:
│   ├─ L1: fresh local entry? ─────────────────────────────> freshHit(... 'L1-HIT')
│   ├─ L2 (if shared):
│   │    read = beginRead()            ← ticket taken BEFORE the L2 read
│   │    shared.read(): entry + failedAt + lock, in parallel
│   │    merge failedAt into this.failures
│   │    adoptShared(remote, read.ticket)
│   │    fresh entry now? ─────────────────────────────────> freshHit(... 'L2-HIT' or 'L1-HIT')
│   └─ stale within staleWhileRevalidate?
│        refreshInBackground(...) ; return current value ──> 'STALE'
│
├─ in cooldown and no fetch in flight? ──> fallbackResult(LilypadCacheCooldownError) ──> 'MISS', refreshFailed
│
└─ try  fetchAndStore(key, valueFn, options) ─────────────> 'MISS'
   catch fallbackResult(error, options, key) ────────────────> 'MISS', refreshFailed
```

Why is the ticket for L2 taken _before_ reading L2 (line 571)? If a local `set` happens while the L2 read is in flight, the local value is newer than whatever L2 returns. `adoptShared` will see `read.ticket <= currentTicket` and refuse the copy.

Why is the entry re-read after L2 (`const current = this.store.get(...)`, line 581)? The `await` gave other code the chance to write it.

#### Fetching: fetchAndStore

It first looks for a fetch of the key in flight that a new caller may join: `fetches.join(key, currentTicket(key))` returns it only if its ticket is **above** the ticket the key has now. A fetch that started before an invalidation, or before a change applied from the sync, may return the old value: joining it would hand that old value to a caller that asked after the change. Such a fetch is **superseded**: the caller starts a new one, and the old one stays counted by `fetches.has(key)` until it settles, so that `hasReadInFlight` keeps the fences that discard its result. Otherwise it wraps the caller's `valueFn` in `flowControl.executeWithTimeout`:

```ts
const read = this.beginRead();            // ticket at the real start of the fetch
const fetching = this.flowControl.executeWithTimeout(async (signal) => {
  const value = await valueFn(signal);
  if (!signal.aborted) {                  // timed out: the caller already got an error
    read.storeFetched(key, value, options.ttl, options.staleWhileRevalidate);
  }
  return value;
}, options.timeout).catch((error) => { libLog(...); this.recordFailure(key); throw error; });
this.fetches.start([key], read.ticket, fetching); // before the callers get the promise
```

`LilypadReadFlights` ([src/cache/LilypadReadFlights.ts](../src/cache/LilypadReadFlights.ts)) forgets a read with a `then` handler registered before the callers get the promise, so the read is gone before their continuations run, as `singleFlight` did with `finally`. `LilypadDbCache` uses the same class for `rowFetches`, the queries by primary key of `getAll`.

When the fetch fails, `fallbackResult` chooses the fallback of each caller, except when a different, fresh entry was written meanwhile (every write replaces the entry object, so the entry seen before the fetch tells): that value is newer than anything the fetch could have returned, and is returned as an `L1-HIT`.

`storeFetched` does three things: clears the key's failure (and its L2 failure marker), stores the value with `setIfNewer`, and, only if it was stored, writes it to L2. Note that the fetch's result is returned to every caller even if it was not stored: the callers asked for the value _now_, and the value is correct for the moment it was read.

#### Failures: fallbackResult and the cooldown

When the fetch fails, the shared promise rejects for every caller who joined it. Each caller then runs `fallbackResult` **with its own `onError` options**. It re-reads the **current** entry (it may have changed during the fetch), and then:

1. `fallback: 'stale'`: the current entry's value, even expired or invalidated;
2. a fallback function: its result, called with `{ key, error, stale }`, where `stale` is `{ value, fetchedAt }` of the current entry, if any;
3. `undefined` (no fallback, or the function returned `undefined`): rethrow.

A fallback is stored with `writeLocal(..., ttl, 'fallback', fetchedAt)`: in this instance only, for `onError.ttl` or the cache's `errorTtl`, and tagged so that `freshHit` reports it with `refreshFailed: true`. When the fallback **is** the stale value, it keeps the stale entry's `fetchedAt`: it is not a newer value, and dating it from now would make `adoptShared` refuse, once the fallback expires, a fresher copy that another instance put in the shared level meanwhile. A value computed by the function is dated from now.

The **failure cooldown** keeps a source that is down from being hammered by every request. `recordFailure` stores the failure time in `failures`, and in L2 (the `f` key of the key) so other instances see it. `inCooldown` is true for `failureCooldown` ms after it. A failure time in the future (the wall clock stepped back since the failure) counts as now, as a remote one does: otherwise the cooldown would last as long as the step. During the cooldown `getOrSetDetailed` skips the fetch and goes straight to `fallbackResult` with a `LilypadCacheCooldownError`, unless a fetch is already in flight (joining it costs nothing). Once the cooldown ends, `freshHit` refreshes a cached fallback in the background, otherwise the fallback would hide the source's recovery until it expired.

#### Stale-while-revalidate

When an entry has expired but less than `staleWhileRevalidate` ago (and was not invalidated), `getOrSetDetailed` returns it immediately with status `STALE`, and calls `refreshInBackground`. The refresh is skipped when:

- another instance holds the L2 refresh lock (`remote.locked`);
- this instance scheduled a refresh of the key less than 60 s ago (`refreshing` map, on `performance.now()` so that a step back of the wall clock does not extend it; after 60 s it is assumed the platform dropped it);
- a fetch of the key is already in flight;
- the key is in its failure cooldown.

Otherwise it records the key in `refreshing` and hands the work to `runAfterResponse`: take the L2 lock (if configured), run `fetchAndStore` unless another instance holds the lock or the cache was disposed meanwhile, then clean up in `finally`. The lock is a random owner id stored under the `l` key with a TTL. `acquireLock` reads it again first (`null`: held by another instance): the work may run long after the read that scheduled it (after the response), and every instance that served the stale value meanwhile would otherwise refresh too. It is released only if it still holds _our_ owner id, because it may have expired and been taken by another instance meanwhile. It is a soft lock: read and write are separate operations, so two instances can occasionally both refresh, which is harmless.

#### The shared level (L2)

Everything about the store itself is in `LilypadSharedLevel` ([LilypadSharedLevel.ts](../src/cache/LilypadSharedLevel.ts)); the engine keeps only the decisions that involve its own entries and tickets (`adoptShared`, `writeShared`).

- **Keys** (`key()`, [line 68](../src/cache/LilypadSharedLevel.ts)): `lilypad:2:<name>:<kind>:<key>`, with `kind` one of `v` (the value), `f` (the time of the last failed fetch) and `l` (the refresh lock), and the name and the key URI-encoded. The kind comes _before_ the key and `:` is encoded, so no key can collide with the lock or the failure marker of another key (`"a:lock"` used to be the lock of `"a"`), and no pair of name and key can collide with another pair (`"x:y"` + `"z"` and `"x"` + `"y:z"`). The `2` is the version of the format: entries of the previous format are simply not read. The tags of the entries and of the invalidation events (`lilypadCacheTags`, [line 47](../src/cache/LilypadSharedLevel.ts)) are encoded the same way.
- **Values**: an envelope `{ lilypad: 2, value, fetchedAt, expiresAt }`. `fetchedAt` travels with the value, so that the _age_ of a value is measured from when some instance fetched it, not from when it reached this instance. Without that, a value could bounce between instances and never expire.
- **Codec**: the store usually holds JSON, so an optional codec encodes values on the way in and decodes (and validates) them on the way out. `decode` rejects malformed envelopes (including timestamps that are not finite, which would never expire, and an `undefined` value) and values the codec refuses, with a warning. `null` bypasses the codec. A remote failure time is ignored unless finite, and counts as now when in the future (another instance's clock ahead). An entry fetched "in the future" is ignored until its time comes: its stamp would pass every invalidation made before it (an entry of an instance whose clock is ahead, or planted in the store), and `checkBeforeWrite` replaces it.
- **Reading**: `read` reads the value, the failure marker and the lock in parallel, each bounded by the timeout (fallback `null`).
- **Adopting**: `adoptShared` ([LilypadCacheEngine.ts](../src/cache/LilypadCacheEngine.ts)) copies a remote entry into L1 only if all of these hold:
  1. it is newer than the local entry (`fetchedAt`);
  2. it was produced after the local entry was invalidated (`invalidatedAt`): an L2 delete may have failed, or another instance may have written an old copy back. The entries written after an invalidation keep its time too, while an L2 copy of that time may live: a value written to this instance only (a bulk sync, a load) does not replace that copy. A key without an entry keeps that time in `invalidatedMissing` (set by `deleteShared`, or when an entry carrying it is removed), for the default lifetime of an L2 copy (a copy kept longer, by a per-call TTL or stale window or by another instance with a longer TTL, is not covered). Beyond 10,000 of them (e.g. a flood of notifications), they are replaced with `rejectSharedBefore` of the latest: every older copy is refused, in constant memory;
  3. it was produced after `sharedNotBefore` (raised by a `TRUNCATE`, see [4.10](#applying-a-change));
  4. no local write started after the L2 read began (ticket check).
- **Writing**: `writeShared` ([LilypadCacheEngine.ts](../src/cache/LilypadCacheEngine.ts)) computes the L2 lifetime as `expirationTime + staleWhileRevalidate - now` (so other instances can serve it stale too), and `LilypadSharedLevel.write` skips expired entries and writes in the background. With `checkBeforeWrite`, it first reads the L2 entry and leaves it alone if it was fetched later.

What writes L2 and what does not is a deliberate choice: `set`, `bulkSet` and successful fetches write it; `delete` and `invalidate` remove from it; fallbacks, bulk syncs, `clear` and `dispose` stay local. A fallback is an instance's local emergency answer, not a fact to share. A bulk sync would copy a whole table into the shared store.

#### Invalidation and expiry

Four levels, each built on the previous one:

| Method                  | Does                                                                                              | Used by                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `expireNormalized(key)` | Entry: `expirationTime = 0`, new ticket, `invalidatedAt`. No entry but a read in flight: a fence. | everything below                                                                                                    |
| `expire(key)`           | The above, with a key                                                                             | subclasses                                                                                                          |
| `markInvalid(key)`      | `expire` + remove from L2                                                                         | `invalidate`; `LilypadDbCache` for changelog changes (and `LilypadCache.invalidate` then forces the next bulk sync) |
| `invalidate(key)`       | `markInvalid` + a `manual` event to `platform.onInvalidate`                                       | the public API                                                                                                      |

`expireEverything()` expires every entry, raises `ticketFloor` (discarding every read in flight, including of keys without an entry, so the fences are no longer needed and are cleared), and calls the `onEntriesIncomplete` hook. `LilypadDbCache` calls it when it may have missed changes.

`emitInvalidation` builds `{ source, cache, keys, tags }` and calls `onInvalidate` inside `runInBackground`. The `Promise.resolve().then(...)` wrapper turns a synchronous throw of `onInvalidate` into a rejection that the handler catches.

`delete` removes the entry (and the L2 copy); protected keys need `{ force: true }`. `clear` removes everything local. `purgeExpired` removes entries expired for longer than the stale window, and also cleans the bookkeeping maps (`failures`, `refreshing`, `fences`, `invalidatedMissing`). Since it may never run, the same cleanup also runs whenever one of these maps has doubled in size since the last one (`sweepBookkeepingIfLarge`, from 1000 entries), so they stay bounded at an amortized constant cost. It runs from the timer (`autoCleanupInterval`) or from `cleanupOnAccess` (at most once per `cleanupOnAccessEvery`, on reads and writes; no timer, which suits serverless instances that are suspended between requests). Every one of these removals goes through `dropEntry`, so it keeps the fence of a key being read ([3.4](#34-tickets-ordering-asynchronous-writes)).

#### Bulk sync

`LilypadCache.bulkSync()` loads everything from `bulkSync.fn` and replaces the content of the cache. Without a function it resolves to `false` at once (or rejects with `throwOnError`), with no query and no log. Still fresh (`now < bulkSyncExpirationTime`)? It resolves to `true` without loading. Otherwise it joins the sync in flight (`bulkSyncs`, a `LilypadReadFlights`), but only one that started after the last `forceNextBulkSync()` (its ticket above `bulkSyncInvalidationTicket`), as `getOrSet` joins a fetch: a sync started before an invalidation may miss it. Else `startBulkSync` takes the read (`beginRead()`) and starts one, bounded by its own flow control (30 s timeout). It resolves to a boolean instead of throwing, unless `throwOnError`.

`runBulkSync`, step by step:

1. Count the sync as reading (`bulkSyncsReading`, which the `hasReadInFlight` hook reads) until its data arrives or it times out: a key without an entry expired meanwhile then gets a fence, which discards the value read before the change.
2. `await bulkSyncFn(signal)`. Timed out (`signal.aborted`)? Store nothing.
3. Build `incoming`, keyed by normalized key.
4. For each **local** entry (on a copy of the store): keep it if it was written after the sync started (`entry.ticket > read.ticket`, newer than the sync's data) or if it is about to be overwritten; otherwise remove it, and if it is protected, expire it instead.
5. `read.store(key, value)` for each incoming entry: `setIfNewer`, so entries written during the sync still win.
6. Raise `ticketFloor` to the sync's ticket (in `replaceEntries`): a read of a missing key that started before the sync is older than the sync's knowledge that the key does not exist.
7. Mark the sync fresh, **unless** an invalidation happened while it was running (`bulkSyncInvalidationTicket >= read.ticket`): its data may predate that invalidation. Freshness never lasts longer than `ttl`, since the entries it loaded expire then, nor beyond the expiration of the entries written while it ran (taken before step 4), which it kept.

`forceNextBulkSync()` ([LilypadCache.ts](../src/cache/LilypadCache.ts), public as `invalidateBulkSync()` on `LilypadCache`) resets the expiration **and** records a ticket. Setting `bulkSyncExpirationTime = 0` alone would not be enough: a sync already running would set it again at step 7, and the next call would join it.

#### dispose

[LilypadCacheEngine.ts](../src/cache/LilypadCacheEngine.ts): The engine's `dispose()` returns at once if already disposed; it stops the timer, clears everything (including protected keys), drops the logger and the bookkeeping, and sets `disposed`. From then on the `assertNotDisposed` of the caches makes every public method throw. The caches' `dispose()` return a promise even though `LilypadCache` has nothing to wait for, because `LilypadDbCache` must await its `UNLISTEN`, and the API is the same for both (`LilypadDbCache` returns the same promise to every call).

### 4.7 LilypadDbGate

[src/dbGate/LilypadDbGate.ts](../src/dbGate/LilypadDbGate.ts), 706 lines. A thin layer over [postgres.js](https://github.com/porsager/postgres): a client, typed CRUD helpers, and `LISTEN` management.

#### The clients

The constructor creates the main client:

```ts
this.sql = postgres(options.connectionString, {
  prepare: false, // works behind PgBouncer in transaction mode
  ...toPostgresPoolOptions(options.pool), // ms → seconds, undefined keys removed
  ...(statementTimeout !== undefined && { connection: { statement_timeout } }), // 30 s by default
});
```

postgres.js connects lazily, on the first query, so creating a gate opens nothing. That is what keeps `next build` from reaching the database. `prepare: false` must stay: transaction-mode poolers route each statement to any backend, where a prepared statement may not exist.

`LISTEN` belongs to a session, so it cannot go through a pooler that reassigns sessions, and it must not be closed for being idle. postgres.js already handles this: its `listen()` opens **its own** dedicated connection (one per client, with no idle timeout and no maximum lifetime), whatever the pool options. So the gate listens through `this.sql` itself, and creates a second client only when `listenerConnectionString` points elsewhere, typically a direct connection (`listenClient()`, [line 506](../src/dbGate/LilypadDbGate.ts)).

`create()` goes through the singleton helper with a SHA-256 signature of the connection options; `initializeNew` registers the `listen` subscriptions and, if one fails, closes the gate before rethrowing, so that a gate that is never returned does not leak its pools.

#### CRUD helpers

All generic over a table definition `LilypadDbTableDefinition<T, PK>` of a config ([4.9](#49-the-database-config-and-lilypad-doctor)): table name and schema, primary key, the `cols` record (one entry per property of `T`), and the optional `hooks` the application bound to it (`write`, `select`: see [4.9](#the-hooks-of-the-application)). Every query names the table as `qualifiedName` (`"public"."users"`: postgres.js quotes each part), so it reads the table the doctor checked, whatever the `search_path`.

- **Reading rows.** `selectedColumns` selects only the schema columns, or `*` if there is a `select` hook (which may read other columns). `mapRow` builds `T` with the hook, or by copying the `cols` keys; the hook can return `null` to drop a row.
  The CRUD helpers live in `LilypadDbTable` ([src/dbGate/LilypadDbTable.ts](../src/dbGate/LilypadDbTable.ts)), created with `gate.table(definition)` or `gate.table('<key>')` (a table of the config the gate was created with, `resolveLilypadDbTable`): the definition is bound once, and the gate provides the connections and `assertOpen`. The schema types and errors are in [src/dbConfig/LilypadDbSchema.ts](../src/dbConfig/LilypadDbSchema.ts).

- `selectAll` reads through a **cursor** in batches of 1000 rows, so the raw result of a large table is never in memory at once. It is an SQL cursor in a transaction (`sql.begin`, `DECLARE`, then one `FETCH` per batch) rather than a postgres.js `.cursor()`: that one is a single statement, which `statementTimeout` cancels once the whole table takes longer than the timeout, while each `FETCH` is a statement of its own. It takes an optional `signal`: it checks it before each batch, and throws its reason once aborted. The throw rolls the transaction back, which closes the cursor, so a table load that timed out stops reading instead of streaming the rest of the table for nothing.
- `selectByPrimaryKeys` uses `IN (...)`, one query per 1000 keys, since Postgres limits the number of parameters per query. It removes the duplicate keys first: a key in two batches would return its row twice.
- **Writing rows.** `prepareWrite` is the security-relevant function: it applies the `write` hook (whose result _replaces_ the data), checks the primary key, removes it when the database generates it, and keeps **only the columns declared in `cols`** that are not `undefined`. An application can pass a request body directly; an extra `is_admin: true` is simply never written (no mass assignment).
- **Write results.** `insert`, `update` and `delete` return the transaction id with the result. Their `RETURNING` lists the selected columns (not `*`, unless there is a `select` hook) plus `pg_current_xact_id()::text AS __lilypad_xid`; `writeResult` strips that column before mapping the row and returns `{ row, xid }` (a column of the table with that name is therefore missing from the returned row). `pg_current_xact_id()` is the function the changelog trigger uses as the default of its `xid` column, so the ids match; it is how `LilypadDbCache` recognises its own writes when they come back ([4.10](#own-writes)). A delete returns `{ deleted, xid }`. An update of a missing row throws `LilypadDbNotFoundError`, which carries `tableName` and `primaryKeyValue`.

#### LISTEN management

State: `listeners: Map<channel, { callbacks: Map<callbackId, ...>, ready, listening }>`.

- `addListener` checks the channel (non-empty, at most 63 bytes: `LISTEN` truncates a longer one, whose notifications postgres.js would then never deliver), gets or creates the channel entry, sets the callback under its id (re-adding an id replaces the callback), awaits `ready`, then starts the heartbeat (unless the callback was removed meanwhile).
- `initializeListener` registers the channel entry **before** `LISTEN` completes, so concurrent `addListener` calls for the same channel share one `ready` promise. If `LISTEN` fails, the entry is removed and the error rethrown, so the next call retries. postgres.js keeps the callbacks of a failed `LISTEN` (it gives no `unlisten` for them) and listens to them again on every reconnection, so the callbacks given to postgres.js act only while their entry is the current one of the channel: otherwise each failed attempt would repeat every notification and `onReconnect`. Such a channel also stays listened to on the connection after its last callback is removed (its notifications are ignored).
- The third argument of postgres.js `listen()` is `onlisten`, which postgres.js calls after the first `LISTEN` **and after every reconnection**. The `listening` flag tells them apart: the first call only sets it; later calls run each callback's `onReconnect`. The cache uses that hook to expire everything, since notifications sent while the connection was down are lost for good.
- Each notification runs every callback of the channel through `runCallbackSafely`.
- `removeListener` deletes the callback synchronously, and only when the channel has none left, awaits `ready` and `UNLISTEN`s. It never rejects: a `LISTEN` that had failed, or a failed `UNLISTEN`, is logged. When the last channel goes, the heartbeat stops. After a reconnection no `UNLISTEN` is sent: postgres.js listens again with new listener objects, which the `unlisten` it returned for the first `LISTEN` does not remove, so the channel stays listened to (its notifications ignored).
- `close({ timeout })` clears the listeners, stops the heartbeat, releases the singleton, and ends the clients, waiting at most `timeout` (5 s) for the running queries. It keeps its promise, so a second call returns it, and `assertOpen()` makes the CRUD methods and `addListener` throw afterwards.
- `startHeartbeat` starts the timer only if `heartbeatStop` still holds its own `LISTEN` when that `LISTEN` completes: a `removeListener` of the last channel (or `close()`) that ran meanwhile has already awaited it to `UNLISTEN`, and a timer started after it would ping the database until `close()`. A heartbeat that could not start is retried by `isListenHealthy()`, after a `LilypadBackoff`.

#### The heartbeat

postgres.js re-establishes a lost `LISTEN` connection by itself, and `onlisten` tells when it is back. But it gives **no signal while the connection is down**: its internal listen connection overrides any `onclose` option. During that window notifications are lost, while a cache that trusts `LISTEN` keeps rows past their TTL without a query ([4.10](#trust-and-renewal)).

`LilypadListenHeartbeat` ([LilypadListenHeartbeat.ts](../src/dbGate/LilypadListenHeartbeat.ts)) closes that gap. Once a channel is listened to, the gate also listens on a private channel (`lilypad_heartbeat_<gate id>`) and, every `listenHeartbeat` ms (15 s by default), sends itself `pg_notify` on it **through the main pool**. Each notification that comes back on the listen connection is a beat. `isListenHealthy()` is true while the last beat is less than 2.5 intervals old. A broken listen connection, a broken pool or a suspended instance all stop the beats, and the caches stop trusting `LISTEN` until they resume. The timer is `unref()`ed; with `listenHeartbeat: false`, `isListenHealthy()` only tells whether `LISTEN` is active on a channel. The ages are measured on the monotonic clock (`performance.now()`): after a step back of the wall clock, a dead connection would otherwise count as healthy until the clock catches up.

### 4.8 The changelog

[src/dbGate/LilypadChangelog.ts](../src/dbGate/LilypadChangelog.ts) (SQL and the read) and [LilypadChangelogReader.ts](../src/dbGate/LilypadChangelogReader.ts) (batching). This section describes the database side and the query; [4.11](#411-the-changelog-strategy-end-to-end) follows a cache that uses them, from installation to failures.

#### Why a changelog

`LISTEN/NOTIFY` is near real-time, but it needs a long-lived direct connection, and a notification sent while no one is listening is lost. On a serverless platform, instances are suspended most of the time. The changelog solves this by **recording** every change in a table; each instance reads what it missed, whenever it wakes up. And unlike a notification, a changelog row can only be written by the triggers: the trigger function runs as its owner (`SECURITY DEFINER`), and no other role may write the changelog (`writable-changelog` reports one that may), so the cache can trust its content.

#### The SQL

`lilypadChangelogSql()` returns the DDL. The table:

```sql
id           bigserial PRIMARY KEY,          -- order of insertion
xid          xid8 NOT NULL DEFAULT pg_current_xact_id(),  -- the writing transaction (64-bit, PG 13+)
table_schema text,                           -- TG_TABLE_SCHEMA (the rows of version 1 have none: ignored)
table_name   text NOT NULL,
row_id       text,                           -- the primary key as text; NULL for TRUNCATE
op           text NOT NULL,                  -- INSERT | UPDATE | DELETE | TRUNCATE
changed_at   timestamptz DEFAULT clock_timestamp()
```

with indexes on `(table_name, xid)` (cursor reads) and `(changed_at)` (lookback reads and pruning).

The trigger function receives the primary key column name as its argument (`TG_ARGV[0]`), so one function serves every table. Since version 4 it runs as a **statement** trigger, one per event, with transition tables (`REFERENCING OLD TABLE AS lilypad_old NEW TABLE AS lilypad_new`): it builds, with `format('%I')`, a query that reads only the primary key column of the changed rows (`to_jsonb(n.id) #>> '{}'`, the same text as before, without converting whole rows to JSON), and records every row of the statement with one `INSERT ... SELECT` in `EXECUTE`. An `UPDATE` that changes primary keys also records a `DELETE` for each old key that no row has any more. `TRUNCATE` has a statement trigger of its own. Unless `notifyChannel: false`, the changes are also sent with `pg_notify('cache_events', json)`, so one trigger serves both strategies: one notification per row, read again from the transition table, or, when the statement changed more rows than `notifyBulkThreshold` (default 1000, `GET DIAGNOSTICS ... ROW_COUNT` of the insert into the changelog), one `BULK` notification for the table. A row trigger of version 3 or earlier still calling the function records nothing: the function raises a `WARNING` and returns, so that the write goes on, and the schema check reports the table (`missing-changelog-trigger`). The function runs as its owner: a `DO` block, which knows the schemas, creates it `SECURITY DEFINER` with a `search_path` of `pg_catalog` then `pg_temp` only, the changelog and the prune function qualified with their schemas (placeholders in the body, which become the arguments of one `format()` there: unlike nested `replace()` calls, it never reads again a name it inserted, which may contain a placeholder). The names of its functions and indexes come from the changelog table name; from a 62-byte prefix, PostgreSQL would truncate two of them into one, so they are cut with a hash instead. No other schema is on its path: neither another table nor a temporary table of the writer stands for the changelog, and no role can add, in a schema it may write to (`public`), an overload that matches better than a built-in function (`to_jsonb(integer)` over `to_jsonb(anyelement)`) and would run as the owner; the writes of the changelog and the execution of the functions are revoked from `PUBLIC`. Before version 7 it ran with the privileges of the writer, who then needed `INSERT` on the changelog, and could record forged changes that every cache applied. The function's comment carries the version (`lilypad-changelog:8`), which the schema check reads to detect outdated installs: below `LILYPAD_CHANGELOG_MIN_COMPATIBLE_VERSION` (4) it is an error, between it and the current version only a warning. Everything is idempotent (`IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP TRIGGER IF EXISTS`), so a migration can run it again.

`lilypadChangelogTriggerSql()` attaches the four triggers to one table, and drops the row trigger of version 3.

#### The cursor: the transactions a read could not see

This is the clever part. The obvious cursor, "the last `id` (or `xid`) I have read", **misses changes**, because transactions do not commit in the order they started:

```
T1 (xid 100) BEGIN ... writes a changelog row ............................ COMMIT
T2 (xid 101)      BEGIN ... writes a changelog row ... COMMIT
Cache read r1:                                               ↑ sees only xid 101 (T1 not committed)
                                                              "last seen" = 101
Cache read r2 (after T1 commits): WHERE xid > 101  → T1's change is never returned ✗
```

The snapshot of a read says exactly which transactions it could **not** see: those still running when it was taken (`pg_snapshot_xip`, here `{100}`), and those that had not started yet (`xid >= pg_snapshot_xmax`, here `>= 102`). Every other transaction had committed (its changes were visible) or aborted (it has none). So the cursor ([`LilypadChangelogCursor`, line 177](../src/dbGate/LilypadChangelog.ts)) is `{ xmax, xip }`, and the next read asks for `xid >= xmax OR xid = ANY(xip)`: it gets T1's change once T1 commits, and nothing it has already returned.

Two properties follow:

- **Each change is returned by exactly one cursor read.** A change of a transaction in `xip` is invisible to the read that produced the cursor; a later read returns it once it is visible, and the cursor of that later read no longer lists the transaction. So the cache needs no memory of applied changes.
- **A long transaction costs nothing.** An earlier version used `pg_snapshot_xmin` (the oldest running transaction) and asked for `xid >= xmin`: a transaction held open for an hour (a migration, a session idle in transaction) pinned `xmin`, and every read returned again every change of that hour. With `{ xmax, xip }`, the long transaction only stays in `xip`, and the reads return only the new changes.

`lilypadCursorCovers(cursor, xid)` answers "were the changes of `xid` visible to the read that produced this cursor?" (`xid < xmax` and not in `xip`). The cache uses it to forget its own writes whose change can no longer come back.

A caveat of the transaction ids: `pg_current_xact_id()` returns the id of the **top-level** transaction, even inside a subtransaction (a `SAVEPOINT`, a PL/pgSQL `EXCEPTION` block), and `xip` lists top-level transactions, so the two always agree.

#### The batched read

`readLilypadChangesBatch` reads several tables in **one statement**. One statement matters: behind a transaction-mode pooler, two separate statements could run on different backends, and the snapshot would not match the rows. The query is explained clause by clause in [5.5](#55-the-changelog-query-clause-by-clause).

Each request is either `{ cursor }` (trusted: continue from where I stopped) or `{ lookback }` (untrusted: give me everything from the last N ms). `readLilypadChanges` is the one-table wrapper; `pruneLilypadChangelog` deletes rows older than a retention, as do the pg_cron job of `lilypadChangelogPruneScheduleSql` and the trigger itself with the `prune` option of `lilypadChangelogSql` (see [What it costs](#what-it-costs)).

#### The reader: one query for all the caches of a gate

An application may cache ten tables. Ten caches each polling the changelog would be ten queries per interval. `LilypadChangelogReader` ([LilypadChangelogReader.ts](../src/dbGate/LilypadChangelogReader.ts)) is shared by every cache of a gate that uses the same changelog table (a `WeakMap<gate, Map<table, reader>>`, [line 108](../src/dbGate/LilypadChangelogReader.ts)); the `WeakMap` lets the reader be garbage collected with the gate.

Each cache **subscribes** with two functions: `request(readAtMonotonic)` (what to read for me: my cursor or a lookback) and `apply(result, request)` (apply what was read). When any cache needs a read, `read(subscriber)`:

- no read running: start one that includes **every** current subscriber;
- a read running that includes this subscriber: share it;
- a read running that does not include it (it subscribed later): queue one read after it (shared by every late caller).

`readAll` asks each subscriber for its request, runs the batched query, and calls every `apply` with `Promise.allSettled`, so one cache's failure does not affect the others.

### 4.9 The database config and lilypad-doctor

#### The config

A config ([src/dbConfig/LilypadDbConfig.ts](../src/dbConfig/LilypadDbConfig.ts)) is the one description of the database that both sides use: the application imports it to build its gates, table handles and caches, and `lilypad-doctor` imports it to check the database. `defineLilypadTable<T, PK>` only carries the row type (an identity function); `defineLilypadDb` validates the input (`validateLilypadDbConfigInput`: the config itself, never the database) and **resolves** it, once, into frozen definitions:

- the name is split into `tableName`, `schemaName` (from `app.users`, `schemaName`, or `defaultSchema`) and `qualifiedName`;
- the column shorthands (`unique: true`, `references`) join the table-level `unique` and `foreignKeys`; a reference is resolved to a qualified table (an unqualified name is the table of the config of that `tableName` in `defaultSchema`, else its only one, an error when several schemas share it, else a table of `defaultSchema` outside the config), and its columns default to the primary key of a table of the config;
- every default is applied (`sync` `listen`, actions `no action`, index method `btree`, `strict` of the config), and each definition carries the settings of its config (`db`: name, channel, changelog table).

The definitions carry a mark, `Symbol.for('lilypad.dbTable')` (and the config `Symbol.for('lilypad.dbConfig')`): `Symbol.for`, so that a config made by another copy of the library (the command, loading the application's `node_modules`) is recognized. `gate.table()` and `LilypadDbCache.create()` go through `resolveLilypadDbTable`, which takes a marked definition, or a key looked up in the `config` of the call, else in the config of the gate. On the type side, `LilypadDbGate<C>` carries the type of its config, so `gate.table('users')` and `create({ gate, table: 'users' })` infer the row type (`LilypadDbRow<C, N>`) and reject an unknown key.

The runtime never compares the config with the database. What the caches used to learn from a runtime check, they now read from the definition: the schema of the table (to filter notifications of a same-named table elsewhere), the channel, the changelog table.

#### The hooks of the application

The config holds no function. `lilypad-doctor` loads it with a plain `import()`, so everything it imports, even indirectly, must load in Node.js as it is: functions that transform rows usually import application code (path aliases, `server-only`, JSON, modules with side effects), which would make the config unloadable, or run that code at every check. So `defineLilypadDb` rejects `writeSanitizationFn`, `selectSanitizationFn` and `hooks` in a table (a JavaScript config is not type-checked, and silently dropping a write function would drop what it removes), and the application binds them with `bindLilypadDbHooks(db, { users: { write, select } })` ([LilypadDbHooks.ts](../src/dbConfig/LilypadDbHooks.ts)).

`bindLilypadDbHooks` returns a frozen copy of the config: the same settings and the same definitions, except that those it names are copied with a frozen `hooks` object (merged over the hooks already bound, so binding again replaces only what it names; an `undefined` hook is not named, and a table named with no hook is left as it is, since an empty `hooks` would hide those of the gate's config). The spread keeps the `Symbol.for` marks, so the copy is a config and its tables are definitions. The types of the hooks come from the row type of each table (`LilypadDbHooks<C>`, with `LilypadDbRow<C, N>`).

Two definitions of the same table now exist: `db.tables.users` and `appDb.tables.users`. Using the first one where the second was meant would skip the hooks, silently. `resolveLilypadDbTable` closes that gap: a definition without hooks whose key names a table with hooks in the config it resolves against (the gate's), with the same config name and the same `qualifiedName`, is returned with those hooks (`withConfigHooks`). Every table handle goes through `gate.table()`, including the one of `LilypadDbCache`, so a gate created with `appDb` applies the hooks whichever copy the application passes. It is not an identity check, on purpose: a singleton gate outlives the module reloads of a development server, which create new config objects.

#### The check

The check itself lives in [src/dbGate/](../src/dbGate/). `lilypadSchemaCheckOptions(config)` ([LilypadDoctor.ts](../src/dbGate/LilypadDoctor.ts)) turns a config into the options of `checkLilypadSchema`: one requirement per table (`changelog` for the `changelog` tables, the config's `notifyChannel` for the `listen` ones, and the definition itself as its `shape`), the changelog (only if a table reads it) with a `minRetention` of the largest of `changelog.minRetention` and each table's `maxGap` and `lookback`. `runLilypadDoctor` opens a gate of one connection, runs it and closes it; the command ([src/cli/](../src/cli/)) loads the config file (`loadLilypadDbConfig`: `lilypad.config.*` or `lilypad.<name>.config.*`, imported with `import()`, so a TypeScript file relies on the type stripping of Node.js) and maps the result to its exit code. `checkLilypadSchema` is two steps:

1. `readLilypadSchemaFacts` ([LilypadSchemaFacts.ts](../src/dbGate/LilypadSchemaFacts.ts)) reads only the catalogs. One query: server version, the current database, whether the changelog table exists (`to_regclass`) and in which schema, whether it has the `table_schema` column, whether the trigger function and the prune function exist (`to_regprocedure`), the function's comment (the version) and its source, the rows deleted from the changelog (`n_tup_del`), and what the server says of pg_cron (available, installed here, `cron.database_name` read from `pg_settings`, which leaves out the settings the role may not read, where `current_setting()` would throw). Then one query for every table: the table's schema, and all its non-internal triggers as JSON: whether it calls the changelog function, its arguments, its `tgtype` bitmask, whether it is enabled, and the **source** of its function. For the tables whose shape is checked, the same query also returns their columns (`format_type`, `typcategory`, `attnotnull`, `atthasdef`, identity, generated), their constraints (primary key, unique, foreign keys with the referenced table, columns and actions, checks) and their indexes (key columns in order, `NULL` for an expression, method, unique, partial, and whether a constraint owns it). Last, when the changelog is checked: the age of its oldest row (`min(changed_at)`, one step on its index) and the jobs of `cron.job`, read as `row_to_json` so that the columns older versions of pg_cron lack are simply absent. These two are best effort: a role that cannot read them leaves them unknown (`null`) instead of failing the check.
2. `evaluateLilypadSchema` turns those facts into problems. It is a pure function, so every rule is unit-tested without a database. Per table: first its shape (`evaluateLilypadTableShape`, [LilypadSchemaShape.ts](../src/dbGate/LilypadSchemaShape.ts)), then the triggers its sync needs. Checks on `tgtype` (bits `ROW=1, INSERT=4, DELETE=8, UPDATE=16, TRUNCATE=32`): the enabled changelog triggers must together record `INSERT`, `UPDATE` and `DELETE` (`recordedEvents`: a statement trigger records the events whose transition tables it declares as `lilypad_old`/`lilypad_new`; a row trigger of the changelog function, left by version 3, records nothing); their first argument must be the primary key; a statement-level `TRUNCATE` trigger must exist. For `listen`, a regular expression looks for `pg_notify('<channel>'` in the function source, so a hand-written trigger counts too. The event bits of every enabled row trigger that notifies are OR-ed together, and must cover `INSERT`, `UPDATE` and `DELETE`: one trigger per operation is fine, but a trigger on `UPDATE` alone is reported, since the cache would never hear about inserts and deletes.

The shape rules compare structure, never names. A declared `pgType` is normalized the way `format_type` writes it (`normalizeLilypadPgType`: aliases such as `int4` or `timestamptz`, the precision of the time types before their zone, the default modifiers such as `numeric(10)` for `numeric(10,0)` or `bit` for `bit(1)`, and one `[]` for any array, whose dimensions PostgreSQL ignores) and compared exactly; without it, the `type` must be what postgres.js returns for the column (`lilypadColumnTypeMismatch`, from the table of `LilypadPgTypes.ts`, or the category of a type it does not know: a `numeric` or `bigint` column declared `number` is a warning, since postgres.js returns strings). A unique key is satisfied by any primary key, unique constraint or unique index (neither partial nor on expressions) on the same set of columns; a foreign key by a constraint with the same referenced table and the same pairs of columns, whose actions are then compared; an index by one with the same columns in order and the same method. `strict` adds warnings for what the database has and the description lacks, skipping the indexes that implement a constraint. The missing foreign keys are reported after every table (`deferred`), so that the fix SQL, printed in the order of the problems, creates the tables before the keys that reference them.

The pruning of the changelog is evaluated by `evaluatePruning`. It collects the prunings it can prove: the `prune` option (from the `lilypad-prune:` comment) and the active jobs of this database whose command is a `DELETE FROM` the changelog table (`lilypadCommandDeletesFrom`), each with its retention when it can read it (`lilypadPruneCommandRetention`). A retention not longer than `minRetention` is an **error**: [the cursor cannot notice the missing rows](#choosing-the-options). If it proves none, and `pruning` is not `external` and no row was ever deleted (`n_tup_del`, which also catches `pruneLilypadChangelog` run from the application), it **warns**, with the best pruning for the database (`suggestPruning`, [LilypadSchemaPruning.ts](../src/dbGate/LilypadSchemaPruning.ts)): a pg_cron job when pg_cron is known to run (installed here, or `cron.database_name` names this database or another one, where the job is then scheduled with `schedule_in_database`); otherwise the `prune` option, which works everywhere. `pruning: 'trigger'` or `'cron'` forces one of the two: `'cron'` keeps the other database when `cron.database_name` names one, and otherwise assumes this one (where the role cannot read the setting, as on managed hosts), saying so in the message. When the suggestion is the `prune` option, the fix of a missing or outdated changelog includes it, so the report shows one SQL. The last rule is a safety net that needs no detection: an oldest row older than the retention (24 hours if unknown) plus 7 days means that the pruning does not run, or does not keep up. The 7 days leave a weekly job its week.

Problems have a severity: `error` (the database is not what the config describes; `ok` is false and the command exits with 1) or `warning` (it works, but something needs attention).

Every problem that the library can fix comes with the SQL that fixes it, generated by the same functions as the install SQL: a missing table is created (`lilypadCreateTableSql`, when every column has a `pgType`) with its keys, checks, indexes and the triggers its sync needs; a missing column added; a foreign key created, or dropped and created again with other actions. Every fix that installs the changelog installs the same SQL, whose function notifies on one channel: the one the check requires, else the one the installed function notifies on (found in its source) when no table needs another, else the channel of the first `listen` table. A changelog installed with `notifyChannel: false` is not turned into one that notifies unless a table needs it, and one shared with `listen` caches does not stop notifying; a table that needs yet another channel gets no fix. A missing table whose schema is missing too is preceded by `CREATE SCHEMA IF NOT EXISTS`; a generated primary key gets an identity (integer) or `gen_random_uuid()` (`uuid`), and a default the library cannot write is left as a comment. A fix that must run in another database (the pg_cron job scheduled from the database pg_cron runs in) carries that database in `fixDatabase`: the report shows it apart, and `--sql` (`formatLilypadSchemaFixSql`) prints it as a comment, out of the migration.

### 4.10 LilypadDbCache

[src/dbCache/LilypadDbCache.ts](../src/dbCache/LilypadDbCache.ts), about 950 lines, with its sync strategies in [dbCache/sync/](../src/dbCache/sync/). A cache of one table on the engine of [4.6](#46-the-cache-engine-lilypadcachecore). What it adds:

1. **Fetching**: `getOrFetch(key)` = the engine's `getOrSetDetailed(key, () => table.selectByPrimaryKey(key))`, where `table = gate.table(schema)`.
2. **Writing through**: `sqlCreate`/`sqlUpdate`/`sqlDelete` write to the database, then cache the row the database returned.
3. **Syncing**: learning about changes made elsewhere, through a strategy object (`listen`, `changelog` or `none`).
4. **Trust and renewal**: while the strategy is known to see every change, entries don't need a query at their TTL.
5. **The table as a whole**: `getAll()` returns every row (a `Map` keyed by primary key), with as few queries as possible, by tracking which keys exist (`LilypadDbMembers`, [src/dbCache/LilypadDbMembers.ts](../src/dbCache/LilypadDbMembers.ts)). The writes of the instance are remembered by `LilypadOwnWrites` ([src/dbCache/LilypadOwnWrites.ts](../src/dbCache/LilypadOwnWrites.ts)).

What it does **not** have is as important: the writes of `LilypadCache` (`set`, `bulkSet`, `getOrSet`, `bulkSync`) and its bulk reads are not exposed: they stay in its private engine. Every value of the cache comes from the table (a fetch, a load, or the row a write returned), which is what makes renewing values past their TTL safe.

#### Types and construction

`create()` is generic over the row type `V` and the primary key column `PK`, both **inferred from the table definition** (given as `db.tables.users`, or by key, in `config` or in the config of the gate: three overloads); the key type is `LilypadDbKey<V, PK> = V[PK] & LilypadCacheKey`. It resolves the definition (`resolveLilypadDbTable`), builds the cache, calls the strategy's `start()` (which starts `LISTEN` for `listen`, unless lazy); on any failure, it disposes and rethrows. It never queries the catalogs.

The constructor:

- takes `gate`, `table` and `sync` out of the options and builds the engine with the rest, `name` defaulting to the table name;
- merges the `sync` of the definition with the overrides of the cache (`maxAge`, `connect`, `applyChanges`, `onNotification`, `pollInterval`, `poll`), whose numbers it validates (those of the definition were validated by `defineLilypadDb`);
- sets no bulk sync function: the table is loaded by its own `loadTable` (see [getAll](#members-and-getall)), which calls the engine's `replaceEntries`;
- takes the schema of the table from the definition (`schemaName`);
- creates the strategy (with the channel or the changelog table of the config), giving the strategy a **host** object (`syncHost()`, [line 244](../src/dbCache/LilypadDbCache.ts)): a few closures over the cache's own methods (`applyChange`, `applyTruncate`, `expireEverything`, `emitInvalidation`, ...), so that the strategy can act on the cache without reaching into it.

#### The strategies

A strategy ([`LilypadDbSyncStrategy`, LilypadDbSyncTypes.ts:165](../src/dbCache/sync/LilypadDbSyncTypes.ts)) answers four questions: what to start in `create()` (`start`), what to do before a read (`beforeRead`), since when it sees every change (`trustedSince`), and whether the writes of this instance come back through it (`seesOwnWrites`). Plus `dispose`.

- **`lilypadNoSync`**: nothing to start, nothing to wait for, never trusted.
- **`LilypadListenSync`** ([LilypadListenSync.ts](../src/dbCache/sync/LilypadListenSync.ts)): subscribes to the `LilypadNotificationRouter` of its gate ([LilypadNotificationRouter.ts](../src/dbCache/sync/LilypadNotificationRouter.ts)), which registers **one** callback on the channel of the config (`cache_events` by default) for every cache of the gate (`callbackId: 'lilypad_notification_router'`), parses each notification once, and hands it to the caches of its table (the last cache to unsubscribe removes the listener). `startListening` subscribes; if the cache was disposed while `LISTEN` was starting, it unsubscribes again (otherwise a lazy `LISTEN` started by a read just before `dispose()` would leave a callback registered forever on the gate). `dispose` waits for a `LISTEN` still starting before removing the listener, for the same reason. `trustedSince` is the time `LISTEN` became active (reset by `onReconnect`), but only **while `gate.isListenHealthy()`**: without recent heartbeats, the cache does not trust it. `onReconnect` applies the reconnection as a change of the whole table (`applyBulkChange`, with a `wholeCache` event): the notifications sent while the connection was down are lost, for every instance when the database itself went away, so the L2 copies produced before are refused too.
- **`LilypadChangelogSync`** ([LilypadChangelogSync.ts](../src/dbCache/sync/LilypadChangelogSync.ts)): subscribes to the gate's reader, keeps the cursor, and reads the changelog before a read when `pollInterval` has passed. `trustedSince` is the start of the unbroken chain of cursor reads; `undefined` without a cursor, when the last read is older than `maxGap`, or when no read was applied within `pollInterval` (two intervals with `poll: 'background'`): a change committed since is still unapplied. The whole strategy is described in [4.11](#411-the-changelog-strategy-end-to-end).

#### Syncing before a read

The async reads (`getOrFetchDetailed`, [LilypadDbCache.ts](../src/dbCache/LilypadDbCache.ts), `getAll` and `getManyOrFetch`) start with:

```ts
const syncing = this.sync.beforeRead();
if (syncing) await syncing;
this.renew(this.normalizeKey(key));
return this.getOrSetDetailed(key, valueFn, options);
```

`beforeRead` returns `undefined` when there is nothing to wait for, and the caller only awaits a real promise. That detail matters: even `await undefined` yields to the microtask queue. Without it, the read runs synchronously down to the registration of the fetch, exactly as in the engine. So by the time `getOrFetch` returns its promise, the fetch is already registered as in flight, and a change applied immediately afterwards sees it (`hasReadInFlight`) and fences it. (Wrapping these three lines in an `async` helper would silently break this.) When something is due:

- `listen` + `connect: 'lazy'`: start `LISTEN` on the first read (unless it is already started or in backoff);
- `listen`, once `LISTEN` is started: nothing;
- `changelog`: if `pollInterval` has passed (and no backoff), read the changelog. With `poll: 'background'`, the read is not awaited.

Failures are logged and turned into a backoff ([3.8](#38-retries-back-off)).

`get()` (synchronous) cannot sync; it only renews. With `changelog`, it renews only while the last applied read is at most one `pollInterval` old, since a read is what applies the changes.

#### Trust and renewal

The idea: if the cache is **certain** it would have heard about every change of the table, then a row that reaches its TTL without a change is still correct, and there is no reason to query it again.

`renew(key)` extends an expired entry's `expirationTime` (directly in the store, without a ticket: the value does not change) when all of these hold:

- `origin === 'source'`: it was read from the database or written by this instance, not a fallback and not an L2 copy;
- `expirationTime !== 0`: no change invalidated it;
- `fetchedAt >= sync.trustedSince()`: it was read while the sync was already watching, so any later change would have expired it;
- it is younger than `maxAge` (1 h by default). `maxAge` bounds the damage of changes the triggers cannot see (triggers disabled, `session_replication_role = replica` during a restore).

The new expiration is `min(now + ttl, fetchedAt + maxAge)`. L2 lifetimes are never extended: other instances may not be in sync.

Renewal is also why the ordering rules of [3.4](#34-tickets-ordering-asynchronous-writes) must hold without exception: an older row that slipped into the cache after a change would not just live until its TTL, it would be renewed until `maxAge`.

#### Applying a change

Changes arrive through two paths, which converge on `applyChange` and `applyTruncate`:

```
changelog read ──> LilypadChangelogSync.apply(result, trusted) ──┐ mode 'lazy'   (trusted content)
LISTEN payload ──> LilypadListenSync.handleNotification ─────────┤ mode 'eager'  (a hint)
                                                                 ▼
                                     applyChange(op, id, mode, xid) / applyTruncate(mode)
```

The two modes differ in **how much the cache trusts the change**. A changelog row is written by the triggers only. A notification is not: in PostgreSQL, **any role connected to the database can `NOTIFY` any channel**, without privileges. A notification is therefore only a hint that something may have changed, and the cache never acts on its content without a query.

`applyChange`:

1. `resolveNotifiedKey(id)`: the key of the existing entry or member (so `'7'` becomes `7` if that is how it is cached), else a number if the schema says the primary key is a `number` and the conversion is exact, else the text.
2. `ownWrites.consume(key, xid)`: skip changes this instance made itself (next section).
3. `DELETE` from the changelog: if the key is held (an entry, or a read in flight), cache it as `null` (the `null` entry also blocks a fetch in flight from storing the deleted row), even for a protected key. Otherwise, no entry: remove the key from `members` and from L2. A mass delete, or the lookback of a cold start, thus creates no entries, which would evict the rows the instance holds.
4. Otherwise, `INSERT`/`UPDATE` note the key as a member of the table. Then:
   - key **not held** (no entry, no read in flight; a write of the key in flight counts as a read, a load of the table does not: `isHeld`): no query at all. Nobody asked for this row here. Remove it from L2 (other instances may have cached an old copy), and, while a load of the table waits for its rows, expire it too (`forgetUnheld`): its fence discards the row the load may have read before the change. An eager `DELETE` of such a key leaves it among the members: `getAll` will fetch it, and learn whether it is really gone.
   - held, `eager` (notifications, including `DELETE`): `eagerRefresh`, a `LilypadEagerRefresh` ([LilypadEagerRefresh.ts](../src/dbCache/LilypadEagerRefresh.ts)), re-fetches it now, together with the other keys notified meanwhile: the batch is sent a microtask later, once the notifications received in the same chunk have been handled, with one `selectByPrimaryKeys` (`rereadNotified`; a statement that changes many rows notifies each of them, and one query per row would flood the pool). The keys of a failed batch are expired. It counts the keys of the pending and running batches (`has`), for `hasReadInFlight`. The query of a batch starts after the notifications of its keys, so it sees their changes even if an older read of the key is still running (the older result loses by its ticket). A forged `DELETE` thus costs part of one query and changes nothing; a real one caches `null`.
   - held, `lazy` (changelog): `markInvalid`, no query; the next read fetches it. The new ticket also discards a read in flight.

Why lazy for the changelog? A changelog read can return hundreds of changes at once (on a lookback, for instance); re-fetching them all eagerly would turn a poll into hundreds of queries, most of them for rows no one will ask for again.

`applyTruncate(mode)` expires everything, removes every cached key from L2, calls `rejectSharedBefore(now)` (L2 copies older than the truncate are refused from now on, even for keys this instance did not hold), empties `members` and raises its floor (`members.forget`: a table load that started before the truncate must not bring back the old rows). From the changelog, the table is then known to be empty, with no query. From a notification, it also marks the table as not loaded, so the next `getAll()` loads it again: a forged `TRUNCATE` costs one load, not an empty result.

`applyBulkChange()` is the same as an eager `TRUNCATE` without the L2 removal of each key (the older L2 copies are ignored through `rejectSharedBefore`): it applies a `BULK` notification (a statement changed more rows than the `notifyBulkThreshold` of the trigger), and a changelog read with more than 1000 keys (`LILYPAD_BULK_CHANGE_THRESHOLD`). Following each key would cost, on every instance, one L2 removal and one tag per key.

Notifications are untrusted, so their re-reads have a budget: at most 1000 keys per second per cache (`LilypadEagerRefresh`, on the monotonic clock; a key already in the batch being gathered costs nothing). Beyond it, a notified key is only expired (`markInvalid`, no query), and read again when the application asks for it.

The notifications themselves have a budget too, since even a key not held costs an L2 removal, an entry of `invalidatedMissing` and an invalidation event, and a `TRUNCATE` or a `BULK` expires every entry: `LilypadListenSync` applies at most 2000 notifications per second per cache, and one `TRUNCATE`/`BULK`. Beyond, the second is applied as one change of the whole table (`applyBulkChange`), at once, and once more at its end for the notifications left: a flood of any size costs two expirations of the table per second. The router logs malformed notifications once a minute, with the count of the others.

`LilypadChangelogSync.apply` ([LilypadChangelogSync.ts](../src/dbCache/sync/LilypadChangelogSync.ts)) wraps it for a changelog read:

- **untrusted read** (a lookback, because there was no cursor or the gap exceeded `maxGap`): the local memory may have missed anything, so `expireEverything()`; then apply the lookback's changes anyway, because they remove L2 copies that other instances may still serve. The chain of trust starts at `readAt`.
- reduce the changes with `lilypadNetChanges`: a `TRUNCATE` drops the changes read before it (and is applied once), and only the last change of each row is kept, since the changes of a row are ordered by the lock of the row. Beyond 1000 rows, `applyBulkChange()` instead of one `applyChange` per row;
- apply each remaining change (each is returned once by a cursor read, see [4.8](#48-the-changelog));
- after applying, forget the own writes the new cursor covers (`forgetOwnWritesCoveredBy`, [LilypadDbCache.ts](../src/dbCache/LilypadDbCache.ts)): their changes can no longer be returned;
- store the cursor, reset the backoff, emit one `changelog` event, with each key once (`keys: []` and the tag of the cache for a bulk change or a `TRUNCATE`).

The **notification** path is `LilypadListenSync.handleNotification` ([LilypadListenSync.ts](../src/dbCache/sync/LilypadListenSync.ts)): it ignores notifications once the cache is disposed; `parseLilypadNotification` validates the JSON (a known `op`, a non-empty `table`, a string or number `id` except for `TRUNCATE` and `BULK`, string `schema` and `xid`); the router does it once for every cache of the gate and anything else is logged as a warning and ignored; then it checks the table and schema, applies eagerly, emits a `notification` event, and calls the user's `onNotification`. With `applyChanges: false` it only calls `onNotification`, and the sync is not trusted.

#### Own writes

When this instance runs `sqlUpdate`, it caches the row the database returned. Seconds later, its own change comes back through the changelog or a notification. Applying it would expire the fresh row and cost a query, for nothing.

- `storeWritten` records `(key, xid, ticket of the stored entry)` in `ownWrites` (`ownWrites.record`, [LilypadOwnWrites.ts](../src/dbCache/LilypadOwnWrites.ts)), if the strategy `seesOwnWrites` (not `listen` with `applyChanges: false`, which applies no change).
- `ownWrites.consume(key, xid)` removes the xid from the set and returns `true` only if the entry **still has the ticket** of that write. If anything replaced the entry since (another change, a fetch), the change is applied normally.

`ownWrites` is bounded two ways: by the changelog cursor (`lilypadCursorCovers`: a transaction still in `xip` is kept, so a write whose transaction was still running at a read is recognised when its change comes later), and, for `listen` where there is no cursor, by a 10-minute retention (on the monotonic clock). The map is kept in the order of the last write (delete + set), so pruning stops at the first recent entry. A key written again and again is never older than the retention, and the change of some of its writes may never come back (a lost notification, or one received before the write returned): each key keeps its last 32 transactions only.

#### Writing through

`sqlCreate`, `sqlUpdate`, `sqlDelete` share one pattern:

```ts
this.assertNotDisposed();
const row = await this.writing(key, async (startTicket) => {
  const { row, xid } = await table.update(item);
  this.storeWritten(key, row, startTicket, xid);
  return row;
});
this.emitInvalidation('write', [key]);
```

`writing` counts the write in `writesInFlight` (by key, when the key is known before the write: not for a generated primary key) and takes `startTicket` once it is counted. While it runs, the key counts as read (`hasReadInFlight`), so a change of the key applied meanwhile always leaves a mark newer than `startTicket`, even when the cache does not hold the key: an entry, or a fence.

`storeWritten`: nothing if the cache was disposed during the write. If `currentTicket(key)` (the entry's ticket, or else the fence and the floor) is now greater than `startTicket`, something touched the key _while the write was running_ (a change applied, possibly newer than the write, a fetch that may have read the row before the write). The library cannot tell which of the two happened last in the database, so it does not guess: it expires the key, and the next read fetches the truth. Otherwise, `engine.set(key, row)` (new ticket, L2 write) and record the own write. It runs inside `writing`, before the fences of the key can be pruned.

#### refresh

`refresh(key)` re-fetches one row, with the running + queued coalescing described in [3.7](#37-single-flight-everywhere): a caller that arrives while a query runs gets the _next_ query, which is guaranteed to start after the call. `fetchRow` uses `beginRead` and `storeFetched`, like `getOrSet`, and `fetchTimeout`.

#### Members and getAll

`getAll()` must return every row of the table. Loading the whole table each time is correct but expensive; returning the cached entries is cheap but wrong (the cache may hold only some rows). The solution is to track **which keys exist** separately from their values:

- `members`, a `LilypadDbMembers`: the keys of the rows, each with a ticket, set by each table load (`members.replace`) and kept up to date afterwards by the `onValueStored` hook of the engine (`members.follow`: a row → member, `null` → removed; fallbacks ignored; an older ticket never overrides a newer one), `members.add` (INSERT/UPDATE of an uncached key) and `members.forget` (a `TRUNCATE` or a bulk change). Evicting an entry does **not** remove its member: the row still exists. The members are tracked once a load completed, and **while a load runs** (`beginLoad`/`endLoad`): a row inserted during the very first load is newer than the load, and `replace` keeps it. The members noted by `add` and not yet seen in a load or a stored value are counted: beyond a quarter of the table (and at least 1000), since anyone can send a notification, they are forgotten (`forget`) and the next `getAll` loads the table, as it would anyway. Never while a load runs: that would void the load, and its `getAll` would return only the rows noted since; the next `add` after the load checks again.
- `members.isLoaded(trustedSince, ttl)`: the members are reliable if the last load happened after the sync became trusted, or, without a trusted sync, less than `bulkSync.ttl` ago. A load made before the sync became trusted again (a `LISTEN` reconnection, a broken changelog chain) does not count, even within `bulkSync.ttl`: rows may have been inserted in between.

`getAll()`:

```
sync.beforeRead
members not reliable?  ──> loadTable()            (one full query)
stale = members whose entry is missing or expired (after renew)
stale > 25% of members, and no load yet? ──> loadTable()   (one full query beats many key lookups)
fetchRows(stale)                                  (one IN query per 1000 keys)
return rowsOf(members, fetched, loaded)
```

Three subtleties:

- **With `maxEntries`**, a load may store more rows than the cache can hold; the evicted ones would then count as stale and be fetched again immediately. So `loadTable` does not rely on the store: `loadRows` (with `beginRead`, `members.replace` and the engine's `replaceEntries`) returns the loaded rows, and concurrent callers share the promise of one load (`tableLoad`), bounded by `bulkSync.timeout`. `staleKeys` treats a key missing from the store but present in `loaded` as fresh, and `rowsOf` takes each value from, in order: the fresh entry, the rows just fetched, the rows just loaded, the expired entry.
- **A change during a load** is newer than the load, which may have read the old row. While a load waits for its rows (`loadsReading`), every key counts as read (`hasReadInFlight`), so that a change of a key the cache does not hold expires it with no query, and its fence discards the loaded row. Not while the load stores its rows: its evictions beyond `maxEntries` must leave no fence. `loadRows` then leaves out of `loaded` the rows whose `currentTicket` exceeds its ticket, so that neither `staleKeys` nor `rowsOf` uses them: those keys are fetched by key.
- **`loadTable` does not use the engine's bulk sync**: `getAll` decides freshness with `members.isLoaded`, not with the engine's timer.

`fetchRows` is single-flight **per key**: keys already being fetched join those queries, the rest go into one new query (`queryRows`, [line 581](../src/dbCache/LilypadDbCache.ts)), which stores each row with `read.store` (this instance only, not L2, like the table loads) and caches `null` for keys without a row.

`getManyOrFetch(keys)` skips the members: it fetches only the given keys that are stale.

#### dispose

[LilypadDbCache.ts](../src/dbCache/LilypadDbCache.ts): return if already disposed; release the singleton; dispose the engine (from now on, notifications and changelog reads that arrive are ignored); clear the database bookkeeping; then `sync.dispose()`, which unsubscribes from the changelog reader, or waits for a `LISTEN` still starting and removes the listener.

### 4.11 The changelog strategy, end to end

Sections [4.8](#48-the-changelog) and [4.10](#410-lilypaddbcache) describe the parts one at a time: the SQL and the cursor, the reader, how a change is applied, renewal. This section puts them together. It follows one `LilypadDbCache` created with `sync: { strategy: 'changelog', pollInterval }` through its whole life: what runs in the database, what the instance remembers, when it polls, what it does with what it reads, why it can then trust its memory, and what happens when something goes wrong. The traces [5.1](#51-three-concurrent-getorfetch42-on-a-cold-instance), [5.3](#53-an-update-from-psql-reaches-a-serverless-instance), [5.4](#54-sqlupdate-and-its-echo) and [5.5](#55-the-changelog-query-clause-by-clause) run the same code with concrete values.

The code: [LilypadChangelogSync.ts](../src/dbCache/sync/LilypadChangelogSync.ts) (the strategy, about 150 lines), [LilypadChangelogReader.ts](../src/dbGate/LilypadChangelogReader.ts) (batching), [LilypadChangelog.ts](../src/dbGate/LilypadChangelog.ts) (SQL and the query), and the host methods of [LilypadDbCache.ts](../src/dbCache/LilypadDbCache.ts) that the strategy calls.

#### The whole picture

```
 DATABASE                                          ONE INSTANCE
 ────────                                          ────────────
 any writer: this app, other instances,            cache of users          cache of accounts
 a script, psql, another service                   getOrFetch / getAll     getOrFetch / getAll
   │ INSERT / UPDATE / DELETE / TRUNCATE                 │                       │
   ▼                                                     ▼                       ▼
 statement triggers <table>_lilypad_<event>        LilypadChangelogSync    LilypadChangelogSync
   │ same transaction as the write                 cursor,                 (one per cache)
   ▼                                               lastReadMonotonic,
                                                   chainStartedAt, backoff
 lilypad_cache_changes                                   │ read(subscriber)      │
 (xid, table_schema, table_name,                         └──────────┬────────────┘
  row_id, op, changed_at)                                           ▼
   ▲                                               LilypadChangelogReader
   │       one SELECT for every subscribed table   (one per gate and changelog table)
   └──────────── readLilypadChangesBatch ◀──────────────────────────┘
                 → the changes of each table + the next cursor { xmax, xip }
                                                                    │ apply(result), per cache
                                                                    ▼
                                                   applyChange / applyTruncate, mode 'lazy':
                                                   expire or cache null, no row query
```

Three properties shape everything else:

- **The change is recorded in the same transaction as the write.** The trigger runs inside the writing transaction, so its changelog row becomes visible exactly when the write does, and disappears with it on a rollback. A reader never sees a new row version without also being able to see its changelog row.
- **Nothing is pushed.** Instances pull, and only when their cache is read: no timer, no connection kept open. An idle or suspended instance costs the database nothing, and loses nothing either: the changes wait in the table.
- **The database does not know its readers.** Each instance keeps its own cursor in memory. The changelog is shared by every instance and every cached table, and rows leave it only through retention (`pruneLilypadChangelog`, a pg_cron job, or the trigger's `prune` option).

#### What each side keeps

In the database: one changelog row per changed row (one per statement for `TRUNCATE`), until it is pruned. In the instance:

| State                          | Kept by                | Used for                                                                                                                                             |
| ------------------------------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cursor`                       | `LilypadChangelogSync` | Where the next read starts: `{ xmax, xip }`, the transactions the last read could not see ([4.8](#the-cursor-the-transactions-a-read-could-not-see)) |
| `lastReadMonotonic`            | `LilypadChangelogSync` | When the last **applied** read started (`performance.now()`): when the next poll falls due, and whether the cursor is still within `maxGap`          |
| `lastApplied`                  | `LilypadChangelogSync` | When the last read was applied (`performance.now()`, at its end): whether the changes committed up to about now are applied, for `trustedSince()`    |
| `chainStartedAt`               | `LilypadChangelogSync` | Since when the reads form an unbroken chain: what `trustedSince()` returns                                                                           |
| `backoff`                      | `LilypadChangelogSync` | After a failure, when the next read may run                                                                                                          |
| `ownWrites`                    | `LilypadDbCache`       | The `xid` of this instance's own writes, to recognize their echo ([Own writes](#own-writes))                                                         |
| `members` (`LilypadDbMembers`) | `LilypadDbCache`       | Which rows exist, for `getAll` ([Members and getAll](#members-and-getall))                                                                           |

Nothing records which changes were already applied: a cursor read returns each change exactly once, so there is nothing to deduplicate.

#### Step 0: installing

One migration runs `lilypadChangelogSql()` ([LilypadChangelog.ts](../src/dbGate/LilypadChangelog.ts)): the changelog table, its two indexes, the trigger function and its version comment. It also runs `lilypadChangelogTriggerSql({ table, primaryKey })` once per cached table: four statement triggers, see [4.8](#the-sql). The library never runs DDL itself, and the cache checks nothing: `lilypad-doctor` checks the installation against the config ([4.9](#49-the-database-config-and-lilypad-doctor)), and prints this SQL when it is missing.

The distinction matters because the two ways of being misconfigured fail differently. A missing changelog **table** makes every read fail, which is logged at each attempt. Missing **triggers** fail silently: the reads succeed and return nothing, and the cache trusts a chain that sees no change. Only `lilypad-doctor` catches that second case.

#### Step 1: creating the cache

The constructor of `LilypadDbCache` checks the numeric options (`pollInterval` is required and may be `0`) and builds the strategy ([LilypadDbCache.ts](../src/dbCache/LilypadDbCache.ts)). The strategy's constructor ([LilypadChangelogSync.ts](../src/dbCache/sync/LilypadChangelogSync.ts)):

- creates its backoff, with a base of `max(pollInterval, 1 s)`;
- gets the reader shared by every cache of the gate that uses the same changelog table (`getLilypadChangelogReader`, [LilypadChangelogReader.ts](../src/dbGate/LilypadChangelogReader.ts)), and subscribes with two closures: `request` (what to read for me) and `apply` (apply what was read for me).

`start()` resolves at once. Creating the cache opens no connection, which keeps `next build` away from the database. The initial state is `cursor` undefined, `lastReadMonotonic = -Infinity` (not `0`: `performance.now()` starts near 0, so the first read within `pollInterval` of the start would not poll), no chain: the sync is **not trusted**, so nothing is renewed until the first read.

#### Step 2: when a poll happens

`beforeRead()` ([LilypadChangelogSync.ts](../src/dbCache/sync/LilypadChangelogSync.ts)) is called at the start of `getOrFetch`/`getOrFetchDetailed`, `getAll` and `getManyOrFetch`. It is not called by `get` and `peek`, which are synchronous, nor by the writes.

```
now - lastReadMonotonic < pollInterval → undefined: nothing to wait for
backoff not ready                      → undefined
otherwise:
  reading = read()                     reader.read(this.subscriber); errors → backoff.fail() + log
  poll: 'background'                   → runInBackground(reading); return undefined
  poll: 'await' (default)              → return reading: the caller awaits it
```

A few consequences:

- **Polls ride on reads.** A serverless instance cannot keep a timer, so the changelog is read when a read needs it. `pollInterval` then bounds the age of the data **served by the reads that poll**, and an instance nobody uses sends no query. `get()` and `peek()` never poll ([Caveats](#caveats)).
- **Concurrent reads share one poll.** `lastReadMonotonic` moves only once a read has been applied. So while a poll runs, every other read of the cache finds a poll due and calls `read()` again. The reader sees that the running read already includes this subscriber and returns the same promise. A burst of requests on a cold instance costs one changelog query.
- **`beforeRead` never rejects.** `read()` catches, logs `Error reading the changelog:`, and backs off. A broken changelog degrades freshness; it never fails a user's read.
- **`pollInterval: 0`** polls before every async read, each poll still shared by the reads that arrive while it runs.
- With `poll: 'background'`, the read goes through `runInBackground`, so the platform keeps the instance alive until it completes, and the user's read proceeds with the current memory.

#### Step 3: what is read

`reader.read(subscriber)` starts a read, shares the running one, or queues one after it for late subscribers ([4.8](#the-reader-one-query-for-all-the-caches-of-a-gate)). `readAll` ([LilypadChangelogReader.ts](../src/dbGate/LilypadChangelogReader.ts)) takes one `readAt = Date.now()` and one `readAtMonotonic = performance.now()`, and asks **every** subscribed cache for its request, not only the one that triggered the read. `request(readAtMonotonic)` ([LilypadChangelogSync.ts](../src/dbCache/sync/LilypadChangelogSync.ts)) returns one of two things:

- `{ cursor }` if the cache has a cursor and `readAtMonotonic - lastReadMonotonic <= maxGap`: a **trusted** read, which continues the chain;
- `{ lookback }` otherwise: an **untrusted** read of the changes of the last `lookback` ms (`sync.lookback`, or by default TTL + `staleWhileRevalidate` + 1 minute, from `defaultLookback` at [LilypadDbCache.ts](../src/dbCache/LilypadDbCache.ts)). This happens on the first read, or after a gap longer than `maxGap`.

Two clocks, one per use. The intervals (`pollInterval`, `maxGap`) are measured on `readAtMonotonic`: on the wall clock, a step back (an NTP correction, a resumed virtual machine) would stop the polls until the clock caught up, and keep trusting a chain broken for longer than `maxGap`. `readAt` stays on the wall clock, because `chainStartedAt`, which `trustedSince()` returns, is compared with the `fetchedAt` of the entries.

All the requests go into one `readLilypadChangesBatch` ([LilypadChangelog.ts](../src/dbGate/LilypadChangelog.ts), clause by clause in [5.5](#55-the-changelog-query-clause-by-clause)). It returns the changes of each request, and **one** next cursor taken from the snapshot of that statement, which is valid for every request. Caches in different states share the query: an old cache continuing its cursor and a new one reading a lookback are served by the same statement. Each cache's `apply` then runs under `Promise.allSettled`, so one failing cache does not stop the others.

#### Step 4: applying what was read

`apply` ([LilypadChangelogSync.ts](../src/dbCache/sync/LilypadChangelogSync.ts)):

1. If the cache was disposed meanwhile, stop.
2. **Untrusted read** (a lookback): `expireEverything()` ([LilypadCacheEngine.ts](../src/cache/LilypadCacheEngine.ts)). Every entry is expired, which means never served stale but still usable as an `onError` fallback. `ticketFloor` is raised, so reads in flight, which may have read rows before changes this instance never saw, store nothing. Then `chainStartedAt = readAt`: a new chain starts.
3. Apply each change, in the order they were recorded (`ORDER BY id`): `TRUNCATE` → `applyTruncate('lazy')` ([LilypadDbCache.ts](../src/dbCache/LilypadDbCache.ts)), any other operation → `applyChange(op, rowId, 'lazy', xid)`.
4. `forgetOwnWritesCoveredBy(cursor)`: drop the own writes whose change this read has returned or can no longer return. Transactions still in `xip` are kept.
5. Store the new `cursor`, set `lastReadMonotonic = readAtMonotonic`, reset the backoff.
6. `emitInvalidation('changelog', keys, { wholeCache: truncated })`: `platform.onInvalidate` in the background, e.g. to expire tags of a CDN or of the Runtime Cache.

If steps 3 to 6 throw, the error is logged (`Error applying the changelog:`) and the backoff grows. Neither the cursor nor `lastReadMonotonic` moves, so the next read, after the backoff, returns the same changes again. Applying a change twice is harmless: expiring an entry twice or caching `null` twice changes nothing. The only cost is an own write, already consumed by the first attempt, which is applied as a foreign change and costs one fetch.

What each change does, in `lazy` mode. A key is "held" if it has an entry or a read of it is in flight:

| Change                                                                                                   | Key held                                                                                                                                                                           | Key not held                                                                  |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| The echo of an own write (its `xid` is in `ownWrites`, and the entry still has the ticket of that write) | Skipped: the entry already holds the row the write returned                                                                                                                        | —                                                                             |
| `INSERT` / `UPDATE`                                                                                      | Added to `members`, then `markInvalid`: expired (`expirationTime: 0`, `invalidatedAt`), a new ticket that discards a read in flight, the L2 copy deleted. The next read fetches it | Added to `members`, the L2 copy deleted. No entry, no query                   |
| `DELETE`                                                                                                 | `engine.set(key, null)`: cached as `null`, even for a protected key. The `null` entry also stops a read in flight from storing the deleted row                                     | Removed from `members` and from L2. No entry, so a mass delete evicts nothing |
| `TRUNCATE`                                                                                               | Every entry expired and its L2 copy deleted; L2 copies older than now refused (`rejectSharedBefore`); `members` emptied, so the table is known to be empty with no query           | (same)                                                                        |

The changelog carries the key as text; `resolveNotifiedKey` turns `'7'` back into `7` when the entry, the member or the schema says the key is a number ([3.6](#36-keys-are-compared-by-their-string-form)).

Two design choices in that table. **Changes are applied lazily**, by expiring rather than re-fetching: one poll can return hundreds of changes (a batch job, a cold start's lookback), and most of them concern rows nobody will read again on this instance. **The L2 copy is deleted even for keys this instance does not hold**, because another instance may have written a copy fetched before the change. Every instance that reads the change deletes it again; the deletes are redundant but idempotent.

#### Step 5: trust, and what it buys

`trustedSince()` ([LilypadChangelogSync.ts](../src/dbCache/sync/LilypadChangelogSync.ts)) is `undefined` without a cursor, when the last applied read is older than `maxGap`, or when no read was applied within `pollInterval` (two intervals with `poll: 'background'`), and `chainStartedAt` otherwise.

Why an unbroken chain means "this instance sees every change". The chain starts with a lookback read, which expired everything held at that moment and discarded the reads in flight. Every later read starts exactly where the previous one stopped (the cursor), and the cursor reads return each change exactly once, whatever the order of the commits ([4.8](#the-cursor-the-transactions-a-read-could-not-see)). Take an entry fetched after `chainStartedAt` that no change has invalidated. A change of its row made after the fetch would have been returned by one of the reads since, and would have invalidated the entry. So the entry is up to date **as of the last applied read**, which is why the trust also needs that read to be recent: `get` never reads the changelog, and a read may fail, while the chain itself holds for up to `maxGap`.

Two things rely on it:

- **Renewal** ([Trust and renewal](#trust-and-renewal)): an entry that reaches its TTL with no change is extended without a query, up to `maxAge`. With the changelog, the TTL costs no query while the chain holds.
- **`getAll`**: `members.isLoaded()` ([LilypadDbMembers.ts](../src/dbCache/LilypadDbMembers.ts)) is true when the table was loaded after the chain started. `getAll` then never reloads the whole table; it fetches only the members whose entries are missing or invalidated.

When no read was applied for `pollInterval` (reads failing, or none triggered), `trustedSince()` is `undefined` until the next applied read, which continues the chain. When the chain breaks (no applied read for `maxGap`), `trustedSince()` turns `undefined` too. Entries then expire at their TTL, and `getAll` trusts its members only for `bulkSync.ttl`. The next successful read is a lookback, which expires everything and starts a new chain.

#### A timeline

`pollInterval: 5 s`, TTL 60 s, no stale window, so `lookback` is 120 s; `maxGap` and `maxAge` 1 h.

```
t = 0       cold start. getOrFetch(7): a poll is due (no read yet).
            No cursor → lookback read of the last 120 s. The query returns the changes of other
            instances' writes and cursor c1. apply (untrusted): expireEverything (nothing yet),
            chainStartedAt = 0, the changes delete their L2 copies. Then row 7 is fetched.
t = 3 s     getOrFetch(7): 3 s < pollInterval, no poll. L1 hit.
t = 61 s    getOrFetch(7): poll from c1, no change of 7, cursor c2.
            renew(7): past its TTL, fetched after the chain started, younger than maxAge
            → kept until min(61 s + 60 s, 0 + 1 h). No row query.
t = 80 s    psql: UPDATE ... WHERE id = 7. The trigger records it in the same transaction.
t = 82 s    getOrFetch(7): poll from c2 returns UPDATE 7 → markInvalid(7) → fetch. Fresh row.
            (the instance is then suspended)
t = 40 min  getOrFetch(7): 40 min < maxGap, so still a cursor read. It returns every change
            of the last 40 minutes, in one query, applied without row queries. The chain holds,
            so unchanged entries are still renewed.
t = 3 h     getOrFetch(7): 3 h > maxGap. Untrusted: lookback read, expireEverything,
            new chain from now. Row 7 is fetched again.
```

#### Choosing the options

| Option         | Default           | What it controls                                                                                                                                                | Keep it                                                                                                     |
| -------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `pollInterval` | required          | How old the data served by a polling read can be, for changes made elsewhere; at most one changelog query per interval per instance (for all its cached tables) | Well below `maxGap`: otherwise every poll is a lookback and the chain never holds                           |
| `poll`         | `'await'`         | Whether a read that falls due waits for the poll                                                                                                                | `'background'` only if the latency of one small query matters more than freshness (see [Caveats](#caveats)) |
| `maxGap`       | 1 h               | How long the chain is trusted without an applied read                                                                                                           | Far below the retention of the changelog (`olderThan`)                                                      |
| `lookback`     | TTL + SWR + 1 min | How far back an untrusted read looks                                                                                                                            | At least the lifetime of an L2 copy (TTL + SWR), and far below the retention                                |
| `maxAge`       | 1 h               | How long a trusted entry can outlive its TTL                                                                                                                    | Low if the triggers are sometimes bypassed (`0` disables renewal)                                           |

They are options of the `sync` of the table, in the config; the changelog table is `changelog.table` of the config, shared by its tables. `create` can override `pollInterval`, `poll` and `maxAge` for one cache: not `maxGap` or `lookback`, which set the retention that `lilypad-doctor` checks.

Why the inequalities:

- **Retention must exceed `maxGap`.** Say an instance reads from its cursor after a gap just under `maxGap`. It needs every changelog row written since that cursor. If pruning has already deleted some, the read returns fewer changes, and the cache, still trusting its chain, never learns about the missing ones. The library cannot detect this: the cursor works on transaction ids, pruning on timestamps. That is why the recommended retention is 24 h against a `maxGap` of 1 h.
- **`lookback` must cover the lifetime of an L2 copy.** Why read a lookback at all on a cold instance whose memory is empty? Because the shared level is not empty. Another instance may have written a copy of a row there before a change that this instance has never seen. Applying the lookback's changes deletes those copies (and a `TRUNCATE` refuses every older copy). An L2 copy lives at most TTL + SWR, and never longer than `lookback` after it was fetched, even with a `ttl` or `staleWhileRevalidate` given to `getOrFetch` (the engine hook `maxSharedAge`), so older changes cannot have left a stale copy behind.
- **`lookback` must stay below the retention**, for the same reason as `maxGap`: beyond it, the read silently returns less.

#### When something goes wrong

| What                                                                                                                   | What happens                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The changelog cannot be read (database down, table missing, no privilege)                                              | The user's read goes on with the current memory. The error is logged and the backoff starts (from `max(pollInterval, 1 s)`, doubling up to 1 min). `lastReadMonotonic` does not move, so the chain is still trusted, and entries still renewed, until `maxGap` after the last applied read. A changelog that stays broken therefore delays changes by up to `maxGap`, not `pollInterval` |
| One cache fails to apply its changes                                                                                   | That cache keeps its cursor and backs off; the others, applied under `allSettled`, are unaffected. The same changes come back at its next read                                                                                                                                                                                                                                           |
| The triggers are missing (the table exists)                                                                            | Every read succeeds and returns nothing for that table: the cache trusts a chain that sees no change. Only `lilypad-doctor` reports it, with the SQL that fixes it                                                                                                                                                                                                                       |
| The triggers are bypassed (`ALTER TABLE ... DISABLE TRIGGER`, `session_replication_role = replica` as in `pg_restore`) | The change is never recorded. Entries are renewed until `maxAge`, which is the only bound                                                                                                                                                                                                                                                                                                |
| The cache is disposed while a read is in flight                                                                        | `apply` returns at its first line; `dispose` unsubscribes from the reader, which garbage collects with the gate                                                                                                                                                                                                                                                                          |

#### Caveats

- **Trust is measured against `maxGap`, not against `pollInterval`.** After an instance has been idle for a while (less than `maxGap`), its chain is still trusted, although the changes of the idle period have not been read yet. Reads that poll and wait (`getOrFetch`, `getAll` with `poll: 'await'`) apply them first, so they are unaffected. But `get()`, `peek()`, and the reads with `poll: 'background'` renew entries **before** that poll is applied. They can serve a row that changed while the instance was idle, up to the length of the idle period.
- **A transaction longer than the retention.** `changed_at` is the time of the write, not of the commit. A transaction that stays open longer than the retention, and commits just before a prune, can have its changelog rows deleted before any instance reads them. Keep the retention far above the longest transaction.
- **Own writes are forgotten after 10 minutes** (`OWN_WRITE_RETENTION`, [LilypadDbCache.ts](../src/dbCache/LilypadDbCache.ts)), besides being pruned by the cursor. On an instance idle for longer, the echo of its own write is applied as a foreign change: one extra fetch, never a wrong value.
- **A write-heavy table** makes each poll return many rows, and every cold start's lookback returns every change of the last `lookback` ms. That stays one query, and applying changes of rows not held costs no row query, but the size of the result grows with the write rate.
- **The shared level has a rare race**, described in the [Known limits of the Next.js guide](nextjs-vercel.md#9-known-limits): keep the TTL of database caches with `shared` short.

#### What it costs

- **Database, on each write:** the statement trigger adds one `INSERT ... SELECT` per statement (not per row) to the writing transaction, plus the maintenance of two indexes. With `notifyChannel` left on, it also sends one `pg_notify` per row.
- **Database, on reads:** one indexed query per instance per `pollInterval`, only while the instance is used, for all its cached tables. The row queries are made only for held keys that changed and are then read again. The instance that wrote a row queries nothing afterwards ([5.4](#54-sqlupdate-and-its-echo)).
- **Database, on each write, with the `prune` option:** on about one statement in `every`, an indexed lookup of the rows older than the retention, and the deletion of up to `batchSize` of them (`FOR UPDATE SKIP LOCKED`, so concurrent prunes never wait for each other). It runs in the writing transaction, only in `READ COMMITTED`: in `REPEATABLE READ` or `SERIALIZABLE`, deleting a row that a concurrent prune deleted raises a serialization failure, which would fail the write. The deletion is a `SECURITY DEFINER` function without parameters, so the writing roles need no `DELETE` privilege, and calling it by hand does nothing the trigger would not do. It names the changelog with its schema and searches `pg_temp` last (`SET search_path = pg_catalog, pg_temp`): otherwise a role could create a temporary table of the same name, which PostgreSQL searches first, and make the function delete from it with the privileges of its owner. The trigger function records the options in a comment (`lilypad-prune: ...`), which the schema check reads to keep them in the SQL it suggests.
- **Storage:** one row per changed row, bounded by the retention (`olderThan`).

The tests of the strategy are the `changelog sync`, `database traffic`, `changelog failures and reads in flight` and `own writes and the changelog cursor` groups of [LilypadDbCache.test.ts](../src/dbCache/LilypadDbCache.test.ts). The cursor itself is tested against PostgreSQL in [LilypadDbGate.integration.test.ts](../src/dbGate/LilypadDbGate.integration.test.ts) ("should not miss a transaction that commits after a later one", "should not return again the changes committed while a long transaction runs").

---

## 5. Line by line: five traces

Each trace follows one scenario through the code. Line numbers are links; keep the source open next to this document.

### 5.1 Three concurrent `getOrFetch(42)` on a cold instance

Setup: a `LilypadDbCache` of `users` with `sync: { strategy: 'changelog', pollInterval: 5000 }`, no shared level, just created. Three requests call `users.getOrFetch(42)` in the same tick. Call them A, B and C.

**A:**

1. `getOrFetch` → `getOrFetchDetailed` ([DbCache 673](../src/dbCache/LilypadDbCache.ts)): `assertNotDisposed()`, then `this.sync.beforeRead()` (line 680) → `LilypadChangelogSync.beforeRead`. `lastReadMonotonic` is `-Infinity`, so a poll is due. `read()` → `reader.read(subscriber)`: nothing is running, so `start()` includes every subscriber and runs `readAll`.
2. `readAll` calls `subscriber.request(readAtMonotonic)` → `request`: no cursor yet, so `{ lookback: ttl + swr + 60 000 }`. Then the batched query runs. A awaits it.

**B and C** arrive while A is awaiting. `lastReadMonotonic` is still `-Infinity` (it is set only after the read is applied), so their `beforeRead` also calls `reader.read(subscriber)`. This time `current` exists and includes the subscriber, so they get **the same promise**. One query for three callers.

**The read completes.** `apply(result, trusted = false)`: the request was a lookback, so `expireEverything()` (nothing to expire yet, but `ticketFloor` rises to, say, 3) and the chain of trust starts at `readAt`. The returned changes are applied (keys not held: only L2 deletes and members). Cursor stored, `lastReadMonotonic = readAtMonotonic`.

**A resumes**: `renew('42')` does nothing (no entry). `getOrSetDetailed`: no local entry, no shared level, no stale entry, no cooldown → `fetchAndStore`:

- `fetches.join('42', currentTicket('42'))`: nothing in flight;
- `beginRead()` takes ticket 4, and `executeWithTimeout(fn, 5000)` starts `valueFn` **synchronously**: it sends `SELECT ... WHERE id = 42`;
- `fetches.start(['42'], 4, fetching)` registers the fetch. No `await` happened since the lookup.

**B resumes** (its promise resolved in the same microtask batch): same path down to `fetchAndStore`, where `fetches.join('42', 3)` finds A's fetch (ticket 4 > 3: it started after the last change of the key) and returns its promise. **C** does the same.

**The row arrives.** Back in `fn`: `signal.aborted` is false, so `read.storeFetched(42, row)`: no failure to clear; `setIfNewer` compares ticket 4 with `currentTicket('42')`: no entry, no fence, floor 3, and `4 > 3`, so it stores. `writeEntry` → `onValueStored` (members are not tracked yet, since the table was never loaded) → no eviction. `writeShared` does nothing (no shared level). The settle handler of `LilypadReadFlights` forgets the fetch.

All three callers resolve to `{ value: row, status: 'MISS', refreshFailed: false }`. Totals: one changelog query, one row query.

### 5.2 A slow fetch loses to a write

Four variations, with explicit ticket numbers.

**(a) The key has an entry.**

| Step                                     | Code                                           | Ticket    |
| ---------------------------------------- | ---------------------------------------------- | --------- |
| Entry `a` exists, expired                |                                                | entry = 3 |
| `getOrSet('a', slowFn)` starts the fetch | `beginRead()`                                  | read = 4  |
| `set('a', v2)`                           | `engine.set` → `writeLocal` → `nextTicket()`   | entry = 5 |
| `slowFn` resolves with `v1`              | `setIfNewer(..., 4)`: `4 <= currentTicket = 5` | discarded |

The caller of `getOrSet` receives `v1`; the cache keeps `v2`.

**(b) The key has no entry, and is invalidated during the fetch.**

| Step                                                            | Code                                                      | Ticket       |
| --------------------------------------------------------------- | --------------------------------------------------------- | ------------ |
| `getOrSet('b', slowFn)` starts                                  | `beginRead()`                                             | read = 6     |
| A change for `b` → `markInvalid('b')` → `expireNormalized('b')` | no entry, but `hasReadInFlight('b')` → fence              | fence(b) = 7 |
| `slowFn` resolves                                               | `setIfNewer(..., 6)`: `currentTicket = max(floor, 7) = 7` | discarded    |

Without the fence, the fetch, which may have read the row _before_ the change, would have cached the old row.

**(c) The key is invalidated, then its entry is purged, during the fetch.**

| Step                                                         | Code                                                        | Ticket        |
| ------------------------------------------------------------ | ----------------------------------------------------------- | ------------- |
| Entry `c` exists                                             |                                                             | entry = 8     |
| `getOrSet('c', slowFn, { skipCache: true })` starts          | `beginRead()`                                               | read = 9      |
| A change for `c` → `expireNormalized('c')`                   | the entry is rewritten with `expirationTime: 0`             | entry = 10    |
| `cleanupOnAccess` → `purgeExpired` removes the expired entry | `dropEntry`: a read is in flight → fence = entry ticket     | fence(c) = 10 |
| `slowFn` resolves with the row read before the change        | `setIfNewer(..., 9)`: `currentTicket = max(floor, 10) = 10` | discarded     |

Without `dropEntry`'s fence, the key would have no entry and no fence at this point, and the pre-change row would be stored; in a `LilypadDbCache` it would then be renewed until `maxAge`.

**(d) A bulk sync completes while a fetch of a missing key runs.**

| Step                                     | Code                             | Ticket     |
| ---------------------------------------- | -------------------------------- | ---------- |
| `getOrSet('d', slowFn)` starts           |                                  | read = 11  |
| `bulkSync()` starts                      | `beginRead()` in `startBulkSync` | sync = 12  |
| The sync's data has no `d`; it completes | `ticketFloor = 12`               | floor = 12 |
| `slowFn` resolves with an old `d`        | `11 <= max(12, …)`               | discarded  |

### 5.3 An `UPDATE` from `psql` reaches a serverless instance

Setup: an instance holds `accounts` row `7` (fresh from a fetch 30 s ago, ticket 40); `sync: changelog`, `pollInterval: 5000`, `shared` configured. Someone runs `UPDATE accounts SET plan = 'pro' WHERE id = 7;` in `psql`.

**In the database.** The statement trigger `accounts_lilypad_update` fires `AFTER UPDATE FOR EACH STATEMENT` with the transition tables `lilypad_old` and `lilypad_new`, and calls `lilypad_cache_changes_record('id')`. The key `'7'` is in both, so there is no extra `DELETE`. It inserts `(table_schema 'public', table_name 'accounts', row_id '7', op 'UPDATE')`; `xid` defaults to `pg_current_xact_id()`, say 9100. It also sends a `pg_notify`, which nobody hears on Vercel.

**On the instance**, the next request calls `accounts.getOrFetch(7)`:

1. `beforeRead`: 5 s have passed since the last read, so the reader builds requests for **every** subscribed cache of the gate, e.g. `[{ accounts, cursor: { xmax: 9050, xip: [] } }, { users, cursor: … }]`, and runs one query.
2. The query returns the next cursor (say `{ xmax: 9121, xip: [9120] }`: transaction 9120 is still running) and, for request 0, the change `{ id: '551', xid: 9100n, rowId: '7', op: 'UPDATE' }`.
3. `apply(result, trusted = true)` → `applyChange('UPDATE', '7', 'lazy', 9100n)`:
   - `resolveNotifiedKey('7')` finds the entry and returns its key, the number `7`;
   - `ownWrites.consume(7, 9100n)`: no own write for `7` → `false`;
   - the entry exists → held → `members.add` → `markInvalid(7)`: `expireNormalized` rewrites the entry with `expirationTime: 0`, ticket 55, `invalidatedAt: now`; `deleteShared(7)` removes the `v` key of `7` from L2 in the background; the next bulk sync is forced.
   - Back in `apply`: the own writes covered by the new cursor are forgotten; cursor stored; a `changelog` event with the tag `lilypad:accounts:7`.
4. `renew('7')`: `expirationTime === 0`, so no renewal.
5. `getOrSetDetailed`: the L1 entry is expired. L2: suppose another instance, which has not polled yet, writes its old copy back just now. `adoptShared` refuses it: `remote.fetchedAt < current.invalidatedAt`. Stale window: `staleUntil` is `0` for an invalidated entry, so not served stale. Fetch: `SELECT ... WHERE id = 7` returns `plan = 'pro'`, stored with a ticket greater than 55.

The change reached the instance within `pollInterval`, with one changelog query (shared with every other cached table of the gate) and one row query. The next poll asks for `xid >= 9121 OR xid = ANY({9120})`: change 551 is not returned again.

### 5.4 `sqlUpdate` and its echo

Same instance. The application calls `accounts.sqlUpdate({ id: 7, plan: 'team' })`.

1. `sqlUpdate`: not disposed; `key = 7`; `writing` counts the write of `'7'` in flight, and `startTicket = nextTicket()` = 60.
2. `table.update` → `prepareWrite`: the `write` hook, if any; primary key present; with `generatedPrimaryKey` the `id` is removed from the data (it only identifies the row); `columns = ['plan']` (only the declared columns that are not `undefined`).
3. SQL: `UPDATE "accounts" SET "plan" = $1 WHERE "id" = $2 RETURNING "id", "email", "plan", pg_current_xact_id()::text AS "__lilypad_xid"`. `writeResult` strips `__lilypad_xid` and returns `{ row, xid: 9200n }`.
4. `storeWritten(7, row, 60, 9200n)`: `currentTicket('7')`, the entry's ticket (say 58), is not greater than 60, so nothing interfered. `engine.set(7, row)` → ticket 61, and the row is written to L2. `ownWrites.record('7', 9200n, 61)`.
5. `emitInvalidation('write', [7])`: `platform.onInvalidate` can call `revalidateTag('lilypad:accounts:7')`.

**Five seconds later**, a poll returns the trigger's change `{ xid: 9200n, rowId: '7', op: 'UPDATE' }`. `applyChange` → `ownWrites.consume(7, 9200n)`: the xid is in the set (removed now), and the entry's ticket is still 61 → `true` → return. No expiry, no query.

**Variation:** the poll ran while transaction 9200 was still committing, so its cursor lists 9200 in `xip` and does not return the change. `forgetOwnWritesCoveredBy` keeps 9200 (`lilypadCursorCovers` is false for a transaction in `xip`), and the next poll returns the change and recognises it.

**Variation:** between step 4 and the poll, another instance updated row 7, and this instance applied that change first (ticket 70). At the echo, `store.get('7').ticket` is 70, not 61 → `ownWrites.consume` returns `false`, and the echo is applied normally. That is correct: the entry no longer holds our write's result.

**Variation:** while the `UPDATE` of step 3 was running, a poll applied someone else's change to row 7 (entry ticket becomes 62 > 60). The library cannot know which write committed last, so `storeWritten` calls `markInvalid` instead of caching the row, and the next read queries the database.

### 5.5 The changelog query, clause by clause

[LilypadChangelog.ts](../src/dbGate/LilypadChangelog.ts). The inputs are four parallel text arrays, one element per request: the quoted table reference, the cursor's `xmax` (or `''`), the cursor's `xip` joined by commas, and the lookback in seconds.

```sql
WITH snapshot AS (
  SELECT pg_snapshot_xmax(current.s)::text AS next_xmax,
    (SELECT coalesce(string_agg(x::text, ','), '') FROM pg_snapshot_xip(current.s) AS x) AS next_xip
  FROM (SELECT pg_current_snapshot() AS s) AS current
),
```

The next cursor: the transactions this statement cannot see. `pg_current_snapshot()` returns the snapshot the statement reads with, so the cursor and the rows below are consistent.

```sql
requests AS (
  SELECT (r.ordinality - 1)::int AS request, r.table_ref,
    NULLIF(r.since_xmax, '')::xid8 AS since_xmax,
    string_to_array(NULLIF(r.since_xip, ''), ',')::xid8[] AS since_xip,
    r.lookback_secs::float8 AS lookback_secs
  FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) WITH ORDINALITY AS r(...)
),
```

Turns the four arrays back into rows, numbered from 0 so that each result row can be routed to `changes[request]`. An empty `xmax` becomes `NULL`, meaning "use the lookback"; an empty `xip` becomes `NULL`, and `= ANY(NULL)` matches nothing.

```sql
targets AS (
  SELECT requests.*, n.nspname AS schema_name, t.relname AS rel_name
  FROM requests
  JOIN pg_class t ON t.oid = to_regclass(requests.table_ref)
  JOIN pg_namespace n ON n.oid = t.relnamespace
),
```

Resolves each table the way the gate's own queries do: an unqualified name goes through the `search_path`. The result is the real schema and name, so that `accounts` in `public` is not mixed up with `accounts` in `archive`.

```sql
SELECT snapshot.next_xmax, snapshot.next_xip, targets.request, c.id::text, c.xid::text, c.row_id, c.op
FROM snapshot
LEFT JOIN targets ON true
```

`snapshot` is always one row, and the `LEFT JOIN`s keep it even if there are no targets or no changes, so the next cursor always comes back (the code throws if it does not, line 305).

```sql
LEFT JOIN LATERAL (
  SELECT ... FROM changelog c
  WHERE targets.since_xmax IS NOT NULL
    AND c.table_name = targets.rel_name
    AND (c.table_schema = targets.schema_name OR c.table_schema IS NULL)
    AND (c.xid >= targets.since_xmax OR c.xid = ANY(targets.since_xip))
  UNION ALL
  SELECT ... FROM changelog c
  WHERE targets.since_xmax IS NULL
    AND c.table_name = targets.rel_name
    AND (c.table_schema = targets.schema_name OR c.table_schema IS NULL)
    AND c.changed_at >= clock_timestamp() - make_interval(secs => targets.lookback_secs)
) c ON true
ORDER BY c.id
```

For each target, one of the two branches returns rows (the other one's first condition is false). Splitting them in a `UNION ALL` lets each branch use its own index: `(table_name, xid)` for cursor reads (a range for `xid >= xmax`, point lookups for the few running transactions), `(changed_at)` for lookbacks. `table_schema IS NULL` accepts rows written by a version 1 trigger, which did not record the schema. `ORDER BY c.id` applies the changes in the order they were recorded.

---

## 6. Glossary and where to go next

| Term                      | Meaning                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Engine**                | `LilypadCacheEngine`, shared by `LilypadCache` (public writes) and `LilypadDbCache` (values from its table only)                       |
| **L1**                    | The memory of one instance (`store`)                                                                                                   |
| **L2** / shared level     | A key-value store shared by all instances (`platform.shared`, e.g. the Vercel Runtime Cache), handled by `LilypadSharedLevel`          |
| **Ticket**                | A number from an ever-increasing counter that orders writes; a read stores its result only if its ticket beats the key's               |
| **Floor** (`ticketFloor`) | The ticket that reads of _missing_ keys must beat; raised by bulk syncs and `expireEverything`                                         |
| **Fence**                 | A per-key floor, set when a missing key is expired, or an entry removed, while a read of it runs                                       |
| **Single-flight**         | Concurrent calls for the same identifier share one execution                                                                           |
| **Fallback**              | A value returned after a failed fetch (`onError`), cached locally with `origin: 'fallback'`                                            |
| **Cooldown**              | After a failed fetch, the key is not fetched again for `failureCooldown` ms                                                            |
| **Stale** / SWR           | An expired value served while it is refreshed in the background, within `staleWhileRevalidate`                                         |
| **Invalidated**           | `expirationTime === 0`: expired, never served stale, still a fallback                                                                  |
| **Bulk sync**             | Replacing the whole cache with `bulkSync.fn`; "fresh" while `now < bulkSyncExpirationTime`                                             |
| **Members**               | The keys that `LilypadDbCache` knows to exist in its table, used by `getAll`                                                           |
| **Strategy**              | How a `LilypadDbCache` follows its table: `LilypadListenSync`, `LilypadChangelogSync` or `lilypadNoSync`                               |
| **Trusted sync**          | `LISTEN` active with recent heartbeats, or the changelog read within `pollInterval` and unbroken: the cache sees every change          |
| **Heartbeat**             | A notification the gate sends itself; while they come back, `isListenHealthy()` is true                                                |
| **Renew**                 | Extending an expired, trusted, unchanged entry without a query, up to `maxAge`                                                         |
| **Cursor**                | For the changelog: `{ xmax, xip }`, the transactions the last read could not see; the next read returns their changes                  |
| **Lookback**              | A changelog read by time instead of cursor, when the cursor is missing or too old                                                      |
| **Eager / lazy**          | How a change is applied: a notification is a hint, re-read now (`eager`); a changelog row is trusted, applied without a query (`lazy`) |
| **Own write**             | A change made by this instance's `sqlCreate`/`sqlUpdate`/`sqlDelete`, recognised by its `xid`                                          |

**Where to go next.** The tests are the best executable documentation of the edge cases, and each describes one behaviour by name:

- [LilypadCache.test.ts](../src/cache/LilypadCache.test.ts): tickets, fences (including "entries removed while a read is in flight"), bulk sync, eviction (everything runs on fake timers, `vi.advanceTimersByTimeAsync`);
- [LilypadCache.shared.test.ts](../src/cache/LilypadCache.shared.test.ts): L2, its key format, stale-while-revalidate and the cooldown, with an in-memory store that clones values;
- [LilypadDbCache.test.ts](../src/dbCache/LilypadDbCache.test.ts): the sync strategies, untrusted notifications, `getAll`, own writes, against an in-memory fake gate and a mocked changelog;
- [LilypadChangelogReader.test.ts](../src/dbGate/LilypadChangelogReader.test.ts), [LilypadSchemaCheck.test.ts](../src/dbGate/LilypadSchemaCheck.test.ts) and [LilypadSchemaShape.test.ts](../src/dbGate/LilypadSchemaShape.test.ts): the batching of changelog reads, and every rule of the schema check, without a database;
- [LilypadDbConfig.test.ts](../src/dbConfig/LilypadDbConfig.test.ts) and [loadLilypadDbConfig.test.ts](../src/dbGate/loadLilypadDbConfig.test.ts): how a config is validated and resolved, and how its file is found;
- [LilypadDbGate.integration.test.ts](../src/dbGate/LilypadDbGate.integration.test.ts): the real thing against PostgreSQL in Docker, including the out-of-order commit test for the changelog cursor ("should not miss a transaction that commits after a later one"), the long-transaction test, the heartbeat, a reference `NOTIFY` trigger, and the shape check (the fix SQL creates the tables of a config, and the check then finds nothing).

To see a behaviour in action, run a single test by name: `npx vitest run --project unit -t "<part of the test name>"`.
