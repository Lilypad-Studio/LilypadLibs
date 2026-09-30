# @lilypad-studio/libs

Server-side TypeScript utilities from Lilypad Studios:

| Module                                      | What it gives you                                                                                                                                                                                                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`LilypadLogger`](#logger)                  | A typed logger with named channels (`logger.info(...)`, `logger.error(...)`) and pluggable outputs (console, Discord, your own).                                                                                                                                  |
| [`LilypadCache`](#lilypadcache)             | A TTL cache that deduplicates concurrent fetches, serves stale values while refreshing them, falls back to the old value when a fetch fails, and can share its values between instances.                                                                          |
| [Database config](#database-config)         | One file that describes the database the application expects (tables, columns, keys, foreign keys, indexes, checks, sync), used by the database modules at runtime and checked against the database by [`lilypad-doctor`](#lilypad-doctor-checking-the-database). |
| [`LilypadDbGate`](#lilypaddbgate)           | A thin PostgreSQL gateway (built on [postgres.js](https://github.com/porsager/postgres)): typed CRUD helpers and `LISTEN/NOTIFY` subscriptions.                                                                                                                   |
| [`LilypadDbCache`](#lilypaddbcache)         | A cache of the rows of one database table (on the same engine as `LilypadCache`), kept up to date by a changelog table or by Postgres notifications.                                                                                                              |
| [`LilypadFlowControl`](#lilypadflowcontrol) | Timeouts, retries with backoff, rate limiting and single-flight deduplication for async calls.                                                                                                                                                                    |
| [`LilypadSerializer`](#lilypadserializer)   | Type-checked mapping between two object shapes (for example, compact storage keys) that leaves out default values.                                                                                                                                                |
| [Singleton helpers](#singletons)            | A process-wide registry that survives hot reloads and duplicate bundles.                                                                                                                                                                                          |

**Running on Next.js or Vercel?** Read [Using Lilypad on Next.js and Vercel](docs/nextjs-vercel.md): it shows how to connect the library to the platform, and the recommended options for each module.

**Want to know how it works inside?** Read [How @lilypad-studio/libs works](docs/how-it-works.md): a top-down tour of the internals, from the general design down to single functions.

**Contents:** [Installation](#installation) · [Quick start](#quick-start) · [Conventions](#conventions-used-across-the-library) · [Next.js / Vercel](docs/nextjs-vercel.md) · [Logger](#logger) · [LilypadCache](#lilypadcache) · [Database config](#database-config) · [LilypadDbGate](#lilypaddbgate) · [LilypadDbCache](#lilypaddbcache) · [lilypad-doctor](#lilypad-doctor-checking-the-database) · [LilypadFlowControl](#lilypadflowcontrol) · [LilypadSerializer](#lilypadserializer) · [Singletons](#singletons) · [Troubleshooting](#troubleshooting) · [Contributing](#contributing)

## Installation

The package is internal: it is published to the GitHub Packages registry of Lilypad-Studio, which only the people and the repositories given access to it can read. Point the `@lilypad-studio` scope to that registry in the `.npmrc` of the application, give npm a token that can read packages, then install it:

```ini
# .npmrc of the application (committed: it holds no secret)
@lilypad-studio:registry=https://npm.pkg.github.com
```

```bash
npm install @lilypad-studio/libs
```

[docs/installing.md](docs/installing.md) explains which token to use on a workstation, in GitHub Actions, on Vercel and in Docker, and how to upgrade from `@lilypad/libs` installed from git.

Requirements:

- Node.js 22.12 or later.
- It is built as ES modules, with type declarations. Node.js 22.12+ also loads them with `require()`, so CommonJS code can use it too.
- The database modules (`@lilypad-studio/libs/db`) run on Node.js only, since they need TCP connections. The other modules also run in edge runtimes (see [Importing](#importing-the-whole-package-or-one-module)). None of them is meant for browsers.
- The database modules need PostgreSQL and the [`postgres`](https://github.com/porsager/postgres) driver, an optional peer dependency: install it next to the library (`npm install postgres`) if you use `@lilypad-studio/libs/db`. The other modules do not need it.

## Quick start

The database modules start from a config file that describes the tables (see [Database config](#database-config)). `npx lilypad-doctor init` creates one to start from, with an example table; edit it into:

```ts
// lilypad.config.ts
import { defineLilypadDb, defineLilypadTable } from '@lilypad-studio/libs/schema';

type User = { id: string; name: string; email: string };

const users = defineLilypadTable<User, 'id'>({
  tableName: 'users',
  primaryKey: 'id',
  cols: {
    id: { pgType: 'uuid' },
    name: { pgType: 'text', nullable: false },
    email: { pgType: 'text', nullable: false, unique: true },
  },
  sync: { strategy: 'listen' }, // the default
});

export default defineLilypadDb({ tables: { users } });
```

This example loads the `users` table into a cache and reads rows through it:

```ts
import { LilypadLogger, LilypadConsoleLogger } from '@lilypad-studio/libs/logger';
import { LilypadDbGate, LilypadDbCache } from '@lilypad-studio/libs/db';
import db from './lilypad.config';

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

// 2. The database gateway, with the config of the database
const gate = await LilypadDbGate.create({
  connectionString: process.env.DATABASE_URL!,
  config: db,
  logger,
});

// 3. A cache over the `users` table (or `table: db.tables.users`)
// The row type and the key type are inferred from the config
const users = await LilypadDbCache.create({ ttl: 60_000, gate, table: 'users', logger });

const user = await users.getOrFetch('42'); // rejects if the query fails
if (user === null) {
  // there is no user with this id
} else {
  logger.info('Hello', user.name);
}

// 4. On shutdown
await users.dispose();
await gate.close();
```

Then check that the database matches the config, for example in a deployment step:

```sh
npx lilypad-doctor --url "$DATABASE_URL"
```

It prints what is missing (here, the trigger that notifies the cache of the changes) with the SQL that fixes it. See [lilypad-doctor](#lilypad-doctor-checking-the-database).

## Conventions used across the library

### Importing the whole package or one module

Each module is available on its own. `@lilypad-studio/libs` exports every module **except `/db`**, so that importing it never pulls in `postgres` and it also runs in edge runtimes:

| Import                            | Contents                                                                                                         | Edge runtime |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------ |
| `@lilypad-studio/libs/logger`     | `LilypadLogger` and the components                                                                               | Yes          |
| `@lilypad-studio/libs/cache`      | `LilypadCache`                                                                                                   | Yes          |
| `@lilypad-studio/libs/flow`       | `LilypadFlowControl`                                                                                             | Yes          |
| `@lilypad-studio/libs/serializer` | `LilypadSerializer`                                                                                              | Yes          |
| `@lilypad-studio/libs/singleton`  | The singleton registry                                                                                           | Yes          |
| `@lilypad-studio/libs/platform`   | The platform types (`LilypadPlatform`, ...)                                                                      | Yes          |
| `@lilypad-studio/libs/schema`     | `defineLilypadDb`, `defineLilypadTable` and the table types, for the [config files](#database-config)            | Yes          |
| `@lilypad-studio/libs/db`         | `LilypadDbGate`, `LilypadDbCache`, the changelog helpers, `lilypad-doctor` from code (it also exports `/schema`) | No           |

Import the database modules from `@lilypad-studio/libs/db`. For the others, importing the module you use keeps bundles smaller. Code that runs in an edge runtime (for example Next.js middleware) must not import `/db`.

### Platform capabilities

On serverless platforms, the modules accept a `platform` option (type `LilypadPlatform`). Every field is optional:

| Field                 | What the library does with it                                                                                            | On Next.js / Vercel                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `background(task)`    | Keeps the instance alive until `task` settles: log messages being sent, shared level writes, invalidation events         | `(task) => after(() => task)` or `waitUntil` |
| `afterResponse(work)` | Starts stale-while-revalidate refreshes once the response is sent. Without it, they start at once (through `background`) | `(work) => after(work)`                      |
| `shared`              | The default store of the caches' shared level (`get`, `set` with a `ttl` in **seconds**, `delete`)                       | `getCache()` from `@vercel/functions`        |
| `onInvalidate(event)` | Called when cached data changes (see [Invalidation events](docs/nextjs-vercel.md#invalidation-events))                   | `revalidateTag`                              |

If `background` or `afterResponse` throws (for example `after` called outside a request), the work still runs, only without the guarantee. See [Using Lilypad on Next.js and Vercel](docs/nextjs-vercel.md). Without `platform`, the modules behave as on a long-running server.

### Creating instances: `create()` or `new`

| Class                                                        | How to create it                              |
| ------------------------------------------------------------ | --------------------------------------------- |
| `LilypadLogger`                                              | `LilypadLogger.create(options)` (synchronous) |
| `LilypadDbGate`                                              | `await LilypadDbGate.create(options)`         |
| `LilypadDbCache`                                             | `await LilypadDbCache.create(options)`        |
| `LilypadCache`                                               | `new LilypadCache(options)`                   |
| `LilypadFlowControl`, `LilypadSerializer`, logger components | `new ...`                                     |

The first three classes have private constructors, so `new LilypadLogger(...)` does not compile. `LilypadDbGate.create` and `LilypadDbCache.create` are async. A gate with `listen` channels, and a cache whose table uses the `listen` sync (unless `connect: 'lazy'`), resolve once `LISTEN` is active, and reject if it fails (e.g. the database cannot be reached). Otherwise they open no connection: the first query does.

### Singletons

Every `create()` accepts a `singleton` identifier, or no singleton option at all:

```ts
// Always returns the same instance for 'main-db', even when called from several modules
const gate = await LilypadDbGate.create({
  singleton: 'main-db',
  connectionString: process.env.DATABASE_URL!,
});
```

- The first call builds the instance. Later calls with the same identifier return that instance and **ignore their own options**. If those options differ from the first ones (connection strings or `listen` channels for a gate, table or TTL for a cache, name or channels for a logger), a warning is logged (`console.warn` for the logger).
- Identifiers are separate for each class: a `LilypadLogger` and a `LilypadDbGate` can both use `'main'`.
- Concurrent first calls share one initialization. If it fails, the next call tries again.
- `gate.close()` and `cache.dispose()` remove the instance from the registry, so the next `create()` builds a new one.

This is useful in frameworks with hot module reloading, such as Next.js in development, where module-level variables are created again on every reload but connections should not be.

### Passing a logger to the other modules

`LilypadCache`, `LilypadDbCache` and `LilypadDbGate` accept an optional `logger`: any object with some of the methods `error`, `warn`, `info` and `debug` (the type `LilypadLibLogger`). Each method receives the message, then its `LilypadLogMeta`: `{ source, error?, detail? }` (the instance that logs, and the error or the value the message is about). A `LilypadLogger` works, and so does `console`. For pino, which takes the fields first, wrap it: `logger: lilypadPinoLogger(pino())` passes `{ source, err, detail }` then the message, so that pino serializes the error. The levels the logger lacks are skipped, and a logger that throws or rejects never breaks the module. Without a logger, these modules log nothing. That includes errors they handle themselves, such as a failed `bulkSync` or a failed notification callback.

The `source` of the meta is the name of the instance (for a `LilypadDbCache`, its table).

### `undefined` and `null` are different

Cache methods return:

- `undefined`: the key is **not in the cache** (or has expired), so the value is unknown.
- `null`: the key **is in the cache**, and the value is known **not to exist** (for example, no row has that primary key).
- any other value: the cached value.

Use `null` to cache "not found" results. Repeated lookups of a missing id then stop reaching the database.

## Logger

### Creating a logger

You choose the channel names. Each channel becomes a method on the logger, which returns nothing (see `flush()` below):

```ts
import { LilypadLogger, LilypadConsoleLogger, LilypadDiscordLogger } from '@lilypad-studio/libs';

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

logger.info('Invoice created', { id: 'inv_1', total: 42 });
logger.error('Payment failed', new Error('card declined'));
// 2026-09-24T10:00:00.000Z - [billing] [INFO]: Invoice created { id: 'inv_1', total: 42 }
```

- A channel method takes any number of arguments. Strings are printed as they are. Other values are formatted in a style close to `util.inspect`: an `Error` keeps its message, stack trace, own properties (such as the `code` and `detail` of a database error) and `cause`. Formatting never throws: circular objects, BigInts and getters that throw are printed too.
- Channel methods return nothing: they never throw, each failing component is reported to `errorLogging`, and a failure of `errorLogging` itself is printed with `console.error`. A failing component does not stop the others. `await logger.flush()` when the messages must be sent before you continue, for example just before `process.exit`.
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
import type { LilypadLibLogger } from '@lilypad-studio/libs';

// LilypadLibLogger: any object with some of the methods error, warn, info and debug
class OrderService {
  constructor(private readonly logger?: LilypadLibLogger) {}

  run() {
    this.logger?.info?.('running', { source: 'OrderService' });
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
import { LilypadLoggerComponent, type LilypadLogRecord } from '@lilypad-studio/libs';
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
import { LILYPAD_DEFAULT_REDACTED_KEYS, LilypadLogger } from '@lilypad-studio/libs';

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
import { LilypadCache } from '@lilypad-studio/libs';

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

| Option                           | Default                | What it does                                                                                                                                    |
| -------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `ttl`                            | 60 s                   | Time to live of the entries. It must be a positive finite number                                                                                |
| `autoCleanupInterval`            | never                  | Removes expired entries with a timer (which does not keep Node.js running)                                                                      |
| `cleanupOnAccessEvery`           | never                  | Removes expired entries during reads and writes, at most once per interval. It needs no timer, so it suits instances suspended between requests |
| `errorTtl`                       | the TTL, at most 5 min | TTL of a fallback value cached after a failed fetch                                                                                             |
| `fetchTimeout`                   | 5 s                    | Timeout of the fetches of `getOrSet`                                                                                                            |
| `staleWhileRevalidate`           | 0 (off)                | [Stale values](#stale-values-cooldown-and-bounded-memory)                                                                                       |
| `failureCooldown`                | 0 (off)                | [Cooldown after a failed fetch](#stale-values-cooldown-and-bounded-memory)                                                                      |
| `maxEntries`                     | no limit               | [Bounded memory](#stale-values-cooldown-and-bounded-memory)                                                                                     |
| `name`                           | a random id            | Names the cache in shared level keys and invalidation events. Required with `shared`                                                            |
| `shared`                         | none                   | [A level shared by every instance](#a-level-shared-by-every-instance)                                                                           |
| `platform`                       | none                   | [Platform capabilities](#platform-capabilities)                                                                                                 |
| `tagPrefix`                      | `'lilypad'`            | Prefix of the tags of the invalidation events (`<tagPrefix>:<name>:<key>`, name and key URI-encoded)                                            |
| `bulkSync: { fn, ttl, timeout }` | none, the TTL, 30 s    | [Loading everything at once](#loading-everything-at-once-bulksync)                                                                              |
| `logger`                         | none                   | See [Passing a logger](#passing-a-logger-to-the-other-modules)                                                                                  |

Durations and sizes are checked by the constructor: a value that is not a finite number, a negative one, or a `maxEntries` that is not a positive integer throws.

### Reading and writing

```ts
products.set('p1', { id: 'p1', price: 10 });
products.set('p2', null); // cache "p2 does not exist"
products.set('p3', { id: 'p3', price: 5 }, 1_000); // TTL for this entry only

products.get('p1'); // { id: 'p1', price: 10 }
products.get('p2'); // null      -> known not to exist
products.get('p4'); // undefined -> not cached

products.bulkSet([
  ['p5', { id: 'p5', price: 7 }],
  ['p6', null],
]); // several `set` at once (also takes a Map)
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
- **`failureCooldown`**: during a source outage, requests do not all retry it. Within the cooldown, `getOrSet` uses a stale value or the `onError` fallback, or throws `LilypadCacheCooldownError` (exported by `/cache` and `/db`, so you can test for it with `instanceof`). With a shared level, the cooldown is shared by every instance.
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

## Database config

The database modules work from a **config**: a file that describes the database the application expects. It lists its tables with their columns, keys, foreign keys, indexes and checks, how each table is kept in sync, and the changelog with its pruning. The application imports it to create its gates and caches, where nothing is compared with the database. The [`lilypad-doctor`](#lilypad-doctor-checking-the-database) command loads the same file and checks the database against it.

To start, let the command write the file:

```sh
npx lilypad-doctor init                       # lilypad.config.ts, with an example table
npx lilypad-doctor init --config analytics    # lilypad.analytics.config.ts (name: 'analytics')
npx lilypad-doctor init --config ./db/lilypad.config.mjs --empty  # JavaScript, no example table
```

It never overwrites a config unless you pass `--force`, which overwrites only the file it creates: when another file of the same config exists (another extension), it stops, since the loader would refuse both. It needs no database. The file it writes lists the options of the config with their defaults, as comments. A complete config looks like this:

```ts
// lilypad.config.ts, at the root of the project
import { defineLilypadDb, defineLilypadTable } from '@lilypad-studio/libs/schema';

type Team = { id: number; slug: string; name: string };
type Member = {
  id: string;
  teamId: number;
  email: string;
  joinedAt: Date;
  managerId: string | null;
};

const teams = defineLilypadTable<Team, 'id'>({
  tableName: 'teams',
  primaryKey: 'id',
  generatedPrimaryKey: true, // the database generates the id
  cols: {
    id: { pgType: 'int4' },
    slug: { pgType: 'varchar(64)', nullable: false, unique: true },
    name: { pgType: 'text', nullable: false },
  },
  sync: { strategy: 'changelog', pollInterval: 5_000 },
});

const members = defineLilypadTable<Member, 'id'>({
  tableName: 'members',
  primaryKey: 'id',
  generatedPrimaryKey: true,
  cols: {
    id: { pgType: 'uuid', default: { sql: 'gen_random_uuid()' } },
    teamId: {
      pgType: 'int4',
      nullable: false,
      references: { table: 'teams', onDelete: 'cascade' },
    },
    email: { pgType: 'text', nullable: false },
    joinedAt: { pgType: 'timestamptz', nullable: false, default: { sql: 'now()' } },
    managerId: { pgType: 'uuid', nullable: true },
  },
  unique: [{ columns: ['teamId', 'email'] }],
  foreignKeys: [{ columns: ['managerId'], references: { table: 'members', onDelete: 'set null' } }],
  indexes: [{ columns: ['teamId', 'joinedAt'] }],
  checks: [{ name: 'members_email_check', expression: "email LIKE '%@%'" }],
  sync: { strategy: 'changelog', pollInterval: 5_000 },
});

export default defineLilypadDb({
  changelog: { pruning: 'cron' },
  tables: { teams, members },
});
```

The application imports it:

```ts
import db from './lilypad.config';

const gate = await LilypadDbGate.create({
  connectionString: process.env.DATABASE_URL!,
  config: db,
});
const members = await LilypadDbCache.create({ ttl: 60_000, gate, table: 'members' });
const teams = gate.table(db.tables.teams); // the CRUD helpers; gate.table('teams') works too
```

`defineLilypadDb` checks the config itself, and throws on the first mistake: a primary key that is not a column, a foreign key whose columns do not match the referenced ones (or name a column the referenced table of the config lacks), two keys for the same table, a `changelog` sync without `pollInterval`, a function in a table, an option it does not know (a misspelled `generatedPrimaryKey` would otherwise be ignored), an identifier longer than 63 bytes, and so on. It never queries the database. Its result is frozen, all the way down, and its `tables` are the definitions that `gate.table()` and `LilypadDbCache.create()` take: they reject a description that does not come from `defineLilypadDb`.

| Option                   | Default                   | What it does                                                                                                                                                    |
| ------------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tables`                 | required                  | The tables, by key: `db.tables.<key>`, `gate.table('<key>')`                                                                                                    |
| `name`                   | `'default'`               | The name of the config, which `lilypad-doctor --config` looks for (see [Several configs](#several-configs))                                                     |
| `defaultSchema`          | `'public'`                | The schema of the tables whose name is not qualified. Every query of the library names a table with its schema (`"public"."teams"`), whatever the `search_path` |
| `notifyChannel`          | `'cache_events'`          | The channel the triggers notify, for the tables with the `listen` sync                                                                                          |
| `changelog.table`        | `'lilypad_cache_changes'` | The changelog table, for the tables with the `changelog` sync                                                                                                   |
| `changelog.pruning`      | `'detect'`                | How the old changelog rows are deleted (see [Checking the pruning of the changelog](#checking-the-pruning-of-the-changelog))                                    |
| `changelog.minRetention` | 1 hour                    | The shortest retention the pruning may keep; `lilypad-doctor` raises it to the `maxGap` and `lookback` of the `changelog` tables                                |
| `strict`                 | `false`                   | `lilypad-doctor` also warns about what the database has and the config lacks: columns, foreign keys, unique keys, checks, indexes. A table can override it      |

### Describing a table

`defineLilypadTable<T, PK>(table)` describes one table and the TypeScript type of its rows. It only returns its input, typed: declaring the primary key column `PK` makes it optional in inserts and allows partial updates. The row type of a table described without it is inferred from `cols`, with `unknown` values.

| Field                 | Default                       | What it does                                                                                                                                                                                   |
| --------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tableName`           | required                      | `'teams'`, or `'app.teams'` to give its schema                                                                                                                                                 |
| `schemaName`          | `defaultSchema` of the config | The schema of the table, instead of qualifying `tableName`                                                                                                                                     |
| `primaryKey`          | required                      | One column: the keys of `LilypadDbCache`. `lilypad-doctor` checks that it is the primary key of the table                                                                                      |
| `generatedPrimaryKey` | `false`                       | The database generates the primary key (serial, identity, default): inserts leave it out and return the generated one. `lilypad-doctor` checks that the column has a default or is an identity |
| `cols`                | required                      | The columns: see below                                                                                                                                                                         |
| `unique`              | none                          | The sets of columns that are unique together: `[{ columns: ['teamId', 'email'], name? }]`                                                                                                      |
| `foreignKeys`         | none                          | `[{ columns, references: { table, columns?, onDelete?, onUpdate? }, name? }]`                                                                                                                  |
| `indexes`             | none                          | `[{ columns, unique?, using?, name? }]`, `using` being `'btree'` (default), `'hash'`, `'gin'`, `'gist'`, `'brin'` or `'spgist'`                                                                |
| `checks`              | none                          | `[{ name, expression? }]`: found by name; with an `expression`, the fix creates it                                                                                                             |
| `sync`                | `{ strategy: 'listen' }`      | How `LilypadDbCache` keeps the table up to date (see [Keeping the cache in sync with the database](#keeping-the-cache-in-sync-with-the-database))                                              |
| `strict`              | `strict` of the config        | See the config options                                                                                                                                                                         |

A table holds no function: the functions that transform its rows are bound by the application (see [Functions applied to the rows](#functions-applied-to-the-rows-bindlilypaddbhooks)).

The columns of `cols`:

| Field        | At runtime                                                                                                                                      | Checked by `lilypad-doctor`                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `type`       | The `type` of the primary key: with `'number'`, `LilypadDbCache` converts to numbers the ids that notifications and the changelog carry as text | What postgres.js returns for the column: one of `'string'`, `'number'`, `'bigint'` (an `int8`, returned as a string), `'boolean'`, `'date'`, `'json'` and `'array'`. It follows from a known `pgType`: declare it only for the other types (enums, domains, the types of extensions) or without `pgType`. Without `pgType`, checks that the database type is read by postgres.js as this type (a warning: e.g. a `numeric` or `bigint` column declared `'number'`) |
| `pgType`     | Gives the `type` when it is not declared                                                                                                        | The exact PostgreSQL type (`'uuid'`, `'int4'`, `'varchar(64)'`, `'timestamptz'`, `'text[]'`...), common aliases accepted (`int4` is `integer`, `timestamptz` is `timestamp with time zone`). Without it, the fix cannot create the column                                                                                                                                                                                                                          |
| `converted`  | Not used (types only)                                                                                                                           | The hooks convert the column (see [Functions applied to the rows](#functions-applied-to-the-rows-bindlilypaddbhooks)): its property in `T` is not compared with `type` and `pgType`                                                                                                                                                                                                                                                                                |
| `nullable`   | Not used                                                                                                                                        | Whether the column accepts `NULL`, when set                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `default`    | Not used                                                                                                                                        | `true`: the column has a default; `{ sql: 'now()' }`: the same, and the fix uses this expression. The installed expression is not compared                                                                                                                                                                                                                                                                                                                         |
| `unique`     | Not used                                                                                                                                        | A unique key on this column alone                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `references` | Not used                                                                                                                                        | A foreign key of this column: `{ table, column?, onDelete?, onUpdate? }`                                                                                                                                                                                                                                                                                                                                                                                           |

- `cols` must list **every property of `T`**. Only these columns are read and written: any other property of the data you pass is ignored. So you can pass a request body directly without the risk of writing columns such as `is_admin`. Properties set to `undefined` are not written either. The table may have other columns: `lilypad-doctor` warns only about a `NOT NULL` column without a default (the inserts of the library would fail), or about every one with `strict`.
- The library does not validate or convert values at runtime: postgres.js converts them, and `type` says what it returns. The `type` of a known `pgType` is given for you: `int2`/`int4`/`serial`/`real`/`float8` are `'number'`; `int8`/`bigserial` `'bigint'` and `numeric` `'string'` (postgres.js returns them as strings, so type them as `string` in `T`: their keys stay strings); `text`, `varchar`, `uuid`, `time`, `interval`, `inet`... `'string'`; `date`/`timestamp`/`timestamptz` `'date'`; `bool` `'boolean'`; `json`/`jsonb` `'json'`; any array `'array'` (`lilypadColumnTypesOfPgType` tells them). `defineLilypadDb` rejects a declared `type` that does not fit a known `pgType` (`int4` declared `'string'`).
- With `defineLilypadTable<T>`, TypeScript checks each column against its property of `T`: a `number` property needs `'number'` or a numeric `pgType` (`int4`, not `int8`), a `string` one `'string'`/`'bigint'` or a text, `uuid`, `int8`, `numeric`... `pgType`, a `Date` one a date or timestamp, an array an array or `json`, another object `json`. A `pgType` whose type is not known (an enum) needs its `type`: `{ type: 'string', pgType: 'user_role' }`. When the hooks convert a column (e.g. a `timestamptz` read as an ISO string), mark it `converted: true`.
- A foreign key references `table`, a table of the config with this `tableName`, or else a table of `defaultSchema` (or `'schema.table'`). The referenced columns default to the primary key of a table of the config; give them for another table. The actions (`'no action'`, the default, `'restrict'`, `'cascade'`, `'set null'`, `'set default'`) are checked.
- The unique keys, foreign keys and indexes are found by their columns, not by their `name`, which only names what the fix creates. A unique key is satisfied by the primary key, a unique constraint or a unique index (neither partial nor on expressions) on the same columns; an index by one with the same columns in the same order, and the same method.

### Functions applied to the rows (`bindLilypadDbHooks`)

The config describes the database only, so that `lilypad-doctor` can load it with Node.js alone. The functions that transform the rows usually import application code (validation, parsing, `server-only` modules, path aliases, JSON): the application binds them to the config, in the module that creates its gate.

```ts
// src/db.ts
import { bindLilypadDbHooks } from '@lilypad-studio/libs/schema';
import { LilypadDbGate } from '@lilypad-studio/libs/db';
import db from '../lilypad.config';
import { parseMember, sanitizeMember } from '@/members/rows';

export const appDb = bindLilypadDbHooks(db, {
  members: { write: sanitizeMember, select: parseMember },
});

export const gate = await LilypadDbGate.create({
  connectionString: process.env.DATABASE_URL!,
  config: appDb,
});
```

| Hook          | What it does                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `write(data)` | Applied to the data before every insert and update. Its result replaces the data, so a property it leaves out is not written. Only the `cols` columns of the result are written |
| `select(row)` | Builds `T` from a database row. It receives the whole row (`SELECT *`, and `RETURNING *` for the writes), and can return `null` to leave the row out of the results             |

- The hooks are typed with the row type of each table: `write: (data: Partial<Member>) => Partial<Member>`, `select: (row: Record<string, unknown>) => Member | null`. A key that is not a table of the config is a type error, and `bindLilypadDbHooks` throws for it.
- `bindLilypadDbHooks` returns a copy of the config (same name, settings and tables) and leaves `db` untouched. There is still one description of each table, in the config file; the copy only adds the functions.
- A gate created with the bound config applies the hooks to its tables however they are given: `gate.table('members')`, `LilypadDbCache.create({ gate, table: 'members' })`, and also `db.tables.members`, the definition of the original config. The rest of the application can keep importing `lilypad.config`. A gate without a config applies only the hooks of the definitions it is given: pass it `appDb.tables.members`.
- Binding a bound config again replaces the hooks given, and keeps the others.
- `LilypadDbCache.sqlCreate` returns, without caching it, a created row that `select` returns without its primary key (with a warning): the row is inserted, and failing would make the caller insert it again.

```ts
select: (row) => {
  if (typeof row.name !== 'string') return null; // skip malformed rows
  return { id: Number(row.id), slug: String(row.slug), name: row.name };
},
```

### Several configs

`lilypad.config.ts` holds the default config (`name: 'default'`). Other configs go in `lilypad.<name>.config.ts`, with `name: '<name>'`: another database, or the tables of one part of the application. A gate takes one config (`config`), whose tables it finds by key; a table of any other config can be given as its definition, or by key with the `config` it belongs to:

```ts
import db from './lilypad.config';
import analytics from './lilypad.analytics.config';

const gate = await LilypadDbGate.create({ connectionString, config: db });

const members = await LilypadDbCache.create({ ttl, gate, table: 'members' }); // from db, the config of the gate
const events = await LilypadDbCache.create({ ttl, gate, config: analytics, table: 'events' });
const sessions = await LilypadDbCache.create({ ttl, gate, table: analytics.tables.sessions });
```

`npx lilypad-doctor` checks the default config; `npx lilypad-doctor --config analytics` checks `lilypad.analytics.config.*`, and `--config ./path/to/file.ts` any file.

### Writing the config file

`lilypad-doctor` imports the config with Node.js, outside the application (no bundler, no path aliases), so:

- import only `@lilypad-studio/libs/schema` (it runs in edge runtimes too, and does not load postgres.js), the files of the config, and your types with `import type`. Type imports are erased before loading, so they may use path aliases and name application modules: `import type { Member } from '@/members/types'`. A type imported without `type` is kept by the type stripping of Node.js, and fails (`does not provide an export named`): `verbatimModuleSyntax` in `tsconfig.json` reports them;
- keep one file per config (`lilypad-doctor` refuses `lilypad.config.ts` next to `lilypad.config.mjs`);
- keep application code out of the config: its functions are bound by the application (see [Functions applied to the rows](#functions-applied-to-the-rows-bindlilypaddbhooks)), and `defineLilypadDb` rejects a table with a function;
- a TypeScript config is loaded by the type stripping of Node.js: Node.js 22.18 or later, or `NODE_OPTIONS=--experimental-strip-types` from 22.12 to 22.17. It may use only erasable syntax (no `enum`, no `namespace`, no parameter properties), and its relative imports need their extension (`import { teams } from './db/teams.ts'`, with `allowImportingTsExtensions` in `tsconfig.json`). Or write it as `.mjs`;
- the file name decides the config it is (`lilypad.config.ts`, `.mts`, `.mjs` or `.js`; `lilypad.<name>.config.*`), and a config found by name must have that `name`.

When the config does not load, the error says why when it can tell (a type imported as a value, an import Node.js cannot resolve) and what a config may import. `loadLilypadDbConfig({ config, cwd })` (from `@lilypad-studio/libs/db`) loads a config file from code, as the command does.

## LilypadDbGate

A PostgreSQL gateway: typed CRUD helpers for simple tables, the full postgres.js client for everything else, and `LISTEN/NOTIFY`.

```ts
import { LilypadDbGate } from '@lilypad-studio/libs/db';

const gate = await LilypadDbGate.create({
  connectionString: process.env.DATABASE_URL!,
  config: db, // optional: the config whose tables gate.table('<key>') finds
  // Optional: a different connection for LISTEN, for example a direct connection
  // when connectionString goes through PgBouncer in transaction mode
  listenerConnectionString: process.env.DATABASE_DIRECT_URL,
  listen: [], // optional: channels to subscribe to at startup (see below)
  statementTimeout: 10_000, // optional: Postgres cancels queries longer than this (default: 30 s)
  pool: { max: 10, idleTimeout: 30_000 }, // optional: pool size and timeouts, in ms
  listenHeartbeat: 15_000, // optional: how often the LISTEN connection is checked (default: 15 s)
  // logger,
  // singleton: 'main-db',
});

// ...
await gate.close(); // waits up to 5 s for the running queries, then closes both connections
```

- The gate connects on the first query: creating it opens no connection, unless `listen` subscribes to channels. If a `listen` subscription fails, `create()` closes the gate and rejects.
- `pool` configures the query pool. Every duration is in milliseconds, and an option you leave out keeps the postgres.js default:

  | Option           | postgres.js default | What it does                               |
  | ---------------- | ------------------- | ------------------------------------------ |
  | `max`            | 10                  | Maximum number of connections              |
  | `idleTimeout`    | never               | Closes connections idle for this long      |
  | `connectTimeout` | 30 s                | Fails a connection attempt after this long |
  | `maxLifetime`    | 30 to 60 min        | Closes connections older than this         |

- On serverless platforms, use `pool: lilypadServerlessPool` (`{ max: 3, idleTimeout: 5_000, connectTimeout: 10_000 }`: few connections per instance, closed quickly when idle) with a pooled connection string. Adjust `max` to the number of queries one instance runs in parallel: `pool: { ...lilypadServerlessPool, max: 5 }`.
- `statementTimeout` (default: 30 s; `false` keeps the setting of the database) is enforced by Postgres on the queries of the pool. A cache that times out (`fetchTimeout`) does not stop its query: this bound frees the connection, instead of leaving slow queries holding the pool while the queries behind them wait.
- `close({ timeout })` waits at most `timeout` ms (default: 5 s) for the running queries, then closes the connections. It returns the same promise when called again, and the gate then rejects queries and `addListener` (`gate.closed` tells whether it was closed).

### CRUD helpers

`gate.table(db.tables.posts)` returns the typed CRUD helpers of a table of a [config](#database-config) (a `LilypadDbTable`): every method uses its definition. `gate.table('posts')` finds the table in the config of the gate. The handle is cheap: keep one per table.

```ts
type Post = { id: number; title: string; body: string; published_at: Date | null };

const posts = gate.table(db.tables.posts);

// INSERT ... RETURNING: returns the row with the generated id
const { row: post } = await posts.insert({
  title: 'Hello',
  body: '...',
  published_at: null,
}); // no `id`: the database generates it

const all = await posts.selectAll(); // Post[], read in batches of 1 000 rows
const one = await posts.selectByPrimaryKey(1); // Post | null
const some = await posts.selectByPrimaryKeys([1, 2, 3]); // Post[], one query

// UPDATE ... WHERE id = 1: only the given columns are written
const { row: updated } = await posts.update({ id: 1, title: 'Updated' });

const { deleted } = await posts.delete(1); // false if the row did not exist
```

- `insert` and `update` resolve to `{ row, xid }`: the row as stored by the database, including generated columns (`null` if the `select` hook rejects it), and the id of the transaction that made the write, the one the changelog records. `LilypadDbCache` uses it to recognize its own writes. `delete` resolves to `{ deleted, xid }` (`xid` only if a row was deleted).
- The queries name the table with its schema (`"public"."posts"`), so they read the table that `lilypad-doctor` checked, whatever the `search_path`.
- The writes return only the `cols` columns (`RETURNING` lists them), or the whole row when the table has a `select` hook.
- `update` throws a `LilypadDbNotFoundError` (with `tableName` and `primaryKeyValue`) when no row has the primary key.
- `selectAll({ signal })` reads through an SQL cursor in one transaction (so a pooler must be in transaction or session mode), one `FETCH` of 1 000 rows at a time: `statementTimeout` bounds each batch, not the whole table. It stops reading, and closes its cursor, once the signal is aborted; it then rejects with the reason of the signal.
- `selectByPrimaryKeys` leaves out the keys without a row. It sends one query per 1 000 keys, since Postgres limits the parameters of a query.
- An insert or update throws before querying if the primary key is missing (`LilypadDbMissingPrimaryKeyError`: always required by updates; by inserts unless `generatedPrimaryKey`), or if no column is left to write (`LilypadDbEmptyWriteError`).
- Updates never write the primary key column: it only identifies the row.
- Once the gate is closed, every method rejects with a `LilypadDisposedError`.

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
- While channels are listened to, the gate sends a notification to itself every `listenHeartbeat` ms (default: 15 s) through the query pool. `gate.isListenHealthy()` is `true` while those heartbeats come back, and turns `false` after 2.5 intervals without one: the connection may be down, and notifications lost, even before postgres.js reconnects. `LilypadDbCache` stops trusting `LISTEN` meanwhile. Set `listenHeartbeat: false` to disable it (`isListenHealthy()` is then `true` once `LISTEN` is active on a channel).
- `addListener` rejects if `LISTEN` fails; the callback is then not registered, and a later call tries again.
- `removeListener` resolves to `false` when no such callback was registered. It never rejects: a failed `UNLISTEN` is logged.

## LilypadDbCache

A cache of the rows of a single table of a [config](#database-config). It reads rows through a `LilypadDbGate`, writes through to the database, and updates itself when the table changes elsewhere. It runs on the same engine as `LilypadCache` (TTL, stale values, shared level, fallbacks), but its values always come from the table: it has no `set`, `bulkSet`, `getOrSet` or `bulkSync`, since a value that does not come from the table could otherwise be kept past its TTL as if it did.

```ts
// In the config: type Account = { id: number; email: string; plan: string }
const accounts = defineLilypadTable<Account, 'id'>({
  tableName: 'accounts',
  primaryKey: 'id',
  generatedPrimaryKey: true,
  cols: { id: { type: 'number' }, email: { type: 'string' }, plan: { type: 'string' } },
});

// In the application
import { LilypadDbCache } from '@lilypad-studio/libs/db';

const accounts = await LilypadDbCache.create({
  ttl: 5 * 60_000,
  gate,
  table: db.tables.accounts, // or 'accounts', in the config of the gate (or in `config`)
  // logger, singleton, and every LilypadCache option (autoCleanupInterval, ...) are accepted
});
```

The row type (`Account`) and the key type (the type of the primary key, `number`) are inferred from the table. `create` compares nothing with the database: run [`lilypad-doctor`](#lilypad-doctor-checking-the-database) for that. `get(7)` and `get('7')` read the same entry. The cache's `name` (shared level keys, invalidation events, logs) defaults to the table name.

### Reading

```ts
const account = await accounts.getOrFetch(7);
// Account -> found (from the cache or from the database)
// null    -> no row with id 7 (this result is cached too)
// It rejects when the query fails, unless `onError` gives a fallback

const everyAccount = await accounts.getAll(); // Map<id, Account>: loads the whole table once, then serves it from the cache
const someAccounts = await accounts.getManyOrFetch([1, 2]); // Map<id, Account>: queries only the keys it does not hold
```

`getOrFetch(key, options)` accepts the options of [`getOrSet`](#getorset-read-through-the-cache) (`ttl`, `staleWhileRevalidate`, `timeout`, `onError`, ...). `getOrFetchDetailed(key, options)` also returns the `status` and `refreshFailed` of [`getOrSetDetailed`](#getorset-read-through-the-cache). `get()` reads memory only: a cache miss is fetched from the database by `getOrFetch`, not by `get`.

`getAll()` resolves to a `Map` of the rows keyed by primary key (like `LilypadCache.getAll()`), without the keys that have no row. It loads the whole table the first time. The cache then keeps track of the rows of the table (the writes, the fetches and the changes it learns about), and later calls query only the rows it does not hold up to date, by primary key, in one query: rows changed or inserted elsewhere, rows that expired. When those are more than a quarter of the table, it loads the whole table instead. It loads the whole table again only when it may have missed changes (the `LISTEN` connection was lost, or the changelog was not read for longer than `maxGap`), or, with the `none` strategy, after `bulkSync.ttl` (the option takes `ttl` and `timeout`, but no `fn`). `getManyOrFetch(keys)` returns the rows of some keys: it queries only the keys it does not hold up to date, and concurrent calls share the queries of the keys they have in common. Both reject when the rows cannot be loaded. With `maxEntries` smaller than the table, `getAll()` still returns every row, but queries most of them again at each call.

### Writing through the cache

These methods write to the database first, then cache the row that the database returns:

```ts
const created = await accounts.sqlCreate({ email: 'ada@example.com', plan: 'free' });
// created.id is the id generated by the database

await accounts.sqlUpdate({ id: created!.id, plan: 'pro' }); // LilypadDbNotFoundError if the row does not exist
await accounts.sqlDelete(created!.id); // true if a row was deleted; the key is then cached as null, even if protected
```

`sqlCreate` and `sqlUpdate` return `null` if the `select` hook of the table rejects the returned row. Each write sends a `write` event to `platform.onInvalidate`.

To reload a key from the database:

```ts
await accounts.refresh(7); // query, cache and return the row (null if it does not exist); throws on database errors
accounts.invalidate(7); // no query: the entry is expired, and the next read fetches it
```

`refresh` shares the query of a refresh of the same key already running; a call made while a query runs waits for one more query, which sees every change made before the call. It times out after `fetchTimeout`. `invalidate` behaves as in `LilypadCache`.

### Keeping the cache in sync with the database

If other instances or other programs (a script, an admin tool, a manual `UPDATE`) change the table, the cache would keep serving old rows until they expire. The `sync` of the table, in the config, chooses how the cache learns about those changes (`lilypad-doctor` checks that the database has the triggers it needs):

| Strategy                                  | How                                                                                                                      | Delay            | Suited to                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------- | ------------------------------------------------- |
| `{ strategy: 'changelog', pollInterval }` | A trigger records every change in a table; the cache reads the new rows at most once per `pollInterval`, when it is used | ≤ `pollInterval` | Serverless platforms, and any number of instances |
| `{ strategy: 'listen' }` (default)        | `LISTEN/NOTIFY` on a dedicated connection                                                                                | Near real time   | Long-running servers                              |
| `{ strategy: 'none' }`                    | Only the writes of this instance, and the TTL                                                                            | ≤ TTL            | Data no one else changes                          |

Both `changelog` and `listen` rely on a trigger. The library provides its SQL; run it once, in a migration:

```ts
import { lilypadChangelogSql, lilypadChangelogTriggerSql } from '@lilypad-studio/libs/db';

await sql.unsafe(lilypadChangelogSql()); // the changelog table and the trigger function
await sql.unsafe(lilypadChangelogTriggerSql({ table: 'accounts', primaryKey: 'id' })); // per table
```

The trigger records each change in the `lilypad_cache_changes` table and also sends a notification on the `cache_events` channel, so it serves both strategies. A second trigger, on each table, records `TRUNCATE`, which fires no row trigger. It records the schema of the table too, so tables of the same name in different schemas are not mixed up. It needs PostgreSQL 13 or later. Both functions return SQL that can safely be run again (`IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP TRIGGER IF EXISTS`).

- `lilypadChangelogSql({ changelogTable, notifyChannel, notifyBulkThreshold })`: `changelogTable` renames the changelog table (default: `LILYPAD_DEFAULT_CHANGELOG_TABLE`, that is `lilypad_cache_changes`; set the same `changelog.table` in the config). `notifyChannel: false` sends no notification, for the `changelog` strategy alone. The `listen` strategy of `LilypadDbCache` listens on the `notifyChannel` of the config (default: `cache_events`), so keep the two the same. A statement that changes more rows than `notifyBulkThreshold` (default 1000) sends one `BULK` notification instead of one per row: the caches then expire the whole table, instead of flooding the `NOTIFY` queue and re-reading each row.
- `lilypadChangelogTriggerSql({ table, primaryKey, changelogTable })`: `table` and `primaryKey` are those of the cached table; pass `changelogTable` if you renamed it. It creates one statement trigger per event (`<table>_lilypad_insert`, `_update`, `_delete`; a name longer than PostgreSQL keeps is shortened with a hash), which records all the rows of a statement in one query through its transition tables, and `<table>_lilypad_truncate` for `TRUNCATE`. Transition tables are not allowed on the partitions of a partitioned table: attach the triggers to the partitioned table itself. Run it in one transaction, so that no write goes unrecorded while the triggers are replaced.
- If you installed the changelog with an earlier version of the library, run both functions again, in one transaction: `lilypadChangelogSql()` updates the trigger function (version 6; a function of version 4 or 5 is still read correctly, and the schema check only warns about it), `lilypadChangelogTriggerSql()` replaces the row trigger of versions 3 and earlier with the statement triggers (and adds the `TRUNCATE` trigger if it is missing). The function no longer records the changes of a row trigger: until the triggers are replaced, the writes go on unrecorded (with a `WARNING` of the database), and the schema check reports `missing-changelog-trigger`. The changes recorded without a schema by version 1 are ignored.
- An `UPDATE` that changes the primary key is recorded as a `DELETE` of the old key followed by an `UPDATE` of the new one.
- Delete the old changelog rows, in one of three ways. `olderThan` (ms) must be much longer than `maxGap` and `lookback` (see [the changelog section of the Next.js guide](docs/nextjs-vercel.md#deleting-old-changelog-rows)).
  - `lilypadChangelogPruneScheduleSql({ olderThan, schedule, changelogTable, jobName, database })`: the SQL that schedules a [pg_cron](https://github.com/citusdata/pg_cron) job deleting them (daily at 3:00 UTC by default). Run it again to change the job.
  - `lilypadChangelogSql({ prune: { olderThan, every, batchSize } })`: the trigger deletes up to `batchSize` (default 1000) old rows on about one statement in `every` (default 20), in the writing transaction, through a `SECURITY DEFINER` function (the writing roles need no `DELETE` privilege). It prunes only in `READ COMMITTED` transactions. The schema check keeps these options in the SQL it suggests.
  - `pruneLilypadChangelog(gate, { olderThan, changelogTable, batchSize })`, from a job of your own: it deletes in batches of `batchSize` rows (default 10000), one statement each, and resolves to the number of deleted rows. An `olderThan` shorter than one hour (`LILYPAD_MIN_CHANGELOG_RETENTION`) throws, unless you pass `force: true`: it is in milliseconds, and a shorter retention deletes rows the caches may still have to read.
- `readLilypadChanges(gate, { tableName, since, changelogTable })` is the low-level read, if you want to consume the changelog yourself. It resolves to `{ changes, cursor }`; pass `since: { cursor }` on the next call (or `since: { lookback }` the first time). The cursor holds the transactions the read could not see yet (`xmax`, and `xip`, those still running), so each change is returned by exactly one read from a cursor, whatever the order of the commits, and a long-running transaction does not make every read return again the changes made since it started. A lookback read can return changes that an earlier read returned. A `TRUNCATE` change has `rowId: null`. The caches of a gate read their tables together, in one query.

```ts
// In the config
const accounts = defineLilypadTable<Account, 'id'>({
  // ...
  sync: { strategy: 'changelog', pollInterval: 5_000 },
});
```

`lilypad-doctor` prints the SQL that installs the changelog and the triggers the config needs, so you rarely have to call these functions yourself.

When the cache learns about a change of its table:

- on `INSERT` and `UPDATE`, it re-fetches (`listen`) or expires (`changelog`) the key if it holds it (or is fetching it). Expiring also discards a read of the key already running, which may predate the change, without a query. The keys notified together are re-fetched together, in one query by primary key (a statement that changes many rows notifies each of them). For other keys it sends no query. In every case it notes that the row exists, and the next `getAll` returns it;
- on `DELETE`, with `changelog`, it caches the key as `null` if it holds it (also for protected keys); a key it does not hold gets no entry, so a mass delete does not evict the rows it holds. With `listen`, it re-fetches the key if it holds it (the query returns `null` if the row is gone): any role connected to the database can send a notification, so the cache treats notifications as hints and never trusts their content without a query;
- on `TRUNCATE`, it expires every entry, and copies of the rows in the shared level are then ignored. With `changelog` it knows the table is empty, without a query; with `listen`, the next `getAll()` loads the table again;
- on a change of many rows (a `BULK` notification, or more than 1000 keys in one read of the changelog), it does the same as a `TRUNCATE` seen from a notification, with one invalidation event for the whole cache (`keys: []`), instead of following each key. From the changelog, it applies only the last change of each row of a read;
- notifications re-read at most 1000 keys per second: beyond this budget, the notified keys are only expired, and read again when the application asks for them, so that a flood of notifications (anyone connected can send one) cannot flood the database;
- a change made by `sqlCreate`, `sqlUpdate` or `sqlDelete` of the same instance is skipped when the cache still holds the row that write returned: the instance that writes does not query the row again;
- if it may have missed changes (the `LISTEN` connection was lost, or the changelog was not read for longer than `maxGap`), it marks every entry as expired.

A notification that is not valid JSON, or whose `op` is not one of `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE` and `BULK`, is ignored and logged as a warning. The caches of a gate share one listener on `cache_events`: each notification is parsed once, and handed to the caches of its table.

Rows are stored in the order the changes happened: a slow query can never overwrite the result of a newer one. A write whose row changed while it was running (a change applied meanwhile, or a read that may have seen the row before the write) is not cached: the next read fetches the row.

#### The TTL while the cache is in sync

With `listen` or `changelog`, as long as the sync is trusted (`LISTEN` active and its [heartbeat](#listening-to-notifications-listennotify) recent; changelog read within `maxGap`, and a read applied within `pollInterval`, two intervals with `poll: 'background'`), the cache sees every change of its table. `get` and `peek` never read the changelog: once no read was applied for `pollInterval`, they no longer keep a row past its TTL. A row that reaches its TTL without a change is then still up to date: the cache keeps it without a query, until it is `maxAge` old (default: 1 hour). `get`, `peek`, `getOrFetch` and `getAll` all see it as fresh. The TTL keeps bounding the shared level, which is never extended this way, and the copies read from it, which are queried again at their TTL.

`maxAge` bounds how long a change that the triggers do not see (triggers disabled, `session_replication_role = replica` during a restore) can go unnoticed. Set `maxAge: 0` to query the rows again at each TTL. With the `none` strategy the TTL applies as in `LilypadCache`.

The options of the `changelog` strategy, in the `sync` of the table:

| Option         | Default                              | What it does                                                                                                                                                              |
| -------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pollInterval` | required                             | Minimum time (ms) between two reads of the changelog. The cache reads it before a `getOrFetch` or `getAll` once this has passed, so changes are seen within it            |
| `poll`         | `'await'`                            | `'await'`: a read that falls due waits for the changelog. `'background'`: it does not wait, and may return data one interval older                                        |
| `maxGap`       | 1 hour                               | If the changelog has not been read for this long, the instance no longer trusts its memory and expires every entry                                                        |
| `lookback`     | TTL + `staleWhileRevalidate` + 1 min | On the first read, or after `maxGap`, the changes of this period are applied, which also removes older copies from the shared level                                       |
| `maxAge`       | 1 hour                               | How long a row can be kept past its TTL while the sync is trusted: see [The TTL while the cache is in sync](#the-ttl-while-the-cache-is-in-sync). `listen` accepts it too |

The changelog table and its pruning are options of the config (`changelog.table`, `changelog.pruning`), shared by its tables. The options of the `listen` strategy are `connect` (`'eager'`, the default: `create` resolves once `LISTEN` is active; `'lazy'`: on the first read), `applyChanges` and `maxAge`.

`LilypadDbCache.create` can change, for one cache, the options that do not change what the database must provide, with its own `sync` option: `maxAge`, `connect`, `applyChanges`, `onNotification` (see below), `pollInterval` and `poll`. The strategy, `maxGap` and `lookback` stay those of the config, which `lilypad-doctor` checks the database against:

```ts
const accounts = await LilypadDbCache.create({
  ttl,
  gate,
  table: 'accounts',
  sync: { connect: 'lazy' },
});
```

The caches of a gate that use the same changelog table read it together, in one query per poll. A failed read of the changelog is logged, and the read of the cache goes on with its current content; the next attempt waits for a backoff (from `pollInterval`, doubling up to one minute) instead of retrying at every read. A failed lazy `LISTEN` backs off the same way, from one second. The [Next.js guide](docs/nextjs-vercel.md#5-database-caches-keeping-every-instance-up-to-date) explains how to choose these values.

#### Custom notification triggers and callbacks

With `listen`, the cache expects JSON payloads on the channel of the config (`cache_events` by default) shaped like `{ "schema": "public", "table": "accounts", "id": 7, "op": "INSERT" | "UPDATE" | "DELETE" }`, where `id` is a number or a string: you can also send them from your own trigger. `schema` is optional: without it, the payload applies to a table of that name in any schema. To run your own code on each notification:

```ts
const accounts = await LilypadDbCache.create({
  ttl: 60_000,
  gate,
  table: 'accounts', // with sync: { strategy: 'listen' } in the config
  sync: {
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

## lilypad-doctor: checking the database

The library installs nothing in the database at runtime, and checks nothing there either: a missing trigger would leave a `listen` cache silently stale, a missing changelog would fail each of its reads, a missing column would fail the queries. `lilypad-doctor` compares the database with a [config](#database-config), for example in a deployment step, before the application starts. It connects with its own connection and only reads the catalogs:

```sh
npx lilypad-doctor init                                     # create lilypad.config.ts (see Database config)
npx lilypad-doctor --url "$DATABASE_URL"                    # lilypad.config.* in the working directory
npx lilypad-doctor --url "$DATABASE_URL" --config analytics # lilypad.analytics.config.*
npx lilypad-doctor --config ./db/lilypad.config.ts          # a file; the URL from DATABASE_URL
npx lilypad-doctor --env-file .env --url-env POSTGRES_URL   # the URL from POSTGRES_URL, in .env
npx lilypad-doctor --sql > migrations/fix.sql                # only the SQL that fixes the problems
npx lilypad-doctor --json                                   # a machine-readable result
```

The URL is `--url`, else the environment variable named by `--url-env` (default `DATABASE_URL`). `--env-file <path>` reads variables from a file such as `.env` (repeatable: the later files win, and a variable already set in the environment wins over the files), so a `package.json` script needs no shell expansion, which `cmd` on Windows lacks: `"db:check": "lilypad-doctor --env-file .env --url-env POSTGRES_URL"`.

It prints the problems and the SQL that fixes them, and exits with 0 when the database matches the config (warnings may be printed), 1 when it does not, and 2 when the check could not run (invalid arguments, config not found, unreachable database). The SQL comes in an order that runs as it is: the changelog first, then each table (a missing table is created with its schema, keys, checks, indexes and triggers), then the foreign keys. Read it before you run it: a type change or a `SET NOT NULL` can fail on the existing rows. A fix that must run in another database (a pg_cron job scheduled from the database pg_cron runs in) has its `fixDatabase`: the report shows it apart, and `--sql` prints it as a comment, out of the migration.

For each table of the config, it checks:

- the table: that it exists, in the schema of the config;
- its columns: that each column of `cols` exists, and its `pgType`, `type`, `nullable` and `default`; that no `NOT NULL` column without a default is missing from `cols`;
- its keys: that `primaryKey` is the primary key, and the unique keys, foreign keys (with their actions), indexes and checks of its description;
- its sync: with `changelog`, the changelog triggers of the table (recording `INSERT`, `UPDATE`, `DELETE` and `TRUNCATE`, on its primary key); with `listen`, triggers that notify the channel of the config on each of them (the changelog trigger, or your own); nothing with `none`.

When a table uses the `changelog` sync, it also checks the changelog table and its trigger function (installed by this version of the library), and how the changelog is pruned (see below).

From code, `runLilypadDoctor({ connectionString, config })` does the same, and resolves to the result, with its `text` and `assertOk()` (which throws a `LilypadSchemaCheckError` when the check found errors). Or run the check on a gate of your own:

```ts
import { checkLilypadSchema, lilypadSchemaCheckOptions } from '@lilypad-studio/libs/db';

const { ok, problems, tables } = await checkLilypadSchema(gate, lilypadSchemaCheckOptions(db));
for (const { code, severity, table, message, fix } of problems) {
  console.log(severity, code, table, message); // e.g. 'error' 'missing-column' 'public.members' ...
  if (fix) console.log(fix); // the SQL to run in a migration
}
```

`checkLilypadSchema(gate, options)` also takes the tables and what they need without a config (`{ tables: [{ table, primaryKey, changelog?, notifyChannel?, shape? }], changelog, notifyChannel }`): without a `shape`, only the table and its triggers are checked. `tables` gives the schema each table resolves to (`null` if it does not exist).

Each problem has a `severity`. `error`: the database is not what the config describes (the caches may serve stale data, the queries may fail); `ok` is `false`. `warning`: it works, but something needs attention; `ok` stays `true`.

| Code                                                                      | Severity        | When                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unsupported-version`                                                     | error           | PostgreSQL is older than 13 (the changelog needs `xid8`)                                                                                                                                                                                                         |
| `missing-table`                                                           | error           | The table does not exist. The fix creates it when every column has a `pgType`                                                                                                                                                                                    |
| `missing-column`                                                          | error           | A column of `cols` does not exist                                                                                                                                                                                                                                |
| `column-type-mismatch`                                                    | error / warning | The type is not the `pgType` (error), or does not fit the `type` (warning)                                                                                                                                                                                       |
| `column-nullability-mismatch`                                             | error           | The column accepts `NULL` although `nullable: false`, or the reverse                                                                                                                                                                                             |
| `missing-column-default`                                                  | error           | A column with `default` (or the primary key with `generatedPrimaryKey`) has no default                                                                                                                                                                           |
| `wrong-primary-key`                                                       | error / warning | `primaryKey` is not the primary key: an error if it is not unique, a warning if a unique index and `NOT NULL` make it a key anyway                                                                                                                               |
| `missing-unique-key`                                                      | error           | No unique constraint or index covers exactly the columns of a unique key                                                                                                                                                                                         |
| `missing-foreign-key`                                                     | error           | A foreign key does not exist (same columns, same referenced table and columns)                                                                                                                                                                                   |
| `foreign-key-mismatch`                                                    | error           | The foreign key exists, with other `ON DELETE` / `ON UPDATE` actions                                                                                                                                                                                             |
| `missing-index`                                                           | error / warning | An index does not exist: an error for a unique index, a warning otherwise                                                                                                                                                                                        |
| `missing-check`                                                           | error           | No check has this name                                                                                                                                                                                                                                           |
| `undeclared-required-column`                                              | warning         | A `NOT NULL` column without a default is not in `cols`: the inserts of the library fail                                                                                                                                                                          |
| `undeclared-column`, `undeclared-constraint`, `undeclared-index`          | warning         | With `strict`: a column, a unique key, foreign key or check, or an index that the config does not describe                                                                                                                                                       |
| `missing-changelog`                                                       | error           | The changelog table or its trigger function does not exist                                                                                                                                                                                                       |
| `outdated-changelog`                                                      | error / warning | Installed by an older version of the library: run `lilypadChangelogSql()` again, with the same `notifyChannel` (the suggested SQL keeps the channel of the installed function, or the one the check requires). A warning when the caches still read it correctly |
| `missing-changelog-trigger`                                               | error           | The changelog triggers are missing, disabled or not on every `INSERT`, `UPDATE` and `DELETE`                                                                                                                                                                     |
| `wrong-trigger-primary-key`                                               | error           | The changelog trigger records another column than the primary key                                                                                                                                                                                                |
| `missing-notify-trigger`                                                  | error           | No trigger notifies on the channel, or not on each of `INSERT`, `UPDATE` and `DELETE`                                                                                                                                                                            |
| `missing-truncate-trigger`                                                | error           | `TRUNCATE` is not recorded, or not notified: add it with `lilypadChangelogTriggerSql`, or handle `TG_OP = 'TRUNCATE'` in your own trigger                                                                                                                        |
| `short-changelog-retention`, `no-changelog-pruning`, `unpruned-changelog` | see below       | The pruning of the changelog                                                                                                                                                                                                                                     |

### Checking the pruning of the changelog

When a table of the config uses the `changelog` sync, `lilypad-doctor` also looks at how the old rows of the changelog are deleted, and suggests the best way for your database when it finds none:

| It finds                          | How                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The `prune` option of the trigger | The `lilypad-prune:` comment in the trigger function, which also gives its retention                                                                                                                                                                                                                                                                 |
| A pg_cron job                     | A job of `cron.job` (in this database) whose command is a `DELETE FROM` the changelog table. The retention is read from `make_interval(secs => ...)` (the SQL of the library) or an interval literal (`interval '7 days'`). Row-level security hides the jobs of the other roles, except from a superuser: create the job with the role of the check |
| That something deletes rows       | `pg_stat_user_tables.n_tup_del` of the changelog is not zero: a job it cannot see, such as `pruneLilypadChangelog` from a scheduled function, prunes it                                                                                                                                                                                              |

It cannot see a pg_cron job in another database (pg_cron often runs in `postgres`), nor a job of your application until it has deleted rows. Set `changelog: { pruning: 'external' }` in the config to tell it that you prune the changelog yourself.

When it finds none, it suggests the best pruning it can tell for the database. To choose it yourself, set `pruning: 'trigger'` (always the `prune` option of the trigger) or `pruning: 'cron'` (always a pg_cron job). With `'cron'`, if the role cannot read `cron.database_name` (managed hosts often hide it), the fix installs pg_cron in this database: on a host that fixes `cron.database_name` in its settings (e.g. Neon), set it to this database first. Both still report a pruning they find, as `'detect'` does.

| Code                        | Severity | When                                                                                                                                                                                | The fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `short-changelog-retention` | error    | A pruning found deletes rows that are not older than `minRetention`: a cache could miss changes without knowing it                                                                  | The same pruning (same `every`/`batchSize`, or same job name and schedule), with a retention of 4 × `minRetention`, at least 24 hours                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `no-changelog-pruning`      | warning  | None of the above, and `pruning` is not `'external'`                                                                                                                                | With `pruning: 'trigger'`, the `prune` option of the trigger; with `'cron'`, a pg_cron job (scheduled from the database pg_cron runs in, if known to be another one; else in this one). Otherwise the best pruning for the database: a pg_cron job where pg_cron is installed, or known to run in this database; a job scheduled from the database pg_cron runs in, if that is another one (`cron.database_name`, if the role can read it); otherwise the `prune` option of the trigger, which needs nothing (the message mentions pg_cron if the server has it). If the changelog is missing or outdated too, its fix installs it with that option, in one SQL |
| `unpruned-changelog`        | warning  | The oldest row of the changelog is older than the retention found (24 hours if unknown) plus 7 days: the pruning does not run, or does not keep up. Checked whatever `pruning` says | A `DELETE` of the old rows, once                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

`minRetention` is the retention the caches need: the largest of `changelog.minRetention` of the config (default: 1 hour) and the `maxGap` and `lookback` of the `changelog` tables. The default `lookback` depends on the TTL of each cache, which the config does not know: declare `lookback` in the sync of a table whose TTL plus `staleWhileRevalidate` exceeds `maxGap`.

## LilypadFlowControl

Wraps an async function with a timeout, retries, rate limiting and single-flight deduplication. `LilypadCache` uses it internally, and you can use it on its own:

```ts
import { LilypadFlowControl, LilypadTimeoutError } from '@lilypad-studio/libs';

const payments = new LilypadFlowControl({
  timeout: 3_000, // abort each attempt after 3 s (default: no timeout)
  retries: 2, // retry twice after the first failure (default: 0)
  rate: 1_000, // at most one new execution per second per consumer/function pair (default: no limit)
});

const result = await payments.executeFn({
  functionIdentifier: 'charge:user-42', // concurrent calls with the same id share one execution
  consumerIdentifier: 'user-42', // optional: the rate limit applies per consumer and function
  fn: (signal) => callPaymentApi('user-42', signal), // pass the signal on so a timeout cancels the work
  backOffTime: (attempt) => attempt * 500, // wait before retries (default: 200, 400, 800 ms... up to 30 s)
});
```

- **Typing:** the class is not generic: each execution is typed by its `fn` (here, the return type of `callPaymentApi`).
- **Single flight:** while an execution with a given `functionIdentifier` is running, other calls with the same identifier receive its promise. They do not start a new execution and are not rate limited, and their own options (`fn`, `timeout`, ...) are ignored: they share the outcome of the first call. Each caller handles an error on its own (`.catch`).
- **Per-call options:** `retries` and `timeout` in the options of `executeFn` override those of the instance for that execution, and are checked the same way (`retries` must be a non-negative integer: the call rejects before the first attempt otherwise). `shouldRetry(error, attempt)` returns `false` for an error that another attempt cannot fix: it is thrown at once. If `backOffTime` returns a delay a timer cannot hold, the call rejects with a `RangeError` whose `cause` is the error of the attempt.
- **Durations:** every timeout and delay given to a timer must be at most 2^31 - 1 ms (about 24.8 days): beyond it, a JavaScript timer fires at once, so the constructors and the calls throw instead.
- **Timeout:** a timed out attempt fails with a `LilypadTimeoutError` (`Operation timed out after <timeout>ms`, with the `timeout` as a property). Each attempt gets its own timeout, so with retries the whole execution can last `(retries + 1) × timeout` plus the backoff times. Each attempt gets an `AbortSignal` that is aborted when the timeout expires. JavaScript cannot stop a running promise, so pass the signal to `fetch`, to the database driver, and so on, or check `signal.aborted` yourself.
- **Rate limit:** a new execution started less than `rate` ms after the previous one for the same consumer/function pair fails with a `LilypadRateLimitError` (`Rate limit exceeded for ...`, with the limited key as `rateKey`). The call is rejected, not delayed. `rate: 0` disables it. Intervals are measured on the monotonic clock (`performance.now()`), so a step back of the system clock does not lock callers out.
- An execution refused by the rate limit rejects with a `LilypadRateLimitError`; one that failed rejects with the error of its last attempt.
- The constructor throws a `RangeError` for an invalid option (`NaN`, a negative duration, a fractional `retries`).

The individual steps are also available: `executeWithTimeout(fn, timeout?)`, `executeWithRetries({ executionFn, retries, backOffTime, shouldRetry })`, `rateLimit(key)` (synchronous: it throws when the limit is exceeded), `singleFlight(key, fn)` and `isInFlight(key)`.

## LilypadSerializer

Maps objects of one shape (`FROM`) to another shape (`TO`) and back. It is useful for compact storage or transport formats, because values equal to their default are left out:

```ts
import { LilypadSerializer } from '@lilypad-studio/libs';

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
} from '@lilypad-studio/libs';

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

The registry is stored on `globalThis`, so it is shared by the whole process, including copies of the library loaded from different bundles. Use identifiers that are unique across your application. The `create()` methods prefix their identifiers with the class name and a registry version (`LilypadDbGate@1:main-db`), so they never collide with yours, and two copies of the library whose instances are not compatible never share them. To drop one of those singletons, call its `close()`/`dispose()` rather than `removeLilypadSingletonInstance`. `getLilypadSingletonInstance` throws if the identifier is still being created by `getLilypadSingletonInstanceAsync`.

## Troubleshooting

For problems specific to serverless platforms (connections exhausted, lost logs, changes not seen), see the [troubleshooting section of the Next.js guide](docs/nextjs-vercel.md#10-troubleshooting).

**`LilypadDbCache` does not see changes made outside the application.**
Run [`lilypad-doctor`](#lilypad-doctor-checking-the-database): it reports a missing or disabled trigger, with the SQL that installs it. Check also that the `sync` of the table is not `{ strategy: 'none' }`, nor `listen` with `applyChanges: false`. With the `changelog` strategy, changes appear only after `pollInterval`, and only when the cache is read. To test the setup, run `SELECT pg_notify('cache_events', '{"table":"accounts","id":"7","op":"UPDATE"}');` and pass a logger with a `debug` component: the cache logs every payload it receives.

**Notifications stop arriving behind PgBouncer.**
`LISTEN` does not work through a pooler in transaction mode. Set `listenerConnectionString` to a direct connection to Postgres.

**`getOrSet` throws `Operation timed out after ...ms` (a `LilypadTimeoutError`, exported by `/cache`, `/db` and `/flow`).**
The fetch took longer than `fetchTimeout` (5 s by default). Increase it in the cache options, or use `onError` to return a fallback value. For database fetches, set `statementTimeout` on the gate too, so that Postgres stops the slow queries instead of letting them pile up.

**`Rate limit exceeded for ...` (a `LilypadRateLimitError`).**
A `LilypadFlowControl` with `rate` rejects new executions that come too soon. Catch the error, or use a different `consumerIdentifier` for each caller.

**The process does not exit.**
Open database connections keep Node.js running. Call `await dispose()` on every `LilypadDbCache`, then `close()` on the gate.

**My logger does not print anything from the library.**
The other modules log only through the logger you pass them, on the levels `error`, `warn`, `info` and `debug`. Check that you passed `logger` and that it has those methods (with a `LilypadLogger`, that those channels have components).

**`lilypad-doctor` cannot load `lilypad.config.ts`.**
Node.js loads it without a bundler: use Node.js 22.18 or later (or `NODE_OPTIONS=--experimental-strip-types`), import only `@lilypad-studio/libs/schema`, relative files with their extension, and types with `import type` (a type imported without `type` fails with `does not provide an export named`). Functions that need application code do not belong in the config: bind them with [`bindLilypadDbHooks`](#functions-applied-to-the-rows-bindlilypaddbhooks). See [Writing the config file](#writing-the-config-file).

**`the table must be a table of a config made with defineLilypadDb`.**
`gate.table()` and `LilypadDbCache.create()` take a table of a config (`db.tables.users`), or its key: pass the result of `defineLilypadDb`, not the object given to `defineLilypadTable`.

**`@lilypad-studio/libs` has no `LilypadDbGate` or `LilypadDbCache`.**
The database modules are exported by `@lilypad-studio/libs/db` only, so that the root entry never pulls in postgres.js and runs in edge runtimes.

**TypeScript: `Property 'info' does not exist on type 'LilypadLogger<...>'`.**
Type the variable as `LilypadLoggerType<...>`, not `LilypadLogger<...>`.

## Contributing

```bash
npm install
npm test                  # unit tests (npm run test:watch in watch mode)
npm run test:integration  # needs Docker (starts a PostgreSQL container)
npm run typecheck         # Node.js sources, then the edge entries without the Node.js types
npm run lint              # eslint (npm run lint:fix applies the fixes)
npm run format            # prettier (npm run format:check only checks)
npm run build             # dist/, then publint and arethetypeswrong on the package
npm run check             # everything the CI checks, except the integration tests
npx changeset             # describe a change for the changelog (see docs/releasing.md)
```

The pre-commit hook formats and lints the staged files (lint-staged), then runs the typecheck and the unit tests; the commit-msg hook requires a [conventional](https://www.conventionalcommits.org) message (`feat:`, `fix:`, `refactor:`, `chore:`...). The CI (`.github/workflows/ci.yml`) runs the checks on Node.js 22, 24 and 26, installs the packed package on Node.js 22.12 (the lowest supported version) to load every entry, and runs the integration tests. `dist/` is not committed: the release workflow builds and publishes it (see [docs/releasing.md](docs/releasing.md)). See [How @lilypad-studio/libs works](docs/how-it-works.md) for a guided tour of the internals, and [CLAUDE.md](CLAUDE.md) for condensed architecture notes.
