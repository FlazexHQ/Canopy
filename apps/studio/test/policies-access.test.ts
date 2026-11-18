import { describe, expect, it } from "vitest"
import type { PolicyDraft } from "../src/api/client.ts"
import type { StoredPolicy } from "../src/api/contract.ts"
import { accessMap, reachOf } from "../src/features/policies/access.ts"

function policy(overrides: Partial<StoredPolicy> & Pick<StoredPolicy, "name">): StoredPolicy {
  return { kind: "permissive", ops: ["read"], roles: ["authenticated"], ...overrides }
}

function draft(policies: StoredPolicy[]): PolicyDraft {
  return { _id: "todos", exposed: true, realtime: false, policies }
}

const OWN = '{"ownerId":{"$auth":"sub"}}'

describe("policy access map", () => {
  it("denies every operation when no policy applies, as the engine fails closed", () => {
    const map = accessMap(draft([]))
    expect(map.map((row) => row.role)).toEqual(["anon", "authenticated"])
    for (const row of map) {
      expect(Object.values(row.cells).map((cell) => cell.reach)).toEqual([
        "none",
        "none",
        "none",
        "none",
      ])
    }
  })

  it("gives all documents to a permissive policy without a clause and only its roles", () => {
    const map = accessMap(draft([policy({ name: "read all", roles: ["anon"] })]))
    expect(map[0]?.cells.read).toEqual({ reach: "all", grants: ["read all"], limits: [] })
    expect(map[1]?.cells.read.reach).toBe("none")
    expect(map[0]?.cells.insert.reach).toBe("none")
  })

  it("treats an empty clause written as {} like a missing one", () => {
    const cell = reachOf([policy({ name: "p", using: "{}" })], "read", ["authenticated"])
    expect(cell.reach).toBe("all")
  })

  it("matches every request role when a policy names public", () => {
    const map = accessMap(draft([policy({ name: "public read", roles: ["public"], using: OWN })]))
    expect(map.map((row) => row.cells.read.reach)).toEqual(["matching", "matching"])
  })

  it("lets one unconditional permissive policy win over a conditional one (OR)", () => {
    const cell = reachOf(
      [policy({ name: "own", using: OWN }), policy({ name: "everything" })],
      "read",
      ["authenticated"],
    )
    expect(cell).toEqual({ reach: "all", grants: ["own", "everything"], limits: [] })
  })

  it("narrows an open grant to matching documents when a restrictive policy applies (AND)", () => {
    const cell = reachOf(
      [
        policy({ name: "everything", ops: ["update"] }),
        policy({
          name: "not paid",
          kind: "restrictive",
          ops: ["update"],
          roles: ["public"],
          using: '{"status":{"$ne":"paid"}}',
        }),
      ],
      "update",
      ["authenticated"],
    )
    expect(cell).toEqual({ reach: "matching", grants: ["everything"], limits: ["not paid"] })
  })

  it("never grants with a restrictive policy alone", () => {
    const cell = reachOf(
      [policy({ name: "only drafts", kind: "restrictive", using: '{"draft":true}' })],
      "read",
      ["authenticated"],
    )
    expect(cell.reach).toBe("none")
    expect(cell.limits).toEqual(["only drafts"])
  })

  it("uses check before using for inserts, and both for updates", () => {
    const policies = [policy({ name: "write own", ops: ["insert", "update"], check: OWN })]
    expect(reachOf(policies, "insert", ["authenticated"]).reach).toBe("matching")
    expect(reachOf(policies, "update", ["authenticated"]).reach).toBe("matching")
    const scoped = [policy({ name: "edit own", ops: ["update"], using: OWN, check: "{}" })]
    expect(reachOf(scoped, "update", ["authenticated"]).reach).toBe("matching")
  })

  it("adds a row per custom role that also carries authenticated", () => {
    const map = accessMap(
      draft([
        policy({ name: "staff edit", ops: ["update"], roles: ["staff"] }),
        policy({ name: "members read", roles: ["authenticated"], using: OWN }),
      ]),
    )
    expect(map.map((row) => row.role)).toEqual(["anon", "authenticated", "staff"])
    const staff = map[2]
    expect(staff?.roles).toEqual(["authenticated", "staff"])
    expect(staff?.cells.update.reach).toBe("all")
    expect(staff?.cells.read).toEqual({ reach: "matching", grants: ["members read"], limits: [] })
    expect(map[1]?.cells.update.reach).toBe("none")
  })
})
