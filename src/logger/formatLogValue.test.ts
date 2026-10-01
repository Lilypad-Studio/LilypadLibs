import { describe, it, expect } from 'vitest';
import { formatLogValue, lilypadRedaction, NO_REDACTION, toLogJson } from './formatLogValue';

describe('formatLogValue', () => {
  it.each([
    ['plain strings as they are', 'hello', 'hello'],
    ['numbers', 42, '42'],
    ['BigInts', 10n, '10n'],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
    ['symbols', Symbol('s'), 'Symbol(s)'],
    ['functions', function named() {}, '[Function: named]'],
    ['nested strings quoted', { a: "it's" }, "{ a: 'it\\'s' }"],
    ['objects', { key: 'value', n: 1 }, "{ key: 'value', n: 1 }"],
    ['keys that are not identifiers', { 'a-b': 1 }, "{ 'a-b': 1 }"],
    ['empty objects and arrays', [{}, []], '[ {}, [] ]'],
    ['arrays', [1, 'two'], "[ 1, 'two' ]"],
    ['dates', new Date('2026-01-02T03:04:05.000Z'), '2026-01-02T03:04:05.000Z'],
    ['maps', new Map([['k', 1]]), "Map(1) { 'k' => 1 }"],
    ['sets', new Set([1]), 'Set(1) { 1 }'],
    ['nested line breaks escaped', { a: 'one\ntwo "q"' }, `{ a: 'one\\ntwo "q"' }`],
    ['quoted keys escaped', { "it's\n": 1 }, "{ 'it\\'s\\n': 1 }"],
  ])('should format %s', (_name, value, expected) => {
    expect(formatLogValue(value)).toBe(expected);
  });

  it('should keep the stack and the cause of errors', () => {
    const error = new Error('outer', { cause: new Error('inner') });

    const formatted = formatLogValue(error);

    expect(formatted).toContain('Error: outer');
    expect(formatted).toContain('formatLogValue.test.ts');
    expect(formatted).toContain('[cause]: Error: inner');
  });

  it('should mark circular references', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;

    expect(formatLogValue(circular)).toBe("{ name: 'loop', self: [Circular] }");
  });

  it('should not mark a value seen twice without a cycle as circular', () => {
    const shared = { v: 1 };

    expect(formatLogValue({ a: shared, b: shared })).toBe('{ a: { v: 1 }, b: { v: 1 } }');
  });

  it('should abbreviate objects nested deeper than 4 levels', () => {
    expect(formatLogValue({ a: { b: { c: { d: { e: 1 } } } } })).toBe(
      '{ a: { b: { c: { d: [Object] } } } }'
    );
  });
});

