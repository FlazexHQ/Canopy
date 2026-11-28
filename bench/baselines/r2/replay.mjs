const bytes = (parts) => {
  const output = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}
const utf8 = (text) => new TextEncoder().encode(text)
const int32 = (value) => {
  const output = new Uint8Array(4)
  new DataView(output.buffer).setInt32(0, value, true)
  return output
}
const isUnsupported = (error) =>
  error.code === "CANOPY_INVALID_QUERY" && error.message.startsWith("UnsupportedQueryError:")

function schemaBson(value, { Binary, EJSON, serialize }) {
  const fields = Object.entries(value).map(([name, item]) => {
    const key = utf8(`${name}\0`)
    if (item !== null && typeof item === "object") {
      if (item.$undefined === true) return bytes([Uint8Array.of(6), key])
      if (item.$dbPointer !== undefined) {
        const { $ref, $id } = item.$dbPointer
        const namespace = utf8(`${$ref}\0`)
        const size = int32(namespace.length)
        return bytes([
          Uint8Array.of(12),
          key,
          size,
          namespace,
          Binary.createFromHexString($id.$oid).value(),
        ])
      }
      if (!Object.keys(item).some((name) => name.startsWith("$"))) {
        return bytes([
          Uint8Array.of(Array.isArray(item) ? 4 : 3),
          key,
          schemaBson(item, { Binary, EJSON, serialize }),
        ])
      }
    }
    return serialize({ [name]: EJSON.deserialize(item, { relaxed: false }) }).subarray(4, -1)
  })
  const size = int32(5 + fields.reduce((total, field) => total + field.length, 0))
  return bytes([size, ...fields, Uint8Array.of(0)])
}

