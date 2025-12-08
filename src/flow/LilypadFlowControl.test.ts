import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LilypadFlowControl } from './LilypadFlowControl';

describe('LilypadFlowControl', () => {
  let flowControl: LilypadFlowControl<string>;

  beforeEach(() => {
    flowControl = new LilypadFlowControl<string>();
  });

  describe('constructor', () => {
    it('should initialize with default options', () => {
      const fc = new LilypadFlowControl<string>();
      expect(fc).toBeDefined();
    });

    it('should initialize with provided options', () => {
      const fc = new LilypadFlowControl<string>({
        rate: 1000,
        timeout: 5000,
        retries: 3,
      });
      expect(fc).toBeDefined();
    });
  });

  describe('executeWithTimeout', () => {
    it('should return result when execution completes before timeout', async () => {
      flowControl = new LilypadFlowControl<string>({ timeout: 1000 });
      const result = await flowControl.executeWithTimeout(() => Promise.resolve('success'));
      expect(result).toBe('success');
    });

    it('should throw timeout error when execution exceeds timeout', async () => {
      flowControl = new LilypadFlowControl<string>({ timeout: 100 });
      await expect(
        flowControl.executeWithTimeout(
          () => new Promise((resolve) => setTimeout(() => resolve('delayed'), 500))
        )
      ).rejects.toThrow('Operation timed out');
    });

    it('should not timeout when no timeout is configured', async () => {
      flowControl = new LilypadFlowControl<string>();
      const result = await flowControl.executeWithTimeout(() => Promise.resolve('success'));
      expect(result).toBe('success');
    });
  });

  describe('executeWithRetries', () => {
    it('should return result on first success', async () => {
      flowControl = new LilypadFlowControl<string>({ retries: 3 });
      const result = await flowControl.executeWithRetries(() => Promise.resolve('success'));
      expect(result).toBe('success');
    });

    it('should retry on failure and return result', async () => {
      flowControl = new LilypadFlowControl<string>({ retries: 3 });
      let attempts = 0;
      const result = await flowControl.executeWithRetries(() => {
        attempts++;
        if (attempts < 2) {
          return Promise.reject(new Error('fail'));
        }
        return Promise.resolve('success');
      });
      expect(result).toBe('success');
      expect(attempts).toBe(2);
    });

    it('should throw error after exhausting retries', async () => {
      flowControl = new LilypadFlowControl<string>({ retries: 2 });
      await expect(
        flowControl.executeWithRetries(
          () => Promise.reject(new Error('fail')),
          undefined,
          () => 20
        )
      ).rejects.toThrow('fail');
    });

    it('should use errorFn when provided and retries exhausted', async () => {
      flowControl = new LilypadFlowControl<string>({ retries: 1 });
      const result = await flowControl.executeWithRetries(
        () => Promise.reject(new Error('fail')),
        () => 'fallback'
      );
      expect(result).toBe('fallback');
    });

    it('should use custom backoff time', async () => {
      flowControl = new LilypadFlowControl<string>({ retries: 2 });
      const backoffSpy = vi.fn((attempt) => attempt * 10);
      let attempts = 0;

      await flowControl.executeWithRetries(
        () => {
          attempts++;
          if (attempts < 3) {
            return Promise.reject(new Error('fail'));
          }
          return Promise.resolve('success');
        },
        undefined,
        backoffSpy
      );

      expect(backoffSpy).toHaveBeenCalled();
    });
  });

  describe('rateLimit', () => {
    it('should allow execution when rate limit is not set', async () => {
      flowControl = new LilypadFlowControl<string>();
      await expect(flowControl.rateLimit('user1', 'func1')).resolves.toBeUndefined();
    });

    it('should allow first execution when rate limit is set', async () => {
      flowControl = new LilypadFlowControl<string>({ rate: 1000 });
      await expect(flowControl.rateLimit('user1', 'func1')).resolves.toBeUndefined();
    });

    it('should reject execution when rate limit is exceeded', async () => {
      flowControl = new LilypadFlowControl<string>({ rate: 1000 });
      await flowControl.rateLimit('user1', 'func1');
      await expect(flowControl.rateLimit('user1', 'func1')).rejects.toThrow(
        'Rate limit exceeded for user1#func1'
      );
    });

    it('should allow execution after rate limit expires', async () => {
      flowControl = new LilypadFlowControl<string>({ rate: 100 });
      await flowControl.rateLimit('user1', 'func1');
      await new Promise((resolve) => setTimeout(resolve, 150));
      await expect(flowControl.rateLimit('user1', 'func1')).resolves.toBeUndefined();
    });

    it('should track rate limits per consumer/function pair', async () => {
      flowControl = new LilypadFlowControl<string>({ rate: 1000 });
      await flowControl.rateLimit('user1', 'func1');
      await expect(flowControl.rateLimit('user2', 'func1')).resolves.toBeUndefined();
    });
  });

  describe('executeFn', () => {
    it('should execute function successfully', async () => {
      const result = await flowControl.executeFn({
        functionIdentifier: 'func1',
        consumerIdentifier: 'user1',
        fn: () => Promise.resolve('success'),
      });
      expect(result).toBe('success');
    });

    it('should apply rate limiting', async () => {
      flowControl = new LilypadFlowControl<string>({ rate: 1000 });
      await flowControl.executeFn({
        functionIdentifier: 'func1',
        consumerIdentifier: 'user1',
        fn: () => Promise.resolve('success'),
      });
      await expect(
        flowControl.executeFn({
          functionIdentifier: 'func1',
          consumerIdentifier: 'user1',
          fn: () => Promise.resolve('success'),
        })
      ).rejects.toThrow('Rate limit exceeded');
    });

    it('should implement single-flight deduplication', async () => {
      const fnSpy = vi.fn(() => Promise.resolve('success'));
      flowControl = new LilypadFlowControl<string>();

      const promise1 = flowControl.executeFn({
        functionIdentifier: 'func1',
        consumerIdentifier: 'user1',
        fn: fnSpy,
      });

      const promise2 = flowControl.executeFn({
        functionIdentifier: 'func1',
        consumerIdentifier: 'user1',
        fn: fnSpy,
      });

      const [result1, result2] = await Promise.all([promise1, promise2]);

      expect(result1).toBe('success');
      expect(result2).toBe('success');
      expect(fnSpy).toHaveBeenCalledOnce();
    });

    it('should apply timeout', async () => {
      flowControl = new LilypadFlowControl<string>({ timeout: 100 });
      await expect(
        flowControl.executeFn({
          functionIdentifier: 'func1',
          consumerIdentifier: 'user1',
          fn: () => new Promise((resolve) => setTimeout(() => resolve('delayed'), 500)),
        })
      ).rejects.toThrow('Operation timed out');
    });

    it('should apply retries with exponential backoff', async () => {
      flowControl = new LilypadFlowControl<string>({ retries: 3 });
      let attempts = 0;

      const result = await flowControl.executeFn({
        functionIdentifier: 'func1',
        consumerIdentifier: 'user1',
        fn: () => {
          attempts++;
          if (attempts < 2) {
            return Promise.reject(new Error('fail'));
          }
          return Promise.resolve('success');
        },
      });

      expect(result).toBe('success');
      expect(attempts).toBe(2);
    });

    it('should use errorFn when provided', async () => {
      flowControl = new LilypadFlowControl<string>({ retries: 1 });
      const result = await flowControl.executeFn({
        functionIdentifier: 'func1',
        consumerIdentifier: 'user1',
        fn: () => Promise.reject(new Error('fail')),
        errorFn: () => 'fallback',
      });

      expect(result).toBe('fallback');
    });

    it('should clear single-flight map after execution', async () => {
      flowControl = new LilypadFlowControl<string>();
      await flowControl.executeFn({
        functionIdentifier: 'func1',
        consumerIdentifier: 'user1',
        fn: () => Promise.resolve('success'),
      });

      const fnSpy = vi.fn(() => Promise.resolve('second'));
      await flowControl.executeFn({
        functionIdentifier: 'func1',
        consumerIdentifier: 'user1',
        fn: fnSpy,
      });

      expect(fnSpy).toHaveBeenCalledOnce();
    });

    it('should handle different function identifiers with single-flight', async () => {
      const fnSpy1 = vi.fn(() => Promise.resolve('func1'));
      const fnSpy2 = vi.fn(() => Promise.resolve('func2'));

      await Promise.all([
        flowControl.executeFn({
          functionIdentifier: 'func1',
          consumerIdentifier: 'user1',
          fn: fnSpy1,
        }),
        flowControl.executeFn({
          functionIdentifier: 'func2',
          consumerIdentifier: 'user1',
          fn: fnSpy2,
        }),
      ]);

      expect(fnSpy1).toHaveBeenCalledOnce();
      expect(fnSpy2).toHaveBeenCalledOnce();
    });
  });
});
