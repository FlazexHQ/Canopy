# Canopy MongoDB wire endpoint

## Wire compression

The endpoint negotiates `snappy`, `zlib` and `zstd` on `hello` or `isMaster`. The response lists
the supported compressors in the client's order. With no offer on the initial handshake, the connection
uses uncompressed messages. A compressed request receives a reply using the same compressor. Handshake
and authentication commands always use uncompressed frames.

The endpoint closes the connection on a malformed compressed frame, an unnegotiated compressor, a
compressed handshake or authentication command, or a decompressed size mismatch. The configured
`maxMessageBytes` applies to both the compressed frame and the reconstructed message, including its
header. The Zstandard decoding window is also bounded by that limit.

The wire endpoint uses `snap` for raw Snappy, `flate2` with its Rust backend for zlib, and `ruzstd`
for Zstandard. These codecs implement the MongoDB formats without native compression libraries.

## Writes

Configure both `Session::with_read_path` and `Session::with_write_path` for the same application database and policy source. The read path resolves the authenticated principal's policy context. The write path applies its grants, document policies, field rules and limits. Each write statement runs in a majority acknowledged transaction. For ordered batches the first write error stops execution. Unordered batches continue, and earlier successful statements in either batch stay committed.

Retryable writes use the client session UUID, transaction number and statement ID to replay committed outcomes for the original caller within the mutation history TTL. A retry returns the original counts and upserted IDs. For `findAndModify`, it also returns the original projected image when the policy version and caller authorization context still match. Client transactions receive IllegalOperation (20) without retry labels.

The endpoint accepts the default write concern, `w: 1`, or `w: "majority"`, and always commits with majority write concern. It refuses `w: 0`, custom journaling and nonzero write concern timeouts. A fire and forget OP_MSG receives no reply and performs no write. The Data API also refuses pipeline updates, and the wire endpoint refuses `arrayFilters` and custom `collation`. Use a regular filter and update document. Unsupported command options receive BadValue (2).

Policy denials map to Unauthorized (13) without retry labels. DuplicateKey (11000) uses the Data API's sanitized error message. The write path discards raw duplicate key details. DocumentValidationFailure (121) reports collection validator failures. Canopy conflicts are not advertised as retryable WriteConflict errors.

For `findAndModify`, filters and sort may reference readable fields. The requested projection is applied to the policy filtered preimage or postimage inside the same transaction. A document the caller cannot read produces a null image.