describe('formatLogValue robustness', () => {
  it('should print the own properties of errors, such as the code of a database error', () => {
    const error = Object.assign(new Error('duplicate key'), {
      code: '23505',
      detail: 'Key (id)=(1) already exists.',
    });

    const formatted = formatLogValue(error);

    expect(formatted).toContain('Error: duplicate key');
    expect(formatted).toContain("{ code: '23505', detail: 'Key (id)=(1) already exists.' }");
  });

  it('should not repeat the name of errors that set it as an own property', () => {
    class CustomError extends Error {
      constructor() {
        super('custom');
        this.name = 'CustomError';
      }
    }

    expect(formatLogValue(new CustomError())).not.toContain("name: 'CustomError'");
  });

  it('should keep formatting when a getter throws', () => {
    const value = {
      ok: 1,
      get broken(): number {
        throw new Error('boom');
      },
    };
    Object.defineProperty(value, 'broken', { enumerable: true });

    expect(formatLogValue(value)).toBe('{ ok: 1, broken: [Getter threw] }');
  });

  it('should print the errors of an AggregateError, such as the addresses a connection tried', () => {
    const error = Object.assign(
      new AggregateError(
        [
          new Error('connect ECONNREFUSED ::1:5432'),
          new Error('connect ECONNREFUSED 127.0.0.1:5432'),
        ],
        ''
      ),
      { code: 'ECONNREFUSED' }
    );

    const formatted = formatLogValue(error);

    expect(formatted).toContain("code: 'ECONNREFUSED'");
    expect(formatted).toContain('Error: connect ECONNREFUSED ::1:5432');
    expect(formatted).toContain('Error: connect ECONNREFUSED 127.0.0.1:5432');
    expect(toLogJson(error)).toMatchObject({
      code: 'ECONNREFUSED',
      errors: [
        { message: 'connect ECONNREFUSED ::1:5432' },
        { message: 'connect ECONNREFUSED 127.0.0.1:5432' },
      ],
    });
  });

  it('should redact the errors of an AggregateError when errors is a redacted key', () => {
    const error = new AggregateError([new Error('secret detail')], 'failed');

    expect(formatLogValue(error, lilypadRedaction(['errors']))).not.toContain('secret detail');
  });

  it('should lose only the part that cannot be read', () => {
    const map = new Map([[1, 2]]);
    map[Symbol.iterator] = () => {
      throw new Error('iterator');
    };
    const withToJson = {
      ok: 1,
      bad: {
        toJSON() {
          throw new Error('toJSON');
        },
      },
    };

    expect(formatLogValue({ ok: 1, map })).toBe('{ ok: 1, map: [Unformattable value] }');
    expect(toLogJson(withToJson)).toEqual({ ok: 1, bad: '[Unformattable value]' });
  });

  it('should keep an error whose fields cannot be read or are not strings', () => {
    const error = Object.assign(new Error('boom'), { code: 'E1' });
    // e.g. a failing Error.prepareStackTrace
    Object.defineProperty(error, 'stack', {
      get() {
        throw new Error('no stack');
      },
    });
    Object.defineProperty(error, 'cause', {
      get() {
        throw new Error('no cause');
      },
    });
    const odd = Object.assign(new Error('odd'), { message: 42 });

    expect(formatLogValue(error)).toBe("Error: boom { code: 'E1' }\n[cause]: [Getter threw]");
    expect(toLogJson(error)).toEqual({
      name: 'Error',
      message: 'boom',
      code: 'E1',
      cause: '[Getter threw]',
    });
    // V8 builds the stack lazily, from the message it finds
    expect(formatLogValue(odd)).toMatch(/^Error: 42\n/);
    expect(toLogJson(odd)).toMatchObject({ name: 'Error', message: '42' });
  });

  it('should redact the cause of an error when cause is a redacted key', () => {
    const error = new Error('outer', { cause: new Error('secret detail') });

    expect(formatLogValue(error, lilypadRedaction(['cause']))).toContain('[cause]: [Redacted]');
    expect(JSON.stringify(toLogJson(error, lilypadRedaction(['cause'])))).not.toContain('secret');
  });

  it('should never throw, even for a Proxy whose traps throw', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('trap');
        },
      }
    );

    expect(formatLogValue(hostile)).toBe('[Unformattable value]');
  });
});

describe('toLogJson', () => {
  it('should redact at any depth, also inside errors and what toJSON returns', () => {
    const error = Object.assign(new Error('request failed'), {
      config: { headers: { Authorization: 'Bearer secret' } },
      cause: new Error('socket closed'),
    });
    const json = toLogJson({
      error,
      request: { toJSON: () => ({ headers: { cookie: 'sid=1' }, url: '/users' }) },
    }) as Record<string, Record<string, unknown>>;

    expect(JSON.stringify(json)).not.toContain('secret');
    expect(json.error).toMatchObject({
      name: 'Error',
      message: 'request failed',
      config: { headers: { Authorization: '[Redacted]' } },
      cause: { message: 'socket closed' },
    });
    expect(json.request).toEqual({ headers: { cookie: '[Redacted]' }, url: '/users' });
  });

  it('should mask the passwords of URLs in strings, messages and stacks, unless redaction is off', () => {
    const url = 'postgres://app:s3cr3t@db.internal:5432/app';
    // e.g. the error of a malformed connection string, which carries it in `input`
    const error = Object.assign(new Error(`cannot reach ${url}`), { input: url });
    const values = [url, { url }, error, [`see ${url}, then https://host/path?a=b@c`]];

    for (const value of values) {
      expect(formatLogValue(value)).not.toContain('s3cr3t');
      expect(JSON.stringify(toLogJson(value))).not.toContain('s3cr3t');
    }
    expect(formatLogValue(url)).toBe('postgres://app:[Redacted]@db.internal:5432/app');
    expect(formatLogValue(['https://host/path?a=b@c'])).toBe("[ 'https://host/path?a=b@c' ]");
    // Off only with redaction off, not with an empty list of keys
    expect(formatLogValue(url, lilypadRedaction([]))).not.toContain('s3cr3t');
    expect(formatLogValue(url, NO_REDACTION)).toBe(url);
  });

  it('should turn what JSON cannot hold into plain values', () => {
    const node: Record<string, unknown> = { big: 10n, at: new Date(0), invalid: new Date(NaN) };
    node.self = node;
    node.map = new Map<unknown, unknown>([
      ['token', 'secret'],
      [1, 'one'],
    ]);
    node.set = new Set(['a']);

    expect(toLogJson(node)).toEqual({
      big: '10n',
      at: '1970-01-01T00:00:00.000Z',
      invalid: null,
      self: '[Circular]',
      map: { token: '[Redacted]', 1: 'one' },
      set: ['a'],
    });
  });

  it('should keep the depth the text form abbreviates', () => {
    const deep = { a: { b: { c: { d: { e: 'deep' } } } } };

    expect(formatLogValue(deep)).toBe('{ a: { b: { c: { d: [Object] } } } }');
    expect(toLogJson(deep)).toEqual(deep);
  });
});

