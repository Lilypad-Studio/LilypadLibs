import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LilypadLoggerComponent } from './LilypadLoggerComponent';
import { LilypadLogger } from './LilypadLogger';
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

    await logger.info('test message');

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
    await logger.info(obj);

    expect(mockComponent.write).toHaveBeenCalledWith(
      expect.objectContaining({ message: "{ key: 'value' }" })
    );
  });

  it('should keep message and stack of errors', async () => {
    const logger = LilypadLogger.create<mockType>({
      components: { info: [], error: [mockComponent] },
    });

    await logger.error('Failure:', new Error('boom'));

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

    await expect(logger.info(circular, 10n)).resolves.toBeUndefined();

    const message = vi.mocked(mockComponent.write).mock.calls[0]![0].message;
    expect(message).toContain('[Circular]');
    expect(message).toContain('10n');
  });

  it.each(['components', 'register', 'name', 'then', 'constructor', 'toString'])(
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

  it('should route messages to all registered components', async () => {
    const logger = LilypadLogger.create<mockType>({
      components: {
        info: [mockComponent, mockComponent2],
        error: [mockComponent, mockComponent2],
      },
    });

    await logger.info('test');

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

    await logger.info('test');

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

    await logger.info('test');

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

    await logger.info('test');

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

    await logger.info('first message');
    await logger.info('second message');

    expect(mockComponent.write).toHaveBeenCalledTimes(2);
  });

  it('should not throw error if no components are registered', async () => {
    const logger = LilypadLogger.create<mockType>({
      components: {
        info: [],
        error: [],
      },
    });

    await logger.info('test message'); // Should not throw
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

    await expect(logger.info('test')).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith(expect.any(String), expect.any(Error));
    expect(consoleSpy).toHaveBeenCalledTimes(2); // the errorLogging failure and the original error
    consoleSpy.mockRestore();
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

    await logger.info('test');

    expect(errorLogging).toHaveBeenCalledTimes(2);
    expect(errorLogging).toHaveBeenCalledWith(expect.objectContaining({ message: 'first' }));
    expect(errorLogging).toHaveBeenCalledWith(expect.objectContaining({ message: 'second' }));
  });

  it('should keep singletons apart from other classes using the same identifier', async () => {
    const identifier = 'LilypadLogger.test-namespace';
    const logger = LilypadLogger.create<mockType>({
      singleton: true,
      singletonIdentifier: identifier,
      components: { info: [], error: [] },
    });
    const other = await getLilypadSingletonInstanceAsync(identifier, async () => ({ other: true }));

    expect(other).toEqual({ other: true });
    expect(
      LilypadLogger.create<mockType>({
        singleton: true,
        singletonIdentifier: identifier,
        components: { info: [], error: [] },
      })
    ).toBe(logger);
    removeLilypadSingletonInstance(identifier);
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

      const logged = logger.info('after the response');

      expect(background).toHaveBeenCalledOnce();
      const task = background.mock.calls[0]![0] as Promise<unknown>;
      let settled = false;
      void task.then(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);
      resolveOutput();
      await logged;
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

      await expect(logger.info('message')).resolves.toBeUndefined();
      expect(mockComponent.write).toHaveBeenCalledOnce();
    });

    it('should resolve flush once every pending message is sent', async () => {
      let resolveOutput!: () => void;
      mockComponent.write = vi.fn(() => new Promise<void>((resolve) => (resolveOutput = resolve)));
      const logger = LilypadLogger.create<mockType>({
        components: { info: [mockComponent], error: [] },
      });
      void logger.info('pending');

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

      const logged = logger.info('message');
      requestId = 'req-2';
      await logged;

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

      await logger.info('Failed:', error, { apiKey: 'k', tokenCount: 3 });

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

      await custom.info({ ssn: '123', password: 'p' });
      await none.info({ password: 'p' });

      expect(vi.mocked(mockComponent.write).mock.calls[0]![0].message).toBe(
        "{ ssn: [Redacted], password: 'p' }"
      );
      expect(vi.mocked(mockComponent2.write).mock.calls[0]![0].message).toBe("{ password: 'p' }");
    });

    it('should log without context when the context function throws', async () => {
      const logger = LilypadLogger.create<mockType>({
        components: { info: [mockComponent], error: [] },
        context: () => {
          throw new Error('no request');
        },
      });

      await expect(logger.info('message')).resolves.toBeUndefined();
      expect(mockComponent.write).toHaveBeenCalledOnce();
    });
  });
});
