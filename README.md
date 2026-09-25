# @lilypad/libs

Server-side TypeScript utilities from Lilypad Studios:

| Module | What it gives you |
| --- | --- |
| [`LilypadLogger`](#logger) | A typed logger with named channels (`logger.info(...)`, `logger.error(...)`) and pluggable outputs (console, Discord, your own). |
| [`LilypadCache`](#lilypadcache) | A TTL cache that deduplicates concurrent fetches, serves stale values while refreshing them, falls back to the old value when a fetch fails, and can share its values between instances. |
| [`LilypadDbGate`](#lilypaddbgate) | A thin PostgreSQL gateway (built on [postgres.js](https://github.com/porsager/postgres)): typed CRUD helpers and `LISTEN/NOTIFY` subscriptions. |
| [`LilypadDbCache`](#lilypaddbcache) | A `LilypadCache` backed by one database table, kept up to date by a changelog table or by Postgres notifications. |
| [`LilypadFlowControl`](#lilypadflowcontrol) | Timeouts, retries with backoff, rate limiting and single-flight deduplication for async calls. |
| [`LilypadSerializer`](#lilypadserializer) | Type-checked mapping between two object shapes (for example, compact storage keys) that leaves out default values. |
| [Singleton helpers](#singletons) | A process-wide registry that survives hot reloads and duplicate bundles. |

**Running on Next.js or Vercel?** Read [Using Lilypad on Next.js and Vercel](docs/nextjs-vercel.md): it shows how to connect the library to the platform, and the recommended options for each module.

**Contents:** [Installation](#installation) · [Quick start](#quick-start) · [Conventions](#conventions-used-across-the-library) · [Next.js / Vercel](docs/nextjs-vercel.md) · [Logger](#logger) · [LilypadCache](#lilypadcache) · [LilypadDbGate](#lilypaddbgate) · [LilypadDbCache](#lilypaddbcache) · [LilypadFlowControl](#lilypadflowcontrol) · [LilypadSerializer](#lilypadserializer) · [Singletons](#singletons) · [Troubleshooting](#troubleshooting) · [Contributing](#contributing)

## Installation

The built package (`dist/`) is committed to the repository, so you can install it straight from GitHub:

```bash
npm install github:Lilypad-Studio/LilypadLibs
```

Requirements:

- Node.js 20 or later.
- It is built as CommonJS and ESM, with type declarations.
- The database modules (`@lilypad/libs/db`) run on Node.js only, since they need TCP connections. The other modules also run in edge runtimes (see [Importing](#importing-the-whole-package-or-one-module)). None of them is meant for browsers.
- The database modules need PostgreSQL. The `postgres` driver is installed as a dependency.

## Quick start

This example loads a `users` table into a cache and reads rows through it:

```ts
import {
  LilypadLogger,
  LilypadConsoleLogger,
  LilypadDbGate,
  LilypadDbCache,
  type LilypadDbSchema,
} from '@lilypad/libs';

type User = { id: string; name: string; email: string };

const usersSchema: LilypadDbSchema<User, 'id'> = {
  tableName: 'users',
  primaryKey: 'id',
  cols: {
    id: { type: 'string' },
    name: { type: 'string' },
    email: { type: 'string' },
  },
};

// 1. A logger with the four channels the other modules expect
const logger = LilypadLogger.create<'error' | 'warn' | 'info' | 'debug'>({
  name: 'my-app',
  components: {
    error: [new LilypadConsoleLogger()],
    warn: [new LilypadConsoleLogger()],
    info: [new LilypadConsoleLogger()],
    debug: [], // a channel with no components discards its messages
  },
});

// 2. The database gateway
const gate = await LilypadDbGate.create({
  connectionString: process.env.DATABASE_URL!,
  logger,
});

// 3. A cache over the `users` table
const users = await LilypadDbCache.create<string, User, 'id'>(60_000, {
  dbGate: { gate, schema: usersSchema },
  logger,
});

const user = await users.getOrFetch('42');
if (user === undefined) {
  // the lookup failed (the error has already been logged)
} else if (user === null) {
  // there is no user with this id
} else {
  void logger.info('Hello', user.name);
}

// 4. On shutdown
await users.dispose();
await gate.close();
```

By default, `LilypadDbCache` updates itself when rows change, but only if the database sends notifications. See [Keeping the cache in sync with the database](#keeping-the-cache-in-sync-with-the-database) for the trigger to install.

## Conventions used across the library

### Importing the whole package or one module

`@lilypad/libs` exports everything. Each module is also available on its own:

| Import | Contents | Edge runtime |
| --- | --- | --- |
| `@lilypad/libs/logger` | `LilypadLogger` and the components | Yes |
| `@lilypad/libs/cache` | `LilypadCache` | Yes |
| `@lilypad/libs/flow` | `LilypadFlowControl` | Yes |
| `@lilypad/libs/serializer` | `LilypadSerializer` | Yes |
| `@lilypad/libs/singleton` | The singleton registry | Yes |
| `@lilypad/libs/platform` | The platform types (`LilypadPlatform`, ...) | Yes |
| `@lilypad/libs/db` | `LilypadDbGate`, `LilypadDbCache`, the changelog helpers | No |

Import the modules you use: bundles stay smaller, since only `/db` pulls in `postgres`, and code that runs in an edge runtime (for example Next.js middleware) must not import the root or `/db`.

### Platform capabilities

On serverless platforms, the modules accept a `platform` option (type `LilypadPlatform`). Every field is optional:

| Field | What the library does with it | On Next.js / Vercel |
| --- | --- | --- |
| `background(task)` | Keeps the instance alive until `task` settles: log messages being sent, shared level writes, invalidation events | `(task) => after(() => task)` or `waitUntil` |
| `afterResponse(work)` | Starts stale-while-revalidate refreshes once the response is sent. Without it, they start at once (through `background`) | `(work) => after(work)` |
| `shared` | The default store of the caches' shared level (`get`, `set` with a `ttl` in **seconds**, `delete`) | `getCache()` from `@vercel/functions` |
| `onInvalidate(event)` | Called when cached data changes (see [Invalidation events](docs/nextjs-vercel.md#invalidation-events)) | `revalidateTag` |

If `background` or `afterResponse` throws (for example `after` called outside a request), the work still runs, only without the guarantee. See [Using Lilypad on Next.js and Vercel](docs/nextjs-vercel.md). Without `platform`, the modules behave as on a long-running server.

### Creating instances: `create()` or `new`

| Class | How to create it |
| --- | --- |
| `LilypadLogger` | `LilypadLogger.create(options)` (synchronous) |
| `LilypadDbGate` | `await LilypadDbGate.create(options)` |
| `LilypadDbCache` | `await LilypadDbCache.create(ttl, options)` |
| `LilypadCache`, `LilypadFlowControl`, `LilypadSerializer`, logger components | `new ...` |

The first three classes have private constructors, so `new LilypadLogger(...)` does not compile. `LilypadDbGate.create` and `LilypadDbCache.create` are async: they resolve only after their `LISTEN` subscriptions are active, and they reject if the database cannot be reached.

### Singletons

Every `create()` accepts either `singleton: true` together with a `singletonIdentifier`, or no singleton option at all:

```ts
// Always returns the same instance for 'main-db', even when called from several modules
const gate = await LilypadDbGate.create({
  singleton: true,
  singletonIdentifier: 'main-db',
  connectionString: process.env.DATABASE_URL!,
});
```

- The first call builds the instance. Later calls with the same identifier return that instance and **ignore their own options**. If those options differ from the first ones (connection strings for a gate, table or TTL for a cache, name or channels for a logger), a warning is logged (`console.warn` for the logger).
- Identifiers are separate for each class: a `LilypadLogger` and a `LilypadDbGate` can both use `'main'`.
- Concurrent first calls share one initialization. If it fails, the next call tries again.
- `gate.close()` and `cache.dispose()` remove the instance from the registry, so the next `create()` builds a new one.

This is useful in frameworks with hot module reloading, such as Next.js in development, where module-level variables are created again on every reload but connections should not be.

### Passing a logger to the other modules

`LilypadCache`, `LilypadDbCache`, `LilypadDbGate` and `LilypadFlowControl` accept an optional `logger` with at least the channels `error`, `warn`, `info` and `debug` (the type `LilypadLibLogger`). A logger with more channels also works. Without a logger, these modules log nothing. That includes errors they handle themselves, such as a failed `bulkSync` or a failed notification callback.

### `undefined` and `null` are different

Cache methods return:

- `undefined`: the key is **not in the cache** (or has expired), so the value is unknown.
- `null`: the key **is in the cache**, and the value is known **not to exist** (for example, no row has that primary key).
- any other value: the cached value.

Use `null` to cache "not found" results. Repeated lookups of a missing id then stop reaching the database.

## Logger

### Creating a logger

You choose the channel names. Each channel becomes an async method on the logger:

```ts
import { LilypadLogger, LilypadConsoleLogger, LilypadDiscordLogger } from '@lilypad/libs';

type Channels = 'error' | 'warn' | 'info' | 'debug';

const consoleOutput = new LilypadConsoleLogger<Channels>();
const discordOutput = new LilypadDiscordLogger<Channels>(process.env.DISCORD_WEBHOOK_URL!);

const logger = LilypadLogger.create<Channels>({
  name: 'billing', // optional, printed as [billing]
  components: {
    error: [consoleOutput, discordOutput], // errors also go to Discord
    warn: [consoleOutput],
    info: [consoleOutput],
    debug: process.env.NODE_ENV === 'production' ? [] : [consoleOutput],
  },
  // Optional: called for each component that fails (for example, Discord is unreachable).
  // Without it, or if it fails too, the failure is printed with console.error.
  errorLogging: async (error) => {
    process.stderr.write(`Logger failure: ${String(error)}\n`);
  },
});

void logger.info('Invoice created', { id: 'inv_1', total: 42 });
void logger.error('Payment failed', new Error('card declined'));
// 2026-09-24T10:00:00.000Z - [billing] [INFO]: Invoice created { id: 'inv_1', total: 42 }
```

- A channel method takes any number of arguments. Strings are printed as they are. Other values are formatted in a style close to `util.inspect`: an `Error` keeps its message, stack trace and `cause`, and circular objects or BigInts do not throw.
- Channel methods never reject: each failing component is reported to `errorLogging`, and a failure of `errorLogging` itself is printed with `console.error`. A failing component does not stop the others. Call them with `void` ("fire and forget"), or `await` them if the message must be sent before you continue, for example just before `process.exit`.
- A channel name cannot be the name of a logger property (`components`, `register`, `flush`, `constructor`, `toString`, and so on) or `then`. `create()` throws if it is.
- Without a type argument, the channels are `'log' | 'error' | 'warn'`.
- `createLogger(options)` is a deprecated alias of `LilypadLogger.create(options)`.

### Serverless: background work, flush and context

```ts
const logger = LilypadLogger.create<Channels>({
  components: { ... },
  // Every message being sent is passed to `background`, so that it survives the end of the request
  platform: { background: (task) => after(() => task) },
  // Called when each message is logged: its fields are added to the message
  context: () => requestContext.getStore(),
});

await logger.flush(); // waits for every message being sent, e.g. at the end of a script
```

On a serverless platform an instance can be suspended as soon as the response is sent: without `platform`, a message still being sent at that moment (for example to Discord) can be lost.

`context` is read synchronously when the message is logged, so it sees the caller's `AsyncLocalStorage`. Its fields are appended to the text message as JSON, and become top-level fields with `LilypadJsonConsoleLogger`. If `context` throws, the message is logged without context.

### Typing a logger parameter

Use `LilypadLoggerType<Channels>` to type a logger, not `LilypadLogger<Channels>`: only the first type includes the channel methods.

```ts
import type { LilypadLibLogger } from '@lilypad/libs';

// LilypadLibLogger = LilypadLoggerType<'error' | 'warn' | 'info' | 'debug'>
class OrderService {
  constructor(private readonly logger?: LilypadLibLogger) {}

  run() {
    void this.logger?.info('running');
  }
}
```

### Adding components later

`register()` adds components to channels that already exist. It cannot create new channels: it throws for a channel that was not given to `create()`. It returns the logger, so calls can be chained.

```ts
logger.register({ debug: [new LilypadConsoleLogger()] });
```

### Writing your own component

Extend `LilypadLoggerComponent` and implement `send()`. The message you receive is already formatted as `<ISO timestamp> - [name] [CHANNEL]: <message> <context as JSON>`. To receive the structured record instead (`type`, `message`, `parts`, `timestamp`, `loggerName`, `context`), override `sendRecord(record)`.

```ts
import { LilypadLoggerComponent } from '@lilypad/libs';
import { appendFile } from 'node:fs/promises';

class FileLogger<T extends string> extends LilypadLoggerComponent<T> {
  constructor(private readonly path: string) {
    super();
  }

  // `type` is the channel name, if you want to route messages by severity
  protected async send(message: string, type: T): Promise<void> {
    await appendFile(this.path, message + '\n');
  }
}

logger.register({ error: [new FileLogger('errors.log')] });
```

If `send()` throws or rejects, the logger passes the error to `errorLogging`.

### Built-in components

- **`LilypadConsoleLogger`**: channels named `error` go to `console.error`, channels named `warn` go to `console.warn` (case-insensitive), and every other channel goes to `console.log`.
- **`LilypadJsonConsoleLogger`**: the same routing, but each message is one JSON object (`time`, `level`, `logger`, `msg`, the context fields, and `errors` with name, message and stack). Log platforms can filter on these fields.
- **`LilypadDiscordLogger(webhookUrl, options?)`**: posts messages to a Discord webhook.
  - Requests are throttled: at most one every `minRequestInterval` ms (default: 1 000). Messages logged in between are sent together in one Discord message, up to 2000 characters.
  - A request rate limited by Discord (429) is retried after the `retry-after` time (1 s if Discord gives none), `rateLimitRetries` times (default: 1).
  - When a request fails (error status, timeout, rate limit after the retries), every message of its batch is reported to the logger's `errorLogging`.
  - Messages longer than 2000 characters are cut.
  - Mentions are disabled, so `@everyone` notifies no one.
  - Each request times out after 5 seconds.
  - Everything you log is visible to the members of the Discord channel, so do not log secrets or personal data on these channels.
  - Keep the webhook URL in an environment variable, not in the code.

## LilypadCache

An in-memory cache with string or number keys and a time to live (TTL) for each entry.

```ts
import { LilypadCache } from '@lilypad/libs';

type Product = { id: string; price: number };

const products = new LilypadCache<string, Product>(
  30_000, // default TTL in ms (default: 60 000)
  {
    autoCleanupInterval: 60_000, // remove expired entries every minute, with a timer (default: never)
    // cleanupOnAccessEvery: 60_000, // the same without a timer, for serverless platforms
    defaultErrorTtl: 30_000, // TTL of fallback values after an error (default: the TTL, at most 5 min)
    flowControlTimeout: 5_000, // timeout of getOrSet fetches (default: 5 s)
    bulkSyncTimeout: 30_000, // timeout of bulkSync (default: 30 s)
    // logger,
  }
);
```

Every constructor option, in one place (the sections below explain them):

| Option | Default | What it does |
| --- | --- | --- |
| `autoCleanupInterval` | never | Removes expired entries with a timer (which does not keep Node.js running) |
| `cleanupOnAccessEvery` | never | Removes expired entries during reads and writes, at most once per interval. It needs no timer, so it suits instances suspended between requests |
| `defaultErrorTtl` | the TTL, at most 5 min | TTL of a fallback value cached after a failed fetch |
| `flowControlTimeout` | 5 s | Timeout of the fetches of `getOrSet` |
| `staleWhileRevalidate` | 0 (off) | [Stale values](#stale-values-cooldown-and-bounded-memory) |
| `failureCooldown` | 0 (off) | [Cooldown after a failed fetch](#stale-values-cooldown-and-bounded-memory) |
| `maxEntries` | no limit | [Bounded memory](#stale-values-cooldown-and-bounded-memory) |
| `name` | a random id | Names the cache in shared level keys and invalidation events. Required with `shared` |
| `shared` | none | [A level shared by every instance](#a-level-shared-by-every-instance) |
| `platform` | none | [Platform capabilities](#platform-capabilities) |
| `tagPrefix` | `'lilypad'` | Prefix of the tags of the invalidation events (`<tagPrefix>:<name>:<key>`) |
| `bulkSyncFn`, `defaultBulkSyncTtl`, `bulkSyncTimeout` | none, the TTL, 30 s | [Loading everything at once](#loading-everything-at-once-bulksync) |
| `logger` | none | See [Passing a logger](#passing-a-logger-to-the-other-modules) |

### Reading and writing

```ts
products.set('p1', { id: 'p1', price: 10 });
products.set('p2', null); // cache "p2 does not exist"
products.set('p3', { id: 'p3', price: 5 }, 1_000); // TTL for this entry only

products.get('p1'); // { id: 'p1', price: 10 }
products.get('p2'); // null      -> known not to exist
products.get('p4'); // undefined -> not cached

products.bulkSet([['p5', { id: 'p5', price: 7 }], ['p6', null]]); // several `set` at once (also takes a Map)
```

- `get` reads the memory of this instance only; `getOrSet` also reads the shared level.
- `get(key, true)` also removes the entry if it has expired. By default expired entries are kept as a fallback (see [Handling errors](#handling-errors)).
- `getComprehensive(key)` tells expired entries apart from missing ones: `{ type: 'hit' | 'expired', value, expirationTime }` or `{ type: 'miss' }`.

### `getOrSet`: read through the cache

`getOrSet` is the method you will use most. It returns the cached value when there is one; otherwise it calls your function, caches the result and returns it.

```ts
const product = await products.getOrSet('p1', () => fetchProduct('p1'), {
  ttl: 10_000, // TTL of this entry (default: the cache TTL)
});
```

- **Concurrent calls are deduplicated.** If 100 requests ask for `p1` at the same time, `fetchProduct` runs once and all 100 receive the same result. The value is cached with the `ttl` of the call that started the fetch; the error options (below) apply to each call separately.
- **Fetches time out** after `flowControlTimeout` (5 s by default). The function receives an `AbortSignal` that is aborted on timeout. A value that arrives after the timeout is not cached.
- **A slow fetch never overwrites a newer value.** If the key is written (by `set`, `invalidate`, another fetch or a database notification) after the fetch started, the fetched value is returned but not cached.
- `skipCache: true` always calls the function and caches the new value.
- `timeout` sets the timeout of this call, instead of `flowControlTimeout`.
- `staleWhileRevalidate` overrides the cache's [stale window](#stale-values-cooldown-and-bounded-memory) for this call.
- `getOrSetDetailed` returns `{ value, status, refreshFailed }`, where `status` tells where the value comes from: `L1-HIT` (memory), `L2-HIT` (shared level), `STALE` or `MISS` (fetched now, or a fallback). `refreshFailed` is `true` when the last fetch of the key failed, so the value is a stale copy or a fallback.

#### Handling errors

By default, an error from the fetch function is thrown by `getOrSet`. You can return a fallback value instead:

```ts
// Keep serving the last known value (even if expired) while the source is down
const product = await products.getOrSet('p1', () => fetchProduct('p1'), {
  returnOldOnError: true,
  errorTtl: 5_000, // retry the source after 5 s, instead of after defaultErrorTtl
});

// Or compute a fallback value
const price = await products.getOrSet('p9', () => fetchProduct('p9'), {
  errorFn: ({ key, error }) => ({ id: key, price: 0 }),
});
```

When the fetch fails, for each caller:

1. If `errorFn` returns a value other than `undefined`, that value is used. `errorFn` is called whether or not `returnOldOnError` is set.
2. Otherwise, if `returnOldOnError` is `true` and the key was cached before (even if expired), the old value is used.
3. Otherwise, the error is thrown.

`errorFn` receives `{ key, error, options }`, where `options` are the options of the call. Put anything else it needs in the `data` option: the cache does not read it.

The fallback value is cached for `errorTtl`, or for `defaultErrorTtl` when `errorTtl` is not set, in this instance only (not in the shared level). The error is also sent to the logger, once per fetch.

Expired entries stay in memory until `purgeExpired()` or `autoCleanupInterval` removes them, so that `returnOldOnError` can still use them. `get(key)` returns `undefined` for them.

### Stale values, cooldown and bounded memory

```ts
const products = new LilypadCache<string, Product>(30_000, {
  staleWhileRevalidate: 5 * 60_000, // serve up to 5 minutes stale while refreshing (default: 0)
  failureCooldown: 30_000, // after a failed fetch, do not retry the source for 30 s (default: 0)
  maxEntries: 10_000, // remove the least recently used entries beyond this (default: no limit)
  // platform, // runs the refreshes after the response (see docs/nextjs-vercel.md)
});
```

- **`staleWhileRevalidate`**: `getOrSet` returns an expired value at once if it expired less than this long ago, and refreshes it in the background (one refresh per key). An entry removed with `invalidate()` is never served stale. `purgeExpired()` keeps entries while they are within this window.
- **`failureCooldown`**: during a source outage, requests do not all retry it. Within the cooldown, `getOrSet` uses a stale value, `errorFn` or `returnOldOnError`, or throws `LilypadCacheCooldownError` (exported, so you can test for it with `instanceof`). With a shared level, the cooldown is shared by every instance.
- **`maxEntries`**: when a write goes beyond the limit, the least recently read or written entries are removed first. Protected keys are never removed this way.

### A level shared by every instance

When the application runs on several instances (serverless functions, several servers), each one has its own memory. A **shared level** lets an instance find the values fetched by the others:

```ts
const products = new LilypadCache<string, Product>(30_000, {
  name: 'products', // required: prefixes the keys in the shared store
  shared: {
    store: sharedStore, // { get, set, delete }, e.g. the Vercel Runtime Cache; or `platform.shared`
    codec: productCodec, // optional: converts values to JSON and validates them on the way back
    timeout: 300, // a slower store counts as missing (default: 300 ms)
    refreshLockTtl: 60_000, // optional: one instance at a time refreshes a stale key
  },
});
```

- `store` defaults to `platform.shared`. The constructor throws when there is no store, or no `name`.
- `getOrSet` looks in memory, then in the shared level, then fetches. The age of a shared value is measured from when it was fetched.
- `set`, `bulkSet`, `delete` and `invalidate` also write to or remove from the shared level, and so do the fetches of `getOrSet`. `clear`, `dispose`, `bulkSync` and the fallback values after an error act on the instance only.
- The shared level is never required: a failure or a timeout counts as a missing entry, and is logged as a warning.
- **`codec`**: without it, values are stored as they are, which suits JSON-compatible values only (a `Date` comes back as a string). `encode(value)` converts a value for the store; `decode(raw)` converts it back, and returns `null` to reject an entry that does not have the expected shape.
- **`refreshLockTtl`**: while an instance refreshes a stale key, it holds a lock in the store for this long, and the other instances do not refresh that key. Set it to the longest duration of a fetch. It is a soft lock: rarely, two instances still refresh together.
- The keys in the store are `lilypad:<name>:<key>`, plus `:failedAt` (for `failureCooldown`) and `:lock` (for `refreshLockTtl`).

### Loading everything at once (`bulkSync`)

When the source can return all values in one call, pass a `bulkSyncFn` and read with `bulkAsyncGet`:

```ts
const products = new LilypadCache<string, Product>(30_000, {
  bulkSyncFn: async () => (await fetchAllProducts()).map((p) => [p.id, p] as [string, Product]),
  defaultBulkSyncTtl: 60_000, // how long a full load stays valid (default: the cache TTL)
});

const all = await products.bulkAsyncGet(); // Map<string, Product | null>
const some = await products.bulkAsyncGet({ keys: ['p1', 'p2'] });
const cachedOnly = products.bulkGet({}); // synchronous, no reload
```

- A load replaces the whole content of the cache. Protected keys (see below) are kept, but marked as expired. Values written while the load was running are kept, since they are newer than its data.
- A load happens again only after `defaultBulkSyncTtl`, or after `invalidate()` (also when `invalidate()` is called while a load is running).
- `bulkSync()` resolves to `true` when the cache is synced, `false` when the load failed or `bulkSyncFn` returned no data. A failed load is logged and **not thrown**, unless you call `bulkSync(syncFn, { throwOnError: true })`: the cache keeps its current content, and the next call tries again. A load that times out (`bulkSyncTimeout`) writes nothing.
- `bulkSyncFn` receives an `AbortSignal`, aborted on timeout.
- `bulkSync(syncFn)` and `bulkAsyncGet({ syncFn })` use `syncFn` for this load instead of `bulkSyncFn`.
- Pass `{ doSync: false }` to `bulkAsyncGet` to read without reloading.
- Loads fill the memory of this instance only, not the shared level.

### Removing and protecting entries

```ts
products.invalidate('p1'); // mark as expired (the old value stays available as a fallback)
products.delete('p1'); // remove the entry
products.delete('p1', { setNull: true }); // cache "p1 does not exist" instead
products.clear(); // remove every entry
products.purgeExpired(); // remove expired entries only

products.addProtectedKeys(['config']);
products.delete('config'); // returns false: protected keys are kept
products.delete('config', { force: true }); // removes it
products.removeProtectedKeys(['config']);
```

- `invalidate(key)` also forces the next `bulkSync` to reload. Pass `{ invalidateBulkSync: false }` to prevent that. It sends a `manual` event to `platform.onInvalidate`.
- `clear` and `purgeExpired` take the same `{ force }` option as `delete`: without it, protected keys are kept. `clear({ setNull: true })` caches every key as `null` instead of removing it.
- `addProtectedKeys` and `removeProtectedKeys` return the cache, so calls can be chained.

Call `dispose()` when you no longer need the cache: it stops the cleanup timer and empties the cache. A disposed cache ignores later writes, including the results of fetches still running.

Keys are compared by their string form, so `get(1)` and `get('1')` read the same entry. `bulkGet({})` returns each key with the type it was stored with.

## LilypadDbGate

A PostgreSQL gateway: typed CRUD helpers for simple tables, the full postgres.js client for everything else, and `LISTEN/NOTIFY`.

```ts
import { LilypadDbGate } from '@lilypad/libs';

const gate = await LilypadDbGate.create({
  connectionString: process.env.DATABASE_URL!,
  // Optional: a different connection for LISTEN, for example a direct connection
  // when connectionString goes through PgBouncer in transaction mode
  listenerConnectionString: process.env.DATABASE_DIRECT_URL,
  listen: [], // optional: channels to subscribe to at startup (see below)
  statementTimeout: 10_000, // optional: Postgres cancels queries longer than 10 s
  pool: { max: 10, idleTimeout: 30_000 }, // optional: pool size and timeouts, in ms
  // logger,
  // singleton: true, singletonIdentifier: 'main-db',
});

// ...
await gate.close(); // closes both connections
```

- The gate connects on the first query: creating it opens no connection, unless `listen` subscribes to channels. If a `listen` subscription fails, `create()` closes the gate and rejects.
- `pool` configures the query pool. Every duration is in milliseconds, and an option you leave out keeps the postgres.js default:

  | Option | postgres.js default | What it does |
  | --- | --- | --- |
  | `max` | 10 | Maximum number of connections |
  | `idleTimeout` | never | Closes connections idle for this long |
  | `connectTimeout` | 30 s | Fails a connection attempt after this long |
  | `maxLifetime` | 30 to 60 min | Closes connections older than this |

- On serverless platforms, use `pool: lilypadServerlessPool` (`{ max: 3, idleTimeout: 5_000, connectTimeout: 10_000 }`: few connections per instance, closed quickly when idle) with a pooled connection string. Adjust `max` to the number of queries one instance runs in parallel: `pool: { ...lilypadServerlessPool, max: 5 }`.
- `statementTimeout` applies to the query pool only, not to the `LISTEN` connection.

### Describing a table

The CRUD helpers take a `LilypadDbSchema<T, PK>`, which describes the table and the TypeScript type of its rows. Declaring the primary key column `PK` makes it optional in inserts and allows partial updates:

```ts
import type { LilypadDbSchema } from '@lilypad/libs';

type Post = { id: number; title: string; body: string; published_at: Date | null };

const postsSchema: LilypadDbSchema<Post, 'id'> = {
  tableName: 'posts',
  primaryKey: 'id',
  primaryKeyShouldAutoDetermine: true, // the database generates the id (serial / identity / default)
  cols: {
    id: { type: 'number' },
    title: { type: 'string' },
    body: { type: 'string' },
    published_at: { type: 'date', nullable: true, default: null },
  },
  // Optional: applied to the data before every insert and update. Its result replaces the
  // data, so a property it leaves out is not written.
  insertSanitizationFn: (data) => ({ ...data, title: data.title?.trim() }),
};
```

- `cols` must list **every property of `T`**. Only these columns are read and written: any other property of the data you pass is ignored. So you can pass a request body directly without the risk of writing columns such as `is_admin`. Properties set to `undefined` are not written either.
- The column metadata only documents the table. The gate does not validate or convert values; postgres.js converts them.
  - `type` is one of `'string'`, `'number'`, `'boolean'`, `'date'`, `'json'` and `'array'`.
  - `nullable: true` requires a `default` (the database default of the column, often `null`).
- With `primaryKeyShouldAutoDetermine: true`, inserts leave out the primary key, and the database generates it. Without this option, inserts require the primary key.
- `selectSanitizationFn(row)` (optional) builds `T` from a database row. It receives the whole row (`SELECT *`), and it can return `null` to leave the row out of the results:

  ```ts
  const safePostsSchema: LilypadDbSchema<Post, 'id'> = {
    ...postsSchema,
    selectSanitizationFn: (row) => {
      const r = row as Record<string, unknown>;
      if (typeof r.title !== 'string') return null; // skip malformed rows
      return {
        id: Number(r.id),
        title: r.title,
        body: String(r.body ?? ''),
        published_at: r.published_at instanceof Date ? r.published_at : null,
      };
    },
  };
  ```

### CRUD helpers

```ts
// INSERT ... RETURNING *: returns the row with the generated id
const post = await gate.insertToTable(postsSchema, {
  title: 'Hello',
  body: '...',
  published_at: null,
}); // no `id`: the database generates it

const all = await gate.selectAllFromTable(postsSchema); // Post[], read in batches of 1 000 rows
const one = await gate.selectFromTableByPrimaryKey(postsSchema, 1); // Post | null

// UPDATE ... WHERE id = 1: only the given columns are written; throws if no such row exists
const updated = await gate.updateToTable(postsSchema, { id: 1, title: 'Updated' });

await gate.deleteFromTable(postsSchema, 1); // does nothing if the row does not exist
```

- `insertToTable` and `updateToTable` return the row as stored by the database (`RETURNING *`), including generated columns. They return `null` if `selectSanitizationFn` rejects that row.
- An insert or update throws before querying if the primary key is missing (always required by updates; by inserts unless `primaryKeyShouldAutoDetermine`), or if no column is left to write.
- With `primaryKeyShouldAutoDetermine`, updates never write the primary key column: it only identifies the row.

### Custom queries

For anything the helpers do not cover (joins, filters, transactions), use the postgres.js client in `gate.sql`. Values in the template are sent as parameters, so they are safe from SQL injection:

```ts
const recent = await gate.sql<Post[]>`
  SELECT * FROM posts
  WHERE published_at > ${since}
  ORDER BY published_at DESC
  LIMIT ${limit}
`;

await gate.sql.begin(async (tx) => {
  await tx`UPDATE accounts SET balance = balance - ${amount} WHERE id = ${from}`;
  await tx`UPDATE accounts SET balance = balance + ${amount} WHERE id = ${to}`;
});
```

See the [postgres.js documentation](https://github.com/porsager/postgres) for the full API. The client is created with `prepare: false` (no prepared statements), so it also works behind poolers such as PgBouncer.

### Listening to notifications (`LISTEN/NOTIFY`)

```ts
const gate = await LilypadDbGate.create({
  connectionString: process.env.DATABASE_URL!,
  listen: [
    {
      channel: 'jobs',
      callbackId: 'job-runner',
      callback: async (payload) => {
        // payload is the NOTIFY string, for example '{"jobId": 12}'
        const { jobId } = JSON.parse(payload as string);
        await runJob(jobId);
      },
      // Optional: LISTEN is active again after a lost connection. Notifications sent while the
      // connection was down are lost, so resynchronize here.
      onReconnect: async () => {
        await runPendingJobs();
      },
    },
  ],
});

// Subscribe at runtime; the promise resolves once LISTEN is active
await gate.addListener({ channel: 'jobs', callbackId: 'metrics', callback: countJob });

// Unsubscribe; the channel is released when its last callback is removed
await gate.removeListener('jobs', 'metrics');
```

From SQL: `SELECT pg_notify('jobs', '{"jobId": 12}');` or `NOTIFY jobs, '...';`.

- A channel can have several callbacks. They are identified by `callbackId`: adding a callback with an id that already exists on that channel **replaces** the old callback.
- Callbacks can be async. Their errors are caught and logged, so a failing callback does not affect the others.
- The payload is the string sent by `NOTIFY` (postgres.js does not parse it).
- All subscriptions share one dedicated connection, separate from the query pool and never closed for idleness. It reconnects by itself; `onReconnect` tells you when that happened.
- `addListener` rejects if `LISTEN` fails; the callback is then not registered, and a later call tries again.
- `removeListener` resolves to `false` when no such callback was registered.

## LilypadDbCache

A `LilypadCache` for a single table. It reads rows through a `LilypadDbGate` and a `LilypadDbSchema`, writes through to the database, and can update itself from database notifications.

```ts
import { LilypadDbCache, type LilypadDbSchema } from '@lilypad/libs';

type Account = { id: number; email: string; plan: string };

const accountsSchema: LilypadDbSchema<Account, 'id'> = {
  tableName: 'accounts',
  primaryKey: 'id',
  primaryKeyShouldAutoDetermine: true,
  cols: { id: { type: 'number' }, email: { type: 'string' }, plan: { type: 'string' } },
};

const accounts = await LilypadDbCache.create<number, Account, 'id'>(
  5 * 60_000, // TTL
  {
    dbGate: { gate, schema: accountsSchema },
    // logger, singleton, and every LilypadCache option (autoCleanupInterval, ...) are accepted
  }
);
```

The type arguments are the key type (the type of the primary key), the row type and the primary key column. `get(7)` and `get('7')` read the same entry. The cache's `name` (shared level keys, invalidation events) defaults to the table name.

### Reading

```ts
const account = await accounts.getOrFetch(7);
// Account   -> found (from the cache or from the database)
// null      -> no row with id 7 (this result is cached too)
// undefined -> the query failed; the error has been logged, nothing is thrown

const everyAccount = await accounts.getAll(); // loads the whole table, then serves it from the cache
const someAccounts = await accounts.getAll([1, 2]);
```

`getOrFetch(key, options)` accepts the options of [`getOrSet`](#getorset-read-through-the-cache) (`ttl`, `staleWhileRevalidate`, `timeout`, ...), and [`getOrSetDetailed`](#getorset-read-through-the-cache) works too. `get()` reads memory only: a cache miss is fetched from the database by `getOrFetch`, not by `get`. `getAll` loads the table again when `defaultBulkSyncTtl` has passed, after an `invalidate()` that failed, or after a notification about a row the cache does not hold. `getAll` rejects when the table cannot be loaded.

### Writing through the cache

These methods write to the database first, then cache the row that the database returns:

```ts
const created = await accounts.sqlCreate({ email: 'ada@example.com', plan: 'free' });
// created.id is the id generated by the database

await accounts.sqlUpdate({ id: created!.id, plan: 'pro' }); // throws if the row does not exist
await accounts.sqlDelete(created!.id); // the key is then cached as null, even if protected
```

`sqlCreate` and `sqlUpdate` return `null` if the schema's `selectSanitizationFn` rejects the returned row. Each write sends a `write` event to `platform.onInvalidate`.

To reload a key from the database:

```ts
await accounts.update(7); // query, cache and return the row (null if it does not exist); throws on database errors
await accounts.invalidate(7); // same, but a failure is logged and the entry marked expired
```

Unlike in `LilypadCache`, `invalidate` is async here, so `await` it. It accepts the same `{ invalidateBulkSync }` option, which only applies when the query fails.

### Keeping the cache in sync with the database

If other instances or other programs (a script, an admin tool, a manual `UPDATE`) change the table, the cache would keep serving old rows until they expire. The `sync` option chooses how the cache learns about those changes:

| Strategy | How | Delay | Suited to |
| --- | --- | --- | --- |
| `{ strategy: 'changelog', pollInterval }` | A trigger records every change in a table; the cache reads the new rows at most once per `pollInterval`, when it is used | ≤ `pollInterval` | Serverless platforms, and any number of instances |
| `{ strategy: 'listen' }` (default) | `LISTEN/NOTIFY` on a dedicated connection | Near real time | Long-running servers |
| `{ strategy: 'none' }` | Only the writes of this instance, and the TTL | ≤ TTL | Data no one else changes |

Both `changelog` and `listen` rely on a trigger. The library provides its SQL; run it once, in a migration:

```ts
import { lilypadChangelogSql, lilypadChangelogTriggerSql } from '@lilypad/libs/db';

await sql.unsafe(lilypadChangelogSql()); // the changelog table and the trigger function
await sql.unsafe(lilypadChangelogTriggerSql({ table: 'accounts', primaryKey: 'id' })); // per table
```

The trigger records each change in the `lilypad_cache_changes` table and also sends a notification on the `cache_events` channel, so it serves both strategies. It records the schema of the table too, so tables of the same name in different schemas are not mixed up. It needs PostgreSQL 13 or later. Both functions return SQL that can safely be run again (`IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP TRIGGER IF EXISTS`).

- `lilypadChangelogSql({ table, notifyChannel })`: `table` renames the changelog table (default: `LILYPAD_DEFAULT_CHANGELOG_TABLE`, that is `lilypad_cache_changes`). `notifyChannel: false` sends no notification, for the `changelog` strategy alone. The `listen` strategy of `LilypadDbCache` always listens on `cache_events`, so keep that name if you use it.
- `lilypadChangelogTriggerSql({ table, primaryKey, changelogTable })`: `table` and `primaryKey` are those of the cached table; pass `changelogTable` if you renamed it.
- An `UPDATE` that changes the primary key is recorded as a `DELETE` of the old key followed by an `UPDATE` of the new one.
- Delete the old changelog rows periodically with `pruneLilypadChangelog(gate, { olderThan, changelogTable })`, which resolves to the number of deleted rows. `olderThan` (ms) must be much longer than `maxGap` and `lookback` (see [the changelog section of the Next.js guide](docs/nextjs-vercel.md#deleting-old-changelog-rows)).
- `readLilypadChanges(gate, { tableName, since, changelogTable })` is the low-level read the cache uses, if you want to consume the changelog yourself. It resolves to `{ changes, cursor }`; pass `since: { cursor }` on the next call (or `since: { lookback }` the first time). The same change can be returned by several reads, so skip the `id`s you have already processed.

```ts
const accounts = await LilypadDbCache.create<number, Account, 'id'>(60_000, {
  dbGate: { gate, schema: accountsSchema },
  sync: { strategy: 'changelog', pollInterval: 5_000 },
});
```

When the cache learns about a change of its table:

- on `INSERT` and `UPDATE`, it re-fetches (`listen`) or expires (`changelog`) the key if it holds it (or is fetching it). For other keys it sends no query: the next `getAll` reloads the table instead;
- on `DELETE`, it caches the key as `null`, also for protected keys;
- if it may have missed changes (the `LISTEN` connection was lost, or the changelog was not read for longer than `maxGap`), it marks every entry as expired.

Rows are stored in the order the changes happened: a slow query can never overwrite the result of a newer one.

The options of the `changelog` strategy:

| Option | Default | What it does |
| --- | --- | --- |
| `pollInterval` | required | Minimum time (ms) between two reads of the changelog. The cache reads it before a `getOrFetch` or `getAll` once this has passed, so changes are seen within it |
| `poll` | `'await'` | `'await'`: a read that falls due waits for the changelog. `'background'`: it does not wait, and may return data one interval older |
| `maxGap` | 1 hour | If the changelog has not been read for this long, the instance no longer trusts its memory and expires every entry |
| `lookback` | TTL + `staleWhileRevalidate` + 1 min | On the first read, or after `maxGap`, the changes of this period are applied, which also removes older copies from the shared level |
| `table` | `lilypad_cache_changes` | The changelog table, if you renamed it |
| `verify` | `'warn'` | Checks that the changelog and the trigger are installed: see [Checking the database setup](#checking-the-database-setup) |

A failed read of the changelog is logged, and the read of the cache goes on with its current content. The [Next.js guide](docs/nextjs-vercel.md#5-database-caches-keeping-every-instance-up-to-date) explains how to choose these values.

#### Checking the database setup

The library does not create the changelog or the triggers itself: without them, the cache would silently stay stale (`listen`) or fail each read of the changelog (`changelog`). So the `listen` and `changelog` strategies check them once, with their `verify` option:

| `verify` | When | If something is missing |
| --- | --- | --- |
| `'warn'` (default) | Once, when the cache first uses the database: before `LISTEN`, or with the first read of the changelog (which does not wait for it) | A warning on the logger (on `console.warn` without a logger), with the SQL that fixes it |
| `'throw'` | In `create`, which then queries the database whatever the strategy | `create` rejects with a `LilypadSchemaCheckError`, whose `problems` list what is missing |
| `'off'` | Never | |

With `changelog`, the check looks for the changelog table, its trigger function (installed by this version of the library) and the changelog trigger on the table, recording its primary key. With `listen`, it looks for a trigger of the table whose function calls `pg_notify('cache_events', ...)`: yours or the library's. If you send notifications another way, set `verify: 'off'`.

The check also finds the schema of the table, so that with `listen` the cache ignores the notifications of a table of the same name in another schema. With `verify: 'off'`, it can do so only if `tableName` is qualified (`'app.accounts'`).

You can run the same check yourself, for example in a deployment script or a health check. It only reads the catalogs:

```ts
import { checkLilypadSchema } from '@lilypad/libs/db';

const { ok, problems, tables } = await checkLilypadSchema(gate, {
  tables: [{ table: 'accounts', primaryKey: 'id' }],
  changelog: {}, // the default; `{ table }` if you renamed it, `false` to skip
  notifyChannel: 'cache_events', // also check the notifications (default: false)
});
for (const { code, table, message, fix } of problems) {
  console.log(code, table, message); // e.g. 'missing-changelog-trigger' 'accounts' ...
  if (fix) console.log(fix); // the SQL to run in a migration
}
```

`tables` gives the schema each table resolves to (`null` if it does not exist). The codes are `unsupported-version`, `missing-table`, `missing-changelog`, `outdated-changelog` (installed by an older version of the library: run `lilypadChangelogSql()` again), `missing-changelog-trigger` (missing, disabled or not on every `INSERT`, `UPDATE` and `DELETE`), `wrong-trigger-primary-key` and `missing-notify-trigger`.

#### Custom notification triggers and callbacks

With `listen`, the cache expects JSON payloads on `cache_events` shaped like `{ "schema": "public", "table": "accounts", "id": 7, "op": "INSERT" | "UPDATE" | "DELETE" }`, where `id` is a number or a string: you can also send them from your own trigger. `schema` is optional: without it, the payload applies to a table of that name in any schema. To run your own code on each notification:

```ts
const accounts = await LilypadDbCache.create<number, Account, 'id'>(60_000, {
  dbGate: { gate, schema: accountsSchema },
  sync: {
    strategy: 'listen',
    connect: 'lazy', // start LISTEN on the first read instead of in create()
    listenerOptions: {
      // true: update the cache first, then call `callback`.
      // false (the default when a callback is given): only call `callback`, which is then
      // responsible for updating the cache.
      automaticallyInvalidateDataBeforeCallback: true,
      callback: async ({ op, id }) => {
        await broadcastToClients({ type: 'account-changed', op, id });
      },
    },
  },
});
```

With any strategy, `platform.onInvalidate` receives an event for every change (`write`, `changelog`, `notification` or `manual`), for example to revalidate other caches.

The former options `useDefaultDbListener` and `defaultListenerOptions` still work, but are deprecated in favour of `sync`.

Always call `await accounts.dispose()` when you are done with a cache. It removes the cache's notification subscription, which otherwise keeps running on the gate.

## LilypadFlowControl

Wraps an async function with a timeout, retries, rate limiting and single-flight deduplication. `LilypadCache` uses it internally, and you can use it on its own:

```ts
import { LilypadFlowControl } from '@lilypad/libs';

const payments = new LilypadFlowControl<{ ok: boolean }>({
  timeout: 3_000, // abort each attempt after 3 s (default: no timeout)
  retries: 2, // retry twice after the first failure (default: 0)
  rate: 1_000, // at most one new execution per second per consumer/function pair (default: no limit)
  // logger,
});

const result = await payments.executeFn({
  functionIdentifier: 'charge:user-42', // concurrent calls with the same id share one execution
  consumerIdentifier: 'user-42', // used by the rate limit
  fn: (signal) => callPaymentApi('user-42', signal), // pass the signal on so a timeout cancels the work
  backOffTime: (attempt) => attempt * 500, // wait before retries (default: 200, 400, 800 ms...)
  errorFn: (error) => ({ ok: false }), // after the last retry: return a fallback, or throw
});
```

- **Single flight:** while an execution with a given `functionIdentifier` is running, other calls with the same identifier receive its promise. They do not start a new execution and are not rate limited, and their own options (`fn`, `errorFn`, `timeout`, ...) are ignored: they share the result of the first call, including what its `errorFn` returned.
- **Per-call options:** `retries` and `timeout` in the options of `executeFn` override those of the instance for that execution.
- **Timeout:** a timed out attempt fails with `Operation timed out`. Each attempt gets its own timeout, so with retries the whole execution can last `(retries + 1) × timeout` plus the backoff times. Each attempt gets an `AbortSignal` that is aborted when the timeout expires. JavaScript cannot stop a running promise, so pass the signal to `fetch`, to the database driver, and so on, or check `signal.aborted` yourself.
- **Rate limit:** a new execution started less than `rate` ms after the previous one for the same consumer/function pair throws `Rate limit exceeded for ...`. The call is rejected, not delayed.
- `errorFn` is called once, after the last retry. Its return value becomes the result; to propagate the error instead, throw from `errorFn`.

The individual steps are also available: `executeWithTimeout(fn, timeout?)`, `executeWithRetries({ executionFn, retries, backOffTime, errorFn })`, `rateLimit(consumerId, functionId)` (synchronous: it throws when the limit is exceeded) and `isInFlight(functionId)`.

## LilypadSerializer

Maps objects of one shape (`FROM`) to another shape (`TO`) and back. It is useful for compact storage or transport formats, because values equal to their default are left out:

```ts
import { LilypadSerializer } from '@lilypad/libs';

type Settings = { theme: 'light' | 'dark'; volume: number; tags: string[] };
type StoredSettings = { t?: 'l' | 'd'; v?: number; g?: string };

const settingsSerializer = new LilypadSerializer<
  Settings,
  StoredSettings,
  { theme: 't'; volume: 'v'; tags: 'g' } // which FROM key goes to which TO key
>({
  serialization: {
    theme: {
      target: 't',
      serialize: (s) => (s.theme === 'dark' ? 'd' : 'l'),
      deserialize: (s) => (s.t === 'd' ? 'dark' : 'light'),
      default: 'light',
    },
    volume: {
      target: 'v',
      serialize: (s) => s.volume,
      deserialize: (s) => s.v ?? 50,
      default: 50,
    },
    tags: {
      target: 'g',
      serialize: (s) => s.tags.join(','),
      deserialize: (s) => (s.g ? s.g.split(',') : []),
      default: [],
      // Needed for objects and arrays: the default comparison is ===
      equality: (value, defaultValue) => value.length === defaultValue.length,
    },
  },
});

settingsSerializer.serialize([
  { theme: 'dark', volume: 50, tags: [] },
  { theme: 'light', volume: 80, tags: ['a', 'b'] },
]);
// [{ t: 'd' }, { v: 80, g: 'a,b' }]

settingsSerializer.deserialize([{ t: 'd' }]);
// [{ theme: 'dark', volume: 50, tags: [] }]
```

- The key mapping must be **one to one**: every `TO` key is used, and no two `FROM` keys go to the same `TO` key. Otherwise `target` is typed as `never`, and the code does not compile.
- `serialize` leaves out a key when its value equals `default` (using `equality`, or `===` when `equality` is not set), or when the `serialize` function returns `undefined`.
- `deserialize` uses a copy of `default` when the `deserialize` function returns `null` or `undefined`. Object and array defaults are cloned, so deserialized items never share them.

## Singletons

The registry used by the `create()` methods is exported, so you can use it for your own objects:

```ts
import {
  getLilypadSingletonInstance,
  getLilypadSingletonInstanceAsync,
  removeLilypadSingletonInstance,
} from '@lilypad/libs';

const flags = getLilypadSingletonInstance('feature-flags', () => new Map<string, boolean>());

const client = await getLilypadSingletonInstanceAsync('search-client', async () => {
  const c = new SearchClient(process.env.SEARCH_URL!);
  await c.connect();
  return c;
});

removeLilypadSingletonInstance('search-client'); // the next call builds a new instance; false if none was registered

// Optional third argument: warn when a later call asks for the same identifier with other options
const cache = getLilypadSingletonInstance('prices', () => new LilypadCache(ttl), {
  value: JSON.stringify([ttl]), // kept in a global map: hash it if it contains secrets
  onMismatch: () => console.warn('"prices" already exists with a different TTL'),
});
```

`getLilypadSingletonInstanceAsync` shares one creation between concurrent callers. If the creation fails, it is forgotten, so the next call tries again.

The registry is stored on `globalThis`, so it is shared by the whole process, including copies of the library loaded from different bundles. Use identifiers that are unique across your application. The `create()` methods prefix their identifiers with the class name (`LilypadDbGate:main-db`), so they never collide with yours. `getLilypadSingletonInstance` throws if the identifier is still being created by `getLilypadSingletonInstanceAsync`.

## Troubleshooting

For problems specific to serverless platforms (connections exhausted, lost logs, changes not seen), see the [troubleshooting section of the Next.js guide](docs/nextjs-vercel.md#10-troubleshooting).

**`LilypadDbCache` does not see changes made outside the application.**
Check that the trigger from [Keeping the cache in sync with the database](#keeping-the-cache-in-sync-with-the-database) is installed on the table, and that its `table` value matches `schema.tableName`. Check also that `sync` is not `{ strategy: 'none' }` (or the deprecated `useDefaultDbListener: false`). With the `changelog` strategy, changes appear only after `pollInterval`, and only when the cache is read. To test the setup, run `SELECT pg_notify('cache_events', '{"table":"accounts","id":"7","op":"UPDATE"}');` and pass a logger with a `debug` component: the cache logs every payload it receives.

**Notifications stop arriving behind PgBouncer.**
`LISTEN` does not work through a pooler in transaction mode. Set `listenerConnectionString` to a direct connection to Postgres.

**`getOrSet` throws `Operation timed out`.**
The fetch took longer than `flowControlTimeout` (5 s by default). Increase it in the cache options, or use `returnOldOnError` or `errorFn` to return a fallback value. For database fetches, set `statementTimeout` on the gate too, so that Postgres stops the slow queries instead of letting them pile up.

**`Rate limit exceeded for ...`.**
A `LilypadFlowControl` with `rate` rejects new executions that come too soon. Catch the error, or use a different `consumerIdentifier` for each caller.

**The process does not exit.**
Open database connections keep Node.js running. Call `dispose()` on every `LilypadDbCache`, then `close()` on the gate.

**My logger does not print anything from the library.**
The other modules log only through the logger you pass them, on the channels `error`, `warn`, `info` and `debug`. Check that you passed `logger` and that those channels have components.

**TypeScript: `Property 'info' does not exist on type 'LilypadLogger<...>'`.**
Type the variable as `LilypadLoggerType<...>`, not `LilypadLogger<...>`.

## Contributing

```bash
npm install
npm test -- --run         # unit tests
npm run test:integration  # needs Docker (starts a PostgreSQL container)
npm run typecheck
npm run lint              # eslint --fix, modifies files
npm run build
```

The pre-commit hook runs the unit tests, the typecheck, the lint check and the build, then stages `dist/`. See [CLAUDE.md](CLAUDE.md) for architecture notes.
