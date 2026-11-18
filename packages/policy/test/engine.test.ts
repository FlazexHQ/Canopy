import { compileFilter } from "@canopy/matcher"
import { InvalidQueryError, ObjectId, parse, stringify } from "@canopy/protocol"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  allow,
  and,
  auth,
  type Compiled,
  canAccess,
  collection,
  contextsFromStored,
  createPolicySet,
  deniesTextSearch,
  fieldAccess,
  fromStored,
  hashCollection,
  intersectProjection,
  lintPolicies,
  now,
  PolicyEngine,
  PolicyValidationError,
  projectReadable,
  type RequestContext,
  readStored,
  resolveClause,
  restrict,
  shiftDate,
  toFilter,
  toProjection,
  toStored,
  type VariableIssue,
} from "../src/index.ts"
import { employees, invoices, posts, secrets, todos } from "./fixtures.ts"

const NOW = new Date("2026-11-06T12:00:00Z")

function user(claims: Record<string, unknown>, ...roles: string[]): RequestContext {
  return { roles: new Set(["authenticated", ...roles]), claims, now: NOW }
}
const anon: RequestContext = { roles: new Set(["anon"]), claims: null, now: NOW }
const service: RequestContext = { roles: new Set(["service"]), claims: null, now: NOW }

const engine = new PolicyEngine(createPolicySet([todos, invoices, posts, employees, secrets]))

function visible(compiled: Compiled, doc: Record<string, unknown>): boolean {
  return (
    compiled.kind === "all" ||
    (compiled.kind === "filter" && compileFilter(compiled.filter).matches(doc))
  )
}

describe("combining policies", () => {
  it("ORs permissive and ANDs restrictive clauses", () => {
    const alice = user({ sub: "u_alice", org_ids: ["o1"] })
    expect(toFilter(engine.using("todos", "read", alice))).toEqual({
      $or: [{ ownerId: "u_alice" }, { orgId: { $in: ["o1"] }, shared: true }],
    })
    expect(toFilter(engine.using("todos", "delete", alice))).toEqual({
      $and: [{ ownerId: "u_alice" }, { archived: { $ne: true } }],
    })
  })

  it("denies when no permissive policy applies, with a filter that matches nothing", () => {
    expect(engine.using("todos", "read", anon)).toEqual({ kind: "deny" })
    expect(toFilter(engine.using("todos", "read", anon))).toEqual({ _id: { $in: [] } })
  })

  it("bypasses everything for service and hides unexposed collections from everyone else", () => {
    expect(engine.using("todos", "read", service)).toEqual({ kind: "all" })
    expect(engine.using("secrets", "read", user({ sub: "x" }))).toEqual({ kind: "deny" })
    expect(engine.using("missing", "read", user({ sub: "x" }))).toEqual({ kind: "deny" })
    expect(engine.using("secrets", "read", service)).toEqual({ kind: "all" })
  })

  it("treats public as every role, including anon", () => {
    expect(toFilter(engine.using("posts", "read", anon))).toEqual({ published: true })
    expect(toFilter(engine.using("posts", "read", user({ sub: "u1" })))).toEqual({
      $or: [{ published: true }, { authorId: "u1" }],
    })
  })

  it("uses the using clause as the update check when there is no check", () => {
    expect(toFilter(engine.check("posts", "update", user({ sub: "u1" })))).toEqual({
      authorId: "u1",
    })
  })

  it("targets updates and deletes with USING(op) AND USING(read)", () => {
    const t = engine.target("invoices", "update", user({ tenant_id: "t1" }, "tenant_admin"))
    expect(toFilter(t)).toEqual({ $and: [{ tenantId: "t1" }, { status: { $ne: "paid" } }] })
  })

  it("applies restrictive policies for public to every role", () => {
    const admin = user({ tenant_id: "t1" }, "tenant_admin")
    expect(
      visible(engine.target("invoices", "delete", admin), { tenantId: "t1", status: "paid" }),
    ).toBe(false)
    expect(
      visible(engine.target("invoices", "delete", admin), { tenantId: "t1", status: "sent" }),
    ).toBe(true)
  })
})

