# @lilypad/libs

Server-side TypeScript utilities from Lilypad Studios:

| Module | What it gives you |
| --- | --- |
| [`LilypadLogger`](#logger) | A typed logger with named channels (`logger.info(...)`, `logger.error(...)`) and pluggable outputs (console, Discord, your own). |
| [`LilypadCache`](#lilypadcache) | A TTL cache that deduplicates concurrent fetches, serves stale values while refreshing them, falls back to the old value when a fetch fails, and can share its values between instances. |
| [`LilypadDbGate`](#lilypaddbgate) | A thin PostgreSQL gateway (built on [postgres.js](https://github.com/porsager/postgres)): typed CRUD helpers and `LISTEN/NOTIFY` subscriptions. |
| [`LilypadDbCache`](#lilypaddbcache) | A cache of the rows of one database table (on the same engine as `LilypadCache`), kept up to date by a changelog table or by Postgres notifications. |
| [`LilypadFlowControl`](#lilypadflowcontrol) | Timeouts, retries with backoff, rate limiting and single-flight deduplication for async calls. |
| [`LilypadSerializer`](#lilypadserializer) | Type-checked mapping between two object shapes (for example, compact storage keys) that leaves out default values. |
| [Singleton helpers](#singletons) | A process-wide registry that survives hot reloads and duplicate bundles. |

**Running on Next.js or Vercel?** Read [Using Lilypad on Next.js and Vercel](docs/nextjs-vercel.md): it shows how to connect the library to the platform, and the recommended options for each module.

**Want to know how it works inside?** Read [How @lilypad/libs works](docs/how-it-works.md): a top-down tour of the internals, from the general design down to single functions.

**Contents:** [Installation](#installation) · [Quick start](#quick-start) · [Conventions](#conventions-used-across-the-library) · [Next.js / Vercel](docs/nextjs-vercel.md) · [Logger](#logger) · [LilypadCache](#lilypadcache) · [LilypadDbGate](#lilypaddbgate) · [LilypadDbCache](#lilypaddbcache) · [LilypadFlowControl](#lilypadflowcontrol) · [LilypadSerializer](#lilypadserializer) · [Singletons](#singletons) · [Troubleshooting](#troubleshooting) · [Contributing](#contributing)

## Installation

The built package (`dist/`) is committed to the repository, so you can install it straight from GitHub:

```bash
npm install github:Lilypad-Studio/LilypadLibs
```

Requirements:

- Node.js 22 or later.
- It is built as CommonJS and ESM, with type declarations.
- The database modules (`@lilypad/libs/db`) run on Node.js only, since they need TCP connections. The other modules also run in edge runtimes (see [Importing](#importing-the-whole-package-or-one-module)). None of them is meant for browsers.
- The database modules need PostgreSQL and the [`postgres`](https://github.com/porsager/postgres) driver, an optional peer dependency: install it next to the library (`npm install postgres`) if you use `@lilypad/libs/db`. The other modules do not need it.

## Quick start

This example loads a `users` table into a cache and reads rows through it:

```ts
import { LilypadLogger, LilypadConsoleLogger } from '@lilypad/libs/logger';
import { LilypadDbGate, LilypadDbCache, type LilypadDbSchema } from '@lilypad/libs/db';

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

// 1. A logger with the four channels the other modules log on (the default channels)
const logger = LilypadLogger.create({
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
// The row type and the key type are inferred from the schema
const users = await LilypadDbCache.create({
  ttl: 60_000,
  gate,
  schema: usersSchema,
  logger,
});

const user = await users.getOrFetch('42'); // rejects if the query fails
if (user === null) {
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

Each module is available on its own. `@lilypad/libs` exports every module **except `/db`**, so that importing it never pulls in `postgres` and it also runs in edge runtimes:

| Import | Contents | Edge runtime |
| --- | --- | --- |
| `@lilypad/libs/logger` | `LilypadLogger` and the components | Yes |
| `@lilypad/libs/cache` | `LilypadCache` | Yes |
| `@lilypad/libs/flow` | `LilypadFlowControl` | Yes |
| `@lilypad/libs/serializer` | `LilypadSerializer` | Yes |
| `@lilypad/libs/singleton` | The singleton registry | Yes |
| `@lilypad/libs/platform` | The platform types (`LilypadPlatform`, ...) | Yes |
| `@lilypad/libs/db` | `LilypadDbGate`, `LilypadDbCache`, the changelog helpers | No |

Import the database modules from `@lilypad/libs/db`. For the others, importing the module you use keeps bundles smaller. Code that runs in an edge runtime (for example Next.js middleware) must not import `/db`.

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
| `LilypadDbCache` | `await LilypadDbCache.create(options)` |
| `LilypadCache` | `new LilypadCache(options)` |
| `LilypadFlowControl`, `LilypadSerializer`, logger components | `new ...` |

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

`LilypadCache`, `LilypadDbCache`, `LilypadDbGate` and `LilypadFlowControl` accept an optional `logger`: any object with some of the methods `error`, `warn`, `info` and `debug` (the type `LilypadLibLogger`). A `LilypadLogger` works, and so do `console` or pino. The levels the logger lacks are skipped, and a logger that throws or rejects never breaks the module. Without a logger, these modules log nothing. That includes errors they handle themselves, such as a failed `bulkSync` or a failed notification callback.

The first argument of their messages is the name of the instance (for a `LilypadDbCache`, its table).

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
  // Optional: called for each component that fails (for example, Discord is unreachable). It may
  // be async. Without it, or if it fails too, the failure is printed with console.error.
  errorLogging: (error) => {
    process.stderr.write(`Logger failure: ${String(error)}\n`);
  },
});

void logger.info('Invoice created', { id: 'inv_1', total: 42 });
void logger.error('Payment failed', new Error('card declined'));
// 2026-09-24T10:00:00.000Z - [billing] [INFO]: Invoice created { id: 'inv_1', total: 42 }
```

- A channel method takes any number of arguments. Strings are printed as they are. Other values are formatted in a style close to `util.inspect`: an `Error` keeps its message, stack trace, own properties (such as the `code` and `detail` of a database error) and `cause`. Formatting never throws: circular objects, BigInts and getters that throw are printed too.
- Channel methods never reject: each failing component is reported to `errorLogging`, and a failure of `errorLogging` itself is printed with `console.error`. A failing component does not stop the others. Call them with `void` ("fire and forget"), or `await` them if the message must be sent before you continue, for example just before `process.exit`.
- A channel name cannot be the name of a logger property (`components`, `register`, `flush`, `constructor`, `toString`, and so on) or `then`. `create()` throws if it is.
- Without a type argument, the channels are `'error' | 'warn' | 'info' | 'debug'`, the ones the other modules log on.

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

// LilypadLibLogger: any object with some of the methods error, warn, info and debug
class OrderService {
  constructor(private readonly logger?: LilypadLibLogger) {}

  run() {
    void this.logger?.info?.('running');
  }
}
```

### Adding components later

`register()` adds components to channels that already exist. It cannot create new channels: it throws for a channel that was not given to `create()`. It returns the logger, so calls can be chained.

```ts
logger.register({ debug: [new LilypadConsoleLogger()] });
```

### Writing your own component

Extend `LilypadLoggerComponent` and implement `write(record)`. The record holds `type` (the channel), `message` (the parts formatted and joined), `parts` (as they were logged), `timestamp`, `loggerName` and `context`. `this.formatRecord(record)` formats it as `<ISO timestamp> - [name] [CHANNEL]: <message> <context as JSON>`.

```ts
import { LilypadLoggerComponent, type LilypadLogRecord } from '@lilypad/libs';
import { appendFile } from 'node:fs/promises';

class FileLogger<T extends string> extends LilypadLoggerComponent<T> {
  constructor(private readonly path: string) {
    super();
  }

  // `record.type` is the channel name, if you want to route messages by severity
  async write(record: LilypadLogRecord<T>): Promise<void> {
    await appendFile(this.path, this.formatRecord(record) + '\n');
  }
}

logger.register({ error: [new FileLogger('errors.log')] });
```

If `write()` throws or rejects, the logger passes the error to `errorLogging`.

### Redacted keys

The values of some keys are replaced with `[Redacted]` in the messages and in the context, at any depth: by default `LILYPAD_DEFAULT_REDACTED_KEYS` (authorization headers, cookies, passwords, secrets, tokens, API keys). This keeps, for example, the `Authorization` header of the request attached to an HTTP client error out of the logs, and out of Discord. Keys are compared ignoring case, `-` and `_` (`apiKey` matches `api_key`).

```ts
import { LILYPAD_DEFAULT_REDACTED_KEYS, LilypadLogger } from '@lilypad/libs';

LilypadLogger.create({ components, redact: [...LILYPAD_DEFAULT_REDACTED_KEYS, 'ssn'] }); // extend
LilypadLogger.create({ components, redact: false }); // redact nothing
```

The raw `parts` of a record are not redacted: a custom component that prints them must redact them itself.

### Built-in components

- **`LilypadConsoleLogger`**: channels named `error` go to `console.error`, channels named `warn` go to `console.warn` (case-insensitive), and every other channel goes to `console.log`.
- **`LilypadJsonConsoleLogger`**: the same routing, but each message is one JSON object (`time`, `level`, `logger`, `msg`, the context fields, and `errors` with name, message and stack). Log platforms can filter on these fields.
- **`LilypadDiscordLogger(webhookUrl, options?)`**: posts messages to a Discord webhook.
  - Requests are throttled: at most one every `minRequestInterval` ms (default: 1 000). Messages logged in between are sent together in one Discord message, up to 2000 characters.
  - A request rate limited by Discord (429) is retried after the `retry-after` time (1 s if Discord gives none), `rateLimitRetries` times (default: 1).
  - A `retry-after` longer than 30 seconds (e.g. a global rate limit) is not waited for: the request fails at once.
  - When a request fails (error status, timeout, rate limit after the retries), the logger's `errorLogging` receives one error for the batch, with the number of messages lost.
  - Messages longer than 2000 characters are cut.
  - At most `maxQueueSize` messages (default: 100) wait to be sent. During a flood of messages the oldest are dropped, and the next Discord message says how many.
  - Mentions are disabled, so `@everyone` notifies no one.
  - Each request times out after 5 seconds.
  - Everything you log is visible to the members of the Discord channel, so do not log secrets or personal data on these channels.
  - Keep the webhook URL in an environment variable, not in the code.

## LilypadCache

An in-memory cache with string or number keys and a time to live (TTL) for each entry.

```ts
import { LilypadCache } from '@lilypad/libs';

type Product = { id: string; price: number };

const products = new LilypadCache<string, Product>({
  ttl: 30_000, // default TTL in ms (default: 60 000)
  autoCleanupInterval: 60_000, // remove expired entries every minute, with a timer (default: never)
  // cleanupOnAccessEvery: 60_000, // the same without a timer, for serverless platforms
  errorTtl: 30_000, // TTL of fallback values after an error (default: the TTL, at most 5 min)
  fetchTimeout: 5_000, // timeout of getOrSet fetches (default: 5 s)
  // logger,
});
```

Every constructor option, in one place (the sections below explain them):

| Option | Default | What it does |
| --- | --- | --- |
| `ttl` | 60 s | Time to live of the entries. It must be a positive finite number |
| `autoCleanupInterval` | never | Removes expired entries with a timer (which does not keep Node.js running) |
| `cleanupOnAccessEvery` | never | Removes expired entries during reads and writes, at most once per interval. It needs no timer, so it suits instances suspended between requests |
| `errorTtl` | the TTL, at most 5 min | TTL of a fallback value cached after a failed fetch |
| `fetchTimeout` | 5 s | Timeout of the fetches of `getOrSet` |
| `staleWhileRevalidate` | 0 (off) | [Stale values](#stale-values-cooldown-and-bounded-memory) |
| `failureCooldown` | 0 (off) | [Cooldown after a failed fetch](#stale-values-cooldown-and-bounded-memory) |
| `maxEntries` | no limit | [Bounded memory](#stale-values-cooldown-and-bounded-memory) |
| `name` | a random id | Names the cache in shared level keys and invalidation events. Required with `shared` |
| `shared` | none | [A level shared by every instance](#a-level-shared-by-every-instance) |
| `platform` | none | [Platform capabilities](#platform-capabilities) |
| `tagPrefix` | `'lilypad'` | Prefix of the tags of the invalidation events (`<tagPrefix>:<name>:<key>`, name and key URI-encoded) |
| `bulkSync: { fn, ttl, timeout }` | none, the TTL, 30 s | [Loading everything at once](#loading-everything-at-once-bulksync) |
| `logger` | none | See [Passing a logger](#passing-a-logger-to-the-other-modules) |

Durations and sizes are checked by the constructor: a value that is not a finite number, a negative one, or a `maxEntries` that is not a positive integer throws.

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
- `get(key, { removeExpired: true })` also removes the entry if it has expired. By default expired entries are kept as a fallback (see [Handling errors](#handling-errors)).
- `peek(key)` tells expired entries apart from missing ones, without side effects: `{ type: 'hit' | 'expired', value, expirationTime }` or `{ type: 'miss' }`.

### `getOrSet`: read through the cache

`getOrSet` is the method you will use most. It returns the cached value when there is one; otherwise it calls your function, caches the result and returns it.

```ts
const product = await products.getOrSet('p1', () => fetchProduct('p1'), {
  ttl: 10_000, // TTL of this entry (default: the cache TTL)
});
```

- **Concurrent calls are deduplicated.** If 100 requests ask for `p1` at the same time, `fetchProduct` runs once and all 100 receive the same result. The value is cached with the `ttl` of the call that started the fetch; the error options (below) apply to each call separately.
- **Fetches time out** after `fetchTimeout` (5 s by default). The function receives an `AbortSignal` that is aborted on timeout. A value that arrives after the timeout is not cached.
- **A slow fetch never overwrites a newer value.** If the key is written (by `set`, `invalidate`, another fetch or a database notification) after the fetch started, the fetched value is returned but not cached. This holds even for a key that was not cached yet, or whose entry was removed meanwhile (`delete`, `clear`, `purgeExpired`, `maxEntries`).
- `skipCache: true` always calls the function and caches the new value.
- `timeout` sets the timeout of this call, instead of `fetchTimeout`.
- `staleWhileRevalidate` overrides the cache's [stale window](#stale-values-cooldown-and-bounded-memory) for this call.
- `getOrSetDetailed` returns `{ value, status, refreshFailed }`, where `status` tells where the value comes from: `L1-HIT` (memory), `L2-HIT` (shared level), `STALE` or `MISS` (fetched now, or a fallback). `refreshFailed` is `true` when the last fetch of the key failed, so the value is a stale copy or a fallback, also while that fallback is cached.
- Every method of a disposed cache throws, except `dispose`.

#### Handling errors

By default, an error from the fetch function is thrown by `getOrSet`. With `onError`, you can return a fallback value instead:

```ts
// Keep serving the last known value (even if expired) while the source is down
const product = await products.getOrSet('p1', () => fetchProduct('p1'), {
  onError: { fallback: 'stale', ttl: 5_000 }, // retry the source after 5 s, instead of after errorTtl
});

// Or compute a fallback value; `stale` is the last known value, if any
const price = await products.getOrSet('p9', () => fetchProduct('p9'), {
  onError: { fallback: ({ key, error, stale }) => stale?.value ?? { id: key, price: 0 } },
});
```

When the fetch fails, for each caller:

1. With `fallback: 'stale'`, the last value of the key is used, even if it expired or was invalidated.
2. With a fallback function, its result is used. It receives `{ key, error, stale }`, where `stale` is `{ value, fetchedAt }` when the cache still holds a value for the key. Return `undefined` to rethrow the error.
3. Without a fallback value, the error is thrown.

The fallback value is cached for `onError.ttl`, or for the cache's `errorTtl`, in this instance only (not in the shared level). The stale value keeps its original age: it is not treated as a newer value. The error is also sent to the logger, once per fetch. While the fallback is cached, `getOrSetDetailed` reports `refreshFailed: true`; with `failureCooldown`, the key is refreshed in the background once the cooldown is over, instead of waiting for the fallback to expire.

Expired entries stay in memory until `purgeExpired()` or `autoCleanupInterval` removes them, so that `fallback: 'stale'` can still use them. `get(key)` returns `undefined` for them.

### Stale values, cooldown and bounded memory

```ts
const products = new LilypadCache<string, Product>({
  ttl: 30_000,
  staleWhileRevalidate: 5 * 60_000, // serve up to 5 minutes stale while refreshing (default: 0)
  failureCooldown: 30_000, // after a failed fetch, do not retry the source for 30 s (default: 0)
  maxEntries: 10_000, // remove the least recently used entries beyond this (default: no limit)
  // platform, // runs the refreshes after the response (see docs/nextjs-vercel.md)
});
```

- **`staleWhileRevalidate`**: `getOrSet` returns an expired value at once if it expired less than this long ago, and refreshes it in the background (one refresh per key). An entry removed with `invalidate()` is never served stale. `purgeExpired()` keeps entries while they are within this window.
- **`failureCooldown`**: during a source outage, requests do not all retry it. Within the cooldown, `getOrSet` uses a stale value or the `onError` fallback, or throws `LilypadCacheCooldownError` (exported, so you can test for it with `instanceof`). With a shared level, the cooldown is shared by every instance.
- **`maxEntries`**: when a write goes beyond the limit, the least recently read or written entries are removed first. Protected keys are never removed this way.

### A level shared by every instance

When the application runs on several instances (serverless functions, several servers), each one has its own memory. A **shared level** lets an instance find the values fetched by the others:

```ts
const products = new LilypadCache<string, Product>({
  ttl: 30_000,
  name: 'products', // required: prefixes the keys in the shared store
  shared: {
    store: sharedStore, // { get, set, delete }, e.g. the Vercel Runtime Cache; or `platform.shared`
    codec: productCodec, // optional: converts values to JSON and validates them on the way back
    timeout: 300, // a slower store counts as missing (default: 300 ms)
    refreshLockTtl: 60_000, // optional: one instance at a time refreshes a stale key
    checkBeforeWrite: false, // optional: read before each write, to keep a newer shared value
  },
});
```

- `store` defaults to `platform.shared`. The constructor throws when there is no store, or no `name`.
- `getOrSet` looks in memory, then in the shared level, then fetches. The age of a shared value is measured from when it was fetched.
- `set`, `bulkSet`, `delete` and `invalidate` also write to or remove from the shared level, and so do the fetches of `getOrSet`. `clear`, `dispose`, `bulkSync` and the fallback values after an error act on the instance only.
- The shared level is never required: a failure or a timeout counts as a missing entry, and is logged as a warning.
- **`codec`**: without it, values are stored as they are, which suits JSON-compatible values only (a `Date` comes back as a string). `encode(value)` converts a value for the store; `decode(raw)` converts it back, and returns `null` to reject an entry that does not have the expected shape. Either one may throw (e.g. a schema `parse`): a value that cannot be encoded is not shared, an entry that cannot be decoded is ignored, and the read or the fetch goes on as usual.
- **`refreshLockTtl`**: while an instance refreshes a stale key, it holds a lock in the store for this long, and the other instances do not refresh that key. Set it to the longest duration of a fetch. It is a soft lock: rarely, two instances still refresh together.
- **`checkBeforeWrite`**: by default a write replaces the shared value. With `true`, each write first reads the shared entry, and leaves it alone when another instance fetched it later. It costs one more round-trip per write, and the check is soft (read and write are not atomic).
- An invalidated key never adopts a shared copy produced before the invalidation, even if its removal from the shared level failed.
- The keys in the store are `lilypad:2:<name>:v:<key>` for the values, with `f` instead of `v` for the time of the last failed fetch (`failureCooldown`) and `l` for the refresh lock (`refreshLockTtl`). The name and the key are URI-encoded, so a `:` in either never makes two keys collide.

### Loading everything at once (`bulkSync`)

When the source can return all values in one call, pass a `bulkSync.fn` and read with `getAll`:

```ts
const products = new LilypadCache<string, Product>({
  ttl: 30_000,
  bulkSync: {
    fn: async () => (await fetchAllProducts()).map((p) => [p.id, p] as [string, Product]),
    ttl: 60_000, // how long a full load stays valid (default: the cache TTL)
    timeout: 30_000, // timeout of a load (default: 30 s)
  },
});

const all = await products.getAll(); // Map<string, Product | null>, after a load if needed
const cachedOnly = products.entries(); // synchronous, no reload
const some = products.getMany(['p1', 'p2']); // synchronous: the fresh values of these keys
```

- A load replaces the whole content of the cache. Protected keys (see below) are kept, but marked as expired. Values written while the load was running are kept, since they are newer than its data.
- A load happens again only after `bulkSync.ttl` (at most the cache TTL, since the loaded values expire then), after `invalidate()` or `invalidateBulkSync()` (also when called while a load is running), after `clear()`, after `maxEntries` evicted an entry, or once an entry written with a shorter TTL expires.
- `bulkSync()` resolves to `true` when the cache is synced, `false` when the load failed, `bulkSync.fn` returned no data, or there is no `bulkSync.fn`. A failed load is logged and **not thrown**, unless you call `bulkSync({ throwOnError: true })`: the cache keeps its current content, and the next call tries again. A load that times out writes nothing.
- `bulkSync.fn` receives an `AbortSignal`, aborted on timeout.
- Concurrent calls share one load.
- Pass `{ sync: false }` to `getAll` to read without reloading (the same as `entries()`).
- Loads fill the memory of this instance only, not the shared level.

### Removing and protecting entries

```ts
products.invalidate('p1'); // mark as expired (the old value stays available as a fallback)
products.delete('p1'); // remove the entry
products.set('p1', null); // cache "p1 does not exist" instead
products.clear(); // remove every entry
products.purgeExpired(); // remove expired entries only

products.addProtectedKeys(['config']);
products.delete('config'); // returns false: protected keys are kept
products.delete('config', { force: true }); // removes it
products.removeProtectedKeys(['config']);
```

- `invalidate(key)` also forces the next `bulkSync` to reload. Pass `{ invalidateBulkSync: false }` to prevent that (`entries()` then leaves the key out until the next load). A fetch of the key already running is not cached. It sends a `manual` event to `platform.onInvalidate`.
- `clear` and `purgeExpired` take the same `{ force }` option as `delete`: without it, protected keys are kept.
- `addProtectedKeys` and `removeProtectedKeys` return the cache, so calls can be chained.

Call `await dispose()` when you no longer need the cache: it stops the cleanup timer and empties the cache. A disposed cache ignores the results of fetches still running, and its methods throw (except `dispose`, which can be called again). `dispose()` returns a promise for every cache (a `LilypadDbCache` also stops its database subscription): always await it.

Keys are compared by their string form, so `get(1)` and `get('1')` read the same entry. `entries()` returns each key with the type it was stored with.

## LilypadDbGate

A PostgreSQL gateway: typed CRUD helpers for simple tables, the full postgres.js client for everything else, and `LISTEN/NOTIFY`.

```ts
import { LilypadDbGate } from '@lilypad/libs/db';

const gate = await LilypadDbGate.create({
  connectionString: process.env.DATABASE_URL!,
  // Optional: a different connection for LISTEN, for example a direct connection
  // when connectionString goes through PgBouncer in transaction mode
  listenerConnectionString: process.env.DATABASE_DIRECT_URL,
  listen: [], // optional: channels to subscribe to at startup (see below)
  statementTimeout: 10_000, // optional: Postgres cancels queries longer than this (default: 30 s)
  pool: { max: 10, idleTimeout: 30_000 }, // optional: pool size and timeouts, in ms
  listenHeartbeat: 15_000, // optional: how often the LISTEN connection is checked (default: 15 s)
  // logger,
  // singleton: true, singletonIdentifier: 'main-db',
});

// ...
await gate.close(); // waits up to 5 s for the running queries, then closes both connections
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
- `statementTimeout` (default: 30 s; `false` keeps the setting of the database) is enforced by Postgres on the queries of the pool. A cache that times out (`fetchTimeout`) does not stop its query: this bound frees the connection, instead of leaving slow queries holding the pool while the queries behind them wait.
- `close({ timeout })` waits at most `timeout` ms (default: 5 s) for the running queries, then closes the connections. It returns the same promise when called again, and the gate then rejects queries and `addListener` (`gate.closed` tells whether it was closed).

### Describing a table

The CRUD helpers take a `LilypadDbSchema<T, PK>`, which describes the table and the TypeScript type of its rows. Declaring the primary key column `PK` makes it optional in inserts and allows partial updates:

```ts
import type { LilypadDbSchema } from '@lilypad/libs/db';

type Post = { id: number; title: string; body: string; published_at: Date | null };

const postsSchema: LilypadDbSchema<Post, 'id'> = {
  tableName: 'posts',
  primaryKey: 'id',
  generatedPrimaryKey: true, // the database generates the id (serial / identity / default)
  cols: {
    id: { type: 'number' },
    title: { type: 'string' },
    body: { type: 'string' },
    published_at: { type: 'date', nullable: true },
  },
  // Optional: applied to the data before every insert and update. Its result replaces the
  // data, so a property it leaves out is not written.
  writeSanitizationFn: (data) => ({ ...data, title: data.title?.trim() }),
};
```

- `cols` must list **every property of `T`**. Only these columns are read and written: any other property of the data you pass is ignored. So you can pass a request body directly without the risk of writing columns such as `is_admin`. Properties set to `undefined` are not written either.
- The column metadata is optional, and mostly documents the table. The gate does not validate or convert values; postgres.js converts them.
  - `type` is one of `'string'`, `'number'`, `'bigint'`, `'boolean'`, `'date'`, `'json'` and `'array'`. The `type` of the primary key is used: with `'number'`, `LilypadDbCache` converts to numbers the ids that notifications and the changelog carry as text. Declare `bigint`/`bigserial` keys as `'bigint'`, and type them as `string` in `T`: postgres.js returns them as strings, so their keys stay strings.
  - `nullable` and `default` are descriptive only.
- With `generatedPrimaryKey: true`, inserts leave out the primary key, and the database generates it. Without this option, inserts require the primary key.
- `LilypadDbCache.sqlCreate` returns, without caching it, a created row that the `selectSanitizationFn` returns without its primary key (with a warning): the row is inserted, and failing would make the caller insert it again.
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
// INSERT ... RETURNING: returns the row with the generated id
const { row: post } = await gate.insertToTable(postsSchema, {
  title: 'Hello',
  body: '...',
  published_at: null,
}); // no `id`: the database generates it

const all = await gate.selectAllFromTable(postsSchema); // Post[], read in batches of 1 000 rows
const one = await gate.selectFromTableByPrimaryKey(postsSchema, 1); // Post | null
const some = await gate.selectFromTableByPrimaryKeys(postsSchema, [1, 2, 3]); // Post[], one query

// UPDATE ... WHERE id = 1: only the given columns are written
const { row: updated } = await gate.updateToTable(postsSchema, { id: 1, title: 'Updated' });

const { deleted } = await gate.deleteFromTable(postsSchema, 1); // false if the row did not exist
```

- `insertToTable` and `updateToTable` resolve to `{ row, xid }`: the row as stored by the database, including generated columns (`null` if `selectSanitizationFn` rejects it), and the id of the transaction that made the write, the one the changelog records. `LilypadDbCache` uses it to recognize its own writes. `deleteFromTable` resolves to `{ deleted, xid }` (`xid` only if a row was deleted).
- The writes return only the schema columns (`RETURNING` lists them), or the whole row when the schema has a `selectSanitizationFn`.
- `updateToTable` throws a `LilypadDbNotFoundError` (with `tableName` and `primaryKeyValue`) when no row has the primary key.
- `selectAllFromTable(schema, { signal })` stops reading, and closes its cursor, once the signal is aborted; it then rejects with the reason of the signal.
- `selectFromTableByPrimaryKeys` leaves out the keys without a row. It sends one query per 1 000 keys, since Postgres limits the parameters of a query.
- An insert or update throws before querying if the primary key is missing (always required by updates; by inserts unless `generatedPrimaryKey`), or if no column is left to write.
- With `generatedPrimaryKey`, updates never write the primary key column: it only identifies the row.

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

See the [postgres.js documentation](https://github.com/porsager/postgres) for the full API. The client is created with `prepare: false` (no prepared statements), so it also works behind poolers such as PgBouncer. `gate.sql` is read-only.

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
- While channels are listened to, the gate sends a notification to itself every `listenHeartbeat` ms (default: 15 s) through the query pool. `gate.isListenHealthy()` is `true` while those heartbeats come back, and turns `false` after 2.5 intervals without one: the connection may be down, and notifications lost, even before postgres.js reconnects. `LilypadDbCache` stops trusting `LISTEN` meanwhile. Set `listenHeartbeat: false` to disable it (`isListenHealthy()` is then `true` while a channel is listened to).
- `addListener` rejects if `LISTEN` fails; the callback is then not registered, and a later call tries again.
- `removeListener` resolves to `false` when no such callback was registered. It never rejects: a failed `UNLISTEN` is logged.

## LilypadDbCache

A cache of the rows of a single table. It reads rows through a `LilypadDbGate` and a `LilypadDbSchema`, writes through to the database, and updates itself when the table changes elsewhere. It runs on the same engine as `LilypadCache` (TTL, stale values, shared level, fallbacks), but its values always come from the table: it has no `set`, `bulkSet`, `getOrSet` or `bulkSync`, since a value that does not come from the table could otherwise be kept past its TTL as if it did.

```ts
import { LilypadDbCache, type LilypadDbSchema } from '@lilypad/libs/db';

type Account = { id: number; email: string; plan: string };

const accountsSchema: LilypadDbSchema<Account, 'id'> = {
  tableName: 'accounts',
  primaryKey: 'id',
  generatedPrimaryKey: true,
  cols: { id: { type: 'number' }, email: { type: 'string' }, plan: { type: 'string' } },
};

const accounts = await LilypadDbCache.create({
  ttl: 5 * 60_000,
  gate,
  schema: accountsSchema,
  // logger, singleton, and every LilypadCache option (autoCleanupInterval, ...) are accepted
});
```

The row type (`Account`) and the key type (the type of the primary key, `number`) are inferred from the schema. `get(7)` and `get('7')` read the same entry. The cache's `name` (shared level keys, invalidation events, logs) defaults to the table name.

### Reading

```ts
const account = await accounts.getOrFetch(7);
// Account -> found (from the cache or from the database)
// null    -> no row with id 7 (this result is cached too)
// It rejects when the query fails, unless `onError` gives a fallback

const everyAccount = await accounts.getAll(); // loads the whole table once, then serves it from the cache
const someAccounts = await accounts.getAll([1, 2]); // queries only the keys it does not hold
```

`getOrFetch(key, options)` accepts the options of [`getOrSet`](#getorset-read-through-the-cache) (`ttl`, `staleWhileRevalidate`, `timeout`, `onError`, ...). `getOrFetchDetailed(key, options)` also returns the `status` and `refreshFailed` of [`getOrSetDetailed`](#getorset-read-through-the-cache). `get()` reads memory only: a cache miss is fetched from the database by `getOrFetch`, not by `get`.

`getAll()` loads the whole table the first time. The cache then keeps track of the rows of the table (the writes, the fetches and the changes it learns about), and later calls query only the rows it does not hold up to date, by primary key, in one query: rows changed or inserted elsewhere, rows that expired. When those are more than a quarter of the table, it loads the whole table instead. It loads the whole table again only when it may have missed changes (the `LISTEN` connection was lost, or the changelog was not read for longer than `maxGap`), or, with the `none` strategy, after `bulkSync.ttl` (the option takes `ttl` and `timeout`, but no `fn`). `getAll(keys)` queries only the keys it does not hold; concurrent calls share the queries of the keys they have in common. `getAll` rejects when the rows cannot be loaded. With `maxEntries` smaller than the table, `getAll()` still returns every row, but queries most of them again at each call.

### Writing through the cache

These methods write to the database first, then cache the row that the database returns:

```ts
const created = await accounts.sqlCreate({ email: 'ada@example.com', plan: 'free' });
// created.id is the id generated by the database

await accounts.sqlUpdate({ id: created!.id, plan: 'pro' }); // LilypadDbNotFoundError if the row does not exist
await accounts.sqlDelete(created!.id); // true if a row was deleted; the key is then cached as null, even if protected
```

`sqlCreate` and `sqlUpdate` return `null` if the schema's `selectSanitizationFn` rejects the returned row. Each write sends a `write` event to `platform.onInvalidate`.

To reload a key from the database:

```ts
await accounts.refresh(7); // query, cache and return the row (null if it does not exist); throws on database errors
accounts.invalidate(7); // no query: the entry is expired, and the next read fetches it
```

`refresh` shares the query of a refresh of the same key already running; a call made while a query runs waits for one more query, which sees every change made before the call. It times out after `fetchTimeout`. `invalidate` behaves as in `LilypadCache`.

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

The trigger records each change in the `lilypad_cache_changes` table and also sends a notification on the `cache_events` channel, so it serves both strategies. A second trigger, on each table, records `TRUNCATE`, which fires no row trigger. It records the schema of the table too, so tables of the same name in different schemas are not mixed up. It needs PostgreSQL 13 or later. Both functions return SQL that can safely be run again (`IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP TRIGGER IF EXISTS`).

- `lilypadChangelogSql({ table, notifyChannel })`: `table` renames the changelog table (default: `LILYPAD_DEFAULT_CHANGELOG_TABLE`, that is `lilypad_cache_changes`). `notifyChannel: false` sends no notification, for the `changelog` strategy alone. The `listen` strategy of `LilypadDbCache` always listens on `cache_events`, so keep that name if you use it.
- `lilypadChangelogTriggerSql({ table, primaryKey, changelogTable })`: `table` and `primaryKey` are those of the cached table; pass `changelogTable` if you renamed it. It creates one statement trigger per event (`<table>_lilypad_insert`, `_update`, `_delete`), which records all the rows of a statement in one query through its transition tables, and `<table>_lilypad_truncate` for `TRUNCATE`. Transition tables are not allowed on the partitions of a partitioned table: attach the triggers to the partitioned table itself. Run it in one transaction, so that no write goes unrecorded while the triggers are replaced.
- If you installed the changelog with an earlier version of the library, run both functions again: `lilypadChangelogSql()` updates the trigger function (version 4), `lilypadChangelogTriggerSql()` replaces the row trigger of the earlier versions with the statement triggers (and adds the `TRUNCATE` trigger if it is missing). The function still serves the row triggers of the earlier versions, so the tables keep being recorded between the two steps. The schema check reports an outdated function (`outdated-changelog`) and a missing `TRUNCATE` trigger (`missing-truncate-trigger`); the row triggers of version 3 still pass it.
- An `UPDATE` that changes the primary key is recorded as a `DELETE` of the old key followed by an `UPDATE` of the new one.
- Delete the old changelog rows periodically with `pruneLilypadChangelog(gate, { olderThan, changelogTable })`, which resolves to the number of deleted rows. `olderThan` (ms) must be much longer than `maxGap` and `lookback` (see [the changelog section of the Next.js guide](docs/nextjs-vercel.md#deleting-old-changelog-rows)).
- `readLilypadChanges(gate, { tableName, since, changelogTable })` is the low-level read, if you want to consume the changelog yourself. It resolves to `{ changes, cursor }`; pass `since: { cursor }` on the next call (or `since: { lookback }` the first time). The cursor holds the transactions the read could not see yet (`xmax`, and `xip`, those still running), so each change is returned by exactly one read from a cursor, whatever the order of the commits, and a long-running transaction does not make every read return again the changes made since it started. A lookback read can return changes that an earlier read returned. A `TRUNCATE` change has `rowId: null`. The caches of a gate read their tables together, in one query.

```ts
const accounts = await LilypadDbCache.create({
  ttl: 60_000,
  gate,
  schema: accountsSchema,
  sync: { strategy: 'changelog', pollInterval: 5_000 },
});
```

When the cache learns about a change of its table:

- on `INSERT` and `UPDATE`, it re-fetches (`listen`) or expires (`changelog`) the key if it holds it (or is fetching it). Expiring also discards a read of the key already running, which may predate the change, without a query. The keys notified together are re-fetched together, in one query by primary key (a statement that changes many rows notifies each of them). For other keys it sends no query. In every case it notes that the row exists, and the next `getAll` returns it;
- on `DELETE`, with `changelog`, it caches the key as `null` if it holds it (also for protected keys); a key it does not hold gets no entry, so a mass delete does not evict the rows it holds. With `listen`, it re-fetches the key if it holds it (the query returns `null` if the row is gone): any role connected to the database can send a notification, so the cache treats notifications as hints and never trusts their content without a query;
- on `TRUNCATE`, it expires every entry, and copies of the rows in the shared level are then ignored. With `changelog` it knows the table is empty, without a query; with `listen`, the next `getAll()` loads the table again;
- a change made by `sqlCreate`, `sqlUpdate` or `sqlDelete` of the same instance is skipped when the cache still holds the row that write returned: the instance that writes does not query the row again;
- if it may have missed changes (the `LISTEN` connection was lost, or the changelog was not read for longer than `maxGap`), it marks every entry as expired.

A notification that is not valid JSON, or whose `op` is not one of `INSERT`, `UPDATE`, `DELETE` and `TRUNCATE`, is ignored and logged as a warning.

Rows are stored in the order the changes happened: a slow query can never overwrite the result of a newer one. A write whose row changed while it was running (a change applied meanwhile, or a read that may have seen the row before the write) is not cached: the next read fetches the row.

#### The TTL while the cache is in sync

With `listen` or `changelog`, as long as the sync is trusted (`LISTEN` active and its [heartbeat](#listening-to-notifications-listennotify) recent, changelog read within `maxGap`), the cache sees every change of its table. A row that reaches its TTL without a change is then still up to date: the cache keeps it without a query, until it is `maxAge` old (default: 1 hour). `get`, `peek`, `getOrFetch` and `getAll` all see it as fresh. The TTL keeps bounding the shared level, which is never extended this way, and the copies read from it, which are queried again at their TTL.

`maxAge` bounds how long a change that the triggers do not see (triggers disabled, `session_replication_role = replica` during a restore) can go unnoticed. Set `maxAge: 0` to query the rows again at each TTL. With the `none` strategy the TTL applies as in `LilypadCache`.

The options of the `changelog` strategy:

| Option | Default | What it does |
| --- | --- | --- |
| `pollInterval` | required | Minimum time (ms) between two reads of the changelog. The cache reads it before a `getOrFetch` or `getAll` once this has passed, so changes are seen within it |
| `poll` | `'await'` | `'await'`: a read that falls due waits for the changelog. `'background'`: it does not wait, and may return data one interval older |
| `maxGap` | 1 hour | If the changelog has not been read for this long, the instance no longer trusts its memory and expires every entry |
| `lookback` | TTL + `staleWhileRevalidate` + 1 min | On the first read, or after `maxGap`, the changes of this period are applied, which also removes older copies from the shared level |
| `maxAge` | 1 hour | How long a row can be kept past its TTL while the sync is trusted: see [The TTL while the cache is in sync](#the-ttl-while-the-cache-is-in-sync). `listen` accepts it too |
| `table` | `lilypad_cache_changes` | The changelog table, if you renamed it |
| `verify` | `'warn'` | Checks that the changelog and the trigger are installed: see [Checking the database setup](#checking-the-database-setup) |

The caches of a gate that use the same changelog table read it together, in one query per poll. A failed read of the changelog is logged, and the read of the cache goes on with its current content; the next attempt waits for a backoff (from `pollInterval`, doubling up to one minute) instead of retrying at every read. A failed lazy `LISTEN` backs off the same way, from one second. The [Next.js guide](docs/nextjs-vercel.md#5-database-caches-keeping-every-instance-up-to-date) explains how to choose these values.

#### Checking the database setup

The library does not create the changelog or the triggers itself: without them, the cache would silently stay stale (`listen`) or fail each read of the changelog (`changelog`). So the `listen` and `changelog` strategies check them once, with their `verify` option:

| `verify` | When | If something is missing |
| --- | --- | --- |
| `'warn'` (default) | Once, when the cache first uses the database: before `LISTEN`, or with the first read of the changelog (which does not wait for it). If the check cannot run (e.g. the database is unreachable), a later read runs it again, after a backoff | A warning on the logger (on `console.warn` without a logger), with the SQL that fixes it |
| `'throw'` | In `create`, which then queries the database whatever the strategy | `create` rejects with a `LilypadSchemaCheckError`, whose `problems` list what is missing |
| `'off'` | Never | |

With `changelog`, the check looks for the changelog table, its trigger function (installed by this version of the library) and the changelog trigger on the table, recording its primary key. With `listen`, it looks for triggers of the table whose function calls `pg_notify('cache_events', ...)` (yours or the library's), firing on each `INSERT`, `UPDATE` and `DELETE` row. If you send notifications another way, set `verify: 'off'`.

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

`tables` gives the schema each table resolves to (`null` if it does not exist). The codes are `unsupported-version`, `missing-table`, `missing-changelog`, `outdated-changelog` (installed by an older version of the library: run `lilypadChangelogSql()` again), `missing-changelog-trigger` (missing, disabled or not on every `INSERT`, `UPDATE` and `DELETE`), `wrong-trigger-primary-key`, `missing-notify-trigger` (no trigger notifies on the channel, or not on each of `INSERT`, `UPDATE` and `DELETE`) and `missing-truncate-trigger` (`TRUNCATE` is not recorded, or, with `notifyChannel`, not notified: add it with `lilypadChangelogTriggerSql`, or handle `TG_OP = 'TRUNCATE'` in your own trigger).

#### Custom notification triggers and callbacks

With `listen`, the cache expects JSON payloads on `cache_events` shaped like `{ "schema": "public", "table": "accounts", "id": 7, "op": "INSERT" | "UPDATE" | "DELETE" }`, where `id` is a number or a string: you can also send them from your own trigger. `schema` is optional: without it, the payload applies to a table of that name in any schema. To run your own code on each notification:

```ts
const accounts = await LilypadDbCache.create({
  ttl: 60_000,
  gate,
  schema: accountsSchema,
  sync: {
    strategy: 'listen',
    connect: 'lazy', // start LISTEN on the first read instead of in create()
    // Called after the cache has applied the notification
    onNotification: async ({ op, id }) => {
      await broadcastToClients({ type: 'account-changed', op, id });
    },
    // applyChanges: false, // leave the cache to onNotification (default: true)
  },
});
```

With any strategy, `platform.onInvalidate` receives an event for every change (`write`, `changelog`, `notification` or `manual`), for example to revalidate other caches.

Always call `await accounts.dispose()` when you are done with a cache. It removes the cache's notification subscription, which otherwise keeps running on the gate.

## LilypadFlowControl

Wraps an async function with a timeout, retries, rate limiting and single-flight deduplication. `LilypadCache` uses it internally, and you can use it on its own:

```ts
import { LilypadFlowControl, LilypadTimeoutError } from '@lilypad/libs';

const payments = new LilypadFlowControl({
  timeout: 3_000, // abort each attempt after 3 s (default: no timeout)
  retries: 2, // retry twice after the first failure (default: 0)
  rate: 1_000, // at most one new execution per second per consumer/function pair (default: no limit)
  // logger,
});

const result = await payments.executeFn({
  functionIdentifier: 'charge:user-42', // concurrent calls with the same id share one execution
  consumerIdentifier: 'user-42', // optional: the rate limit applies per consumer and function
  fn: (signal) => callPaymentApi('user-42', signal), // pass the signal on so a timeout cancels the work
  backOffTime: (attempt) => attempt * 500, // wait before retries (default: 200, 400, 800 ms...)
});
```

- **Typing:** the class is not generic: each execution is typed by its `fn` (here `{ ok: boolean }`).
- **Single flight:** while an execution with a given `functionIdentifier` is running, other calls with the same identifier receive its promise. They do not start a new execution and are not rate limited, and their own options (`fn`, `timeout`, ...) are ignored: they share the outcome of the first call. Each caller handles an error on its own (`.catch`).
- **Per-call options:** `retries` and `timeout` in the options of `executeFn` override those of the instance for that execution.
- **Timeout:** a timed out attempt fails with a `LilypadTimeoutError` (`Operation timed out after <timeout>ms`, with the `timeout` as a property). Each attempt gets its own timeout, so with retries the whole execution can last `(retries + 1) × timeout` plus the backoff times. Each attempt gets an `AbortSignal` that is aborted when the timeout expires. JavaScript cannot stop a running promise, so pass the signal to `fetch`, to the database driver, and so on, or check `signal.aborted` yourself.
- **Rate limit:** a new execution started less than `rate` ms after the previous one for the same consumer/function pair fails with a `LilypadRateLimitError` (`Rate limit exceeded for ...`). The call is rejected, not delayed.
- An execution refused by the rate limit rejects with a `LilypadRateLimitError`; one that failed rejects with the error of its last attempt.
- The constructor throws for an invalid option (`NaN`, a negative duration, a fractional `retries`).

The individual steps are also available: `executeWithTimeout(fn, timeout?)`, `executeWithRetries({ executionFn, retries, backOffTime })`, `rateLimit(key)` (synchronous: it throws when the limit is exceeded), `singleFlight(key, fn)` and `isInFlight(key)`.

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
- `deserialize` uses a copy of `default` when the `deserialize` function returns `undefined`. `null` is kept as a value. Object and array defaults are cloned, so deserialized items never share them.

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
const cache = getLilypadSingletonInstance('prices', () => new LilypadCache({ ttl }), {
  value: JSON.stringify([ttl]), // kept in a global map: hash it if it contains secrets
  onMismatch: () => console.warn('"prices" already exists with a different TTL'),
});
```

`getLilypadSingletonInstanceAsync` shares one creation between concurrent callers. If the creation fails, it is forgotten, so the next call tries again.

The registry is stored on `globalThis`, so it is shared by the whole process, including copies of the library loaded from different bundles. Use identifiers that are unique across your application. The `create()` methods prefix their identifiers with the class name (`LilypadDbGate:main-db`), so they never collide with yours. `getLilypadSingletonInstance` throws if the identifier is still being created by `getLilypadSingletonInstanceAsync`.

## Troubleshooting

For problems specific to serverless platforms (connections exhausted, lost logs, changes not seen), see the [troubleshooting section of the Next.js guide](docs/nextjs-vercel.md#10-troubleshooting).

**`LilypadDbCache` does not see changes made outside the application.**
Check that the trigger from [Keeping the cache in sync with the database](#keeping-the-cache-in-sync-with-the-database) is installed on the table, and that its `table` value matches `schema.tableName`. Check also that `sync` is not `{ strategy: 'none' }`, nor `listen` with `applyChanges: false`. With the `changelog` strategy, changes appear only after `pollInterval`, and only when the cache is read. To test the setup, run `SELECT pg_notify('cache_events', '{"table":"accounts","id":"7","op":"UPDATE"}');` and pass a logger with a `debug` component: the cache logs every payload it receives.

**Notifications stop arriving behind PgBouncer.**
`LISTEN` does not work through a pooler in transaction mode. Set `listenerConnectionString` to a direct connection to Postgres.

**`getOrSet` throws `Operation timed out after ...ms` (a `LilypadTimeoutError`).**
The fetch took longer than `fetchTimeout` (5 s by default). Increase it in the cache options, or use `onError` to return a fallback value. For database fetches, set `statementTimeout` on the gate too, so that Postgres stops the slow queries instead of letting them pile up.

**`Rate limit exceeded for ...` (a `LilypadRateLimitError`).**
A `LilypadFlowControl` with `rate` rejects new executions that come too soon. Catch the error, or use a different `consumerIdentifier` for each caller.

**The process does not exit.**
Open database connections keep Node.js running. Call `await dispose()` on every `LilypadDbCache`, then `close()` on the gate.

**My logger does not print anything from the library.**
The other modules log only through the logger you pass them, on the levels `error`, `warn`, `info` and `debug`. Check that you passed `logger` and that it has those methods (with a `LilypadLogger`, that those channels have components).

**`@lilypad/libs` has no `LilypadDbGate` or `LilypadDbCache`.**
The database modules are exported by `@lilypad/libs/db` only, so that the root entry never pulls in postgres.js and runs in edge runtimes.

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

The pre-commit hook runs the unit tests, the typecheck, the lint check and the build on the staged changes (the unstaged ones are stashed meanwhile), then stages `dist/`. The CI (`.github/workflows/ci.yml`) runs the same checks on Node.js 22 and 24, checks that the committed `dist/` matches the sources, and runs the integration tests. See [How @lilypad/libs works](docs/how-it-works.md) for a guided tour of the internals, and [CLAUDE.md](CLAUDE.md) for condensed architecture notes.
