"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = createLogger;
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
class LilypadLogger {
    components = {};
    // Optional logger name
    _name;
    get __name() {
        return this._name;
    }
    constructor(options) {
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
        for (const [type, comps] of Object.entries(options.components)) {
            // Initialize components array
            this.components[type] = [...comps];
        }
        for (const type of Object.keys(this.components)) {
            // Create the function that logs to components
            const logFn = async (...message) => {
                let stringMessage = '';
                for (let i = 0; i < message.length; i++) {
                    if (i > 0) {
                        stringMessage += ' ';
                    }
                    const msgPart = message[i];
                    if (typeof msgPart === 'string') {
                        stringMessage += msgPart;
                    }
                    else {
                        stringMessage += JSON.stringify(msgPart);
                    }
                }
                try {
                    const promises = [];
                    for (const component of this.components[type]) {
                        promises.push(component.output(type, stringMessage, { logger: this }));
                    }
                    await Promise.all(promises);
                }
                catch (error) {
                    if (options.errorLogging) {
                        await options.errorLogging(error);
                    }
                    else {
                        console.error(`Error in logger component for type "${type}":`, error);
                    }
                }
            };
            // Assign the function directly to the class instance (this)
            this[type] = logFn;
        }
    }
    /**
     * Registers new logger components for specified types.
     * @param newComponents - A partial record mapping component types to arrays of logger components to register
     * @returns The current logger instance for method chaining
     */
    register(newComponents) {
        for (const type of Object.keys(newComponents)) {
            this.components[type].push(...(newComponents[type] ?? []));
        }
        return this;
    }
}
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
function createLogger(options) {
    return new LilypadLogger(options);
}
