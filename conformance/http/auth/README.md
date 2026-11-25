# http/auth

The oracle of `/auth/v1` for stage R5 of plan 005: every flow built in auth serves today (Better Auth 1.7.18
through `@canopy/auth-builtin`), recorded as request and response sequences with the mail sent, the calls made
to identity providers, and the documents each case leaves in `canopy_auth`, `canopy.audit_log` and
`canopy.revocations`. A Rust implementation replays every case and must give the same answers and documents
after the placeholders below.

```
http/auth/
  fixture.json        the public URL, the secret, the first instant, the base options, and the signing keys
                      and key sets every case starts with (EdDSA and ES256)
  cases/<group>.json  one file per group
```

Written by `bun run vectors:http-auth` (`packages/testing/scripts/http-auth-vectors.ts`, recorder in
`packages/auth-builtin/test/conformance/`); `--check` (and `packages/auth-builtin/test/conformance-auth.test.ts`)
records again and fails when a file would change. `--group <name>` records one group. Needs a replica set
(`--uri` or `CANOPY_TEST_MONGODB_URI`). The same run proves the `canopy_auth` fixture database of
[`../../auth/documents`](../../auth/documents/README.md).

## Groups

| Group | Cases |
|---|---|
| `email-password` | Sign up (uniform answer), verification link, session, sign out, sign in; a taken and an unverified address; wrong password, unknown address, missing field, short password, unparsable JSON; sign up without required verification and remember me off |
| `email-verification` | Resend, a tampered token, the real token twice; an expired link |
| `password-reset` | Reset through the mailed link (known and unknown address, the callback redirect, every session ended, the token not reusable); change password with and without the current password, revoking other sessions |
| `magic-link` | Sign in once (new user, callback), reuse refused; an expired link and a foreign callback |
| `email-otp` | Sign in with a code and its reuse; three wrong codes use up the attempts; an expired code; email verification and password reset with a code |
| `two-factor` | TOTP enrolment, a sign in that stops at the second factor, a wrong code and the `aal2` session; the bearer ceremony headers (forged and missing Origin refused), backup codes and their reuse, new backup codes, the TOTP URI, disabling; a passwordless session cannot enrol |
| `passkeys` | Registration with `none` (ES256, synced) and `packed` self attestation (EdDSA, device bound), listing, renaming, sign in with each (`aal2`), deletion; refused registrations (foreign origin, no user verification, bad attestation signature) and assertions (bad signature, another relying party, wrong type, counter gone back); the fresh session rule |
| `anonymous` | Anonymous sign in and token, upgrade in place, verification and password sign in; upgrade refusals; linking on sign in and deleting the anonymous user; the routes when anonymous users are off |
| `social` | GitHub (OAuth 2 with PKCE, the emails API) twice and the account list; Google (RS256 ID token, nonce); a foreign callback, an unknown provider, a state of another browser, a code the provider refuses |
| `oidc` | The generic provider `acme` configured through discovery; ID tokens with another nonce or audience |
| `sessions` | Listing and revoking one, the others and all sessions; refresh after the update age and expiry; user updates (metadata writable, roles and app metadata not) and an email change |
| `bearer` | A session through `set-auth-token` and `Authorization: Bearer`, the access token and session list, a forged token, sign out |
| `tokens` | An EdDSA token, the key set on its three paths, a method other than GET, `/token` without a session, `/settings`; an ES256 token and key set |
| `admin-users` | The user admin behind `/admin/v1/users` (create, refusals, list, get, update, ban and its effect on sign in and tokens, unban, sessions, delete; invite; import of every hash kind with rehash on sign in) |
| `rate-limits` | The per identifier limit, the failure backoff, the engine's per address limit on sign in |
| `errors` | Unknown, disabled and foreign routes, bodies over 64 KiB with and without a length, the delete user route; preflights, a foreign origin with cookies, redirect targets outside the allowlist |

## How the recording is made deterministic

- **One fresh provider per run** on scratch databases, started at **2031-01-01T00:00:00.000Z** under the seed
  `canopy auth oracle startup` (so every case starts with the signing keys of `fixture.json`), with the base
  options of `fixture.json` and the case's `options`. Each step records its `clock`.
- **A fake clock.** `Date` is replaced while recording; the clock stands still and moves only where a case
  advances it (expiry, refresh, limits), so dates in bodies, cookies and documents are exact and are not
  substituted. A replayer sets its clock to each step's `clock`. ObjectId timestamps follow the same clock.
- **Seeded randomness.** `crypto.getRandomValues`, `crypto.randomUUID` and Ed25519 and P-256 key generation in
  Web Crypto draw from SHA-256 in counter mode over the seed. The MongoDB driver and BSON keep real
  randomness (their session ids must not repeat).
