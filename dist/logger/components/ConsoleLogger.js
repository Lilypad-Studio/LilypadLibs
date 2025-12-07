"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const LilypadLoggerComponent_1 = __importDefault(require("../LilypadLoggerComponent"));
/**
 * A logger component that outputs messages to the console.
 *
 * @template T - A string literal type representing the logger's category or name.
 *
 * @example
 * ```typescript
 * const logger = new ConsoleLogger<'app'>();
 * ```
 *
 * @remarks
 * This logger extends {@link LilypadLoggerComponent} and implements basic console logging functionality.
 * Messages are sent to the standard output using `console.log()`.
 */
class ConsoleLogger extends LilypadLoggerComponent_1.default {
    async send(message) {
        console.log(message);
    }
}
exports.default = ConsoleLogger;
