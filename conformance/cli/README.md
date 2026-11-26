# TypeScript CLI oracle

The fixture starts with one document in the `notes` collection. The recorder copies the project to a
temporary directory and creates isolated app, meta and auth databases. It drops those databases and
removes the temporary copy when finished. The remote commands use the real TypeScript admin API on a
loopback listener with a fixture admin session. Server startup, disabling sampled request logs and
session setup for that listener form the baseline before those commands run. The login and logout
cases stop before any keychain access.

Each step in `vectors.json` includes the working directory relative to the project, arguments, CLI
environment overrides, piped stdin, stdout, stderr, exit code and file changes. MongoDB changes are
shown as before and after documents with BSON types preserved in canonical Extended JSON. A null side
means the file or document was absent. The `fileInput` entry applies the local policy edit before the
corresponding step. Competing policy versions, noninteractive confirmation, unavailable MongoDB,
missing config, an invalid policy definition and invocation errors are captured alongside success cases.

The CLI starts as a subprocess with noninteractive stdio, `NODE_NO_WARNINGS=1` and `SystemRoot` on Windows.
For the successful `dev` case, the recorder calls the same dispatcher with an abort signal and stops as
soon as the startup banner is complete. The TypeScript CLI has no command that dispatches type
generation. The `typeGeneration` entry calls the public schema generator using the fixture collection
after `schema push`. JSON escapes preserve the original punctuation of captured CLI text.

## Substitutions

- `<project>` and `<config-loader>` replace absolute paths and config module URLs. Paths use forward
  slashes and text uses LF. `<mongo-uri>`, `<app-db>`, `<meta-db>` and `<auth-db>` name the
  replica set and isolated databases. `<admin-url>` identifies the local admin listener.
- `<port>`, `<version>` and `<fcv>` cover the dynamically assigned port and MongoDB server
  diagnostics. The CLI version stays literal. `<time>` and `<time-ms>` cover UTC timestamps and dates
  encoded as Extended JSON milliseconds.
- `<user>` is the local OS username in the CLI actor. Numbered `<admin-id:n>`, `<object-id:n>`
  and `<uuid:n>` placeholders track generated identifiers and request IDs in order of first use.
- The `<key-id>`, `<key>`, `<key-prefix>`, `<key-hash>`, `<admin-token-id>`,
  `<admin-token>`, `<admin-token-prefix>`, `<admin-token-hash>`, `<session-token>`,
  `<session-token-hash>`, `<temporary-password>`, `<password-hash>`, `<setup-token>`,
  `<setup-token-hash>` and `<dev-key:n>` placeholders cover generated credentials. The SCRAM salt and
  derived keys are `<scram-value>`. Policy hashes remain literal.
- Bun sends a `Bun/<version>` user agent and Node 26 sends `node` on the loopback requests. The
  resulting audit entries use `<runtime-user-agent>`. Windows uses backslash path separators in
  several diagnostics and config values. POSIX uses forward slashes. The stored paths use forward
  slashes on both.

## Replay

```text
bun run vectors:cli --uri mongodb://localhost:37017/?replicaSet=rs0
bun run vectors:cli --check --uri mongodb://localhost:37090/?replicaSet=rs0
fnm exec --using=26 -- node --conditions=@canopy/source packages/testing/scripts/cli-vectors.ts --check --uri mongodb://localhost:37090/?replicaSet=rs0
```

The CLI Vitest project runs the same check when `CANOPY_TEST_MONGODB_URI` is set.

## Rust replay

`crates/canopy-cli` replays these steps against the Rust `canopy` binary:

- `tests/vectors.rs`: the steps without MongoDB (help, version, refusals, the admin API commands).
- `tests/meta_vectors.rs`: migrations, keys, admins, realtime images and user import, without a config file.
- `tests/policy_vectors.rs`: the project steps (config, policies, init, doctor, schema, pull, indexes and
  dev) with the fixture loaded through the real `canopy.js/emit`. The copy of the fixture moves its imports of
  `@canopy/policy`, `@canopy/policy/testing` and `@canopy/schema/define` to `canopy.js/policy`,
  `canopy.js/policy/testing` and `canopy.js/schema`, and links `node_modules/canopy.js` to the Canopy.js build
  (`CANOPY_JS_DIR`, else the repository's installed `node_modules/canopy.js`). After `schema-push` it also
  checks `canopy gen types` against `typeGeneration`.
- `tests/pull_vectors.rs`: `conformance/typegen/pull.json` against a database seeded from its fixture.

The Rust usage text has commands and options the TypeScript CLI lacks (`build`, `gen types`, `--bundle`,
`--check`). The help, no command and unknown command steps are compared after inserting exactly those lines
at fixed anchors (`USAGE_ADDITIONS` in `tests/vectors.rs`); the recorded vectors are not edited, and any other
difference fails.

```text
CANOPY_TEST_MONGODB_URI="mongodb://localhost:37017/?replicaSet=rs0" cargo test -j 2 -p canopy-cli
```
