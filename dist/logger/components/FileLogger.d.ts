import LilypadLoggerComponent from '../LilypadLoggerComponent';
/**
 * A file-based logger component that extends LilypadLoggerComponent.
 *
 * This logger writes log messages to a specified file on disk. Each message is appended
 * on a new line in UTF-8 encoding.
 *
 * @template T - A string type that represents the log level or category.
 *
 * @example
 * ```typescript
 * const fileLogger = new LilypadFileLogger('./logs/app.log');
 * await fileLogger.send('Application started');
 * ```
 */
export default class LilypadFileLogger<T extends string> extends LilypadLoggerComponent<T> {
    private filePath;
    constructor(filePath: string);
    protected send(message: string): Promise<void>;
}