- **Mail** is captured by the memory transport; a step waits for the mails it is expected to send.
- **Identity providers** are mocked at their real origins through a routed `fetch`: the generic OIDC provider
  `https://idp.canopy.test` (discovery, authorize, token, userinfo, JWKS; an ES256 key derived from a fixed
  seed; codes `code-1`, `code-2`), GitHub (`github.com`, `api.github.com`) and Google (`accounts.google.com`,
  `oauth2.googleapis.com`, `www.googleapis.com`; RS256 because Better Auth accepts nothing else from Google,
  with a key made per run, which no recorded value depends on). The authorization endpoint consents at once
  and redirects back with the code and state. Any other origin fails the recording.
- **Passkeys** use two software authenticators (`packages/auth-builtin/test/conformance/webauthn.ts`), their
  keys derived from fixed seeds: `synced` (ES256, `none`, counter always 0, backed up) and `device` (EdDSA,
  `packed` self attestation, counting, not backed up). The `none` attestation object is fully deterministic.
- **Each case runs twice under two seeds** (`<case>:first` and `<case>:second`). Everything that differs between
  the runs is volatile and becomes a placeholder; anything else that differs (another status, field, length
  or word) fails the recording. So no value that depends on randomness can stay in the files unnoticed.

## Steps

```jsonc
{
  "clock": "2031-01-01T00:00:00.000Z",
  "client": "web",                       // a browser (cookie jar) or a bearer client; each has its own address
  "request": {
    "ip": "203.0.113.1",                 // passed as the socket address; no proxy is trusted
    "method": "POST", "path": "/auth/v1/sign-in/email",
    "headers": { "content-type": "application/json", "origin": "https://app.canopy.test" },
    "cookies": [{ "name": "__Secure-canopy.session_token", "value": "<session-token-1>.<cookie-signature-1>=" }],
    "body": { }                          // JSON, or the raw text for an unparsable body
  },
  "response": {
    "status": 200,
    "headers": { },                      // every header but date, content-length and set-cookie
    "cookies": [{ "name": "...", "value": "...", "attributes": ["Max-Age=604800", "Path=/", "HttpOnly", "Secure", "SameSite=Lax"] }],
    "body": { }                          // JSON with its key order, text, or null when empty
  },
  "details": { },                        // what the client computed: decoded WebAuthn data, the TOTP step
  "heldForTheFloor": true,               // on the routes of the response floor: the answer took at least 75 ms
  "mails": [{ "to": "...", "from": "...", "subject": "...", "text": "...", "html": "...", "jwts": [] }],
  "outbound": [{ "method": "POST", "url": "...", "headers": { }, "body": "..." }]  // calls to a provider
}
```

Request cookies are sent as `name=value` pairs joined by `; `, each value percent encoded with
`encodeURIComponent`; the files hold them decoded, like `set-auth-ceremony` and `x-canopy-ceremony`. A
`provider` step is the browser at a provider's authorization endpoint (its URL and the redirect back). An
`operation` step is a call of the user admin with its input and its `result` (canonical EJSON) or `error`
(name, Canopy code, message). `documents` holds every non empty collection of `canopy_auth` and
`canopy.audit_log` and `canopy.revocations` after the case, as canonical EJSON. `canopy_auth` collections are
sorted by `_id` (creation order, because ObjectIds count up). Audit and revocation documents are written
concurrently (several sessions ending at once), so their order is not part of the contract: they are sorted
by `at`, then by their content with every id ranked by the order its document was created.

An access token in a body is recorded as `{ "jwt": { "header", "claims", "signature" } }`: the recorder
verified its signature with the case's key set, and a replayer verifies its own token the same way after
seeding `canopy_auth.signing_keys` with the startup keys of `fixture.json`. The JWTs in verification links are
listed decoded under the mail's `jwts`.

## Placeholders

A placeholder `<kind-n>` stands for one value: the same value is the same placeholder everywhere in a case
(also inside URLs, cookie values, JSON strings in documents and mail), numbered per kind in the order of first
appearance. Tokens are runs of letters, digits and `+/_-`; a value whose tokens do not line up between the runs
is replaced whole. Kinds:

