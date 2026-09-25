import { describe, it, expect, vi } from 'vitest';
import { libLog, type LilypadLibLogger } from './LilypadLibLogger';
import { LilypadLogger } from './LilypadLogger';

describe('libLog', () => {
  it('should call the method of the level with the logger as this', () => {
    const logger = {
      prefix: 'app',
      lines: [] as string[],
      info(this: { prefix: string; lines: string[] }, ...message: unknown[]) {
        this.lines.push(`${this.prefix}: ${message.join(' ')}`);
      },
    };

    libLog(logger as LilypadLibLogger, 'info', 'hello', 1);

    expect(logger.lines).toEqual(['app: hello 1']);
  });

  it('should skip the levels the logger lacks', () => {
    const logger = { error: vi.fn() };

    expect(() => libLog(logger, 'debug', 'ignored')).not.toThrow();
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

    expect(() => libLog(logger, 'error', 'message')).not.toThrow();
    libLog(logger, 'warn', 'message');
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
