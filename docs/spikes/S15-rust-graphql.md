# S15: Which Rust GraphQL library does the data plane build on?

- **Date:** 2026-11-24
- **Status:** done. **Go** for apollo-compiler with a Canopy executor; async-graphql is not taken.
- **Plan:** [004](../plans/004-rust-data-plane.md), stage D3 (spike S15 comes first)
- **Prototype:** [`bench/spikes/S15/`](../../bench/spikes/S15/src/main.rs)

## Question

Stage D3 moves the GraphQL endpoint (`packages/graphql`, graphql-js behind GraphQL Yoga and graphql-ws) into the
Rust data plane. Its gate asks for the existing GraphQL behavior unchanged and for nested queries that cost one
execution, not one internal request per resolver. Which Rust library gives:

- a schema built at run time from the policies and collections, rebuilt when they change;
- parsing, validation and introspection as GraphQL clients expect them;
- execution that turns a root field into one read or write of `canopy_data` and a relation level into one
  batched read, writing documents from BSON without a resolver per field;
- subscriptions over the graphql-ws protocol, fed by the realtime engine;
- the request limits of `packages/graphql/src/limits.ts` and persisted queries;
- a permissive license (MIT, Apache 2.0, BSD or ISC)?

## Method

The prototype builds the same small schema three ways (graphql-js `buildSchema`, async-graphql 7.2.1 with its
`dynamic-schema` feature, apollo-compiler 1.33.1 from SDL), sends eight invalid queries a recorded oracle would
hold (an unknown field, a wrong argument type, a syntax error, a missing required argument, a list without a
selection, a repeated operation name, an unknown argument, an unknown fragment type) and compares the messages. It
then times a list query of 100 documents with three fields: executed by async-graphql's dynamic schema, and
parsed and validated by apollo-compiler (the step an own executor would start from). Release builds on the
Windows development laptop.

## Results

| Query | graphql-js | async-graphql | apollo-compiler |
|---|---|---|---|
| `{ todos { nope } }` | Cannot query field "nope" on type "Todo". Did you mean "done"? | Unknown field "nope" on type "Todo". | type `Todo` does not have a field `nope` |
| `{ todos(limit: "x") { title } }` | Int cannot represent non-integer value: "x" | Invalid value for argument "limit", expected type "Int" | expected value of type Int, found a string |
| `{ todos { title }` | Syntax Error: Expected Name, found &lt;EOF&gt;. | a pest error with a caret diagram | syntax error: expected R_CURLY, got EOF |
| `{ todo { title } }` | Field "todo" argument "id" of type "ID!" is required, but it was not provided. | Field "todo" argument "id" of type "Query" is required but not provided | the required argument `Query.todo(id:)` is not provided |
| `{ todos }` | Field "todos" of type "[Todo!]!" must have a selection of subfields. | Field "todos" of type "Todo" must have a selection of subfields | interface, union and object types must have a subselection set |
| two operations named `A` | There can be only one operation named "A". | operation A is defined twice | the operation `A` is defined multiple times in the document |
| `{ todos(nope: 1) { title } }` | Unknown argument "nope" on field "Query.todos". | Unknown argument "nope" on field "todos" of type "Query". | the argument `nope` is not supported by `Query.todos` |
| fragment on `Missing` | Unknown type "Missing". | Unknown type "Missing" | two errors, the fragment and its type |

- **No library reproduces graphql-js's texts:** async-graphql matches one of eight, apollo-compiler none, and both
  agree with graphql-js on what is invalid. Byte for byte error texts would mean porting graphql-js's validation
  rules and their messages, which neither library helps with.
- **Execution cost:** async-graphql runs the 100 document list in 341 µs (one async resolver per field, 300 here),
  apollo-compiler parses and validates it in 13 µs. A Canopy executor walks the validated selection over documents
  already read in one command, as the REST routes write pages, so its cost is the read plus the encoding.
- **Features:** apollo-compiler builds a schema from SDL generated at run time, validates executable documents,
  and answers introspection (`apollo_compiler::introspection`). It has no executor and no transport, which is what
  the data plane wants to own anyway: root fields and relations become `canopy_data` reads and writes, live
  subscriptions come from the engine, the graphql-ws protocol is a few frame types over the WebSockets the gateway
  already serves. async-graphql brings its own HTTP and WebSocket integrations and depth and complexity limits,
  which would have to be bent to Canopy's limits and policies.
- **Footprint:** async-graphql pulls 104 crates (pest, multer, async-io and the derive stack), apollo-compiler 88;
  both are MIT or Apache 2.0.

## Decision

Build `canopy-graphql` on **apollo-compiler 1.x** (parsing, validation, introspection, the schema built as SDL
from the policies and collections) with a **Canopy executor** over `canopy_data`: one read or write per root
field, one batched `$in` read per relation level (the batching `packages/graphql` does with its loaders), the
limits of `packages/graphql/src/limits.ts` checked on the parsed document, persisted queries by their SHA-256,
subscriptions from the realtime engine over graphql-ws.

Consequence for the oracle `conformance/http/graphql/`: data, error codes (`extensions.code`), paths and
locations are compared exactly; the message of a parse or validation error is compared only for its kind,
because graphql-js's texts are not reproduced. Every other message (Canopy's own refusals, limits, policy
errors) is compared byte for byte.
