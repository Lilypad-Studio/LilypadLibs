/** Nesting levels printed in the text form before objects are abbreviated as `[Object]` / `[Array]`. */
const MAX_TEXT_DEPTH = 4;
/** Nesting levels kept in the JSON form: beyond, a value is abbreviated too (pathological depth). */
const MAX_JSON_DEPTH = 64;

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

function normalizeRedactedKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

/** The keys to redact, in the form that the functions of this module compare. */
export function lilypadRedaction(keys: readonly string[]): ReadonlySet<string> {
  return new Set(keys.map(normalizeRedactedKey));
}

const DEFAULT_REDACTION = lilypadRedaction(LILYPAD_DEFAULT_REDACTED_KEYS);
const NO_REDACTION: ReadonlySet<string> = new Set();

function isRedacted(key: unknown, redaction: ReadonlySet<string>): boolean {
  return typeof key === 'string' && redaction.size > 0 && redaction.has(normalizeRedactedKey(key));
}

/**
 * A logged value, normalized once by {@link walk}: the text form and the JSON form are rendered
 * from it, so that both handle cycles, redaction, errors and throwing getters the same way.
 */
type LogNode =
  | { kind: 'string'; value: string }
  | { kind: 'scalar'; value: number | boolean | null | undefined }
  /** Printed as it is, and a string in JSON: a BigInt, a symbol, a function, a `RegExp`. */
  | { kind: 'text'; text: string }
  /** `[Circular]`, `[Redacted]`, `[Getter threw]`, `[Object]`...: never quoted. */
  | { kind: 'marker'; text: string }
  | { kind: 'date'; iso: string | null }
  | { kind: 'array'; items: LogNode[] }
  | { kind: 'map'; entries: [LogNode, LogNode][] }
  | { kind: 'set'; items: LogNode[] }
  | { kind: 'object'; properties: [string, LogNode][] }
  | {
      kind: 'error';
      name: string;
      message: string;
      stack: string | undefined;
      /** Its own properties; `undefined` beyond the depth of the text form. */
      properties: [string, LogNode][] | undefined;
      cause: LogNode | undefined;
    };

const marker = (text: string): LogNode => ({ kind: 'marker', text });
const REDACTED = marker('[Redacted]');

type WalkState = {
  /** The ancestors of the value being walked: only a reference to one of them is circular. */
  seen: Set<object>;
  redaction: ReadonlySet<string>;
  /** The JSON form follows `toJSON`, as `JSON.stringify` would; the text form prints the object. */
  json: boolean;
  maxDepth: number;
};

/** Properties of errors printed by the stack, or separately. */
const ERROR_OWN_KEYS = new Set(['name', 'stack', 'message', 'cause']);

function walk(value: unknown, depth: number, state: WalkState): LogNode {
  switch (typeof value) {
    case 'string':
      return { kind: 'string', value };
    case 'bigint':
      return { kind: 'text', text: `${value}n` };
    case 'symbol':
      return { kind: 'text', text: value.toString() };
    case 'function':
      return { kind: 'text', text: `[Function: ${value.name || '(anonymous)'}]` };
    case 'object':
      break;
    default:
      return { kind: 'scalar', value: value as number | boolean | undefined };
  }
  if (value === null) {
    return { kind: 'scalar', value: null };
  }
  const { seen } = state;
  if (seen.has(value)) {
    return marker('[Circular]');
  }
  if (value instanceof Error) {
    return walkError(value, depth, state);
  }
  if (value instanceof Date) {
    return { kind: 'date', iso: Number.isNaN(value.getTime()) ? null : value.toISOString() };
  }
  if (value instanceof RegExp) {
    return { kind: 'text', text: value.toString() };
  }
  if (state.json) {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') {
      // What JSON.stringify would write, redacted like the rest
      seen.add(value);
      try {
        return walk(toJSON.call(value), depth, state);
      } finally {
        seen.delete(value);
      }
    }
  }
  if (depth >= state.maxDepth) {
    return marker(
      Array.isArray(value)
        ? '[Array]'
        : value instanceof Map
          ? '[Map]'
          : value instanceof Set
            ? '[Set]'
            : '[Object]'
    );
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return { kind: 'array', items: value.map((item) => walk(item, depth + 1, state)) };
    }
    if (value instanceof Map) {
      return {
        kind: 'map',
        entries: [...value].map(([key, item]) => [
          walk(key, depth + 1, state),
          isRedacted(key, state.redaction) ? REDACTED : walk(item, depth + 1, state),
        ]),
      };
    }
    if (value instanceof Set) {
      return { kind: 'set', items: [...value].map((item) => walk(item, depth + 1, state)) };
    }
    return { kind: 'object', properties: walkProperties(value, depth, state) };
  } finally {
    seen.delete(value);
  }
}

function walkError(error: Error, depth: number, state: WalkState): LogNode {
  state.seen.add(error);
  try {
    return {
      kind: 'error',
      name: error.name,
      message: error.message,
      stack: error.stack,
      properties:
        depth < state.maxDepth ? walkProperties(error, depth, state, ERROR_OWN_KEYS) : undefined,
      cause: error.cause !== undefined ? walk(error.cause, depth + 1, state) : undefined,
    };
  } finally {
    state.seen.delete(error);
  }
}

