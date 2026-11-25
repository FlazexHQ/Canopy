# WebAuthn test vectors

`vectors.txt` holds the test vectors of the W3C Web Authentication Level 3 specification, appendix "Test
Vectors", copied without change: an attestation root certificate and registration ceremonies for the `none`,
`packed` (self and `x5c`), `tpm`, `android-key`, `apple` and `fido-u2f` formats over ES256, ES384, ES512, RS256,
EdDSA and Ed448 credentials, with cross origin and top origin variants. The specification is published under
the W3C Software and Document License, which permits copying with attribution.

`crates/canopy-webauthn/tests/spec_vectors.rs` replays them. Canopy's relying party accepts the `none` and
`packed` cases with ES256, RS256 and EdDSA credentials and must refuse the others with a named error: the
`tpm`, `android-key`, `apple` and `fido-u2f` formats are not supported, and ES384, ES512 and Ed448 credentials
are outside the accepted algorithms.
