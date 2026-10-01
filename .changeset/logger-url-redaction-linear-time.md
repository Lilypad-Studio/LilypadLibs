---
'@lilypad-studio/libs': patch
---

#### Fixed

- `LilypadLogger` (`@lilypad-studio/libs/logger`) no longer blocks the event loop on a crafted logged value. Its channel methods, `toLogJson` and the messages the other modules log through it mask the passwords of URLs (`scheme://user:[Redacted]@host`). The expression that finds them backtracked quadratically on a long run like `a.a.a…://`: a 50 KB value took about 4 seconds to format, and it was formatted synchronously by the channel method. Such a value can come from user input that a logged error carries, e.g. a PostgreSQL error that quotes the invalid input. Formatting is now linear. A URL scheme longer than 64 characters is no longer masked.
