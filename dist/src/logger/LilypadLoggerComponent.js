"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Abstract base class for logging components in the Lilypad library.
 *
 * Provides a template for implementing custom loggers with standardized message formatting.
 * Subclasses must implement the {@link send} method to define how formatted messages are output.
 *
 * @template T - A string literal type representing the log message types (e.g., 'INFO', 'ERROR', 'WARN')
 *
 * @example
 * ```typescript
 * class ConsoleLogger extends LilypadLoggerComponent<'INFO' | 'ERROR' | 'WARN'> {
 *   protected async send(message: string): Promise<void> {
 *     console.log(message);
 *   }
 * }
 * ```
 */
class LilypadLoggerComponent {
    getTimestamp() {
        return new Date().toISOString();
    }
    formatMessage(type, message, options) {
        let formatted = `${this.getTimestamp()} - `;
        if (options?.logger?.__name) {
            formatted += `[${options.logger.__name}] `;
        }
        else if (options?.name) {
            formatted += `[${options.name}] `;
        }
        formatted += `[${type.toUpperCase()}]: ${message}`;
        return formatted;
    }
    async output(type, message, options) {
        const formattedMessage = this.formatMessage(type, message, options);
        await this.send(formattedMessage);
    }
}
exports.default = LilypadLoggerComponent;
