"use strict";Object.defineProperty(exports, "__esModule", {value: true}); function _nullishCoalesce(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return rhsFn(); } } var _class; var _class2;

var _chunkLL3KVXOKjs = require('./chunk-LL3KVXOK.js');


var _chunkGU4ZU4STjs = require('./chunk-GU4ZU4ST.js');

// src/logger/formatLogValue.ts
var MAX_DEPTH = 4;
function formatLogValue(value) {
  return typeof value === "string" ? value : formatNested(value, 0, /* @__PURE__ */ new Set());
}
function formatNested(value, depth, seen) {
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
    return formatError(value, depth, seen);
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
      const items = value.map((item) => formatNested(item, depth + 1, seen));
      return items.length === 0 ? "[]" : `[ ${items.join(", ")} ]`;
    }
    if (value instanceof Map) {
      if (depth >= MAX_DEPTH) {
        return "[Map]";
      }
      const items = [...value].map(
        ([k, v]) => `${formatNested(k, depth + 1, seen)} => ${formatNested(v, depth + 1, seen)}`
      );
      return `Map(${value.size}) {${items.length ? ` ${items.join(", ")} ` : ""}}`;
    }
    if (value instanceof Set) {
      if (depth >= MAX_DEPTH) {
        return "[Set]";
      }
      const items = [...value].map((item) => formatNested(item, depth + 1, seen));
      return `Set(${value.size}) {${items.length ? ` ${items.join(", ")} ` : ""}}`;
    }
    if (depth >= MAX_DEPTH) {
      return "[Object]";
    }
    const entries = Object.entries(value).map(
      ([key, item]) => `${formatKey(key)}: ${formatNested(item, depth + 1, seen)}`
    );
    return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
  } finally {
    seen.delete(value);
  }
}
function formatError(error, depth, seen) {
  seen.add(error);
  try {
    let formatted = _nullishCoalesce(error.stack, () => ( `${error.name}: ${error.message}`));
    if (error.cause !== void 0) {
      formatted += `
[cause]: ${formatNested(error.cause, depth + 1, seen)}`;
    }
    return formatted;
  } finally {
    seen.delete(error);
  }
}
function formatKey(key) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : `'${key}'`;
}

