---
'@lilypad-studio/libs': patch
---

#### Fixed

- After a step back of the system clock (an NTP correction, a resumed virtual machine), a `LilypadDbCache` with the `changelog` strategy (`@lilypad-studio/libs/db`) no longer stops reading the changelog, and serving stale rows, until the clock catches up, and no longer keeps trusting its cursor after a gap longer than `maxGap`. `pollInterval` and `maxGap` are now measured on the monotonic clock.
