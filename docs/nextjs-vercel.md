# Using Lilypad on Next.js and Vercel

The library does not depend on Next.js or Vercel. It declares the few platform capabilities it can use (background work, a shared cache level, an invalidation hook) as plain options, and your application connects them in one file. This guide shows that file, the recommended option for each module, and why.

**Contents:** [Assumptions](#what-the-library-assumes-about-the-platform) · [Platform adapter](#1-the-platform-adapter) · [Database connection](#2-the-database-connection) · [Creating instances](#3-creating-instances-without-connecting-at-build-time) · [Caches](#4-caches) · [Database caches and the changelog](#5-database-caches-keeping-every-instance-up-to-date) · [Logger](#6-logger) · [Edge runtime](#7-edge-runtime-and-middleware) · [Recommended options](#8-recommended-options-at-a-glance) · [Known limits](#9-known-limits) · [Troubleshooting](#10-troubleshooting)

## What the library assumes about the platform

The recommendations below are conservative. They do not rely on instances being reused (Fluid compute), because that is not guaranteed:

1. **An instance can be suspended as soon as the response is sent**, and may never resume. Work that continues after the response survives only if it is registered with `after` (Next.js) or `waitUntil` (Vercel).
2. **An instance can also stay alive** and serve many requests, even concurrently. Its memory is a useful cache level, but correctness never depends on it.
3. **Timers and TCP connections may not survive a suspension.** Nothing relies on `setInterval`, and connections are closed quickly when idle.
4. **Many instances run at the same time**, possibly in several regions. The Vercel Runtime Cache is per region, so the only source that every instance sees the same way is the database.
5. **Queries go through a connection pooler** in transaction mode (e.g. Neon's pooled connection string). `LISTEN/NOTIFY` does not work through it.

## 1. The platform adapter

Create this file in your application. It is the only place that imports Next.js and Vercel:

```ts
// lib/lilypad-platform.ts
import { after } from 'next/server';
import { getCache } from '@vercel/functions';
import { revalidateTag } from 'next/cache';
import type { LilypadPlatform } from '@lilypad/libs/platform';

export const platform: LilypadPlatform = {
  // Keeps the function alive until the task settles (logs, cache writes)
  background: (task) => after(() => task),
  // Starts background refreshes only once the response is sent
  afterResponse: (work) => after(work),
  // A cache level shared by every instance of a region
  shared: getCache(),
  // Keeps the Next.js cache in line with the Lilypad caches (optional)
  onInvalidate: ({ source, tags }) => {
    // Every instance reads the same changelog entries: react only to the writes of this instance
    if (source === 'write') {
      tags.forEach((tag) => revalidateTag(tag));
    }
  },
};
```

- `background` can also be `waitUntil` from `@vercel/functions`. `after` is preferable in Next.js, because Next.js also honors it when running outside Vercel.
- `after` throws when called outside a request (for example in a script). The library catches it: the work still runs, only without the guarantee.
- `getCache()` returns the Vercel Runtime Cache, whose shape matches `LilypadSharedStore`. Its TTLs are in seconds; the library converts them.
- Check the signature of `revalidateTag` in your Next.js version. The event also carries `cache` and `keys` if you tag your Next.js data differently.

Pass `platform` to every module you create (see below).

## 2. The database connection

```ts
// lib/db.ts
import { LilypadDbGate, lilypadServerlessPool } from '@lilypad/libs/db';

export const getGate = () =>
  LilypadDbGate.create({
    singleton: true,
    singletonIdentifier: 'main',
    connectionString: process.env.DATABASE_URL!, // the POOLED connection string
    pool: lilypadServerlessPool, // { max: 3, idleTimeout: 5 s, connectTimeout: 10 s }
    statementTimeout: 10_000, // Postgres cancels queries longer than 10 s
  });
```

- **Use the pooled connection string** (with Neon, the host that contains `-pooler`). Every instance opens its own pool, and a pooler lets many of them share few database connections. The gate already disables prepared statements (`prepare: false`), which transaction-mode poolers require.
- **`lilypadServerlessPool`** keeps few connections per instance (`max: 3`) and closes them after 5 idle seconds, so a suspended instance does not hold connections. Raise `max` if a single request runs many queries in parallel.
- **`statementTimeout`** makes Postgres stop queries that take too long, so that slow queries whose callers already gave up do not pile up. Keep it below the `maxDuration` of your functions.
- `listenerConnectionString` (a direct, non-pooled connection) is only needed by the `listen` strategy, which is not recommended on Vercel (see section 5).

## 3. Creating instances without connecting at build time

`next build` imports your route modules to collect page data. Anything a module does when it is imported also runs during the build.

- `LilypadDbGate.create` opens **no connection** as long as it has no listeners: the pool connects on the first query.
- `LilypadDbCache.create` opens no connection with the `changelog` or `none` strategies, or with `listen` and `connect: 'lazy'`. With the default `listen` strategy it connects at once, to start `LISTEN`.

Even so, create instances on first use, through a function, rather than with a top-level `await`:

```ts
// Good: nothing runs until a request calls getUsers()
export const getUsers = async () =>
  LilypadDbCache.create<number, User, 'id'>(60_000, { singleton: true, singletonIdentifier: 'users', ... });

// Avoid: runs when the module is imported, including during the build
export const users = await LilypadDbCache.create(...);
```

With `singleton: true`, every call returns the same instance for the lifetime of the Node.js process, even across hot reloads in development.

## 4. Caches

```ts
import { LilypadCache } from '@lilypad/libs/cache';
import { platform } from './lilypad-platform';

const prices = new LilypadCache<string, Price>(60_000, {
  name: 'prices', // required with `shared`; unique per shared store
  platform,
  shared: {
    timeout: 300, // a slower shared store counts as missing
    refreshLockTtl: 60_000, // the maxDuration of your functions
    codec: priceCodec, // see below
  },
  staleWhileRevalidate: 10 * 60_000, // serve up to 10 minutes stale while refreshing
  failureCooldown: 30_000, // after a failure, do not retry the source for 30 s
  cleanupOnAccessEvery: 60_000, // no timers
  maxEntries: 5_000,
});

const { value, status, refreshFailed } = await prices.getOrSetDetailed('eur', fetchPrice);
```

The lookup order of `getOrSet` is: memory of the instance (**L1**), shared level (**L2**), stale value, fetch.

- **`shared`**: an instance that starts cold finds the values fetched by the others. The age of a value is measured from when it was fetched, not from when it reached the instance. A failing or slow shared store never blocks a response: after `timeout` it counts as missing.
- **`codec`**: the shared store keeps JSON. Without a codec, a `Date` comes back as a string. A codec converts the values and validates what comes back (`decode` returns `null` to reject an entry).
- **`staleWhileRevalidate`**: an expired value is returned at once, and refreshed after the response (`afterResponse`). Choose it as the largest age you accept to show. An `invalidate()`d value is never served stale.
- **`refreshLockTtl`**: prevents several instances from refreshing the same key at the same time. It is a soft lock (read and write are not atomic): rarely, two instances still refresh together, which is harmless.
- **`failureCooldown`**: while a source is down, requests do not all retry it. The cooldown is shared through L2. During it, a stale value or the `errorFn`/`returnOldOnError` fallbacks are used, otherwise `LilypadCacheCooldownError` is thrown.
- **`cleanupOnAccessEvery`** replaces `autoCleanupInterval`, whose timer does not run while an instance is suspended.
- **`status`** (`L1-HIT`, `L2-HIT`, `STALE`, `MISS`) and **`refreshFailed`** let you log the hit rate, or show "prices as of …" when the refresh failed.
- Per-call `timeout` overrides `flowControlTimeout`: keep the fetch within the remaining time of the request.

## 5. Database caches: keeping every instance up to date

A `LilypadDbCache` must learn about the changes made by other instances and by other programs (scripts, admin tools, other services). The `sync` option chooses how:

| Strategy | How | Delay | Suited to |
| --- | --- | --- | --- |
| `changelog` | A trigger records each change in a table; each instance reads the new rows, at most once per `pollInterval`, when the cache is used | ≤ `pollInterval` | **Vercel**, any serverless platform |
| `listen` | `LISTEN/NOTIFY` on a dedicated connection | Near real time | Long-running servers only |
| `none` | Only the writes of this instance, and the TTL | ≤ TTL | Data that no one else changes |

`listen` is not suited to Vercel: it needs a connection that stays open, it does not work through a pooler, and the notifications sent while an instance is suspended are lost.

### Setting up the changelog

Run this once, in a migration (it uses a direct connection, as any migration):

```ts
import { lilypadChangelogSql, lilypadChangelogTriggerSql } from '@lilypad/libs/db';

await sql.unsafe(lilypadChangelogSql());
await sql.unsafe(lilypadChangelogTriggerSql({ table: 'users', primaryKey: 'id' }));
// ...one trigger per cached table
```

Or print the SQL and paste it into your migration tool: both functions return plain SQL strings. It needs PostgreSQL 13 or later.

- The changelog table (`lilypad_cache_changes`) records the table, the primary key and the operation of every change. An update that changes the primary key is recorded as a delete of the old key and an update of the new one.
- The trigger also sends a `NOTIFY` on `cache_events`, so `listen` and `changelog` can coexist (for example a long-running worker next to the Vercel app). Pass `{ notifyChannel: false }` to skip it.

### Using it

```ts
const users = await LilypadDbCache.create<number, User, 'id'>(60_000, {
  dbGate: { gate: await getGate(), schema: usersSchema },
  platform,
  shared: { refreshLockTtl: 60_000 },
  sync: { strategy: 'changelog', pollInterval: 5_000 },
  staleWhileRevalidate: 60_000,
  cleanupOnAccessEvery: 60_000,
});
```

- **`pollInterval`**: the largest delay you accept for changes made elsewhere. Each read of the changelog is one indexed query. It happens only when the cache is used, so an idle instance costs nothing.
- **`poll: 'await'`** (default): a read that falls due waits for the changelog, so it never returns data older than `pollInterval`. With `'background'` the request does not pay for the query, but may see data one interval older.
- **`maxGap`** (default: 1 hour): an instance that has not read the changelog for this long stops trusting its memory, and expires it.
- **`lookback`**: on its first read, or after `maxGap`, an instance applies the changes of this period, which also removes older copies from the shared level. The default (TTL + `staleWhileRevalidate` + 1 minute) covers the lifetime of any shared entry.
- **No change is ever missed** because of the order in which transactions commit. The cursor is the oldest transaction still running, not the last row read.
- `get()` is synchronous, so it cannot read the changelog. Use `getOrFetch`, `getOrSet` or `getAll`.

### Deleting old changelog rows

Delete the rows older than the retention periodically, for example daily with Vercel Cron:

```ts
// app/api/cron/lilypad-changelog/route.ts
import { pruneLilypadChangelog } from '@lilypad/libs/db';
import { getGate } from '@/lib/db';

export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  const deleted = await pruneLilypadChangelog(await getGate(), { olderThan: 24 * 60 * 60_000 });
  return Response.json({ deleted });
}
```

```json
// vercel.json
{ "crons": [{ "path": "/api/cron/lilypad-changelog", "schedule": "0 3 * * *" }] }
```

The retention (`olderThan`) must be much longer than `maxGap` and `lookback`. With the defaults, 24 hours leaves a wide margin.

### Invalidation events

Every change that reaches a cache calls `platform.onInvalidate` with a `source`:

| `source` | When | Sent by |
| --- | --- | --- |
| `write` | `sqlCreate`, `sqlUpdate`, `sqlDelete` | The instance that wrote |
| `changelog` | A change read from the changelog | **Every** instance that reads it |
| `notification` | A `LISTEN/NOTIFY` notification | Every listening instance |
| `manual` | `invalidate()` | The instance that called it |

Filter on `source` so that a change triggers your action (for example `revalidateTag`) only once. The tags are `lilypad:<table>` and `lilypad:<table>:<key>`; `tagPrefix` changes `lilypad`.

## 6. Logger

```ts
import { AsyncLocalStorage } from 'node:async_hooks';
import { LilypadLogger, LilypadJsonConsoleLogger, LilypadDiscordLogger } from '@lilypad/libs/logger';
import { platform } from './lilypad-platform';

export const requestContext = new AsyncLocalStorage<{ requestId: string }>();

const json = new LilypadJsonConsoleLogger<Channels>();
const discord = new LilypadDiscordLogger<Channels>(process.env.DISCORD_WEBHOOK_URL!);

export const getLogger = () =>
  LilypadLogger.create<Channels>({
    singleton: true,
    singletonIdentifier: 'app',
    name: 'my-app',
    platform, // messages sent after the response are not lost
    context: () => requestContext.getStore(), // adds requestId to every line
    components: { error: [json, discord], warn: [json], info: [json], debug: [] },
  });
```

- **`platform`**: each message being sent is registered with `background`. Without it, a message logged at the end of a request, and especially a Discord message, can be lost when the instance is suspended.
- **`LilypadJsonConsoleLogger`** writes one JSON object per line (`time`, `level`, `logger`, `msg`, your context fields, `errors`). Vercel logs and log drains can filter on these fields.
- **`context`** runs synchronously when a message is logged, so it sees the `AsyncLocalStorage` of the request. The library does not know where the values come from.
- **`LilypadDiscordLogger`** batches the messages logged within `minRequestInterval` (1 s) into one Discord message. With `platform`, the function stays alive until the batch is sent. Lower `minRequestInterval` if you prefer shorter lifetimes to fewer requests.
- **`await logger.flush()`** waits for every message being sent: useful at the end of a script, or where `platform` is not available.

## 7. Edge runtime and middleware

Import the subpaths, not the package root, in edge code:

| Import | Edge runtime |
| --- | --- |
| `@lilypad/libs/logger`, `/cache`, `/flow`, `/serializer`, `/singleton`, `/platform` | Yes |
| `@lilypad/libs/db` (`LilypadDbGate`, `LilypadDbCache`, changelog) | No: it needs TCP connections |
| `@lilypad/libs` (the root) | No: it includes `/db` |

The subpaths also keep the bundles small, since `postgres` is only pulled in by `/db`.

## 8. Recommended options at a glance

| Module | Option | On Vercel | Why |
| --- | --- | --- | --- |
| All | `platform` | The adapter of section 1 | Background work survives the end of the request |
| `LilypadDbGate` | `connectionString` | Pooled | Many instances, few database connections |
| | `pool` | `lilypadServerlessPool` | Few connections per instance, closed when idle |
| | `statementTimeout` | Below `maxDuration`, e.g. `10_000` | Slow queries stop instead of piling up |
| | `listen` | Leave empty | `LISTEN` needs a long-lived direct connection |
| `LilypadCache`, `LilypadDbCache` | `shared` | `{}` (store from `platform`), with a `codec` for non-JSON values | Cold instances find the values of the others |
| | `shared.timeout` | `300` | The shared level never slows a response down much |
| | `shared.refreshLockTtl` | The `maxDuration` of your functions | One instance refreshes a key at a time |
| | `staleWhileRevalidate` | The largest age you accept to show | Responses do not wait for refreshes |
| | `failureCooldown` | `30_000` | A source that is down is not retried by every request |
| | `cleanupOnAccessEvery` | `60_000` (and no `autoCleanupInterval`) | No timers |
| | `maxEntries` | According to the memory of your functions | Bounded memory on long-lived instances |
| `LilypadDbCache` | `sync` | `{ strategy: 'changelog', pollInterval: 5_000 }` | Works without long-lived connections, sees external changes |
| | TTL (with `shared`) | ≤ `60_000` | Bounds the rare race described in section 9 |
| Changelog | Retention | `pruneLilypadChangelog`, 24 h, daily | Keeps the table small; much longer than `maxGap` |
| `LilypadLogger` | `platform`, `context` | The adapter; your request context | Logs are not lost and can be correlated |
| | Components | `LilypadJsonConsoleLogger` | Structured, filterable logs |

## 9. Known limits

- **A rare race on the shared level.** A query that starts before a change and stores its result after the changelog has been read can leave an old value in the shared level until its TTL. This is why the TTL of database caches with `shared` should stay short (≤ 60 s).
- **The shared level is per region** on Vercel. The changelog keeps every region correct; only the hit rate is per region.
- **`bulkSync` and `getAll`** fill the memory of the instance, not the shared level: a whole table is not copied into it.
- **`clear()` and `dispose()`** act on the instance only. To empty a cache everywhere, expire its tag (`lilypad:<name>`) in the Runtime Cache.
- **Rate limits** of `LilypadFlowControl` (`rate`) apply per instance. A limit shared by every instance would need a store with atomic increments (e.g. Redis); the Runtime Cache does not provide them.
- **`get()`** reads only the memory of the instance, synchronously: it neither reads the shared level nor the changelog.

## 10. Troubleshooting

**`too many connections` / `remaining connection slots are reserved`.**
Use the pooled connection string, and `pool: lilypadServerlessPool`. Check that nothing creates a new gate per request: create it once, as a singleton.

**The build fails because it cannot reach the database, or it is slow.**
Something connects when a module is imported. Create instances in functions (section 3), and use `sync: 'changelog'` or `connect: 'lazy'`.

**A change made outside the app never shows up.**
Check that the changelog trigger is on the table (`lilypadChangelogTriggerSql`) and that the table name matches `schema.tableName`. Pass a logger: a failing changelog read is logged as `Error reading the changelog`. Changes show up within `pollInterval`, only when the cache is read with an async method.

**Logs, or Discord messages, are missing.**
Pass `platform` to the logger. In scripts, `await logger.flush()` before exiting.

**`LilypadCacheCooldownError`.**
The source failed less than `failureCooldown` ago and there is no stale value or fallback. Look for the original error in the logs (`Error fetching cache key`), or add an `errorFn`.

**`refreshFailed: true` on a response.**
The last background refresh failed: the value is the last one fetched successfully. The error is in the logs.
