"use strict";Object.defineProperty(exports, "__esModule", {value: true}); function _nullishCoalesce(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return rhsFn(); } } var _class; var _class2;

var _chunkLL3KVXOKjs = require('./chunk-LL3KVXOK.js');


var _chunkCDQ4MAZLjs = require('./chunk-CDQ4MAZL.js');

// src/logger/formatLogValue.ts
var MAX_DEPTH = 4;
var LILYPAD_DEFAULT_REDACTED_KEYS = Object.freeze([
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
var REDACTED = "[Redacted]";
function normalizeRedactedKey(key) {
  return key.toLowerCase().replace(/[-_]/g, "");
}
function lilypadRedaction(keys) {
  return new Set(keys.map(normalizeRedactedKey));
}
var DEFAULT_REDACTION = lilypadRedaction(LILYPAD_DEFAULT_REDACTED_KEYS);
function isRedacted(key, redaction) {
  return typeof key === "string" && redaction.size > 0 && redaction.has(normalizeRedactedKey(key));
}
function redactLogValue(value, redaction = DEFAULT_REDACTION, ancestors = /* @__PURE__ */ new Set()) {
  if (redaction.size === 0 || typeof value !== "object" || value === null) {
    return value;
  }
  if (ancestors.has(value)) {
    return "[Circular]";
  }
  try {
    if (value instanceof Error || typeof value.toJSON === "function") {
      return value;
    }
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((item) => redactLogValue(item, redaction, ancestors));
      }
      const copy = {};
      for (const [key, item] of Object.entries(value)) {
        copy[key] = isRedacted(key, redaction) ? REDACTED : redactLogValue(item, redaction, ancestors);
      }
      return copy;
    } finally {
      ancestors.delete(value);
    }
  } catch (e) {
    return "[Unformattable value]";
  }
}
function formatLogValue(value, redaction = DEFAULT_REDACTION) {
  if (typeof value === "string") {
    return value;
  }
  try {
    return formatNested(value, 0, { seen: /* @__PURE__ */ new Set(), redaction });
  } catch (e2) {
    return "[Unformattable value]";
  }
}
var ERROR_OWN_KEYS = /* @__PURE__ */ new Set(["name", "stack", "message", "cause"]);
function formatNested(value, depth, state) {
  const { seen } = state;
  switch (typeof value) {
    case "string":
      return depth === 0 ? value : `'${value.replace(/'/g, "\\'")}'`;
    case "bigint":
      return `${value}n`;
    case "symbol":
      return value.toString();
    case "function":
      return `[Function: ${value.name || "(anonymous)"}]`;
    case "object":
      break;
    default:
      return String(value);
  }
  if (value === null) {
    return "null";
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  if (value instanceof Error) {
    return formatError(value, depth, state);
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (value instanceof RegExp) {
    return value.toString();
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (depth >= MAX_DEPTH) {
        return "[Array]";
      }
      const items = value.map((item) => formatNested(item, depth + 1, state));
      return items.length === 0 ? "[]" : `[ ${items.join(", ")} ]`;
    }
    if (value instanceof Map) {
      if (depth >= MAX_DEPTH) {
        return "[Map]";
      }
      const items = [...value].map(
        ([k, v]) => `${formatNested(k, depth + 1, state)} => ${isRedacted(k, state.redaction) ? REDACTED : formatNested(v, depth + 1, state)}`
      );
      return `Map(${value.size}) {${items.length ? ` ${items.join(", ")} ` : ""}}`;
    }
    if (value instanceof Set) {
      if (depth >= MAX_DEPTH) {
        return "[Set]";
      }
      const items = [...value].map((item) => formatNested(item, depth + 1, state));
      return `Set(${value.size}) {${items.length ? ` ${items.join(", ")} ` : ""}}`;
    }
    if (depth >= MAX_DEPTH) {
      return "[Object]";
    }
    return formatProperties(value, depth, state);
  } finally {
    seen.delete(value);
  }
}
function formatError(error, depth, state) {
  state.seen.add(error);
  try {
    let formatted = _nullishCoalesce(error.stack, () => ( `${error.name}: ${error.message}`));
    if (depth < MAX_DEPTH) {
      const properties = formatProperties(error, depth, state, ERROR_OWN_KEYS);
      if (properties !== "{}") {
        formatted += ` ${properties}`;
      }
    }
    if (error.cause !== void 0) {
      formatted += `
[cause]: ${formatNested(error.cause, depth + 1, state)}`;
    }
    return formatted;
  } finally {
    state.seen.delete(error);
  }
}
function formatProperties(value, depth, state, excluded) {
  const entries = [];
  for (const key of Object.keys(value)) {
    if (excluded == null ? void 0 : excluded.has(key)) {
      continue;
    }
    if (isRedacted(key, state.redaction)) {
      entries.push(`${formatKey(key)}: ${REDACTED}`);
      continue;
    }
    let item;
    try {
      item = value[key];
    } catch (e3) {
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

// src/logger/LilypadLogger.ts
var LilypadLogger = (_class = class _LilypadLogger {
  __init() {this.components = {}}
  /** The name given in the options, added to each record. */
  
  /** The messages still being sent, awaited by `flush`. */
  __init2() {this._pending = /* @__PURE__ */ new Set()}
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
    return _chunkCDQ4MAZLjs.createLilypadSingletonAble.call(void 0, 
      "LilypadLogger",
      options,
      () => new _LilypadLogger(options),
      {
        // No secrets in these options: the signature can stay in clear text
        value: JSON.stringify([options.name, Object.keys(options.components).sort()]),
        onMismatch: () => console.warn(
          `LilypadLogger singleton "${options.singleton ? options.singletonIdentifier : ""}" already exists with different options: the new options are ignored.`
        )
      }
    );
  }
  constructor(options) {;_class.prototype.__init.call(this);_class.prototype.__init2.call(this);
    const reservedKeys = /* @__PURE__ */ new Set(["components", "register", "flush", "name", "_pending", "then"]);
    for (const key of Object.keys(options.components)) {
      if (reservedKeys.has(key) || key in this) {
        throw new Error(`Logger type "${key}" is reserved and cannot be used as a log channel.`);
      }
    }
    this.name = options.name;
    const redaction = lilypadRedaction(
      options.redact === false ? [] : _nullishCoalesce(options.redact, () => ( LILYPAD_DEFAULT_REDACTED_KEYS))
    );
    for (const [type, comps] of Object.entries(options.components)) {
      this.components[type] = [...comps];
    }
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
          const results = await Promise.allSettled(
            this.components[type].map(async (component) => component.write(record))
          );
          errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
        } catch (error) {
          errors = [error];
        }
        for (const error of errors) {
          await reportComponentError(type, error, options.errorLogging);
        }
      };
      const logFn = (...message) => {
        const task = send(message, readContext(options.context));
        this._pending.add(task);
        void task.finally(() => this._pending.delete(task));
        _chunkLL3KVXOKjs.runInBackground.call(void 0, options.platform, task, () => {
        });
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
      if (!this.components[type]) {
        throw new Error(
          `Logger type "${type}" was not defined when the logger was created and cannot be registered.`
        );
      }
      this.components[type].push(..._nullishCoalesce(newComponents[type], () => ( [])));
    }
    return this;
  }
  /**
   * Resolves once every message logged so far has been sent (or has failed and been reported).
   * Useful before the process exits, or at the end of a serverless request without `platform`.
   */
  async flush() {
    while (this._pending.size > 0) {
      await Promise.all(this._pending);
    }
  }
}, _class);
function readContext(context) {
  try {
    return context == null ? void 0 : context();
  } catch (e4) {
    return void 0;
  }
}
async function reportComponentError(type, error, errorLogging) {
  if (errorLogging) {
    try {
      await errorLogging(error);
      return;
    } catch (loggingError) {
      console.error(`Error in errorLogging callback for type "${type}":`, loggingError);
    }
  }
  console.error(`Error in logger component for type "${type}":`, error);
}

// src/logger/LilypadLoggerComponent.ts
var LilypadLoggerComponent = class {
  /**
   * Formats a record as `<ISO timestamp> - [name] [TYPE]: <message> <context as JSON>`.
   */
  formatRecord(record) {
    let formatted = `${record.timestamp.toISOString()} - `;
    if (record.loggerName) {
      formatted += `[${record.loggerName}] `;
    }
    formatted += `[${record.type.toUpperCase()}]: ${record.message}`;
    if (record.context && Object.keys(record.context).length > 0) {
      formatted += ` ${safeJson(record.context)}`;
    }
    return formatted;
  }
};
function writeToConsole(message, type) {
  switch (type.toLowerCase()) {
    case "error":
      console.error(message);
      break;
    case "warn":
      console.warn(message);
      break;
    default:
      console.log(message);
  }
}
function safeJson(value) {
  try {
    return JSON.stringify(toJsonSafe(value, /* @__PURE__ */ new Set()));
  } catch (e5) {
    return '"[Unserializable]"';
  }
}
function toJsonSafe(value, ancestors) {
  if (typeof value === "bigint") {
    return `${value}n`;
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (ancestors.has(value)) {
    return "[Circular]";
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  const json = value.toJSON;
  if (typeof json === "function") {
    return toJsonSafe(json.call(value), ancestors);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => toJsonSafe(item, ancestors));
    }
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = toJsonSafe(item, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

// src/logger/components/ConsoleLogger.ts
var LilypadConsoleLogger = class extends LilypadLoggerComponent {
  write(record) {
    writeToConsole(this.formatRecord(record), record.type);
    return Promise.resolve();
  }
};

// src/logger/components/JsonConsoleLogger.ts
var LilypadJsonConsoleLogger = class extends LilypadLoggerComponent {
  write(record) {
    const errors = record.parts.filter((part) => part instanceof Error);
    const line = safeJson({
      ...record.context,
      time: record.timestamp.toISOString(),
      level: record.type,
      ...record.loggerName !== void 0 && { logger: record.loggerName },
      msg: record.message,
      ...errors.length > 0 && {
        errors: errors.map((error) => ({
          name: error.name,
          message: error.message,
          stack: error.stack
        }))
      }
    });
    writeToConsole(line, record.type);
    return Promise.resolve();
  }
};

// src/logger/components/DiscordLogger.ts
var DISCORD_MAX_CONTENT_LENGTH = 2e3;
var DISCORD_REQUEST_TIMEOUT = 5e3;
var DEFAULT_RETRY_AFTER = 1e3;
var MAX_RETRY_AFTER = 3e4;
var DEFAULT_MAX_QUEUE_SIZE = 100;
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var LilypadDiscordLogger = (_class2 = class extends LilypadLoggerComponent {
  
  
  
  
  __init3() {this.queue = []}
  /** Messages dropped since the last batch, announced in the next one. */
  __init4() {this.dropped = 0}
  __init5() {this.flushing = false}
  __init6() {this.nextRequestAt = 0}
  constructor(webhookUrl, options = {}) {
    super();_class2.prototype.__init3.call(this);_class2.prototype.__init4.call(this);_class2.prototype.__init5.call(this);_class2.prototype.__init6.call(this);;
    this.webhookUrl = webhookUrl;
    this.minRequestInterval = _nullishCoalesce(options.minRequestInterval, () => ( 1e3));
    this.rateLimitRetries = _nullishCoalesce(options.rateLimitRetries, () => ( 1));
    this.maxQueueSize = Math.max(1, _nullishCoalesce(options.maxQueueSize, () => ( DEFAULT_MAX_QUEUE_SIZE)));
  }
  write(record) {
    return this.enqueue(this.formatRecord(record));
  }
  enqueue(message) {
    return new Promise((resolve, reject) => {
      var _a;
      this.queue.push({ content: message.slice(0, DISCORD_MAX_CONTENT_LENGTH), resolve, reject });
      while (this.queue.length > this.maxQueueSize) {
        (_a = this.queue.shift()) == null ? void 0 : _a.resolve();
        this.dropped++;
      }
      void this.flush();
    });
  }
  /**
   * Sends the queued messages, one batch at a time. It never rejects: the outcome of each batch
   * settles the promises of its messages.
   */
  async flush() {
    if (this.flushing) {
      return;
    }
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const wait = this.nextRequestAt - Date.now();
        if (wait > 0) {
          await sleep(wait);
        }
        await this.sendBatch(this.takeBatch());
      }
    } finally {
      this.flushing = false;
    }
  }
  /** Takes the queued messages that fit in one Discord message, always at least one. */
  takeBatch() {
    if (this.dropped > 0) {
      const notice = `\u2026 ${this.dropped} log messages dropped (queue full)`;
      this.dropped = 0;
      this.queue.unshift({ content: notice, resolve: () => {
      }, reject: () => {
      } });
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
    var _a;
    const content = batch.map((message) => message.content).join("\n");
    try {
      for (let attempt = 0; ; attempt++) {
        const response = await this.post(content);
        this.nextRequestAt = Date.now() + this.minRequestInterval;
        void ((_a = response.body) == null ? void 0 : _a.cancel().catch(() => {
        }));
        const retryAfter = response.status === 429 ? retryAfterMs(response) : void 0;
        if (retryAfter !== void 0 && retryAfter <= MAX_RETRY_AFTER && attempt < this.rateLimitRetries) {
          this.nextRequestAt = Date.now() + retryAfter;
          await sleep(retryAfter);
          continue;
        }
        if (!response.ok) {
          throw new Error(
            `Discord webhook request failed with status ${response.status} ${response.statusText}`
          );
        }
        batch.forEach((message) => message.resolve());
        return;
      }
    } catch (error) {
      this.nextRequestAt = Math.max(this.nextRequestAt, Date.now() + this.minRequestInterval);
      const [reported, ...others] = batch.slice().reverse();
      others.forEach((message) => message.resolve());
      reported == null ? void 0 : reported.reject(
        batch.length === 1 ? error : new Error(`${batch.length} log messages could not be sent to Discord`, {
          cause: error
        })
      );
    }
  }
  post(content) {
    return fetch(this.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT)
    });
  }
}, _class2);
function retryAfterMs(response) {
  var _a;
  const seconds = Number((_a = response.headers) == null ? void 0 : _a.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1e3 : DEFAULT_RETRY_AFTER;
}








exports.LILYPAD_DEFAULT_REDACTED_KEYS = LILYPAD_DEFAULT_REDACTED_KEYS; exports.LilypadLogger = LilypadLogger; exports.LilypadLoggerComponent = LilypadLoggerComponent; exports.LilypadConsoleLogger = LilypadConsoleLogger; exports.LilypadJsonConsoleLogger = LilypadJsonConsoleLogger; exports.LilypadDiscordLogger = LilypadDiscordLogger;
//# sourceMappingURL=chunk-BHGYXWCO.js.map