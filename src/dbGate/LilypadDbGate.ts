import { createHash } from 'node:crypto';
import { LilypadDisposedError } from '@/cache/LilypadCacheTypes';
import {
  resolveLilypadDbTable,
  type LilypadDbConfig,
  type LilypadDbPrimaryKey,
  type LilypadDbRow,
  type LilypadDbTableDefinition,
  type LilypadDbTableName,
} from '@/dbConfig/LilypadDbConfig';
import { LilypadDbTable } from '@/dbGate/LilypadDbTable';
import { LilypadListenHeartbeat } from '@/dbGate/LilypadListenHeartbeat';
import { LilypadBackoff } from '@/internal/LilypadBackoff';
import { assertNumberOption } from '@/internal/LilypadValidation';
import { libLog, type LilypadLibLogger } from '@/logger/LilypadLibLogger';
import {
  createLilypadSingletonAbleAsync,
  type LilypadSingletonAble,
  type LilypadSingletonRelease,
} from '@/singleton/LilypadSingleton';
import postgres from 'postgres';

type ListenerCallback = (payload: unknown) => void | Promise<void>;
/** A callback registered on a channel with `addListener`. */
export type LilypadDbListener = {
  channel: string;
  callbackId: string;
  callback: ListenerCallback;
  /**
   * Called when LISTEN is active again after the listener connection was lost and re-established.
   * Notifications sent while the connection was down are lost: use it to resynchronize.
   */
  onReconnect?: (() => void | Promise<void>) | undefined;
};
export type LilypadDbGateOptions<
  C extends LilypadDbConfig | undefined = LilypadDbConfig | undefined,
> = {
  logger?: LilypadLibLogger | undefined;
  connectionString: string;
  /**
   * The config of the database (see `defineLilypadDb`): `gate.table('users')` and
   * `LilypadDbCache.create({ gate, table: 'users' })` then find the table in it. A table of another
   * config can still be given as a definition (`other.tables.events`), or with its own `config`.
   */
  config?: C | undefined;
  /** The connection used for `LISTEN`, if not `connectionString` (e.g. a direct, unpooled one). */
  listenerConnectionString?: string | undefined;
  listen?: LilypadDbListener[] | undefined;
  /**
   * Maximum duration of each query of the main client, in milliseconds (Postgres
   * `statement_timeout`): the server cancels longer queries. A caller that times out (e.g. after
   * the `fetchTimeout` of a cache) does not stop its query: without this bound, slow queries would
   * keep the connections of the pool busy, and the queries behind them would wait. Defaults to
   * 30 seconds; `false` leaves the setting of the database.
   */
  statementTimeout?: number | false | undefined;
  /** Connection pool of the main client. Every duration is in milliseconds. */
  pool?: LilypadDbPoolOptions | undefined;
  /**
   * While channels are listened to, a notification is sent to a private channel every this many
   * ms, to detect a `LISTEN` connection that stopped delivering notifications (see
   * `isListenHealthy`). `false` disables it. Defaults to 15 seconds.
   */
  listenHeartbeat?: number | false | undefined;
};

export type LilypadDbPoolOptions = {
  /** Maximum number of connections (postgres.js default: 10). */
  max?: number | undefined;
  /** Closes connections idle for this long (postgres.js default: never). */
  idleTimeout?: number | undefined;
  /** Fails a connection attempt after this long (postgres.js default: 30 s). */
  connectTimeout?: number | undefined;
  /** Closes connections older than this (postgres.js default: 30 to 60 minutes). */
  maxLifetime?: number | undefined;
};

/**
 * Pool settings for serverless platforms (e.g. Vercel Functions), where many short-lived instances
 * each open their own pool:
 * - few connections per instance, so that many instances do not exhaust the database;
 * - idle connections closed quickly, so that a suspended instance does not keep them open.
 *
 * Use it with a pooled connection string (e.g. PgBouncer in transaction mode). Adjust `max` to the
 * number of queries a single instance runs in parallel.
 */
export const lilypadServerlessPool: Readonly<LilypadDbPoolOptions> = Object.freeze({
  max: 3,
  idleTimeout: 5_000,
  connectTimeout: 10_000,
});

