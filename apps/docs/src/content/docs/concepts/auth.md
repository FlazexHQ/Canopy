---
title: Auth
description: API keys, tokens from your own identity provider, and Canopy's built in user auth.
---

Every request carries an API key and, for signed in users, an access token.

## API keys

| Key             | Role      | Where it belongs                                 |
| --------------- | --------- | ------------------------------------------------ |
| Publishable key | `anon`    | In the browser or app; it identifies the project |
| Secret key      | `service` | On your servers only; it bypasses every policy   |

Keys are sent in the `apikey` header (or the `hello` frame on realtime). Manage stored keys with
`canopy keys` or in Studio.

## Bring your own identity provider

Auth0, Clerk, Cognito, Keycloak, Firebase Auth, Supabase Auth or any issuer with a JWKS works. Canopy verifies
the token's signature, issuer, audience and expiry, and reads roles from the claim you name:

```ts
import { defineConfig, external } from "@canopy/config"

export default defineConfig({
  auth: external({
    jwksUrl: "https://YOUR_TENANT.us.auth0.com/.well-known/jwks.json",
    issuer: "https://YOUR_TENANT.us.auth0.com/",
    audience: "https://api.example.com",
    rolesClaim: "https://example.com/roles",
  }),
})
```

`none` and HMAC algorithms are refused.

## Built in auth

`builtin()` runs user auth inside Canopy, stored in the `canopy_auth` database: email and password, magic
links, email codes, anonymous users, OAuth providers (Google, GitHub, Apple, Microsoft, Discord and any OIDC
issuer), [TOTP and passkeys](/guides/two-factor-and-passkeys/). Canopy issues short lived access tokens
signed with rotating keys and publishes them at `/auth/v1/.well-known/jwks.json`.

```ts
import { createAuth } from "@canopy/client/auth"
import { indexedDbPersister } from "@canopy/client/persist"

const auth = createAuth({ url: "https://api.example.com", storage: indexedDbPersister() })
await auth.signInWithPassword({ email, password })
const canopy = createClient({ url: "https://api.example.com", publishableKey: "pk_app", auth })
```

## Claims in policies

Policies read token claims with `auth("claim")`. Built in auth issues `sub`, `sid`, `role`, `roles`,
`email`, `email_verified`, `is_anonymous`, `aal`, `app_metadata`, `user_metadata` and whatever a claims hook
adds. `aal` is `aal2` when the session was confirmed with a second factor or a passkey, and `aal1` otherwise.

Banning or deleting a user revokes their sessions and the access tokens already issued to them.
