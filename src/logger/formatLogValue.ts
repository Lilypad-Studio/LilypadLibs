/** Nesting levels printed in the text form before objects are abbreviated as `[Object]` / `[Array]`. */
const MAX_TEXT_DEPTH = 4;
/** Nesting levels kept in the JSON form: beyond, a value is abbreviated too (pathological depth). */
const MAX_JSON_DEPTH = 64;
/** Items printed per array, set, map or object in the text form; the others are counted. */
const MAX_TEXT_ITEMS = 100;
/**
 * Objects walked per value, in both forms: beyond, they are abbreviated as `[…]`. An object
 * referenced twice is walked twice (only a reference to an ancestor is circular), so a value whose
 * levels share their children doubles at each level: the budget bounds the work whatever the shape.
 */
const MAX_WALKED_OBJECTS = 10_000;

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

/** The password of a URL (`scheme://user:password@host`), e.g. of a connection string. */
const URL_PASSWORD = /(\b[a-z][a-z\d+.-]*:\/\/[^\s/?#@:]*:)[^\s/?#]*@/gi;

/** Masks the passwords of the URLs of a string, unless redaction is off ({@link NO_REDACTION}). */
export function redactUrlPasswords(text: string, redaction: ReadonlySet<string>): string {
  return redaction !== NO_REDACTION && text.includes('://')
    ? text.replace(URL_PASSWORD, '$1[Redacted]@')
    : text;
}

const DEFAULT_REDACTION = lilypadRedaction(LILYPAD_DEFAULT_REDACTED_KEYS);
/** Redaction off (`redact: false`): no key, and the passwords of URLs are kept too. */
export const NO_REDACTION: ReadonlySet<string> = new Set();

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
  /** `more`: the items left out beyond `MAX_TEXT_ITEMS` (text form only). */
  | { kind: 'array'; items: LogNode[]; more: number }
  | { kind: 'map'; entries: [LogNode, LogNode][]; more: number }
  | { kind: 'set'; items: LogNode[]; more: number }
  | { kind: 'object'; properties: WalkedProperties }
  | {
      kind: 'error';
      name: string;
      message: string;
      stack: string | undefined;
      /** Its own properties; `undefined` beyond the depth of the text form. */
      properties: WalkedProperties | undefined;
      cause: LogNode | undefined;
    };

type WalkedProperties = { entries: [string, LogNode][]; more: number };

const marker = (text: string): LogNode => ({ kind: 'marker', text });
const REDACTED = marker('[Redacted]');

type WalkState = {
  /** The ancestors of the value being walked: only a reference to one of them is circular. */
  seen: Set<object>;
  redaction: ReadonlySet<string>;
  /** The JSON form follows `toJSON`, as `JSON.stringify` would; the text form prints the object. */
  json: boolean;
  maxDepth: number;
  maxItems: number;
  /** The objects that can still be walked (see `MAX_WALKED_OBJECTS`). */
  budget: number;
};

/** Properties of errors printed by the stack, or separately. */
const ERROR_OWN_KEYS = new Set(['name', 'stack', 'message', 'cause']);
const AGGREGATE_ERROR_OWN_KEYS = new Set([...ERROR_OWN_KEYS, 'errors']);

/**
 * Walks a value. A part that cannot be read (a `toJSON` or an iterator that throws, a Proxy trap)
 * becomes `[Unformattable value]` without losing the rest of the value.
 */
function walk(value: unknown, depth: number, state: WalkState): LogNode {
  try {
    return walkValue(value, depth, state);
  } catch {
    return marker('[Unformattable value]');
  }
}

function walkValue(value: unknown, depth: number, state: WalkState): LogNode {
  switch (typeof value) {
    case 'string':
      return { kind: 'string', value: redactUrlPasswords(value, state.redaction) };
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
  if (--state.budget < 0) {
    return marker('[…]');
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
      const items: LogNode[] = [];
      const shown = Math.min(value.length, state.maxItems);
      for (let index = 0; index < shown; index++) {
        items.push(walk(value[index], depth + 1, state));
      }
      return { kind: 'array', items, more: value.length - shown };
    }
    if (value instanceof Map) {
      const entries: [LogNode, LogNode][] = [];
      for (const [key, item] of value as Map<unknown, unknown>) {
        if (entries.length === state.maxItems) {
          break;
        }
        entries.push([
          walk(key, depth + 1, state),
          isRedacted(key, state.redaction) ? REDACTED : walk(item, depth + 1, state),
        ]);
      }
      return { kind: 'map', entries, more: value.size - entries.length };
    }
    if (value instanceof Set) {
      const items: LogNode[] = [];
      for (const item of value as Set<unknown>) {
        if (items.length === state.maxItems) {
          break;
        }
        items.push(walk(item, depth + 1, state));
      }
      return { kind: 'set', items, more: value.size - items.length };
    }
    return { kind: 'object', properties: walkProperties(value, depth, state) };
  } finally {
    seen.delete(value);
  }
}

function walkError(error: Error, depth: number, state: WalkState): LogNode {
  state.seen.add(error);
  try {
    const aggregate = error instanceof AggregateError;
    const properties =
      depth < state.maxDepth
        ? walkProperties(error, depth, state, aggregate ? AGGREGATE_ERROR_OWN_KEYS : ERROR_OWN_KEYS)
        : undefined;
    if (properties && aggregate) {
      // Not enumerable, and often what explains the error (e.g. each address a connection tried)
      properties.entries.push([
        'errors',
        isRedacted('errors', state.redaction) ? REDACTED : walk(error.errors, depth + 1, state),
      ]);
    }
    return {
      kind: 'error',
      name: error.name,
      message: redactUrlPasswords(error.message, state.redaction),
      stack:
        error.stack === undefined ? undefined : redactUrlPasswords(error.stack, state.redaction),
      properties,
      cause: error.cause !== undefined ? walk(error.cause, depth + 1, state) : undefined,
    };
  } finally {
    state.seen.delete(error);
  }
}

/**
 * The own enumerable properties of an object, at most `maxItems`. A getter that throws does not
 * stop the others.
 */
function walkProperties(
  value: object,
  depth: number,
  state: WalkState,
  excluded?: Set<string>
): WalkedProperties {
  const keys = Object.keys(value).filter((key) => !excluded?.has(key));
  const entries: [string, LogNode][] = [];
  for (const key of keys.slice(0, state.maxItems)) {
    if (isRedacted(key, state.redaction)) {
      entries.push([key, REDACTED]);
      continue;
    }
    let item: unknown;
    try {
      item = (value as Record<string, unknown>)[key];
    } catch {
      entries.push([key, marker('[Getter threw]')]);
      continue;
    }
    entries.push([key, walk(item, depth + 1, state)]);
  }
  return { entries, more: keys.length - entries.length };
}

function renderText(node: LogNode, depth: number): string {
  switch (node.kind) {
    case 'string':
      return depth === 0 ? node.value : quote(node.value);
    case 'scalar':
      return String(node.value);
    case 'text':
    case 'marker':
      return node.text;
    case 'date':
      return node.iso ?? 'Invalid Date';
    case 'array': {
      const items = withMore(
        node.items.map((item) => renderText(item, depth + 1)),
        node.more,
        'items'
      );
      return items.length === 0 ? '[]' : `[ ${items.join(', ')} ]`;
    }
    case 'map': {
      const items = withMore(
        node.entries.map(
          ([key, item]) => `${renderText(key, depth + 1)} => ${renderText(item, depth + 1)}`
        ),
        node.more,
        'items'
      );
      const size = node.entries.length + node.more;
      return `Map(${size}) {${items.length ? ` ${items.join(', ')} ` : ''}}`;
    }
    case 'set': {
      const items = withMore(
        node.items.map((item) => renderText(item, depth + 1)),
        node.more,
        'items'
      );
      const size = node.items.length + node.more;
      return `Set(${size}) {${items.length ? ` ${items.join(', ')} ` : ''}}`;
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

function renderProperties(properties: WalkedProperties, depth: number): string {
  const entries = withMore(
    properties.entries.map(([key, item]) => `${formatKey(key)}: ${renderText(item, depth + 1)}`),
    properties.more,
    'properties'
  );
  return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
}

/** The rendered items, followed by the count of those left out, like `util.inspect`. */
function withMore(items: string[], more: number, noun: 'items' | 'properties'): string[] {
  return more > 0 ? [...items, `… ${more} more ${noun}`] : items;
}

function formatKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : quote(key);
}

/**
 * A nested string or a key between single quotes, with its line breaks and control characters
 * escaped as in JSON: a logged value cannot start a new line of the output.
 */
function quote(text: string): string {
  const escaped = JSON.stringify(text).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'");
  return `'${escaped}'`;
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
      return Object.fromEntries(
        node.properties.entries.map(([key, item]) => [key, renderJson(item)])
      );
    case 'error':
      return {
        name: node.name,
        message: node.message,
        stack: node.stack,
        ...Object.fromEntries(
          (node.properties?.entries ?? []).map(([key, item]) => [key, renderJson(item)])
        ),
        ...(node.cause && { cause: renderJson(node.cause) }),
      };
  }
}

/**
 * Formats a part of a log message, in a style close to `util.inspect` but without Node.js APIs,
 * so that the logger also runs in edge runtimes.
 * - Strings are returned as they are, except the passwords of URLs (`scheme://user:[Redacted]@`),
 *   masked in every string unless redaction is off ({@link NO_REDACTION}, even with no key).
 * - Errors keep their stack (or name and message), their own properties (e.g. the `code` and
 *   `detail` of a database error) and their `cause`.
 * - It never throws: circular references print as `[Circular]`, BigInts as `10n`, a getter
 *   that throws as `[Getter threw]`, any other part that cannot be read (a Proxy trap, an
 *   iterator that throws) as `[Unformattable value]`.
 * - An `AggregateError` also prints its `errors`.
 * - Its size is bounded: 100 items per array, set, map or object (then `… 900 more items`), 4
 *   levels of nesting (then `[Object]`), 10,000 objects in all (then `[…]`).
 * - The values of the keys of `redaction` print as `[Redacted]` (by default, the keys of
 *   {@link LILYPAD_DEFAULT_REDACTED_KEYS}).
 */
export function formatLogValue(
  value: unknown,
  redaction: ReadonlySet<string> = DEFAULT_REDACTION
): string {
  if (typeof value === 'string') {
    return redactUrlPasswords(value, redaction);
  }
  try {
    const node = walk(value, 0, {
      seen: new Set(),
      redaction,
      json: false,
      maxDepth: MAX_TEXT_DEPTH,
      maxItems: MAX_TEXT_ITEMS,
      budget: MAX_WALKED_OBJECTS,
    });
    return renderText(node, 0);
  } catch {
    // The walk already isolates each value: e.g. an output too long to build a string
    return '[Unformattable value]';
  }
}

/**
 * The JSON-safe copy of a logged value (the context of a record, a JSON log line), with the values
 * of the keys of `redaction` replaced with `[Redacted]` at any depth (and the passwords of URLs in
 * its strings, unless redaction is off). It follows `toJSON` as
 * `JSON.stringify` does, then redacts what it returns; errors become `{ name, message, stack }`
 * with their own properties and their `cause` (and an `AggregateError` its `errors`); BigInts
 * become `10n`; a part that cannot be read becomes `[Unformattable value]`; a reference to an ancestor
 * becomes `[Circular]`. It keeps every item, up to 64 levels of nesting and 10,000 objects in all
 * (then `[…]`). It never throws.
 */
export function toLogJson(
  value: unknown,
  redaction: ReadonlySet<string> = DEFAULT_REDACTION
): unknown {
  try {
    return renderJson(
      walk(value, 0, {
        seen: new Set(),
        redaction,
        json: true,
        maxDepth: MAX_JSON_DEPTH,
        maxItems: Number.POSITIVE_INFINITY,
        budget: MAX_WALKED_OBJECTS,
      })
    );
  } catch {
    // The walk already isolates each value: e.g. a stack overflow
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
