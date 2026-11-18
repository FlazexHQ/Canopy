import { testPolicyEngine } from "@canopy/testing"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  allow,
  auth,
  collection,
  createPolicySet,
  describeIssue,
  explainAccess,
  explainContext,
  formatAccessReport,
  OPERATIONS,
  onceVariableIssue,
  toFilter,
} from "../src/index.ts"
import { employees, invoices, posts, secrets, todos } from "./fixtures.ts"

const NOW = new Date("2026-11-06T12:00:00Z")
const coerced = collection("accounts", {
  exposed: true,
  policies: [
    allow
      .read("authenticated")
      .where({ ownerId: auth("sub", "objectId") })
      .named("own account"),
  ],
})
const engine = testPolicyEngine(
  createPolicySet([todos, invoices, posts, employees, secrets, coerced]),
)

describe("formatAccessReport", () => {
  it("explains an empty read for a user without a claim", () => {
    const report = explainAccess(engine, {
      collection: "todos",
      context: explainContext({ claims: { sub: "u_alice" }, now: NOW }),
      filter: { status: "active" },
    })
    expect(formatAccessReport(report)).toBe(
      [
        "todos, read, roles [authenticated]",
        '  permissive  "read own"                matches   {"ownerId":"u_alice"}',
        '  permissive  "read shared in my orgs"  no match  claim org_ids is missing or null (fails closed)',
        "  restrictive (none)",
        "  (4 policies do not cover read for these roles)",
        "Result: allowed",
        'Effective filter: {"$and":[{"status":"active"},{"ownerId":"u_alice"}]}',
        "Fields hidden: internalNotes",
      ].join("\n"),
    )
  })

  it("shows restrictive policies and the target of a delete", () => {
    const report = explainAccess(engine, {
      collection: "todos",
      op: "delete",
      context: explainContext({ claims: { sub: "u1", org_ids: ["o1"] }, now: NOW }),
    })
    const text = formatAccessReport(report)
    expect(text).toContain('  permissive  "delete own"             matches   {"ownerId":"u1"}')
    expect(text).toContain(
      '  restrictive "archived is permanent"  matches   {"archived":{"$ne":true}}',
    )
    expect(toFilter(report.effective)).toEqual(
      toFilter(
        engine.target(
          "todos",
          "delete",
          explainContext({ claims: { sub: "u1", org_ids: ["o1"] }, now: NOW }),
        ),
      ),
    )
  })

  it("shows the check clause of an insert and the writable fields", () => {
    const report = explainAccess(engine, {
      collection: "todos",
      op: "insert",
      context: explainContext({ claims: { sub: "u1" }, now: NOW }),
    })
    const text = formatAccessReport(report)
    expect(text.split("\n").slice(0, 3)).toEqual([
      "todos, insert, roles [authenticated]",
      "check:",
      '  permissive  "create own"  matches   {"ownerId":"u1"}',
    ])
    expect(text).toContain(
      "Writable fields limited to: title, done, dueAt, tags, ownerId, orgId, shared, archived",
    )
  })

  it("names the reason a request is denied outright", () => {
    const anon = explainContext({ claims: null, now: NOW })
    expect(
      formatAccessReport(explainAccess(engine, { collection: "todos", context: anon })),
    ).toContain("Result: no permissive policy grants read to these roles: denied")
    const user = explainContext({ claims: { sub: "u1" }, now: NOW })
    expect(
      formatAccessReport(explainAccess(engine, { collection: "secrets", context: user })),
    ).toContain("Result: secrets is not exposed: denied for every role but service")
    const service = explainContext({ claims: null, roles: ["service"], now: NOW })
    const bypass = explainAccess(engine, { collection: "secrets", context: service })
    expect(bypass.bypass).toBe(true)
    expect(formatAccessReport(bypass)).toBe(
      [
        "secrets, read, roles [service]",
        "Result: service bypasses DLS: every document and field",
        "Effective filter: {}",
      ].join("\n"),
    )
  })

  it("never prints the value that made a variable fail", () => {
    const report = explainAccess(engine, {
      collection: "accounts",
      context: explainContext({ claims: { sub: "u_not_an_object_id_SECRET" }, now: NOW }),
    })
    const text = formatAccessReport(report)
    expect(text).toContain(
      '"own account"  no match  claim sub cannot be converted to the requested type (fails closed)',
    )
    expect(text).not.toContain("SECRET")
    expect(text).toContain("Result: no policy matches: denied")
  })
})

