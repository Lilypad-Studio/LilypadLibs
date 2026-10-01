/**
 * Runs `operation` and rejects with `createError()` if it has not settled within `timeout` ms; the
 * signal it receives is aborted with that error. JavaScript cannot stop a running promise:
 * `operation` should observe the signal. The timer is always cleared.
 */
export async function withLilypadTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeout: number,
  createError: () => Error
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = createError();
      // Rejected first: the abort listeners run synchronously, and an operation that rejects from
      // one with an error of its own would otherwise win the race
      reject(error);
      controller.abort(error);
    }, timeout);
  });
  try {
    return await Promise.race([operation(controller.signal), timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}
