import {
  createLilypadSingletonAble,
  type LilypadSingletonAble,
  type LilypadSingletonRelease,
} from '@/singleton/LilypadSingleton';
import {
  type LilypadLoggerComponent,
  type LilypadLogRecord,
} from '@/logger/LilypadLoggerComponent';
import {
  formatLogValue,
  LILYPAD_DEFAULT_REDACTED_KEYS,
  lilypadErrorSummary,
  lilypadRedaction,
  NO_REDACTION,
  toLogJson,
} from '@/logger/formatLogValue';
import { runInBackground, type LilypadPlatform } from '@/platform/LilypadPlatform';
import type { LilypadLibLogLevel } from '@/logger/LilypadLibLogger';

/**
 * The options of {@link LilypadLogger.create}.
 *
 * @template T - The channel names: the keys of `components`.
 *
 * @property {Record<T, LilypadLoggerComponent<T>[]>} components - The components of each channel. Its keys
 * are the channels of the logger: the components never widen them (`NoInfer`), so that a logger
 * built from `new LilypadConsoleLogger()` without a type argument has the channels it is given.
 * @property {(error: unknown) => void | Promise<void>} [errorLogging] - Optional callback function to handle logging errors.
 * It is called once for each failing component. If it fails as well, both errors are written to `console.error`.
 * The failures of the messages it logs synchronously on this logger go to `console.error` only, so
 * that a failing component does not loop through it; it must not log on this logger after an `await`.
 */
export type LilypadLoggerOptions<T extends string> = {
  components: Record<T, LilypadLoggerComponent<NoInfer<T>>[]>;
  name?: string | undefined;
  errorLogging?: ((error: unknown) => void | Promise<void>) | undefined;
  /**
   * `platform.background` receives every message being sent, so that the instance stays alive
   * until it is sent even after the response (serverless platforms).
   */
  platform?: Pick<LilypadPlatform, 'background'> | undefined;
  /**
   * Called synchronously for every message: its fields are added to the record (e.g. a request id
   * read from `AsyncLocalStorage`). If it throws, the message is logged without context.
   */
  context?: (() => Record<string, unknown> | undefined) | undefined;
  /**
   * The keys whose values are replaced with `[Redacted]` in the messages and in the context, at
   * any depth (compared ignoring case, `-` and `_`). Defaults to
   * {@link LILYPAD_DEFAULT_REDACTED_KEYS} (authorization headers, cookies, passwords, tokens...);
   * extend it with `[...LILYPAD_DEFAULT_REDACTED_KEYS, 'ssn']`, or pass `false` to redact nothing.
   * The `parts` of a record are never redacted.
   */
  redact?: readonly string[] | false | undefined;
} & LilypadSingletonAble;

/** @deprecated Renamed {@link LilypadLoggerOptions}: the options go to `create`. */
export type LilypadLoggerConstructorOptions<T extends string> = LilypadLoggerOptions<T>;

/**
 * A channel method: it logs without being awaited (it never throws, and component errors go to
 * `errorLogging`). Await `logger.flush()` to wait until the messages are sent.
 */
type ChannelMethodFunction = (...message: unknown[]) => void;
type ChannelMethods<T extends string> = Record<T, ChannelMethodFunction>;

/**
 * A generic logger that dynamically creates logging methods based on component types.
 *
 * @template T - A string literal union type representing the available log types/channels
 *
 * @example
 * ```typescript
 * const logger = LilypadLogger.create<'info' | 'error' | 'warn'>({
 *   components: {
 *     info: [consoleComponent],
 *     error: [consoleComponent, fileComponent],
 *     warn: [consoleComponent]
 *   }
 * });
 *
 * logger.info('Information message');
 * logger.error('Error message');
 * logger.warn('Warning message');
 * await logger.flush(); // e.g. before the process exits
 * ```
 *
 * @remarks
 * The logger creates dynamic methods on the instance for each log type defined in the constructor options.
 * Each method accepts any number of values, formats them into one message and routes it to all
 * registered components of that type.
 * Errors thrown by components are caught and handled via the errorLogging callback if provided.
 */
export class LilypadLogger<T extends string> {
  private components: Record<T, LilypadLoggerComponent<T>[]> = {} as Record<
    T,
    LilypadLoggerComponent<T>[]
  >;

  /** The name given in the options, added to each record. */
  readonly name?: string | undefined;

  /** The messages still being sent, awaited by `flush`. */
  private _pending = new Set<Promise<void>>();

