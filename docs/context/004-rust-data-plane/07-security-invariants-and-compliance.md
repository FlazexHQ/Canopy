# Security Invariants and Compliance Context

This document details the security principles, invariant properties, and engineering standards governing [004-rust-data-plane.md](../../plans/004-rust-data-plane.md) and all related Rust and TypeScript implementations.

## Security Principles and Fail Closed Semantics

Canopy is an authorization product. A Document Level Security (DLS) bypass represents the worst possible defect. Therefore, the Rust data plane enforces strict fail closed semantics:
1. **Unrecognized Elements Deny:**
   Any unknown query operator, unlisted pipeline stage, or unsupported expression causes an immediate query rejection, never a pass-through.
2. **Missing Variables Deny:**
   When a policy evaluates a variable that does not exist in the caller's JWT claims or request context (such as an unassigned attribute or missing metadata), the policy evaluates to false and access is denied.
3. **Exceptions Deny:**
   Any runtime error, decoding issue, timeout, or cancellation during policy evaluation terminates the request with access denied.
4. **Writes Checked by the Database:**
   All `check` constraints are evaluated directly by MongoDB inside multi document transactions using aggregation pipelines. The data plane does not simulate update expressions in application memory.
5. **Collation Scope and Precheck Security:**
   Pipelines starting with `$documents` evaluated at the database level ignore collection default collations. To ensure strict adherence to collection collations, prechecks in `Scope.checkBefore` run as an aggregation directly on the target collection: `{$match: {_id: {$in: []}}}` (matching zero documents), followed by `$unionWith: {pipeline: [{$documents: [...]}]}`, followed by the `$facet` evaluating the check filter. Because the pipeline executes against the target collection, MongoDB applies the collection default collation to the `$unionWith` document stream. The cached collation lookup is removed from the DLS authorization path, allowing collections with default collations to use the 2 command fast path safely. The 60 second collation cache is restricted to batch grouping and read back deferral, where stale cache metadata cannot cause an authorization bypass.

## Security Invariants (I1 through I6)

From [09-security.md](../../design/09-security.md), the following six invariants are verified continuously through property tests and cannot be weakened:

- **Invariant I1 (Read Security):**
  A non-service read never returns any document that fails the effective `USING(read)` policy for the caller's context.
- **Invariant I2 (Write Security):**
  A non-service write never leaves any document in the database that fails the effective `CHECK(op)` policy for the caller's context. By executing prechecks on the target collection through `$unionWith`, MongoDB enforces collection collations on prechecked writes outside transactions, preserving Invariant I2 across all collections without falling back to multi-document transactions.
- **Invariant I3 (Field Level Privacy):**
  A non-service response never contains any field outside the set defined by `readable(roles)`.
- **Invariant I4 (Realtime Equivalence):**
  A realtime client never receives any document or field that it could not fetch through REST with the exact same context at the exact same cluster time `ct`.
- **Invariant I5 (Fail Closed Evaluation):**
  Any exception or error occurring during policy evaluation produces a denial of access.
- **Invariant I6 (Redaction):**
  No secret value (such as API keys, JWT tokens, credentials, or encryption keys) ever appears in log output, metrics labels, or error responses.

## Codebase Standards and Compliance Rules

### 1. MongoDB Terminology
Canopy is a document database platform. Never use relational terms in code, type names, variable names, generated documentation, comments, error messages, or commit messages:
- Say **documents**, not rows or records.
- Say **collections**, not tables.
- Say **fields**, not columns.
- Say **databases**, not schemas (except when referring specifically to JSON Schema or GraphQL schema definitions).

### 2. Prohibition on Punctuation Dashes
The project strictly prohibits punctuation dashes across all documentation, code comments, error messages, commit messages, and pull request text:
- Do not use em dashes (U+2014).
- Do not use en dashes (U+2013).
- Do not use spaced hyphens (a hyphen with a space on each side: ` - `) as punctuation in prose.
- Rephrase statements using commas, colons, parentheses, or separate sentences. Hyphens that form syntax or part of fixed identifiers (such as CLI flags, crate names, package names, or file names) are permitted.

### 3. Rust Code Standards
- **`unsafe_code = "forbid"`:** No unsafe blocks are permitted anywhere in the workspace.
- **Documentation:** `missing_docs = "deny"` enforces rustdoc documentation on all public modules, structs, enums, functions, and traits.
- **No panics:** Clippy denies `unwrap_used`, `expect_used`, `panic`, `todo`, `unimplemented`, and `dbg_macro`.
- **Standardized Errors:** Errors map directly to the shared `CanopyError` struct and `ErrorCode` enum hierarchy defined in `canopy-protocol` (without external error derive macros like `thiserror`).
- **Crate Dependency Layering Rule:** Core and configuration crates must never depend on runtime or service crates. Foundation crates (`canopy-protocol`, `canopy-matcher`, `canopy-query`, `canopy-policy`, `canopy-config`) define data models, compilers, and configuration contracts without any runtime or transport dependencies. Specifically, `canopy-config` depends only on `canopy-protocol` and `base64`, exposing plain configuration types (`JwtConfig`, `FullDocument`, `MessageRate`, `Cors`) and view key decoding. It must never depend on `canopy-auth`, `canopy-engine`, `canopy-realtime`, `canopy-http`, or `canopy-data`. Runtime crates depend downward on configuration and core crates, never the reverse.