/** postgres.js takes durations in seconds. */
function toPostgresPoolOptions(pool: LilypadDbPoolOptions | undefined) {
  const seconds = (ms: number | undefined) => (ms === undefined ? undefined : ms / 1000);
  return Object.fromEntries(
    Object.entries({
      max: pool?.max,
      idle_timeout: seconds(pool?.idleTimeout),
      connect_timeout: seconds(pool?.connectTimeout),
      max_lifetime: seconds(pool?.maxLifetime),
    }).filter(([, value]) => value !== undefined)
  );
}

type LilypadDbGateOptionsWithSingleton<C extends LilypadDbConfig | undefined> =
  LilypadDbGateOptions<C> & LilypadSingletonAble;

const DEFAULT_STATEMENT_TIMEOUT = 30_000;
/** How long `close` waits for the queries still running, in ms, by default. */
const DEFAULT_CLOSE_TIMEOUT = 5_000;
const DEFAULT_LISTEN_HEARTBEAT = 15_000;

type ChannelListener = {
  callbacks: Map<string, LilypadDbListener>;
  /** Resolves, once LISTEN is active on the channel, with the function that stops listening. */
  ready: Promise<() => Promise<void>>;
  /** Becomes true on the first LISTEN: later ones are reconnections. */
  listening: boolean;
};

/**
 * A gateway to a PostgreSQL database: typed CRUD helpers over the tables of a config (through
 * {@link LilypadDbGate.table}), and channel listeners (`LISTEN/NOTIFY`) with reconnection handling.
 *
 * @typeParam C - The config the gate was created with, whose tables can be named.
 *
 * @example
 * ```typescript
 * const gate = await LilypadDbGate.create({
 *   connectionString: 'postgres://user:pass@host:port/db',
 *   config: db, // the default export of lilypad.config.ts
 *   listen: [
 *     { channel: 'my_channel', callbackId: 'my_callback', callback: (payload) => console.log(payload) }
 *   ]
 * });
 * ```
 */
export class LilypadDbGate<C extends LilypadDbConfig | undefined = LilypadDbConfig | undefined> {
  public readonly id: string = `LilypadDbGate-${globalThis.crypto.randomUUID()}`;
  public readonly sql: postgres.Sql;
  /** The config given to `create`, if any. */
  public readonly config: C;
  /** Only when `listenerConnectionString` differs: otherwise `sql` listens. */
  private readonly listenerClient?: postgres.Sql | undefined;
  protected logger?: LilypadLibLogger | undefined;
  private listeners = new Map<string, ChannelListener>();
  private releaseSingleton: LilypadSingletonRelease = () => {};
  private readonly heartbeat?: LilypadListenHeartbeat | undefined;
  private readonly heartbeatChannel = `lilypad_heartbeat_${this.id.slice(-36).replace(/-/g, '')}`;
  private heartbeatStop?: Promise<() => Promise<void>> | undefined;
  /** A heartbeat that could not start is retried after a backoff (see `isListenHealthy`). */
  private readonly heartbeatBackoff = new LilypadBackoff(() => 1000);
  private closing?: Promise<void> | undefined;

  private constructor(options: LilypadDbGateOptions<C>) {
    if (options.statementTimeout !== false) {
      assertNumberOption('LilypadDbGate', 'statementTimeout', options.statementTimeout, 'positive');
    }
    if (options.listenHeartbeat !== false) {
      assertNumberOption(
        'LilypadDbGate',
        'listenHeartbeat',
        options.listenHeartbeat,
        'positive-delay'
      );
    }
    this.logger = options.logger;
    this.config = options.config as C;
    const statementTimeout = resolveStatementTimeout(options);
    this.sql = postgres(options.connectionString, {
      prepare: false,
      ...toPostgresPoolOptions(options.pool),
      ...(statementTimeout !== undefined && {
        connection: { statement_timeout: statementTimeout },
      }),
    });
    const listenerConnectionString = options.listenerConnectionString;
    if (listenerConnectionString && listenerConnectionString !== options.connectionString) {
      // postgres.js opens its own single, long-lived connection for LISTEN: no pool options needed
      this.listenerClient = postgres(listenerConnectionString);
    }
    if (options.listenHeartbeat !== false) {
      this.heartbeat = new LilypadListenHeartbeat(
        options.listenHeartbeat ?? DEFAULT_LISTEN_HEARTBEAT,
        () => this.sql`SELECT pg_notify(${this.heartbeatChannel}, '')`,
        (error) => libLog(this.logger, 'debug', this.id, 'LISTEN heartbeat failed:', error)
      );
    }
  }

