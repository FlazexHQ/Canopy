# Authoring conformance


## Policy set documents

[Policy set schema](policy-set.schema.json) defines format version `1`. A set has a `collections`
array and a `contexts` document keyed by lookup name. Each collection carries its name, resolved
`exposed` and `realtime` flags, policies in declaration order, optional field rules and optional
immutable paths. The builders assign names to unnamed policies. Each policy has a name, a kind,
operations, roles, and optional `using` and `check` filters. Field rules are keyed by operation kind
(`read`, `write`, `update`) and then by role or `default`. Each rule supplies exactly one of `only`
and `omit`. An omitted field rule differs from an empty `only` list.

Filters and lookup queries use canonical Extended JSON objects. Claim references use
`{"$auth":"profile.id","as":"objectId"}`, with optional coercion. Context references use
`{"$ctx":"projectIds"}`. Request time uses `{"$now":{}}` and accepts an optional ISO 8601
`offset`. Context lookups specify `from`, `where`, `select`, `max` and `ttl`. Their `where` clause
can reference claims. The policy validator checks supported operators, placement and resolution
of variables, supported BSON values, operation compatibility, uniqueness and limits.

Publishing uses the collection name as `_id` and encodes `using` and `check` as the canonical
Extended JSON strings stored in `canopy.policies`. It stores decoded contexts as the `lookups`
field of the `_context` document. Preserve filter field order when parsing and reserializing to
retain the existing hashes. Revisions, hashes and audit metadata are assigned by publishing and
are absent from the bundle.

## Policy test case documents

[Policy test case schema](policy-test.schema.json) defines one version `1` case. It carries a
suite name, collection, actor, `action` and expected allow or deny outcome as a boolean.
The actor has a label, roles, claims or `null`, and optional precomputed context values. Supply either
`doc` or `filter`. Inserts require `doc`, updates require an `update` document, and allowed reads may
assert visible and hidden paths with `withFields` and `withoutFields`. Documents, filters, updates,
claims and actor context values use canonical Extended JSON.

The existing helpers produce concrete document cases. The filter form is represented in the
schema and by a hand authored vector that uses the actor builder. The existing runner can replay
concrete documents. A filter case runs only against MongoDB (decided 2026-11-26): it passes when
every document the filter matches gives the expected outcome. A filter that matches no documents
fails with "matched no documents", and a mixed match fails and names the documents that disagree.
Without MongoDB the case is reported as not run, never as passed.

### Functions and diagnostics

Policy builder methods and typed kits run during authoring and reduce to definitions. The
`describePolicies` body runs during authoring to collect expectations. The emitted case can carry
built in field checks as data. Callbacks that would run during policy evaluation, custom
assertions, engine hooks, context readers and custom test backends have no field in these
documents. Function or accessor values that survive authoring are rejected before serialization.
The maintainer should confirm the distinction between the existing suite declaration callback
and prohibited custom assertions when closing O5.

The [policy vectors](policy/vectors.json) capture the installed Canopy.js builders, with 15 policy
sets, 15 concrete test cases, one filter case and seven refusals. The policy sets cover the DSL
constructs and the policies in `deploy/dev`, the examples and `sdk-e2e`. Invalid inputs use
`CANOPY_INVALID_QUERY` and RFC 6901 JSON Pointers. The R0 fixture adapter provides the paths
for schema and serialization failures. The current TypeScript semantic validator has its own
diagnostics. R3 must match the recorded codes and paths.

Run `bun run vectors:authoring-policy --check` to replay the capture, or omit `--check` to
regenerate it. Ajv 8.20.0 (MIT), already resolved in the workspace, is an explicit development
dependency of `@canopy/policy` so the recorder can compile and check the draft 2020-12 schemas
under isolated installs. The replay compares stored policy documents and bundle hashes with
the existing publishing helpers and evaluates the decoded concrete test cases in memory.

## Unresolved config

[config.schema.json](config.schema.json) describes a version 1 document with a `config` object.
Omitted settings stay omitted so resolution can apply defaults, environment overlays and command
specific requirements. A config function is evaluated once for the requested mode and command.
The caller supplies that context separately. The function matrix covers both modes and all seven
commands recognized by the TypeScript loader.

An environment reference is an object with a single `$env` key. Its payload contains `name`,
`type`, `secret`, `optional` and, when declared, `default`. The type identifies the reader that
created the marker. Resolution still checks the destination setting using its own accepted type.
Secret references and optional references omit the default. The recorder emits before supplying
environment values to the resolver. The canary checks the synthetic secret reaches the resolved
setting and is absent from both the unresolved document and the source display.

JWKS documents, webhook filters and webhook bodies use a `$ejson` envelope. The payload uses
canonical Extended JSON for BSON values. In a plain document with a key starting with `$`, the
encoder wraps its fields in `$literal` so literal fields and query operators survive independently
of BSON wrapper syntax. The escape applies recursively. An ordinary config value uses JSON.

Built in auth's `claims` setting takes an HTTPS `url` and a required `secret` environment
reference. The TypeScript resolver still expects a function at this setting. Its refusal is
captured for the HTTPS fixture, and the SDK auth fixture records the emission refusal for the
old callback. Emission diagnostics use `CANOPY_CONFIG_INVALID` and JSON Pointers, including
array indices and escaped field names. Resolution diagnostics also include the original dotted
path from the TypeScript resolver.

The [config vectors](config/vectors.json) capture deploy/dev, the example projects, SDK fixtures,
synthetic config inputs and resolution errors. Embedded examples and SDK fixtures with direct
realtime constructors use equivalent config settings. Their injected clients, policies and
write paths live outside config. The recorder extracts the actual `defineConfig` expressions
when a project uses that builder and supplies deterministic values for its surrounding bindings.
The resolver uses `/project/canopy.config.ts`, base directory `/project`, and working directory
`/working`. Fixture `envText` is parsed as `/project/.env.local`, and `environment` takes
precedence. Values and keys used in the vectors are synthetic. Successful oracles include the
resolved settings, source map, secret paths and exact `config print --sources` text.

## Collection schema

[collection-schema.schema.json](collection-schema.schema.json) describes a version 1 document
with a `collections` list ordered by name. Each entry carries the existing `CollectionSchema`
name, source and recursive object shape, with the sample count when available. Object shapes
preserve field requiredness and openness. A nullable field is a union with the BSON null
scalar. String literals use the shape's `values` list. The scalar vocabulary matches
[schema inference](../schema/schema.json) and [type generation](../typegen/generate.json).
Client insert defaults, generators and validators remain in the schema definition. The
canonical document describes stored document shapes.

The [schema vectors](schema/vectors.json) exercise the installed builders with declared shapes,
defaults, generators, optional fields, nullable types and unions. They preserve the TypeScript
builder's error messages. The proposed canonical diagnostics use `CANOPY_SCHEMA_INVALID`
and JSON Pointers. The pull fixture records the inferred and validator shapes, generated
editable source and the document from evaluating that source through the builders. This
captures the distinction between the pulled shape's provenance and a subsequent import of
its editable definition. The type generation fixture also covers BSON shapes beyond the
current field builders.

Run `bun run vectors:authoring-config` to write both sets and
`bun run vectors:authoring-config --check` to verify them. Both owning packages replay their
vectors under Vitest. Ajv 8, already in the lockfile under the MIT license, is an explicit
development dependency of both packages so each replay validates draft 2020-12 documents.
