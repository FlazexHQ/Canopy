import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { deserialize, EJSON, serialize } from "bson"

const root = new URL("../../../", import.meta.url)
const vectors = async (name) =>
  JSON.parse(await readFile(new URL(`conformance/${name}.json`, root), "utf8"))
const generated = (module, suffix) =>
  new URL(`packages/wasm/generated/${module}/canopy_${module}${suffix}`, root)
const bson = (text) => Buffer.from(text, "base64")
const decode = (bytes) => deserialize(bytes, { promoteValues: false, bsonRegExp: true })
const isUnsupported = (error) =>
  error.code === "CANOPY_INVALID_QUERY" && error.message.startsWith("UnsupportedQueryError:")

function schemaBson(value) {
  const fields = Object.entries(value).map(([name, item]) => {
    const key = Buffer.from(`${name}\0`)
    if (item !== null && typeof item === "object") {
      if (item.$undefined === true) return Buffer.concat([Buffer.from([6]), key])
      if (item.$dbPointer !== undefined) {
        const { $ref, $id } = item.$dbPointer
        const namespace = Buffer.from(`${$ref}\0`)
        const size = Buffer.alloc(4)
        size.writeInt32LE(namespace.length)
        return Buffer.concat([
          Buffer.from([12]),
          key,
          size,
          namespace,
          Buffer.from($id.$oid, "hex"),
        ])
      }
      if (!Object.keys(item).some((name) => name.startsWith("$"))) {
        return Buffer.concat([Buffer.from([Array.isArray(item) ? 4 : 3]), key, schemaBson(item)])
      }
    }
    return serialize({ [name]: EJSON.deserialize(item, { relaxed: false }) }).subarray(4, -1)
  })
  const size = Buffer.alloc(4)
  size.writeInt32LE(5 + fields.reduce((total, field) => total + field.length, 0))
  return Buffer.concat([size, ...fields, Buffer.from([0])])
}

