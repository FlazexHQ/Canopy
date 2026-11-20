# Plan 003 SDK verification

## Criteria

| Criterion | Status | Evidence |
| --- | --- | --- |
| Schema definitions, generated IDs, defaults and CLI schema operations | Implemented and covered | [Schema tests](../../packages/schema/test/), [CLI tests](../../packages/cli/test/), [schema guide](../../apps/docs/src/content/docs/guides/schema.md) |
| Collection writes, read-only queries, projections and framework inference | Implemented and covered | [Breaking cut](https://github.com/FlazexHQ/Canopy/commit/0c08fd3), [client type tests](../../packages/client/test/types.test.ts), [API declaration](../../api/client.api.md) |
| REST pages, continuation, by ID, count, BSON, errors and cancellation | Verified | [Client unit tests](../../packages/client/test/rest.test.ts), [composed server tests](../../packages/client/test/rest.e2e.test.ts), [Chromium test](../../examples/todo-react/e2e/rest.spec.ts) |
| Distinct, aggregation and optional HTTP writes | Implemented and covered | [Read tests](../../packages/client/test/rest.e2e.test.ts), [write tests](../../packages/client/test/rest-writes.e2e.test.ts) |
| Local packed installs and declarations | Verified, four package managers | [Packed fixture](../../packages/testing/scripts/install-test.ts#L461), [local results](#local-results) |
| Clone based JavaScript and TypeScript guides | Verified, both sign in, subscribe, insert and fetch a REST page | [Runnable guide](../../apps/docs/src/content/docs/guides/client.md#run-from-a-clone), [local results](#local-results) |
| O4 timed exercise | Complete by maintainer confirmation | [Exercise record, including missing participant notes](o4-exercise.md) |
| REST participant exercise | Pending participant evidence | [Exercise record](o4-exercise.md#separate-rest-exercise) |
| Equivalent two user REST pagination check | Verified separately | [Composed server test](../../packages/client/test/rest.e2e.test.ts), [local results](#local-results) |
| Public registry install in a clean app | Pending publication | Re-run the quickstart against the published package names and versions once available. |
| MongoDB minimum, replica set, sharding and Search | 8.0 minimum enforced. Topology and Search checks verified independently. | [Minimum version change](https://github.com/FlazexHQ/Canopy/commit/36ae827ac6448f38ecd9835b96d2dbc10a9379ff), [CI evidence](#ci-evidence) |
| Native read codec | Decision recorded. REST and GraphQL use the TypeScript codec. | [Phase 5 measurements and decision](../../docs/plan/14-native-core.md#8-stages-and-gates) |
| Inbound MongoDB wire endpoint | Independent S13 gate. No go for production on the current evidence. | [Driver, DLS and cost results](../../docs/spikes/S13-inbound-wire.md) |

## Local results

Tests ran on Windows x64 with the branch at
`4abe9868962f32eed29a8e05a44a0aa3343a3c22` plus the closeout guide and two user fixture changes.

- `bun packages/testing/scripts/install-test.ts --build` packed 25 workspace packages and two
  optional packages into a temporary local registry. Bun 1.4.4, pnpm 10.34.9, Yarn 4.18.1 and npm
  11.20.0 each installed a clean consumer, imported all 41 public entries, including
  `@canopy/schema/define` and `@canopy/client/rest`, compiled the packed declarations under
  `bundler` and `nodenext`, and verified the WebAssembly fallback.
- The [client guide](../../apps/docs/src/content/docs/guides/client.md#run-from-a-clone) ran from a
  fresh clone after `bun install --frozen-lockfile` and `bun run build`. The exact guide block
  compiled in `.mjs` with `checkJs` and in `.ts` with TypeScript 6.0.3 and `strict` enabled.
  Node 24.22.1 ran both files against the auth-notes server with an isolated MongoDB 8.0.34 replica
  set started by the documented binary helper on port 37153. Each run logged `live ready []`,
  the live result containing `Buy milk`, and `REST page [ 'Buy milk' ]`.
- The REST unit and composed server suites passed all 27 tests on each of Bun 1.4.4, Node 24.22.1,
  Node 26.12.1 and Deno 2.9.8 against that replica set. All six integration cases executed in each
  run. The new two user check used separate signed tokens, asserted both first and continuation
  pages, and checked that each user received only their own documents.

## CI evidence

The CI run at `acab6e344b078794da142aa01083cd3d0cc8ae19` predates the sharded acknowledgement fix.
Nightly reran the relevant extended jobs at `4abe9868962f32eed29a8e05a44a0aa3343a3c22`.
The job logs identify executed files and test counts. The CI reader fixtures predate the closeout's
second cursor assertion, which was run locally as described above.

| Check | Tested revision | Environment and result |
| --- | --- | --- |
| Bun and Node 24 REST reader, database-backed | `4abe986` | Linux arm64, MongoDB 8.0.34 replica set. 21 reader unit tests and six composed server tests passed on each runtime. [Nightly job](https://github.com/FlazexHQ/Canopy/actions/runs/44760510701/job/136371482627) |
| Node 26 REST reader | `acab6e3` | Linux Node 26. 21 unit tests passed. The database suite in this matrix job was skipped. The local Node 26 run exercised all six database cases. [CI job](https://github.com/FlazexHQ/Canopy/actions/runs/44682031582/job/136107554558) |
| Deno REST reader, database-backed | `4abe986` | Ubuntu 22.04, Deno 2 with the thread pool, MongoDB 8.0.34. 21 reader unit tests and six composed server tests passed. [Nightly job](https://github.com/FlazexHQ/Canopy/actions/runs/44760510701/job/136371482733) |
| Chromium REST reader | `4abe986` | Windows 2025, Playwright Chromium against the todo-react server and MongoDB 8.0.34. The private page, cursor, count, typed error and no socket test passed. [Nightly job](https://github.com/FlazexHQ/Canopy/actions/runs/44760510701/job/136371482745) |
| MongoDB 8.0 replica set | `acab6e3` | Ubuntu 22.04, MongoDB 8.0.34 `rs0`. The replica set smoke passed on both matrix legs, which ran 215 test files on Bun and 214 on Node, including six composed REST reader cases on each. [Bun job](https://github.com/FlazexHQ/Canopy/actions/runs/44682031582/job/136107554656) · [Node job](https://github.com/FlazexHQ/Canopy/actions/runs/44682031582/job/136107554846) |
| MongoDB 8.0 sharded cluster | `4abe986` | Linux, Node 24 and two shards behind `mongos`. All four integration cases passed, including snapshot, resume and acknowledgements on both shards. [Isolated regression](https://github.com/FlazexHQ/Canopy/actions/runs/44693372961/job/136144261532) · [Nightly job](https://github.com/FlazexHQ/Canopy/actions/runs/44760510701/job/136371482797) |
| Search with ready indexes | `4abe986` | Linux, Node 24 and MongoDB Atlas Local 8.0.21 with `mongot`. All three indexed Search tests passed. [Nightly job](https://github.com/FlazexHQ/Canopy/actions/runs/44760510701/job/136371482231) |
