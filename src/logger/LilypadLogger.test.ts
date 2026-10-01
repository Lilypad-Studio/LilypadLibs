import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { type LilypadLoggerComponent } from './LilypadLoggerComponent';
import { LilypadLogger, type LilypadLoggerType } from './LilypadLogger';
import { LilypadJsonConsoleLogger } from './components/JsonConsoleLogger';
import {
  getLilypadSingletonInstanceAsync,
  removeLilypadSingletonInstance,
} from '@/singleton/LilypadSingleton';

type mockType = 'info' | 'error';

describe('LilypadLogger', () => {
  let mockComponent: LilypadLoggerComponent<mockType>;
  let mockComponent2: LilypadLoggerComponent<mockType>;

  beforeEach(() => {
    mockComponent = { write: vi.fn() } as unknown as LilypadLoggerComponent<mockType>;
    mockComponent2 = { write: vi.fn() } as unknown as LilypadLoggerComponent<mockType>;
  });

  it('should create logger with dynamic methods for each channel', () => {
    const logger = LilypadLogger.create({
      components: {
        info: [mockComponent],
        error: [mockComponent],
      },
    });

    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
  });

  it('should call component.write with the record of a string message', async () => {
    const logger = LilypadLogger.create<mockType>({
      components: {
        info: [mockComponent],
        error: [mockComponent],
      },
    });

    logger.info('test message');

    await logger.flush();

    expect(mockComponent.write).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'info', message: 'test message' })
    );
  });

  it('should stringify non-string messages', async () => {
    const logger = LilypadLogger.create<mockType>({
      components: {
        info: [mockComponent],
        error: [mockComponent],
      },
    });

    const obj = { key: 'value' };
    logger.info(obj);
    await logger.flush();

    expect(mockComponent.write).toHaveBeenCalledWith(
      expect.objectContaining({ message: "{ key: 'value' }" })
    );
  });

  it('should keep message and stack of errors', async () => {
    const logger = LilypadLogger.create<mockType>({
      components: { info: [], error: [mockComponent] },
    });

    logger.error('Failure:', new Error('boom'));

    await logger.flush();

    const message = vi.mocked(mockComponent.write).mock.calls[0]![0].message;
    expect(message).toContain('Failure: Error: boom');
    expect(message).toContain('LilypadLogger.test.ts');
  });

  it('should not throw on circular references and BigInts', async () => {
    const logger = LilypadLogger.create<mockType>({
      components: { info: [mockComponent], error: [] },
    });
    const circular: Record<string, unknown> = { name: 'circular' };
    circular.self = circular;

    expect(logger.info(circular, 10n)).toBeUndefined();

    await logger.flush();

    const message = vi.mocked(mockComponent.write).mock.calls[0]![0].message;
    expect(message).toContain('[Circular]');
    expect(message).toContain('10n');
  });

  it.each(['components', 'register', 'dispose', 'name', 'then', 'constructor', 'toString'])(
    'should reject the reserved log channel "%s"',
    (channel) => {
      expect(() =>
        LilypadLogger.create<string>({ components: { [channel]: [mockComponent] } })
      ).toThrow(`Logger type "${channel}" is reserved`);
    }
  );

  it('should throw a clear error when registering an unknown log type', () => {
    const logger = LilypadLogger.create<string>({ components: { info: [] } });

    expect(() => logger.register({ debug: [mockComponent] })).toThrow(
      'Logger type "debug" was not defined'
    );
  });

  it.each(['constructor', 'toString'])(
    'should throw a clear error when registering the inherited name "%s"',
    (type) => {
      const logger = LilypadLogger.create<string>({ components: { info: [] } });

      expect(() => logger.register({ [type]: [mockComponent] })).toThrow(
        `Logger type "${type}" was not defined`
      );
    }
  );

  it('should route messages to all registered components', async () => {
    const logger = LilypadLogger.create<mockType>({
      components: {
        info: [mockComponent, mockComponent2],
        error: [mockComponent, mockComponent2],
      },
    });

    logger.info('test');

    await logger.flush();

    expect(mockComponent.write).toHaveBeenCalled();
    expect(mockComponent2.write).toHaveBeenCalled();
  });

  it('should handle component errors with errorLogging callback', async () => {
    mockComponent.write = vi.fn(() => {
      throw new Error('Component error');
    });
    const errorLogging = vi.fn();

    const logger = LilypadLogger.create<mockType>({
      components: {
        info: [mockComponent],
        error: [],
      },
      errorLogging,
    });

    logger.info('test');

    await logger.flush();

    expect(errorLogging).toHaveBeenCalledWith(expect.any(Error));
  });

  it('should use console.error as fallback for component errors', async () => {
    mockComponent.write = vi.fn(() => {
      throw new Error('Component error');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const logger = LilypadLogger.create<mockType>({
      components: {
        info: [mockComponent],
        error: [],
      },
    });

    logger.info('test');

    await logger.flush();

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('should register new components', async () => {
    const logger = LilypadLogger.create<mockType>({
      components: {
        info: [mockComponent],
        error: [],
      },
    });

    logger.register({
      info: [mockComponent2],
    });

    logger.info('test');

    await logger.flush();

    expect(mockComponent.write).toHaveBeenCalled();
    expect(mockComponent2.write).toHaveBeenCalled();
  });

  it('should return this for method chaining on register', () => {
    const logger = LilypadLogger.create<mockType>({
      components: {
        info: [mockComponent],
        error: [],
      },
    });

    const result = logger.register({
      info: [mockComponent2],
      error: [],
    });

    expect(result).toBe(logger);
  });

  it('should assign logger name if provided', () => {
    const logger = LilypadLogger.create<mockType>({
      components: {
        info: [mockComponent],
        error: [],
      },
      name: 'TestLogger',
    });

    expect(logger.name).toBe('TestLogger');
  });

  it('should initialize components correctly', () => {
    const logger = LilypadLogger.create<mockType>({
      components: {
        info: [mockComponent],
        error: [mockComponent2],
      },
    });

    expect(logger['components']['info']).toContain(mockComponent);
    expect(logger['components']['error']).toContain(mockComponent2);
  });

  it('should handle multiple messages correctly', async () => {
    const logger = LilypadLogger.create<mockType>({
      components: {
        info: [mockComponent],
        error: [mockComponent2],
      },
    });

    logger.info('first message');

    await logger.flush();
    logger.info('second message');
    await logger.flush();

    expect(mockComponent.write).toHaveBeenCalledTimes(2);
  });

  it('should not throw error if no components are registered', async () => {
    const logger = LilypadLogger.create<mockType>({
      components: {
        info: [],
        error: [],
      },
    });

    logger.info('test message'); // Should not throw

    await logger.flush();
    expect(true).toBe(true); // Just to ensure the test passes
  });

  it('should never reject, even when errorLogging fails', async () => {
    mockComponent.write = vi.fn(async () => {
      throw new Error('Component error');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = LilypadLogger.create<mockType>({
      components: { info: [mockComponent], error: [] },
      errorLogging: async () => {
        throw new Error('errorLogging failed');
      },
    });

    expect(logger.info('test')).toBeUndefined();

    await logger.flush();

    expect(consoleSpy).toHaveBeenCalledWith(expect.any(String), expect.any(Error));
    expect(consoleSpy).toHaveBeenCalledTimes(2); // the errorLogging failure and the original error
    consoleSpy.mockRestore();
  });

  it('should not loop when errorLogging logs on the same logger', async () => {
    let writes = 0;
    mockComponent.write = vi.fn(async () => {
      // Bounded, so that a regression fails the test instead of hanging the event loop
      if (++writes <= 10) {
        throw new Error('Component error');
      }
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger: LilypadLoggerType<mockType> = LilypadLogger.create<mockType>({
      components: { info: [], error: [mockComponent] },
      errorLogging: (error) => {
        logger.error('Logging failed:', error);
      },
    });

    logger.error('first');

    await logger.flush();

    // The message, then the report of its failure, whose own failure goes to console.error
    expect(mockComponent.write).toHaveBeenCalledTimes(2);
    expect(consoleSpy).toHaveBeenCalledOnce();
    consoleSpy.mockRestore();
  });

  it('should resolve flush while messages keep arriving', async () => {
    vi.useFakeTimers();
    try {
      mockComponent.write = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 30)));
      const logger = LilypadLogger.create<mockType>({
        components: { info: [mockComponent], error: [] },
      });
      const stream = setInterval(() => logger.info('tick'), 10);
      logger.info('before flush');

      let flushed = false;
      void logger.flush().then(() => (flushed = true));
      await vi.advanceTimersByTimeAsync(100);
      clearInterval(stream);

      expect(flushed).toBe(true);
      await vi.advanceTimersByTimeAsync(100);
      await logger.flush();
    } finally {
      vi.useRealTimers();
    }
  });

  it('should wait in flush for the messages errorLogging logs about a failure', async () => {
    let reported = false;
    const slow = {
      write: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        reported = true;
      }),
    } as unknown as LilypadLoggerComponent<mockType>;
    mockComponent.write = vi.fn(async () => {
      throw new Error('Component error');
    });
    const logger: LilypadLoggerType<mockType> = LilypadLogger.create<mockType>({
      components: { info: [slow], error: [mockComponent] },
      errorLogging: (error) => {
        logger.info('Logging failed:', error);
      },
    });

    logger.error('first');
    await logger.flush();

    expect(reported).toBe(true);
  });

  it('should log a message with an error whose fields cannot be read', async () => {
    const errorLogging = vi.fn();
    const logger = LilypadLogger.create<mockType>({
      components: { info: [], error: [mockComponent] },
      errorLogging,
    });
    const error = new Error('boom');
    // e.g. a failing Error.prepareStackTrace
    Object.defineProperty(error, 'stack', {
      get() {
        throw new Error('no stack');
      },
    });
    const odd = Object.assign(new Error('odd'), { message: 42 });

    logger.error('failed', error, odd);
    await logger.flush();

    expect(errorLogging).not.toHaveBeenCalled();
    const record = vi.mocked(mockComponent.write).mock.calls[0]![0];
    expect(record.message).toContain('failed Error: boom');
    expect(record.errors).toEqual([
      { name: 'Error', message: 'boom', stack: undefined },
      { name: 'Error', message: '42', stack: odd.stack },
    ]);
  });

  it('should report the error of every failing component', async () => {
    mockComponent.write = vi.fn(async () => {
      throw new Error('first');
    });
    mockComponent2.write = vi.fn(async () => {
      throw new Error('second');
    });
    const errorLogging = vi.fn(async () => {});
    const logger = LilypadLogger.create<mockType>({
      components: { info: [mockComponent, mockComponent2], error: [] },
      errorLogging,
    });

    logger.info('test');

    await logger.flush();

    expect(errorLogging).toHaveBeenCalledTimes(2);
    expect(errorLogging).toHaveBeenCalledWith(expect.objectContaining({ message: 'first' }));
    expect(errorLogging).toHaveBeenCalledWith(expect.objectContaining({ message: 'second' }));
  });

  it('should keep singletons apart from other classes using the same identifier', async () => {
    const identifier = 'LilypadLogger.test-namespace';
    const logger = LilypadLogger.create<mockType>({
      singleton: identifier,
      components: { info: [], error: [] },
    });
    const other = await getLilypadSingletonInstanceAsync(identifier, async () => ({ other: true }));

    expect(other).toEqual({ other: true });
    expect(
      LilypadLogger.create<mockType>({
        singleton: identifier,
        components: { info: [], error: [] },
      })
    ).toBe(logger);
    removeLilypadSingletonInstance(identifier);
    await logger.dispose();
  });

  it('should wait for the pending messages when disposed', async () => {
    let finishWrite!: () => void;
    mockComponent.write = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        })
    );
    const logger = LilypadLogger.create<mockType>({
      components: { info: [mockComponent], error: [] },
    });
    logger.info('pending');
    let disposed = false;

    const disposing = logger.dispose().then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockComponent.write).toHaveBeenCalledTimes(1);
    expect(disposed).toBe(false);

    finishWrite();
    await disposing;
    expect(disposed).toBe(true);
  });

  it('should release its singleton when disposed, so that create builds a new one', async () => {
    const options = {
      singleton: 'LilypadLogger.test-dispose',
      components: { info: [], error: [] },
    };
    const logger = LilypadLogger.create<mockType>(options);
    expect(LilypadLogger.create<mockType>(options)).toBe(logger);

    await logger.dispose();
    const next = LilypadLogger.create<mockType>(options);

    expect(next).not.toBe(logger);
    // A second dispose of the old logger does not remove the new one
    await logger.dispose();
    expect(LilypadLogger.create<mockType>(options)).toBe(next);
    // What `await using` calls at the end of the scope
    await next[Symbol.asyncDispose]();
    expect(LilypadLogger.create<mockType>(options)).not.toBe(next);
    await LilypadLogger.create<mockType>(options).dispose();
  });

  describe('serverless support', () => {
    it('should hand every message being sent to platform.background', async () => {
      let resolveOutput!: () => void;
      mockComponent.write = vi.fn(() => new Promise<void>((resolve) => (resolveOutput = resolve)));
      const background = vi.fn();
      const logger = LilypadLogger.create<mockType>({
        components: { info: [mockComponent], error: [] },
        platform: { background },
      });

      logger.info('after the response');

      expect(background).toHaveBeenCalledOnce();
      const task = background.mock.calls[0]![0] as Promise<unknown>;
      let settled = false;
      void task.then(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);
      resolveOutput();
      await logger.flush();
      await task;
      expect(settled).toBe(true);
    });

    it('should still log when platform.background throws', async () => {
      const logger = LilypadLogger.create<mockType>({
        components: { info: [mockComponent], error: [] },
        platform: {
          background: () => {
            throw new Error('outside a request scope');
          },
        },
      });

      expect(logger.info('message')).toBeUndefined();

      await logger.flush();
      expect(mockComponent.write).toHaveBeenCalledOnce();
    });

    it('should resolve flush once every pending message is sent', async () => {
      let resolveOutput!: () => void;
      mockComponent.write = vi.fn(() => new Promise<void>((resolve) => (resolveOutput = resolve)));
      const logger = LilypadLogger.create<mockType>({
        components: { info: [mockComponent], error: [] },
      });
      logger.info('pending');

      let flushed = false;
      const flushing = logger.flush().then(() => (flushed = true));
      await Promise.resolve();
      expect(flushed).toBe(false);

      resolveOutput();
      await flushing;
      expect(flushed).toBe(true);
    });

    it('should add the context to the record, read when the message is logged', async () => {
      let requestId = 'req-1';
      const logger = LilypadLogger.create<mockType>({
        components: { info: [mockComponent], error: [] },
        context: () => ({ requestId }),
      });

      logger.info('message');
      requestId = 'req-2';
      await logger.flush();

      expect(mockComponent.write).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'message', context: { requestId: 'req-1' } })
      );
    });

    it('should redact the default keys in the messages and the context', async () => {
      const logger = LilypadLogger.create<mockType>({
        components: { info: [mockComponent], error: [] },
        context: () => ({ requestId: 'req-1', session: { Cookie: 'sid=1' } }),
      });
      const error = Object.assign(new Error('request failed'), {
        config: { headers: { Authorization: 'Bearer secret', Accept: 'json' } },
      });

      logger.info('Failed:', error, { apiKey: 'k', tokenCount: 3 });

      await logger.flush();

      const record = vi.mocked(mockComponent.write).mock.calls[0]![0];
      expect(record.message).toContain("Authorization: [Redacted], Accept: 'json'");
      expect(record.message).toContain('apiKey: [Redacted], tokenCount: 3');
      expect(record.message).not.toContain('Bearer secret');
      expect(record.context).toEqual({ requestId: 'req-1', session: { Cookie: '[Redacted]' } });
      // The raw parts are not redacted
      expect(record.parts[1]).toBe(error);
    });

    it('should redact the keys given, or none with false', async () => {
      const custom = LilypadLogger.create<mockType>({
        components: { info: [mockComponent], error: [] },
        redact: ['ssn'],
      });
      const none = LilypadLogger.create<mockType>({
        components: { info: [mockComponent2], error: [] },
        redact: false,
      });

      custom.info({ ssn: '123', password: 'p' });

      await custom.flush();
      none.info({ password: 'p' });
      await none.flush();

      expect(vi.mocked(mockComponent.write).mock.calls[0]![0].message).toBe(
        "{ ssn: [Redacted], password: 'p' }"
      );
      expect(vi.mocked(mockComponent2.write).mock.calls[0]![0].message).toBe("{ password: 'p' }");
    });

    it('should mask the passwords of URLs, also in the errors of the record, unless redact is false', async () => {
      const url = 'postgres://app:s3cr3t@db/app';
      const loggers = [[], false].map((redact, index) =>
        LilypadLogger.create<mockType>({
          components: { info: [index === 0 ? mockComponent : mockComponent2], error: [] },
          redact: redact as string[] | false,
        })
      );

      for (const logger of loggers) {
        logger.info(`connecting to ${url}`, new Error(`cannot reach ${url}`));
        await logger.flush();
      }

      const masked = vi.mocked(mockComponent.write).mock.calls[0]![0];
      expect(JSON.stringify({ ...masked, parts: [] })).not.toContain('s3cr3t');
      expect(masked.errors).toEqual([
        {
          name: 'Error',
          message: 'cannot reach postgres://app:[Redacted]@db/app',
          stack: expect.stringContaining('[Redacted]') as unknown,
        },
      ]);
      const raw = vi.mocked(mockComponent2.write).mock.calls[0]![0];
      expect(raw.message).toContain(url);
      expect(raw.errors?.[0]?.message).toBe(`cannot reach ${url}`);
    });

    it('should log without context when the context function throws', async () => {
      const logger = LilypadLogger.create<mockType>({
        components: { info: [mockComponent], error: [] },
        context: () => {
          throw new Error('no request');
        },
      });

      expect(logger.info('message')).toBeUndefined();

      await logger.flush();
      expect(mockComponent.write).toHaveBeenCalledOnce();
    });
  });
});

