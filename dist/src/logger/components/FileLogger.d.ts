import LilypadLoggerComponent from '../LilypadLoggerComponent';
/**
 * A file-based logger component that extends LilypadLoggerComponent.
 *
 * This logger writes log messages to a specified file on disk. Each message is appended
 * on a new line in UTF-8 encoding.
 *
 * The directory for the log file must exist prior to logging; this class does not create directories.
 *
 * @template T - A string type that represents the log level or category.
 */
export default class LilypadFileLogger<T extends string> extends LilypadLoggerComponent<T> {
    private filePath;
    constructor(filePath: string);
    protected send(message: string): Promise<void>;
}
