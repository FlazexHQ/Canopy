---
"@canopy/auth-builtin": patch
---

Sign up, sign in, password reset and the other routes whose timing could reveal whether an email has an account now also wait for the slowest recent answer on the same route (up to one second), not only for `responseFloorMs`. On a machine where creating an account outlasted the 80 ms floor, a taken address answered measurably faster than a new one.
