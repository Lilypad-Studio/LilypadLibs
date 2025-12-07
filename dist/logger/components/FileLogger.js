"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const LilypadLoggerComponent_1 = __importDefault(require("../LilypadLoggerComponent"));
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
class LilypadFileLogger extends LilypadLoggerComponent_1.default {
    filePath;
    constructor(filePath) {
        super();
        this.filePath = filePath;
    }
    send(message) {
        return new Promise((resolve, reject) => {
            fs_1.default.appendFile(this.filePath, message + '\n', 'utf8', (err) => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve();
                }
            });
        });
    }
}
exports.default = LilypadFileLogger;