// src/logger/LilypadLogger.ts
var LilypadLogger = (_class = class _LilypadLogger {
  __init() {this.components = {}}
  // Optional logger name
  
  get __name() {
    return this._name;
  }
  /** The messages still being sent, awaited by `flush`. */
  __init2() {this._pending = /* @__PURE__ */ new Set()}
  /**
   * Creates a new LilypadLogger instance or retrieves a singleton instance.
   *
   * @template T - The log level type, defaults to 'log' | 'error' | 'warn'
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
    if (options.singleton) {
      const registryKey = `LilypadLogger:${options.singletonIdentifier}`;
      return _chunkGU4ZU4STjs.getLilypadSingletonInstance.call(void 0, registryKey, () => new _LilypadLogger(options), {
        // No secrets in these options: the signature can stay in clear text
        value: JSON.stringify([options.name, Object.keys(options.components).sort()]),
        onMismatch: () => console.warn(
          `LilypadLogger singleton "${options.singletonIdentifier}" already exists with different options: the new options are ignored.`
        )
      });
    }
    return new _LilypadLogger(options);
  }
  constructor(options) {;_class.prototype.__init.call(this);_class.prototype.__init2.call(this);
    const reservedKeys = /* @__PURE__ */ new Set([
      "components",
      "register",
      "flush",
      "__name",
      "_name",
      "_pending",
      "then"
    ]);
    for (const key of Object.keys(options.components)) {
      if (reservedKeys.has(key) || key in this) {
        throw new Error(`Logger type "${key}" is reserved and cannot be used as a log channel.`);
      }
    }
    this._name = options.name;
    for (const [type, comps] of Object.entries(options.components)) {
      this.components[type] = [...comps];
    }
    for (const type of Object.keys(this.components)) {
      const send = async (message, context) => {
        let errors;
        try {
          const record = {
            type,
            message: message.map(formatLogValue).join(" "),
            parts: message,
            timestamp: /* @__PURE__ */ new Date(),
            loggerName: this._name,
            context
          };
          const results = await Promise.allSettled(
            this.components[type].map(
              async (component) => component.output(type, record.message, {
                logger: this,
                record
              })
            )
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
  } catch (e) {
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
function createLogger(options) {
  return LilypadLogger.create(options);
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
  async output(type, message, options) {
    var _a;
    const record = _nullishCoalesce((options == null ? void 0 : options.record), () => ( {
      type,
      message,
      parts: [message],
      timestamp: /* @__PURE__ */ new Date(),
      loggerName: (_a = options == null ? void 0 : options.logger) == null ? void 0 : _a.__name
    }));
    await this.sendRecord(record);
  }
  /**
   * Sends a record to the output. By default it formats the record with {@link formatRecord}
   * and passes it to {@link send}.
   */
  async sendRecord(record) {
    await this.send(this.formatRecord(record), record.type);
  }
};
function safeJson(value) {
  const seen = /* @__PURE__ */ new WeakSet();
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === "bigint") {
        return `${item}n`;
      }
      if (item instanceof Error) {
        return { name: item.name, message: item.message, stack: item.stack };
      }
      if (typeof item === "object" && item !== null) {
        if (seen.has(item)) {
          return "[Circular]";
        }
        seen.add(item);
      }
      return item;
    });
  } catch (e2) {
    return '"[Unserializable]"';
  }
}

// src/logger/components/ConsoleLogger.ts
var LilypadConsoleLogger = class extends LilypadLoggerComponent {
  async send(message, type) {
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
};

// src/logger/components/JsonConsoleLogger.ts
var LilypadJsonConsoleLogger = class extends LilypadLoggerComponent {
  async sendRecord(record) {
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
    await this.send(line, record.type);
  }
  async send(message, type) {
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
};

// src/logger/components/DiscordLogger.ts
var DISCORD_MAX_CONTENT_LENGTH = 2e3;
var DISCORD_REQUEST_TIMEOUT = 5e3;
var DEFAULT_RETRY_AFTER = 1e3;
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var LilypadDiscordLogger = (_class2 = class extends LilypadLoggerComponent {
  
  
  
  __init3() {this.queue = []}
  __init4() {this.flushing = false}
  __init5() {this.nextRequestAt = 0}
  constructor(webhookUrl, options = {}) {
    super();_class2.prototype.__init3.call(this);_class2.prototype.__init4.call(this);_class2.prototype.__init5.call(this);;
    this.webhookUrl = webhookUrl;
    this.minRequestInterval = _nullishCoalesce(options.minRequestInterval, () => ( 1e3));
    this.rateLimitRetries = _nullishCoalesce(options.rateLimitRetries, () => ( 1));
  }
  send(message) {
    return new Promise((resolve, reject) => {
      this.queue.push({ content: message.slice(0, DISCORD_MAX_CONTENT_LENGTH), resolve, reject });
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
      for (let attempt = 0; ; attempt++) {
        const response = await this.post(content);
        this.nextRequestAt = Date.now() + this.minRequestInterval;
        if (response.status === 429 && attempt < this.rateLimitRetries) {
          this.nextRequestAt = Date.now() + retryAfterMs(response);
          await sleep(this.nextRequestAt - Date.now());
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
      batch.forEach((message) => message.reject(error));
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








exports.LilypadLogger = LilypadLogger; exports.createLogger = createLogger; exports.LilypadLoggerComponent = LilypadLoggerComponent; exports.LilypadConsoleLogger = LilypadConsoleLogger; exports.LilypadJsonConsoleLogger = LilypadJsonConsoleLogger; exports.LilypadDiscordLogger = LilypadDiscordLogger;
//# sourceMappingURL=chunk-MRWDJMGP.js.map