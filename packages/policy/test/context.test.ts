import { compileFilter } from "@canopy/matcher"
import { ObjectId } from "@canopy/protocol"
import { afterEach, describe, expect, it } from "vitest"
import {
  allow,
  auth,
  type ContextChange,
  type ContextDefinitions,
  type ContextIssue,
  type ContextQuery,
  ContextResolver,
  collection,
  context,
  contextNames,
  createPolicySet,
  ctx,
  PolicyEngine,
  type RequestContext,
  selectValues,
  toFilter,
  ttlMs,
} from "../src/index.ts"

type Doc = Record<string, unknown>

/** An in memory source collection whose reader evaluates filters with the matcher, like MongoDB would. */
class Source {
  readonly docs = new Map<unknown, Doc>()
  reads = 0
  gate: Promise<void> | undefined
  failWith: unknown

  reader = async (query: ContextQuery): Promise<Doc[]> => {
    this.reads += 1
    const snapshot = [...this.docs.values()]
    if (this.gate !== undefined) await this.gate
    if (this.failWith !== undefined) throw this.failWith
    const matcher = compileFilter(query.filter)
    return snapshot.filter((doc) => matcher.matches(doc)).slice(0, query.limit)
  }

  put(doc: Doc): ContextChange {
    const pre = this.docs.get(doc["_id"]) ?? null
    this.docs.set(doc["_id"], doc)
    return { coll: "members", id: doc["_id"], pre, post: doc }
  }

  delete(id: unknown): ContextChange {
    const pre = this.docs.get(id) ?? null
    this.docs.delete(id)
    return { coll: "members", id, pre, post: null }
  }
}

const contexts: ContextDefinitions = context({
  projectIds: {
    from: "members",
    where: { userId: auth("sub") },
    select: "projectId",
    max: 3,
    ttl: "5m",
  },
})

const user = (sub: string): RequestContext => ({
  roles: new Set(["authenticated"]),
  claims: { sub },
  now: new Date(0),
})

const resolvers: ContextResolver[] = []

function setup(options: { timeoutMs?: number; now?: () => number } = {}) {
  const source = new Source()
  const issues: ContextIssue[] = []
  const invalidated: string[][] = []
  const resolver = new ContextResolver({
    reader: source.reader,
    onIssue: (issue) => issues.push(issue),
    ...options,
  })
  resolver.onInvalidate((keys) => invalidated.push([...keys]))
  resolvers.push(resolver)
  return { source, resolver, issues, invalidated }
}

afterEach(() => {
  for (const resolver of resolvers.splice(0)) resolver.close()
})