  /**
   * While `errorLogging` runs synchronously: the messages it logs, which are marked (their own
   * failures go to `console.error` only) and awaited by the report.
   */
  #reports: Promise<void>[] | undefined;

  /** Removes the logger from the singleton registry (a no-op if it is not a singleton). */
  readonly #release: LilypadSingletonRelease;

  /**
   * Creates a new LilypadLogger instance or retrieves a singleton instance.
   *
   * @template T - The channels: inferred from the keys of `components` (with the levels the other
   * Lilypad modules log on, 'error' | 'warn' | 'info' | 'debug', the logger can be passed to them)
   * @param options - Configuration options for the logger, and `singleton`: the identifier of the
   * singleton instance, if one is wanted
   * @returns A LilypadLogger instance typed according to the generic parameter T
   *
   * @example
   * // Create a new logger instance
   * const logger = LilypadLogger.create<'info' | 'error'>({
   *   components: { info: [new LilypadConsoleLogger()], error: [new LilypadConsoleLogger()] },
   * });
   *
   * @example
   * // Create or retrieve a singleton logger (later calls ignore their options)
   * const singletonLogger = LilypadLogger.create<'info' | 'error'>({
   *   singleton: 'app-logger',
   *   components: { info: [new LilypadConsoleLogger()], error: [new LilypadConsoleLogger()] },
   * });
   */
  public static create<T extends string = LilypadLibLogLevel>(
    options: LilypadLoggerOptions<T>
  ): LilypadLoggerType<T> {
    return createLilypadSingletonAble(
      'LilypadLogger',
      options,
      (release) => new LilypadLogger<T>(options, release) as LilypadLoggerType<T>,
      {
        // No secrets in these options: the signature can stay in clear text
        value: JSON.stringify([options.name, Object.keys(options.components).sort()]),
        onMismatch: () =>
          console.warn(
            `LilypadLogger singleton "${options.singleton ?? ''}" already exists with different options: the new options are ignored.`
          ),
      }
    );
  }

  private constructor(options: LilypadLoggerOptions<T>, release: LilypadSingletonRelease) {
    // Check that no T can override existing properties. `key in this` also covers inherited ones
    // (e.g. `constructor`, `toString`); fields are listed explicitly because, depending on the
    // compilation target, they may not be defined on the instance yet. `then` would make the logger
    // a thenable: returning it from an async function would call it instead of resolving to it.
    const reservedKeys = new Set(['components', 'register', 'flush', 'name', '_pending', 'then']);
    for (const key of Object.keys(options.components)) {
      if (reservedKeys.has(key) || key in this) {
        throw new Error(`Logger type "${key}" is reserved and cannot be used as a log channel.`);
      }
    }

    this.name = options.name;
    this.#release = release;
    const redaction =
      options.redact === false
        ? NO_REDACTION
        : lilypadRedaction(options.redact ?? LILYPAD_DEFAULT_REDACTED_KEYS);

    // Assign initial components
    for (const [type, comps] of Object.entries(options.components) as [
      T,
      LilypadLoggerComponent<T>[],
    ][]) {
      // Initialize components array
      this.components[type] = [...comps];
    }

    const { errorLogging } = options;
    const report =
      errorLogging &&
      (async (error: unknown): Promise<void> => {
        const reports: Promise<void>[] = [];
        const outer = this.#reports;
        this.#reports = reports;
        let outcome: Promise<unknown>;
        try {
          // Runs synchronously: an async function runs until its first `await`
          outcome = Promise.resolve(errorLogging(error));
        } catch (failure) {
          outcome = Promise.reject(failure);
        } finally {
          this.#reports = outer;
        }
        // The report includes the messages it logged, so that `flush()` waits for them too.
        // allSettled handles `outcome` at once: its rejection is never left unhandled
        const [settled] = await Promise.allSettled([outcome, ...reports]);
        if (settled?.status === 'rejected') {
          throw settled.reason;
        }
      });

    for (const type of Object.keys(this.components) as T[]) {
      // Create the function that logs to components
      const send = async (
        message: unknown[],
        context: Record<string, unknown> | undefined,
        fromErrorLogging: boolean
      ) => {
        let errors: unknown[];
        try {
          // Formatting stays inside the try: it must never make the returned promise reject
          const record: LilypadLogRecord<T> = {
            type,
            message: message.map((part) => formatLogValue(part, redaction)).join(' '),
            parts: message,
            timestamp: new Date(),
            loggerName: this.name,
            context: toLogContext(context, redaction),
            errors: logErrors(message, redaction),
          };
          // allSettled: a failing component must neither stop nor hide the errors of the others
          const results = await Promise.allSettled(
            this.components[type].map(async (component) => component.write(record))
          );
          errors = results
            .filter((result) => result.status === 'rejected')
            .map((result): unknown => result.reason);
        } catch (error) {
          errors = [error];
        }
        for (const error of errors) {
          // A message logged by errorLogging that fails would call it again, without end
          await reportComponentError(type, error, fromErrorLogging ? undefined : report);
        }
      };

      const logFn = (...message: unknown[]): void => {
        // The context is read synchronously, while the caller's async context is still active
        const reports = this.#reports;
        const task = send(message, readContext(options.context), reports !== undefined);
        reports?.push(task);
        this._pending.add(task);
        void task.finally(() => this._pending.delete(task));
        // `task` never rejects: the error handler is only required by runInBackground
        runInBackground(options.platform, task, () => {});
      };

      // Assign the function directly to the class instance (this)
      (this as ChannelMethods<T>)[type] = logFn;
    }
  }

