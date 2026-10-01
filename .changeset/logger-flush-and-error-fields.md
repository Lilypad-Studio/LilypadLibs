---
'@lilypad-studio/libs': minor
---

#### Upgrading

| Change                                                                                                                                                                                                                                                                                                                                                                                                                         | What to do                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **`logger.flush()` waits only for the messages logged before the call** (`@lilypad-studio/libs/logger`). It used to loop until no message was pending, so it also waited for the messages logged while it waited, and never resolved while messages kept arriving (for example during a shutdown with requests still logging to Discord). The messages `errorLogging` logs synchronously about a failure are still waited for. | Nothing, unless you relied on `flush()` waiting for messages logged after the call: call `await logger.flush()` again after logging them. |

#### Fixed

- `LilypadLogger` (`@lilypad-studio/libs/logger`): a message with an `Error` part whose `stack`, `message` or `name` cannot be read (a getter that throws, such as a failing `Error.prepareStackTrace`) or is not a string is logged. It used to be lost: no component received it, and `errorLogging` got an internal `TypeError` instead. `record.errors` converts such a field to a string, and replaces one that cannot be read (`Error` for the name, an empty message, no stack). In the text of the message, such an error used to print as `[Unformattable value]`, and an error whose `cause` getter threw as well: they now keep the rest of the error, with `[cause]: [Getter threw]`.
- `LilypadLogger`: a typed array, such as a Node.js `Buffer`, prints as `Uint8Array(3) [ 1, 2, 3 ]`, its first 100 items, without listing all its keys first: logging a 5 MB `Buffer` blocked the caller for about 500 ms to print `{ '0': 0, '1': 0, ... }`. The JSON form (`toLogJson`, the context, `LilypadJsonConsoleLogger`) is unchanged.
- `LilypadLogger`: the `redact` option also applies to the `cause` of errors, as it does to the `errors` of an `AggregateError`: with `redact: [...LILYPAD_DEFAULT_REDACTED_KEYS, 'cause']`, the causes print as `[Redacted]`.
