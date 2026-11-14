---
title: Unauthorized
description: The request carried no valid API key or token.
---

**Code:** `CANOPY_UNAUTHORIZED` (HTTP 401)

The request reached Canopy without credentials it accepts: no `apikey` header, a key that is not configured
or was revoked, or a bearer token whose signature, issuer or audience does not verify.

## Fix

- Send a publishable key (browsers) or a secret key (servers) in the `apikey` header on every request; the SDK
  sends `publishableKey` from `createClient`.
- For a signed in user, also send `Authorization: Bearer <access token>`. With an external identity provider,
  check that `auth.issuer`, `auth.audience` and `auth.jwksUrl` match what the provider puts in its tokens.
- Keys created in Studio can be revoked; list them with `canopy keys list`.

An address that keeps failing to authenticate is slowed down with `CANOPY_RATE_LIMITED` (see
[rate limits](/guides/rate-limits/)).