describe('size bounds', () => {
  it('should walk a value whose levels share their children in bounded time', () => {
    let node: unknown = { leaf: true };
    for (let level = 0; level < 30; level++) {
      node = { a: node, b: node };
    }

    // Without a bound, the JSON form walks 2^30 objects
    const start = performance.now();
    const json = JSON.stringify(toLogJson(node));
    formatLogValue(node);

    expect(performance.now() - start).toBeLessThan(1000);
    expect(json).toContain('[…]');
  });

  it('should print at most 100 items per collection in the text form, and keep all in JSON', () => {
    const numbers = Array.from({ length: 1000 }, (_, index) => index);

    const formatted = formatLogValue(numbers);

    expect(formatted).toMatch(/^\[ 0, 1, .*, 99, … 900 more items \]$/);
    expect(toLogJson(numbers)).toEqual(numbers);
  });

  it('should print a typed array by index, with its type and length', () => {
    expect(formatLogValue(new Uint8Array([1, 2, 3]))).toBe('Uint8Array(3) [ 1, 2, 3 ]');
    expect(formatLogValue({ data: new BigInt64Array([10n]) })).toBe(
      '{ data: BigInt64Array(1) [ 10n ] }'
    );
    // The JSON form is what JSON.stringify writes
    expect(toLogJson(new Uint8Array([1, 2]))).toEqual({ 0: 1, 1: 2 });
  });

  it('should print a large typed array (e.g. a Buffer) without listing all its keys', () => {
    const large = new Uint8Array(5_000_000);

    const start = performance.now();
    const formatted = formatLogValue(large);

    // Listing its 5 million keys took about 500 ms
    expect(performance.now() - start).toBeLessThan(100);
    expect(formatted).toMatch(/^Uint8Array\(5000000\) \[ 0, 0, .*, … 4999900 more items \]$/);
  });

  it('should mask URL passwords in linear time, even in a crafted string', () => {
    // Each word of the run used to rescan it up to `://`: about 5 seconds per format
    const crafted = 'a.'.repeat(50_000) + '://a:' + 'b'.repeat(50_000);

    const start = performance.now();
    formatLogValue(crafted);
    formatLogValue(new Error(crafted));
    toLogJson({ crafted });

    expect(performance.now() - start).toBeLessThan(600);
    expect(formatLogValue('a.b+c-d.postgres://app:s3cr3t@db/app')).toBe(
      'a.b+c-d.postgres://app:[Redacted]@db/app'
    );
  });

  it('should count the entries and properties left out of maps, sets and objects', () => {
    const entries = Array.from({ length: 150 }, (_, index) => [`k${index}`, index] as const);

    expect(formatLogValue(new Map(entries))).toMatch(/^Map\(150\) \{ .*, … 50 more items \}$/);
    expect(formatLogValue(new Set(entries.map(([key]) => key)))).toMatch(
      /^Set\(150\) \{ .*, … 50 more items \}$/
    );
    expect(formatLogValue(Object.fromEntries(entries))).toMatch(/, … 50 more properties \}$/);
  });
});
