---
title: TLS mismatch
description: The client and the server disagree about TLS.
---

**Diagnostic:** `the TLS handshake with MongoDB failed`

## Fix

- When the server requires TLS (Atlas always does), use a `mongodb+srv://` string or add `tls=true`.
- When the server does not use TLS, remove `tls=true` or `ssl=true` from the connection string.
- With a private certificate authority, pass its file with `tlsCAFile=<path>`. Do not turn certificate
  checks off in production.