describe("ContextResolver", () => {
  it("resolves the selected values of the subject's documents", async () => {
    const { source, resolver } = setup()
    source.put({ _id: 1, userId: "alice", projectId: "p1" })
    source.put({ _id: 2, userId: "alice", projectId: "p2" })
    source.put({ _id: 3, userId: "bob", projectId: "p3" })
    const result = await resolver.resolve(contexts, ["projectIds"], user("alice"))
    expect(result.ctx["projectIds"]).toEqual(["p1", "p2"])
    expect(result.keys.has("projectIds")).toBe(true)
  })

  it("caches per substituted where clause, so subjects never share results", async () => {
    const { source, resolver } = setup()
    source.put({ _id: 1, userId: "alice", projectId: "p1" })
    source.put({ _id: 2, userId: "bob", projectId: "p2" })
    const a = await resolver.resolve(contexts, ["projectIds"], user("alice"))
    const b = await resolver.resolve(contexts, ["projectIds"], user("bob"))
    await resolver.resolve(contexts, ["projectIds"], user("alice"))
    expect(a.ctx["projectIds"]).toEqual(["p1"])
    expect(b.ctx["projectIds"]).toEqual(["p2"])
    expect(a.keys.get("projectIds")).not.toBe(b.keys.get("projectIds"))
    expect(source.reads).toBe(2)
  })

  it("shares one read between concurrent requests for the same entry", async () => {
    const { source, resolver } = setup()
    source.put({ _id: 1, userId: "alice", projectId: "p1" })
    await Promise.all([
      resolver.resolve(contexts, ["projectIds"], user("alice")),
      resolver.resolve(contexts, ["projectIds"], user("alice")),
    ])
    expect(source.reads).toBe(1)
  })

  it("fails closed when the result is larger than max", async () => {
    const { source, resolver, issues } = setup()
    for (let i = 1; i <= 4; i += 1) source.put({ _id: i, userId: "alice", projectId: `p${i}` })
    const result = await resolver.resolve(contexts, ["projectIds"], user("alice"))
    expect(Object.hasOwn(result.ctx, "projectIds")).toBe(false)
    expect(issues).toEqual([{ name: "projectIds", kind: "max" }])
    await resolver.resolve(contexts, ["projectIds"], user("alice"))
    expect(source.reads).toBe(1)
  })

  it("accepts exactly max documents", async () => {
    const { source, resolver } = setup()
    for (let i = 1; i <= 3; i += 1) source.put({ _id: i, userId: "alice", projectId: `p${i}` })
    const result = await resolver.resolve(contexts, ["projectIds"], user("alice"))
    expect(result.ctx["projectIds"]).toEqual(["p1", "p2", "p3"])
  })

  it("fails closed on reader errors and does not cache them", async () => {
    const { source, resolver, issues } = setup()
    source.put({ _id: 1, userId: "alice", projectId: "p1" })
    source.failWith = new Error("boom")
    const failed = await resolver.resolve(contexts, ["projectIds"], user("alice"))
    expect(failed.ctx).toEqual({})
    expect(issues[0]?.kind).toBe("error")
    source.failWith = undefined
    const ok = await resolver.resolve(contexts, ["projectIds"], user("alice"))
    expect(ok.ctx["projectIds"]).toEqual(["p1"])
  })

  it("fails closed on timeouts and aborts the read", async () => {
    let signal: AbortSignal | undefined
    const issues: ContextIssue[] = []
    const resolver = new ContextResolver({
      timeoutMs: 20,
      reader: (query) => {
        signal = query.signal
        return new Promise(() => {})
      },
      onIssue: (issue) => issues.push(issue),
    })
    resolvers.push(resolver)
    const result = await resolver.resolve(contexts, ["projectIds"], user("alice"))
    expect(result.ctx).toEqual({})
    expect(issues).toEqual([{ name: "projectIds", kind: "timeout" }])
    expect(signal?.aborted).toBe(true)
  })

  it("leaves the value missing when the where clause cannot be resolved", async () => {
    const { source, resolver, issues } = setup()
    const anon: RequestContext = { roles: new Set(["anon"]), claims: null, now: new Date(0) }
    const result = await resolver.resolve(contexts, ["projectIds"], anon)
    expect(result.ctx).toEqual({})
    expect(issues).toEqual([{ name: "projectIds", kind: "unresolvable" }])
    expect(source.reads).toBe(0)
  })

  it("ignores names that are not declared", async () => {
    const { source, resolver } = setup()
    const result = await resolver.resolve(contexts, ["unknown"], user("alice"))
    expect(result.ctx).toEqual({})
    expect(source.reads).toBe(0)
  })

  it("invalidates when a new document matches the where clause", async () => {
    const { source, resolver, invalidated } = setup()
    const before = await resolver.resolve(contexts, ["projectIds"], user("alice"))
    expect(before.ctx["projectIds"]).toEqual([])
    resolver.invalidate(source.put({ _id: 9, userId: "alice", projectId: "p9" }))
    expect(invalidated).toEqual([[before.keys.get("projectIds")]])
    const after = await resolver.resolve(contexts, ["projectIds"], user("alice"))
    expect(after.ctx["projectIds"]).toEqual(["p9"])
  })

  it("invalidates on delete and on updates without images when the document was in the result", async () => {
    const { source, resolver } = setup()
    source.put({ _id: 1, userId: "alice", projectId: "p1" })
    await resolver.resolve(contexts, ["projectIds"], user("alice"))
    resolver.invalidate({ coll: "members", id: 1, post: null })
    expect(resolver.size).toBe(0)
    await resolver.resolve(contexts, ["projectIds"], user("alice"))
    source.docs.set(1, { _id: 1, userId: "bob", projectId: "p1" })
    resolver.invalidate({
      coll: "members",
      id: 1,
      pre: undefined,
      post: { _id: 1, userId: "bob", projectId: "p1" },
    })
    const after = await resolver.resolve(contexts, ["projectIds"], user("alice"))
    expect(after.ctx["projectIds"]).toEqual([])
  })

  it("keeps entries that a change cannot affect", async () => {
    const { source, resolver, invalidated } = setup()
    source.put({ _id: 1, userId: "alice", projectId: "p1" })
    await resolver.resolve(contexts, ["projectIds"], user("alice"))
    resolver.invalidate(source.put({ _id: 2, userId: "bob", projectId: "p2" }))
    resolver.invalidate({ coll: "other", id: 1, pre: null, post: { _id: 1, userId: "alice" } })
    expect(invalidated).toEqual([])
    expect(resolver.size).toBe(1)
  })

  it("invalidates when the images are unknown and the document is not in the result", async () => {
    const { resolver } = setup()
    await resolver.resolve(contexts, ["projectIds"], user("alice"))
    resolver.invalidate({ coll: "members", id: 42 })
    expect(resolver.size).toBe(0)
  })

  it("invalidates an oversized result on any change of its source", async () => {
    const { source, resolver } = setup()
    for (let i = 1; i <= 4; i += 1) source.put({ _id: i, userId: "alice", projectId: `p${i}` })
    await resolver.resolve(contexts, ["projectIds"], user("alice"))
    resolver.invalidate(source.delete(99))
    expect(resolver.size).toBe(0)
  })

  it("does not cache a result read before a concurrent relevant change", async () => {
    const { source, resolver } = setup()
    let open: () => void = () => {}
    source.gate = new Promise((resolve) => {
      open = resolve
    })
    const first = resolver.resolve(contexts, ["projectIds"], user("alice"))
    await Promise.resolve()
    resolver.invalidate(source.put({ _id: 1, userId: "alice", projectId: "p1" }))
    source.gate = undefined
    open()
    const result = await first
    expect(result.ctx["projectIds"]).toEqual(["p1"])
    expect(source.reads).toBe(2)
  })

  it("expires entries after their ttl and reports retained ones", async () => {
    let clock = 0
    const { source, resolver, invalidated } = setup({ now: () => clock })
    source.put({ _id: 1, userId: "alice", projectId: "p1" })
    const held = await resolver.resolve(contexts, ["projectIds"], user("alice"))
    await resolver.resolve(contexts, ["projectIds"], user("bob"))
    resolver.retain(held.keys.values())
    clock = ttlMs("5m") + 1
    resolver.sweep()
    expect(resolver.size).toBe(0)
    expect(invalidated).toEqual([[held.keys.get("projectIds")]])
    await resolver.resolve(contexts, ["projectIds"], user("alice"))
    expect(source.reads).toBe(3)
  })

  it("reports invalidation of retained entries only through invalidateAll", async () => {
    const { resolver, invalidated } = setup()
    const a = await resolver.resolve(contexts, ["projectIds"], user("alice"))
    await resolver.resolve(contexts, ["projectIds"], user("bob"))
    resolver.retain(a.keys.values())
    resolver.release(a.keys.values())
    resolver.retain(a.keys.values())
    resolver.invalidateAll()
    expect(invalidated).toEqual([[a.keys.get("projectIds")]])
    expect(resolver.size).toBe(0)
  })

  it("never evicts retained entries", async () => {
    const source = new Source()
    const resolver = new ContextResolver({ reader: source.reader, maxEntries: 1 })
    resolvers.push(resolver)
    const a = await resolver.resolve(contexts, ["projectIds"], user("alice"))
    resolver.retain(a.keys.values())
    await resolver.resolve(contexts, ["projectIds"], user("bob"))
    await resolver.resolve(contexts, ["projectIds"], user("carol"))
    await resolver.resolve(contexts, ["projectIds"], user("alice"))
    expect(source.reads).toBe(3)
  })

  it("feeds the policy engine so membership rules match exactly the member's documents", async () => {
    const { source, resolver } = setup()
    source.put({ _id: 1, userId: "alice", projectId: new ObjectId("0123456789abcdef01234567") })
    const set = createPolicySet(
      [
        collection("tasks", {
          exposed: true,
          policies: [allow.read("authenticated").where({ projectId: { $in: ctx("projectIds") } })],
        }),
      ],
      contexts,
    )
    const engine = new PolicyEngine(set)
    const names = engine.contextNames(["tasks"], new Set(["authenticated"]))
    expect(names).toEqual(["projectIds"])
    const resolved = await resolver.resolve(set.contexts, names, user("alice"))
    const filter = toFilter(engine.using("tasks", "read", { ...user("alice"), ctx: resolved.ctx }))
    const matcher = compileFilter(filter)
    expect(matcher.matches({ projectId: new ObjectId("0123456789abcdef01234567") })).toBe(true)
    expect(matcher.matches({ projectId: new ObjectId("0123456789abcdef01234568") })).toBe(false)
    const missing = engine.using("tasks", "read", user("alice"))
    expect(missing.kind).toBe("deny")
  })
})

