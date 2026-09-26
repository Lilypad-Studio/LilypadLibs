# How @lilypad/libs works

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

`@lilypad/libs` is mostly an answer to those three questions. Its centre is a **cache that stays correct**: it deduplicates concurrent fetches, orders every write so that an older result can never overwrite a newer one, and learns about database changes through a changelog table or `LISTEN/NOTIFY`. Everything else in the library either supports that cache or is a small, self-contained utility that came along:

```
            ┌──────────────────────────────────────────────────────────┐
  you  ───> │ LilypadDbCache    a cache of one table, kept in sync     │
            │ LilypadCache      the generic cache, public writes       │
            ├──────────────────────────────────────────────────────────┤
            │ LilypadCacheCore  the engine: TTL, single-flight, write  │
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
2. **The library must not depend on any hosting platform.** It knows nothing about Next.js or Vercel. It declares the few capabilities it can *use* (background work, a shared cache, an invalidation hook) and the application plugs them in. Without them, it behaves as on a plain long-running Node.js server.

---

## 2. The map

### 2.1 Modules and dependencies

```
src/
├── singleton/LilypadSingleton.ts   process-wide registry on globalThis
├── platform/LilypadPlatform.ts     the platform contract + 4 helpers
├── internal/
│   ├── LilypadValidation.ts        checks of numeric options
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
│   ├── LilypadCacheCore.ts         the engine of both caches (≈1180 lines)
│   ├── LilypadSharedLevel.ts       the shared level (L2): keys, envelopes, locks
│   ├── LilypadCache.ts             the generic cache: the engine with public writes
│   ├── LilypadDbCache.ts           the table cache (≈950 lines)
│   └── dbSync/
│       ├── LilypadDbSyncTypes.ts   sync options, the strategy and host interfaces
│       ├── LilypadListenSync.ts    the `listen` strategy
│       ├── LilypadChangelogSync.ts the `changelog` strategy
│       └── LilypadSchemaVerifier.ts the once-per-cache schema check
├── dbGate/
│   ├── LilypadDbGate.ts            postgres.js wrapper, CRUD, LISTEN
│   ├── LilypadListenHeartbeat.ts   is the LISTEN connection still delivering?
│   ├── LilypadChangelog.ts         changelog SQL + the cursor read
│   ├── LilypadChangelogReader.ts   one batched read for all caches of a gate
│   └── LilypadSchemaCheck.ts       reads the catalogs, then evaluates them
├── entries/*.ts                    the public subpaths
└── index.ts                        the root entry (everything but db)
```

Who uses whom (arrows point to what is used):

```
LilypadCache ───extends──┐
                         ├──> LilypadCacheCore ──uses──> LilypadFlowControl, LilypadSharedLevel,
LilypadDbCache ─extends──┘                               platform helpers (runInBackground, ...)
   │
   ├──uses──> a sync strategy: LilypadListenSync | LilypadChangelogSync | lilypadNoSync
   │             │                   │
   │             │                   └──uses──> LilypadChangelogReader ──> readLilypadChangesBatch
   │             └──uses──> LilypadDbGate (addListener, isListenHealthy)
   ├──uses──> LilypadSchemaVerifier ──uses──> checkLilypadSchema
   └──uses──> LilypadDbGate ──uses──> postgres.js, node:crypto, LilypadListenHeartbeat

every module ──logs through──> libLog(logger, level, name, ...)
LilypadLogger, LilypadDbGate, LilypadDbCache ──register in──> the singleton registry
```

Three observations help when reading the code:

- **The two caches share one engine.** `LilypadCacheCore` holds the hard concurrency logic. Its public methods only read, expire or remove entries; the methods that write values, and the bulk reads (`set`, `bulkSet`, `getOrSet`, `getOrSetDetailed`, `bulkSync`, `getMany`, `entries`, `getAllEntries`) are `protected`. `LilypadCache` re-declares them as public; `LilypadDbCache` keeps them internal, so that its values always come from its table (a value written with a public `set` would otherwise be renewed past its TTL as if the database had returned it).
- **`LilypadDbCache` delegates how it follows the table to a strategy object.** The cache keeps the data logic (`applyChange`, `applyTruncate`, members, renewal); the strategy decides *when* changes arrive and *whether* the cache can trust that it sees them all. The two talk through small interfaces ([`LilypadDbSyncHost`, `LilypadDbSyncStrategy`](../src/cache/dbSync/LilypadDbSyncTypes.ts#L132)).
- **Nothing in the lower layers knows about the upper ones.** `LilypadFlowControl` knows nothing about caches; `LilypadDbGate` knows nothing about caching; `LilypadCacheCore` knows nothing about databases.

### 2.2 How the package is cut

The package is published as several **subpath entries**, one per module ([src/entries/](../src/entries/)): `@lilypad/libs/logger`, `/cache`, `/flow`, `/serializer`, `/singleton`, `/platform` and `/db`. Each entry file is only a list of re-exports: a class that is not listed there does not ship. Everything is exported by name (no default exports).

The root entry [src/index.ts](../src/index.ts) re-exports every entry **except `db`**. The reason is the edge runtime (Next.js middleware, Vercel Edge Functions): it has no TCP sockets and no `node:*` modules. `db` needs both (postgres.js, and `node:crypto` for hashing connection strings), so it is kept out of the root, and importing `@lilypad/libs` stays edge-safe. `postgres` is an optional **peer** dependency: an application that uses only the edge modules does not install it.

This rule is enforced twice:

- [src/entries/entries.test.ts](../src/entries/entries.test.ts) reads the source of each entry, follows every *value* import (`import type` is skipped, since it disappears at build time) and fails if an edge entry reaches any external module. The `db` entry may reach exactly `postgres` and `node:crypto`.
- The `edge` project of [vitest.config.ts](../vitest.config.ts) runs the tests of the edge modules a second time inside the `edge-runtime` environment, where Node.js globals do not exist. This is why the cache uses `globalThis.crypto.randomUUID()` and never `node:crypto`.

The build ([tsup.config.ts](../tsup.config.ts)) bundles each entry as CJS and ESM with type declarations. `splitting: true` puts the modules shared by several entries in common chunks, so that there is **one copy of each class** no matter which subpath imported it. Without that, `error instanceof LilypadCacheCooldownError` could fail when the error was thrown by a class from another bundle copy.

`dist/` is committed, because the package is installed straight from git. The pre-commit hook stashes the unstaged changes, runs the checks and the build on what is being committed, and stages `dist/`; CI checks that the committed `dist/` matches the sources.

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

| Helper | Where | What it guarantees |
| --- | --- | --- |
| `libLog(logger, level, ...)` | [LilypadLibLogger.ts:17](../src/logger/LilypadLibLogger.ts#L17) | Calls `logger[level]` if it exists; swallows a sync throw; attaches a `.catch` if the result is a promise |
| `runInBackground(platform, task, onError)` | [LilypadPlatform.ts:78](../src/platform/LilypadPlatform.ts#L78) | `task.catch(onError)` first, then hands the *handled* promise to `platform.background` |
| `runAfterResponse(platform, work, onError)` | [LilypadPlatform.ts:96](../src/platform/LilypadPlatform.ts#L96) | Same, for work that should start after the response |
| `sharedStoreOperation(op, fallback, timeout, onError)` | [LilypadPlatform.ts:117](../src/platform/LilypadPlatform.ts#L117) | Races the operation against a timeout; any failure resolves to `fallback` |
| `runCallbackSafely(channel, id, cb)` | [LilypadDbGate.ts:550](../src/dbGate/LilypadDbGate.ts#L550) | `Promise.resolve().then(cb).catch(log)`: catches both sync throws and rejections of listener callbacks |
| the logger's channel methods | [LilypadLogger.ts:157](../src/logger/LilypadLogger.ts#L157) | Never reject: component errors go to `errorLogging`, then to `console.error` |

Notice the detail in `runInBackground`: `platform.background` itself may throw (Next.js `after()` throws outside a request). The `try/catch` around it reports that error, but the task **still runs**, only without the "keep the instance alive" guarantee. The same fallback exists in `runAfterResponse`: if `afterResponse` throws, the work is started immediately instead.

ESLint enforces the other half of the rule: `@typescript-eslint/no-floating-promises` is an error, so every promise in the code is either awaited, returned, or explicitly marked with `void` after its errors were handled.

### 3.2 The platform is optional

`LilypadPlatform` ([LilypadPlatform.ts:62](../src/platform/LilypadPlatform.ts#L62)) has four optional fields:

- `background(task)`: keep the instance alive until `task` settles (Vercel `waitUntil`, Next.js `after`);
- `afterResponse(work)`: run `work` after the response is sent;
- `shared`: a key-value store shared by all instances (the Vercel Runtime Cache fits it as is);
- `onInvalidate(event)`: tell the application that cached data changed (e.g. to call `revalidateTag`).

The code always reads them with optional chaining (`platform?.background?.(...)`). When one is missing, the library does the natural thing for a long-running server: run the work now, keep no shared level, send no event. The library never imports `next/*` or `@vercel/*`; [docs/nextjs-vercel.md](nextjs-vercel.md) shows the ten-line adapter the application writes.

### 3.3 `undefined` versus `null`

In every cache method:

- `undefined` means **"I don't know"**: not cached, or expired.
- `null` means **"I know it does not exist"**: for a table cache, no row has that primary key.

This is what lets the cache remember negative results, so that repeated lookups of a missing id stop reaching the database. Internally, `LilypadCachedValueType<V>` is `V | null`, and `undefined` never gets stored. Some code relies on the distinction in subtle ways: a `DELETE` read from the changelog is cached as `null` rather than removing the entry (see [3.4](#34-tickets-ordering-asynchronous-writes)), and `LilypadDbCache` uses `null` to remove a key from its list of table rows ([LilypadDbCache.ts:432](../src/cache/LilypadDbCache.ts#L432)).

### 3.4 Tickets: ordering asynchronous writes

This is the most important idea in the library, and the one that makes the cache code look more complicated than a textbook cache.

**The problem.** A read of the source is asynchronous: it starts at one moment, and its result arrives later. Meanwhile, anything can happen to the same key: a `set`, an `invalidate`, a database notification, another fetch. If the slow read simply stored its result when it arrived, it could overwrite a newer value with an older one:

```
time ─────────────────────────────────────────────────────────────>
fetch("a")   starts ─────── reads v1 from DB ─────────────── stores v1   ✗ overwrites v2
set("a", v2)                          stores v2
```

**The solution.** A counter, `lastTicket`, that only goes up ([LilypadCacheCore.ts:102](../src/cache/LilypadCacheCore.ts#L102), `nextTicket()` at [line 204](../src/cache/LilypadCacheCore.ts#L204)). Every entry carries the ticket of the write that produced it. Then:

- A **synchronous write** (`set`, `expire`, ...) takes a new ticket at the moment it writes. It always wins.
- An **asynchronous read** takes its ticket **when it starts**, with `beginRead()` ([line 212](../src/cache/LilypadCacheCore.ts#L212)). When its result arrives, it stores it through `setIfNewer` ([line 373](../src/cache/LilypadCacheCore.ts#L373)), which refuses to store unless the read's ticket is **greater** than the key's current ticket.

```
                      ticket
fetch("a")   starts:    4  ──────────────────────── setIfNewer(ticket 4): 4 <= 5 → discarded ✓
set("a", v2)                    entry.ticket = 5
```

The caller of the slow fetch still receives the value it fetched; it is just not cached. "The key's current ticket" is computed by `currentTicket(normalizedKey)` ([line 227](../src/cache/LilypadCacheCore.ts#L227)):

```ts
const entry = this.store.get(normalizedKey);
if (entry) return entry.ticket;                                 // the key has an entry
return Math.max(this.ticketFloor, this.fences.get(normalizedKey) ?? 0); // it has none
```

The second line covers a subtle case: what if the key has **no entry** at all? Then there is no entry ticket to compare with, and two mechanisms fill the gap:

- **`ticketFloor`** ([line 107](../src/cache/LilypadCacheCore.ts#L107)): a threshold for every missing key. It is raised when a bulk sync completes (the sync saw the whole source, so a read that started before it is older than what the sync knows) and by `expireEverything()` (the source may have changed in any way).
- **`fences`** ([line 115](../src/cache/LilypadCacheCore.ts#L115)): a per-key threshold, set whenever a key **loses its ordering information while a read of it is in flight**. Two cases:
  - a key with no entry is expired: `expireNormalized` sets a fence with a new ticket ([line 1023](../src/cache/LilypadCacheCore.ts#L1023)), since the read may have queried the database before the change;
  - an entry is **removed** (by `delete`, `clear`, `purgeExpired`, `cleanupOnAccess` or a `maxEntries` eviction): `dropEntry` ([line 283](../src/cache/LilypadCacheCore.ts#L283)) keeps the ticket of the removed entry as the fence. Without it, a read that started before the entry was last written or invalidated would find no entry and no fence once the entry is gone, and would store its older value. This is how an invalidation followed by a purge used to let a pre-change row back into the cache.

  A fence is removed as soon as the key gets an entry (the entry's ticket then does the job) or when no read of the key is in flight any more (`purgeExpired`).

Three consequences worth remembering:

- **Every code path that reads the source and stores the result must go through `beginRead()`.** That is why `setIfNewer` and `storeFetched` are `private`: subclasses can only reach them through the `LilypadCacheRead` object that `beginRead()` returns (`read.store`, `read.storeFetched`). `LilypadDbCache` uses it for single-row fetches, batched fetches and table loads.
- **Expiring an entry takes a new ticket too** ([line 1029](../src/cache/LilypadCacheCore.ts#L1029)). So "invalidate this key" also means "discard any read of this key that is already running", which is exactly what a change notification needs.
- **Removing an entry never lowers the key's ticket** while a read is in flight: the fence takes over.

### 3.5 `expirationTime: 0` means "invalidated"

An entry expires when `Date.now() >= entry.expirationTime` (`isStale`, [line 31](../src/cache/LilypadCacheCore.ts#L31)). Invalidation does not remove the entry: it sets `expirationTime` to `0` and records `invalidatedAt` ([line 1029](../src/cache/LilypadCacheCore.ts#L1029)). One value encodes several rules at once:

- The entry is expired, so `get` returns `undefined` and `getOrSet` fetches again.
- It is **never served stale**: the stale window test is `now < expirationTime + staleWindow`, which is false for `0 + window`.
- It **keeps its value**, which remains available to `onError: { fallback: 'stale' }` if the next fetch fails.
- `LilypadDbCache.renew` refuses to extend it ([LilypadDbCache.ts:289](../src/cache/LilypadDbCache.ts#L289)).
- `invalidatedAt` lets `adoptShared` refuse copies from the shared level that were produced before the invalidation ([LilypadCacheCore.ts:717](../src/cache/LilypadCacheCore.ts#L717)).

### 3.6 Keys are compared by their string form

Keys can be `string | number`, but the store is a `Map<string, entry>` keyed by `normalizeKey(key) = String(key)` ([line 199](../src/cache/LilypadCacheCore.ts#L199)). So `get(7)` and `get('7')` read the same entry. This matters for databases: a notification or a changelog row carries the primary key as text (`'7'`), while the application uses numbers. Each entry keeps the **original** key (`entry.key`), so that `entries()` can return keys with the type they were stored with. `LilypadDbCache.resolveNotifiedKey` ([LilypadDbCache.ts:820](../src/cache/LilypadDbCache.ts#L820)) turns a text id back into the right type.

Inside the class, you will see pairs of methods such as `delete`/`removeEntry` and `expire`/`expireNormalized`: the public one takes a key, the private one takes an already normalized string, which is what internal loops have. The same split separates public methods that assert the cache is not disposed (`purgeExpired`, `clear`) from the internal ones the engine calls itself (`purgeEntries`, `clearEntries`).

### 3.7 Single-flight everywhere

"Single-flight" means: while an operation for some identifier is running, later callers join it instead of starting another one. The library applies it at every level:

| What | Identifier | Where |
| --- | --- | --- |
| `getOrSet` fetches | `LilypadCache-getOrSet-<key>` | `LilypadFlowControl.executeFn` |
| bulk syncs | `LilypadCache-bulkSync` | a second `LilypadFlowControl` |
| async singletons | the registry key | the promise stored in the registry |
| `LISTEN` on a channel | the channel | `ChannelListener.ready` |
| batched row fetches | each key | `LilypadDbCache.rowFetches` |
| `refresh(key)` | each key | `LilypadDbCache.refreshes` (plus one queued) |
| changelog reads | the reader | `LilypadChangelogReader.current` (plus one queued) |
| the schema check | the cache | `LilypadSchemaVerifier.check` |

The recurring trick is to **store the promise itself** in a map, synchronously, before any `await`, and to remove it when it settles, with a guard like `if (map.get(id) === promise) map.delete(id)` so that a newer promise registered meanwhile is not removed by mistake.

Two of them (`refresh` and the changelog reader) add a **queued** second operation. Joining a read that is already running is not always enough: that read may have queried the database *before* the change the new caller wants to see. So a call that arrives while a query runs waits for one more query, and every caller arriving after that shares the queued one.

### 3.8 Retries back off

Three operations of `LilypadDbCache` can fail and must be retried later, but not at every read: starting a lazy `LISTEN`, reading the changelog, and running the schema check. Each keeps a `LilypadBackoff` ([LilypadBackoff.ts:8](../src/internal/LilypadBackoff.ts#L8)): `fail()` schedules the next attempt `base × 2^(failures-1)` later (up to one minute, unless the base itself is longer), `succeed()` resets it, and `ready(now)` tells whether an attempt may run. A database outage therefore does not add a failing query to every request.

---

## 4. Module by module

From the simplest to the most complex. Each section starts with what the module is for, then how it works.

### 4.1 The singleton registry

[src/singleton/LilypadSingleton.ts](../src/singleton/LilypadSingleton.ts), 172 lines.

**Purpose.** In Next.js development, modules are re-evaluated on every hot reload, so a module-level `const gate = ...` would open a new connection pool at every save. And an application can end up with two copies of the library in different bundles. A registry stored on `globalThis` survives both.

**How.**

- Lines 1-7: the two maps live on `globalThis.__lilypadSingletonMap` and `globalThis.__lilypadSingletonSignatureMap`, created with `??=` so the first copy of the library creates them and every later copy reuses them. The signatures are in a *separate* map so that older bundles, which only know the first map, can still share it.
- `getLilypadSingletonInstance` ([line 41](../src/singleton/LilypadSingleton.ts#L41)): if registered, return it; otherwise create, register, return. If the registered value is a `Promise`, an async creation is in progress, and a sync caller cannot wait for it, so it throws.
- `getLilypadSingletonInstanceAsync` ([line 75](../src/singleton/LilypadSingleton.ts#L75)) is the interesting one. It stores the **creation promise** in the map right away (line 86). A concurrent caller finds the promise and returns it; since the function is `async`, returning a promise adopts it, so every caller awaits the same creation. When the creation resolves, the promise is replaced by the instance; if it rejects, the entry is removed (line 100), so the next call retries. Both steps first check `singletonMap.get(identifier) === instancePromise`, in case someone removed or replaced the entry meanwhile.
- **Signatures** (`checkSignature`, [line 29](../src/singleton/LilypadSingleton.ts#L29)): a later call with the same identifier but different options gets the existing instance, and its options are silently ignored. To make this visible, each `create()` passes a string describing its important options. The first one is stored; a different one triggers `onMismatch` (a warning). `LilypadDbGate` hashes its signature with SHA-256, because connection strings contain passwords and the map is global.
- `createLilypadSingletonAble` ([line 134](../src/singleton/LilypadSingleton.ts#L134)) and `createLilypadSingletonAbleAsync` ([line 157](../src/singleton/LilypadSingleton.ts#L157)) are the shared bodies of the `create()` methods. They prefix the identifier with the class name (`LilypadDbGate:main`), so that a gate and a cache can both be called `main`, and pass the factory a **release function** (`releaseFor`, [line 118](../src/singleton/LilypadSingleton.ts#L118)). The instance calls it in `close()`/`dispose()`. It removes the registry entry once: calling it again does nothing, so it can never remove a newer instance registered under the same identifier since. For an instance that is not a singleton, it is a no-op.

### 4.2 The platform helpers

[src/platform/LilypadPlatform.ts](../src/platform/LilypadPlatform.ts), 143 lines. Section [3.1](#31-never-crash-the-host-background-work-without-unhandled-rejections) covered `runInBackground` and `runAfterResponse`. The other two:

- `sharedStoreOperation` ([line 117](../src/platform/LilypadPlatform.ts#L117)): `Promise.race` between the operation and a timer that rejects after `timeout` ms. Any error, including the timeout, calls `onError` and resolves to `fallback`. The `finally` clears the timer so it does not keep Node.js alive. This is how "the shared store is never required to answer" is implemented: a read that fails looks exactly like a miss.
- `toTtlSeconds` ([line 141](../src/platform/LilypadPlatform.ts#L141)): the library works in milliseconds, but the Vercel Runtime Cache takes TTLs in seconds. It rounds up, with a minimum of 1 s, so that a short TTL never becomes `0` (which a store could read as "forever").

The options of every class are checked by `assertNumberOption` ([LilypadValidation.ts:30](../src/internal/LilypadValidation.ts#L30)): a duration must be a finite number (positive, or non-negative where `0` means "disabled"), a size a positive integer. Without it, a `NaN` slips through every comparison silently: `now - last < NaN` is always false, so a `pollInterval` of `NaN` would read the changelog at every request.

### 4.3 Logging

There are two different things here, and it helps to keep them apart:

- **`LilypadLibLogger`**, the logger the *other modules* accept: any object with some of the methods `error`, `warn`, `info`, `debug`. `console` qualifies, so does pino, so does a `LilypadLogger`.
- **`LilypadLogger`**, a full logger you *can* use in your application, with named channels and pluggable outputs.

#### libLog

[LilypadLibLogger.ts:17](../src/logger/LilypadLibLogger.ts#L17). Every module logs through it, always as `libLog(this.logger, 'error', this.name, 'message', error)`. The first argument after the level is the instance name (or the class name, before an instance exists), so logs from several caches can be told apart. The function looks up `logger[level]`, returns if it is missing, calls it with `method.call(logger, ...)` (so that `this` is right for class-based loggers like pino), and if the result looks like a promise, attaches an empty `.catch`. A logger can therefore be missing, partial, throwing or rejecting, and the module never notices.

#### LilypadLogger

[LilypadLogger.ts](../src/logger/LilypadLogger.ts), 264 lines.

**The shape.** You choose channel names (`'error' | 'warn' | 'info' | 'debug'` by default), and each becomes a method: `logger.info(...)`. TypeScript cannot add methods to a class from a type parameter, so the class is `LilypadLogger<T>` and the type you use is `LilypadLoggerType<T> = LilypadLogger<T> & ChannelMethods<T>` ([line 262](../src/logger/LilypadLogger.ts#L262)); `create()` returns the latter.

**Construction** ([line 123](../src/logger/LilypadLogger.ts#L123)):

1. Rejects channel names that would overwrite a property of the logger (line 128). `key in this` catches inherited names such as `constructor` or `toString`; the fields are listed by hand because, depending on the compilation target, class fields may not exist yet at that point of the constructor. `then` is reserved because an object with a `then` method is a "thenable": returning the logger from an `async` function would call it instead of resolving to the logger.
2. Copies the component arrays (so that `register()` does not mutate the caller's arrays).
3. For each channel, builds two closures and assigns the second one as a method of the instance (line 200):
   - `send(message, context)` builds a `LilypadLogRecord` (formatted message, raw parts, timestamp, logger name, context), with the values of the redacted keys (the `redact` option, by default `LILYPAD_DEFAULT_REDACTED_KEYS`) replaced in the message and in a copy of the context. It calls every component's `write()` with `Promise.allSettled`, so that one failing component neither stops the others nor hides their errors, and passes each failure to `reportComponentError`. The formatting itself is inside the `try`, because even formatting must never make the promise reject.
   - `logFn(...message)` (line 189) is the channel method. It reads `context()` **synchronously**, before any `await`, so that an `AsyncLocalStorage` store of the caller's request is still active. It adds the task to `_pending` (for `flush()`), hands it to `runInBackground` (for `platform.background`), and returns it.

`reportComponentError` ([line 246](../src/logger/LilypadLogger.ts#L246)) tries `errorLogging` (which may be synchronous or async), and falls back to `console.error` if there is none or if it fails too. This is the one place where the library writes to the console on its own, because there is nowhere else left to report.

`flush()` ([line 225](../src/logger/LilypadLogger.ts#L225)) loops `while (_pending.size > 0) await Promise.all(_pending)`: a loop rather than one `await`, because messages logged while waiting are added to the set.

#### Components

[LilypadLoggerComponent.ts](../src/logger/LilypadLoggerComponent.ts). A component has one extension point, the abstract `write(record)`, and a helper, `formatRecord(record)`, which formats a record as `<ISO time> - [name] [TYPE]: <message> <context JSON>`:

- `LilypadConsoleLogger` writes `formatRecord(record)` to `console.error`/`warn`/`log` by channel name;
- `LilypadJsonConsoleLogger` writes one JSON object per line, with the context fields at the top level and the `Error` parts under `errors`;
- `LilypadDiscordLogger` queues `formatRecord(record)` (below).

`safeJson` ([line 117](../src/logger/LilypadLoggerComponent.ts#L117)) converts the value to JSON-safe data before `JSON.stringify`: BigInts become `"10n"`, errors `{ name, message, stack }`, `toJSON` is honoured, and it returns `"[Unserializable]"` if it still throws. It tracks the **ancestors** of the current value (added on the way down, removed on the way back up), so only a reference to an ancestor prints `"[Circular]"`: an object referenced twice side by side is printed twice, as in `formatLogValue`.

#### formatLogValue

[formatLogValue.ts](../src/logger/formatLogValue.ts). Node's `util.inspect` is not available in edge runtimes, so this is a small re-implementation. Top-level strings are printed as is; everything else goes through `formatNested`, which recurses with a `depth` (abbreviating beyond 4 levels to `[Object]`/`[Array]`), a `seen` set for cycles, and the set of redacted keys (compared ignoring case, `-` and `_`), whose values print as `[Redacted]`. `redactLogValue` makes the same replacement in a copy of a value that is serialized later, the context. The `seen` set is emptied on the way back up (`finally { seen.delete(value) }`), so an object that appears twice *side by side* is printed twice, and only a real cycle prints `[Circular]`. Errors print their stack, then their own enumerable properties (this is how the `code` and `detail` of a Postgres error show up), then `[cause]:` recursively. Each property read is in its own `try`, because a getter can throw.

#### LilypadDiscordLogger

[DiscordLogger.ts](../src/logger/components/DiscordLogger.ts), 178 lines. Posting one HTTP request per log line would hit Discord's rate limit immediately, so the component is a small queue with batching:

- `write()` formats the record and `enqueue()` returns a promise that is resolved or rejected **later**, when the batch containing the message is sent. It pushes `{ content, resolve, reject }` onto the queue, drops the oldest messages beyond `maxQueueSize` (resolving them, since rejecting 100 dropped messages would flood `errorLogging`), and kicks `flush()`.
- `flush()` ([line 97](../src/logger/components/DiscordLogger.ts#L97)) is guarded by a `flushing` flag, so only one loop runs. The loop waits until `nextRequestAt`, takes a batch and sends it, until the queue is empty.
- `takeBatch()` ([line 116](../src/logger/components/DiscordLogger.ts#L116)) first prepends a notice if messages were dropped, then takes as many messages as fit in Discord's 2000 characters (always at least one).
- `sendBatch()` ([line 134](../src/logger/components/DiscordLogger.ts#L134)) posts, sets `nextRequestAt = now + minRequestInterval`, cancels the unread response body (otherwise the connection stays busy until garbage collection), retries a `429` after `retry-after` (unless it is longer than 30 s: the batch then fails at once, instead of holding the queue and `logger.flush()`), and finally resolves the messages of the batch. On a failure, it rejects only one of them, with an error that counts the messages lost and has the original error as `cause`: it flows back through the logger to `errorLogging` once per batch, not once per message.
- `post()` sets `allowed_mentions: { parse: [] }` so that a logged `@everyone` pings no one, and a 5 s `AbortSignal.timeout`.

### 4.4 LilypadFlowControl

[src/flow/LilypadFlowControl.ts](../src/flow/LilypadFlowControl.ts). Four independent tools, composed by `executeFn`. The constructor checks its numeric options with `assertNumberOption` (a `NaN` timeout would make every call time out at once). The class is **not generic**: each method takes the type of its own `fn`, so one instance can run executions of different types (the cache runs table loads and key queries through the same bulk flow control).

- **`executeWithTimeout(fn, timeout)`** ([line 132](../src/flow/LilypadFlowControl.ts#L132)): creates an `AbortController`, and races `fn(signal)` against a timer. When the timer fires, it aborts the controller **with** the `LilypadTimeoutError` and rejects. JavaScript cannot stop a running promise, so the signal is how `fn` learns it should stop, and how the cache learns that a late result must not be stored (it checks `signal.aborted`).
- **`executeWithRetries({ executionFn, retries, backOffTime })`**: a `while (true)` loop that returns on success, and on failure either sleeps and retries (default backoff `2^attempt × 100` ms) or, after the last attempt, rethrows.
- **`rateLimit(key)`**: remembers the last execution time per key and throws `LilypadRateLimitError` if the new one comes too soon. The map is pruned when it passes 1000 keys. It is deliberately **synchronous**, see below.
- **`singleFlight(key, fn)`**: returns the promise of the execution of `key` in flight, or calls `fn` and registers its promise (synchronously), removing it once settled.

`executeFn` chains them in this order:

```ts
if (!this.isInFlight(id)) this.rateLimit(`${consumer}#${id}`); // 1. rate limit a new execution only
return this.singleFlight(id, () =>                               // 2. join, or start and register
  this.executeWithRetries({                                      // 3. retries around timeouts
    executionFn: () => this.executeWithTimeout(fn, timeout), ...
  })
);
```

Between the lookup and the registration of the promise there is **no `await`**. That is the whole correctness argument of single-flight: two calls cannot both see "nothing in flight" and both start, because JavaScript runs this block without interruption. It is also why `rateLimit` must stay synchronous.

A consequence the cache relies on: callers who join an execution share **everything** from the first caller, including its timeout and its outcome. That is why the cache calls `singleFlight` with a function that only logs a failure and rethrows it, and the per-caller fallback is chosen afterwards, outside the flight (see [4.6](#failures-errorreturn-and-the-cooldown)).

### 4.5 LilypadSerializer

[src/serializer/LilypadSerializer.ts](../src/serializer/LilypadSerializer.ts), 129 lines. Unrelated to the rest of the library: it maps objects of shape `FROM` to a compact shape `TO` and back, leaving out values equal to their default.

The runtime is trivial: `serialize` ([line 88](../src/serializer/LilypadSerializer.ts#L88)) loops over the keys, skips values equal to the default (with `equality`, or `===`), calls the key's `serialize` function and writes the result under the `target` key; `deserialize` ([line 109](../src/serializer/LilypadSerializer.ts#L109)) does the reverse and fills `undefined` with a `structuredClone` of the default, so that deserialized items never share a default array.

The interesting part is the **types** (lines 1-44). The key mapping `KeyMap` must be a bijection: every `TO` key used once, no two `FROM` keys on the same `TO` key.

- `IsSurjective<B, M>`: `keyof B extends M[keyof M]`, every key of `TO` is some target.
- `IsInjective<M>`: for each key `K`, the inverse record `InvertRecord<M>[M[K]]` (the union of all keys that map to the same target) must be exactly `K`. The `[X] extends [K]` brackets prevent TypeScript from distributing over the union.
- If the mapping is not a bijection, `target` is typed `never`, so the options object does not compile.

The `@ts-expect-error` tests in `LilypadSerializer.test.ts` check these types; they run under `npm run typecheck`, not under vitest.

### 4.6 The cache engine: LilypadCacheCore

[src/cache/LilypadCacheCore.ts](../src/cache/LilypadCacheCore.ts), about 1180 lines, with its types in [LilypadCacheTypes.ts](../src/cache/LilypadCacheTypes.ts) and the shared level in [LilypadSharedLevel.ts](../src/cache/LilypadSharedLevel.ts). This is the heart of the library. Read [3.4](#34-tickets-ordering-asynchronous-writes) and [3.5](#35-expirationtime-0-means-invalidated) first.

[LilypadCache.ts](../src/cache/LilypadCache.ts) is only the public face of the engine: its constructor is public, and it re-declares the protected methods of the engine (`set`, `bulkSet`, `getOrSet`, `getOrSetDetailed`, `bulkSync`, `getMany`, `entries`) as public, plus `getAll()` (the engine's `getAllEntries`, renamed because `LilypadDbCache.getAll` has another signature) and `invalidateBulkSync()`. TypeScript allows a subclass to widen the visibility of a member; each override is a one-line call to `super`.

#### What the engine holds

The fields ([lines 68-123](../src/cache/LilypadCacheCore.ts#L68)) fall into four groups:

| Group | Fields | Role |
| --- | --- | --- |
| Data | `store: Map<string, entry>`, `protectedKeys` | The entries, by normalized key; keys that `delete`/`clear`/eviction skip |
| Ordering | `lastTicket`, `ticketFloor`, `fences`, `bulkSyncInvalidationTicket` | See [3.4](#34-tickets-ordering-asynchronous-writes) |
| Resilience | `failures`, `refreshing`, `sharedNotBefore` | Cooldown after a failed fetch, background refreshes in progress, oldest acceptable L2 copy |
| Machinery | `flowControl`, `bulkSyncFlowControl`, `shared`, `platform`, `logger`, `disposed` | Single-flight + timeouts for fetches and for bulk syncs; the shared level |

An entry ([`LilypadCacheEntry`, LilypadCacheTypes.ts:144](../src/cache/LilypadCacheTypes.ts#L144)) is:

```ts
{
  key,            // the key as the caller passed it (number stays number)
  value,          // V | null
  expirationTime, // ms timestamp; 0 = invalidated
  fetchedAt,      // when the value was produced (for L2 copies: when *some* instance fetched it)
  ticket,         // ordering, see 3.4
  origin,         // 'source' (fetch or write) | 'fallback' (errorReturn) | 'shared' (adopted from L2)
  invalidatedAt?, // set by expire()
}
```

`origin` is used in three places: `freshHit` reports a `fallback` as `refreshFailed`; `LilypadDbCache` only renews `source` entries, and ignores `fallback` entries when tracking the table's rows.

The constructor ([line 125](../src/cache/LilypadCacheCore.ts#L125)) validates every numeric option, resolves the shared level (throwing if there is no store or no `name`), creates the two flow controls (5 s timeout for fetches, 30 s for bulk syncs, no retries, no rate limit), and starts the cleanup interval if asked, calling `unref()` so that the timer does not keep Node.js alive.

#### The write path

Every write funnels into one private method, `writeEntry` ([line 248](../src/cache/LilypadCacheCore.ts#L248)), which returns whether it stored the entry:

```
set(key, v, ttl) ──> setValue ──> writeLocal ──(new ticket)──┐
setIfNewer(... ticket) ──(ticket check)──────────────────────┤
adoptShared(... ticket) ──(ticket check)─────────────────────┼──> writeEntry(entry, newValue)
expireNormalized ──(new ticket, exp=0)───────────────────────┘         │
                                                                       ├─ disposed? store nothing, return false
                                                                       ├─ with maxEntries: delete + set (move to the end = most recent)
                                                                       ├─ fences.delete(key)   (the entry's ticket now orders reads)
                                                                       ├─ if newValue: onValueStored(entry)   (subclass hook)
                                                                       │               invalidate bulk sync if the entry expires before it
                                                                       └─ evictOverflow()
```

Four details:

- **The disposed check.** A fetch that was in flight when `dispose()` was called will still complete and try to store its value. The `disposed` flag makes `writeEntry` a no-op, and since the shared level is written only for an entry that was stored (`setValue`, `storeFetched`), a disposed cache writes nothing to L2 either.
- **LRU with a `Set`.** With `maxEntries`, `evictionOrder` holds the keys that can be evicted (not protected), least recently used first: a JavaScript `Set` iterates in insertion order, and deleting and re-adding a key moves it to the end. `markUsed()` does that on writes and reads. `evictOverflow()` removes the first keys of `evictionOrder` until the size fits, through `dropEntry` so that a read in flight keeps its fence. Protected keys stay out of it (`addProtectedKeys` removes them, `removeProtectedKeys` puts them back), so an eviction never scans them. Loops that write while iterating still iterate a **copy** of the store (`[...this.store]`).
- **Bulk sync consistency.** `entries()` returns "everything in the cache" and trusts it to be the whole source while the bulk sync is fresh. So anything that makes an entry disappear or expire early while the sync is fresh must invalidate the sync: an entry written with a shorter TTL (here), an eviction, `clear()`.
- **One removal path.** `delete`, `clear`, `purgeExpired`, the bulk sync and `get(key, { removeExpired })` all remove through `removeEntry` ([line 1074](../src/cache/LilypadCacheCore.ts#L1074)), which checks the protected keys and calls `dropEntry`.

`set` ([line 361](../src/cache/LilypadCacheCore.ts#L361)) asserts the cache is not disposed, then `setValue` ([line 348](../src/cache/LilypadCacheCore.ts#L348)) = `writeLocal` (new ticket, origin `source`) + `writeShared` (L2 in the background). `LilypadDbCache` calls `setValue` directly for its own writes. `writeLocal` alone is used for fallbacks, which must not be shared with other instances.

#### The read path: getOrSetDetailed

`getOrSet` is a thin wrapper over `getOrSetDetailed` ([line 553](../src/cache/LilypadCacheCore.ts#L553)), which returns `{ value, status, refreshFailed }`. Its lookup order:

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
├─ in cooldown and no fetch in flight? ──> errorReturn(LilypadCacheCooldownError) ──> 'MISS', refreshFailed
│
└─ try  fetchAndStore(key, valueFn, options) ─────────────> 'MISS'
   catch errorReturn(error, options, key) ────────────────> 'MISS', refreshFailed
```

Why is the ticket for L2 taken *before* reading L2 (line 571)? If a local `set` happens while the L2 read is in flight, the local value is newer than whatever L2 returns. `adoptShared` will see `read.ticket <= currentTicket` and refuse the copy.

Why is the entry re-read after L2 (`const current = this.store.get(...)`, line 581)? The `await` gave other code the chance to write it.

#### Fetching: fetchAndStore

[Line 632](../src/cache/LilypadCacheCore.ts#L632). It wraps the caller's `valueFn` in `flowControl.executeFn`, keyed by `LilypadCache-getOrSet-<key>`:

```ts
fn: async (signal) => {
  const read = this.beginRead();          // ticket at the real start of the fetch
  const value = await valueFn(signal);
  if (!signal.aborted) {                  // timed out: the caller already got an error
    read.storeFetched(key, value, options.ttl, options.staleWhileRevalidate);
  }
  return value;
}).catch((error) => { libLog(...); this.recordFailure(key); throw error; }),
```

`storeFetched` ([line 399](../src/cache/LilypadCacheCore.ts#L399)) does three things: clears the key's failure (and its L2 failure marker), stores the value with `setIfNewer`, and, only if it was stored, writes it to L2. Note that the fetch's result is returned to every caller even if it was not stored: the callers asked for the value *now*, and the value is correct for the moment it was read.

#### Failures: errorReturn and the cooldown

When the fetch fails, the shared promise rejects for every caller who joined it. Each caller then runs `errorReturn` ([line 473](../src/cache/LilypadCacheCore.ts#L473)) **with its own `onError` options**. It re-reads the **current** entry (it may have changed during the fetch), and then:

1. `fallback: 'stale'`: the current entry's value, even expired or invalidated;
2. a fallback function: its result, called with `{ key, error, stale }`, where `stale` is `{ value, fetchedAt }` of the current entry, if any;
3. `undefined` (no fallback, or the function returned `undefined`): rethrow.

A fallback is stored with `writeLocal(..., ttl, 'fallback', fetchedAt)`: in this instance only, for `onError.ttl` or the cache's `errorTtl`, and tagged so that `freshHit` reports it with `refreshFailed: true`. When the fallback **is** the stale value, it keeps the stale entry's `fetchedAt`: it is not a newer value, and dating it from now would make `adoptShared` refuse, once the fallback expires, a fresher copy that another instance put in the shared level meanwhile. A value computed by the function is dated from now.

The **failure cooldown** keeps a source that is down from being hammered by every request. `recordFailure` ([line 518](../src/cache/LilypadCacheCore.ts#L518)) stores the failure time in `failures`, and in L2 (the `f` key of the key) so other instances see it. `inCooldown` ([line 509](../src/cache/LilypadCacheCore.ts#L509)) is true for `failureCooldown` ms after it. During the cooldown `getOrSetDetailed` skips the fetch and goes straight to `errorReturn` with a `LilypadCacheCooldownError`, unless a fetch is already in flight (joining it costs nothing). Once the cooldown ends, `freshHit` ([line 617](../src/cache/LilypadCacheCore.ts#L617)) refreshes a cached fallback in the background, otherwise the fallback would hide the source's recovery until it expired.

#### Stale-while-revalidate

When an entry has expired but less than `staleWhileRevalidate` ago, `getOrSetDetailed` returns it immediately with status `STALE`, and calls `refreshInBackground` ([line 670](../src/cache/LilypadCacheCore.ts#L670)). The refresh is skipped when:

- another instance holds the L2 refresh lock (`remote.locked`);
- this instance scheduled a refresh of the key less than 60 s ago (`refreshing` map; after 60 s it is assumed the platform dropped it);
- a fetch of the key is already in flight;
- the key is in its failure cooldown.

Otherwise it records the key in `refreshing` and hands the work to `runAfterResponse`: take the L2 lock (if configured), run `fetchAndStore`, then clean up in `finally`. The lock is a random owner id stored under the `l` key with a TTL. It is released only if it still holds *our* owner id, because it may have expired and been taken by another instance meanwhile. It is a soft lock: read and write are separate operations, so two instances can occasionally both refresh, which is harmless.

#### The shared level (L2)

Everything about the store itself is in `LilypadSharedLevel` ([LilypadSharedLevel.ts:65](../src/cache/LilypadSharedLevel.ts#L65)); the engine keeps only the decisions that involve its own entries and tickets (`adoptShared`, `writeShared`).

- **Keys** (`key()`, [line 68](../src/cache/LilypadSharedLevel.ts#L68)): `lilypad:2:<name>:<kind>:<key>`, with `kind` one of `v` (the value), `f` (the time of the last failed fetch) and `l` (the refresh lock), and the name and the key URI-encoded. The kind comes *before* the key and `:` is encoded, so no key can collide with the lock or the failure marker of another key (`"a:lock"` used to be the lock of `"a"`), and no pair of name and key can collide with another pair (`"x:y"` + `"z"` and `"x"` + `"y:z"`). The `2` is the version of the format: entries of the previous format are simply not read. The tags of the entries and of the invalidation events (`lilypadCacheTags`, [line 47](../src/cache/LilypadSharedLevel.ts#L47)) are encoded the same way.
- **Values**: an envelope `{ lilypad: 2, value, fetchedAt, expiresAt }`. `fetchedAt` travels with the value, so that the *age* of a value is measured from when some instance fetched it, not from when it reached this instance. Without that, a value could bounce between instances and never expire.
- **Codec**: the store usually holds JSON, so an optional codec encodes values on the way in and decodes (and validates) them on the way out. `decode` ([line 151](../src/cache/LilypadSharedLevel.ts#L151)) rejects malformed envelopes and values the codec refuses, with a warning. `null` bypasses the codec.
- **Reading**: `read` ([line 119](../src/cache/LilypadSharedLevel.ts#L119)) reads the value, the failure marker and the lock in parallel, each bounded by the timeout (fallback `null`).
- **Adopting**: `adoptShared` ([LilypadCacheCore.ts:717](../src/cache/LilypadCacheCore.ts#L717)) copies a remote entry into L1 only if all of these hold:
  1. it is newer than the local entry (`fetchedAt`);
  2. it was produced after the local entry was invalidated (`invalidatedAt`): an L2 delete may have failed, or another instance may have written an old copy back;
  3. it was produced after `sharedNotBefore` (raised by a `TRUNCATE`, see [4.10](#applying-a-change));
  4. no local write started after the L2 read began (ticket check).
- **Writing**: `writeShared` ([LilypadCacheCore.ts:745](../src/cache/LilypadCacheCore.ts#L745)) computes the L2 lifetime as `expirationTime + staleWhileRevalidate - now` (so other instances can serve it stale too), and `LilypadSharedLevel.write` ([line 183](../src/cache/LilypadSharedLevel.ts#L183)) skips expired entries and writes in the background. With `checkBeforeWrite`, it first reads the L2 entry and leaves it alone if it was fetched later.

What writes L2 and what does not is a deliberate choice: `set`, `bulkSet` and successful fetches write it; `delete` and `invalidate` remove from it; fallbacks, bulk syncs, `clear` and `dispose` stay local. A fallback is an instance's local emergency answer, not a fact to share. A bulk sync would copy a whole table into the shared store.

#### Invalidation and expiry

Four levels, each built on the previous one:

| Method | Does | Used by |
| --- | --- | --- |
| `expireNormalized(key)` ([1019](../src/cache/LilypadCacheCore.ts#L1019)) | Entry: `expirationTime = 0`, new ticket, `invalidatedAt`. No entry but a read in flight: a fence. | everything below |
| `expire(key)` ([1015](../src/cache/LilypadCacheCore.ts#L1015)) | The above, with a key | subclasses |
| `markInvalid(key)` ([999](../src/cache/LilypadCacheCore.ts#L999)) | `expire` + remove from L2 + (optionally) force the next bulk sync | `invalidate`; `LilypadDbCache` for changelog changes |
| `invalidate(key)` ([989](../src/cache/LilypadCacheCore.ts#L989)) | `markInvalid` + a `manual` event to `platform.onInvalidate` | the public API |

`expireEverything()` ([line 1039](../src/cache/LilypadCacheCore.ts#L1039)) expires every entry, raises `ticketFloor` (discarding every read in flight, including of keys without an entry, so the fences are no longer needed and are cleared), and forces the next bulk sync. `LilypadDbCache` calls it when it may have missed changes.

`emitInvalidation` ([line 766](../src/cache/LilypadCacheCore.ts#L766)) builds `{ source, cache, keys, tags }` and calls `onInvalidate` inside `runInBackground`. The `Promise.resolve().then(...)` wrapper turns a synchronous throw of `onInvalidate` into a rejection that the handler catches.

`delete` removes the entry (and the L2 copy); protected keys need `{ force: true }`. `clear` removes everything local. `purgeExpired` / `purgeEntries` ([line 1116](../src/cache/LilypadCacheCore.ts#L1116)) removes entries expired for longer than the stale window, and also cleans the bookkeeping maps (`failures`, `refreshing`, `fences`), which would otherwise grow forever. It runs from the timer (`autoCleanupInterval`) or from `cleanupOnAccess` (at most once per `cleanupOnAccessEvery`, on reads and writes; no timer, which suits serverless instances that are suspended between requests). Every one of these removals goes through `dropEntry`, so it keeps the fence of a key being read ([3.4](#34-tickets-ordering-asynchronous-writes)).

#### Bulk sync

`bulkSync()` ([line 803](../src/cache/LilypadCacheCore.ts#L803)) loads everything from `bulkSync.fn` and replaces the content of the cache. Without a function it resolves to `false` at once (or rejects with `throwOnError`), with no query and no log. It runs in its own flow control (single-flight on `LilypadCache-bulkSync`, 30 s timeout) and resolves to a boolean instead of throwing, unless `throwOnError`.

`runBulkSync` ([line 830](../src/cache/LilypadCacheCore.ts#L830)), step by step:

1. Still fresh (`now < bulkSyncExpirationTime`)? Return `true` without loading.
2. `beginRead()`, then `await bulkSyncFn(signal)`. Timed out (`signal.aborted`)? Store nothing.
3. Build `incoming`, keyed by normalized key.
4. For each **local** entry (on a copy of the store): keep it if it was written after the sync started (`entry.ticket > read.ticket`, newer than the sync's data) or if it is about to be overwritten; otherwise remove it, and if it is protected, expire it instead.
5. `read.store(key, value)` for each incoming entry: `setIfNewer`, so entries written during the sync still win.
6. Raise `ticketFloor` to the sync's ticket (line 875): a read of a missing key that started before the sync is older than the sync's knowledge that the key does not exist.
7. Mark the sync fresh, **unless** an invalidation happened while it was running (`bulkSyncInvalidationTicket >= read.ticket`): its data may predate that invalidation. Freshness never lasts longer than `ttl`, since the entries it loaded expire then.

`forceNextBulkSync()` ([line 887](../src/cache/LilypadCacheCore.ts#L887), public as `invalidateBulkSync()` on `LilypadCache`) resets the expiration **and** records a ticket. Setting `bulkSyncExpirationTime = 0` alone would not be enough: a sync already running would set it again at step 7.

#### dispose

[Line 1164](../src/cache/LilypadCacheCore.ts#L1164): return at once if already disposed; stop the timer, clear everything (including protected keys), drop the logger and the bookkeeping, set `disposed`. From then on `assertNotDisposed` makes every public method throw. It returns a promise even though the engine has nothing to wait for, because `LilypadDbCache` must await its `UNLISTEN`, and the API is the same for both.

### 4.7 LilypadDbGate

[src/dbGate/LilypadDbGate.ts](../src/dbGate/LilypadDbGate.ts), 706 lines. A thin layer over [postgres.js](https://github.com/porsager/postgres): a client, typed CRUD helpers, and `LISTEN` management.

#### The clients

The constructor ([line 205](../src/dbGate/LilypadDbGate.ts#L205)) creates the main client:

```ts
this.sql = postgres(options.connectionString, {
  prepare: false,                           // works behind PgBouncer in transaction mode
  ...toPostgresPoolOptions(options.pool),   // ms → seconds, undefined keys removed
  ...(statementTimeout !== undefined && { connection: { statement_timeout } }), // 30 s by default
});
```

postgres.js connects lazily, on the first query, so creating a gate opens nothing. That is what keeps `next build` from reaching the database. `prepare: false` must stay: transaction-mode poolers route each statement to any backend, where a prepared statement may not exist.

`LISTEN` belongs to a session, so it cannot go through a pooler that reassigns sessions, and it must not be closed for being idle. postgres.js already handles this: its `listen()` opens **its own** dedicated connection (one per client, with no idle timeout and no maximum lifetime), whatever the pool options. So the gate listens through `this.sql` itself, and creates a second client only when `listenerConnectionString` points elsewhere, typically a direct connection (`listenClient()`, [line 506](../src/dbGate/LilypadDbGate.ts#L506)).

`create()` ([line 239](../src/dbGate/LilypadDbGate.ts#L239)) goes through the singleton helper with a SHA-256 signature of the connection options; `initializeNew` registers the `listen` subscriptions and, if one fails, closes the gate before rethrowing, so that a gate that is never returned does not leak its pools.

#### CRUD helpers

All generic over `LilypadDbSchema<T, PK>` ([line 93](../src/dbGate/LilypadDbGate.ts#L93)): table name, primary key, the `cols` record (one entry per property of `T`), optional sanitization functions. The parameters are named `schema`.

- **Reading rows.** `selectedColumns` ([line 310](../src/dbGate/LilypadDbGate.ts#L310)) selects only the schema columns, or `*` if there is a `selectSanitizationFn` (which may read other columns). `mapRow` ([line 292](../src/dbGate/LilypadDbGate.ts#L292)) builds `T` with the sanitization function, or by copying the `cols` keys; a sanitizer can return `null` to drop a row.
- `selectAllFromTable` ([line 357](../src/dbGate/LilypadDbGate.ts#L357)) reads through a **cursor** in batches of 1000 rows, so the raw result of a large table is never in memory at once. It takes an optional `signal`: it checks it before each batch, and throws its reason once aborted. Throwing out of the `for await` loop closes the cursor, so a table load that timed out stops reading instead of streaming the rest of the table for nothing.
- `selectFromTableByPrimaryKeys` ([line 386](../src/dbGate/LilypadDbGate.ts#L386)) uses `IN (...)`, one query per 1000 keys, since Postgres limits the number of parameters per query.
- **Writing rows.** `prepareWrite` ([line 322](../src/dbGate/LilypadDbGate.ts#L322)) is the security-relevant function: it applies `writeSanitizationFn` (whose result *replaces* the data), checks the primary key, removes it when the database generates it, and keeps **only the columns declared in `cols`** that are not `undefined`. An application can pass a request body directly; an extra `is_admin: true` is simply never written (no mass assignment).
- **Write results.** `insertToTable` ([line 427](../src/dbGate/LilypadDbGate.ts#L427)), `updateToTable` ([line 461](../src/dbGate/LilypadDbGate.ts#L461)) and `deleteFromTable` ([line 488](../src/dbGate/LilypadDbGate.ts#L488)) return the transaction id with the result. Their `RETURNING` lists the selected columns (not `*`, unless there is a `selectSanitizationFn`) plus `pg_current_xact_id()::text AS __lilypad_xid`; `writeResult` ([line 441](../src/dbGate/LilypadDbGate.ts#L441)) strips that column before mapping the row and returns `{ row, xid }`. `pg_current_xact_id()` is the function the changelog trigger uses as the default of its `xid` column, so the ids match; it is how `LilypadDbCache` recognises its own writes when they come back ([4.10](#own-writes)). A delete returns `{ deleted, xid }`. An update of a missing row throws `LilypadDbNotFoundError` ([line 142](../src/dbGate/LilypadDbGate.ts#L142)), which carries `tableName` and `primaryKeyValue`.

#### LISTEN management

State: `listeners: Map<channel, { callbacks: Map<callbackId, ...>, ready, listening }>` ([line 171](../src/dbGate/LilypadDbGate.ts#L171)).

- `addListener` ([line 600](../src/dbGate/LilypadDbGate.ts#L600)) gets or creates the channel entry, sets the callback under its id (re-adding an id replaces the callback), awaits `ready`, then starts the heartbeat (unless the callback was removed meanwhile).
- `initializeListener` ([line 517](../src/dbGate/LilypadDbGate.ts#L517)) registers the channel entry **before** `LISTEN` completes, so concurrent `addListener` calls for the same channel share one `ready` promise. If `LISTEN` fails, the entry is removed and the error rethrown, so the next call retries.
- The third argument of postgres.js `listen()` is `onlisten`, which postgres.js calls after the first `LISTEN` **and after every reconnection**. The `listening` flag tells them apart: the first call only sets it; later calls run each callback's `onReconnect`. The cache uses that hook to expire everything, since notifications sent while the connection was down are lost for good.
- Each notification runs every callback of the channel through `runCallbackSafely`.
- `removeListener` ([line 631](../src/dbGate/LilypadDbGate.ts#L631)) deletes the callback synchronously, and only when the channel has none left, awaits `ready` and `UNLISTEN`s. It never rejects: a `LISTEN` that had failed, or a failed `UNLISTEN`, is logged. When the last channel goes, the heartbeat stops.
- `close({ timeout })` clears the listeners, stops the heartbeat, releases the singleton, and ends the clients, waiting at most `timeout` (5 s) for the running queries. It keeps its promise, so a second call returns it, and `assertOpen()` makes the CRUD methods and `addListener` throw afterwards.
- `startHeartbeat` starts the timer only if `heartbeatStop` still holds its own `LISTEN` when that `LISTEN` completes: a `removeListener` of the last channel (or `close()`) that ran meanwhile has already awaited it to `UNLISTEN`, and a timer started after it would ping the database until `close()`. A heartbeat that could not start is retried by `isListenHealthy()`, after a `LilypadBackoff`.

#### The heartbeat

postgres.js re-establishes a lost `LISTEN` connection by itself, and `onlisten` tells when it is back. But it gives **no signal while the connection is down**: its internal listen connection overrides any `onclose` option. During that window notifications are lost, while a cache that trusts `LISTEN` keeps rows past their TTL without a query ([4.10](#trust-and-renewal)).

`LilypadListenHeartbeat` ([LilypadListenHeartbeat.ts:9](../src/dbGate/LilypadListenHeartbeat.ts#L9)) closes that gap. Once a channel is listened to, the gate also listens on a private channel (`lilypad_heartbeat_<gate id>`) and, every `listenHeartbeat` ms (15 s by default), sends itself `pg_notify` on it **through the main pool**. Each notification that comes back on the listen connection is a beat. `isListenHealthy()` ([line 666](../src/dbGate/LilypadDbGate.ts#L666)) is true while the last beat is less than 2.5 intervals old. A broken listen connection, a broken pool or a suspended instance all stop the beats, and the caches stop trusting `LISTEN` until they resume. The timer is `unref()`ed; with `listenHeartbeat: false`, `isListenHealthy()` only tells whether a channel is listened to.

### 4.8 The changelog

[src/dbGate/LilypadChangelog.ts](../src/dbGate/LilypadChangelog.ts) (SQL and the read) and [LilypadChangelogReader.ts](../src/dbGate/LilypadChangelogReader.ts) (batching).

#### Why a changelog

`LISTEN/NOTIFY` is near real-time, but it needs a long-lived direct connection, and a notification sent while no one is listening is lost. On a serverless platform, instances are suspended most of the time. The changelog solves this by **recording** every change in a table; each instance reads what it missed, whenever it wakes up. And unlike a notification, a changelog row can only be written by the triggers (with the usual table privileges), so the cache can trust its content.

#### The SQL

`lilypadChangelogSql()` ([line 64](../src/dbGate/LilypadChangelog.ts#L64)) returns the DDL. The table:

```sql
id           bigserial PRIMARY KEY,          -- order of insertion
xid          xid8 NOT NULL DEFAULT pg_current_xact_id(),  -- the writing transaction (64-bit, PG 13+)
table_schema text,                           -- TG_TABLE_SCHEMA (NULL for rows of version 1)
table_name   text NOT NULL,
row_id       text,                           -- the primary key as text; NULL for TRUNCATE
op           text NOT NULL,                  -- INSERT | UPDATE | DELETE | TRUNCATE
changed_at   timestamptz DEFAULT clock_timestamp()
```

with indexes on `(table_name, xid)` (cursor reads) and `(changed_at)` (lookback reads and pruning).

The trigger function receives the primary key column name as its argument (`TG_ARGV[0]`), so one function serves every table. Since version 4 it runs as a **statement** trigger, one per event, with transition tables (`REFERENCING OLD TABLE AS lilypad_old NEW TABLE AS lilypad_new`): it builds, with `format('%I')`, a query that reads only the primary key column of the changed rows (`to_jsonb(n.id) #>> '{}'`, the same text as before, without converting whole rows to JSON), and records every row of the statement with one `INSERT ... SELECT` in `EXECUTE`. An `UPDATE` that changes primary keys also records a `DELETE` for each old key that no row has any more. `TRUNCATE` has a statement trigger of its own. Unless `notifyChannel: false`, each change is also sent with `pg_notify('cache_events', json)` (from a data-modifying CTE over the inserted rows), so one trigger serves both strategies. The function keeps a row-level branch (`TG_LEVEL = 'ROW'`), so the row triggers of version 3 keep working between `lilypadChangelogSql()` and `lilypadChangelogTriggerSql()`. The function's comment carries the version (`lilypad-changelog:4`), which the schema check reads to detect outdated installs. Everything is idempotent (`IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP TRIGGER IF EXISTS`), so a migration can run it again.

`lilypadChangelogTriggerSql()` ([line 140](../src/dbGate/LilypadChangelog.ts#L140)) attaches the four triggers to one table, and drops the row trigger of version 3.

#### The cursor: the transactions a read could not see

This is the clever part. The obvious cursor, "the last `id` (or `xid`) I have read", **misses changes**, because transactions do not commit in the order they started:

```
T1 (xid 100) BEGIN ... writes a changelog row ............................ COMMIT
T2 (xid 101)      BEGIN ... writes a changelog row ... COMMIT
Cache read r1:                                               ↑ sees only xid 101 (T1 not committed)
                                                              "last seen" = 101
Cache read r2 (after T1 commits): WHERE xid > 101  → T1's change is never returned ✗
```

The snapshot of a read says exactly which transactions it could **not** see: those still running when it was taken (`pg_snapshot_xip`, here `{100}`), and those that had not started yet (`xid >= pg_snapshot_xmax`, here `>= 102`). Every other transaction had committed (its changes were visible) or aborted (it has none). So the cursor ([`LilypadChangelogCursor`, line 177](../src/dbGate/LilypadChangelog.ts#L177)) is `{ xmax, xip }`, and the next read asks for `xid >= xmax OR xid = ANY(xip)`: it gets T1's change once T1 commits, and nothing it has already returned.

Two properties follow:

- **Each change is returned by exactly one cursor read.** A change of a transaction in `xip` is invisible to the read that produced the cursor; a later read returns it once it is visible, and the cursor of that later read no longer lists the transaction. So the cache needs no memory of applied changes.
- **A long transaction costs nothing.** An earlier version used `pg_snapshot_xmin` (the oldest running transaction) and asked for `xid >= xmin`: a transaction held open for an hour (a migration, a session idle in transaction) pinned `xmin`, and every read returned again every change of that hour. With `{ xmax, xip }`, the long transaction only stays in `xip`, and the reads return only the new changes.

`lilypadCursorCovers(cursor, xid)` ([line 194](../src/dbGate/LilypadChangelog.ts#L194)) answers "were the changes of `xid` visible to the read that produced this cursor?" (`xid < xmax` and not in `xip`). The cache uses it to forget its own writes whose change can no longer come back.

A caveat of the transaction ids: `pg_current_xact_id()` returns the id of the **top-level** transaction, even inside a subtransaction (a `SAVEPOINT`, a PL/pgSQL `EXCEPTION` block), and `xip` lists top-level transactions, so the two always agree.

#### The batched read

`readLilypadChangesBatch` ([line 229](../src/dbGate/LilypadChangelog.ts#L229)) reads several tables in **one statement**. One statement matters: behind a transaction-mode pooler, two separate statements could run on different backends, and the snapshot would not match the rows. The query ([line 249](../src/dbGate/LilypadChangelog.ts#L249)) is explained clause by clause in [5.5](#55-the-changelog-query-clause-by-clause).

Each request is either `{ cursor }` (trusted: continue from where I stopped) or `{ lookback }` (untrusted: give me everything from the last N ms). `readLilypadChanges` is the one-table wrapper; `pruneLilypadChangelog` deletes rows older than a retention.

#### The reader: one query for all the caches of a gate

An application may cache ten tables. Ten caches each polling the changelog would be ten queries per interval. `LilypadChangelogReader` ([LilypadChangelogReader.ts:31](../src/dbGate/LilypadChangelogReader.ts#L31)) is shared by every cache of a gate that uses the same changelog table (a `WeakMap<gate, Map<table, reader>>`, [line 101](../src/dbGate/LilypadChangelogReader.ts#L101)); the `WeakMap` lets the reader be garbage collected with the gate.

Each cache **subscribes** with two functions: `request(readAt)` (what to read for me: my cursor or a lookback) and `apply(result, request)` (apply what was read). When any cache needs a read, `read(subscriber)` ([line 56](../src/dbGate/LilypadChangelogReader.ts#L56)):

- no read running: start one that includes **every** current subscriber;
- a read running that includes this subscriber: share it;
- a read running that does not include it (it subscribed later): queue one read after it (shared by every late caller).

`readAll` ([line 83](../src/dbGate/LilypadChangelogReader.ts#L83)) asks each subscriber for its request, runs the batched query, and calls every `apply` with `Promise.allSettled`, so one cache's failure does not affect the others.

### 4.9 The schema check

[src/dbGate/LilypadSchemaCheck.ts](../src/dbGate/LilypadSchemaCheck.ts), 397 lines. Without the triggers, a `listen` cache would silently stay stale, and a `changelog` cache would fail every read. `checkLilypadSchema` ([line 243](../src/dbGate/LilypadSchemaCheck.ts#L243)) is two steps:

1. `readLilypadSchemaFacts` ([line 166](../src/dbGate/LilypadSchemaCheck.ts#L166)) reads only the catalogs. One query ([line 175](../src/dbGate/LilypadSchemaCheck.ts#L175)): server version, whether the changelog table exists (`to_regclass`), whether it has the `table_schema` column, whether the trigger function exists (`to_regprocedure`), and the function's comment (the version). Then, per table ([line 193](../src/dbGate/LilypadSchemaCheck.ts#L193)): the table's schema, and all its non-internal triggers as JSON: whether it calls the changelog function, its arguments, its `tgtype` bitmask, whether it is enabled, and the **source** of its function.
2. `evaluateLilypadSchema` ([line 254](../src/dbGate/LilypadSchemaCheck.ts#L254)) turns those facts into problems. It is a pure function, so every rule is unit-tested without a database. Checks on `tgtype` (bits `ROW=1, INSERT=4, DELETE=8, UPDATE=16, TRUNCATE=32`): a working changelog trigger must be row-level on all three operations; its first argument must be the primary key; a statement-level `TRUNCATE` trigger must exist. For `listen`, a regular expression looks for `pg_notify('cache_events'` in the function source, so a hand-written trigger counts too. The event bits of every enabled row trigger that notifies are OR-ed together, and must cover `INSERT`, `UPDATE` and `DELETE`: one trigger per operation is fine, but a trigger on `UPDATE` alone is reported, since the cache would never hear about inserts and deletes.

Every problem comes with the SQL that fixes it, generated by the same functions as the install SQL (except `missing-table` and `unsupported-version`, which the library cannot fix). Besides diagnostics, the check has a second job: it resolves **which schema** the table lives in, which the cache uses to ignore notifications about a same-named table in another schema.

A cache runs the check through its `LilypadSchemaVerifier` ([LilypadSchemaVerifier.ts:35](../src/cache/dbSync/LilypadSchemaVerifier.ts#L35)), at most once successfully per instance. `verify()` ([line 46](../src/cache/dbSync/LilypadSchemaVerifier.ts#L46)) caches the check promise, so concurrent callers share it. Two outcomes are distinguished:

- the check **ran** (whether or not it found problems): its promise stays cached and it is never repeated. The problems were already reported, and repeating the warning at every read would flood the logs;
- the check **could not run** (an error, e.g. the database was unreachable): `run` ([line 76](../src/cache/dbSync/LilypadSchemaVerifier.ts#L76)) returns `false`, the cached promise is forgotten, and its backoff starts (1 s, doubling up to 60 s). A later read calls `checkInBackground` ([line 67](../src/cache/dbSync/LilypadSchemaVerifier.ts#L67)), which runs it again once the backoff is over. Reads never wait for it. With `listen`, the first check runs before `LISTEN`; the reads only retry a check that failed.

The reset happens in a `.then` on the promise, not inside `run` itself: if the check failed synchronously, a reset inside it would run *before* `verify` stored the promise, and the failed check would stay cached.

### 4.10 LilypadDbCache

[src/cache/LilypadDbCache.ts](../src/cache/LilypadDbCache.ts), about 950 lines, with its sync strategies in [cache/dbSync/](../src/cache/dbSync/). A cache of one table on the engine of [4.6](#46-the-cache-engine-lilypadcachecore). What it adds:

1. **Fetching**: `getOrFetch(key)` = the engine's `getOrSetDetailed(key, () => gate.selectFromTableByPrimaryKey(...))`.
2. **Writing through**: `sqlCreate`/`sqlUpdate`/`sqlDelete` write to the database, then cache the row the database returned.
3. **Syncing**: learning about changes made elsewhere, through a strategy object (`listen`, `changelog` or `none`).
4. **Trust and renewal**: while the strategy is known to see every change, entries don't need a query at their TTL.
5. **The table as a whole**: `getAll()` returns every row, with as few queries as possible, by tracking which keys exist (`members`).

What it does **not** have is as important: the public writes of `LilypadCache` (`set`, `bulkSet`, `getOrSet`, `bulkSync`) and its bulk reads stay protected. Every value of the cache comes from the table (a fetch, a load, or the row a write returned), which is what makes renewing values past their TTL safe.

#### Types and construction

`create()` ([line 155](../src/cache/LilypadDbCache.ts#L155)) is generic over the row type `V` and the primary key column `PK`, both **inferred from `schema`**; the key type is `LilypadDbKey<V, PK> = V[PK] & LilypadCacheKey`. It builds the cache, runs the schema check if `verify: 'throw'`, calls the strategy's `start()` (which starts `LISTEN` for `listen`, unless lazy); on any failure, it disposes and rethrows.

The constructor ([line 188](../src/cache/LilypadDbCache.ts#L188)):

- takes `gate` and `schema` out of the options and calls `super` with the rest, `name` defaulting to the table name;
- validates the numeric options of `sync`;
- sets no bulk sync function: the table is loaded by its own `loadTable` (see [getAll](#members-and-getall)), which calls the engine's `replaceEntries`;
- takes the schema from a qualified `tableName` (`app.accounts` → `app`);
- creates the `LilypadSchemaVerifier` and the strategy, giving the strategy a **host** object (`syncHost()`, [line 244](../src/cache/LilypadDbCache.ts#L244)): a few closures over the cache's own methods (`applyChange`, `applyTruncate`, `expireEverything`, `emitInvalidation`, ...), so that the strategy can act on the cache without reaching into it.

#### The strategies

A strategy ([`LilypadDbSyncStrategy`, LilypadDbSyncTypes.ts:165](../src/cache/dbSync/LilypadDbSyncTypes.ts#L165)) answers four questions: what to start in `create()` (`start`), what to do before a read (`beforeRead`), since when it sees every change (`trustedSince`), and whether the writes of this instance come back through it (`seesOwnWrites`). Plus `dispose`.

- **`lilypadNoSync`** ([line 185](../src/cache/dbSync/LilypadDbSyncTypes.ts#L185)): nothing to start, nothing to wait for, never trusted.
- **`LilypadListenSync`** ([LilypadListenSync.ts:63](../src/cache/dbSync/LilypadListenSync.ts#L63)): registers a callback on `cache_events` whose `callbackId` includes the cache's id (two caches of the same table on one gate must not replace each other). `startListening` ([line 106](../src/cache/dbSync/LilypadListenSync.ts#L106)) runs the schema check, then `addListener`; if the cache was disposed while `LISTEN` was starting, it removes the listener again (otherwise a lazy `LISTEN` started by a read just before `dispose()` would leave a callback registered forever on the gate). `dispose` ([line 191](../src/cache/dbSync/LilypadListenSync.ts#L191)) waits for a `LISTEN` still starting before removing the listener, for the same reason. `trustedSince` ([line 147](../src/cache/dbSync/LilypadListenSync.ts#L147)) is the time `LISTEN` became active (reset by `onReconnect`), but only **while `gate.isListenHealthy()`**: without recent heartbeats, the cache does not trust it.
- **`LilypadChangelogSync`** ([LilypadChangelogSync.ts:29](../src/cache/dbSync/LilypadChangelogSync.ts#L29)): subscribes to the gate's reader, keeps the cursor, and reads the changelog before a read when `pollInterval` has passed ([line 62](../src/cache/dbSync/LilypadChangelogSync.ts#L62)). `trustedSince` is the start of the unbroken chain of cursor reads; `undefined` without a cursor or when the last read is older than `maxGap`.

#### Syncing before a read

The async reads (`getOrFetchDetailed`, [line 673](../src/cache/LilypadDbCache.ts#L673), and `getAll`) start with:

```ts
const syncing = this.sync.beforeRead();
if (syncing) await syncing;
this.renew(this.normalizeKey(key));
return this.getOrSetDetailed(key, valueFn, options);
```

`beforeRead` returns `undefined` when there is nothing to wait for, and the caller only awaits a real promise. That detail matters: even `await undefined` yields to the microtask queue. Without it, the read runs synchronously down to `flowControl.executeFn`, exactly as in the engine. So by the time `getOrFetch` returns its promise, the fetch is already registered as in flight, and a change applied immediately afterwards sees it (`hasReadInFlight`) and fences it. (Wrapping these three lines in an `async` helper would silently break this.) When something is due:

- `listen` + `connect: 'lazy'`: start `LISTEN` on the first read (unless it is already started or in backoff);
- `listen`, once `LISTEN` is started: only retry a schema check that could not run ([4.9](#49-the-schema-check));
- `changelog`: if `pollInterval` has passed (and no backoff), start the schema check in the background if it has not run yet (diagnostics only, reads do not wait for it), then read the changelog. With `poll: 'background'`, the read is not awaited.

Failures are logged and turned into a backoff ([3.8](#38-retries-back-off)).

`get()` (synchronous) cannot sync; it only renews.

#### Trust and renewal

The idea: if the cache is **certain** it would have heard about every change of the table, then a row that reaches its TTL without a change is still correct, and there is no reason to query it again.

`renew(key)` ([line 289](../src/cache/LilypadDbCache.ts#L289)) extends an expired entry's `expirationTime` (directly in the store, without a ticket: the value does not change) when all of these hold:

- `origin === 'source'`: it was read from the database or written by this instance, not a fallback and not an L2 copy;
- `expirationTime !== 0`: no change invalidated it;
- `fetchedAt >= sync.trustedSince()`: it was read while the sync was already watching, so any later change would have expired it;
- it is younger than `maxAge` (1 h by default). `maxAge` bounds the damage of changes the triggers cannot see (triggers disabled, `session_replication_role = replica` during a restore).

The new expiration is `min(now + ttl, fetchedAt + maxAge)`. L2 lifetimes are never extended: other instances may not be in sync.

Renewal is also why the ordering rules of [3.4](#34-tickets-ordering-asynchronous-writes) must hold without exception: an older row that slipped into the cache after a change would not just live until its TTL, it would be renewed until `maxAge`.

#### Applying a change

Changes arrive through two paths, which converge on `applyChange` ([line 328](../src/cache/LilypadDbCache.ts#L328)) and `applyTruncate` ([line 368](../src/cache/LilypadDbCache.ts#L368)):

```
changelog read ──> LilypadChangelogSync.apply(result, trusted) ──┐ mode 'lazy'   (trusted content)
LISTEN payload ──> LilypadListenSync.handleNotification ─────────┤ mode 'eager'  (a hint)
                                                                 ▼
                                     applyChange(op, id, mode, xid) / applyTruncate(mode)
```

The two modes differ in **how much the cache trusts the change**. A changelog row is written by the triggers only. A notification is not: in PostgreSQL, **any role connected to the database can `NOTIFY` any channel**, without privileges. A notification is therefore only a hint that something may have changed, and the cache never acts on its content without a query.

`applyChange`:

1. `resolveNotifiedKey(id)`: the key of the existing entry or member (so `'7'` becomes `7` if that is how it is cached), else a number if the schema says the primary key is a `number` and the conversion is exact, else the text.
2. `isOwnWrite(key, xid)`: skip changes this instance made itself (next section).
3. `DELETE` from the changelog: if the key is held (an entry, or a read in flight), cache it as `null` (the `null` entry also blocks a fetch in flight from storing the deleted row), even for a protected key. Otherwise, no entry: remove the key from `members` and from L2. A mass delete, or the lookback of a cold start, thus creates no entries, which would evict the rows the instance holds.
4. Otherwise, `INSERT`/`UPDATE` note the key as a member of the table. Then:
   - key **not held** (no entry, no read in flight): no query at all. Nobody asked for this row here. Remove it from L2 (other instances may have cached an old copy). An eager `DELETE` of such a key leaves it among the members: `getAll` will fetch it, and learn whether it is really gone.
   - held, `eager` (notifications, including `DELETE`): `refreshInBatch` re-fetches it now, together with the other keys notified meanwhile: the batch is sent a microtask later, once the notifications received in the same chunk have been handled, with one `selectFromTableByPrimaryKeys` (a statement that changes many rows notifies each of them, and one query per row would flood the pool). The keys of a failed batch are expired. `eagerReads` counts the keys of the pending and running batches, for `hasReadInFlight`. The query of a batch starts after the notifications of its keys, so it sees their changes even if an older read of the key is still running (the older result loses by its ticket). A forged `DELETE` thus costs part of one query and changes nothing; a real one caches `null`.
   - held, `lazy` (changelog): `markInvalid`, no query; the next read fetches it. The new ticket also discards a read in flight.

Why lazy for the changelog? A changelog read can return hundreds of changes at once (on a lookback, for instance); re-fetching them all eagerly would turn a poll into hundreds of queries, most of them for rows no one will ask for again.

`applyTruncate(mode)` expires everything, removes every cached key from L2, calls `rejectSharedBefore(now)` (L2 copies older than the truncate are refused from now on, even for keys this instance did not hold), empties `members` and raises `membersFloor` (a table load that started before the truncate must not bring back the old rows). From the changelog, the table is then known to be empty, with no query. From a notification, it also marks the table as not loaded, so the next `getAll()` loads it again: a forged `TRUNCATE` costs one load, not an empty result.

`LilypadChangelogSync.apply` ([LilypadChangelogSync.ts:106](../src/cache/dbSync/LilypadChangelogSync.ts#L106)) wraps it for a changelog read:

- **untrusted read** (a lookback, because there was no cursor or the gap exceeded `maxGap`): the local memory may have missed anything, so `expireEverything()`; then apply the lookback's changes anyway, because they remove L2 copies that other instances may still serve. The chain of trust starts at `readAt`.
- apply each change (each is returned once by a cursor read, see [4.8](#48-the-changelog));
- after applying, forget the own writes the new cursor covers (`forgetOwnWritesCoveredBy`, [LilypadDbCache.ts:416](../src/cache/LilypadDbCache.ts#L416)): their changes can no longer be returned;
- store the cursor, reset the backoff, emit a `changelog` event.

The **notification** path is `LilypadListenSync.handleNotification` ([LilypadListenSync.ts:151](../src/cache/dbSync/LilypadListenSync.ts#L151)): it ignores notifications once the cache is disposed; `parseLilypadNotification` ([line 20](../src/cache/dbSync/LilypadListenSync.ts#L20)) validates the JSON (a known `op`, a non-empty `table`, a string or number `id` except for `TRUNCATE`, string `schema` and `xid`) and anything else is logged as a warning and ignored; then it checks the table and schema, applies eagerly, emits a `notification` event, and calls the user's `onNotification`. With `applyChanges: false` it only calls `onNotification`, and the sync is not trusted.

#### Own writes

When this instance runs `sqlUpdate`, it caches the row the database returned. Seconds later, its own change comes back through the changelog or a notification. Applying it would expire the fresh row and cost a query, for nothing.

- `storeWritten` ([line 880](../src/cache/LilypadDbCache.ts#L880)) records `(key, xid, ticket of the stored entry)` in `ownWrites` (`recordOwnWrite`, [line 400](../src/cache/LilypadDbCache.ts#L400)), if the strategy `seesOwnWrites`.
- `isOwnWrite(key, xid)` ([line 388](../src/cache/LilypadDbCache.ts#L388)) removes the xid from the set and returns `true` only if the entry **still has the ticket** of that write. If anything replaced the entry since (another change, a fetch), the change is applied normally.

`ownWrites` is bounded two ways: by the changelog cursor (`lilypadCursorCovers`: a transaction still in `xip` is kept, so a write whose transaction was still running at a read is recognised when its change comes later), and, for `listen` where there is no cursor, by a 10-minute retention. The map is kept in the order of the last write (delete + set), so pruning stops at the first recent entry.

#### Writing through

`sqlCreate`, `sqlUpdate`, `sqlDelete` ([lines 910-952](../src/cache/LilypadDbCache.ts#L910)) share one pattern:

```ts
this.assertNotDisposed();
const startTicket = this.nextTicket();                    // before the write
const { row, xid } = await gate.updateToTable(...);
this.storeWritten(key, row, startTicket, xid);
this.emitInvalidation('write', [key]);
```

`storeWritten`: nothing if the cache was disposed during the write. If the entry's ticket is now greater than `startTicket`, something touched the key *while the write was running* (a change applied, a fetch that may have read the row before the write). The library cannot tell which of the two happened last in the database, so it does not guess: it expires the key, and the next read fetches the truth. Otherwise, `setValue(key, row)` (new ticket, L2 write) and record the own write.

#### refresh

`refresh(key)` ([line 701](../src/cache/LilypadDbCache.ts#L701)) re-fetches one row, with the running + queued coalescing described in [3.7](#37-single-flight-everywhere): a caller that arrives while a query runs gets the *next* query, which is guaranteed to start after the call. `fetchRow` ([line 741](../src/cache/LilypadDbCache.ts#L741)) uses `beginRead` and `storeFetched`, like `getOrSet`, and `fetchTimeout`.

#### Members and getAll

`getAll()` must return every row of the table. Loading the whole table each time is correct but expensive; returning the cached entries is cheap but wrong (the cache may hold only some rows). The solution is to track **which keys exist** separately from their values:

- `members: Map<normalizedKey, { key, ticket }>` ([line 122](../src/cache/LilypadDbCache.ts#L122)), set by each table load (`replaceMembers`) and kept up to date afterwards by `onValueStored` (a row → member, `null` → removed; fallbacks ignored; an older ticket never overrides a newer one), `addMember` (INSERT/UPDATE of an uncached key) and `applyTruncate`. Evicting an entry does **not** remove its member: the row still exists.
- `isTableLoaded()` ([line 487](../src/cache/LilypadDbCache.ts#L487)): the members are reliable if the last load happened after the sync became trusted, or, without a trusted sync, less than `bulkSync.ttl` ago.

`getAll()` ([line 789](../src/cache/LilypadDbCache.ts#L789)):

```
sync.beforeRead
members not reliable?  ──> loadTable()            (one full query)
stale = members whose entry is missing or expired (after renew)
stale > 25% of members? ──> loadTable() again     (one full query beats many key lookups)
fetchRows(stale)                                  (one IN query per 1000 keys)
return rowsOf(members, fetched, loaded)
```

Two subtleties:

- **With `maxEntries`**, a load may store more rows than the cache can hold; the evicted ones would then count as stale and be fetched again immediately. So `loadTable` does not rely on the store: `loadRows` (with `beginRead`, `replaceMembers` and the engine's `replaceEntries`) returns the loaded rows, and concurrent callers share the promise of one load (`tableLoad`), bounded by `bulkSync.timeout`. `staleKeys` treats a key missing from the store but present in `loaded` as fresh, and `rowsOf` ([line 612](../src/cache/LilypadDbCache.ts#L612)) takes each value from, in order: the fresh entry, the rows just fetched, the rows just loaded, the expired entry.
- **`loadTable` does not use the engine's bulk sync**: `getAll` decides freshness with `isTableLoaded`, not with the engine's timer.

`fetchRows` ([line 544](../src/cache/LilypadDbCache.ts#L544)) is single-flight **per key**: keys already being fetched join those queries, the rest go into one new query (`queryRows`, [line 581](../src/cache/LilypadDbCache.ts#L581)), which stores each row with `read.store` (this instance only, not L2, like the table loads) and caches `null` for keys without a row.

`getAll(keys)` skips the members: it fetches only the given keys that are stale.

#### dispose

[Line 850](../src/cache/LilypadDbCache.ts#L850): return if already disposed; release the singleton; dispose the engine (from now on, notifications and changelog reads that arrive are ignored); clear the database bookkeeping; then `sync.dispose()`, which unsubscribes from the changelog reader, or waits for a `LISTEN` still starting and removes the listener.

---

## 5. Line by line: five traces

Each trace follows one scenario through the code. Line numbers are links; keep the source open next to this document.

### 5.1 Three concurrent `getOrFetch(42)` on a cold instance

Setup: a `LilypadDbCache` of `users` with `sync: { strategy: 'changelog', pollInterval: 5000 }`, no shared level, just created. Three requests call `users.getOrFetch(42)` in the same tick. Call them A, B and C.

**A:**

1. `getOrFetch` → `getOrFetchDetailed` ([DbCache 673](../src/cache/LilypadDbCache.ts#L673)): `assertNotDisposed()`, then `this.sync.beforeRead()` (line 680) → `LilypadChangelogSync.beforeRead` ([Sync 62](../src/cache/dbSync/LilypadChangelogSync.ts#L62)). `lastRead` is `0`, so a poll is due (line 64). The schema check has not run, so it starts in the background (`checkInBackground`, line 67). `read()` → `reader.read(subscriber)` ([Reader 56](../src/dbGate/LilypadChangelogReader.ts#L56)): nothing is running, so `start()` includes every subscriber and runs `readAll`.
2. `readAll` calls `subscriber.request(readAt)` → `request` ([Sync 92](../src/cache/dbSync/LilypadChangelogSync.ts#L92)): no cursor yet, so `{ lookback: ttl + swr + 60 000 }`. Then the batched query runs. A awaits it.

**B and C** arrive while A is awaiting. `lastRead` is still `0` (it is set only after the read is applied), so their `beforeRead` also calls `reader.read(subscriber)`. This time `current` exists and includes the subscriber, so they get **the same promise** (Reader line 61). One query for three callers.

**The read completes.** `apply(result, trusted = false)` ([Sync 106](../src/cache/dbSync/LilypadChangelogSync.ts#L106)): the request was a lookback, so `expireEverything()` (nothing to expire yet, but `ticketFloor` rises to, say, 3) and the chain of trust starts at `readAt`. The returned changes are applied (keys not held: only L2 deletes and members). Cursor stored, `lastRead = readAt`.

**A resumes** at line 684: `renew('42')` does nothing (no entry). `getOrSetDetailed` ([Core 553](../src/cache/LilypadCacheCore.ts#L553)): no local entry, no shared level, no stale entry, no cooldown → `fetchAndStore` ([632](../src/cache/LilypadCacheCore.ts#L632)) → `flowControl.executeFn({ functionIdentifier: 'LilypadCache-getOrSet-42', ... })` ([Flow 258](../src/flow/LilypadFlowControl.ts#L258)):

- line 260: nothing in flight;
- line 267: `rateLimit` does nothing (the cache's flow control has no `rate`);
- line 276: `executeWithRetries` → `executeWithTimeout(fn, 5000)` → `fn(signal)` starts **synchronously**: `beginRead()` takes ticket 4 ([Core 655](../src/cache/LilypadCacheCore.ts#L655)), and `valueFn` sends `SELECT ... WHERE id = 42`;
- line 286: the promise is registered in `singleFlightMap`. No `await` happened between 260 and 286.

**B resumes** (its promise resolved in the same microtask batch): same path down to `executeFn`, which now finds `LilypadCache-getOrSet-42` in flight and returns A's promise. **C** does the same.

**The row arrives.** Back in `fn`: `signal.aborted` is false, so `read.storeFetched(42, row)` ([399](../src/cache/LilypadCacheCore.ts#L399)): no failure to clear; `setIfNewer` ([373](../src/cache/LilypadCacheCore.ts#L373)) compares ticket 4 with `currentTicket('42')`: no entry, no fence, floor 3, and `4 > 3`, so it stores. `writeEntry` → `onValueStored` (members are not tracked yet, since the table was never loaded) → no eviction. `writeShared` does nothing (no shared level). The `finally` of `executeFn` removes the single-flight entry.

All three callers resolve to `{ value: row, status: 'MISS', refreshFailed: false }`. Totals: one changelog query, one row query.

### 5.2 A slow fetch loses to a write

Four variations, with explicit ticket numbers.

**(a) The key has an entry.**

| Step | Code | Ticket |
| --- | --- | --- |
| Entry `a` exists, expired | | entry = 3 |
| `getOrSet('a', slowFn)` starts the fetch | `beginRead()` | read = 4 |
| `set('a', v2)` | `setValue` → `writeLocal` → `nextTicket()` | entry = 5 |
| `slowFn` resolves with `v1` | `setIfNewer(..., 4)`: `4 <= currentTicket = 5` | discarded |

The caller of `getOrSet` receives `v1`; the cache keeps `v2`.

**(b) The key has no entry, and is invalidated during the fetch.**

| Step | Code | Ticket |
| --- | --- | --- |
| `getOrSet('b', slowFn)` starts | `beginRead()` | read = 6 |
| A change for `b` → `markInvalid('b')` → `expireNormalized('b')` | no entry, but `hasReadInFlight('b')` → fence ([1023](../src/cache/LilypadCacheCore.ts#L1023)) | fence(b) = 7 |
| `slowFn` resolves | `setIfNewer(..., 6)`: `currentTicket = max(floor, 7) = 7` | discarded |

Without the fence, the fetch, which may have read the row *before* the change, would have cached the old row.

**(c) The key is invalidated, then its entry is purged, during the fetch.**

| Step | Code | Ticket |
| --- | --- | --- |
| Entry `c` exists | | entry = 8 |
| `getOrSet('c', slowFn, { skipCache: true })` starts | `beginRead()` | read = 9 |
| A change for `c` → `expireNormalized('c')` | the entry is rewritten with `expirationTime: 0` | entry = 10 |
| `cleanupOnAccess` → `purgeEntries` removes the expired entry | `dropEntry`: a read is in flight → fence = entry ticket ([283](../src/cache/LilypadCacheCore.ts#L283)) | fence(c) = 10 |
| `slowFn` resolves with the row read before the change | `setIfNewer(..., 9)`: `currentTicket = max(floor, 10) = 10` | discarded |

Without `dropEntry`'s fence, the key would have no entry and no fence at this point, and the pre-change row would be stored; in a `LilypadDbCache` it would then be renewed until `maxAge`.

**(d) A bulk sync completes while a fetch of a missing key runs.**

| Step | Code | Ticket |
| --- | --- | --- |
| `getOrSet('d', slowFn)` starts | | read = 11 |
| `bulkSync()` starts | `beginRead()` in `runBulkSync` | sync = 12 |
| The sync's data has no `d`; it completes | `ticketFloor = 12` ([875](../src/cache/LilypadCacheCore.ts#L875)) | floor = 12 |
| `slowFn` resolves with an old `d` | `11 <= max(12, …)` | discarded |

### 5.3 An `UPDATE` from `psql` reaches a serverless instance

Setup: an instance holds `accounts` row `7` (fresh from a fetch 30 s ago, ticket 40); `sync: changelog`, `pollInterval: 5000`, `shared` configured. Someone runs `UPDATE accounts SET plan = 'pro' WHERE id = 7;` in `psql`.

**In the database.** The statement trigger `accounts_lilypad_update` fires `AFTER UPDATE FOR EACH STATEMENT` with the transition tables `lilypad_old` and `lilypad_new`, and calls `lilypad_cache_changes_record('id')`. The key `'7'` is in both, so there is no extra `DELETE`. It inserts `(table_schema 'public', table_name 'accounts', row_id '7', op 'UPDATE')`; `xid` defaults to `pg_current_xact_id()`, say 9100. It also sends a `pg_notify`, which nobody hears on Vercel.

**On the instance**, the next request calls `accounts.getOrFetch(7)`:

1. `beforeRead`: 5 s have passed since the last read, so the reader builds requests for **every** subscribed cache of the gate, e.g. `[{ accounts, cursor: { xmax: 9050, xip: [] } }, { users, cursor: … }]`, and runs one query.
2. The query returns the next cursor (say `{ xmax: 9121, xip: [9120] }`: transaction 9120 is still running) and, for request 0, the change `{ id: '551', xid: 9100n, rowId: '7', op: 'UPDATE' }`.
3. `apply(result, trusted = true)` → `applyChange('UPDATE', '7', 'lazy', 9100n)` ([328](../src/cache/LilypadDbCache.ts#L328)):
   - `resolveNotifiedKey('7')` finds the entry and returns its key, the number `7`;
   - `isOwnWrite(7, 9100n)`: no own write for `7` → `false`;
   - the entry exists → held → `addMember(7)` → `markInvalid(7)`: `expireNormalized` rewrites the entry with `expirationTime: 0`, ticket 55, `invalidatedAt: now`; `deleteShared(7)` removes the `v` key of `7` from L2 in the background; the next bulk sync is forced.
   - Back in `apply`: the own writes covered by the new cursor are forgotten; cursor stored; a `changelog` event with the tag `lilypad:accounts:7`.
4. `renew('7')`: `expirationTime === 0`, so no renewal.
5. `getOrSetDetailed`: the L1 entry is expired. L2: suppose another instance, which has not polled yet, writes its old copy back just now. `adoptShared` refuses it: `remote.fetchedAt < current.invalidatedAt` ([717](../src/cache/LilypadCacheCore.ts#L717)). Stale window: `0 + swr < now`, so not served stale. Fetch: `SELECT ... WHERE id = 7` returns `plan = 'pro'`, stored with a ticket greater than 55.

The change reached the instance within `pollInterval`, with one changelog query (shared with every other cached table of the gate) and one row query. The next poll asks for `xid >= 9121 OR xid = ANY({9120})`: change 551 is not returned again.

### 5.4 `sqlUpdate` and its echo

Same instance. The application calls `accounts.sqlUpdate({ id: 7, plan: 'team' })`.

1. `sqlUpdate` ([930](../src/cache/LilypadDbCache.ts#L930)): not disposed; `key = 7`; `startTicket = nextTicket()` = 60.
2. `gate.updateToTable` ([Gate 461](../src/dbGate/LilypadDbGate.ts#L461)) → `prepareWrite`: sanitization; primary key present; with `generatedPrimaryKey` the `id` is removed from the data (it only identifies the row); `columns = ['plan']` (only the declared columns that are not `undefined`).
3. SQL: `UPDATE "accounts" SET "plan" = $1 WHERE "id" = $2 RETURNING "id", "email", "plan", pg_current_xact_id()::text AS "__lilypad_xid"`. `writeResult` strips `__lilypad_xid` and returns `{ row, xid: 9200n }`.
4. `storeWritten(7, row, 60, 9200n)` ([880](../src/cache/LilypadDbCache.ts#L880)): the entry's ticket (say 58) is not greater than 60, so nothing interfered. `setValue(7, row)` → ticket 61, and the row is written to L2. `recordOwnWrite('7', 9200n, 61)`.
5. `emitInvalidation('write', [7])`: `platform.onInvalidate` can call `revalidateTag('lilypad:accounts:7')`.

**Five seconds later**, a poll returns the trigger's change `{ xid: 9200n, rowId: '7', op: 'UPDATE' }`. `applyChange` → `isOwnWrite(7, 9200n)` ([388](../src/cache/LilypadDbCache.ts#L388)): the xid is in the set (removed now), and the entry's ticket is still 61 → `true` → return. No expiry, no query.

**Variation:** the poll ran while transaction 9200 was still committing, so its cursor lists 9200 in `xip` and does not return the change. `forgetOwnWritesCoveredBy` keeps 9200 (`lilypadCursorCovers` is false for a transaction in `xip`), and the next poll returns the change and recognises it.

**Variation:** between step 4 and the poll, another instance updated row 7, and this instance applied that change first (ticket 70). At the echo, `store.get('7').ticket` is 70, not 61 → `isOwnWrite` returns `false`, and the echo is applied normally. That is correct: the entry no longer holds our write's result.

**Variation:** while the `UPDATE` of step 3 was running, a poll applied someone else's change to row 7 (entry ticket becomes 62 > 60). The library cannot know which write committed last, so `storeWritten` calls `markInvalid` instead of caching the row, and the next read queries the database.

### 5.5 The changelog query, clause by clause

[LilypadChangelog.ts:249](../src/dbGate/LilypadChangelog.ts#L249). The inputs are four parallel text arrays, one element per request: the quoted table reference, the cursor's `xmax` (or `''`), the cursor's `xip` joined by commas, and the lookback in seconds.

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

| Term | Meaning |
| --- | --- |
| **Engine** | `LilypadCacheCore`, shared by `LilypadCache` (public writes) and `LilypadDbCache` (values from its table only) |
| **L1** | The memory of one instance (`store`) |
| **L2** / shared level | A key-value store shared by all instances (`platform.shared`, e.g. the Vercel Runtime Cache), handled by `LilypadSharedLevel` |
| **Ticket** | A number from an ever-increasing counter that orders writes; a read stores its result only if its ticket beats the key's |
| **Floor** (`ticketFloor`) | The ticket that reads of *missing* keys must beat; raised by bulk syncs and `expireEverything` |
| **Fence** | A per-key floor, set when a missing key is expired, or an entry removed, while a read of it runs |
| **Single-flight** | Concurrent calls for the same identifier share one execution |
| **Fallback** | A value returned after a failed fetch (`onError`), cached locally with `origin: 'fallback'` |
| **Cooldown** | After a failed fetch, the key is not fetched again for `failureCooldown` ms |
| **Stale** / SWR | An expired value served while it is refreshed in the background, within `staleWhileRevalidate` |
| **Invalidated** | `expirationTime === 0`: expired, never served stale, still a fallback |
| **Bulk sync** | Replacing the whole cache with `bulkSync.fn`; "fresh" while `now < bulkSyncExpirationTime` |
| **Members** | The keys that `LilypadDbCache` knows to exist in its table, used by `getAll` |
| **Strategy** | How a `LilypadDbCache` follows its table: `LilypadListenSync`, `LilypadChangelogSync` or `lilypadNoSync` |
| **Trusted sync** | `LISTEN` active with recent heartbeats, or the changelog read within `maxGap`: the cache sees every change |
| **Heartbeat** | A notification the gate sends itself; while they come back, `isListenHealthy()` is true |
| **Renew** | Extending an expired, trusted, unchanged entry without a query, up to `maxAge` |
| **Cursor** | For the changelog: `{ xmax, xip }`, the transactions the last read could not see; the next read returns their changes |
| **Lookback** | A changelog read by time instead of cursor, when the cursor is missing or too old |
| **Eager / lazy** | How a change is applied: a notification is a hint, re-read now (`eager`); a changelog row is trusted, applied without a query (`lazy`) |
| **Own write** | A change made by this instance's `sqlCreate`/`sqlUpdate`/`sqlDelete`, recognised by its `xid` |

**Where to go next.** The tests are the best executable documentation of the edge cases, and each describes one behaviour by name:

- [LilypadCache.test.ts](../src/cache/LilypadCache.test.ts): tickets, fences (including "entries removed while a read is in flight"), bulk sync, eviction (everything runs on fake timers, `vi.advanceTimersByTimeAsync`);
- [LilypadCache.shared.test.ts](../src/cache/LilypadCache.shared.test.ts): L2, its key format, stale-while-revalidate and the cooldown, with an in-memory store that clones values;
- [LilypadDbCache.test.ts](../src/cache/LilypadDbCache.test.ts): the sync strategies, untrusted notifications, `getAll`, own writes, against an in-memory fake gate and a mocked changelog;
- [LilypadChangelogReader.test.ts](../src/dbGate/LilypadChangelogReader.test.ts) and [LilypadSchemaCheck.test.ts](../src/dbGate/LilypadSchemaCheck.test.ts): the batching of changelog reads, and every rule of the schema check, without a database;
- [LilypadDbGate.integration.test.ts](../src/dbGate/LilypadDbGate.integration.test.ts): the real thing against PostgreSQL in Docker, including the out-of-order commit test for the changelog cursor ("should not miss a transaction that commits after a later one"), the long-transaction test, the heartbeat, and a reference `NOTIFY` trigger.

To see a behaviour in action, run a single test by name: `npx vitest run --project unit -t "<part of the test name>"`.