  /**
   * Creates a gate and registers the listeners of `options.listen`.
   * Without listeners it opens no connection: the pool connects on the first query, so creating a
   * gate at module level does not reach the database (e.g. during a build).
   * With `singleton: '<identifier>'`, a later call with the same identifier returns the existing gate and
   * ignores its own options (a warning is logged if they differ).
   */
  static async create<C extends LilypadDbConfig | undefined = undefined>(
    options: LilypadDbGateOptionsWithSingleton<C>
  ): Promise<LilypadDbGate<C>> {
    return createLilypadSingletonAbleAsync(
      'LilypadDbGate',
      options,
      async (release) => {
        const instance = await LilypadDbGate.initializeNew(options);
        instance.releaseSingleton = release;
        return instance;
      },
      {
        // Hashed: the connection strings contain credentials
        value: createHash('sha256')
          .update(
            JSON.stringify([
              options.connectionString,
              options.listenerConnectionString,
              resolveStatementTimeout(options),
              options.pool,
              options.listenHeartbeat,
              options.config?.name,
              // The callbacks themselves cannot be compared: a gate reused without the listeners
              // of this call at least warns
              (options.listen ?? []).map(({ channel, callbackId }) => [channel, callbackId]),
            ])
          )
          .digest('hex'),
        onMismatch: () =>
          libLog(
            options.logger,
            'warn',
            'LilypadDbGate',
            `Singleton "${options.singleton ?? ''}" already exists with different connection options, config or listeners: the new options are ignored (add the listeners with addListener).`
          ),
      }
    );
  }

  private static async initializeNew<C extends LilypadDbConfig | undefined>(
    options: LilypadDbGateOptions<C>
  ): Promise<LilypadDbGate<C>> {
    const instance = new LilypadDbGate<C>(options);
    try {
      for (const listenOption of options.listen ?? []) {
        await instance.addListener(listenOption);
      }
    } catch (error) {
      // Do not leak the connection pools of an instance that is never returned
      await instance.close();
      throw error;
    }
    return instance;
  }

  /**
   * The typed CRUD helpers of a table: a table of a config (`db.tables.users`), or the key of a
   * table of the config of the gate (`'users'`). The handle is cheap: create one per table and
   * keep it, or call `table` again.
   *
   * @throws If the table is given by name and the config of the gate has no such table.
   */
  table<T, PK extends keyof T = keyof T>(
    definition: LilypadDbTableDefinition<T, PK>
  ): LilypadDbTable<T, PK>;
  table<N extends LilypadDbTableName<C>>(
    name: N
  ): LilypadDbTable<LilypadDbRow<C, N>, LilypadDbPrimaryKey<C, N>>;
  table(table: unknown): unknown {
    return new LilypadDbTable(
      this,
      resolveLilypadDbTable('LilypadDbGate', table, this.config) as LilypadDbTableDefinition<
        unknown,
        never
      >
    );
  }

  // LISTENER MANAGEMENT

  /** The client that listens: postgres.js keeps one dedicated connection per client for LISTEN. */
  private listenClient(): postgres.Sql {
    return this.listenerClient ?? this.sql;
  }