export async function replay({
  client,
  loadDocuments,
  authoring,
  vectors,
  assert,
  bsonCodec,
  start,
  pass,
}) {
  const { Binary, deserialize, EJSON, serialize } = bsonCodec
  const bson = (text) => Uint8Array.from(Binary.createFromBase64(text).value())
  assert.equal(client.PolicyEngine, undefined)
  assert.equal(authoring.DocumentPage, undefined)
  assert.equal(client.DocumentPage.prototype.sort, undefined)
  assert.equal(client.DocumentPage.prototype.project, undefined)
  assert.equal(client.DocumentPage.prototype.applyUpdate, undefined)
  assert.equal(client.DocumentPage.prototype.applyBsonUpdate, undefined)
  assert.equal(authoring.Filter, undefined)
  const counts = { filters: 0, unsupportedFilters: 0, updates: 0, unsupportedUpdates: 0 }
  start?.("matcher/filters")
  const match = await vectors("matcher/filters")
  const matchPage = client.DocumentPage.fromBson(bytes(match.documents.map(bson)))
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
        const expected = Binary.createFromHexString(item.matches).value()
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
  assert.equal(counts.filters, 1991)
  assert.equal(counts.unsupportedFilters, 0)

  pass?.("matcher/filters", match.cases.length)

  start?.("matcher/sorts")
  const transforms = await loadDocuments()
  assert.equal(transforms.DocumentPage.prototype.matchFilter, undefined)
  assert.equal(transforms.PolicyEngine, undefined)
  for (const [kind, spec, expectedKey] of [
    ["sorts", "sort", "order"],
    ["projections", "projection", "documents"],
  ]) {
    start?.(`matcher/${kind}`)
    const fixture = await vectors(`matcher/${kind}`)
    const pageBytes = bytes(fixture.documents.map(bson))
    for (const [index, item] of fixture.cases.entries()) {
      const page = transforms.DocumentPage.fromBson(pageBytes)
      try {
        const text = client.bsonToEjson(bson(item[spec]), true)
        const apply = () => (spec === "sort" ? page.sort(text) : page.project(text))
        if (item.error !== undefined) {
          assert.throws(apply)
          assert.deepEqual(new Uint8Array(page.bson()), pageBytes)
          continue
        }
        apply()
        const expected = item[expectedKey].map((entry) =>
          bson(spec === "sort" ? fixture.documents[entry] : entry),
        )
        assert.deepEqual(new Uint8Array(page.bson()), bytes(expected), `${kind} ${index}`)
      } finally {
        page.free()
      }
    }
    pass?.(`matcher/${kind}`, fixture.cases.length)
  }

  start?.("matcher/updates")
  const updates = await vectors("matcher/updates")
  const unsupportedUpdates = []
  for (const [index, item] of updates.cases.entries()) {
    const original = bson(updates.documents[item.document])
    const page = transforms.DocumentPage.fromBson(original)
    const arrayFilters = item.arrayFilters
      ? deserialize(bson(item.arrayFilters), { promoteValues: false, bsonRegExp: true }).list.map(
          (filter) => serialize(filter),
        )
      : []
    try {
      try {
        page.applyBsonUpdate(bson(item.update), bytes(arrayFilters), false)
      } catch (error) {
        assert.deepEqual(new Uint8Array(page.bson()), original)
        if (isUnsupported(error)) {
          assert.equal(
            error.message,
            "UnsupportedQueryError: Decimal128 arithmetic is not evaluated in process",
          )
          unsupportedUpdates.push(index)
          counts.unsupportedUpdates++
          continue
        }
        if (item.error === undefined) throw error
        counts.updates++
        continue
      }
      assert.ok(item.result, `update ${index} should refuse`)
      assert.deepEqual(new Uint8Array(page.bson()), bson(item.result), `update ${index}`)
      counts.updates++
    } finally {
      page.free()
    }
  }
  assert.equal(counts.updates, 1995)
  assert.deepEqual(unsupportedUpdates, [163, 596, 893, 1111, 1949])
  const batch = bytes([
    client.ejsonToBson('{"_id":1,"n":1}'),
    client.ejsonToBson('{"_id":2,"n":"text"}'),
  ])
  const atomic = transforms.DocumentPage.fromBson(batch)
  try {
    assert.throws(() => atomic.applyUpdate('{"$inc":{"n":1}}', "[]", false))
    assert.deepEqual(new Uint8Array(atomic.bson()), batch)
    atomic.applyUpdate('{"$set":{"n":3}}', "[]", false)
    assert.deepEqual(
      new Uint8Array(atomic.bson()),
      bytes([client.ejsonToBson('{"_id":1,"n":3}'), client.ejsonToBson('{"_id":2,"n":3}')]),
    )
  } finally {
    atomic.free()
  }

  pass?.("matcher/updates", counts.updates)

  start?.("policy/policy")
  const policy = await vectors("policy/policy")
  const policySets = policy.cases.filter((item) => item.kind === "set")
  for (const item of policySets) {
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

  pass?.("policy/policy", policySets.length)

  start?.("policy/pipeline")
  const pipeline = await vectors("policy/pipeline")
  const pipelineEngine = new authoring.PolicyEngine(pipeline.collections, "null")
  counts.pipelinesAccepted = 0
  counts.pipelinesRefused = 0
  try {
    for (const [index, item] of pipeline.cases.entries()) {
      const label = `pipeline ${index} (${item.caller} on ${item.collection})`
      const secure = () =>
        pipelineEngine.securePipeline(
          item.collection,
          item.pipeline,
          pipeline.callers[item.caller],
          item.search,
          item.maxStages,
          item.maxSample,
        )
      if (item.error !== undefined) {
        assert.throws(
          secure,
          { code: item.code, message: `InvalidQueryError: ${item.error}` },
          label,
        )
        counts.pipelinesRefused++
      } else {
        assert.equal(secure(), item.result, label)
        counts.pipelinesAccepted++
      }
    }
  } finally {
    pipelineEngine.free()
  }
  assert.equal(counts.pipelinesAccepted, 431)
  assert.equal(counts.pipelinesRefused, 1811)

  pass?.("policy/pipeline", pipeline.cases.length)

  start?.("query/query")
  const query = await vectors("query/query")
  const queries = query.cases.filter((item) => item.kind === "query")
  for (const { input, result, error, code } of queries) {
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

  pass?.("query/query", queries.length)

  start?.("schema/schema")
  const schema = await vectors("schema/schema")
  for (const { name, docs, options, expected } of schema.inference) {
    const documents = bytes(docs.map((doc) => schemaBson(doc, bsonCodec)))
    assert.deepEqual(
      JSON.parse(
        authoring.inferSchema(
          name,
          documents,
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

  pass?.(
    "schema/schema",
    schema.inference.length + schema.validators.length + schema.restrictions.length,
  )

  start?.("authoring/policy/vectors", "authoring/policy/publishing")
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

  pass?.("authoring/policy/vectors", sets.length)
  pass?.("authoring/policy/publishing", sets.length)

  start?.("protocol/07-typed-values")
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
  pass?.("protocol/07-typed-values", documents.length)
  return counts
}
