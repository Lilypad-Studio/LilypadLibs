import LilypadLoggerComponent from 'logger/LilypadLoggerComponent';

/**
 * Options for constructing a {@link LilypadLogger} instance.
 *
 * @template T - A string literal type representing component names.
 *
 * @property {Record<T, LilypadLoggerComponent<T>[]>} components - A record mapping component names to arrays of logger components.
 * @property {(error: unknown) => void} [errorLogging] - Optional callback function to handle logging errors.
 */
export interface LilypadLoggerConstructorOptions<T extends string> {
  components: Record<T, LilypadLoggerComponent<T>[]>;
  name?: string;
  errorLogging?: (error: unknown) => Promise<void>;
}

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
 * const logger = new LilypadLogger<'info' | 'error' | 'warn'>({
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
class LilypadLogger<T extends string> {
  private components: Record<T, LilypadLoggerComponent<T>[]> = {} as Record<
    T,
    LilypadLoggerComponent<T>[]
  >;

  // Optional logger name
  private _name?: string;
  get __name(): string | undefined {
    return this._name;
  }

  constructor(options: LilypadLoggerConstructorOptions<T>) {
    // Check that no T can override existing properties
    const reservedKeys = new Set(['components', 'register', '__name']);
    for (const key of Object.keys(options.components)) {
      if (reservedKeys.has(key)) {
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
        let stringMessage: string = '';
        for (let i = 0; i < message.length; i++) {
          if (i > 0) {
            stringMessage += ' ';
          }
          const msgPart = message[i];
          if (typeof msgPart === 'string') {
            stringMessage += msgPart;
          } else {
            stringMessage += JSON.stringify(msgPart);
          }
        }

        try {
          const promises: Promise<void>[] = [];
          for (const component of this.components[type]) {
            promises.push(
              component.output(type, stringMessage, { logger: this as LilypadLoggerType<T> })
            );
          }
          await Promise.all(promises);
        } catch (error) {
          if (options.errorLogging) {
            await options.errorLogging(error);
          } else {
            console.error(`Error in logger component for type "${type}":`, error);
          }
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
      this.components[type].push(...(newComponents[type] ?? []));
    }
    return this;
  }
}

export type LilypadLoggerType<T extends string> = LilypadLogger<T> & ChannelMethods<T>;

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
 */
export default function createLogger<T extends string = 'log' | 'error' | 'warn'>(
  options: LilypadLoggerConstructorOptions<T>
): LilypadLoggerType<T> {
  return new LilypadLogger<T>(options) as LilypadLoggerType<T>;
}