| Kind | The value |
|---|---|
| `user-id`, `session-id`, `account-id`, `verification-id`, `two-factor-id`, `passkey-id`, `rate-limit-id` | The ObjectId (hex) of a document of that collection, wherever it appears (bodies, `accountId`, claims, audit targets) |
| `audit-id`, `revocation-id` | The ObjectId of an audit or revocation document |
| `session-token` | `sessions.token` (32 letters and digits): also the first part of the session cookie, `set-auth-token` and bearer tokens |
| `cookie-signature` | base64 of HMAC-SHA256(secret, value) of a signed cookie (without the `=` padding, which stays literal); the recorder checked every one |
| `two-factor-cookie`, `better-auth-passkey-cookie`, `state-cookie`, `dont-remember-cookie` | The signed value of those cookies |
| `argon2id-salt`, `argon2id-tag` | The salt and tag of a native Argon2id hash (`$argon2id$v=19$m=19456,t=2,p=1$<salt>$<tag>`) |
| `mail-token` | The token of a magic link, invite or password reset link |
| `mail-jwt-claims`, `mail-jwt-signature` | The claims and HS256 signature parts of the JWT in an email verification or email change link (decoded under `jwts`) |
| `tampered-signature` | A verification link signature altered by the case |
| `otp` | A six digit email code |
| `totp`, `totp-secret`, `backup-code` | A TOTP code (from the enrolled secret at the step's clock), the base32 secret of the `otpauth://` URI, a backup code |
| `challenge`, `webauthn-user-id`, `client-data-json`, `attestation-object`, `assertion-signature` | WebAuthn values that depend on the challenge (the `none` attestation object is literal) |
| `code`, `state`, `code-challenge`, `code-verifier`, `nonce` | OAuth values (the provider's codes are literal `code-n` before the substitution of the callback URL) |
| `forged-bearer` | A bearer token made up by the case |
| `lease-owner` | The owner of the signing key lease |
| `two-factor-secret`, `two-factor-backup-codes` | The encrypted TOTP secret and backup codes in `two_factors` (their format is in [`../../auth/documents`](../../auth/documents/README.md)) |
| `verification-identifier`, `verification-value` | The identifier and value of a `verifications` document that are not one of the values above |
| `account-id-token` | A provider's ID token stored in `accounts` |
| `target-id`, `email`, `text` | Named after the field where the value first appears: the session id of an audit target whose session no longer exists after the step, the address of an anonymous user (`<email-n>@anonymous.canopy.invalid`), a random part of a mail text |

Not substituted: dates (the clock is fake), signing key ids, key material and key sets (the startup keys are
fixed), the `none` attestation object and credential ids (fixed authenticator keys), client addresses, emails,
passwords and everything else that is the same in both runs.

## What could not be made deterministic

- **ES256 signatures** (access tokens, packed attestations made with ES256) use a random nonce in Web Crypto;
  access tokens are recorded decoded and verified, attestation objects that embed them are placeholders.
- **Argon2id salts.** Under Bun the native hash is `Bun.password.hash`, whose salt Web Crypto does not supply;
  under Node it comes from `node:crypto`. Both are substituted.
- **ObjectIds** carry a per process random part and a counter shared by both runs.
- **The Google ID token** stored in `accounts.idToken` is signed with an RSA key made per process, so its
  signature is a placeholder (`id-token-signature`); its header and claims are literal.
- **Two runtime differences of the TypeScript server are normalized**, so Bun and Node record the same files:
  Bun's `Response.json` answers `content-type: application/json;charset=utf-8` where Node answers
  `application/json` (recorded as `application/json`); Node labels a plain string body
  `text/plain;charset=UTF-8` where Bun labels nothing (not recorded); and Web Crypto exports JWK members in another order
  on each runtime (`{"crv","kty","x"}` on Bun, `{"kty","crv","x"}` on Node), which changes the stored
  `publicKey` text and the encrypted private key; while recording, exported JWKs list their members in code
  point order. A replacement must accept both orders in stored keys.
- **The response floor** is real time: steps on its routes record only whether the answer was held at least
  75 ms (the floor is 80 ms; timers may fire up to a few milliseconds early).

## Findings recorded here

- The generic OIDC provider is started like a social provider: `POST /auth/v1/sign-in/social` with
  `provider: "acme"`, callback `/auth/v1/callback/acme`. There is no `/sign-in/oauth2` route.
- A client that sends the second factor or passkey ceremony in `x-canopy-ceremony` must also send an `Origin`:
  the bridged cookie makes the engine's origin check apply, so a native client without one gets
  `403 MISSING_OR_NULL_ORIGIN` (case `bearer-ceremony-and-backup-codes`).
- The engine limits `/sign-in*`, `/sign-up*`, `/change-password` and `/change-email` to 3 requests per 10
  seconds per client address (case `address-limit`), on top of the per identifier limit (10 per minute) and the
  failure backoff (a 1, 2, 4 ... second lock after five failures).
- A forged bearer token gives `200` with an empty body on `/get-session` and `401` on `/token`.
- A verification link used again after it was verified redirects to the callback without an error.

## Not covered yet

- The HTTP layer of `/admin/v1/users` (admin sign in, roles, body validation, the admin audit): recorded by
  the `/admin/v1` oracle; here the user admin it calls is recorded directly.
- Apple, Microsoft and Discord sign in; `packed` attestation with an `x5c` certificate chain; RS256 passkeys.
- The claims hook; signing key rotation and revocation over time; revocations followed from another node.
- A public URL on plain http (cookies without the `__Secure-` prefix).
- The email transports themselves (SMTP, Resend, Postmark, SES): mail is captured at the transport interface.