describe("describeIssue", () => {
  it("names claims, context lookups and the request time", () => {
    expect(describeIssue({ kind: "missing", variable: "$auth:app_metadata.tenant" })).toBe(
      "claim app_metadata.tenant is missing or null (fails closed)",
    )
    expect(describeIssue({ kind: "shape", variable: "$ctx:projectIds" })).toContain(
      "context lookup projectIds has the wrong shape",
    )
    expect(describeIssue({ kind: "shape", variable: "$now" })).toContain("the request time")
  })
})

describe("explainContext", () => {
  it("builds anon, authenticated and service contexts", () => {
    expect([...explainContext({ claims: null }).roles]).toEqual(["anon"])
    expect([...explainContext({ claims: { sub: "u" }, roles: ["staff"] }).roles]).toEqual([
      "authenticated",
      "staff",
    ])
    expect([
      ...explainContext({ claims: { sub: "u" }, roles: ["staff", "service"] }).roles,
    ]).toEqual(["service"])
  })
})

const claimValue = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.constantFrom("u1", "u2", "t1", "o1"),
  fc.integer(),
  fc.array(fc.constantFrom("o1", "o2", "t1"), { maxLength: 3 }),
  fc.dictionary(fc.constantFrom("x", "y"), fc.string(), { maxKeys: 1 }),
)
const claims = fc.option(
  fc
    .record({
      sub: claimValue,
      org_ids: claimValue,
      tenant_id: claimValue,
      department: claimValue,
    })
    .map((record) =>
      Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)),
    ),
  { nil: null },
)

describe("explainAccess", () => {
  it("reports exactly the filter the engine enforces, and fails closed like it", () => {
    fc.assert(
      fc.property(
        claims,
        fc.subarray(["tenant_admin", "hr", "staff"]),
        fc.constantFrom(...OPERATIONS),
        fc.constantFrom("todos", "invoices", "posts", "employees", "secrets", "accounts", "nope"),
        (stated, roles, op, coll) => {
          const context = explainContext({ claims: stated, roles, now: NOW })
          const report = explainAccess(engine, { collection: coll, op, context })
          const expected =
            op === "read"
              ? engine.effectiveRead(coll, {}, context)
              : op === "insert"
                ? engine.check(coll, "insert", context)
                : engine.target(coll, op, context)
          expect(report.effective).toEqual(expected)
          expect(report.using.result).toEqual(engine.using(coll, op, context))
          if (op === "insert" || op === "update")
            expect(report.check?.result).toEqual(engine.check(coll, op, context))
          for (const explanation of [report.using, report.check]) {
            if (explanation === undefined || explanation.bypass) continue
            const permissive = explanation.policies.filter(
              (p) => p.kind === "permissive" && p.applies,
            )
            const failedRestrictive = explanation.policies.some(
              (p) => p.kind === "restrictive" && p.issue !== undefined,
            )
            if (permissive.length === 0 || failedRestrictive)
              expect(explanation.result).toEqual({ kind: "deny" })
          }
          expect(report.granted).toBe(engine.hasGrant(coll, op, context))
          expect(report.readable).toEqual(engine.readable(coll, context))
        },
      ),
      { numRuns: 500 },
    )
  })
})

describe("onceVariableIssue", () => {
  it("reports each distinct issue once, without values, through the engine hook", () => {
    const messages: string[] = []
    const hooked = testPolicyEngine(createPolicySet([todos, coerced]), {
      onVariableIssue: onceVariableIssue((message) => messages.push(message)),
    })
    const secret = explainContext({ claims: { sub: "SECRET_VALUE" }, now: NOW })
    for (let i = 0; i < 3; i += 1) {
      hooked.using("todos", "read", secret)
      hooked.using("accounts", "read", secret)
    }
    expect(messages).toEqual([
      'policy "read shared in my orgs" on todos did not match: claim org_ids is missing or null (fails closed)',
      'policy "own account" on accounts did not match: claim sub cannot be converted to the requested type (fails closed)',
    ])
    expect(messages.join("\n")).not.toContain("SECRET_VALUE")
  })

  it("forgets old issues beyond the limit instead of growing", () => {
    const messages: string[] = []
    const hook = onceVariableIssue((message) => messages.push(message), 2)
    const issue = (policy: string) =>
      ({ collection: "c", policy, variable: "$auth:sub", kind: "missing" }) as const
    hook(issue("a"))
    hook(issue("b"))
    hook(issue("a"))
    hook(issue("c"))
    hook(issue("a"))
    expect(messages).toHaveLength(4)
  })
})
