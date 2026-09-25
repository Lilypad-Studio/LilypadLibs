/** Nesting levels printed before objects are abbreviated as `[Object]` / `[Array]`. */
const MAX_DEPTH = 4;

/**
 * Formats a part of a log message, in a style close to `util.inspect` but without Node.js APIs,
 * so that the logger also runs in edge runtimes.
 * - Strings are returned as they are.
 * - Errors keep their stack (or name and message), their own properties (e.g. the `code` and
 *   `detail` of a database error) and their `cause`.
 * - It never throws: circular references print as `[Circular]`, BigInts as `10n`, a getter
 *   that throws as `[Getter threw]`.
 */
export function formatLogValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return formatNested(value, 0, new Set());
  } catch {
    // e.g. a Proxy whose traps throw
    return '[Unformattable value]';
  }
}

/** Properties of errors printed by the stack, or separately. */
const ERROR_OWN_KEYS = new Set(['name', 'stack', 'message', 'cause']);

function formatNested(value: unknown, depth: number, seen: Set<object>): string {
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
    return formatError(value, depth, seen);
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
      const items = value.map((item) => formatNested(item, depth + 1, seen));
      return items.length === 0 ? '[]' : `[ ${items.join(', ')} ]`;
    }
    if (value instanceof Map) {
      if (depth >= MAX_DEPTH) {
        return '[Map]';
      }
      const items = [...value].map(
        ([k, v]) => `${formatNested(k, depth + 1, seen)} => ${formatNested(v, depth + 1, seen)}`
      );
      return `Map(${value.size}) {${items.length ? ` ${items.join(', ')} ` : ''}}`;
    }
    if (value instanceof Set) {
      if (depth >= MAX_DEPTH) {
        return '[Set]';
      }
      const items = [...value].map((item) => formatNested(item, depth + 1, seen));
      return `Set(${value.size}) {${items.length ? ` ${items.join(', ')} ` : ''}}`;
    }
    if (depth >= MAX_DEPTH) {
      return '[Object]';
    }
    return formatProperties(value, depth, seen);
  } finally {
    seen.delete(value);
  }
}

function formatError(error: Error, depth: number, seen: Set<object>): string {
  seen.add(error);
  try {
    let formatted = error.stack ?? `${error.name}: ${error.message}`;
    if (depth < MAX_DEPTH) {
      const properties = formatProperties(error, depth, seen, ERROR_OWN_KEYS);
      if (properties !== '{}') {
        formatted += ` ${properties}`;
      }
    }
    if (error.cause !== undefined) {
      formatted += `\n[cause]: ${formatNested(error.cause, depth + 1, seen)}`;
    }
    return formatted;
  } finally {
    seen.delete(error);
  }
}

/**
 * The own enumerable properties of an object, as `{ key: value, ... }`. A getter that throws does
 * not stop the others from being printed.
 */
function formatProperties(
  value: object,
  depth: number,
  seen: Set<object>,
  excluded?: Set<string>
): string {
  const entries: string[] = [];
  for (const key of Object.keys(value)) {
    if (excluded?.has(key)) {
      continue;
    }
    let item: unknown;
    try {
      item = (value as Record<string, unknown>)[key];
    } catch {
      entries.push(`${formatKey(key)}: [Getter threw]`);
      continue;
    }
    entries.push(`${formatKey(key)}: ${formatNested(item, depth + 1, seen)}`);
  }
  return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
}

function formatKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : `'${key}'`;
}
