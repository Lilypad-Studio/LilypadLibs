import fs from 'fs';

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
  private filePath: string;

  constructor(filePath: string) {
    super();
    this.filePath = filePath;
  }

  protected send(message: string): Promise<void> {
    return new Promise((resolve, reject) => {
      fs.appendFile(this.filePath, message + '\n', 'utf8', (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }
}