describe("variables fail closed", () => {
  it("drops a policy whose claim is missing instead of matching documents without the field", () => {
    const noSub = user({})
    const compiled = engine.using("todos", "read", noSub)
    expect(compiled).toEqual({ kind: "deny" })
    expect(visible(compiled, { title: "no owner" })).toBe(false)
  })

  it("drops a policy whose claim is null", () => {
    expect(engine.using("todos", "read", user({ sub: null }))).toEqual({ kind: "deny" })
  })

  it("denies everything when a restrictive policy cannot resolve", () => {
    const set = createPolicySet([
      collection("docs", {
        exposed: true,
        policies: [
          allow.read("authenticated").named("all"),
          restrict
            .read("authenticated")
            .where({ tenantId: auth("tenant_id") })
            .named("tenant"),
        ],
      }),
    ])
    const local = new PolicyEngine(set)
    expect(local.using("docs", "read", user({ sub: "u" }))).toEqual({ kind: "deny" })
    expect(toFilter(local.using("docs", "read", user({ sub: "u", tenant_id: "t" })))).toEqual({
      tenantId: "t",
    })
  })

  it("checks shapes: scalars in equality positions, arrays of scalars under $in", () => {
    const issues: VariableIssue[] = []
    const local = new PolicyEngine(createPolicySet([todos]), {
      onVariableIssue: (issue) => issues.push(issue),
    })
    expect(toFilter(local.using("todos", "read", user({ sub: ["a", "b"] })))).toEqual({
      _id: { $in: [] },
    })
    expect(toFilter(local.using("todos", "read", user({ sub: { $gt: "" } })))).toEqual({
      _id: { $in: [] },
    })
    expect(toFilter(local.using("todos", "read", user({ sub: "u", org_ids: "o1" })))).toEqual({
      ownerId: "u",
    })
    expect(toFilter(local.using("todos", "read", user({ sub: "u", org_ids: [null] })))).toEqual({
      ownerId: "u",
    })
    const many = Array.from({ length: 1001 }, (_, i) => `o${i}`)
    expect(toFilter(local.using("todos", "read", user({ sub: "u", org_ids: many })))).toEqual({
      ownerId: "u",
    })
    expect(issues.map((issue) => issue.kind)).toContain("shape")
  })

  it("reads only own properties of the claims, never the prototype chain", () => {
    const set = createPolicySet([
      collection("c", {
        exposed: true,
        policies: [allow.read("authenticated").where({ x: auth("constructor") })],
      }),
    ])
    expect(new PolicyEngine(set).using("c", "read", user({}))).toEqual({ kind: "deny" })
  })

  it("coerces only when asked, and a failed coercion counts as missing", () => {
    const set = createPolicySet([
      collection("c", {
        exposed: true,
        policies: [allow.read("authenticated").where({ ownerId: auth("sub", "objectId") })],
      }),
    ])
    const local = new PolicyEngine(set)
    const hex = "6728f0c2a1b2c3d4e5f60718"
    const filter = toFilter(local.using("c", "read", user({ sub: hex })))
    expect(filter["ownerId"]).toBeInstanceOf(ObjectId)
    expect(local.using("c", "read", user({ sub: "not-hex" }))).toEqual({ kind: "deny" })
  })

  it("coerces dates from epoch seconds and from ISO 8601 text that does not depend on the time zone", () => {
    const set = createPolicySet([
      collection("c", {
        exposed: true,
        policies: [allow.read("authenticated").where({ at: auth("t", "date") })],
      }),
    ])
    const local = new PolicyEngine(set)
    const at = (t: unknown): Compiled => local.using("c", "read", user({ t }))
    const filter = (iso: string): Compiled => ({ kind: "filter", filter: { at: new Date(iso) } })
    expect(at(1_700_000_000)).toEqual(filter("2023-11-14T22:13:20.000Z"))
    expect(at("2026-11-06T12:00:00Z")).toEqual(filter("2026-11-06T12:00:00.000Z"))
    expect(at("2026-11-06T12:00:00.1239+05:30")).toEqual(filter("2026-11-06T06:30:00.123Z"))
    expect(at("2026-11-06T12:00-01:00")).toEqual(filter("2026-11-06T13:00:00.000Z"))
    expect(at("2024-02-29")).toEqual(filter("2024-02-29T00:00:00.000Z"))
    expect(at("0001-01-01")).toEqual(filter("0001-01-01T00:00:00.000Z"))
    for (const bad of [
      "2026-11-06T12:00:00",
      "Fri Nov 06 2026",
      "2026/11/06",
      "1 March 2022",
      "2021-02-29",
      "2021-02-31T00:00:00Z",
      "2026-11-06T24:00:00Z",
      "2026-11-06T12:00:60Z",
      "2026-11-06T12:00:00+24:00",
      "+002026-11-06T12:00:00Z",
      "",
      1e13,
      Number.NaN,
      true,
    ])
      expect(at(bad), String(bad)).toEqual({ kind: "deny" })
  })

  it("resolves $now with ISO 8601 offsets", () => {
    expect(shiftDate(NOW, "-P7D").toISOString()).toBe("2026-10-30T12:00:00.000Z")
    expect(shiftDate(NOW, "-PT24H").toISOString()).toBe("2026-11-05T12:00:00.000Z")
    expect(shiftDate(NOW, "P1M").toISOString()).toBe("2026-12-06T12:00:00.000Z")
    const set = createPolicySet([
      collection("stories", {
        exposed: true,
        policies: [allow.read("authenticated").where({ createdAt: { $gte: now("-PT24H") } })],
      }),
    ])
    const filter = toFilter(new PolicyEngine(set).using("stories", "read", user({ sub: "u" })))
    expect(filter).toEqual({ createdAt: { $gte: new Date("2026-11-05T12:00:00Z") } })
  })

  it("drops a policy whose $now offset leaves the range of dates", () => {
    const issues: VariableIssue[] = []
    const set = createPolicySet([
      collection("stories", {
        exposed: true,
        policies: [
          allow
            .read("authenticated")
            .where({ createdAt: { $gte: now("-P300000Y") } })
            .named("recent"),
        ],
      }),
    ])
    const local = new PolicyEngine(set, { onVariableIssue: (issue) => issues.push(issue) })
    expect(local.using("stories", "read", user({ sub: "u" }))).toEqual({ kind: "deny" })
    expect(issues).toEqual([
      { kind: "coercion", variable: "$now", collection: "stories", policy: "recent" },
    ])
    expect(Number.isNaN(shiftDate(NOW, "P300000Y").getTime())).toBe(true)
  })

  it("refuses to resolve a clause that is itself a variable instead of returning a value as a filter", () => {
    const ctx = user({ sub: "u1" })
    expect(() => resolveClause({ $auth: "sub" }, ctx)).toThrow(InvalidQueryError)
    expect(() => resolveClause({ $now: {} }, ctx)).toThrow(
      "A policy clause must be a filter document",
    )
    expect(resolveClause({ ownerId: { $auth: "sub" } }, ctx)).toEqual({
      ok: true,
      filter: { ownerId: "u1" },
    })
  })

  it("forces DENY when evaluation throws", () => {
    const errors: unknown[] = []
    const local = new PolicyEngine(createPolicySet([todos]), {
      onEvaluationError: (error) => errors.push(error),
    })
    const hostile = {
      roles: new Set(["authenticated"]),
      get claims(): Record<string, unknown> {
        throw new Error("boom")
      },
      now: NOW,
    } as RequestContext
    expect(local.using("todos", "read", hostile)).toEqual({ kind: "deny" })
    expect(errors).toHaveLength(1)
  })
})

