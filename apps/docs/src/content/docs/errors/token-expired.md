---
title: Token expired
description: The access token was genuine but has expired.
---

**Code:** `CANOPY_TOKEN_EXPIRED` (HTTP 401)

Access tokens are short lived (10 minutes by default with built in auth). Once one expires, requests with it
are refused with this code, and realtime connections ask for a fresh one.

## Fix

- Give the SDK a token source (`auth` in `createClient`: `createAuth()` from `canopy.js/auth`, or your
  own `getToken` and `refresh`) instead of a fixed token: it asks for a new token before the old one expires
  and after the server refuses one.
- On a server, refresh the token before it expires, or use a secret key for server to server calls.
- Check the clocks of the machines involved: a clock far ahead makes tokens look expired.
