import { n as runInBackground } from "./LilypadPlatform-Cdm5WJuh.mjs";
import { t as createLilypadSingletonAble } from "./LilypadSingleton-w0oZfBDG.mjs";
//#region src/logger/formatLogValue.ts
/** Nesting levels printed before objects are abbreviated as `[Object]` / `[Array]`. */
const MAX_DEPTH = 4;
/**
* The keys whose values the logger replaces with `[Redacted]` by default, wherever they appear in
* a logged value or in the context (e.g. the headers of the request of an HTTP client error).
* Keys are compared ignoring case, `-` and `_`: `apiKey`, `api_key` and `API-KEY` all match.
*/
const LILYPAD_DEFAULT_REDACTED_KEYS = Object.freeze([
	"authorization",
	"proxy-authorization",
	"cookie",
	"set-cookie",
	"password",
	"passwd",
	"secret",
	"client_secret",
	"token",
	"access_token",
	"refresh_token",
	"id_token",
	"api_key",
	"x-api-key",
	"private_key"
]);
const REDACTED = "[Redacted]";
function normalizeRedactedKey(key) {
	return key.toLowerCase().replace(/[-_]/g, "");
}
/** The keys to redact, in the form that `formatLogValue` and `redactLogValue` compare. */
function lilypadRedaction(keys) {
	return new Set(keys.map(normalizeRedactedKey));
}
const DEFAULT_REDACTION = lilypadRedaction(LILYPAD_DEFAULT_REDACTED_KEYS);
function isRedacted(key, redaction) {
	return typeof key === "string" && redaction.size > 0 && redaction.has(normalizeRedactedKey(key));
}
/**
* A copy of `value` whose redacted keys hold `[Redacted]`, for the values serialized as JSON later
* (the context of a record). Plain objects and arrays are copied; errors and objects with a
* `toJSON` method are kept as they are. It never throws.
*/
function redactLogValue(value, redaction = DEFAULT_REDACTION, ancestors = /* @__PURE__ */ new Set()) {
	if (redaction.size === 0 || typeof value !== "object" || value === null) return value;
	if (ancestors.has(value)) return "[Circular]";
	try {
		if (value instanceof Error || typeof value.toJSON === "function") return value;
		ancestors.add(value);
		try {
			if (Array.isArray(value)) return value.map((item) => redactLogValue(item, redaction, ancestors));
			const copy = {};
			for (const [key, item] of Object.entries(value)) copy[key] = isRedacted(key, redaction) ? REDACTED : redactLogValue(item, redaction, ancestors);
			return copy;
		} finally {
			ancestors.delete(value);
		}
	} catch {
		return "[Unformattable value]";
	}
}
/**
* Formats a part of a log message, in a style close to `util.inspect` but without Node.js APIs,
* so that the logger also runs in edge runtimes.
* - Strings are returned as they are.
* - Errors keep their stack (or name and message), their own properties (e.g. the `code` and
*   `detail` of a database error) and their `cause`.
* - It never throws: circular references print as `[Circular]`, BigInts as `10n`, a getter
*   that throws as `[Getter threw]`.
* - The values of the keys of `redaction` print as `[Redacted]` (by default, the keys of
*   {@link LILYPAD_DEFAULT_REDACTED_KEYS}).
*/
function formatLogValue(value, redaction = DEFAULT_REDACTION) {
	if (typeof value === "string") return value;
	try {
		return formatNested(value, 0, {
			seen: /* @__PURE__ */ new Set(),
			redaction
		});
	} catch {
		return "[Unformattable value]";
	}
}
/** Properties of errors printed by the stack, or separately. */
const ERROR_OWN_KEYS = /* @__PURE__ */ new Set([
	"name",
	"stack",
	"message",
	"cause"
]);
function formatNested(value, depth, state) {
	const { seen } = state;
	switch (typeof value) {
		case "string": return depth === 0 ? value : `'${value.replace(/'/g, "\\'")}'`;
		case "bigint": return `${value}n`;
		case "symbol": return value.toString();
		case "function": return `[Function: ${value.name || "(anonymous)"}]`;
		case "object": break;
		default: return String(value);
	}
	if (value === null) return "null";
	if (seen.has(value)) return "[Circular]";
	if (value instanceof Error) return formatError(value, depth, state);
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
	if (value instanceof RegExp) return value.toString();
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			if (depth >= MAX_DEPTH) return "[Array]";
			const items = value.map((item) => formatNested(item, depth + 1, state));
			return items.length === 0 ? "[]" : `[ ${items.join(", ")} ]`;
		}
		if (value instanceof Map) {
			if (depth >= MAX_DEPTH) return "[Map]";
			const items = [...value].map(([k, v]) => `${formatNested(k, depth + 1, state)} => ${isRedacted(k, state.redaction) ? REDACTED : formatNested(v, depth + 1, state)}`);
			return `Map(${value.size}) {${items.length ? ` ${items.join(", ")} ` : ""}}`;
		}
		if (value instanceof Set) {
			if (depth >= MAX_DEPTH) return "[Set]";
			const items = [...value].map((item) => formatNested(item, depth + 1, state));
			return `Set(${value.size}) {${items.length ? ` ${items.join(", ")} ` : ""}}`;
		}
		if (depth >= MAX_DEPTH) return "[Object]";
		return formatProperties(value, depth, state);
	} finally {
		seen.delete(value);
	}
}
function formatError(error, depth, state) {
	state.seen.add(error);
	try {
		let formatted = error.stack ?? `${error.name}: ${error.message}`;
		if (depth < MAX_DEPTH) {
			const properties = formatProperties(error, depth, state, ERROR_OWN_KEYS);
			if (properties !== "{}") formatted += ` ${properties}`;
		}
		if (error.cause !== void 0) formatted += `\n[cause]: ${formatNested(error.cause, depth + 1, state)}`;
		return formatted;
	} finally {
		state.seen.delete(error);
	}
}
/**
* The own enumerable properties of an object, as `{ key: value, ... }`. A getter that throws does
* not stop the others from being printed.
*/
function formatProperties(value, depth, state, excluded) {
	const entries = [];
	for (const key of Object.keys(value)) {
		if (excluded?.has(key)) continue;
		if (isRedacted(key, state.redaction)) {
			entries.push(`${formatKey(key)}: ${REDACTED}`);
			continue;
		}
		let item;
		try {
			item = value[key];
		} catch {
			entries.push(`${formatKey(key)}: [Getter threw]`);
			continue;
		}
		entries.push(`${formatKey(key)}: ${formatNested(item, depth + 1, state)}`);
	}
	return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
}
function formatKey(key) {
	return /^[A-Za-z_$][\w$]*$/.test(key) ? key : `'${key}'`;
}
//#endregion
//#region src/logger/LilypadLogger.ts
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
var LilypadLogger = class LilypadLogger {
	/**
	* Creates a new LilypadLogger instance or retrieves a singleton instance.
	*
	* @template T - The log level type, defaults to the levels the other Lilypad modules log on
	* ('error' | 'warn' | 'info' | 'debug'), so that the logger can be passed to them
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
	static create(options) {
		return createLilypadSingletonAble("LilypadLogger", options, () => new LilypadLogger(options), {
			value: JSON.stringify([options.name, Object.keys(options.components).sort()]),
			onMismatch: () => console.warn(`LilypadLogger singleton "${options.singleton ? options.singletonIdentifier : ""}" already exists with different options: the new options are ignored.`)
		});
	}
	constructor(options) {
		this.components = {};
		this._pending = /* @__PURE__ */ new Set();
		const reservedKeys = /* @__PURE__ */ new Set([
			"components",
			"register",
			"flush",
			"name",
			"_pending",
			"then"
		]);
		for (const key of Object.keys(options.components)) if (reservedKeys.has(key) || key in this) throw new Error(`Logger type "${key}" is reserved and cannot be used as a log channel.`);
		this.name = options.name;
		const redaction = lilypadRedaction(options.redact === false ? [] : options.redact ?? LILYPAD_DEFAULT_REDACTED_KEYS);
		for (const [type, comps] of Object.entries(options.components)) this.components[type] = [...comps];
		for (const type of Object.keys(this.components)) {
			const send = async (message, context) => {
				let errors;
				try {
					const record = {
						type,
						message: message.map((part) => formatLogValue(part, redaction)).join(" "),
						parts: message,
						timestamp: /* @__PURE__ */ new Date(),
						loggerName: this.name,
						context: redactLogValue(context, redaction)
					};
					errors = (await Promise.allSettled(this.components[type].map(async (component) => component.write(record)))).filter((result) => result.status === "rejected").map((result) => result.reason);
				} catch (error) {
					errors = [error];
				}
				for (const error of errors) await reportComponentError(type, error, options.errorLogging);
			};
			const logFn = (...message) => {
				const task = send(message, readContext(options.context));
				this._pending.add(task);
				task.finally(() => this._pending.delete(task));
				runInBackground(options.platform, task, () => {});
				return task;
			};
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
			if (!this.components[type]) throw new Error(`Logger type "${type}" was not defined when the logger was created and cannot be registered.`);
			this.components[type].push(...newComponents[type] ?? []);
		}
		return this;
	}
	/**
	* Resolves once every message logged so far has been sent (or has failed and been reported).
	* Useful before the process exits, or at the end of a serverless request without `platform`.
	*/
	async flush() {
		while (this._pending.size > 0) await Promise.all(this._pending);
	}
};
function readContext(context) {
	try {
		return context?.();
	} catch {
		return;
	}
}
/**
* Reports the error of a logger component. It never rejects: channel methods are called
* fire-and-forget, so a rejection would be unhandled and terminate the Node.js process.
*/
async function reportComponentError(type, error, errorLogging) {
	if (errorLogging) try {
		await errorLogging(error);
		return;
	} catch (loggingError) {
		console.error(`Error in errorLogging callback for type "${type}":`, loggingError);
	}
	console.error(`Error in logger component for type "${type}":`, error);
}
//#endregion
//#region src/logger/LilypadLoggerComponent.ts
/**
* Abstract base class of the outputs of a {@link LilypadLogger}: a component implements
* {@link write}, which receives each record of the channels it is registered on. Use
* {@link formatRecord} for a line of text.
*
* @template T - A string literal type representing the log message types (e.g., 'INFO', 'ERROR', 'WARN')
*
* @example
* ```typescript
* class StderrLogger extends LilypadLoggerComponent<'info' | 'error'> {
*   async write(record: LilypadLogRecord<'info' | 'error'>): Promise<void> {
*     process.stderr.write(this.formatRecord(record) + '
');
*   }
* }
* ```
*/
var LilypadLoggerComponent = class {
	/**
	* Formats a record as `<ISO timestamp> - [name] [TYPE]: <message> <context as JSON>`.
	*/
	formatRecord(record) {
		let formatted = `${record.timestamp.toISOString()} - `;
		if (record.loggerName) formatted += `[${record.loggerName}] `;
		formatted += `[${record.type.toUpperCase()}]: ${record.message}`;
		if (record.context && Object.keys(record.context).length > 0) formatted += ` ${safeJson(record.context)}`;
		return formatted;
	}
};
/**
* Writes a message on the console: channels named `error` go to `console.error`, `warn` to
* `console.warn` (case-insensitive), the others to `console.log`.
*/
function writeToConsole(message, type) {
	switch (type.toLowerCase()) {
		case "error":
			console.error(message);
			break;
		case "warn":
			console.warn(message);
			break;
		default: console.log(message);
	}
}
/**
* `JSON.stringify` that never throws (circular references, BigInts). Only a reference to one of
* its own ancestors prints as `[Circular]`: an object referenced twice side by side is printed twice.
*/
function safeJson(value) {
	try {
		return JSON.stringify(toJsonSafe(value, /* @__PURE__ */ new Set()));
	} catch {
		return "\"[Unserializable]\"";
	}
}
function toJsonSafe(value, ancestors) {
	if (typeof value === "bigint") return `${value}n`;
	if (typeof value !== "object" || value === null) return value;
	if (ancestors.has(value)) return "[Circular]";
	if (value instanceof Error) return {
		name: value.name,
		message: value.message,
		stack: value.stack
	};
	const json = value.toJSON;
	if (typeof json === "function") return toJsonSafe(json.call(value), ancestors);
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return value.map((item) => toJsonSafe(item, ancestors));
		const result = {};
		for (const [key, item] of Object.entries(value)) result[key] = toJsonSafe(item, ancestors);
		return result;
	} finally {
		ancestors.delete(value);
	}
}
//#endregion
//#region src/logger/components/ConsoleLogger.ts
/**
* A logger component that outputs messages to the console.
*
* @template T - A string literal type representing the logger's category or name.
*
* @example
* ```typescript
* const logger = new LilypadConsoleLogger<'app'>();
* ```
*
* @remarks
* This logger extends {@link LilypadLoggerComponent} and implements basic console logging functionality.
* Messages of type `error` are sent to `console.error`, messages of type `warn` to `console.warn`
* (case-insensitive), and every other message to `console.log`.
*/
var LilypadConsoleLogger = class extends LilypadLoggerComponent {
	write(record) {
		writeToConsole(this.formatRecord(record), record.type);
		return Promise.resolve();
	}
};
//#endregion
//#region src/logger/components/JsonConsoleLogger.ts
/**
* A logger component that writes one JSON object per message on the console, for log platforms
* that filter on fields (Vercel logs, log drains, ...).
*
* Each line holds `time`, `level` (the channel), `logger` (the logger name), `msg` (the formatted
* message), the fields of the logger's `context`, and `errors` when Error objects were logged.
* Channels named `error` go to `console.error`, `warn` to `console.warn` (case-insensitive), the
* others to `console.log`.
*
* @example
* ```typescript
* const json = new LilypadJsonConsoleLogger<'error' | 'info'>();
* const logger = LilypadLogger.create({ components: { error: [json], info: [json] } });
* logger.info('Invoice created', { id: 'inv_1' });
* // {"time":"2026-09-24T10:00:00.000Z","level":"info","msg":"Invoice created { id: 'inv_1' }"}
* ```
*/
var LilypadJsonConsoleLogger = class extends LilypadLoggerComponent {
	write(record) {
		const errors = record.parts.filter((part) => part instanceof Error);
		writeToConsole(safeJson({
			...record.context,
			time: record.timestamp.toISOString(),
			level: record.type,
			...record.loggerName !== void 0 && { logger: record.loggerName },
			msg: record.message,
			...errors.length > 0 && { errors: errors.map((error) => ({
				name: error.name,
				message: error.message,
				stack: error.stack
			})) }
		}), record.type);
		return Promise.resolve();
	}
};
//#endregion
//#region src/logger/components/DiscordLogger.ts
/** Maximum length of the content of a Discord message. */
const DISCORD_MAX_CONTENT_LENGTH = 2e3;
const DISCORD_REQUEST_TIMEOUT = 5e3;
/** Wait used after a 429 response without a valid `retry-after` header. */
const DEFAULT_RETRY_AFTER = 1e3;
/**
* Longest `retry-after` waited for: beyond it (e.g. a global rate limit of an hour) the batch
* fails, instead of holding the queue and `logger.flush()` for that long.
*/
const MAX_RETRY_AFTER = 3e4;
const DEFAULT_MAX_QUEUE_SIZE = 100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
* A Discord webhook logger component that sends log messages to a Discord channel.
*
* @template T - A string type representing the log level or category.
* @extends {LilypadLoggerComponent<T>}
*
* @example
* ```typescript
* const discordLogger = new LilypadDiscordLogger<'info' | 'error' | 'warn'>('https://discordapp.com/api/webhooks/...');
* const logger = LilypadLogger.create({ components: { error: [discordLogger] } });
* await logger.error('An important log message');
* ```
*
* @remarks
* This class uses Discord's webhook API to send messages. Ensure the webhook URL is kept secure
* and not exposed in version control or client-side code.
* - Log messages are sent to a third-party service: anything they contain (including data logged
*   together with errors) becomes visible to the members of the Discord channel.
* - Mentions are disabled, so a message containing `@everyone` or a user/role mention notifies no one.
* - Messages longer than 2000 characters are truncated.
* - Requests are throttled (see {@link LilypadDiscordLoggerOptions}): messages logged while a request
*   is pending or too recent are batched into one Discord message, up to 2000 characters.
* - A rate limited request (429) is retried after the `retry-after` time given by Discord, when
*   it is at most 30 seconds.
* - A failed request makes `write` reject for one message of the batch (with the number of
*   messages lost), so the logger reports it once through its `errorLogging` callback.
* - At most `maxQueueSize` messages wait to be sent: during a flood of messages the oldest are
*   dropped, so that memory and the pending `write` promises stay bounded.
*/
var LilypadDiscordLogger = class extends LilypadLoggerComponent {
	constructor(webhookUrl, options = {}) {
		super();
		this.queue = [];
		this.dropped = 0;
		this.flushing = false;
		this.nextRequestAt = 0;
		this.webhookUrl = webhookUrl;
		this.minRequestInterval = options.minRequestInterval ?? 1e3;
		this.rateLimitRetries = options.rateLimitRetries ?? 1;
		this.maxQueueSize = Math.max(1, options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE);
	}
	write(record) {
		return this.enqueue(this.formatRecord(record));
	}
	enqueue(message) {
		return new Promise((resolve, reject) => {
			this.queue.push({
				content: message.slice(0, DISCORD_MAX_CONTENT_LENGTH),
				resolve,
				reject
			});
			while (this.queue.length > this.maxQueueSize) {
				this.queue.shift()?.resolve();
				this.dropped++;
			}
			this.flush();
		});
	}
	/**
	* Sends the queued messages, one batch at a time. It never rejects: the outcome of each batch
	* settles the promises of its messages.
	*/
	async flush() {
		if (this.flushing) return;
		this.flushing = true;
		try {
			while (this.queue.length > 0) {
				const wait = this.nextRequestAt - Date.now();
				if (wait > 0) await sleep(wait);
				await this.sendBatch(this.takeBatch());
			}
		} finally {
			this.flushing = false;
		}
	}
	/** Takes the queued messages that fit in one Discord message, always at least one. */
	takeBatch() {
		if (this.dropped > 0) {
			const notice = `… ${this.dropped} log messages dropped (queue full)`;
			this.dropped = 0;
			this.queue.unshift({
				content: notice,
				resolve: () => {},
				reject: () => {}
			});
		}
		let length = this.queue[0].content.length;
		let count = 1;
		while (count < this.queue.length && length + 1 + this.queue[count].content.length <= DISCORD_MAX_CONTENT_LENGTH) {
			length += 1 + this.queue[count].content.length;
			count++;
		}
		return this.queue.splice(0, count);
	}
	async sendBatch(batch) {
		const content = batch.map((message) => message.content).join("\n");
		try {
			for (let attempt = 0;; attempt++) {
				const response = await this.post(content);
				this.nextRequestAt = Date.now() + this.minRequestInterval;
				response.body?.cancel().catch(() => {});
				const retryAfter = response.status === 429 ? retryAfterMs(response) : void 0;
				if (retryAfter !== void 0 && retryAfter <= MAX_RETRY_AFTER && attempt < this.rateLimitRetries) {
					this.nextRequestAt = Date.now() + retryAfter;
					await sleep(retryAfter);
					continue;
				}
				if (!response.ok) throw new Error(`Discord webhook request failed with status ${response.status} ${response.statusText}`);
				batch.forEach((message) => message.resolve());
				return;
			}
		} catch (error) {
			this.nextRequestAt = Math.max(this.nextRequestAt, Date.now() + this.minRequestInterval);
			const [reported, ...others] = batch.slice().reverse();
			others.forEach((message) => message.resolve());
			reported?.reject(batch.length === 1 ? error : new Error(`${batch.length} log messages could not be sent to Discord`, { cause: error }));
		}
	}
	post(content) {
		return fetch(this.webhookUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content,
				allowed_mentions: { parse: [] }
			}),
			signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT)
		});
	}
};
/** The wait requested by a 429 response: `retry-after` is in seconds. */
function retryAfterMs(response) {
	const seconds = Number(response.headers?.get("retry-after"));
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1e3 : DEFAULT_RETRY_AFTER;
}
//#endregion
export { LilypadLogger as a, LilypadLoggerComponent as i, LilypadJsonConsoleLogger as n, LILYPAD_DEFAULT_REDACTED_KEYS as o, LilypadConsoleLogger as r, LilypadDiscordLogger as t };

//# sourceMappingURL=logger-CVmu2YTA.mjs.map