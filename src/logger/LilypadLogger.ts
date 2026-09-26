import {
  createLilypadSingletonAble,
  type LilypadSingletonAble,
} from '@/singleton/LilypadSingleton';
import { LilypadLoggerComponent, type LilypadLogRecord } from '@/logger/LilypadLoggerComponent';
import { formatLogValue } from '@/logger/formatLogValue';
import { runInBackground, type LilypadPlatform } from '@/platform/LilypadPlatform';
import type { LilypadLibLogLevel } from '@/logger/LilypadLibLogger';

/**
 * Options for constructing a {@link LilypadLogger} instance.
 *
 * @template T - A string literal type representing component names.
 *
 * @property {Record<T, LilypadLoggerComponent<T>[]>} components - A record mapping component names to arrays of logger components.
 * @property {(error: unknown) => void | Promise<void>} [errorLogging] - Optional callback function to handle logging errors.
 * It is called once for each failing component. If it fails as well, both errors are written to `console.error`.
 */
export type LilypadLoggerConstructorOptions<T extends string> = {
  components: Record<T, LilypadLoggerComponent<T>[]>;
  name?: string;
  errorLogging?: (error: unknown) => void | Promise<void>;
  /**
   * `platform.background` receives every message being sent, so that the instance stays alive
   * until it is sent even after the response (serverless platforms).
   */
  platform?: Pick<LilypadPlatform, 'background'>;
  /**
   * Called synchronously for every message: its fields are added to the record (e.g. a request id
   * read from `AsyncLocalStorage`). If it throws, the message is logged without context.
   */
  context?: () => Record<string, unknown> | undefined;
} & LilypadSingletonAble;

// Define a utility type to map channel keys to method signatures
type ChannelMethodFunction = (...message: unknown[]) => Promise<void>;
type ChannelMethods<T extends string> = {
  [K in T]: ChannelMethodFunction;
};

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
 * ```
 *
 * @remarks
 * The logger creates dynamic methods on the instance for each log type defined in the constructor options.
 * Each method accepts a message string and routes it to all registered components of that type.
 * Errors thrown by components are caught and handled via the errorLogging callback if provided.
 */
export class LilypadLogger<T extends string> {
  private components: Record<T, LilypadLoggerComponent<T>[]> = {} as Record<
    T,
    LilypadLoggerComponent<T>[]
  >;

  // Optional logger name
  private _name?: string;
  get __name(): string | undefined {
    return this._name;
  }

  /** The messages still being sent, awaited by `flush`. */
  private _pending: Set<Promise<void>> = new Set();

  /**
   * Creates a new LilypadLogger instance or retrieves a singleton instance.
   *
   * @template T - The log level type, defaults to the levels the other Lilypad modules log on
   * ('error' | 'warn' | 'info' | 'debug'), so that the logger can be passed to them
   * @param options - Configuration options for the logger
   * @param options.singleton - Whether to use a singleton instance
   * @param options.singletonIdentifier - Unique identifier for the singleton instance
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
   *   singleton: true,
   *   singletonIdentifier: 'app-logger',
   *   components: { info: [new LilypadConsoleLogger()], error: [new LilypadConsoleLogger()] },
   * });
   */
  public static create<T extends string = LilypadLibLogLevel>(
    options: LilypadLoggerConstructorOptions<T>
  ): LilypadLoggerType<T> {
    return createLilypadSingletonAble(
      'LilypadLogger',
      options,
      () => new LilypadLogger<T>(options) as LilypadLoggerType<T>,
      {
        // No secrets in these options: the signature can stay in clear text
        value: JSON.stringify([options.name, Object.keys(options.components).sort()]),
        onMismatch: () =>
          console.warn(
            `LilypadLogger singleton "${options.singleton ? options.singletonIdentifier : ''}" already exists with different options: the new options are ignored.`
          ),
      }
    );
  }

  private constructor(options: LilypadLoggerConstructorOptions<T>) {
    // Check that no T can override existing properties. `key in this` also covers inherited ones
    // (e.g. `constructor`, `toString`); fields are listed explicitly because, depending on the
    // compilation target, they may not be defined on the instance yet. `then` would make the logger
    // a thenable: returning it from an async function would call it instead of resolving to it.
    const reservedKeys = new Set([
      'components',
      'register',
      'flush',
      '__name',
      '_name',
      '_pending',
      'then',
    ]);
    for (const key of Object.keys(options.components)) {
      if (reservedKeys.has(key) || key in this) {
        throw new Error(`Logger type "${key}" is reserved and cannot be used as a log channel.`);
      }
    }

    // Assign logger name if provided
    this._name = options.name;

    // Assign initial components
    for (const [type, comps] of Object.entries(options.components) as [
      T,
      LilypadLoggerComponent<T>[],
    ][]) {
      // Initialize components array
      this.components[type] = [...comps];
    }

    for (const type of Object.keys(this.components) as T[]) {
      // Create the function that logs to components
      const send = async (message: unknown[], context: Record<string, unknown> | undefined) => {
        let errors: unknown[];
        try {
          // Formatting stays inside the try: it must never make the returned promise reject
          const record: LilypadLogRecord<T> = {
            type,
            message: message.map(formatLogValue).join(' '),
            parts: message,
            timestamp: new Date(),
            loggerName: this._name,
            context,
          };
          // allSettled: a failing component must neither stop nor hide the errors of the others
          const results = await Promise.allSettled(
            this.components[type].map(async (component) =>
              component.output(type, record.message, {
                logger: this as LilypadLoggerType<T>,
                record,
              })
            )
          );
          errors = results
            .filter((result) => result.status === 'rejected')
            .map((result): unknown => result.reason);
        } catch (error) {
          errors = [error];
        }
        for (const error of errors) {
          await reportComponentError(type, error, options.errorLogging);
        }
      };

      const logFn = (...message: unknown[]): Promise<void> => {
        // The context is read synchronously, while the caller's async context is still active
        const task = send(message, readContext(options.context));
        this._pending.add(task);
        void task.finally(() => this._pending.delete(task));
        // `task` never rejects: the error handler is only required by runInBackground
        runInBackground(options.platform, task, () => {});
        return task;
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
      if (!this.components[type]) {
        throw new Error(
          `Logger type "${type}" was not defined when the logger was created and cannot be registered.`
        );
      }
      this.components[type].push(...(newComponents[type] ?? []));
    }
    return this;
  }

  /**
   * Resolves once every message logged so far has been sent (or has failed and been reported).
   * Useful before the process exits, or at the end of a serverless request without `platform`.
   */
  async flush(): Promise<void> {
    while (this._pending.size > 0) {
      await Promise.all(this._pending);
    }
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