describe('LilypadLogger redaction of objects with toJSON', () => {
  it('should redact the keys of what toJSON returns, in the JSON output', async () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(line));
    const logger = LilypadLogger.create<'info'>({
      components: { info: [new LilypadJsonConsoleLogger()] },
      context: () => ({
        request: { toJSON: () => ({ url: '/users', headers: { authorization: 'Bearer secret' } }) },
        at: new Date(0),
      }),
    });

    logger.info('request');

    await logger.flush();
    log.mockRestore();

    expect(lines[0]).not.toContain('secret');
    expect(JSON.parse(lines[0]!)).toMatchObject({
      request: { url: '/users', headers: { authorization: '[Redacted]' } },
      at: '1970-01-01T00:00:00.000Z',
    });
  });
});

describe('LilypadLogger context that cannot be formatted', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should lose only the part that cannot be formatted, and keep the context an object', async () => {
    const write = vi.fn(async () => {});
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(line));
    const logger = LilypadLogger.create<'info'>({
      components: {
        info: [
          { write } as unknown as LilypadLoggerComponent<'info'>,
          new LilypadJsonConsoleLogger(),
        ],
      },
      context: () => ({
        requestId: 'req-1',
        user: {
          toJSON() {
            throw new Error('no user');
          },
        },
      }),
    });

    logger.info('message');

    await logger.flush();

    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({ context: { requestId: 'req-1', user: '[Unformattable value]' } })
    );
    const line = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(line).toMatchObject({ requestId: 'req-1', user: '[Unformattable value]' });
    expect(line).not.toHaveProperty('0');
  });

  it('should keep under context a context that is not an object once serialized', async () => {
    const write = vi.fn(async () => {});
    const logger = LilypadLogger.create<'info'>({
      components: { info: [{ write } as unknown as LilypadLoggerComponent<'info'>] },
      context: () => ({ toJSON: () => 'anonymous' }),
    });

    logger.info('message');

    await logger.flush();

    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({ context: { context: 'anonymous' } })
    );
  });
});
