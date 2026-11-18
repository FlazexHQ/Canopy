---
"@canopy/studio": patch
---

Studio clears the timers of its pending toasts when the toaster unmounts, so a toast no longer updates state after the page that showed it is gone.
