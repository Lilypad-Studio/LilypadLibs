import { describe, it, expect, vi } from 'vitest';
import { libLog, lilypadPinoLogger, type LilypadLibLogger } from './LilypadLibLogger';
import { LilypadLogger } from './LilypadLogger';

describe('libLog', () => {
  it('should call the method of the level with the logger as this, the message and the meta', () => {
    const logger = {
      prefix: 'app',
      lines: [] as string[],
      info(this: { prefix: string; lines: string[] }, message: string, meta: { source: string }) {
        this.lines.push(`${this.prefix}: [${meta.source}] ${message}`);
      },
    };

    libLog(logger, 'info', 'cache', 'hello');

    expect(logger.lines).toEqual(['app: [cache] hello']);
  });

  it('should put an error under meta.error, and any other value under meta.detail', () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const error = new Error('boom');

    libLog(logger, 'error', 'cache', 'failed', error);
    libLog(logger, 'warn', 'cache', 'malformed', 'payload');

    expect(logger.error).toHaveBeenCalledWith('failed', { source: 'cache', error });
    expect(logger.warn).toHaveBeenCalledWith('malformed', { source: 'cache', detail: 'payload' });
  });

  it('should skip the levels the logger lacks', () => {
    const logger = { error: vi.fn() };

    expect(() => libLog(logger, 'debug', 'cache', 'ignored')).not.toThrow();
    expect(logger.error).not.toHaveBeenCalled();
  });

  // vitest fails the run on an unhandled rejection
  it('should ignore a logger that throws or rejects', async () => {
    const logger: LilypadLibLogger = {
      error: () => {
        throw new Error('sync failure');
      },
      warn: () => Promise.reject(new Error('async failure')),
    };

    expect(() => libLog(logger, 'error', 'cache', 'message')).not.toThrow();
    libLog(logger, 'warn', 'cache', 'message');
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it('should accept console and a LilypadLogger created with the default channels', () => {
    const fromConsole: LilypadLibLogger = console;
    const fromLilypad: LilypadLibLogger = LilypadLogger.create({
      components: { error: [], warn: [], info: [], debug: [] },
    });

    expect(fromConsole.error).toBeTypeOf('function');
    expect(fromLilypad.debug).toBeTypeOf('function');
  });
});

describe('lilypadPinoLogger', () => {
  it('should pass the meta first, with the error under err, as pino expects', () => {
    const pino = { error: vi.fn(), info: vi.fn() };
    const logger = lilypadPinoLogger(pino);
    const error = new Error('boom');

    libLog(logger, 'error', 'cache', 'failed', error);
    libLog(logger, 'debug', 'cache', 'skipped');

    expect(pino.error).toHaveBeenCalledWith(
      { source: 'cache', err: error, detail: undefined },
      'failed'
    );
    expect(logger.debug).toBeUndefined();
  });
});
