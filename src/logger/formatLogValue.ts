/** Nesting levels printed before objects are abbreviated as `[Object]` / `[Array]`. */
const MAX_DEPTH = 4;

/**
 * The keys whose values the logger replaces with `[Redacted]` by default, wherever they appear in
 * a logged value or in the context (e.g. the headers of the request of an HTTP client error).
 * Keys are compared ignoring case, `-` and `_`: `apiKey`, `api_key` and `API-KEY` all match.
 */
export const LILYPAD_DEFAULT_REDACTED_KEYS: readonly string[] = Object.freeze([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'password',
  'passwd',
  'secret',
  'client_secret',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'api_key',
  'x-api-key',
  'private_key',
]);

const REDACTED = '[Redacted]';

function normalizeRedactedKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

/** The keys to redact, in the form that `formatLogValue` and `redactLogValue` compare. */
export function lilypadRedaction(keys: readonly string[]): ReadonlySet<string> {
  return new Set(keys.map(normalizeRedactedKey));
}

const DEFAULT_REDACTION = lilypadRedaction(LILYPAD_DEFAULT_REDACTED_KEYS);

function isRedacted(key: unknown, redaction: ReadonlySet<string>): boolean {
  return typeof key === 'string' && redaction.size > 0 && redaction.has(normalizeRedactedKey(key));
}

/**
 * A copy of `value` whose redacted keys hold `[Redacted]`, for the values serialized as JSON later
 * (the context of a record). Plain objects and arrays are copied; errors and objects with a
 * `toJSON` method are kept as they are. It never throws.
 */
export function redactLogValue(
  value: unknown,
  redaction: ReadonlySet<string> = DEFAULT_REDACTION,
  ancestors: Set<object> = new Set()
): unknown {
  if (redaction.size === 0 || typeof value !== 'object' || value === null) {
    return value;
  }
  if (ancestors.has(value)) {
    return '[Circular]';
  }
  try {
    if (value instanceof Error || typeof (value as { toJSON?: unknown }).toJSON === 'function') {
      return value;
    }
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((item) => redactLogValue(item, redaction, ancestors));
      }
      const copy: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        copy[key] = isRedacted(key, redaction)
          ? REDACTED
          : redactLogValue(item, redaction, ancestors);
      }
      return copy;
    } finally {
      ancestors.delete(value);
    }
  } catch {
    // e.g. a getter or a Proxy trap that throws
    return '[Unformattable value]';
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
export function formatLogValue(
  value: unknown,
  redaction: ReadonlySet<string> = DEFAULT_REDACTION
): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return formatNested(value, 0, { seen: new Set(), redaction });
  } catch {
    // e.g. a Proxy whose traps throw
    return '[Unformattable value]';
  }
}

/** Properties of errors printed by the stack, or separately. */
const ERROR_OWN_KEYS = new Set(['name', 'stack', 'message', 'cause']);

type FormatState = { seen: Set<object>; redaction: ReadonlySet<string> };

function formatNested(value: unknown, depth: number, state: FormatState): string {
  const { seen } = state;
  switch (typeof value) {
    case 'string':
      return depth === 0 ? value : `'${value.replace(/'/g, "\\'")}'`;
    case 'bigint':
      return `${value}n`;
    case 'symbol':
      return value.toString();
    case 'function':
      return `[Function: ${value.name || '(anonymous)'}]`;
    case 'object':
      break;
    default:
      return String(value);
  }
  if (value === null) {
    return 'null';
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  if (value instanceof Error) {
    return formatError(value, depth, state);
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }
  if (value instanceof RegExp) {
    return value.toString();
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (depth >= MAX_DEPTH) {
        return '[Array]';
      }
      const items = value.map((item) => formatNested(item, depth + 1, state));
      return items.length === 0 ? '[]' : `[ ${items.join(', ')} ]`;
    }
    if (value instanceof Map) {
      if (depth >= MAX_DEPTH) {
        return '[Map]';
      }
      const items = [...value].map(
        ([k, v]) =>
          `${formatNested(k, depth + 1, state)} => ${
            isRedacted(k, state.redaction) ? REDACTED : formatNested(v, depth + 1, state)
          }`
      );
      return `Map(${value.size}) {${items.length ? ` ${items.join(', ')} ` : ''}}`;
    }
    if (value instanceof Set) {
      if (depth >= MAX_DEPTH) {
        return '[Set]';
      }
      const items = [...value].map((item) => formatNested(item, depth + 1, state));
      return `Set(${value.size}) {${items.length ? ` ${items.join(', ')} ` : ''}}`;
    }
    if (depth >= MAX_DEPTH) {
      return '[Object]';
    }
    return formatProperties(value, depth, state);
  } finally {
    seen.delete(value);
  }
}

function formatError(error: Error, depth: number, state: FormatState): string {
  state.seen.add(error);
  try {
    let formatted = error.stack ?? `${error.name}: ${error.message}`;
    if (depth < MAX_DEPTH) {
      const properties = formatProperties(error, depth, state, ERROR_OWN_KEYS);
      if (properties !== '{}') {
        formatted += ` ${properties}`;
      }
    }
    if (error.cause !== undefined) {
      formatted += `\n[cause]: ${formatNested(error.cause, depth + 1, state)}`;
    }
    return formatted;
  } finally {
    state.seen.delete(error);
  }
}

/**
 * The own enumerable properties of an object, as `{ key: value, ... }`. A getter that throws does
 * not stop the others from being printed.
 */
function formatProperties(
  value: object,
  depth: number,
  state: FormatState,
  excluded?: Set<string>
): string {
  const entries: string[] = [];
  for (const key of Object.keys(value)) {
    if (excluded?.has(key)) {
      continue;
    }
    if (isRedacted(key, state.redaction)) {
      entries.push(`${formatKey(key)}: ${REDACTED}`);
      continue;
    }
    let item: unknown;
    try {
      item = (value as Record<string, unknown>)[key];
    } catch {
      entries.push(`${formatKey(key)}: [Getter threw]`);
      continue;
    }
    entries.push(`${formatKey(key)}: ${formatNested(item, depth + 1, state)}`);
  }
  return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
}

function formatKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : `'${key}'`;
}