  /**
   * Registers new logger components for specified types.
   * @param newComponents - A partial record mapping component types to arrays of logger components to register
   * @returns The current logger instance for method chaining
   */
  register(newComponents: Partial<Record<T, LilypadLoggerComponent<T>[]>>): this {
    for (const type of Object.keys(newComponents) as T[]) {
      // hasOwn: `constructor` or `toString` would be found on the prototype
      if (!Object.hasOwn(this.components, type)) {
        throw new Error(
          `Logger type "${type}" was not defined when the logger was created and cannot be registered.`
        );
      }
      this.components[type].push(...(newComponents[type] ?? []));
    }
    return this;
  }

  /**
   * Resolves once every message logged so far has been sent (or has failed and been reported, with
   * the messages `errorLogging` logged synchronously about it). The messages logged after the call
   * are not waited for, so that a steady stream of messages cannot keep it pending.
   * Useful before the process exits, or at the end of a serverless request without `platform`.
   */
  async flush(): Promise<void> {
    // Promise.all reads the set now: the messages logged meanwhile are not in it
    await Promise.all(this._pending);
  }

  /**
   * Waits for the messages logged so far (as `flush` does), then removes the logger from the
   * singleton registry, so that the next `create` with its `singleton` identifier builds a new
   * logger. The logger holds no resources: its channel methods keep working afterwards.
   */
  async dispose(): Promise<void> {
    await this.flush();
    this.#release();
  }

  /** `await using logger = ...` disposes of the logger at the end of the scope. */
  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }
}

function readContext(
  context: (() => Record<string, unknown> | undefined) | undefined
): Record<string, unknown> | undefined {
  try {
    return context?.();
  } catch {
    return undefined;
  }
}

/**
 * The Error objects among the parts of a message, redacted like the message. An error whose fields
 * cannot be read must not lose the message: see `lilypadErrorSummary`.
 */
function logErrors(parts: unknown[], redaction: ReadonlySet<string>): LilypadLogRecord['errors'] {
  const errors = parts.filter((part): part is Error => part instanceof Error);
  if (errors.length === 0) {
    return undefined;
  }
  return errors.map((error) => lilypadErrorSummary(error, redaction));
}

/**
 * The JSON-safe copy of the context, always an object: what is not one (e.g. the marker of a
 * context that could not be formatted) is kept under `context`.
 */
function toLogContext(
  context: Record<string, unknown> | undefined,
  redaction: ReadonlySet<string>
): Record<string, unknown> | undefined {
  if (context === undefined) {
    return undefined;
  }
  const json = toLogJson(context, redaction);
  return typeof json === 'object' && json !== null && !Array.isArray(json)
    ? (json as Record<string, unknown>)
    : { context: json };
}

/**
 * Reports the error of a logger component. It never rejects: channel methods are called
 * fire-and-forget, so a rejection would be unhandled and terminate the Node.js process.
 */
async function reportComponentError(
  type: string,
  error: unknown,
  errorLogging?: (error: unknown) => void | Promise<void>
): Promise<void> {
  if (errorLogging) {
    try {
      await errorLogging(error);
      return;
    } catch (loggingError) {
      console.error(`Error in errorLogging callback for type "${type}":`, loggingError);
    }
  }
  console.error(`Error in logger component for type "${type}":`, error);
}

export type LilypadLoggerType<T extends string> = LilypadLogger<T> & ChannelMethods<T>;

export type { LilypadLibLogger, LilypadLibLogLevel } from './LilypadLibLogger';
