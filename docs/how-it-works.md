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
            ├──────────────────────────────────────────────────────────┤
            │ LilypadCache      the generic cache: TTL, single-flight, │
            │                   write ordering, shared level, SWR      │
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
├── logger/
│   ├── LilypadLibLogger.ts         the minimal logger type + libLog()
│   ├── LilypadLogger.ts            the full logger (channels, components)
│   ├── LilypadLoggerComponent.ts   base class of the outputs
│   ├── formatLogValue.ts           util.inspect-like formatting, edge-safe
│   └── components/                 Console, JsonConsole, Discord
├── flow/LilypadFlowControl.ts      timeout, retries, rate limit, single-flight
├── serializer/LilypadSerializer.ts key mapping + default elision
├── cache/
│   ├── LilypadCache.ts             the generic cache (≈1650 lines)
│   └── LilypadDbCache.ts           the table cache (≈1350 lines)
├── dbGate/
│   ├── LilypadDbGate.ts            postgres.js wrapper, CRUD, LISTEN
│   ├── LilypadChangelog.ts         changelog SQL + the cursor read
│   ├── LilypadChangelogReader.ts   one batched read for all caches of a gate
│   └── LilypadSchemaCheck.ts       checks triggers/tables in the catalogs
├── entries/*.ts                    the public subpaths
└── index.ts                        the root entry (everything but db)
```

Who uses whom (arrows point to what is used):

```
LilypadDbCache ──extends──> LilypadCache ──uses──> LilypadFlowControl
   │    │                        │
   │    │                        └──uses──> platform helpers (runInBackground, sharedStoreOperation, ...)
   │    ├──uses──> LilypadDbGate ──uses──> postgres.js, node:crypto
   │    ├──uses──> LilypadChangelogReader ──uses──> readLilypadChangesBatch (LilypadChangelog)
   │    └──uses──> checkLilypadSchema
   │
every module ──logs through──> libLog(logger, level, name, ...)
LilypadLogger, LilypadDbGate, LilypadDbCache ──register in──> the singleton registry
```

Two observations help when reading the code:

- **The two caches are 60% of the library.** `LilypadCache` holds the hard concurrency logic; `LilypadDbCache` adds database-specific knowledge on top, mostly by calling protected methods of its parent (`beginRead`, `expire`, `markInvalid`, `expireEverything`, ...) and by overriding two hooks (`onValueStored`, `hasReadInFlight`).
- **Nothing in the lower layers knows about the upper ones.** `LilypadFlowControl` knows nothing about caches; `LilypadDbGate` knows nothing about caching; `LilypadCache` knows nothing about databases.

### 2.2 How the package is cut

The package is published as several **subpath entries**, one per module ([src/entries/](../src/entries/)): `@lilypad/libs/logger`, `/cache`, `/flow`, `/serializer`, `/singleton`, `/platform` and `/db`. Each entry file is only a list of re-exports: a class that is not listed there does not ship.

The root entry [src/index.ts](../src/index.ts) re-exports every entry **except `db`**. The reason is the edge runtime (Next.js middleware, Vercel Edge Functions): it has no TCP sockets and no `node:*` modules. `db` needs both (postgres.js, and `node:crypto` for hashing connection strings), so it is kept out of the root, and importing `@lilypad/libs` stays edge-safe.

This rule is enforced twice:

- [src/entries/entries.test.ts](../src/entries/entries.test.ts) reads the source of each entry, follows every *value* import (`import type` is skipped, since it disappears at build time) and fails if an edge entry reaches any external module. The `db` entry may reach exactly `postgres` and `node:crypto`.
- The `edge` project of [vitest.config.ts](../vitest.config.ts) runs the tests of the edge modules a second time inside the `edge-runtime` environment, where Node.js globals do not exist. This is why the cache uses `globalThis.crypto.randomUUID()` and never `node:crypto`.

The build ([tsup.config.ts](../tsup.config.ts)) bundles each entry as CJS and ESM with type declarations. `splitting: true` puts the modules shared by several entries in common chunks, so that there is **one copy of each class** no matter which subpath imported it. Without that, `error instanceof LilypadCacheCooldownError` could fail when the error was thrown by a class from another bundle copy.

`dist/` is committed, because the package is installed straight from git. The pre-commit hook rebuilds it and stages it, and CI checks that the committed `dist/` matches the sources.

### 2.3 The life of an instance

Every stateful class follows the same lifecycle:

```
create / new ──> use ──> dispose() / close()
     │                        │
     └─ singleton? ──> registry (globalThis) <── removed here
```

- `LilypadLogger`, `LilypadDbGate` and `LilypadDbCache` have **private constructors**; you get an instance from a static `create()`. That gives the class one place to decide whether to build a new instance or return a registered singleton, and (for the async ones) to do async setup such as starting `LISTEN` before handing out the instance.
- `LilypadCache`, `LilypadFlowControl` and `LilypadSerializer` use plain `new`: they need no async setup and are not singletons.
- `dispose()` (caches) and `close()` (gate) release resources and remove the instance from the singleton registry, so that the next `create()` builds a fresh one.

---

## 3. The ideas that recur everywhere

These are the patterns you will meet in almost every file. Once you recognise them, most of the code reads as variations on them.

### 3.1 Never crash the host: background work without unhandled rejections

In Node.js, a promise that rejects with no handler attached terminates the process (by default since Node 15). The library starts a lot of work that nobody awaits: log messages, writes to the shared store, background refreshes, invalidation events, listener callbacks. Every one of those goes through a helper that attaches an error handler **before** anything else can happen:

| Helper | Where | What it guarantees |
| --- | --- | --- |
| `libLog(logger, level, ...)` | [LilypadLibLogger.ts:17](../src/logger/LilypadLibLogger.ts#L17) | Calls `logger[level]` if it exists; swallows a sync throw; attaches a `.catch` if the result is a promise |
| `runInBackground(platform, task, onError)` | [LilypadPlatform.ts:78](../src/platform/LilypadPlatform.ts#L78) | `task.catch(onError)` first, then hands the *handled* promise to `platform.background` |
| `runAfterResponse(platform, work, onError)` | [LilypadPlatform.ts:96](../src/platform/LilypadPlatform.ts#L96) | Same, for work that should start after the response |
| `sharedStoreOperation(op, fallback, timeout, onError)` | [LilypadPlatform.ts:117](../src/platform/LilypadPlatform.ts#L117) | Races the operation against a timeout; any failure resolves to `fallback` |
| `runCallbackSafely(channel, id, cb)` | [LilypadDbGate.ts:540](../src/dbGate/LilypadDbGate.ts#L540) | `Promise.resolve().then(cb).catch(log)`: catches both sync throws and rejections of listener callbacks |
| the logger's channel methods | [LilypadLogger.ts:154](../src/logger/LilypadLogger.ts#L154) | Never reject: component errors go to `errorLogging`, then to `console.error` |

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

This is what lets the cache remember negative results, so that repeated lookups of a missing id stop reaching the database. Internally, `LilypadCachedValueType<V>` is `V | null`, and `undefined` never gets stored. Some code relies on the distinction in subtle ways: a `DELETE` is cached as `set(key, null)` rather than removing the entry (see [3.4](#34-tickets-ordering-asynchronous-writes)), and `LilypadDbCache` uses `null` to remove a key from its list of table rows ([LilypadDbCache.ts:787](../src/cache/LilypadDbCache.ts#L787)).

### 3.4 Tickets: ordering asynchronous writes

This is the most important idea in the library, and the one that makes the cache code look more complicated than a textbook cache.

**The problem.** A read of the source is asynchronous: it starts at one moment, and its result arrives later. Meanwhile, anything can happen to the same key: a `set`, an `invalidate`, a database notification, another fetch. If the slow read simply stored its result when it arrived, it could overwrite a newer value with an older one:

```
time ─────────────────────────────────────────────────────────────>
fetch("a")   starts ─────── reads v1 from DB ─────────────── stores v1   ✗ overwrites v2
set("a", v2)                          stores v2
```

**The solution.** A counter, `lastTicket`, that only goes up ([LilypadCache.ts:385](../src/cache/LilypadCache.ts#L385), `nextTicket()` at [line 496](../src/cache/LilypadCache.ts#L496)). Every entry carries the ticket of the write that produced it. Then:

- A **synchronous write** (`set`, `expire`, ...) takes a new ticket at the moment it writes. It always wins.
- An **asynchronous read** takes its ticket **when it starts**, with `beginRead()` ([line 504](../src/cache/LilypadCache.ts#L504)). When its result arrives, it stores it through `setIfNewer` ([line 640](../src/cache/LilypadCache.ts#L640)), which refuses to store unless the read's ticket is **greater** than the key's current ticket.

```
                      ticket
fetch("a")   starts:    4  ──────────────────────── setIfNewer(ticket 4): 4 <= 5 → discarded ✓
set("a", v2)                    entry.ticket = 5
```

The caller of the slow fetch still receives the value it fetched; it is just not cached. "The key's current ticket" is computed by `currentTicket(normalizedKey)` ([line 519](../src/cache/LilypadCache.ts#L519)):

```ts
const entry = this.store.get(normalizedKey);
if (entry) return entry.ticket;                                 // the key has an entry
return Math.max(this.ticketFloor, this.fences.get(normalizedKey) ?? 0); // it has none
```

The second line covers a subtle case: what if the key has **no entry** at all? Then there is no entry ticket to compare with, and two mechanisms fill the gap:

- **`ticketFloor`** ([line 390](../src/cache/LilypadCache.ts#L390)): a threshold for every missing key. It is raised when a bulk sync completes (the sync saw the whole source, so a read that started before it is older than what the sync knows) and by `expireEverything()` (the source may have changed in any way).
- **`fences`** ([line 398](../src/cache/LilypadCache.ts#L398)): a per-key threshold. When a key with no entry is expired while a read of it is in flight, `expireNormalized` sets a fence with a new ticket ([line 1514](../src/cache/LilypadCache.ts#L1514)). The read in flight may have queried the database before the change, so its result must be discarded. A fence is removed as soon as the key gets an entry (the entry's ticket then does the job) or when no read of the key is in flight any more (`purgeExpired`).

Three consequences worth remembering:

- **Every code path that reads the source and stores the result must go through `beginRead()`.** That is why `setIfNewer` and `storeFetched` are `private`: subclasses can only reach them through the `LilypadCacheRead` object that `beginRead()` returns (`read.store`, `read.storeFetched`). `LilypadDbCache` uses it for single-row fetches, batched fetches and table loads.
- **Expiring an entry takes a new ticket too** ([line 1521](../src/cache/LilypadCache.ts#L1521)). So "invalidate this key" also means "discard any read of this key that is already running", which is exactly what a change notification needs.
- **A `DELETE` is stored as `null`, not removed.** If the entry were removed, a fetch that started before the delete could store the deleted row afterwards. A `null` entry with a fresh ticket blocks it.

### 3.5 `expirationTime: 0` means "invalidated"

An entry expires when `Date.now() >= entry.expirationTime` (`isStale`, [line 227](../src/cache/LilypadCache.ts#L227)). Invalidation does not remove the entry: it sets `expirationTime` to `0` and records `invalidatedAt` ([line 1519](../src/cache/LilypadCache.ts#L1519)). One value encodes several rules at once:

- The entry is expired, so `get` returns `undefined` and `getOrSet` fetches again.
- It is **never served stale**: the stale window test is `now < expirationTime + staleWindow`, which is false for `0 + window`.
- It **keeps its value**, which remains available to `returnOldOnError` if the next fetch fails.
- `LilypadDbCache.renew` refuses to extend it ([LilypadDbCache.ts:528](../src/cache/LilypadDbCache.ts#L528)).
- `invalidatedAt` lets `adoptShared` refuse copies from the shared level that were produced before the invalidation ([LilypadCache.ts:1153](../src/cache/LilypadCache.ts#L1153)).

### 3.6 Keys are compared by their string form

Keys can be `string | number`, but the store is a `Map<string, entry>` keyed by `normalizeKey(key) = String(key)` ([line 488](../src/cache/LilypadCache.ts#L488)). So `get(7)` and `get('7')` read the same entry. This matters for databases: a notification or a changelog row carries the primary key as text (`'7'`), while the application uses numbers. Each entry keeps the **original** key (`entry.key`), so that `bulkGet({})` can return keys with the type they were stored with. `LilypadDbCache.resolveNotifiedKey` ([LilypadDbCache.ts:1166](../src/cache/LilypadDbCache.ts#L1166)) turns a text id back into the right type.

Inside the class, you will see pairs of methods such as `delete`/`deleteNormalized` and `expire`/`expireNormalized`: the public one takes a key, the private one takes an already normalized string, which is what internal loops have.

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
| the schema check | the cache | `LilypadDbCache.schemaCheck` |

The recurring trick is to **store the promise itself** in a map, synchronously, before any `await`, and to remove it when it settles, with a guard like `if (map.get(id) === promise) map.delete(id)` so that a newer promise registered meanwhile is not removed by mistake.

Two of them (`refresh` and the changelog reader) add a **queued** second operation. Joining a read that is already running is not always enough: that read may have queried the database *before* the change the new caller wants to see. So a call that arrives while a query runs waits for one more query, and every caller arriving after that shares the queued one.

---

## 4. Module by module

From the simplest to the most complex. Each section starts with what the module is for, then how it works.

### 4.1 The singleton registry

[src/singleton/LilypadSingleton.ts](../src/singleton/LilypadSingleton.ts), 130 lines.

**Purpose.** In Next.js development, modules are re-evaluated on every hot reload, so a module-level `const gate = ...` would open a new connection pool at every save. And an application can end up with two copies of the library in different bundles. A registry stored on `globalThis` survives both.

**How.**

- Lines 1-7: the two maps live on `globalThis.__lilypadSingletonMap` and `globalThis.__lilypadSingletonSignatureMap`, created with `??=` so the first copy of the library creates them and every later copy reuses them. The signatures are in a *separate* map so that older bundles, which only know the first map, can still share it.
- `getLilypadSingletonInstance` ([line 41](../src/singleton/LilypadSingleton.ts#L41)): if registered, return it; otherwise create, register, return. If the registered value is a `Promise`, an async creation is in progress, and a sync caller cannot wait for it, so it throws.
- `getLilypadSingletonInstanceAsync` ([line 75](../src/singleton/LilypadSingleton.ts#L75)) is the interesting one. It stores the **creation promise** in the map right away (line 86). A concurrent caller finds the promise and returns it (line 82); since the function is `async`, returning a promise adopts it, so every caller awaits the same creation. When the creation resolves, the promise is replaced by the instance (line 94); if it rejects, the entry is removed (line 100), so the next call retries. Both steps first check `singletonMap.get(identifier) === instancePromise`, in case someone removed or replaced the entry meanwhile.
- **Signatures** (`checkSignature`, [line 29](../src/singleton/LilypadSingleton.ts#L29)): a later call with the same identifier but different options gets the existing instance, and its options are silently ignored. To make this visible, each `create()` passes a string describing its important options. The first one is stored; a different one triggers `onMismatch` (a warning). `LilypadDbGate` hashes its signature with SHA-256, because connection strings contain passwords and the map is global.
- `createLilypadSingletonAbleAsync` ([line 115](../src/singleton/LilypadSingleton.ts#L115)) is the shared body of the async `create()` methods. It prefixes the identifier with the class name (`LilypadDbGate:main`), so that a gate and a cache can both be called `main`, and passes the resulting registry key to the factory. The instance stores the key, to remove itself from the registry in `close()`/`dispose()`.

### 4.2 The platform helpers

[src/platform/LilypadPlatform.ts](../src/platform/LilypadPlatform.ts), 143 lines. Section [3.1](#31-never-crash-the-host-background-work-without-unhandled-rejections) covered `runInBackground` and `runAfterResponse`. The other two:

- `sharedStoreOperation` ([line 117](../src/platform/LilypadPlatform.ts#L117)): `Promise.race` between the operation and a timer that rejects after `timeout` ms. Any error, including the timeout, calls `onError` and resolves to `fallback`. The `finally` clears the timer so it does not keep Node.js alive. This is how "the shared store is never required to answer" is implemented: a read that fails looks exactly like a miss.
- `toTtlSeconds` ([line 141](../src/platform/LilypadPlatform.ts#L141)): the library works in milliseconds, but the Vercel Runtime Cache takes TTLs in seconds. It rounds up, with a minimum of 1 s, so that a short TTL never becomes `0` (which a store could read as "forever").

### 4.3 Logging

There are two different things here, and it helps to keep them apart:

- **`LilypadLibLogger`**, the logger the *other modules* accept: any object with some of the methods `error`, `warn`, `info`, `debug`. `console` qualifies, so does pino, so does a `LilypadLogger`.
- **`LilypadLogger`**, a full logger you *can* use in your application, with named channels and pluggable outputs.

#### libLog

[LilypadLibLogger.ts:17](../src/logger/LilypadLibLogger.ts#L17). Every module logs through it, always as `libLog(this.logger, 'error', this.name, 'message', error)`. The first argument after the level is the instance name, so logs from several caches can be told apart. The function looks up `logger[level]`, returns if it is missing, calls it with `method.call(logger, ...)` (so that `this` is right for class-based loggers like pino), and if the result looks like a promise, attaches an empty `.catch`. A logger can therefore be missing, partial, throwing or rejecting, and the module never notices.

#### LilypadLogger

[LilypadLogger.ts](../src/logger/LilypadLogger.ts), 261 lines.

**The shape.** You choose channel names (`'error' | 'warn' | 'info' | 'debug'` by default), and each becomes a method: `logger.info(...)`. TypeScript cannot add methods to a class from a type parameter, so the class is `LilypadLogger<T>` and the type you use is `LilypadLoggerType<T> = LilypadLogger<T> & ChannelMethods<T>` ([line 259](../src/logger/LilypadLogger.ts#L259)); `create()` returns the latter.

**Construction** ([line 120](../src/logger/LilypadLogger.ts#L120)):

1. Rejects channel names that would overwrite a property of the logger (line 125). `key in this` catches inherited names such as `constructor` or `toString`; the fields are listed by hand because, depending on the compilation target, class fields may not exist yet at that point of the constructor. `then` is reserved because an object with a `then` method is a "thenable": returning the logger from an `async` function would call it instead of resolving to the logger.
2. Copies the component arrays (so that `register()` does not mutate the caller's arrays).
3. For each channel, builds two closures and assigns the second one as a method of the instance (line 197):
   - `send(message, context)` (line 154) builds a `LilypadLogRecord` (formatted message, raw parts, timestamp, logger name, context), calls every component's `output()` with `Promise.allSettled`, so that one failing component neither stops the others nor hides their errors, and passes each failure to `reportComponentError`. The formatting itself is inside the `try`, because even formatting must never make the promise reject.
   - `logFn(...message)` (line 186) is the channel method. It reads `context()` **synchronously**, before any `await`, so that an `AsyncLocalStorage` store of the caller's request is still active. It adds the task to `_pending` (for `flush()`), hands it to `runInBackground` (for `platform.background`), and returns it.

`reportComponentError` ([line 243](../src/logger/LilypadLogger.ts#L243)) tries `errorLogging`, and falls back to `console.error` if there is none or if it fails too. This is the one place where the library writes to the console on its own, because there is nowhere else left to report.

`flush()` ([line 222](../src/logger/LilypadLogger.ts#L222)) loops `while (_pending.size > 0) await Promise.all(_pending)`: a loop rather than one `await`, because messages logged while waiting are added to the set.

#### Components

[LilypadLoggerComponent.ts](../src/logger/LilypadLoggerComponent.ts). A component has a public `output()`, which builds a record if it was called directly (not through a logger) and calls `sendRecord()`. The default `sendRecord()` formats the record as `<ISO time> - [name] [TYPE]: <message> <context JSON>` and calls the abstract `send(text, type)`. So a subclass chooses its level of abstraction:

- implement `send()` to receive text: `LilypadConsoleLogger` routes it to `console.error`/`warn`/`log` by channel name;
- override `sendRecord()` to receive the structured record: `LilypadJsonConsoleLogger` ([JsonConsoleLogger.ts:25](../src/logger/components/JsonConsoleLogger.ts#L25)) writes one JSON object per line, with the context fields at the top level and the `Error` parts under `errors`.

`safeJson` ([line 114](../src/logger/LilypadLoggerComponent.ts#L114)) is a `JSON.stringify` with a replacer that turns BigInts into `"10n"`, errors into `{ name, message, stack }` and repeated objects into `"[Circular]"`, and returns `"[Unserializable]"` if it still throws.

#### formatLogValue

[formatLogValue.ts](../src/logger/formatLogValue.ts). Node's `util.inspect` is not available in edge runtimes, so this is a small re-implementation. Top-level strings are printed as is; everything else goes through `formatNested`, which recurses with a `depth` (abbreviating beyond 4 levels to `[Object]`/`[Array]`) and a `seen` set for cycles. The `seen` set is emptied on the way back up (`finally { seen.delete(value) }`), so an object that appears twice *side by side* is printed twice, and only a real cycle prints `[Circular]`. Errors print their stack, then their own enumerable properties (this is how the `code` and `detail` of a Postgres error show up), then `[cause]:` recursively. Each property read is in its own `try`, because a getter can throw.

#### LilypadDiscordLogger

[DiscordLogger.ts](../src/logger/components/DiscordLogger.ts), 178 lines. Posting one HTTP request per log line would hit Discord's rate limit immediately, so the component is a small queue with batching:

- `send()` ([line 81](../src/logger/components/DiscordLogger.ts#L81)) returns a promise that is resolved or rejected **later**, when the batch containing the message is sent. It pushes `{ content, resolve, reject }` onto the queue, drops the oldest messages beyond `maxQueueSize` (resolving them, since rejecting 100 dropped messages would flood `errorLogging`), and kicks `flush()`.
- `flush()` ([line 97](../src/logger/components/DiscordLogger.ts#L97)) is guarded by a `flushing` flag, so only one loop runs. The loop waits until `nextRequestAt`, takes a batch and sends it, until the queue is empty.
- `takeBatch()` ([line 116](../src/logger/components/DiscordLogger.ts#L116)) first prepends a notice if messages were dropped, then takes as many messages as fit in Discord's 2000 characters (always at least one).
- `sendBatch()` ([line 134](../src/logger/components/DiscordLogger.ts#L134)) posts, sets `nextRequestAt = now + minRequestInterval`, cancels the unread response body (otherwise the connection stays busy until garbage collection), retries a `429` after `retry-after`, and finally resolves or rejects every message of the batch. A rejection flows back through the logger to `errorLogging`.
- `post()` sets `allowed_mentions: { parse: [] }` so that a logged `@everyone` pings no one, and a 5 s `AbortSignal.timeout`.

### 4.4 LilypadFlowControl

[src/flow/LilypadFlowControl.ts](../src/flow/LilypadFlowControl.ts), 289 lines. Four independent tools, composed by `executeFn`:

- **`executeWithTimeout(fn, timeout)`** ([line 133](../src/flow/LilypadFlowControl.ts#L133)): creates an `AbortController`, and races `fn(signal)` against a timer. When the timer fires, it aborts the controller **with** the `LilypadTimeoutError` and rejects. JavaScript cannot stop a running promise, so the signal is how `fn` learns it should stop, and how the cache learns that a late result must not be stored (it checks `signal.aborted`).
- **`executeWithRetries({ executionFn, retries, errorFn, backOffTime })`** ([line 168](../src/flow/LilypadFlowControl.ts#L168)): a `while (true)` loop that returns on success, and on failure either sleeps and retries (default backoff `2^attempt × 100` ms) or, after the last attempt, returns `errorFn(error)` or rethrows.
- **`rateLimit(consumer, fn)`** ([line 210](../src/flow/LilypadFlowControl.ts#L210)): remembers the last execution time per `consumer#function` pair and throws `LilypadRateLimitError` if the new one comes too soon. The map is pruned when it passes 1000 pairs. It is deliberately **synchronous**, see below.
- **Single-flight**: `singleFlightMap` from function identifier to the running promise.

`executeFn` ([line 259](../src/flow/LilypadFlowControl.ts#L259)) chains them in this order:

```ts
const inFlight = this.singleFlightMap.get(id);   // 1. join a running execution
if (inFlight) return inFlight;
this.rateLimit(consumer, id);                      // 2. rate limit (sync, may go to errorFn)
const executionPromise = this.executeWithRetries({ // 3. retries around timeouts
  executionFn: () => this.executeWithTimeout(fn, timeout), ...
}).finally(() => this.singleFlightMap.delete(id));
this.singleFlightMap.set(id, executionPromise);    // 4. register
```

Between step 1 and step 4 there is **no `await`**. That is the whole correctness argument of single-flight: two calls cannot both see "nothing in flight" and both start, because JavaScript runs this block without interruption. It is also why `rateLimit` must stay synchronous.

A consequence the cache relies on: callers who join an execution share **everything** from the first caller, including its timeout and the result of its `errorFn`. That is why the cache's `errorFn` only logs and rethrows, and the per-caller fallback is chosen afterwards, outside the flight (see [4.6](#failures-errorreturn-and-the-cooldown)).

### 4.5 LilypadSerializer

[src/serializer/LilypadSerializer.ts](../src/serializer/LilypadSerializer.ts), 129 lines. Unrelated to the rest of the library: it maps objects of shape `FROM` to a compact shape `TO` and back, leaving out values equal to their default.

The runtime is trivial: `serialize` ([line 88](../src/serializer/LilypadSerializer.ts#L88)) loops over the keys, skips values equal to the default (with `equality`, or `===`), calls the key's `serialize` function and writes the result under the `target` key; `deserialize` ([line 109](../src/serializer/LilypadSerializer.ts#L109)) does the reverse and fills `undefined` with a `structuredClone` of the default, so that deserialized items never share a default array.

The interesting part is the **types** (lines 1-44). The key mapping `KeyMap` must be a bijection: every `TO` key used once, no two `FROM` keys on the same `TO` key.

- `IsSurjective<B, M>`: `keyof B extends M[keyof M]`, every key of `TO` is some target.
- `IsInjective<M>`: for each key `K`, the inverse record `InvertRecord<M>[M[K]]` (the union of all keys that map to the same target) must be exactly `K`. The `[X] extends [K]` brackets prevent TypeScript from distributing over the union.
- If the mapping is not a bijection, `target` is typed `never`, so the options object does not compile.

The `@ts-expect-error` tests in `LilypadSerializer.test.ts` check these types; they run under `npm run typecheck`, not under vitest.

### 4.6 LilypadCache

[src/cache/LilypadCache.ts](../src/cache/LilypadCache.ts), about 1650 lines. This is the heart of the library. Read [3.4](#34-tickets-ordering-asynchronous-writes) and [3.5](#35-expirationtime-0-means-invalidated) first.

#### What the cache holds

The fields ([lines 348-406](../src/cache/LilypadCache.ts#L348)) fall into four groups:

| Group | Fields | Role |
| --- | --- | --- |
| Data | `store: Map<string, entry>`, `protectedKeys` | The entries, by normalized key; keys that `delete`/`clear`/eviction skip |
| Ordering | `lastTicket`, `ticketFloor`, `fences`, `bulkSyncInvalidationTicket` | See [3.4](#34-tickets-ordering-asynchronous-writes) |
| Resilience | `failures`, `refreshing`, `sharedNotBefore` | Cooldown after a failed fetch, background refreshes in progress, oldest acceptable L2 copy |
| Machinery | `flowControl`, `bulkSyncFlowControl`, `shared`, `platform`, `logger`, `disposed` | Single-flight + timeouts for fetches and for bulk syncs; the resolved shared-level options |

An entry ([`LilypadCacheEntry`, line 166](../src/cache/LilypadCache.ts#L166)) is:

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

The constructor ([line 408](../src/cache/LilypadCache.ts#L408)) validates options, resolves the shared level (throwing if there is no store or no `name`), creates the two flow controls (5 s timeout for fetches, 30 s for bulk syncs, no retries, no rate limit), and starts the cleanup interval if asked, calling `unref()` so that the timer does not keep Node.js alive.

#### The write path

Every write funnels into one private method, `writeEntry` ([line 539](../src/cache/LilypadCache.ts#L539)):

```
set(key, v, ttl) ──> setLocal ──(new ticket)──┐
setIfNewer(... ticket) ──(ticket check)───────┤
adoptShared(... ticket) ──(ticket check)──────┼──> writeEntry(entry, newValue)
expireNormalized ──(new ticket, exp=0)────────┘         │
                                                        ├─ ignore if disposed
                                                        ├─ with maxEntries: delete + set (move to the end = most recent)
                                                        ├─ fences.delete(key)   (the entry's ticket now orders reads)
                                                        ├─ if newValue: onValueStored(entry)   (subclass hook)
                                                        │               invalidate bulk sync if the entry expires before it
                                                        └─ evictOverflow()
```

Three details:

- **The disposed check.** A fetch that was in flight when `dispose()` was called will still complete and try to store its value. The `disposed` flag makes `writeEntry` a no-op, so a disposed cache stays empty.
- **LRU with a `Map`.** A JavaScript `Map` iterates in insertion order. Deleting and re-inserting a key moves it to the end, so the start of the map holds the least recently used entries. `touch()` does the same on reads. `evictOverflow()` ([line 572](../src/cache/LilypadCache.ts#L572)) deletes from the start until the size fits, skipping protected keys. Because of this re-insertion, any loop that writes while iterating must iterate a **copy** (`[...this.store]`), or it could revisit the same keys forever.
- **Bulk sync consistency.** `bulkGet({})` returns "everything in the cache" and trusts it to be the whole source while the bulk sync is fresh. So anything that makes an entry disappear or expire early while the sync is fresh must invalidate the sync: an entry written with a shorter TTL (here), an eviction, `clear()`.

`set` ([line 626](../src/cache/LilypadCache.ts#L626)) = `setLocal` (new ticket, origin `source`) + `writeShared` (L2 in the background). `setLocal` alone is used for fallbacks, which must not be shared with other instances.

#### The read path: getOrSetDetailed

`getOrSet` is a thin wrapper over `getOrSetDetailed` ([line 859](../src/cache/LilypadCache.ts#L859)), which returns `{ value, status, refreshFailed }`. Its lookup order:

```
getOrSetDetailed(key, valueFn, options)
│
├─ assertNotDisposed, cleanupOnAccess
│
├─ unless skipCache:
│   ├─ L1: fresh local entry? ─────────────────────────────> freshHit(... 'L1-HIT')
│   ├─ L2 (if shared):
│   │    read = beginRead()            ← ticket taken BEFORE the L2 read
│   │    readShared(): entry + failedAt + lock, in parallel
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

Why is the ticket for L2 taken *before* reading L2? If a local `set` happens while the L2 read is in flight, the local value is newer than whatever L2 returns. `adoptShared` will see `read.ticket <= currentTicket` and refuse the copy.

Why is the entry re-read after L2 (`const current = this.store.get(...)`, line 887)? The `await` gave other code the chance to write it.

#### Fetching: fetchAndStore

[Line 938](../src/cache/LilypadCache.ts#L938). It wraps the caller's `valueFn` in `flowControl.executeFn`, keyed by `LilypadCache-getOrSet-<key>`:

```ts
fn: async (signal) => {
  const read = this.beginRead();          // ticket at the real start of the fetch
  const value = await valueFn(signal);
  if (!signal.aborted) {                  // timed out: the caller already got an error
    read.storeFetched(key, value, options.ttl);
  }
  return value;
},
errorFn: (error) => { libLog(...); this.recordFailure(key); throw error; },
```

`storeFetched` ([line 667](../src/cache/LilypadCache.ts#L667)) does three things: clears the key's failure (and its L2 failure marker), stores the value with `setIfNewer`, and, only if it was stored, writes it to L2. Note that the fetch's result is returned to every caller even if it was not stored: the callers asked for the value *now*, and the value is correct for the moment it was read.

#### Failures: errorReturn and the cooldown

When the fetch fails, the shared promise rejects for every caller who joined it. Each caller then runs `errorReturn` ([line 756](../src/cache/LilypadCache.ts#L756)) **with its own options**:

1. `options.errorFn({ key, error, options })`: if it returns something other than `undefined`, that is the fallback.
2. Otherwise, with `returnOldOnError`, the **current** entry's value, even expired (re-read now, because the entry may have changed during the fetch).
3. Otherwise, rethrow.

A fallback is stored with `setLocal(..., errorTtl, 'fallback')`: in this instance only, for a short TTL, and tagged so that `freshHit` reports it with `refreshFailed: true`.

The **failure cooldown** keeps a source that is down from being hammered by every request. `recordFailure` ([line 807](../src/cache/LilypadCache.ts#L807)) stores the failure time in `failures`, and in L2 under `<key>:failedAt` so other instances see it. `inCooldown` ([line 798](../src/cache/LilypadCache.ts#L798)) is true for `failureCooldown` ms after it. During the cooldown `getOrSetDetailed` skips the fetch and goes straight to `errorReturn` with a `LilypadCacheCooldownError`, unless a fetch is already in flight (joining it costs nothing). Once the cooldown ends, `freshHit` refreshes a cached fallback in the background ([line 931](../src/cache/LilypadCache.ts#L931)), otherwise the fallback would hide the source's recovery until it expired.

#### Stale-while-revalidate

When an entry has expired but less than `staleWhileRevalidate` ago, `getOrSetDetailed` returns it immediately with status `STALE`, and calls `refreshInBackground` ([line 976](../src/cache/LilypadCache.ts#L976)). The refresh is skipped when:

- another instance holds the L2 refresh lock (`remote.locked`);
- this instance scheduled a refresh of the key less than 60 s ago (`refreshing` map; after 60 s it is assumed the platform dropped it);
- a fetch of the key is already in flight;
- the key is in its failure cooldown.

Otherwise it records the key in `refreshing` and hands the work to `runAfterResponse`: take the L2 lock (if configured), run `fetchAndStore`, then clean up in `finally`. The lock is a random owner id stored under `<key>:lock` with a TTL. It is released only if it still holds *our* owner id, because it may have expired and been taken by another instance meanwhile. It is a soft lock: read and write are separate operations, so two instances can occasionally both refresh, which is harmless.

#### The shared level (L2)

Everything about L2 is in [lines 1014-1252](../src/cache/LilypadCache.ts#L1014).

- **Keys**: `lilypad:<name>:<normalizedKey>`, with suffixes `:failedAt` and `:lock`.
- **Values**: an envelope `{ lilypad: 1, value, fetchedAt, expiresAt }`. `fetchedAt` travels with the value, so that the *age* of a value is measured from when some instance fetched it, not from when it reached this instance. Without that, a value could bounce between instances and never expire.
- **Codec**: the store usually holds JSON, so an optional codec encodes values on the way in and decodes (and validates) them on the way out. `decodeEnvelope` ([line 1094](../src/cache/LilypadCache.ts#L1094)) rejects malformed envelopes and values the codec refuses, with a warning. `null` bypasses the codec.
- **Reading**: `readShared` ([line 1061](../src/cache/LilypadCache.ts#L1061)) reads the value, the failure marker and the lock in parallel, each bounded by `sharedOperation` (timeout, fallback `null`).
- **Adopting**: `adoptShared` ([line 1141](../src/cache/LilypadCache.ts#L1141)) copies a remote entry into L1 only if all of these hold:
  1. it is newer than the local entry (`fetchedAt`);
  2. it was produced after the local entry was invalidated (`invalidatedAt`): an L2 delete may have failed, or another instance may have written an old copy back;
  3. it was produced after `sharedNotBefore` (raised by a `TRUNCATE`, see [4.10](#applying-a-change));
  4. no local write started after the L2 read began (ticket check).
- **Writing**: `writeShared` ([line 1177](../src/cache/LilypadCache.ts#L1177)) computes the L2 lifetime as `expirationTime + staleWhileRevalidate - now` (so other instances can serve it stale too), skips expired entries, and writes in the background. With `checkBeforeWrite`, it first reads the L2 entry and leaves it alone if it was fetched later.

What writes L2 and what does not is a deliberate choice: `set`, `bulkSet` and successful fetches write it; `delete` and `invalidate` remove from it; fallbacks, bulk syncs, `clear` and `dispose` stay local. A fallback is an instance's local emergency answer, not a fact to share. A bulk sync would copy a whole table into the shared store.

#### Invalidation and expiry

Four levels, each built on the previous one:

| Method | Does | Used by |
| --- | --- | --- |
| `expireNormalized(key)` ([1511](../src/cache/LilypadCache.ts#L1511)) | Entry: `expirationTime = 0`, new ticket, `invalidatedAt`. No entry but a read in flight: a fence. | everything below |
| `expire(key)` ([1507](../src/cache/LilypadCache.ts#L1507)) | The above, with a key | subclasses |
| `markInvalid(key)` ([1489](../src/cache/LilypadCache.ts#L1489)) | `expire` + remove from L2 + (optionally) invalidate the bulk sync | `invalidate`; `LilypadDbCache` for changelog changes |
| `invalidate(key)` ([1480](../src/cache/LilypadCache.ts#L1480)) | `markInvalid` + a `manual` event to `platform.onInvalidate` | the public API |

`expireEverything()` ([line 1531](../src/cache/LilypadCache.ts#L1531)) expires every entry, raises `ticketFloor` (discarding every read in flight, including of keys without an entry, so the fences are no longer needed and are cleared), and invalidates the bulk sync. `LilypadDbCache` calls it when it may have missed changes.

`emitInvalidation` ([line 1262](../src/cache/LilypadCache.ts#L1262)) builds `{ source, cache, keys, tags }` with tags `<prefix>:<name>` and `<prefix>:<name>:<key>`, and calls `onInvalidate` inside `runInBackground`. The `Promise.resolve().then(...)` wrapper turns a synchronous throw of `onInvalidate` into a rejection that the handler catches.

`delete` removes the entry (and the L2 copy); protected keys need `{ force: true }`. `clear` deletes everything local. `purgeExpired` ([line 1595](../src/cache/LilypadCache.ts#L1595)) removes entries expired for longer than the stale window, and also cleans the bookkeeping maps (`failures`, `refreshing`, `fences`), which would otherwise grow forever. It runs from the timer (`autoCleanupInterval`) or from `cleanupOnAccess` (at most once per `cleanupOnAccessEvery`, on reads and writes; no timer, which suits serverless instances that are suspended between requests).

#### Bulk sync

`bulkSync()` ([line 1296](../src/cache/LilypadCache.ts#L1296)) loads everything from `bulkSyncFn` and replaces the content of the cache. It runs in its own flow control (single-flight on `LilypadCache-bulkSync`, 30 s timeout) and resolves to a boolean instead of throwing, unless `throwOnError`.

`_bulkSync` ([line 1314](../src/cache/LilypadCache.ts#L1314)), step by step:

1. Still fresh (`now < bulkSyncExpirationTime`)? Return `true` without loading.
2. `beginRead()`, then `await bulkSyncFn(signal)`. Timed out (`signal.aborted`)? Store nothing.
3. Build `incoming`, keyed by normalized key.
4. For each **local** entry (on a copy of the store): keep it if it was written after the sync started (`entry.ticket > read.ticket`, newer than the sync's data) or if it is about to be overwritten; otherwise delete it, and if it is protected, expire it instead.
5. `read.store(key, value)` for each incoming entry: `setIfNewer`, so entries written during the sync still win.
6. Raise `ticketFloor` to the sync's ticket: a read of a missing key that started before the sync is older than the sync's knowledge that the key does not exist.
7. Mark the sync fresh, **unless** an invalidation happened while it was running (`bulkSyncInvalidationTicket >= read.ticket`): its data may predate that invalidation. Freshness never lasts longer than `ttl`, since the entries it loaded expire then.

`invalidateBulkSync()` ([line 1370](../src/cache/LilypadCache.ts#L1370)) resets the expiration **and** records a ticket. Setting `bulkSyncExpirationTime = 0` alone would not be enough: a sync already running would set it again at step 7.

#### dispose

[Line 1653](../src/cache/LilypadCache.ts#L1653): drop the logger, stop the timer, clear everything (including protected keys), set `disposed`. It returns a promise even though the base class has nothing to wait for, because `LilypadDbCache` must await its `UNLISTEN`, and the API is the same for both.

### 4.7 LilypadDbGate

[src/dbGate/LilypadDbGate.ts](../src/dbGate/LilypadDbGate.ts), 652 lines. A thin layer over [postgres.js](https://github.com/porsager/postgres): a client, typed CRUD helpers, and `LISTEN` management.

#### Two connections

The constructor ([line 180](../src/dbGate/LilypadDbGate.ts#L180)) creates the main client:

```ts
this.sql = postgres(options.connectionString, {
  prepare: false,                           // works behind PgBouncer in transaction mode
  ...toPostgresPoolOptions(options.pool),   // ms → seconds, undefined keys removed
  ...(statementTimeout !== undefined && { connection: { statement_timeout } }),
});
```

postgres.js connects lazily, on the first query, so creating a gate opens nothing. That is what keeps `next build` from reaching the database. `prepare: false` must stay: transaction-mode poolers route each statement to any backend, where a prepared statement may not exist.

The **listener connection** ([`getListenerConnection`, line 486](../src/dbGate/LilypadDbGate.ts#L486)) is a separate postgres.js client with one connection, no idle timeout and no maximum lifetime, created on the first `LISTEN`. `LISTEN` belongs to a session, so it cannot go through a pooler that reassigns sessions, and it must not be closed for being idle. It can use a different URL (`listenerConnectionString`), typically a direct connection.

`create()` ([line 199](../src/dbGate/LilypadDbGate.ts#L199)) goes through the singleton helper with a SHA-256 signature of the connection options; `initializeNew` registers the `listen` subscriptions and, if one fails, closes the gate before rethrowing, so that a gate that is never returned does not leak its pools.

#### CRUD helpers

All generic over `LilypadDbSchema<T, PK>` ([line 84](../src/dbGate/LilypadDbGate.ts#L84)): table name, primary key, the `cols` record (one entry per property of `T`), optional sanitization functions.

- **Reading rows.** `selectedColumns` ([line 268](../src/dbGate/LilypadDbGate.ts#L268)) selects only the schema columns, or `*` if there is a `selectSanitizationFn` (which may read other columns). `mapRow` ([line 250](../src/dbGate/LilypadDbGate.ts#L250)) builds `T` with the sanitization function, or by copying the `cols` keys; a sanitizer can return `null` to drop a row.
- `selectAllFromTable` ([line 312](../src/dbGate/LilypadDbGate.ts#L312)) reads through a **cursor** in batches of 1000 rows, so the raw result of a large table is never in memory at once.
- `selectFromTableByPrimaryKeys` ([line 336](../src/dbGate/LilypadDbGate.ts#L336)) uses `IN (...)`, one query per 1000 keys, since Postgres limits the number of parameters per query.
- **Writing rows.** `prepareWrite` ([line 280](../src/dbGate/LilypadDbGate.ts#L280)) is the security-relevant function: it applies `writeSanitizationFn` (whose result *replaces* the data), checks the primary key, removes it when the database generates it, and keeps **only the columns declared in `cols`** that are not `undefined`. An application can pass a request body directly; an extra `is_admin: true` is simply never written (no mass assignment).
- **Transaction ids.** Inserts, updates and deletes add `txid_current()::text AS __lilypad_xid` to their `RETURNING` clause. `writeResult` ([line 398](../src/dbGate/LilypadDbGate.ts#L398)) strips that column before mapping the row and returns `{ row, xid }`. This is the id the changelog trigger records for the same change, and it is how `LilypadDbCache` recognises its own writes when they come back ([4.10](#own-writes)).

#### LISTEN management

State: `listeners: Map<channel, { callbacks: Map<callbackId, ...>, ready, listening }>` ([line 142](../src/dbGate/LilypadDbGate.ts#L142)).

- `addListener` ([line 604](../src/dbGate/LilypadDbGate.ts#L604)) gets or creates the channel entry, sets the callback under its id (re-adding an id replaces the callback), and awaits `ready`.
- `initializeListener` ([line 507](../src/dbGate/LilypadDbGate.ts#L507)) registers the channel entry **before** `LISTEN` completes, so concurrent `addListener` calls for the same channel share one `ready` promise. If `LISTEN` fails, the entry is removed and the error rethrown, so the next call retries.
- The third argument of postgres.js `listen()` is `onlisten`, which postgres.js calls after the first `LISTEN` **and after every reconnection**. The `listening` flag tells them apart: the first call only sets it; later calls run each callback's `onReconnect`. The cache uses that hook to expire everything, since notifications sent while the connection was down are lost for good.
- Each notification runs every callback of the channel through `runCallbackSafely`.
- `removeListener` ([line 629](../src/dbGate/LilypadDbGate.ts#L629)) deletes the callback synchronously, and only when the channel has none left, awaits `ready` and `UNLISTEN`s.
- `close()` clears the listeners, leaves the registry, and ends both clients.

### 4.8 The changelog

[src/dbGate/LilypadChangelog.ts](../src/dbGate/LilypadChangelog.ts) (SQL and the read) and [LilypadChangelogReader.ts](../src/dbGate/LilypadChangelogReader.ts) (batching).

#### Why a changelog

`LISTEN/NOTIFY` is near real-time, but it needs a long-lived direct connection, and a notification sent while no one is listening is lost. On a serverless platform, instances are suspended most of the time. The changelog solves this by **recording** every change in a table; each instance reads what it missed, whenever it wakes up.

#### The SQL

`lilypadChangelogSql()` ([line 59](../src/dbGate/LilypadChangelog.ts#L59)) returns the DDL. The table:

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

The trigger function (line 93) receives the primary key column name as its argument (`TG_ARGV[0]`), and reads it generically with `to_jsonb(NEW) ->> TG_ARGV[0]`, so one function serves every table. An `UPDATE` that changes the primary key is recorded as a `DELETE` of the old key plus an `UPDATE` of the new one. A statement-level trigger records `TRUNCATE`, which fires no row trigger. Unless `notifyChannel: false`, each change is also sent with `pg_notify('cache_events', json)`, so one trigger serves both strategies. The function's comment carries the version (`lilypad-changelog:3`), which the schema check reads to detect outdated installs. Everything is idempotent (`IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP TRIGGER IF EXISTS`), so a migration can run it again.

`lilypadChangelogTriggerSql()` ([line 135](../src/dbGate/LilypadChangelog.ts#L135)) attaches the two triggers to one table.

#### The cursor: why `pg_snapshot_xmin`

This is the clever part. The obvious cursor, "the last `id` (or `xid`) I have read", **misses changes**, because transactions do not commit in the order they started:

```
T1 (xid 100) BEGIN ... writes a changelog row ............................ COMMIT
T2 (xid 101)      BEGIN ... writes a changelog row ... COMMIT
Cache read r1:                                               ↑ sees only xid 101 (T1 not committed)
                                                              "last seen" = 101
Cache read r2 (after T1 commits): WHERE xid > 101  → T1's change is never returned ✗
```

The library's cursor is instead `pg_snapshot_xmin(pg_current_snapshot())`: **the oldest transaction still running** at the time of the read. At r1 that is 100 (T1 is still running). The next read asks for `xid >= 100` and gets T1's change once it commits. The price is that a change can come back in several reads (T2's 101 is returned by r2 as well), so the reader remembers the ids it has already applied (`appliedChanges` in the cache) and forgets them once the cursor has passed their xid.

#### The batched read

`readLilypadChangesBatch` ([line 202](../src/dbGate/LilypadChangelog.ts#L202)) reads several tables in **one statement**. One statement matters: behind a transaction-mode pooler, two separate statements could run on different backends, and the snapshot would not match the rows. The query ([line 219](../src/dbGate/LilypadChangelog.ts#L219)) is explained clause by clause in [5.5](#55-the-changelog-query-clause-by-clause).

Each request is either `{ cursor }` (trusted: continue from where I stopped) or `{ lookback }` (untrusted: give me everything from the last N ms). `readLilypadChanges` is the one-table wrapper; `pruneLilypadChangelog` deletes rows older than a retention.

#### The reader: one query for all the caches of a gate

An application may cache ten tables. Ten caches each polling the changelog would be ten queries per interval. `LilypadChangelogReader` ([LilypadChangelogReader.ts:30](../src/dbGate/LilypadChangelogReader.ts#L30)) is shared by every cache of a gate that uses the same changelog table (a `WeakMap<gate, Map<table, reader>>`, [line 100](../src/dbGate/LilypadChangelogReader.ts#L100)); the `WeakMap` lets the reader be garbage collected with the gate.

Each cache **subscribes** with two functions: `request(readAt)` (what to read for me: my cursor or a lookback) and `apply(result, request)` (apply what was read). When any cache needs a read, `read(subscriber)` ([line 55](../src/dbGate/LilypadChangelogReader.ts#L55)):

- no read running: start one that includes **every** current subscriber;
- a read running that includes this subscriber: share it;
- a read running that does not include it (it subscribed later): queue one read after it (shared by every late caller).

`readAll` ([line 82](../src/dbGate/LilypadChangelogReader.ts#L82)) asks each subscriber for its request, runs the batched query, and calls every `apply` with `Promise.allSettled`, so one cache's failure does not affect the others.

### 4.9 The schema check

[src/dbGate/LilypadSchemaCheck.ts](../src/dbGate/LilypadSchemaCheck.ts), 309 lines. Without the triggers, a `listen` cache would silently stay stale, and a `changelog` cache would fail every read. `checkLilypadSchema` ([line 142](../src/dbGate/LilypadSchemaCheck.ts#L142)) reads only the catalogs:

1. One query ([line 160](../src/dbGate/LilypadSchemaCheck.ts#L160)): server version, whether the changelog table exists (`to_regclass`), whether it has the `table_schema` column, whether the trigger function exists (`to_regprocedure`), and the function's comment (the version).
2. Per table ([line 212](../src/dbGate/LilypadSchemaCheck.ts#L212)): the table's schema, and all its non-internal triggers as JSON: whether it calls the changelog function, its arguments, its `tgtype` bitmask, whether it is enabled, and the **source** of its function.
3. Checks on `tgtype` (bits `ROW=1, INSERT=4, DELETE=8, UPDATE=16, TRUNCATE=32`): a working changelog trigger must be row-level on all three operations; its first argument must be the primary key; a statement-level `TRUNCATE` trigger must exist. For `listen`, a regular expression looks for `pg_notify('cache_events'` in the function source, so a hand-written trigger counts too. The event bits of every enabled row trigger that notifies are OR-ed together, and must cover `INSERT`, `UPDATE` and `DELETE`: one trigger per operation is fine, but a trigger on `UPDATE` alone is reported, since the cache would never hear about inserts and deletes.

Every problem comes with the SQL that fixes it, generated by the same functions as the install SQL (except `missing-table` and `unsupported-version`, which the library cannot fix). Besides diagnostics, the check has a second job: it resolves **which schema** the table lives in, which the cache uses to ignore notifications about a same-named table in another schema.

The cache runs the check at most once successfully per instance (`verifySchema`, [LilypadDbCache.ts:394](../src/cache/LilypadDbCache.ts#L394)). The check promise is cached, so concurrent callers share it. Two outcomes are distinguished:

- the check **ran** (whether or not it found problems): its promise stays cached and it is never repeated. The problems were already reported, and repeating the warning at every read would flood the logs;
- the check **could not run** (an error, e.g. the database was unreachable): `runSchemaCheck` returns `false`, the cached promise is forgotten, and a backoff starts (1 s, doubling up to 60 s). A later read calls `checkSchemaInBackground`, which runs it again once the backoff is over. Reads never wait for it. With `listen`, the first check runs before `LISTEN`; the reads only retry a check that failed.

The reset happens in a `.then` on the promise, not inside `runSchemaCheck` itself: if the check failed synchronously, a reset inside it would run *before* `verifySchema` stored the promise, and the failed check would stay cached.

### 4.10 LilypadDbCache

[src/cache/LilypadDbCache.ts](../src/cache/LilypadDbCache.ts), about 1350 lines. A `LilypadCache` bound to one table. What it adds:

1. **Fetching**: `getOrFetch(key)` = `getOrSet(key, () => gate.selectFromTableByPrimaryKey(...))`.
2. **Writing through**: `sqlCreate`/`sqlUpdate`/`sqlDelete` write to the database, then cache the row the database returned.
3. **Syncing**: learning about changes made elsewhere (`sync`: `listen`, `changelog` or `none`).
4. **Trust and renewal**: while the sync is known to see every change, entries don't need a query at their TTL.
5. **The table as a whole**: `getAll()` returns every row, with as few queries as possible, by tracking which keys exist (`members`).

#### Construction

`create()` ([line 284](../src/cache/LilypadDbCache.ts#L284)) → `initializeNew` ([line 311](../src/cache/LilypadDbCache.ts#L311)): build, run the schema check if `verify: 'throw'`, start `LISTEN` if the strategy is `listen` and not lazy; on any failure, dispose and rethrow.

The constructor ([line 331](../src/cache/LilypadDbCache.ts#L331)):

- calls `super` with `name` defaulting to the table name;
- installs its own `bulkSyncFn`, which loads the whole table with `selectAllFromTable`, and also updates `members` and hands the rows to anyone waiting in `tableLoadWaiters` (see [getAll](#members-and-getall));
- takes the schema from a qualified `tableName` (`app.accounts` → `app`);
- for `listen`: prepares the default listener (not registered yet);
- for `changelog`: gets the gate's shared reader and subscribes to it.

#### Syncing before a read

The async reads (`getOrSetDetailed`, [line 991](../src/cache/LilypadDbCache.ts#L991), and `getAll`) start with:

```ts
const syncing = this.syncBeforeRead();
if (syncing) await syncing;
this.renew(this.normalizeKey(key));
return super.getOrSetDetailed(key, valueFn, options);
```

`syncBeforeRead` ([line 556](../src/cache/LilypadDbCache.ts#L556)) returns `undefined` when there is nothing to wait for, and the caller only awaits a real promise. That detail matters: even `await undefined` yields to the microtask queue. Without it, the read runs synchronously down to `flowControl.executeFn`, exactly as in the base class. So by the time `getOrFetch` returns its promise, the fetch is already registered as in flight, and a change applied immediately afterwards sees it (`hasReadInFlight`) and fences it. When something is due:

- `listen` + `connect: 'lazy'`: start `LISTEN` on the first read (unless it is already started or in backoff);
- `listen`, once `LISTEN` is started: only retry a schema check that could not run ([4.9](#49-the-schema-check));
- `changelog`: if `pollInterval` has passed (and no backoff), start the schema check in the background if it has not run yet (diagnostics only, reads do not wait for it), then `readChangelog()`. With `poll: 'background'`, the read is not awaited.

Failures are logged and turned into a backoff (`retryDelay`, [line 171](../src/cache/LilypadDbCache.ts#L171): from the base, doubling, up to 60 s), so that a database outage does not add a failing query to every request.

`get()` (synchronous) cannot sync; it only renews.

#### Trust and renewal

The idea: if the cache is **certain** it would have heard about every change of the table, then a row that reaches its TTL without a change is still correct, and there is no reason to query it again.

`syncTrustedSince()` ([line 501](../src/cache/LilypadDbCache.ts#L501)) answers "since when do I see every change?":

- `listen`: the time `LISTEN` became active and started applying changes; reset to the reconnection time by `onReconnect` (after expiring everything).
- `changelog`: the time of the first read in the current unbroken chain of reads; `undefined` if there is no cursor or the last read is older than `maxGap`.
- `none`: never.

`renew(key)` ([line 524](../src/cache/LilypadDbCache.ts#L524)) extends an expired entry's `expirationTime` (directly in the store, without a ticket: the value does not change) when all of these hold:

- `origin === 'source'`: it was read from the database or written by this instance, not a fallback and not an L2 copy;
- `expirationTime !== 0`: no change invalidated it;
- `fetchedAt >= trustedSince`: it was read while the sync was already watching, so any later change would have expired it;
- it is younger than `maxAge` (1 h by default). `maxAge` bounds the damage of changes the triggers cannot see (triggers disabled, `session_replication_role = replica` during a restore).

The new expiration is `min(now + ttl, fetchedAt + maxAge)`. L2 lifetimes are never extended: other instances may not be in sync.

#### Applying a change

Changes arrive through two paths, which converge on `applyChange` ([line 693](../src/cache/LilypadDbCache.ts#L693)) and `applyTruncate` ([line 730](../src/cache/LilypadDbCache.ts#L730)):

```
changelog read ──> applyChangelog(result, trusted) ──┐ mode 'lazy'
LISTEN payload ──> default listener callback ────────┤ mode 'eager'
                                                     ▼
                         applyChange(op, id, mode, xid) / applyTruncate()
```

`applyChange`:

1. `resolveNotifiedKey(id)`: the key of the existing entry or member (so `'7'` becomes `7` if that is how it is cached), else a number if the schema says the primary key is a `number` and the conversion is exact, else the text.
2. `isOwnWrite(key, xid)`: skip changes this instance made itself (next section).
3. `DELETE`: `set(key, null)`, even for keys not cached (the `null` entry blocks a fetch in flight from storing the deleted row, see [3.4](#34-tickets-ordering-asynchronous-writes)), and even for protected keys.
4. `INSERT`/`UPDATE`: note the key as a member of the table. Then:
   - key **not held** (no entry, no read in flight): no query at all. Nobody asked for this row here. Remove it from L2 (other instances may have cached an old copy) and invalidate the base bulk sync.
   - held, `eager` (notifications): `refreshKey` re-fetches it now (and expires it if the query fails).
   - held, `lazy` (changelog): `markInvalid`, no query; the next read fetches it. The new ticket also discards a read in flight.

Why lazy for the changelog? A changelog read can return hundreds of changes at once (on a lookback, for instance); re-fetching them all eagerly would turn a poll into hundreds of queries, most of them for rows no one will ask for again.

`applyTruncate` expires everything, removes every cached key from L2, calls `rejectSharedBefore(now)` (L2 copies older than the truncate are refused from now on, even for keys this instance did not hold), empties `members` and raises `membersFloor` (a table load that started before the truncate must not bring back the old rows).

`applyChangelog` ([line 624](../src/cache/LilypadDbCache.ts#L624)) wraps it for a changelog read:

- **untrusted read** (a lookback, because there was no cursor or the gap exceeded `maxGap`): the local memory may have missed anything, so `expireEverything()` and forget `appliedChanges`; then apply the lookback's changes anyway, because they remove L2 copies that other instances may still serve. `changelogTrustedSince = readAt`.
- skip change ids already applied; record the others with their xid;
- after applying, drop from `appliedChanges` and from `ownWrites` every xid below the new cursor: such changes can no longer be returned;
- store the cursor, reset the backoff, emit a `changelog` event.

The **notification** path is the default listener ([`getDefaultDbListener`, line 1191](../src/cache/LilypadDbCache.ts#L1191)): its `callbackId` includes the instance id (two caches of the same table on one gate must not replace each other); it parses and validates the JSON, checks the table and schema, applies eagerly, emits a `notification` event, then calls the user's `onNotification`. With `applyChanges: false` it only calls `onNotification`, and the sync is not trusted.

#### Own writes

When this instance runs `sqlUpdate`, it caches the row the database returned. Seconds later, its own change comes back through the changelog or a notification. Applying it would expire the fresh row and cost a query, for nothing.

- `storeWritten` ([line 1321](../src/cache/LilypadDbCache.ts#L1321)) records `(key, xid, ticket of the stored entry)` in `ownWrites` (`recordOwnWrite`, [line 759](../src/cache/LilypadDbCache.ts#L759)).
- `isOwnWrite(key, xid)` ([line 747](../src/cache/LilypadDbCache.ts#L747)) removes the xid from the set and returns `true` only if the entry **still has the ticket** of that write. If anything replaced the entry since (another change, a fetch), the change is applied normally.

`ownWrites` is bounded two ways: by the changelog cursor (see above), and, for `listen` where there is no cursor, by a 10-minute retention. The map is kept in the order of the last write (delete + set), so pruning stops at the first recent entry.

#### Writing through

`sqlCreate`, `sqlUpdate`, `sqlDelete` ([lines 1347-1388](../src/cache/LilypadDbCache.ts#L1347)) share one pattern:

```ts
const startTicket = this.nextTicket();                    // before the write
const { row, xid } = await gate.updateToTableDetailed(...);
this.storeWritten(key, row, startTicket, xid);
this.emitInvalidation('write', [key]);
```

`storeWritten`: if the entry's ticket is now greater than `startTicket`, something touched the key *while the write was running* (a change applied, a fetch that may have read the row before the write). The library cannot tell which of the two happened last in the database, so it does not guess: it expires the key, and the next read fetches the truth. Otherwise, `set(key, row)` (new ticket, L2 write) and record the own write.

#### refresh

`refresh(key)` ([line 1045](../src/cache/LilypadDbCache.ts#L1045)) re-fetches one row, with the running + queued coalescing described in [3.7](#37-single-flight-everywhere): a caller that arrives while a query runs gets the *next* query, which is guaranteed to start after the call. `fetchRow` uses `beginRead` and `storeFetched`, like `getOrSet`, and `flowControlTimeout`.

#### Members and getAll

`getAll()` must return every row of the table. Loading the whole table each time is correct but expensive; returning `bulkGet({})` is cheap but wrong (the cache may hold only some rows). The solution is to track **which keys exist** separately from their values:

- `members: Map<normalizedKey, { key, ticket }>` ([line 236](../src/cache/LilypadDbCache.ts#L236)), set by each table load (`replaceMembers`) and kept up to date afterwards by `onValueStored` (a row → member, `null` → removed; fallbacks ignored; an older ticket never overrides a newer one), `addMember` (INSERT/UPDATE of an uncached key) and `applyTruncate`. Evicting an entry does **not** remove its member: the row still exists.
- `isTableLoaded()` ([line 832](../src/cache/LilypadDbCache.ts#L832)): the members are reliable if the last load happened after the sync became trusted, or, without a trusted sync, less than `defaultBulkSyncTtl` ago.

`getAll()` ([line 1131](../src/cache/LilypadDbCache.ts#L1131)):

```
syncBeforeRead
members not reliable?  ──> loadTable()            (one full query)
stale = members whose entry is missing or expired (after renew)
stale > 25% of members? ──> loadTable() again     (one full query beats many key lookups)
fetchRows(stale)                                  (one IN query per 1000 keys)
return rowsOf(members, fetched, loaded)
```

Two subtleties:

- **With `maxEntries`**, a load may store more rows than the cache can hold; the evicted ones would then count as stale and be fetched again immediately. So `loadTable` does not rely on the store: it registers a waiter in `tableLoadWaiters`, and the `bulkSyncFn` hands it the loaded rows directly ([line 341](../src/cache/LilypadDbCache.ts#L341)). `staleKeys` treats a key missing from the store but present in `loaded` as fresh, and `rowsOf` ([line 960](../src/cache/LilypadDbCache.ts#L960)) takes each value from, in order: the fresh entry, the rows just fetched, the rows just loaded, the expired entry.
- **`loadTable` forces a load** even if the base class's bulk sync still counts as fresh (it invalidates it first): `getAll` decides freshness with `isTableLoaded`, not with the base class's timer.

`fetchRows` ([line 889](../src/cache/LilypadDbCache.ts#L889)) is single-flight **per key**: keys already being fetched join those queries, the rest go into one new query (`queryRows`, [line 926](../src/cache/LilypadDbCache.ts#L926)), which stores each row with `read.store` (this instance only, not L2, like the table loads) and caches `null` for keys without a row.

`getAll(keys)` skips the members: it fetches only the given keys that are stale.

#### dispose

[Line 1283](../src/cache/LilypadDbCache.ts#L1283): leave the registry, unsubscribe from the changelog reader, remove the listener callback (synchronously; only the `UNLISTEN` is awaited), dispose the base class, clear the database bookkeeping, then await the `UNLISTEN`.

---

## 5. Line by line: five traces

Each trace follows one scenario through the code. Line numbers are links; keep the source open next to this document.

### 5.1 Three concurrent `getOrFetch(42)` on a cold instance

Setup: a `LilypadDbCache` of `users` with `sync: { strategy: 'changelog', pollInterval: 5000 }`, no shared level, just created. Three requests call `users.getOrFetch(42)` in the same tick. Call them A, B and C.

**A:**

1. `getOrFetch` → `getOrFetchDetailed` ([DbCache 1025](../src/cache/LilypadDbCache.ts#L1025)) → `this.getOrSetDetailed(42, () => gate.selectFromTableByPrimaryKey(schema, 42), {})`. This resolves to the **override** in `LilypadDbCache` ([991](../src/cache/LilypadDbCache.ts#L991)).
2. `assertNotDisposed()`, then `syncBeforeRead()` ([556](../src/cache/LilypadDbCache.ts#L556)). `lastChangelogRead` is `0`, so a poll is due (line 574). `schemaCheck` is unset, so the check starts in the background (`checkSchemaInBackground`, line 577). `readChangelog()` → `reader.read(subscriber)` ([Reader 55](../src/dbGate/LilypadChangelogReader.ts#L55)): nothing is running, so `start()` includes every subscriber and runs `readAll`.
3. `readAll` calls `subscriber.request(readAt)` → `changelogRequest` ([604](../src/cache/LilypadDbCache.ts#L604)): no cursor yet, so `{ lookback: ttl + swr + 60 000 }`. Then the batched query runs. A awaits it.

**B and C** arrive while A is awaiting. `lastChangelogRead` is still `0` (it is set only after the read is applied), so their `syncBeforeRead` also calls `reader.read(subscriber)`. This time `current` exists and includes the subscriber, so they get **the same promise** (Reader line 60). One query for three callers.

**The read completes.** `applyChangelog(result, trusted = false)` ([624](../src/cache/LilypadDbCache.ts#L624)): the request was a lookback, so `expireEverything()` (nothing to expire yet, but `ticketFloor` rises to, say, 3) and `changelogTrustedSince = readAt`. The returned changes are applied (keys not held: only L2 deletes and members). Cursor stored, `lastChangelogRead = readAt`.

**A resumes** at line 1001: `renew('42')` does nothing (no entry). `super.getOrSetDetailed` ([Cache 859](../src/cache/LilypadCache.ts#L859)): no local entry, no shared level, no stale entry, no cooldown → `fetchAndStore` ([938](../src/cache/LilypadCache.ts#L938)) → `flowControl.executeFn({ functionIdentifier: 'LilypadCache-getOrSet-42', ... })` ([Flow 259](../src/flow/LilypadFlowControl.ts#L259)):

- line 260: nothing in flight;
- line 267: `rateLimit` does nothing (the cache's flow control has no `rate`);
- line 276: `executeWithRetries` → `executeWithTimeout(fn, 5000)` → `fn(signal)` starts **synchronously**: `beginRead()` takes ticket 4 ([Cache 961](../src/cache/LilypadCache.ts#L961)), and `valueFn` sends `SELECT ... WHERE id = 42`;
- line 286: the promise is registered in `singleFlightMap`. No `await` happened between 260 and 286.

**B resumes** (its promise resolved in the same microtask batch): same path down to `executeFn`, which now finds `LilypadCache-getOrSet-42` in flight and returns A's promise. **C** does the same.

**The row arrives.** Back in `fn`: `signal.aborted` is false, so `read.storeFetched(42, row)` ([667](../src/cache/LilypadCache.ts#L667)): no failure to clear; `setIfNewer` ([640](../src/cache/LilypadCache.ts#L640)) compares ticket 4 with `currentTicket('42')`: no entry, no fence, floor 3, and `4 > 3`, so it stores. `writeEntry` → `onValueStored` (members are not tracked yet, since the table was never loaded) → no eviction. `writeShared` returns at once (no shared level). The `finally` of `executeFn` removes the single-flight entry.

All three callers resolve to `{ value: row, status: 'MISS', refreshFailed: false }`. Totals: one changelog query, one row query.

### 5.2 A slow fetch loses to a write

Three variations, with explicit ticket numbers.

**(a) The key has an entry.**

| Step | Code | Ticket |
| --- | --- | --- |
| Entry `a` exists, expired | | entry = 3 |
| `getOrSet('a', slowFn)` starts the fetch | `beginRead()` | read = 4 |
| `set('a', v2)` | `setLocal` → `nextTicket()` | entry = 5 |
| `slowFn` resolves with `v1` | `setIfNewer(..., 4)`: `4 <= currentTicket = 5` | discarded |

The caller of `getOrSet` receives `v1`; the cache keeps `v2`.

**(b) The key has no entry, and is invalidated during the fetch.**

| Step | Code | Ticket |
| --- | --- | --- |
| `getOrSet('b', slowFn)` starts | `beginRead()` | read = 6 |
| A change notification for `b` → `markInvalid('b')` → `expireNormalized('b')` | no entry, but `hasReadInFlight('b')` → fence ([1514](../src/cache/LilypadCache.ts#L1514)) | fence(b) = 7 |
| `slowFn` resolves | `setIfNewer(..., 6)`: `currentTicket = max(floor, 7) = 7` | discarded |

Without the fence, the fetch, which may have read the row *before* the change, would have cached the old row.

**(c) A bulk sync completes while a fetch of a missing key runs.**

| Step | Code | Ticket |
| --- | --- | --- |
| `getOrSet('c', slowFn)` starts | | read = 8 |
| `bulkSync()` starts | `beginRead()` in `_bulkSync` | sync = 9 |
| The sync's data has no `c`; it completes | `ticketFloor = 9` ([1356](../src/cache/LilypadCache.ts#L1356)) | floor = 9 |
| `slowFn` resolves with an old `c` | `8 <= max(9, …)` | discarded |

### 5.3 An `UPDATE` from `psql` reaches a serverless instance

Setup: an instance holds `accounts` row `7` (fresh from a fetch 30 s ago, ticket 40); `sync: changelog`, `pollInterval: 5000`, `shared` configured. Someone runs `UPDATE accounts SET plan = 'pro' WHERE id = 7;` in `psql`.

**In the database.** The row trigger `accounts_lilypad_changes` fires `AFTER UPDATE FOR EACH ROW` and calls `lilypad_cache_changes_record('id')` ([Changelog 93](../src/dbGate/LilypadChangelog.ts#L93)). `new_id` and `old_id` are both `'7'`, so there is no extra `DELETE`. It inserts `(table_schema 'public', table_name 'accounts', row_id '7', op 'UPDATE')`; `xid` defaults to `pg_current_xact_id()`, say 9100. It also sends a `pg_notify`, which nobody hears on Vercel.

**On the instance**, the next request calls `accounts.getOrFetch(7)`:

1. `syncBeforeRead`: 5 s have passed since the last read, so `readChangelog()` → the reader builds requests for **every** subscribed cache of the gate, e.g. `[{ accounts, cursor: 9050 }, { users, cursor: 9050 }]`, and runs one query.
2. The query returns `next_cursor` (the oldest transaction running now, say 9120) and, for request 0, the change `{ id: '551', xid: 9100n, rowId: '7', op: 'UPDATE' }`.
3. `applyChangelog(result, trusted = true)`: `'551'` is not in `appliedChanges`, so it is recorded, then `applyChange('UPDATE', '7', 'lazy', 9100n)` ([693](../src/cache/LilypadDbCache.ts#L693)):
   - `resolveNotifiedKey('7')` finds the entry and returns its key, the number `7`;
   - `isOwnWrite(7, 9100n)`: no own write for `7` → `false`;
   - the entry exists → held → `addMember(7)` → `markInvalid(7)`: `expireNormalized` rewrites the entry with `expirationTime: 0`, ticket 55, `invalidatedAt: now`; `deleteShared(7)` removes `lilypad:accounts:7` from L2 in the background; the bulk sync is invalidated.
   - Back in `applyChangelog`: `appliedChanges` entries with xid below 9120 are dropped (including `'551'`); cursor = 9120; a `changelog` event with tag `lilypad:accounts:7`.
4. `renew('7')`: `expirationTime === 0`, so no renewal.
5. `LilypadCache.getOrSetDetailed`: the L1 entry is expired. L2: suppose another instance, which has not polled yet, writes its old copy back just now. `adoptShared` refuses it: `remote.fetchedAt < current.invalidatedAt` ([1153](../src/cache/LilypadCache.ts#L1153)). Stale window: `0 + swr < now`, so not served stale. Fetch: `SELECT ... WHERE id = 7` returns `plan = 'pro'`, stored with a ticket greater than 55.

The change reached the instance within `pollInterval`, with one changelog query (shared with every other cached table of the gate) and one row query.

### 5.4 `sqlUpdate` and its echo

Same instance. The application calls `accounts.sqlUpdate({ id: 7, plan: 'team' })`.

1. `sqlUpdate` ([1368](../src/cache/LilypadDbCache.ts#L1368)): `key = 7`; `startTicket = nextTicket()` = 60.
2. `gate.updateToTableDetailed` ([Gate 425](../src/dbGate/LilypadDbGate.ts#L425)) → `prepareWrite`: sanitization; primary key present; with `primaryKeyShouldAutoDetermine` the `id` is removed from the data (it only identifies the row); `columns = ['plan']` (only the declared columns that are not `undefined`).
3. SQL: `UPDATE "accounts" SET "plan" = $1 WHERE "id" = $2 RETURNING *, txid_current()::text AS "__lilypad_xid"`. `writeResult` strips `__lilypad_xid` and returns `{ row, xid: 9200n }`.
4. `storeWritten(7, row, 60, 9200n)` ([1321](../src/cache/LilypadDbCache.ts#L1321)): the entry's ticket (say 58) is not greater than 60, so nothing interfered. `set(7, row)` → ticket 61, and the row is written to L2. `recordOwnWrite('7', 9200n, 61)`.
5. `emitInvalidation('write', [7])`: `platform.onInvalidate` can call `revalidateTag('lilypad:accounts:7')`.

**Five seconds later**, a poll returns the trigger's change `{ xid: 9200n, rowId: '7', op: 'UPDATE' }`. `applyChange` → `isOwnWrite(7, 9200n)` ([747](../src/cache/LilypadDbCache.ts#L747)): the xid is in the set (removed now), and the entry's ticket is still 61 → `true` → return. No expiry, no query.

**Variation:** between step 4 and the poll, another instance updated row 7, and this instance applied that change first (ticket 70). At the echo, `store.get('7').ticket` is 70, not 61 → `isOwnWrite` returns `false`, and the echo is applied normally. That is correct: the entry no longer holds our write's result.

**Variation:** while the `UPDATE` of step 3 was running, a poll applied someone else's change to row 7 (entry ticket becomes 62 > 60). The library cannot know which write committed last, so `storeWritten` calls `markInvalid` instead of caching the row, and the next read queries the database.

### 5.5 The changelog query, clause by clause

[LilypadChangelog.ts:219](../src/dbGate/LilypadChangelog.ts#L219). The inputs are three parallel text arrays, one element per request: the quoted table reference, the cursor (or `''`), and the lookback in seconds.

```sql
WITH snapshot AS (SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS next_cursor),
```

The next cursor: the oldest transaction still running when this statement's snapshot was taken. Taken in the same statement as the rows, so they are consistent.

```sql
requests AS (
  SELECT (r.ordinality - 1)::int AS request, r.table_ref,
    NULLIF(r.since_cursor, '')::xid8 AS since_cursor, r.lookback_secs::float8 AS lookback_secs
  FROM unnest($1::text[], $2::text[], $3::text[]) WITH ORDINALITY AS r(...)
),
```

Turns the three arrays back into rows, numbered from 0 so that each result row can be routed to `changes[request]`. An empty cursor becomes `NULL`, meaning "use the lookback".

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
SELECT snapshot.next_cursor, targets.request, c.id::text, c.xid::text, c.row_id, c.op
FROM snapshot
LEFT JOIN targets ON true
```

`snapshot` is always one row, and the `LEFT JOIN`s keep it even if there are no targets or no changes, so `next_cursor` always comes back (the code throws if it does not, line 265).

```sql
LEFT JOIN LATERAL (
  SELECT ... FROM changelog c
  WHERE targets.since_cursor IS NOT NULL
    AND c.table_name = targets.rel_name
    AND (c.table_schema = targets.schema_name OR c.table_schema IS NULL)
    AND c.xid >= targets.since_cursor
  UNION ALL
  SELECT ... FROM changelog c
  WHERE targets.since_cursor IS NULL
    AND c.table_name = targets.rel_name
    AND (c.table_schema = targets.schema_name OR c.table_schema IS NULL)
    AND c.changed_at >= clock_timestamp() - make_interval(secs => targets.lookback_secs)
) c ON true
ORDER BY c.id
```

For each target, one of the two branches returns rows (the other one's first condition is false). Splitting them in a `UNION ALL` lets each branch use its own index: `(table_name, xid)` for cursor reads, `(changed_at)` for lookbacks. `table_schema IS NULL` accepts rows written by a version 1 trigger, which did not record the schema. `xid >= cursor` (not `>`) because the cursor transaction itself was still running at the last read. `ORDER BY c.id` applies the changes in the order they were recorded.

---

## 6. Glossary and where to go next

| Term | Meaning |
| --- | --- |
| **L1** | The memory of one instance (`store`) |
| **L2** / shared level | A key-value store shared by all instances (`platform.shared`, e.g. the Vercel Runtime Cache) |
| **Ticket** | A number from an ever-increasing counter that orders writes; a read stores its result only if its ticket beats the key's |
| **Floor** (`ticketFloor`) | The ticket that reads of *missing* keys must beat; raised by bulk syncs and `expireEverything` |
| **Fence** | A per-key floor, set when a missing key is expired while a read of it runs |
| **Single-flight** | Concurrent calls for the same identifier share one execution |
| **Fallback** | A value returned after a failed fetch (`errorFn` or `returnOldOnError`), cached locally with `origin: 'fallback'` |
| **Cooldown** | After a failed fetch, the key is not fetched again for `failureCooldown` ms |
| **Stale** / SWR | An expired value served while it is refreshed in the background, within `staleWhileRevalidate` |
| **Invalidated** | `expirationTime === 0`: expired, never served stale, still a fallback |
| **Bulk sync** | Replacing the whole cache with `bulkSyncFn`; "fresh" while `now < bulkSyncExpirationTime` |
| **Members** | The keys that `LilypadDbCache` knows to exist in its table, used by `getAll` |
| **Trusted sync** | `LISTEN` active, or the changelog read within `maxGap`: the cache sees every change |
| **Renew** | Extending an expired, trusted, unchanged entry without a query, up to `maxAge` |
| **Cursor** | For the changelog: the oldest transaction running at the last read; the next read returns `xid >= cursor` |
| **Lookback** | A changelog read by time instead of cursor, when the cursor is missing or too old |
| **Own write** | A change made by this instance's `sqlCreate`/`sqlUpdate`/`sqlDelete`, recognised by its `xid` |

**Where to go next.** The tests are the best executable documentation of the edge cases, and each describes one behaviour by name:

- [LilypadCache.test.ts](../src/cache/LilypadCache.test.ts): tickets, fences, bulk sync, eviction (everything runs on fake timers, `vi.advanceTimersByTimeAsync`);
- [LilypadCache.shared.test.ts](../src/cache/LilypadCache.shared.test.ts): L2, stale-while-revalidate and the cooldown, with an in-memory store that clones values;
- [LilypadDbCache.test.ts](../src/cache/LilypadDbCache.test.ts): the sync strategies, `getAll`, own writes, against an in-memory fake gate and a mocked changelog;
- [LilypadDbGate.integration.test.ts](../src/dbGate/LilypadDbGate.integration.test.ts): the real thing against PostgreSQL in Docker, including the out-of-order commit test for the changelog cursor ("should not miss a transaction that commits after a later one") and a reference `NOTIFY` trigger.

To see a behaviour in action, run a single test by name: `npx vitest run --project unit -t "<part of the test name>"`.