/** The own enumerable properties of an object. A getter that throws does not stop the others. */
function walkProperties(
  value: object,
  depth: number,
  state: WalkState,
  excluded?: Set<string>
): [string, LogNode][] {
  const properties: [string, LogNode][] = [];
  for (const key of Object.keys(value)) {
    if (excluded?.has(key)) {
      continue;
    }
    if (isRedacted(key, state.redaction)) {
      properties.push([key, REDACTED]);
      continue;
    }
    let item: unknown;
    try {
      item = (value as Record<string, unknown>)[key];
    } catch {
      properties.push([key, marker('[Getter threw]')]);
      continue;
    }
    properties.push([key, walk(item, depth + 1, state)]);
  }
  return properties;
}

function renderText(node: LogNode, depth: number): string {
  switch (node.kind) {
    case 'string':
      return depth === 0 ? node.value : `'${node.value.replace(/'/g, "\\'")}'`;
    case 'scalar':
      return String(node.value);
    case 'text':
    case 'marker':
      return node.text;
    case 'date':
      return node.iso ?? 'Invalid Date';
    case 'array': {
      const items = node.items.map((item) => renderText(item, depth + 1));
      return items.length === 0 ? '[]' : `[ ${items.join(', ')} ]`;
    }
    case 'map': {
      const items = node.entries.map(
        ([key, item]) => `${renderText(key, depth + 1)} => ${renderText(item, depth + 1)}`
      );
      return `Map(${items.length}) {${items.length ? ` ${items.join(', ')} ` : ''}}`;
    }
    case 'set': {
      const items = node.items.map((item) => renderText(item, depth + 1));
      return `Set(${items.length}) {${items.length ? ` ${items.join(', ')} ` : ''}}`;
    }
    case 'object':
      return renderProperties(node.properties, depth);
    case 'error': {
      let formatted = node.stack ?? `${node.name}: ${node.message}`;
      if (node.properties) {
        const properties = renderProperties(node.properties, depth);
        if (properties !== '{}') {
          formatted += ` ${properties}`;
        }
      }
      if (node.cause) {
        formatted += `\n[cause]: ${renderText(node.cause, depth + 1)}`;
      }
      return formatted;
    }
  }
}

function renderProperties(properties: [string, LogNode][], depth: number): string {
  const entries = properties.map(
    ([key, item]) => `${formatKey(key)}: ${renderText(item, depth + 1)}`
  );
  return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
}

function formatKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : `'${key}'`;
}

function renderJson(node: LogNode): unknown {
  switch (node.kind) {
    case 'string':
    case 'scalar':
      return node.value;
    case 'text':
    case 'marker':
      return node.text;
    case 'date':
      return node.iso;
    case 'array':
    case 'set':
      return node.items.map(renderJson);
    case 'map':
      return Object.fromEntries(
        node.entries.map(([key, item]) => [
          key.kind === 'string' ? key.value : renderText(key, 0),
          renderJson(item),
        ])
      );
    case 'object':
      return Object.fromEntries(node.properties.map(([key, item]) => [key, renderJson(item)]));
    case 'error':
      return {
        name: node.name,
        message: node.message,
        stack: node.stack,
        ...Object.fromEntries(
          (node.properties ?? []).map(([key, item]) => [key, renderJson(item)])
        ),
        ...(node.cause && { cause: renderJson(node.cause) }),
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
export function formatLogValue(
  value: unknown,
  redaction: ReadonlySet<string> = DEFAULT_REDACTION
): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    const node = walk(value, 0, {
      seen: new Set(),
      redaction,
      json: false,
      maxDepth: MAX_TEXT_DEPTH,
    });
    return renderText(node, 0);
  } catch {
    // e.g. a Proxy whose traps throw
    return '[Unformattable value]';
  }
}

/**
 * The JSON-safe copy of a logged value (the context of a record, a JSON log line), with the values
 * of the keys of `redaction` replaced with `[Redacted]` at any depth. It follows `toJSON` as
 * `JSON.stringify` does, then redacts what it returns; errors become `{ name, message, stack }`
 * with their own properties and their `cause`; BigInts become `10n`; a reference to an ancestor
 * becomes `[Circular]`. It never throws.
 */
export function toLogJson(
  value: unknown,
  redaction: ReadonlySet<string> = DEFAULT_REDACTION
): unknown {
  try {
    return renderJson(
      walk(value, 0, { seen: new Set(), redaction, json: true, maxDepth: MAX_JSON_DEPTH })
    );
  } catch {
    // e.g. a getter of a nested value or a Proxy trap that throws
    return '[Unformattable value]';
  }
}

/** `JSON.stringify` that never throws, over {@link toLogJson} without redaction. */
export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(toLogJson(value, NO_REDACTION)) ?? 'undefined';
  } catch {
    return '"[Unserializable]"';
  }
}
