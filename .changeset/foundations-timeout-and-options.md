---
'@lilypad-studio/libs': minor
---

#### Upgrading

| Change                                                                                                                                                                                                                                                                                                                                                                                                           | What to do                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **`LilypadSerializer` rejects a key mapped to a union of target keys** (`@lilypad-studio/libs/serializer`). A `KeyMap` such as `{ a: 'x' \| 'y' }` used to pass the bijection check, although the serializer writes only the one `target` given at runtime, so the other key was never written and the value was lost on the way back. Its `target` is now typed `never`, and such a mapping no longer compiles. | Map each key to a single target key, e.g. `{ a: 'x' }`, and give the other target key its own source key. |

#### Fixed

- `LilypadFlowControl` (`@lilypad-studio/libs/flow`): a timed out attempt always rejects with a `LilypadTimeoutError`, as documented. A `fn` whose promise rejects from its abort listener with an error of its own (for example `reject(new DOMException('Aborted', 'AbortError'))`) used to replace it, so `shouldRetry` and the callers' `instanceof LilypadTimeoutError` checks saw that error instead.
- `LilypadFlowControl.executeFn` checks the per-call `timeout` before the first attempt, like `retries`: an invalid one (`NaN`, `0`, more than 2^31 - 1 ms) rejected with a `RangeError` only after being retried with backoff and passed to `shouldRetry`. A call with an invalid `timeout` or `retries` no longer uses the rate limit of its key, so the next valid call is not refused with a `LilypadRateLimitError`. Both options are checked for a call that joins one in flight too: its options are still ignored, but an invalid one now rejects it with a `RangeError` (the running call is unaffected), instead of failing only when no call is running.
- `LilypadCache` and `LilypadDbCache` (`@lilypad-studio/libs/cache`, `@lilypad-studio/libs/db`): a stale-while-revalidate refresh runs once when `platform.afterResponse` throws after scheduling it. The fallback used to start it a second time.
