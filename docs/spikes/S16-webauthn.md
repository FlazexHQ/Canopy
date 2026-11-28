# S16: Can Canopy verify passkeys itself, in Rust?

- **Date:** 2026-11-25
- **Status:** done. **Go** for the in house relying party in `crates/canopy-webauthn`; it is the passkey part of
  stage R5. An external security review is still required before the release that enables it.
- **Plan:** [005](../plans/005-all-server-code-in-rust.md), §6.3 and the R5 entry gate
- **Decision:** [ADR-0018](../adr/0018-all-server-code-in-rust.md) (the maintainer chose an own implementation
  over webauthn-rs, which is MPL-2.0, and webauthn_rp)

## Question

Built in auth registers and authenticates passkeys through Better Auth today. The Rust auth needs a WebAuthn
relying party that verifies the same ceremonies, authenticates the passkeys the TypeScript server already
registered, refuses everything the specification refuses, and never panics on hostile input, using only
dependencies under MIT, Apache 2.0, BSD or ISC.

## What was built

`crates/canopy-webauthn` (about 1,900 lines, dependencies `ring`, `subtle`, `base64`, `serde` and `serde_json`):

| Module | Covers |
|---|---|
| `cbor` | A strict decoder for what WebAuthn needs: definite lengths only, integer and text map keys, no duplicate keys, no trailing bytes, nesting and size limits |
| `cose` | EC2 P-256 (ES256), OKP Ed25519 (EdDSA) and RSA (RS256, 2,048 to 8,192 bit moduli, odd exponent of at most 32 bits); a key whose `alg` and curve disagree is refused |
| `authenticator_data` | RP ID hash, the UP, UV, BE, BS, AT and ED flags, the signature counter, attested credential data with its AAGUID and credential id length limit, extensions |
| `client_data` | `type`, `challenge`, `origin`, `crossOrigin` and `topOrigin` |
| `der`, `x509` | The DER subset and certificate fields the `packed` attestation needs |
| `attestation` | `none`, `packed` self attestation and `packed` with an `x5c` chain |
| `signature` | ES256 with the unique DER encoding only, EdDSA, RS256 with PKCS #1 v1.5 |
| `relying_party` | Both ceremonies |

**Registration (§7.1):** constant time challenge comparison (challenges shorter than 16 bytes are refused),
ceremony type, origin by exact string match, `crossOrigin` only with an allowed `topOrigin`, RP ID hash in
constant time, user presence, user verification when required, BS only with BE, credential id equal to the raw
id, algorithm in the allowed list, then the attestation statement. For `x5c` the leaf key verifies the
signature and the certificate must meet §8.2.1 where no trust anchor is needed: version 3, the subject OU
"Authenticator Attestation", basic constraints with CA false, and the AAGUID extension matching when present.
Other formats are refused with a named error.

**Authentication (§7.2):** the allowed credential list, credential id, user handle rules for identified and
discoverable flows, client data and flags as above, no attested credential data, the backup eligibility flag
unchanged since registration, the signature over the authenticator data and the SHA-256 of the client data, and
the counter rule: when either counter is nonzero, a counter that does not increase yields
`Error::PossibleClone { stored, received }`, which the caller can act on (refuse, flag the credential, or log).

## Evidence

- **Specification vectors:** `conformance/webauthn/vectors.txt` holds the "Test Vectors" appendix of WebAuthn
  Level 3. The `none` and `packed` cases with ES256, RS256 and EdDSA pass; ES384, ES512, Ed448, `tpm`,
  `android-key`, `apple` and `fido-u2f` are refused with their named errors.
- **The TypeScript server's passkeys:** every passkey of the `canopy_auth` fixture
  (`conformance/auth/documents/`) authenticates with an assertion signed by its recorded authenticator key, and
  every registration and authentication request of `conformance/http/auth/cases/passkeys.json` verifies or is
  refused at the ceremony level as TypeScript answered it.
- **Negative tests:** each check above has a test proving it refuses (`tests/ceremonies.rs`).
- **Parsers:** `proptest` round trips and malformed input tests for CBOR and COSE (`tests/parsers.rs`).
- **Totals:** 39 tests pass; clippy with warnings denied is clean; `cargo deny check licenses` passes. The
  library holds no `unsafe`, `unwrap`, `expect` or panicking indexing.
- **Fuzzing:** six `cargo fuzz` targets (`webauthn_cbor`, `webauthn_cose_key`, `webauthn_authenticator_data`,
  `webauthn_client_data`, `webauthn_registration`, `webauthn_authentication`) with a dictionary build in the
  fuzz workspace and join the nightly fuzz matrix. They have not run for a meaningful time yet: cargo fuzz
  needs the nightly toolchain and libFuzzer, which the development machine (Windows) did not run. The R5 exit
  gate asks for 24 CPU hours per auth target with no finding.

## Decisions

- **Own CBOR decoder.** `ciborium` and `coset` are permissive, but a decoder of only what WebAuthn needs is
  small enough to review and lets the strictness rules (no indefinite lengths, no duplicate keys, no trailing
  bytes) live in one place.
- **Attestation scope:** `none` and `packed` only. Browsers replace the statement with `none` when no
  attestation is requested, which is how Canopy registers passkeys today. Other formats are added only when a
  user reports an authenticator that needs one (plan 005 open question O8).
- **No trust anchor evaluation** for `x5c`: Canopy does not ship an attestation root store, so the chain's
  signature and certificate requirements are checked but not its root.
- **Counter:** a possible clone is an error with both counters, so the auth layer decides the policy.
- **Ownership when the user is known:** with an identified user, the caller must load the credential by that
  user; the relying party checks the user handle when the stored credential has one.

## Remaining for R5

- Wire the ceremonies into `/auth/v1` (`canopy-authn`): challenge storage and expiry, the passkey documents in
  `canopy_auth` in the shape the fixture records, the counter and backup state written after each assertion.
- Run the fuzz targets for the gate's 24 CPU hours each in nightly.
- The external review, before the release that enables Rust auth.

## Review checklist

An external reviewer should check:

1. Every byte of client data, authenticator data and attestation objects is bounds checked before use
   (CBOR lengths, credential id length, extension parsing, DER lengths).
2. Challenge and RP ID hash comparisons are constant time, and origin matching is exact with no prefix or
   host only comparison.
3. The signed message is exactly authenticator data followed by the SHA-256 of the client data JSON bytes as
   received, not a re-serialization.
4. ES256 accepts only canonical DER, RSA keys below 2,048 bits are refused, and the COSE `alg` must agree with
   the key type and curve.
5. `packed` `x5c` statements cannot pass with a certificate that violates §8.2.1, and self attestation uses the
   credential key with the credential's algorithm.
6. The counter rule and the backup flags behave as §6.1.1 and §6.1.3 describe.
7. No input can panic, allocate without bound or recurse without a depth limit (the fuzz targets and the
   parser property tests are the starting point).