async function replay(client, authoring) {
  assert.equal(client.PolicyEngine, undefined)
  assert.equal(authoring.DocumentPage, undefined)
  assert.equal(authoring.Filter, undefined)
  const counts = { filters: 0, unsupportedFilters: 0, updates: 0, unsupportedUpdates: 0 }
  const match = await vectors("matcher/filters")
  const matchPage = client.DocumentPage.fromBson(Buffer.concat(match.documents.map(bson)))
  try {
    for (const [index, item] of match.cases.entries()) {
      if (item.error !== undefined) {
        assert.throws(() => client.Filter.fromBson(bson(item.filter)))
        continue
      }
      let filter
      try {
        filter = client.Filter.fromBson(bson(item.filter))
      } catch (error) {
        if (!isUnsupported(error)) throw error
        counts.unsupportedFilters++
        continue
      }
      try {
        const expected = Buffer.from(item.matches, "hex")
        const actual = matchPage.matchFilter(filter)
        assert.equal(actual.length, match.documents.length)
        for (const [position, decision] of actual.entries()) {
          assert.equal(
            decision,
            (expected[position >> 3] >> (position & 7)) & 1,
            `filter ${index}, document ${position}`,
          )
        }
        counts.filters++
      } finally {
        filter.free()
      }
    }
  } finally {
    matchPage.free()
  }
  assert.ok(counts.filters > 1000)

  for (const [kind, spec, expectedKey] of [
    ["sorts", "sort", "order"],
    ["projections", "projection", "documents"],
  ]) {
    const fixture = await vectors(`matcher/${kind}`)
    const pageBytes = Buffer.concat(fixture.documents.map(bson))
    for (const [index, item] of fixture.cases.entries()) {
      const page = client.DocumentPage.fromBson(pageBytes)
      try {
        const text = client.bsonToEjson(bson(item[spec]), true)
        const apply = () => (spec === "sort" ? page.sort(text) : page.project(text))
        if (item.error !== undefined) {
          assert.throws(apply)
          assert.deepEqual(Buffer.from(page.bson()), pageBytes)
          continue
        }
        apply()
        const expected = item[expectedKey].map((entry) =>
          bson(spec === "sort" ? fixture.documents[entry] : entry),
        )
        assert.deepEqual(Buffer.from(page.bson()), Buffer.concat(expected), `${kind} ${index}`)
      } finally {
        page.free()
      }
    }
  }

  const updates = await vectors("matcher/updates")
  for (const [index, item] of updates.cases.entries()) {
    const original = bson(updates.documents[item.document])
    const page = client.DocumentPage.fromBson(original)
    const arrayFilters = item.arrayFilters
      ? decode(bson(item.arrayFilters)).list.map((filter) => serialize(filter))
      : []
    try {
      try {
        page.applyBsonUpdate(bson(item.update), Buffer.concat(arrayFilters), false)
      } catch (error) {
        assert.deepEqual(Buffer.from(page.bson()), original)
        if (isUnsupported(error)) {
          counts.unsupportedUpdates++
          continue
        }
        if (item.error === undefined) throw error
        counts.updates++
        continue
      }
      assert.ok(item.result, `update ${index} should refuse`)
      assert.deepEqual(Buffer.from(page.bson()), bson(item.result), `update ${index}`)
      counts.updates++
    } finally {
      page.free()
    }
  }
  assert.ok(counts.updates > 1000)
  assert.ok(counts.unsupportedUpdates < 100)
  const batch = Buffer.concat([
    client.ejsonToBson('{"_id":1,"n":1}'),
    client.ejsonToBson('{"_id":2,"n":"text"}'),
  ])
  const atomic = client.DocumentPage.fromBson(batch)
  try {
    assert.throws(() => atomic.applyUpdate('{"$inc":{"n":1}}', "[]", false))
    assert.deepEqual(Buffer.from(atomic.bson()), batch)
    atomic.applyUpdate('{"$set":{"n":3}}', "[]", false)
    assert.deepEqual(
      Buffer.from(atomic.bson()),
      Buffer.concat([client.ejsonToBson('{"_id":1,"n":3}'), client.ejsonToBson('{"_id":2,"n":3}')]),
    )
  } finally {
    atomic.free()
  }

  const policy = await vectors("policy/policy")
  for (const item of policy.cases.filter((item) => item.kind === "set")) {
    const create = () => new authoring.PolicyEngine(item.collections, item.contexts)
    if (item.error !== undefined) {
      assert.throws(create, { code: item.code, message: `${item.name}: ${item.error}` })
    } else {
      const engine = create()
      try {
        assert.equal(engine.version, item.result.version)
        for (const [index, request] of item.requests.entries()) {
          for (const collection of item.result.results[index].collections) {
            for (const operation of collection.ops) {
              const name = collection.collection
              assert.equal(engine.hasGrant(name, operation.op, request), operation.grant)
              const using = engine.using(name, operation.op, request)
              assert.equal(using.filter ?? using.kind, operation.using)
              if (operation.check !== undefined) {
                const check = engine.check(name, operation.op, request)
                assert.equal(check.filter ?? check.kind, operation.check)
              }
            }
          }
        }
      } finally {
        engine.free()
      }
    }
  }

  const query = await vectors("query/query")
  for (const { input, result, error, code } of query.cases.filter(
    (item) => item.kind === "query",
  )) {
    const canonicalize = () => authoring.canonicalizeQuery("notes", input)
    if (error !== undefined) {
      assert.throws(canonicalize, { code })
      continue
    }
    assert.equal(canonicalize(), result.canonical)
    const parsed = JSON.parse(result.canonical)
    const key = {
      collection: parsed.c,
      filter: JSON.stringify(parsed.f),
      sort: result.sort ?? undefined,
      limit: result.limit ?? undefined,
      projection: result.projection?.projection,
    }
    assert.equal(authoring.canonicalQuery(key), result.canonical)
    assert.equal(authoring.queryHash(key), result.hash)
  }

  const schema = await vectors("schema/schema")
  for (const { name, docs, options, expected } of schema.inference) {
    const bytes = Buffer.concat(docs.map(schemaBson))
    assert.deepEqual(
      JSON.parse(
        authoring.inferSchema(
          name,
          bytes,
          Boolean(options.enums),
          options.enums?.maxValues,
          options.enums?.minSamples,
        ),
      ),
      expected,
      name,
    )
  }
  for (const { schema: validator, expected } of schema.validators) {
    assert.deepEqual(JSON.parse(authoring.shapeFromJsonSchema(JSON.stringify(validator))), expected)
  }
  for (const { shape, access, mode, expected } of schema.restrictions) {
    assert.deepEqual(
      JSON.parse(
        authoring.restrictSchema(JSON.stringify(shape), access.kind, access.paths ?? [], mode),
      ),
      expected,
    )
  }

  const { sets } = await vectors("authoring/policy/vectors")
  const published = await vectors("authoring/policy/publishing")
  for (const { name, document } of sets) {
    const expected = published.find((entry) => entry.name === name)
    assert.ok(expected, name)
    const input = JSON.stringify(document)
    assert.equal(authoring.validatePolicySet(input), expected.bundleHash, name)
    const engine = authoring.PolicyEngine.fromCanonical(input)
    try {
      assert.equal(engine.version, expected.bundleHash, name)
    } finally {
      engine.free()
    }
  }

  const protocol = await vectors("protocol/07-typed-values")
  const documents = protocol.steps
    .flatMap((step) => step.server ?? [])
    .flatMap((frame) => (frame.d ? [frame.d] : []))
  assert.ok(documents.length > 0)
  for (const document of documents) {
    const text = JSON.stringify(document)
    const canonical = EJSON.serialize(EJSON.deserialize(document, { relaxed: false }), {
      relaxed: false,
    })
    assert.deepEqual(JSON.parse(client.bsonToEjson(client.ejsonToBson(text), true)), canonical)
    assert.deepEqual(JSON.parse(client.canonicalEjson(text)), canonical)
  }
  process.stdout.write(`${JSON.stringify(counts)}\n`)
}

for (const mode of ["wasm", "js"]) {
  const wasm = globalThis.WebAssembly
  try {
    if (mode === "js") globalThis.WebAssembly = undefined
    const suffix = mode === "wasm" ? ".js" : "_js.js"
    const client = await import(generated("client", suffix))
    const authoring = await import(generated("authoring", suffix))
    if (mode === "wasm") {
      for (const [name, binding] of [
        ["client", client],
        ["authoring", authoring],
      ]) {
        binding.initSync({ module: await readFile(generated(name, "_bg.wasm")) })
      }
    }
    await replay(client, authoring)
    process.stdout.write(`${mode} conformance passed\n`)
  } finally {
    globalThis.WebAssembly = wasm
  }
}