describe("combination semantics as a property", () => {
  const claimValue = fc.oneof(
    fc.constantFrom("u1", "u2", "o1", "o2"),
    fc.constant(null),
    fc.constant(undefined),
  )
  const claims = fc.record({
    sub: claimValue,
    tenant: claimValue,
    orgs: fc.option(fc.array(fc.constantFrom("o1", "o2", "o3"), { maxLength: 3 })),
  })
  const doc = fc.record(
    {
      ownerId: fc.constantFrom("u1", "u2"),
      tenant: fc.constantFrom("o1", "o2"),
      org: fc.constantFrom("o1", "o2", "o3"),
      archived: fc.boolean(),
    },
    { requiredKeys: [] },
  )
  const set = createPolicySet([
    collection("items", {
      exposed: true,
      policies: [
        allow
          .read("authenticated")
          .where({ ownerId: auth("sub") })
          .named("own"),
        allow
          .read("authenticated")
          .where({ org: { $in: auth("orgs") } })
          .named("orgs"),
        allow.read("reader").named("readers see all"),
        restrict
          .read("authenticated")
          .where({ tenant: auth("tenant") })
          .named("tenant"),
        restrict
          .read("public")
          .where({ archived: { $ne: true } })
          .named("hide archived"),
      ],
    }),
  ])
  const local = new PolicyEngine(set)
  const reference = (
    c: Record<string, unknown>,
    roles: Set<string>,
    d: Record<string, unknown>,
  ): boolean => {
    const present = (v: unknown): boolean => v !== undefined && v !== null
    const permissive = [
      present(c["sub"]) && d["ownerId"] === c["sub"],
      Array.isArray(c["orgs"]) && c["orgs"].includes(d["org"]),
      roles.has("reader"),
    ]
    const restrictive = [
      present(c["tenant"]) && d["tenant"] === c["tenant"],
      d["archived"] !== true,
    ]
    return permissive.some(Boolean) && restrictive.every(Boolean)
  }

  it("the compiled filter equals the definition of USING for every context and document", () => {
    fc.assert(
      fc.property(claims, fc.boolean(), doc, (c, reader, d) => {
        const roles = new Set(["authenticated", ...(reader ? ["reader"] : [])])
        const ctx: RequestContext = { roles, claims: c, now: NOW }
        expect(visible(local.using("items", "read", ctx), d)).toBe(reference(c, roles, d))
      }),
      { numRuns: 3000 },
    )
  })
})

