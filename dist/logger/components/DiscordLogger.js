"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const LilypadLoggerComponent_1 = __importDefault(require("../LilypadLoggerComponent"));
/**
 * A Discord webhook logger component that sends log messages to a Discord channel.
 *
 * @template T - A string type representing the log level or category.
 * @extends {LilypadLoggerComponent<T>}
 *
 * @example
 * ```typescript
 * const logger = new LilypadDiscordLogger<'info' | 'error' | 'warn'>('https://discordapp.com/api/webhooks/...');
 * await logger.send('An important log message');
 * ```
 *
 * @remarks
 * This class uses Discord's webhook API to send messages. Ensure the webhook URL is kept secure
 * and not exposed in version control or client-side code.
 */
class LilypadDiscordLogger extends LilypadLoggerComponent_1.default {
    webhookUrl;
    constructor(webhookUrl) {
        super();
        this.webhookUrl = webhookUrl;
    }
    async send(message) {
        const payload = {
            content: message,
        };
        await fetch(this.webhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });
    }
}
exports.default = LilypadDiscordLogger;