  /**
   * Starts listening on the specified channel.
   *
   * The listener entry is registered immediately, before LISTEN is active, so that concurrent
   * `addListener` calls for the same channel share it and await the same `ready` promise.
   * If LISTEN fails, the entry is removed, so that a later `addListener` call retries it.
   *
   * The postgres.js callbacks act only while the entry is the current one of the channel: a LISTEN
   * that failed stays registered in postgres.js (which gives no `unlisten` for it, and listens to it
   * again on every reconnection), and a removed entry is still called until its UNLISTEN is sent.
   */
  private initializeListener(channel: string): ChannelListener {
    libLog(this.logger, 'debug', this.id, `Initializing listener for channel "${channel}".`);
    const isCurrent = () => this.listeners.get(channel) === listener;
    const listener: ChannelListener = {
      callbacks: new Map(),
      listening: false,
      ready: this.listenClient()
        .listen(
          channel,
          (payload) => {
            if (isCurrent()) {
              this.executeAllListenerCallbacks(channel, listener, payload);
            }
          },
          // postgres.js calls it on the first LISTEN and again after every reconnection
          () => {
            if (!isCurrent()) {
              return;
            }
            if (listener.listening) {
              this.executeReconnectCallbacks(channel, listener);
            }
            listener.listening = true;
          }
        )
        .then((meta) => () => meta.unlisten())
        .catch((error: unknown) => {
          if (isCurrent()) {
            this.listeners.delete(channel);
          }
          // postgres.js keeps the callbacks: do not keep the listeners alive through them
          listener.callbacks.clear();
          throw error;
        }),
    };
    this.listeners.set(channel, listener);
    return listener;
  }

  /**
   * Runs a listener callback, catching both synchronous throws and rejected promises,
   * so a failing callback can neither affect the others nor cause an unhandled rejection.
   */
  private runCallbackSafely(
    channel: string,
    callbackId: string,
    callback: () => void | Promise<void>
  ) {
    Promise.resolve()
      .then(callback)
      .catch((error: unknown) => {
        libLog(
          this.logger,
          'error',
          this.id,
          `Error in listener callback "${callbackId}" for channel "${channel}":`,
          error
        );
      });
  }

  /** Runs every callback of a channel with the payload of a notification. */
  private executeAllListenerCallbacks(
    channel: string,
    listener: ChannelListener,
    payload: unknown
  ) {
    for (const [callbackId, { callback }] of listener.callbacks) {
      this.runCallbackSafely(channel, callbackId, () => callback(payload));
    }
  }

  private executeReconnectCallbacks(channel: string, listener: ChannelListener) {
    libLog(
      this.logger,
      'warn',
      this.id,
      `LISTEN on channel "${channel}" was re-established: notifications sent meanwhile are lost.`
    );
    for (const [callbackId, identifier] of listener.callbacks) {
      if (identifier.onReconnect) {
        this.runCallbackSafely(channel, callbackId, () => identifier.onReconnect?.());
      }
    }
  }

  /**
   * Adds a listener callback for a channel. Adding a callback with an existing `callbackId` on the
   * same channel replaces the previous one.
   *
   * @returns A promise that resolves once LISTEN is active on the channel.
   * @throws If LISTEN fails; in that case the callback is not registered.
   */
  async addListener(identifier: LilypadDbListener): Promise<void> {
    this.assertOpen();
    const { channel, callbackId } = identifier;
    libLog(
      this.logger,
      'debug',
      this.id,
      `Adding listener for channel "${channel}" with callback ID "${callbackId}".`
    );
    const listener = this.listeners.get(channel) ?? this.initializeListener(channel);
    listener.callbacks.set(callbackId, identifier);
    await listener.ready;
    // Unless the callback was removed while LISTEN was starting
    if (this.listeners.get(channel) === listener) {
      await this.startHeartbeat();
    }

    libLog(
      this.logger,
      'debug',
      this.id,
      `Listener for channel "${channel}" has ${listener.callbacks.size} callbacks.`
    );
  }

  /**
   * Removes a listener callback. When the channel has no callbacks left, it stops listening to it.
   * It never rejects: a failed UNLISTEN is logged (the connection keeps the channel, whose
   * notifications are then ignored).
   *
   * @returns `true` if the callback was registered.
   */
  async removeListener(channel: string, callbackId: string): Promise<boolean> {
    const listener = this.listeners.get(channel);
    if (!listener?.callbacks.delete(callbackId)) {
      return false;
    }
    if (listener.callbacks.size === 0) {
      this.listeners.delete(channel);
      if (this.listeners.size === 0) {
        await this.stopHeartbeat();
      }
      try {
        const unlisten = await listener.ready;
        await unlisten();
      } catch (error) {
        // LISTEN itself failed (nothing to undo), or UNLISTEN failed
        libLog(this.logger, 'warn', this.id, `Could not stop listening on "${channel}":`, error);
      }
    }
    return true;
  }

