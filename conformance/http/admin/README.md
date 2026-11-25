# Admin HTTP oracle

Run `bun run vectors:http-admin --uri <replica-set-uri>` to capture the TypeScript responses. Add `--check` to compare the complete capture with the checked in files. The recorder also accepts `CANOPY_TEST_MONGODB_URI` and `--dir`. Use a test replica set.

Each role starts with its own scratch application, meta and auth databases. Run the steps in file order. Each step has a request, a status, headers, separate Set-Cookie values in order when present, and a response body as text. State contains the documents written or removed since the previous step, as canonical Extended JSON text with the substitutions below. The first step includes the setup token digest, the initial webhook schedule and two failed deliveries seeded by the fixture. The application begins with a fixture document in `notes`, with `_id` equal to `seed`, title `Seed note` and secret `fixture private field`.

The route matrix exercises owner, admin, developer and viewer in development, using the real session issuer, policy store, data handlers and MongoDB transaction path. The auth oracle owns the app user routes under `/admin/v1/users`. Admin signing key endpoints remain in this oracle. Realtime captures the initial SSE frame, with change event and trace payloads captured separately through the inspector. The webhook workers are stopped before the first request so queue operations cannot send network requests or race the metadata snapshots.

The recorder controls the JavaScript clock and advances it a fixed amount per step. Its epoch is a minute boundary shortly ahead of the MongoDB wall clock so TTL processing does not remove live fixtures. It uses the real cryptographic generators, with these substitutions applied after execution.

- `<database>` and `<meta>` identify the scratch namespaces.
- `<time+N>` is a timestamp offset in milliseconds from the fixture epoch. `<totp-step+N>` is an offset in 30 second steps.
- `<mongo-wall-time>` is the server timestamp reported with a change stream event. `<positive-lag-ms>` is a positive measured lag in milliseconds. Zero lag remains literal.
- `<setup-token>`, `<setup-token-hash>`, `<totp-code:…>`, `<cookie-session:…>`, and the placeholders named for response fields such as `<token:…>`, `<csrfToken:…>`, `<password:…>`, `<secret:…>` and `<key:…>` stand for fixture credentials. A suffix identifies the originating step or TOTP use.
- `<id:N>`, `<object-id:N>`, `<uuid:N>`, `<kid:N>` and `<digest-id:N>` identify generated IDs, signing keys and session digests. `<stored-secret:N>` and `<prefix:N>` identify protected values and generated credential prefixes. Numbering is local to one role capture and preserves repeated references.
- `<ct>` stands for a nonzero MongoDB cluster time. `<version>` stands for the MongoDB build version reported by doctor. `<storage-bytes>` stands for physical collection and index allocations.
