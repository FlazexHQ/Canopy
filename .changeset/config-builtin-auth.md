---
"@canopy/config": minor
"@canopy/realtime": patch
"@canopy/cli": patch
---

Add the `builtin()` auth kind and the `email.smtp()`, `email.resend()`, `email.postmark()`, `email.ses()` and
`email.log()` transports. The resolver validates built in auth and applies its defaults: a secret of at least
32 characters (the master key unless `auth.secret` is set), token lifetimes of 5 to 60 minutes, a key grace
period that covers the token lifetime, passwords of at least 10 characters, unique OIDC provider ids, and in
production an https public URL and redirect URLs and a real email transport. `CANOPY_JWT_*` variables are
refused with built in auth, and `config print` masks every client secret and transport credential.
`canopy-realtime` refuses built in auth and explains how to accept the server's tokens through `external()`.
