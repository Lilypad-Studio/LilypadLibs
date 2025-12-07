import { describe, it, expect, vi, beforeEach } from 'vitest';
import LilypadLoggerComponent from './LilypadLoggerComponent';
import createLogger from './LilypadLogger';

type mockType = 'info' | 'error';

describe('LilypadLogger', () => {
  let mockComponent: LilypadLoggerComponent<mockType>;
  let mockComponent2: LilypadLoggerComponent<mockType>;

  beforeEach(() => {
    mockComponent = {
      output: vi.fn(),
      getTimestamp: vi.fn(() => new Date().toISOString()),
      formatMessage: vi.fn((channel, message) => `[${channel}] ${message}`),
      send: vi.fn(),
    } as unknown as LilypadLoggerComponent<mockType>;

    mockComponent2 = {
      output: vi.fn(),
      getTimestamp: vi.fn(() => new Date().toISOString()),
      formatMessage: vi.fn((channel, message) => `[${channel}] ${message}`),
      send: vi.fn(),
    } as unknown as LilypadLoggerComponent<mockType>;
  });

  it('should create logger with dynamic methods for each channel', () => {
    const logger = createLogger({
      components: {
        info: [mockComponent],
        error: [mockComponent],
      },
    });

    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
  });

  it('should call component.output with string message', () => {
    const logger = createLogger<mockType>({
      components: {
        info: [mockComponent],
        error: [mockComponent],
      },
    });

    logger.info('test message');

    expect(mockComponent.output).toHaveBeenCalledWith('info', 'test message', { logger: logger });
  });

  it('should stringify non-string messages', () => {
    const logger = createLogger<mockType>({
      components: {
        info: [mockComponent],
        error: [mockComponent],
      },
    });

    const obj = { key: 'value' };
    logger.info(obj);

    expect(mockComponent.output).toHaveBeenCalledWith('info', JSON.stringify(obj), {
      logger: logger,
    });
  });

  it('should route messages to all registered components', async () => {
    const logger = createLogger<mockType>({
      components: {
        info: [mockComponent, mockComponent2],
        error: [mockComponent, mockComponent2],
      },
    });

    await logger.info('test');

    expect(mockComponent.output).toHaveBeenCalled();
    expect(mockComponent2.output).toHaveBeenCalled();
  });

  it('should handle component errors with errorLogging callback', () => {
    mockComponent.output = vi.fn(() => {
      throw new Error('Component error');
    });
    const errorLogging = vi.fn();

    const logger = createLogger<mockType>({
      components: {
        info: [mockComponent],
        error: [],
      },
      errorLogging,
    });

    logger.info('test');

    expect(errorLogging).toHaveBeenCalledWith(expect.any(Error));
  });

  it('should use console.error as fallback for component errors', () => {
    mockComponent.output = vi.fn(() => {
      throw new Error('Component error');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const logger = createLogger<mockType>({
      components: {
        info: [mockComponent],
        error: [],
      },
    });

    logger.info('test');

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('should register new components', async () => {
    const logger = createLogger<mockType>({
      components: {
        info: [mockComponent],
        error: [],
      },
    });

    logger.register({
      info: [mockComponent2],
    });

    await logger.info('test');

    expect(mockComponent.output).toHaveBeenCalled();
    expect(mockComponent2.output).toHaveBeenCalled();
  });

  it('should return this for method chaining on register', () => {
    const logger = createLogger<mockType>({
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
    const logger = createLogger<mockType>({
      components: {
        info: [mockComponent],
        error: [],
      },
      name: 'TestLogger',
    });

    expect(logger.__name).toBe('TestLogger');
  });

  it('should initialize components correctly', () => {
    const logger = createLogger<mockType>({
      components: {
        info: [mockComponent],
        error: [mockComponent2],
      },
    });

    expect(logger['components']['info']).toContain(mockComponent);
    expect(logger['components']['error']).toContain(mockComponent2);
  });

  it('should handle multiple messages correctly', async () => {
    const logger = createLogger<mockType>({
      components: {
        info: [mockComponent],
        error: [mockComponent2],
      },
    });

    await logger.info('first message');
    await logger.info('second message');

    expect(mockComponent.output).toHaveBeenCalledTimes(2);
  });

  it('should not throw error if no components are registered', async () => {
    const logger = createLogger<mockType>({
      components: {
        info: [],
        error: [],
      },
    });

    await logger.info('test message'); // Should not throw
    expect(true).toBe(true); // Just to ensure the test passes
  });
});