describe("context helpers", () => {
  it("selects values through arrays like MongoDB paths", () => {
    expect(selectValues({ a: [{ b: 1 }, { b: [2, 3] }, { c: 4 }, { b: null }] }, "a.b")).toEqual([
      1, 2, 3,
    ])
    expect(selectValues({ a: { b: "x" } }, "a.b")).toEqual(["x"])
    expect(selectValues({ a: 1 }, "a.b")).toEqual([])
    expect(selectValues({}, "a")).toEqual([])
  })

  it("parses ttls", () => {
    expect(ttlMs("30s")).toBe(30_000)
    expect(ttlMs("5m")).toBe(300_000)
    expect(ttlMs("1h")).toBe(3_600_000)
    expect(ttlMs("2d")).toBe(172_800_000)
    expect(() => ttlMs("5 minutes")).toThrow(TypeError)
  })

  it("lists the lookups a clause uses", () => {
    expect(
      contextNames({ $or: [{ a: { $in: ctx("x") } }, { b: ctx("y") }, { c: auth("sub") }] }).sort(),
    ).toEqual(["x", "y"])
  })

  it("lists only the lookups of policies that apply to the roles", () => {
    const set = createPolicySet(
      [
        collection("tasks", {
          exposed: true,
          policies: [
            allow.read("authenticated").where({ p: { $in: ctx("projectIds") } }),
            allow.read("admin").where({ t: { $in: ctx("teamIds") } }),
          ],
        }),
      ],
      {
        ...contexts,
        teamIds: { from: "teams", where: { userId: auth("sub") }, select: "t", max: 5, ttl: "1m" },
      },
    )
    const engine = new PolicyEngine(set)
    expect(engine.contextNames(["tasks"], new Set(["authenticated"]))).toEqual(["projectIds"])
    expect(engine.contextNames(undefined, new Set(["authenticated", "admin"]))).toEqual([
      "projectIds",
      "teamIds",
    ])
    expect(engine.contextNames(["tasks"], new Set(["service"]))).toEqual([])
  })
})
