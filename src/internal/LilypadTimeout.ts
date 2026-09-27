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
      controller.abort(error);
      reject(error);
    }, timeout);
  });
  try {
    return await Promise.race([operation(controller.signal), timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}
