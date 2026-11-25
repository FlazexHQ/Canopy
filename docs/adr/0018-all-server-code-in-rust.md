# ADR-0018: All server code in Rust, one shared core

- **Status:** Accepted (decided by the maintainer on 2026-11-25). Partly supersedes
  [ADR-0016](0016-canopy-js-and-container-services.md) (the vendored TypeScript core, the `canopy-control` and
  `canopy-studio` images) and [ADR-0017](0017-rust-data-plane.md) (TypeScript for the control plane and the
  developer surface, embedded mode). Answers open question Q17 of
  [12 §7](../design/12-roadmap.md#7-open-questions) with "no".
- **Date:** 2026-11-25
- **Deciders:** maintainers
- **Related:** [plan 005](../plans/005-all-server-code-in-rust.md), [plan 004](../plans/004-rust-data-plane.md),
  [07](../design/07-auth.md), [08](../design/08-studio-and-cli.md), [09 §4.2](../design/09-security.md#42-policy-engine),
  [14](../design/14-native-core.md), [ADR-0008](0008-auth-better-auth-and-byo-jwks.md),
  [ADR-0001](0001-typescript-6-and-bun.md)

## Context

[ADR-0017](0017-rust-data-plane.md) put every data path in one Rust binary and kept TypeScript for the
developer surface and a control plane. Plan 004 then delivered stages D1 to D6: `canopyd` serves REST,
GraphQL, realtime, storage and the MongoDB wire endpoint, and `packages/control` (`canopy-control`) serves
built in auth (Better Auth), the admin API, policy publishing at startup, meta database migrations and
webhooks. What is left in TypeScript on the server side is now the part with the most moving pieces:

- **Two implementations of every rule.** The policy compiler, the matcher, query canonicalization, config
  resolution and schema inference exist in TypeScript (`packages/policy`, `matcher`, `query`, `config`,
  `schema`) and in Rust (`crates/canopy-*`). Canopy.js vendors a third copy of the TypeScript files with
  `scripts/sync-core.ts`. The conformance vectors keep them equal, but every fix lands three times and ships
  in two releases.
- **Two server runtimes in one deployment.** The stack runs a Rust binary and a Bun process with their own
  MongoDB clients, pools, configs and failure modes. `canopy dev` needs Bun or Node to run the CLI and the
  control plane next to `canopyd`.
- **Embedded mode is a second data plane.** `@canopy/embedded` keeps REST, GraphQL, realtime and storage alive
  in TypeScript as a reference, which doubles the cost of every data feature and of every security fix.
- **Auth is a framework we do not control.** Better Auth (07 §12) brought every flow at once, but it decides
  document shapes, cookie formats and plugin behavior, runs only in a JavaScript runtime, and is the last
  reason the server needs one.

Canopy is a backend as a service; `canopy.js` is how applications talk to it. The maintainer's goal is one
server implementation and one implementation of each rule.

## Decision

**Everything on the server is Rust. Policies and config have one implementation, in Rust, shared by every
consumer. TypeScript remains only where code runs in the developer's app or browser.**

1. **The server.** The control plane (admin API, policy publishing, meta database migrations, webhooks and
   scheduled jobs), built in auth, Studio's server and the CLI move to Rust: `canopyd` serves every role, and a
   Rust `canopy` CLI binary replaces `@canopy/cli`. The `canopy-control` and `canopy-studio` images and their
   TypeScript services are removed; the platform runs as roles of the one `canopy` image (`CANOPY_ROLE` of
   `api`, `realtime`, `control`, `studio` or `all`), so [ADR-0016](0016-canopy-js-and-container-services.md)'s
   rule that one failing service does not take the others down still holds, with one image instead of three.
2. **One shared core, no translation.** Parsing, validation and compilation of policies, the matcher, query
   canonicalization, config resolution and schema inference live once, in the Rust crates. They run natively
   in `canopyd` and the CLI, and as WebAssembly (`canopy-wasm`) inside Canopy.js. Canopy.js keeps thin typed
   builders (`canopy.js/policy`, `/schema`, `/config`) that produce the **canonical document**: versioned JSON
   with a JSON Schema owned by the Rust crates. No TypeScript copy of the semantics survives, and
   `sync-core.ts` vendoring ends. Runtimes without WebAssembly or pages whose Content Security Policy forbids
   it get the same Rust core compiled to JavaScript (`wasm2js`), generated, never hand written.
3. **Embedded mode does not survive.** `@canopy/embedded`, the TypeScript data packages (`rest`, `graphql`,
   `storage`, `realtime`, `node-http`), the TypeScript server and the Node-API port are removed once their
   replacement passes its gate in plan 005. The recorded oracles in `conformance/` become **frozen vectors**.
   New behavior is checked against MongoDB itself (the DLS differential suites) and against new oracles
   recorded from the Rust implementation, which a reviewer approves before they are committed.
4. **Canopy's own auth, in Rust, on audited building blocks.** No auth framework and no separate identity
   server. Building blocks, all under the allowed licenses:

   | Need | Building block |
   |---|---|
   | Password hashing (Argon2id, the current default) | `argon2` (RustCrypto) |
   | Legacy and Better Auth hashes: bcrypt, PBKDF2 (SHA-1, SHA-256, SHA-512), Firebase scrypt, Better Auth scrypt | `bcrypt`, `pbkdf2`, `scrypt`, with `aes` and `ctr` for Firebase's final step (RustCrypto) |
   | EdDSA and ES256 signing, the JWKS, HMAC, SHA-1 and SHA-256, secure random | `ring` (already used) |
   | Private signing keys and two factor secrets that Better Auth's `symmetricEncrypt` encrypted (XChaCha20-Poly1305, confirmed against stored documents in stage R0) | `chacha20poly1305` (RustCrypto) |
   | Social sign in and generic OpenID Connect | `oauth2` (MIT or Apache 2.0), `openidconnect` (MIT) |
   | TOTP | In house on `ring`, per RFC 6238 and RFC 4226 |
   | Magic link and email OTP mail | `lettre` (MIT) for SMTP; Resend, Postmark and SES (SigV4 on `ring`) over the existing HTTP client |
   | Passkeys | **Our own WebAuthn relying party** on `ring`, with `coset` and `ciborium` (Apache 2.0) or our own CBOR and COSE parser |

   The relying party verifies the `none` and `packed` attestation formats (self attestation and an `x5c`
   statement whose signature and certificate requirements are checked; no trust anchors are evaluated, as
   today's configuration requests no attestation), the ES256, EdDSA and RS256 algorithms, user presence and
   required user verification, the backup flags and the signature counter. It is built against the W3C
   WebAuthn Level 3 test vectors, with a fuzz target on every parser. Storage stays the `canopy_auth` documents
   that Better Auth writes today (`users`, `sessions`, `accounts`, `verifications`, `two_factors`, `passkeys`,
   `rate_limits`, `signing_keys`, `identifier_limits`, `leases`), so existing users, sessions, passkeys and
   signing keys carry over without a migration of their contents. Feature parity is everything
   `packages/auth-builtin` offers today, verified by an HTTP oracle of `/auth/v1` recorded from the TypeScript
   server before it is removed, as stages D1 to D6 did.

TypeScript remains in Canopy.js (the client, framework bindings, devtools and the authoring builders), in the
Studio UI (a browser app served by `canopyd`), in the docs site, and in test and repository tooling
(`sdk-e2e`, the Playwright suites, `tools/repo-check`, the benchmark load generators). The developer's own
config and policy files stay TypeScript: at development time the CLI evaluates them with the project's own
runtime through a small emitter in Canopy.js, which prints the canonical documents; `canopyd` never evaluates
TypeScript.

This supersedes, in [ADR-0017](0017-rust-data-plane.md), the statement that TypeScript is the developer
surface and control plane, the TypeScript `control` service and image, and the TypeScript data packages kept
as embedded mode and reference; its data plane decision, gates and driver choice stand. It supersedes, in
[ADR-0016](0016-canopy-js-and-container-services.md), the vendored copy of the core in Canopy.js, the
`canopy-studio` image and `CANOPY_ROLE=all` as an embedding mode; the two repositories, the one `canopy.js`
package and the separate services stand. It replaces the Better Auth engine of
[ADR-0008](0008-auth-better-auth-and-byo-jwks.md); the `AuthProvider` exit plan of
[07 §12](../design/07-auth.md#12-why-better-auth-and-the-exit-plan) is the path it takes, and bring your own
JWKS is unchanged. It narrows [ADR-0001](0001-typescript-6-and-bun.md) to Canopy.js, Studio and tooling.

## Consequences

- **Positive:**
  - one implementation of each rule: a policy, matcher or config fix lands once and reaches `canopyd`, the CLI,
    Studio's "view as user" and the browser at the same time;
  - one server runtime: one binary, one MongoDB client per process, one config loader, one telemetry stack;
    `canopy dev` and the containers need no Bun or Node on the host to serve;
  - Canopy owns its auth document shapes, cookie formats and flows, with no framework release on the security
    path;
  - the container stack uses one image for every role;
  - invariants I1 to I6 are tested against one implementation and MongoDB, not kept equal across three copies.
- **Negative / costs:**
  - auth is now Canopy's own security critical code: it needs an external security review before it ships,
    and the WebAuthn relying party is new code where Better Auth used a mature library;
  - the TypeScript reference that caught Rust divergences is gone; frozen vectors, MongoDB as the oracle and
    reviewed Rust oracles replace it, and a mistake in a reviewed oracle is no longer caught by a second
    implementation;
  - browsers load the core as WebAssembly: a larger first download than today's TypeScript lite matcher, an
    instantiation cost at startup, a crossing per call, and `'wasm-unsafe-eval'` in strict Content Security
    Policies (or the `wasm2js` build); plan 005 gates it by measurement;
  - users can no longer mount Canopy inside a Node application; they run `canopyd` beside it;
  - claims hooks written as TypeScript functions in the config cannot run in the server; they become an HTTPS
    claims hook, signed like webhooks and failing closed (decided 2026-11-25, plan 005 O3);
  - contributors to any server code need Rust; contributors without it keep Canopy.js, Studio and the docs;
  - the CLI ships as eight prebuilt binaries, like `canopyd`, with the release work that brings.
- **Follow-ups:** [plan 005](../plans/005-all-server-code-in-rust.md) stages R0 to R7; the canonical document
  formats and their JSON Schemas; the `/auth/v1` and `/admin/v1` oracles before any TypeScript is removed; a
  WebAuthn spike; the Wasm bundle and startup gate; the external auth review; updates of 01, 07, 08, 11, 12
  and 14, the docs summary and glossary, and `CLAUDE.md` when stage R7 lands.

## Alternatives considered

| Option | Why not |
|---|---|
| Keep the TypeScript control plane, CLI and embedded mode (ADR-0017 as written) | Keeps two server runtimes, three copies of the core and a second data plane to keep equivalent |
| Translate the Rust core to TypeScript for Canopy.js (generated or hand ported) | A translation is a second implementation with its own bugs; the decision is one implementation |
| Rauthy as the identity server | A separate server with its own Hiqlite or Postgres database: breaks "Canopy state lives only in `canopy` and `canopy_auth`" and the one binary |
| A young all in one Rust auth framework (RustAuth, auth-framework, yauth) | Unproven, SQL backed, and the same loss of control over document shapes that Better Auth has |
| Keep Better Auth in a small TypeScript auth service | The one remaining reason for a JavaScript runtime on the server, and a framework on the security path |
| `webauthn-rs` for passkeys | MPL-2.0, outside the allowed licenses |
| `webauthn_rp` for passkeys | The maintainer chose an implementation of our own, built on `ring` and the W3C test vectors |
| Embed a JavaScript engine in `canopyd` to evaluate config and policy files | Puts user code and a second runtime in the server; the canonical document makes it unnecessary |