describe("field level security", () => {
  it("hides omitted fields and blocks reads of their ancestors", () => {
    const access = engine.readable("employees", user({ org_id: "o" }))
    expect(canAccess(access, "salary")).toBe(false)
    expect(canAccess(access, "name")).toBe(true)
    const projected = projectReadable(access, { _id: 1, name: "n", salary: 5, ssn: "x" })
    expect(projected).toEqual({ _id: 1, name: "n" })
  })

  it("unions the rules of all roles", () => {
    expect(engine.readable("employees", user({ org_id: "o" }, "hr"))).toEqual({ kind: "all" })
    const rules = { default: { omit: ["a", "b.c"] }, x: { omit: ["b"] }, y: { only: ["a"] } }
    expect(fieldAccess(rules, new Set(["authenticated", "x"]))).toEqual({
      kind: "omit",
      paths: ["b.c"],
    })
    expect(fieldAccess(rules, new Set(["authenticated", "y"]))).toEqual({
      kind: "omit",
      paths: ["b.c"],
    })
  })

  it("keeps the outer path when allowed or hidden paths contain each other", () => {
    const rules = { x: { only: ["profile"] }, y: { only: ["profile.name"] } }
    const both = fieldAccess(rules, new Set(["x", "y"]))
    expect(both).toEqual({ kind: "only", paths: ["profile"] })
    expect(toProjection(both)).toEqual({ profile: 1 })
    const doc = { _id: 1, profile: { name: "a", ssn: "b" }, x: 1 }
    expect(projectReadable(both, doc)).toEqual({ _id: 1, profile: { name: "a", ssn: "b" } })
    expect(fieldAccess({ default: { only: ["a", "a.b"] } }, new Set(["r"]))).toEqual({
      kind: "only",
      paths: ["a"],
    })
    const omit = fieldAccess({ default: { omit: ["a.b", "a"] } }, new Set(["r"]))
    expect(omit).toEqual({ kind: "omit", paths: ["a"] })
    expect(projectReadable(omit, { _id: 1, a: { b: 1, c: 2 }, d: 3 })).toEqual({ _id: 1, d: 3 })
    expect(canAccess(both, "profile.name.first")).toBe(true)
    expect(canAccess(both, "profile.ssn")).toBe(true)
    expect(canAccess(both, "other")).toBe(false)
    expect(canAccess(omit, "a.c")).toBe(false)
    expect(canAccess(omit, "d")).toBe(true)
    const mixed = fieldAccess(
      { x: { omit: ["s", "s.t", "u"] }, y: { omit: ["s", "s.t"] } },
      new Set(["x", "y"]),
    )
    expect(mixed).toEqual({ kind: "omit", paths: ["s"] })
  })

  it("allows $text only to a caller that can read every field", () => {
    const search = { $text: { $search: "x" }, a: 1 }
    expect(deniesTextSearch({ kind: "all" }, search)).toBe(false)
    expect(deniesTextSearch({ kind: "omit", paths: ["secret"] }, search)).toBe(true)
    expect(deniesTextSearch({ kind: "only", paths: ["a", "b"] }, search)).toBe(true)
    expect(deniesTextSearch({ kind: "omit", paths: ["secret"] }, { a: 1 })).toBe(false)
  })

  it("applies write rules to equal, nested and ancestor paths", () => {
    const access = { kind: "omit" as const, paths: ["profile.ssn"] }
    expect(canAccess(access, "profile.ssn")).toBe(false)
    expect(canAccess(access, "profile.ssn.last4")).toBe(false)
    expect(canAccess(access, "profile")).toBe(false)
    expect(canAccess(access, "profile.name")).toBe(true)
    const only = { kind: "only" as const, paths: ["title", "meta"] }
    expect(canAccess(only, "meta.color")).toBe(true)
    expect(canAccess(only, "items.0.title")).toBe(false)
    expect(canAccess(only, "_id")).toBe(true)
  })

  it("never returns a field outside the readable set, whatever the document", () => {
    const access = { kind: "omit" as const, paths: ["secret", "profile.ssn"] }
    const paths = (value: unknown, prefix = ""): string[] => {
      if (Array.isArray(value)) return value.flatMap((item) => paths(item, prefix))
      if (typeof value !== "object" || value === null) return prefix === "" ? [] : [prefix]
      return Object.entries(value).flatMap(([key, inner]) => {
        const path = prefix === "" ? key : `${prefix}.${key}`
        return [path, ...paths(inner, path)]
      })
    }
    const profile = fc.record({ ssn: fc.string(), name: fc.string() }, { requiredKeys: [] })
    fc.assert(
      fc.property(
        fc.record(
          {
            secret: fc.anything(),
            profile: fc.oneof(profile, fc.array(profile), fc.string()),
            title: fc.string(),
          },
          { requiredKeys: [] },
        ),
        (doc) => {
          const out = projectReadable(access, doc as Record<string, unknown>)
          for (const path of paths(out)) {
            expect(
              access.paths.some((hidden) => path === hidden || path.startsWith(`${hidden}.`)),
              path,
            ).toBe(false)
          }
        },
      ),
    )
  })

  it("intersects caller projections with readable fields", () => {
    const omit = { kind: "omit" as const, paths: ["salary"] }
    expect(intersectProjection({ name: 1, salary: 1 }, omit)).toEqual({ name: 1 })
    expect(intersectProjection({ notes: 0 }, omit)).toEqual({ notes: 0, salary: 0 })
    expect(intersectProjection(undefined, omit)).toEqual({ salary: 0 })
    const only = { kind: "only" as const, paths: ["name", "profile.city"] }
    expect(intersectProjection({ profile: 1 }, only)).toEqual({ "profile.city": 1 })
    expect(intersectProjection({ salary: 1 }, only)).toEqual({ _id: 1 })
  })
})

