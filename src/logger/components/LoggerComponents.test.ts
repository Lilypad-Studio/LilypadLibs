import { describe, it, expect, vi, afterEach } from 'vitest';
import LilypadConsoleLogger from './ConsoleLogger';
import LilypadDiscordLogger from './DiscordLogger';

describe('LilypadConsoleLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['error', 'error'],
    ['ERROR', 'error'],
    ['warn', 'warn'],
    ['info', 'log'],
    ['debug', 'log'],
  ] as const)('should route "%s" messages to console.%s', async (type, method) => {
    const spies = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };

    await new LilypadConsoleLogger<string>().output(type, 'message');

    for (const [name, spy] of Object.entries(spies)) {
      expect(spy).toHaveBeenCalledTimes(name === method ? 1 : 0);
    }
    expect(spies[method]).toHaveBeenCalledWith(expect.stringContaining('message'));
  });
});

describe('LilypadDiscordLogger', () => {
  const webhookUrl = 'https://discord.test/api/webhooks/123/token';

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function stubFetch(response: Partial<Response> = { ok: true, status: 204 }) {
    const fetchMock = vi.fn(async () => response as Response);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function sentBody(fetchMock: ReturnType<typeof stubFetch>) {
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    return JSON.parse(init.body as string);
  }

  it('should post the formatted message to the webhook with mentions disabled', async () => {
    const fetchMock = stubFetch();

    await new LilypadDiscordLogger<'error'>(webhookUrl).output('error', 'hello @everyone');

    expect(fetchMock).toHaveBeenCalledWith(
      webhookUrl,
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) })
    );
    const body = sentBody(fetchMock);
    expect(body.content).toContain('[ERROR]: hello @everyone');
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });

  it('should truncate messages to the Discord limit of 2000 characters', async () => {
    const fetchMock = stubFetch();

    await new LilypadDiscordLogger<'info'>(webhookUrl).output('info', 'x'.repeat(5000));

    expect(sentBody(fetchMock).content).toHaveLength(2000);
  });

  it('should reject when Discord answers with an error status', async () => {
    stubFetch({ ok: false, status: 500, statusText: 'Internal Server Error' });

    await expect(
      new LilypadDiscordLogger<'info'>(webhookUrl).output('info', 'message')
    ).rejects.toThrow('Discord webhook request failed with status 500 Internal Server Error');
  });

  it('should batch the messages logged while the next request is throttled', async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch();
    const logger = new LilypadDiscordLogger<'info'>(webhookUrl);

    const sent = [
      logger.output('info', 'first'),
      logger.output('info', 'second'),
      logger.output('info', 'third'),
    ];
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(sent);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    const content: string = JSON.parse(init.body as string).content;
    expect(content.split('\n')).toEqual([
      expect.stringContaining('[INFO]: second'),
      expect.stringContaining('[INFO]: third'),
    ]);
  });

  it('should retry a rate limited request after the retry-after time', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: new Headers({ 'retry-after': '2' }),
      })
      .mockResolvedValueOnce({ ok: true, status: 204 });
    vi.stubGlobal('fetch', fetchMock);

    const sent = new LilypadDiscordLogger<'info'>(webhookUrl).output('info', 'message');
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    await expect(sent).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should reject when Discord keeps rate limiting the request', async () => {
    vi.useFakeTimers();
    stubFetch({ ok: false, status: 429, statusText: 'Too Many Requests' });

    const sent = new LilypadDiscordLogger<'info'>(webhookUrl).output('info', 'message');
    const assertion = expect(sent).rejects.toThrow('status 429');
    await vi.advanceTimersByTimeAsync(1000);

    await assertion;
  });

  it('should reject when the request times out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      })
    );

    await expect(
      new LilypadDiscordLogger<'info'>(webhookUrl).output('info', 'message')
    ).rejects.toThrow('timeout');
  });
});
