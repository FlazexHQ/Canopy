# canopy_auth fixture database

A `canopy_auth` database written by the TypeScript server (built in auth on Better Auth 1.7.18, through
`@canopy/auth-builtin`), exported as canonical EJSON, one file per collection. A replacement of built in auth
must read these documents as they are and prove that every credential in them still works
(plan 005 §6.2: documents carry over without a migration of their contents).

Written by `bun run vectors:http-auth -- --rewrite-documents` (`packages/auth-builtin/test/conformance/documents.ts`),
and only then: the documents hold random salts and ObjectIds, so a recording keeps the committed files.
`bun run vectors:http-auth -- --check` and `packages/auth-builtin/test/conformance-auth.test.ts` prove the
committed files against the TypeScript server every time.

## How it was written

On the fake clock of the auth oracle (2031-01-01T00:00:00.000Z, see `conformance/http/auth/README.md`), with
the oracle's secret, public URL (`https://auth.canopy.test`) and mock providers, the TypeScript server:

| Who | How | What it leaves |
|---|---|---|
| `native@example.com` | Signs up, follows the verification link, signs in | A native Argon2id hash (`$argon2id$v=19$m=19456,t=2,p=1$...`), two sessions |
| `scrypt@example.com` | Created by the user admin, then its `password` replaced by a Better Auth scrypt hash (`<salt hex>:<key hex>`, N 16384, r 16, p 1, 64 bytes over the NFKC password and the salt's hex text), the format Better Auth writes by default | A Better Auth scrypt hash |
| `bcrypt@`, `pbkdf2-sha1@`, `pbkdf2-sha256@`, `pbkdf2-sha512@`, `firebase@`, `argon2@example.com` | Imported by the user admin with their hashes (`canopy-legacy$<kind>$...`) | One imported hash of every kind `legacy-passwords.ts` verifies |
| `totp@example.com` | Signs up, enables two factor with its password and confirms the first code | A `two_factors` document with the encrypted secret and backup codes |
| `passkey@example.com` | Signs up and registers the `synced` (ES256, `none`) and `device` (EdDSA, packed self attestation) software authenticators | Two `passkeys` documents |
| GitHub, Google and the generic OIDC provider `acme` users | Sign in through the mock providers | `accounts` documents of provider `github`, `google` and `acme` |
| An anonymous user | `POST /auth/v1/sign-in/anonymous` | A user with `isAnonymous: true` and an address in `anonymous.canopy.invalid` |
| Signing keys | The key ring at start with EdDSA, then a second start on the same database with ES256 | An active and a standby key of each algorithm |

`manifest.json` says what belongs to whom: the secret, every plaintext password with its hash kind, the
session tokens with their signed cookie values, the TOTP secret (raw and base32) and backup codes, the
software authenticators with their private keys (`jwk`), and the provider subjects.

## Formats confirmed from these documents

- **Encrypted values** (`signing_keys.privateKey`, `two_factors.secret`, `two_factors.backupCodes`) are what
  Better Auth's `symmetricEncrypt` writes with a plain string secret: lowercase hex of a 24 byte nonce, the
  XChaCha20 ciphertext and the 16 byte Poly1305 tag, no associated data, under the key SHA-256(UTF-8 bytes of
  the secret). No `$ba$<version>$` envelope is written (that envelope appears only with versioned secrets,
  which Canopy does not configure). `signing_keys.privateKey` is additionally a JSON string literal: the stored
  text starts and ends with `"`, and the decrypted plaintext is the JSON of the private JWK (`kty`, `crv`, `x`,
  `d` for Ed25519; also `y` for P-256). `two_factors.secret` decrypts to the raw 32 character TOTP secret; the
  `otpauth://` URI carries its UTF-8 bytes in base32 and the TOTP key is those bytes. `backupCodes` decrypts to
  a JSON array of ten `xxxxx-xxxxx` codes. The proof decrypts all of them with an XChaCha20-Poly1305 written
  apart from Better Auth (`packages/auth-builtin/test/conformance/formats.ts`).
- **The session cookie** is `__Secure-canopy.session_token` (the `__Secure-` prefix because the public URL is
  https), whose value is `encodeURIComponent(token + "." + base64(HMAC-SHA256(secret, token)))` with padded
  standard base64; `token` is `sessions.token` (32 letters and digits). The same signature scheme signs
  `__Secure-canopy.two_factor`, `__Secure-canopy.better-auth-passkey`, `__Secure-canopy.state` and
  `__Secure-canopy.dont_remember`. Attributes: `Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax` for a
  session (no `Max-Age` when remember me is off), `Max-Age=600` for the two factor cookie, `Max-Age=300` for
  the passkey and OAuth state cookies.
- **Key JSON** (`signing_keys.publicKey` and the decrypted private key) is the Web Crypto JWK export, whose
  member order depends on the runtime that minted it: this fixture was written under Bun with the members in
  code point order (`crv`, `d`, `kty`, `x`, `y`); Node writes `kty` first. Readers must not depend on the order.
- **Ids** are ObjectIds in `_id` and in references (`sessions.userId`, `accounts.userId`, `two_factors.userId`,
  `passkeys.userId`); `accounts.accountId` of a credential account is the user id as a hex string. Signing key
  ids are UUID strings. Dates are BSON dates.
- **Passkeys** keep `publicKey` as unpadded standard base64 of the COSE key, `credentialID` as base64url,
  `counter` as an int32, `transports` as a comma separated string, `aaguid` as a UUID string, `deviceType`
  `singleDevice` or `multiDevice` and `backedUp`.

## The proof

`proveDocuments` loads every file into a scratch database, starts the TypeScript server on it at
2031-01-01T01:00:00.000Z and checks, reporting each failure:

1. every private signing key decrypts to the JWK of its `publicKey`;
2. the TOTP secret and the backup codes decrypt to what the manifest holds;
3. every stored session cookie is the token and its HMAC-SHA256;
4. every password user signs in (the TOTP user completes the second factor with a code from the secret), and
   afterwards holds a native Argon2id hash: imported and Better Auth scrypt hashes are replaced on sign in;
5. both stored sessions are accepted by `GET /auth/v1/get-session` with their cookies;
6. both passkeys authenticate (the device authenticator continues from the stored counter);
7. the GitHub, Google and OIDC accounts sign in again as the same users;
8. an access token signed with the stored EdDSA key, and after a restart with ES256 one signed with the stored
   ES256 key, verify with the published key set, and no key was created.

A Rust implementation proves the same on these files: R5's exit gate.
