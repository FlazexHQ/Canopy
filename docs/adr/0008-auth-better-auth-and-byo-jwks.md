# ADR-0008: Auth: Better Auth embedded, plus bring-your-own JWKS

- **Status:** Proposed (fit validated by spike S6)
- **Date:** 2026-11-05
- **Related:** [07](../design/07-auth.md); [ADR-0017](0017-rust-data-plane.md) places Better Auth in the TypeScript
  control plane and token verification in the Rust data plane

## Context

Concept 2 needs Supabase-style JWT auth. Concept 1 must work with any existing identity provider. Building a
secure auth server (password flows, OAuth, magic links, MFA, key rotation) from scratch takes months and carries
a lot of risk.

## Decision

- **Built-in mode** embeds **Better Auth** with `@better-auth/mongo-adapter`, using a `MongoClient` for
  transactions, in a separate `canopy_auth` database. Access tokens are minted by its **JWT plugin** (EdDSA by
  default, JWKS, rotation with grace periods), and a Canopy claims hook shapes them. Routes are mounted under
  `/auth/v1`, and the SDK is the stable contract.
- **External mode** verifies JWTs from any OIDC/JWKS provider with `jose`, using pinned algorithms, a fixed
  JWKS host, and configurable role and claim mapping.
- An **`AuthProvider` interface** isolates the engine, so it can be replaced later.
- Project **API keys** (publishable and secret) are separate from JWT signing keys.

## Consequences

- **Positive:** a mature, TypeScript-native feature set from day one; a first-party MongoDB adapter; key
  rotation; external mode makes the drop-in story possible.
- **Negative:** a dependency on a third-party project's roadmap and security record (mitigated by pinned
  versions, integration tests and the exit plan); route shapes follow Better Auth's conventions underneath.

## Alternatives considered

| Option | Why not |
|---|---|
| A custom GoTrue-style auth server | Months of security-critical work before any differentiating feature |
| Keycloak, Ory or Zitadel as a sidecar | Heavy to operate, and adds an extra service to the "one container" platform |
| BYO only | Loses the Supabase-like all-in-one experience that Concept 2 promises |
