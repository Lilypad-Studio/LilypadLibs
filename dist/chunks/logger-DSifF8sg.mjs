import { n as runInBackground } from "./LilypadPlatform-DXDrm3ih.mjs";
import { t as assertNumberOption } from "./LilypadValidation-ByfswRPE.mjs";
import { t as createLilypadSingletonAble } from "./LilypadSingleton-D729uyb5.mjs";
//#region src/logger/formatLogValue.ts
/** Nesting levels printed in the text form before objects are abbreviated as `[Object]` / `[Array]`. */
const MAX_TEXT_DEPTH = 4;
/** Nesting levels kept in the JSON form: beyond, a value is abbreviated too (pathological depth). */
const MAX_JSON_DEPTH = 64;
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
function normalizeRedactedKey(key) {
	return key.toLowerCase().replace(/[-_]/g, "");
}
/** The keys to redact, in the form that the functions of this module compare. */
function lilypadRedaction(keys) {
	return new Set(keys.map(normalizeRedactedKey));
}
const DEFAULT_REDACTION = lilypadRedaction(LILYPAD_DEFAULT_REDACTED_KEYS);
const NO_REDACTION = /* @__PURE__ */ new Set();
function isRedacted(key, redaction) {
	return typeof key === "string" && redaction.size > 0 && redaction.has(normalizeRedactedKey(key));
}
const marker = (text) => ({
	kind: "marker",
	text
});
const REDACTED = marker("[Redacted]");
/** Properties of errors printed by the stack, or separately. */
const ERROR_OWN_KEYS = /* @__PURE__ */ new Set([
	"name",
	"stack",
	"message",
	"cause"
]);
function walk(value, depth, state) {
	switch (typeof value) {
		case "string": return {
			kind: "string",
			value
		};
		case "bigint": return {
			kind: "text",
			text: `${value}n`
		};
		case "symbol": return {
			kind: "text",
			text: value.toString()
		};
		case "function": return {
			kind: "text",
			text: `[Function: ${value.name || "(anonymous)"}]`
		};
		case "object": break;
		default: return {
			kind: "scalar",
			value
		};
	}
	if (value === null) return {
		kind: "scalar",
		value: null
	};
	const { seen } = state;
	if (seen.has(value)) return marker("[Circular]");
	if (value instanceof Error) return walkError(value, depth, state);
	if (value instanceof Date) return {
		kind: "date",
		iso: Number.isNaN(value.getTime()) ? null : value.toISOString()
	};
	if (value instanceof RegExp) return {
		kind: "text",
		text: value.toString()
	};
	if (state.json) {
		const toJSON = value.toJSON;
		if (typeof toJSON === "function") {
			seen.add(value);
			try {
				return walk(toJSON.call(value), depth, state);
			} finally {
				seen.delete(value);
			}
		}
	}
	if (depth >= state.maxDepth) return marker(Array.isArray(value) ? "[Array]" : value instanceof Map ? "[Map]" : value instanceof Set ? "[Set]" : "[Object]");
	seen.add(value);
	try {
		if (Array.isArray(value)) return {
			kind: "array",
			items: value.map((item) => walk(item, depth + 1, state))
		};
		if (value instanceof Map) return {
			kind: "map",
			entries: [...value].map(([key, item]) => [walk(key, depth + 1, state), isRedacted(key, state.redaction) ? REDACTED : walk(item, depth + 1, state)])
		};
		if (value instanceof Set) return {
			kind: "set",
			items: [...value].map((item) => walk(item, depth + 1, state))
		};
		return {
			kind: "object",
			properties: walkProperties(value, depth, state)
		};
	} finally {
		seen.delete(value);
	}
}
function walkError(error, depth, state) {
	state.seen.add(error);
	try {
		return {
			kind: "error",
			name: error.name,
			message: error.message,
			stack: error.stack,
			properties: depth < state.maxDepth ? walkProperties(error, depth, state, ERROR_OWN_KEYS) : void 0,
			cause: error.cause !== void 0 ? walk(error.cause, depth + 1, state) : void 0
		};
	} finally {
		state.seen.delete(error);
	}
}
/** The own enumerable properties of an object. A getter that throws does not stop the others. */
function walkProperties(value, depth, state, excluded) {
	const properties = [];
	for (const key of Object.keys(value)) {
		if (excluded?.has(key)) continue;
		if (isRedacted(key, state.redaction)) {
			properties.push([key, REDACTED]);
			continue;
		}
		let item;
		try {
			item = value[key];
		} catch {
			properties.push([key, marker("[Getter threw]")]);
			continue;
		}
		properties.push([key, walk(item, depth + 1, state)]);
	}
	return properties;
}
function renderText(node, depth) {
	switch (node.kind) {
		case "string": return depth === 0 ? node.value : `'${node.value.replace(/'/g, "\\'")}'`;
		case "scalar": return String(node.value);
		case "text":
		case "marker": return node.text;
		case "date": return node.iso ?? "Invalid Date";
		case "array": {
			const items = node.items.map((item) => renderText(item, depth + 1));
			return items.length === 0 ? "[]" : `[ ${items.join(", ")} ]`;
		}
		case "map": {
			const items = node.entries.map(([key, item]) => `${renderText(key, depth + 1)} => ${renderText(item, depth + 1)}`);
			return `Map(${items.length}) {${items.length ? ` ${items.join(", ")} ` : ""}}`;
		}
		case "set": {
			const items = node.items.map((item) => renderText(item, depth + 1));
			return `Set(${items.length}) {${items.length ? ` ${items.join(", ")} ` : ""}}`;
		}
		case "object": return renderProperties(node.properties, depth);
		case "error": {
			let formatted = node.stack ?? `${node.name}: ${node.message}`;
			if (node.properties) {
				const properties = renderProperties(node.properties, depth);
				if (properties !== "{}") formatted += ` ${properties}`;
			}
			if (node.cause) formatted += `\n[cause]: ${renderText(node.cause, depth + 1)}`;
			return formatted;
		}
	}
}
function renderProperties(properties, depth) {
	const entries = properties.map(([key, item]) => `${formatKey(key)}: ${renderText(item, depth + 1)}`);
	return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
}
function formatKey(key) {
	return /^[A-Za-z_$][\w$]*$/.test(key) ? key : `'${key}'`;
}
function renderJson(node) {
	switch (node.kind) {
		case "string":
		case "scalar": return node.value;
		case "text":
		case "marker": return node.text;
		case "date": return node.iso;
		case "array":
		case "set": return node.items.map(renderJson);
		case "map": return Object.fromEntries(node.entries.map(([key, item]) => [key.kind === "string" ? key.value : renderText(key, 0), renderJson(item)]));
		case "object": return Object.fromEntries(node.properties.map(([key, item]) => [key, renderJson(item)]));
		case "error": return {
			name: node.name,
			message: node.message,
			stack: node.stack,
			...Object.fromEntries((node.properties ?? []).map(([key, item]) => [key, renderJson(item)])),
			...node.cause && { cause: renderJson(node.cause) }
		};
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
		return renderText(walk(value, 0, {
			seen: /* @__PURE__ */ new Set(),
			redaction,
			json: false,
			maxDepth: MAX_TEXT_DEPTH
		}), 0);
	} catch {
		return "[Unformattable value]";
	}
}
/**
* The JSON-safe copy of a logged value (the context of a record, a JSON log line), with the values
* of the keys of `redaction` replaced with `[Redacted]` at any depth. It follows `toJSON` as
* `JSON.stringify` does, then redacts what it returns; errors become `{ name, message, stack }`
* with their own properties and their `cause`; BigInts become `10n`; a reference to an ancestor
* becomes `[Circular]`. It never throws.
*/
function toLogJson(value, redaction = DEFAULT_REDACTION) {
	try {
		return renderJson(walk(value, 0, {
			seen: /* @__PURE__ */ new Set(),
			redaction,
			json: true,
			maxDepth: MAX_JSON_DEPTH
		}));
	} catch {
		return "[Unformattable value]";
	}
}
/** `JSON.stringify` that never throws, over {@link toLogJson} without redaction. */
function safeJson(value) {
	try {
		return JSON.stringify(toLogJson(value, NO_REDACTION)) ?? "undefined";
	} catch {
		return "\"[Unserializable]\"";
	}
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
* await logger.flush(); // e.g. before the process exits
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
	* @param options.singleton - The identifier of the singleton instance, if one is wanted
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
	*   singleton: 'app-logger',
	*   components: { info: [new LilypadConsoleLogger()], error: [new LilypadConsoleLogger()] },
	* });
	*/
	static create(options) {
		return createLilypadSingletonAble("LilypadLogger", options, () => new LilypadLogger(options), {
			value: JSON.stringify([options.name, Object.keys(options.components).sort()]),
			onMismatch: () => console.warn(`LilypadLogger singleton "${options.singleton ?? ""}" already exists with different options: the new options are ignored.`)
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
						context: toLogJson(context, redaction)
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
* logger.error('An important log message');
* await logger.flush();
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
	/** @throws If a numeric option is not valid (e.g. `NaN`, which would leave the queue unbounded). */
	constructor(webhookUrl, options = {}) {
		super();
		this.queue = [];
		this.dropped = 0;
		this.flushing = false;
		this.nextRequestAt = 0;
		const owner = "LilypadDiscordLogger";
		assertNumberOption(owner, "minRequestInterval", options.minRequestInterval, "non-negative-delay");
		assertNumberOption(owner, "rateLimitRetries", options.rateLimitRetries, "non-negative-integer");
		assertNumberOption(owner, "maxQueueSize", options.maxQueueSize, "positive-integer");
		this.webhookUrl = webhookUrl;
		this.minRequestInterval = options.minRequestInterval ?? 1e3;
		this.rateLimitRetries = options.rateLimitRetries ?? 1;
		this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
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
export { LilypadLogger as a, LilypadLoggerComponent as i, LilypadJsonConsoleLogger as n, LILYPAD_DEFAULT_REDACTED_KEYS as o, LilypadConsoleLogger as r, toLogJson as s, LilypadDiscordLogger as t };

//# sourceMappingURL=logger-DSifF8sg.mjs.map