describe("stored form", () => {
  it("round trips through EJSON text without changing the hash", () => {
    const stored = toStored(todos, { version: 8, updatedBy: "admin:alice@example.com" })
    expect(stored.policies[0]?.using).toBe('{"ownerId":{"$auth":"sub"}}')
    expect(stored.hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    const back = fromStored(parse(stringify(stored)))
    expect(hashCollection(back)).toBe(stored.hash)
    expect(createPolicySet([back]).hashes.get("todos")).toBe(stored.hash)
  })

  it("changes the hash when anything meaningful changes", () => {
    const changed = collection("todos", { ...todos, policies: todos.policies.slice(1) })
    expect(hashCollection(changed)).not.toBe(hashCollection(todos))
    expect(createPolicySet([todos]).version).not.toBe(createPolicySet([changed]).version)
  })

  it("rejects tampered stored documents on load", () => {
    const stored = toStored(todos, { version: 1 }) as unknown as Record<string, unknown>
    const tampered = {
      ...stored,
      policies: [{ name: "x", kind: "permissive", ops: ["read"], roles: ["service"] }],
    }
    expect(() => createPolicySet([fromStored(tampered)])).toThrow(PolicyValidationError)
    const where = {
      ...stored,
      policies: [
        {
          name: "x",
          kind: "permissive",
          ops: ["read"],
          roles: ["anon"],
          using: '{"$where":"true"}',
        },
      ],
    }
    expect(() => createPolicySet([fromStored(where)])).toThrow(PolicyValidationError)
  })

  it("refuses stored documents of the wrong shape before they are compiled", () => {
    const stored = { ...toStored(todos, { version: 1 }) }
    const policy = { name: "x", kind: "permissive", ops: ["read"], roles: ["anon"] }
    const malformed: [string, unknown][] = [
      ["not a document", "todos"],
      ["no _id", { ...stored, _id: undefined }],
      ["policies not an array", { ...stored, policies: { 0: policy } }],
      ["a policy that is a string", { ...stored, policies: ["read all"] }],
      ["a numeric name", { ...stored, policies: [{ ...policy, name: 7 }] }],
      ["an unknown kind", { ...stored, policies: [{ ...policy, kind: "allow" }] }],
      ["an unknown operation", { ...stored, policies: [{ ...policy, ops: ["read", "drop"] }] }],
      ["a role that is a number", { ...stored, policies: [{ ...policy, roles: ["anon", 1] }] }],
      ["roles as a string", { ...stored, policies: [{ ...policy, roles: "anon" }] }],
      ["a using clause that is an object", { ...stored, policies: [{ ...policy, using: {} }] }],
      ["a field rule that is a string", { ...stored, fields: { read: { anon: "salary" } } }],
      [
        "a field rule with both lists",
        { ...stored, fields: { read: { anon: { only: [], omit: [] } } } },
      ],
      ["an unknown field rule kind", { ...stored, fields: { delete: {} } }],
      ["immutable paths that are numbers", { ...stored, immutable: [1] }],
    ]
    for (const [label, document] of malformed) {
      expect(() => fromStored(document), label).toThrow(TypeError)
      expect(() => readStored(document), label).toThrow(TypeError)
    }
  })

  it("reads a stored document with its version, hash and author", () => {
    const at = new Date("2026-11-01T00:00:00Z")
    const stored = toStored(todos, { version: 3, updatedAt: at, updatedBy: "admin:alice" })
    expect(readStored(parse(stringify(stored)))).toEqual(stored)
    expect(() => readStored({ ...stored, version: "3" })).toThrow(TypeError)
    expect(() => readStored({ ...stored, version: 1.5 })).toThrow(TypeError)
    expect(() => readStored({ ...stored, hash: undefined })).toThrow(TypeError)
    expect(() => readStored({ ...stored, updatedAt: "2026-11-01" })).toThrow(TypeError)
    expect(() => readStored({ ...stored, updatedBy: 1 })).toThrow(TypeError)
  })

  it("checks the shape of stored context lookups", () => {
    const lookup = {
      from: "members",
      where: { userId: { $auth: "sub" } },
      select: "team",
      max: 50,
      ttl: "1m",
    }
    expect(contextsFromStored(undefined)).toEqual({})
    expect(contextsFromStored(null)).toEqual({})
    expect(contextsFromStored({ team: lookup })).toEqual({ team: lookup })
    for (const bad of [
      [],
      "team",
      { team: "members" },
      { team: { ...lookup, from: 1 } },
      { team: { ...lookup, where: "{}" } },
      { team: { ...lookup, select: ["team"] } },
      { team: { ...lookup, max: "50" } },
      { team: { ...lookup, ttl: 60 } },
    ])
      expect(() => contextsFromStored(bad), JSON.stringify(bad)).toThrow(TypeError)
  })
})

describe("validation", () => {
  const invalid = (options: Parameters<typeof collection>[1]): void => {
    expect(() => createPolicySet([collection("c", options)])).toThrow(PolicyValidationError)
  }

  it.each([
    ["naming service", { policies: [allow.read("service")] }],
    [
      "using on an insert only policy",
      { policies: [allow.insert("authenticated").where({ a: 1 })] },
    ],
    ["check on a read only policy", { policies: [allow.read("authenticated").check({ a: 1 })] }],
    ["a policy without roles", { policies: [allow.read()] }],
    ["duplicate names", { policies: [allow.read("a").named("x"), allow.read("b").named("x")] }],
    ["$where in using", { policies: [allow.read("a").where({ $where: "true" })] }],
    ["$expr in using", { policies: [allow.read("a").where({ $expr: { $eq: [1, 1] } })] }],
    [
      "a backtracking regex in using",
      { policies: [allow.read("a").where({ s: { $regex: "(a)\\1" } })] },
    ],
    [
      "an undeclared $ctx lookup",
      { policies: [allow.read("a").where({ p: { $in: { $ctx: "nope" } } })] },
    ],
    [
      "a bad $now offset",
      { policies: [allow.read("a").where({ t: { $gte: { $now: { offset: "7 days" } } } })] },
    ],
    [
      "an unknown coercion",
      { policies: [allow.read("a").where({ t: { $auth: "sub", as: "int" } })] },
    ],
    ["a variable as an operator", { policies: [allow.read("a").where({ $auth: "sub" })] }],
    [
      "a field rule with both only and omit",
      { fields: { read: { default: { only: ["a"], omit: ["b"] } as never } } },
    ],
    [
      "too many policies",
      { policies: Array.from({ length: 65 }, (_, i) => allow.read("a").named(`p${i}`)) },
    ],
  ])("rejects %s", (_name, options) => {
    invalid(options as Parameters<typeof collection>[1])
  })

  it("accepts $expr and $jsonSchema in check clauses", () => {
    expect(() =>
      createPolicySet([
        collection("leads", {
          exposed: true,
          policies: [allow.insert("anon").check({ $jsonSchema: { required: ["email"] } })],
        }),
      ]),
    ).not.toThrow()
  })

  it("uses InvalidQueryError as the base type", () => {
    expect(new PolicyValidationError("c", "x")).toBeInstanceOf(InvalidQueryError)
  })
})

describe("explain", () => {
  it("reports why each policy applies or not", () => {
    const explanation = engine.explain("todos", "read", user({ org_ids: ["o1"] }))
    expect(explanation.policies.map((p) => [p.name, p.applies, p.reason])).toEqual([
      ["read own", false, "variable $auth:sub is missing or null"],
      ["read shared in my orgs", true, "applies"],
      ["create own", false, "does not cover read"],
      ["edit own", false, "does not cover read"],
      ["delete own", false, "does not cover read"],
      ["archived is permanent", false, "does not cover read"],
    ])
    expect(toFilter(explanation.result)).toEqual({ orgId: { $in: ["o1"] }, shared: true })
  })
})

describe("lint", () => {
  it("is quiet for the documented examples apart from informational findings", () => {
    const findings = lintPolicies([todos, invoices, posts, employees])
    expect(findings.filter((f) => f.severity !== "info")).toEqual([])
    expect(findings.some((f) => f.rule === "update-without-check")).toBe(true)
  })

  it("reports each rule on a policy that breaks it", () => {
    const bad = collection("bad", {
      exposed: true,
      policies: [
        allow.update("anon").named("anyone edits"),
        allow.insert("public").named("anyone inserts"),
        allow
          .ops(["update"], "authenticated")
          .where({ tenant: auth("user_metadata.tenant") })
          .named("editable"),
        allow
          .update("auditor")
          .where({ ownerId: auth("sub") })
          .check({ ownerId: auth("sub") })
          .named("auditors"),
      ],
      fields: { read: { hr: { only: ["*"] } } },
    })
    const rules = lintPolicies(
      [bad],
      {},
      { knownRoles: ["hr"], indexes: { bad: [["other"]] } },
    ).map((f) => `${f.severity}:${f.rule}`)
    expect(rules).toEqual(
      expect.arrayContaining([
        "warn:exposed-without-read-policy",
        "error:public-allow-all",
        "error:user-editable-claim",
        "warn:field-rules-partial",
        "info:unreachable-role",
        "warn:missing-index",
      ]),
    )
    expect(rules.filter((rule) => rule === "error:public-allow-all")).toHaveLength(2)
  })

  it("asks for an index on the equality fields inside $and, and never on _id", () => {
    const scoped = collection("scoped", {
      exposed: true,
      policies: [
        allow
          .read("authenticated")
          .where({ _id: auth("sub"), $and: [{ tenantId: auth("tenant") }] })
          .named("tenant"),
      ],
    })
    const missing = (indexes: string[][]) =>
      lintPolicies([scoped], {}, { indexes: { scoped: indexes } })
        .filter((finding) => finding.rule === "missing-index")
        .map((finding) => finding.message)
    expect(missing([["other"]])).toEqual([
      "No index starts with tenantId, which this policy filters on for every query",
    ])
    expect(missing([["tenantId", "createdAt"]])).toEqual([])
  })
})

describe("and", () => {
  const f = (filter: Record<string, unknown>): Compiled => ({ kind: "filter", filter })

  it("drops a filter equal to an earlier one, including through nested $and", () => {
    expect(and(f({ ownerId: "u1" }), f({ _id: 5 }), f({ $and: [{ ownerId: "u1" }] }))).toEqual(
      f({ $and: [{ ownerId: "u1" }, { _id: 5 }] }),
    )
    expect(and(f({ a: 1, b: { $gt: 2 } }), f({ a: 1, b: { $gt: 2 } }))).toEqual(
      f({ a: 1, b: { $gt: 2 } }),
    )
  })

  it("keeps filters with the same keys but different values or types", () => {
    expect(and(f({ a: 1 }), f({ a: 2 }))).toEqual(f({ $and: [{ a: 1 }, { a: 2 }] }))
    expect(and(f({ a: 1 }), f({ a: "1" }))).toEqual(f({ $and: [{ a: 1 }, { a: "1" }] }))
    expect(and(f({ a: { b: 1, c: 2 } }), f({ a: { c: 2, b: 1 } }))).toEqual(
      f({ $and: [{ a: { b: 1, c: 2 } }, { a: { c: 2, b: 1 } }] }),
    )
  })

  it("keeps every distinct filter in order", () => {
    expect(and(f({ a: 1 }), f({ b: 1 }), f({ a: 1 }), f({ c: 1 }), f({ b: 1 }))).toEqual(
      f({ $and: [{ a: 1 }, { b: 1 }, { c: 1 }] }),
    )
  })
})

describe("requiring a second factor", () => {
  const vault = collection("vault", {
    exposed: true,
    policies: [
      allow
        .update("authenticated")
        .where({ ownerId: auth("sub") })
        .check({ ownerId: auth("sub") }),
      restrict.update("authenticated").check({ $expr: { $eq: [auth("aal"), "aal2"] } }),
    ],
  })
  const guarded = new PolicyEngine(createPolicySet([vault]))

  it("compares the aal claim of the token in a check clause, so an aal1 session cannot write", () => {
    expect(guarded.check("vault", "update", user({ sub: "u1", aal: "aal1" }))).toEqual({
      kind: "filter",
      filter: { $and: [{ ownerId: "u1" }, { $expr: { $eq: ["aal1", "aal2"] } }] },
    })
    expect(guarded.check("vault", "update", user({ sub: "u1", aal: "aal2" }))).toEqual({
      kind: "filter",
      filter: { $and: [{ ownerId: "u1" }, { $expr: { $eq: ["aal2", "aal2"] } }] },
    })
  })

  it("denies when the token carries no aal claim", () => {
    expect(guarded.check("vault", "update", user({ sub: "u1" }))).toEqual({ kind: "deny" })
  })

  it("cannot gate a using clause on a claim alone", () => {
    expect(() =>
      createPolicySet([
        collection("vault", {
          exposed: true,
          policies: [allow.read("authenticated").where({ $expr: { $eq: [auth("aal"), "aal2"] } })],
        }),
      ]),
    ).toThrow(/\$expr is only allowed in check clauses/)
  })
})
