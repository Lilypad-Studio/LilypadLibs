import { inspect } from 'node:util';
import {
  createLilypadSingletonSignatureValue,
  getLilypadSingletonInstance,
  LilypadSingletonAble,
} from '@/singleton/LilypadSingleton';
import LilypadLoggerComponent from '@/logger/LilypadLoggerComponent';

/**
 * Options for constructing a {@link LilypadLogger} instance.
 *
 * @template T - A string literal type representing component names.
 *
 * @property {Record<T, LilypadLoggerComponent<T>[]>} components - A record mapping component names to arrays of logger components.
 * @property {(error: unknown) => Promise<void>} [errorLogging] - Optional callback function to handle logging errors.
 * It is called once for each failing component. If it fails as well, both errors are written to `console.error`.
 */
export type LilypadLoggerConstructorOptions<T extends string> = {
  components: Record<T, LilypadLoggerComponent<T>[]>;
  name?: string;
  errorLogging?: (error: unknown) => Promise<void>;
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

  /**
   * Creates a new LilypadLogger instance or retrieves a singleton instance.
   *
   * @template T - The log level type, defaults to 'log' | 'error' | 'warn'
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
  public static create<T extends string = 'log' | 'error' | 'warn'>(
    options: LilypadLoggerConstructorOptions<T>
  ): LilypadLoggerType<T> {
    if (options.singleton) {
      const registryKey = `LilypadLogger:${options.singletonIdentifier}`;
      return getLilypadSingletonInstance(registryKey, () => new LilypadLogger<T>(options), {
        value: createLilypadSingletonSignatureValue([
          options.name,
          Object.keys(options.components).sort(),
        ]),
        onMismatch: () =>
          console.warn(
            `LilypadLogger singleton "${options.singletonIdentifier}" already exists with different options: the new options are ignored.`
          ),
      }) as LilypadLoggerType<T>;
    }

    return new LilypadLogger<T>(options) as LilypadLoggerType<T>;
  }

  private constructor(options: LilypadLoggerConstructorOptions<T>) {
    // Check that no T can override existing properties. `key in this` also covers inherited ones
    // (e.g. `constructor`, `toString`); fields are listed explicitly because, depending on the
    // compilation target, they may not be defined on the instance yet. `then` would make the logger
    // a thenable: returning it from an async function would call it instead of resolving to it.
    const reservedKeys = new Set(['components', 'register', '__name', '_name', 'then']);
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
      const logFn = async (...message: unknown[]) => {
        let errors: unknown[];
        try {
          // Formatting stays inside the try: it must never make the returned promise reject
          const stringMessage = message.map(formatMessagePart).join(' ');
          // allSettled: a failing component must neither stop nor hide the errors of the others
          const results = await Promise.allSettled(
            this.components[type].map(async (component) =>
              component.output(type, stringMessage, { logger: this as LilypadLoggerType<T> })
            )
          );
          errors = results
            .filter((result) => result.status === 'rejected')
            .map((result) => result.reason);
        } catch (error) {
          errors = [error];
        }
        for (const error of errors) {
          await reportComponentError(type, error, options.errorLogging);
        }
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
}

/**
 * Reports the error of a logger component. It never rejects: channel methods are called
 * fire-and-forget, so a rejection would be unhandled and terminate the Node.js process.
 */
async function reportComponentError(
  type: string,
  error: unknown,
  errorLogging?: (error: unknown) => Promise<void>
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

/**
 * Formats a part of a log message. Unlike `JSON.stringify`, `inspect` keeps the message and stack
 * of errors and never throws on circular references or BigInts.
 */
function formatMessagePart(part: unknown): string {
  return typeof part === 'string' ? part : inspect(part, { depth: 4, breakLength: Infinity });
}

export type LilypadLoggerType<T extends string> = LilypadLogger<T> & ChannelMethods<T>;

/** The logger accepted by the other Lilypad modules. */
export type LilypadLibLogger = LilypadLoggerType<'error' | 'warn' | 'info' | 'debug'>;

/**
 * Creates a new Lilypad logger instance with the specified options.
 *
 * @template T - The type of log channels supported by this logger. Defaults to 'log' | 'error' | 'warn'.
 * @param options - Configuration options for the logger instance.
 * @returns A new logger instance that combines LilypadLogger functionality with channel methods.
 *
 * @example
 * ```typescript
 * const logger = createLogger({
 *   // logger options
 * });
 * ```
 * @deprecated Use {@link LilypadLogger.create} instead.
 */
export default function createLogger<T extends string = 'log' | 'error' | 'warn'>(
  options: LilypadLoggerConstructorOptions<T>
): LilypadLoggerType<T> {
  return LilypadLogger.create<T>(options) as LilypadLoggerType<T>;
}