  /** Starts the heartbeat, unless it is running or starting. It never rejects. */
  private async startHeartbeat() {
    const heartbeat = this.heartbeat;
    if (!heartbeat || this.heartbeatStop || this.closing) {
      return;
    }
    const starting: Promise<() => Promise<void>> = this.listenClient()
      .listen(this.heartbeatChannel, () => heartbeat.beat())
      .then((meta) => {
        // Unless stopHeartbeat (or close) ran meanwhile: it awaits this promise to UNLISTEN
        if (this.heartbeatStop === starting) {
          heartbeat.start();
        }
        return () => meta.unlisten();
      });
    this.heartbeatStop = starting;
    try {
      await starting;
      this.heartbeatBackoff.succeed();
    } catch (error) {
      // Until it starts, isListenHealthy() stays false: the caches just trust LISTEN less
      if (this.heartbeatStop === starting) {
        this.heartbeatStop = undefined;
      }
      this.heartbeatBackoff.fail();
      libLog(this.logger, 'warn', this.id, 'Could not start the LISTEN heartbeat:', error);
    }
  }

  private async stopHeartbeat() {
    const stop = this.heartbeatStop;
    this.heartbeatStop = undefined;
    this.heartbeat?.stop();
    try {
      await (
        await stop
      )?.();
    } catch {
      // The heartbeat is only a diagnostic
    }
  }

  /**
   * Whether the `LISTEN` connection is known to deliver notifications: a heartbeat came back
   * recently. Without heartbeat (`listenHeartbeat: false`), `true` as soon as LISTEN is active on
   * a channel. `false` while no channel is listened to.
   */
  isListenHealthy(): boolean {
    if (!this.heartbeat) {
      return [...this.listeners.values()].some((listener) => listener.listening);
    }
    if (!this.heartbeatStop && this.listeners.size > 0 && this.heartbeatBackoff.ready()) {
      // The heartbeat could not start: retried here, since the caches ask this before trusting
      void this.startHeartbeat();
    }
    return this.heartbeat.healthy();
  }

  /** Whether `close` was called: the gate then rejects every query and listener. */
  get closed(): boolean {
    return this.closing !== undefined;
  }

  /** @throws {LilypadDisposedError} If the gate is closed. */
  assertOpen(): void {
    if (this.closing) {
      throw new LilypadDisposedError(`LilypadDbGate "${this.id}"`, 'closed');
    }
  }

  /**
   * Closes the connections, after the queries still running (for at most `timeout` ms; the ones
   * still running then are cancelled). Later queries and listeners are rejected. Calling it again
   * returns the same promise.
   *
   * @param options.timeout - How long to wait for the running queries, in ms. Defaults to 5 s.
   * @throws If the timeout is not valid: the gate then stays open.
   */
  close(options: { timeout?: number | undefined } = {}): Promise<void> {
    // Checked before the gate counts as closed: otherwise it would be closed without ending its pools
    assertNumberOption('LilypadDbGate', 'close timeout', options.timeout, 'non-negative-delay');
    this.closing ??= this.closeConnections(options.timeout ?? DEFAULT_CLOSE_TIMEOUT);
    return this.closing;
  }

  /** `await using gate = ...` closes the gate at the end of the scope. */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  private async closeConnections(timeout: number) {
    this.listeners.clear();
    this.heartbeat?.stop();
    this.heartbeatStop = undefined;
    this.releaseSingleton();

    // postgres.js takes seconds
    await Promise.all([
      this.listenerClient?.end({ timeout: timeout / 1000 }),
      this.sql.end({ timeout: timeout / 1000 }),
    ]);
  }
}

function resolveStatementTimeout(options: LilypadDbGateOptions): number | undefined {
  return options.statementTimeout === false
    ? undefined
    : (options.statementTimeout ?? DEFAULT_STATEMENT_TIMEOUT);
}
