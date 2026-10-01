---
'@lilypad-studio/libs': patch
---

#### Fixed

- After a step back of the system clock (an NTP correction, a resumed virtual machine), `LilypadCache` and `LilypadDbCache` (`@lilypad-studio/libs/cache`, `@lilypad-studio/libs/db`) no longer stop refreshing a stale key whose background refresh the platform dropped (`platform.afterResponse`), nor stop purging on access (`cleanupOnAccessEvery`), until the clock catches up. Both intervals are now measured on the monotonic clock.
