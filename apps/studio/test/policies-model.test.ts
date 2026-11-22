import { describe, expect, it } from "vitest"
import type { PolicyDraft } from "../src/api/client.ts"
import {
  checkDraft,
  diffLines,
  draftFromText,
  draftOf,
  draftText,
  emptyDraft,
  sameDraft,
  TEMPLATE_IDS,
  templateDraft,
  testSnippet,
  toDsl,
} from "../src/features/policies/model.ts"

const todos: PolicyDraft = {
  _id: "todos",
  exposed: true,
  realtime: true,
  policies: [
    {
      name: "read own",
      kind: "permissive",
      ops: ["read"],
      roles: ["authenticated"],
      using: '{"ownerId":{"$auth":"sub"}}',
    },
    {
      name: "archived is permanent",
      kind: "restrictive",
      ops: ["delete"],
      roles: ["authenticated"],
      using: '{"archived":{"$ne":true}}',
    },
    {
      name: "edit or delete",
      kind: "permissive",
      ops: ["update", "delete"],
      roles: ["authenticated", "editor"],
      using: '{"orgId":{"$in":{"$auth":"org_ids"}},"due":{"$lt":{"$now":{"offset":"-P7D"}}}}',
    },
  ],
  fields: { read: { default: { omit: ["internalNotes"] } } },
  immutable: ["ownerId"],
}

describe("toDsl", () => {
  it("renders the TypeScript DSL with only the imports it uses", () => {
    expect(toDsl(todos))
      .toBe(`import { allow, auth, collection, now, restrict } from "canopy.js/policy"

export default collection("todos", {
  exposed: true,
  realtime: true,
  policies: [
    allow.read("authenticated")
      .where({
        ownerId: auth("sub"),
      })
      .named("read own"),
    restrict.delete("authenticated")
      .where({
        archived: {
          $ne: true,
        },
      })
      .named("archived is permanent"),
    allow.ops(["update", "delete"], "authenticated", "editor")
      .where({
        orgId: {
          $in: auth("org_ids"),
        },
        due: {
          $lt: now("-P7D"),
        },
      })
      .named("edit or delete"),
  ],
  fields: {
    read: {
      default: {
        omit: ["internalNotes"],
      },
    },
  },
  immutable: ["ownerId"],
})
`)
  })

  it("renders an empty draft without policies", () => {
    expect(toDsl(emptyDraft("notes"))).toContain(
      'collection("notes", {\n  exposed: false,\n  realtime: false,\n  policies: [],\n})',
    )
    expect(
      toDsl(emptyDraft("notes")).startsWith('import { collection } from "canopy.js/policy"'),
    ).toBe(true)
  })
})

describe("draft text", () => {
  it("round trips through the EJSON view", () => {
    const back = draftFromText(draftText(todos), "todos")
    expect(sameDraft(back, todos)).toBe(true)
    expect(back.policies[0]?.using).toBe('{"ownerId":{"$auth":"sub"}}')
  })

  it("rejects a draft for another collection or without a policies array", () => {
    expect(() => draftFromText('{"_id":"notes","policies":[]}', "todos")).toThrow(
      "for notes, not todos",
    )
    expect(() => draftFromText('{"exposed":true}', "todos")).toThrow("policies must be an array")
    expect(() => draftFromText('{"policies":[{"name":"x","using":"{}"}]}', "todos")).toThrow(
      "policies[0].using must be an object",
    )
    expect(() => draftFromText("[]", "todos")).toThrow("must be a JSON object")
  })

  it("drops server members when editing a published version", () => {
    const draft = draftOf({ ...todos, version: 3, hash: "sha256:x", updatedBy: "admin:a" }, "todos")
    expect(Object.keys(draft).sort()).toEqual([
      "_id",
      "exposed",
      "fields",
      "immutable",
      "policies",
      "realtime",
    ])
    expect(draftOf(null, "notes")).toEqual(emptyDraft("notes"))
  })
})

describe("checkDraft", () => {
  it("accepts a valid draft and reports lint findings", () => {
    const result = checkDraft(todos)
    expect(result.errors).toEqual([])
    expect(result.lint.map((finding) => finding.rule)).toContain("update-without-check")
  })

  it("rejects operators that are not allowed in using", () => {
    const result = checkDraft({
      ...todos,
      policies: [
        {
          name: "bad",
          kind: "permissive",
          ops: ["read"],
          roles: ["public"],
          using: '{"$where":"1"}',
        },
      ],
    })
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/\$where/)
  })

  it("rejects a variable in a key position and invalid clause text", () => {
    const variableKey = checkDraft({
      ...todos,
      policies: [
        {
          name: "bad",
          kind: "permissive",
          ops: ["read"],
          roles: ["authenticated"],
          using: '{"$auth":"sub"}',
        },
      ],
    })
    expect(variableKey.errors).toHaveLength(1)
    const broken = checkDraft({
      ...todos,
      policies: [
        { name: "bad", kind: "permissive", ops: ["read"], roles: ["authenticated"], using: "{" },
      ],
    })
    expect(broken.errors).toHaveLength(1)
  })

  it("flags public writes that allow everything", () => {
    const result = checkDraft({
      ...todos,
      policies: [{ name: "open", kind: "permissive", ops: ["insert"], roles: ["public"] }],
    })
    expect(result.lint.find((finding) => finding.rule === "public-allow-all")?.severity).toBe(
      "error",
    )
  })
})

describe("templates", () => {
  it.each(TEMPLATE_IDS)("%s compiles without errors or lint errors", (id) => {
    const result = checkDraft(templateDraft("todos", id))
    expect(result.errors).toEqual([])
    expect(result.lint.filter((finding) => finding.severity === "error")).toEqual([])
  })

  it("uses the given field names", () => {
    const draft = templateDraft("docs", "tenant-scoped", {
      tenantField: "teamId",
      tenantClaim: "team",
    })
    expect(draft.policies[0]?.using).toBe('{"teamId":{"$auth":"team"}}')
    expect(draft.immutable).toEqual(["teamId"])
    expect(templateDraft("x", "public-read").policies[0]?.roles).toEqual(["public"])
  })
})

describe("diffLines", () => {
  it("marks added and removed lines around common ones", () => {
    expect(diffLines("a\nb\nc", "a\nx\nc\nd")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "x" },
      { kind: "same", text: "c" },
      { kind: "added", text: "d" },
    ])
    expect(diffLines("same", "same")).toEqual([{ kind: "same", text: "same" }])
  })
})

describe("testSnippet", () => {
  it("writes a describePolicies case for a read with hidden fields", () => {
    expect(
      testSnippet({
        collection: "todos",
        as: { roles: ["authenticated", "editor"], claims: { sub: "u_alice" } },
        op: "read",
        document: { _id: "t1", ownerId: "u_alice" },
        allowed: true,
        hiddenFields: ["internalNotes"],
      }),
    ).toBe(`import { as, describePolicies } from "canopy.js/policy/testing"

describePolicies("todos", ({ doc, expect }) => {
  const actor = as.user({"sub":"u_alice"}, { roles: ["editor"] })
  expect(actor).can.read(doc({"_id":"t1","ownerId":"u_alice"})).withoutFields(["internalNotes"])
})
`)
  })

  it("writes denied updates and anonymous actors", () => {
    const snippet = testSnippet({
      collection: "todos",
      as: { roles: ["anon"], claims: {} },
      op: "update",
      document: { _id: "t1" },
      update: { $set: { done: true } },
      allowed: false,
    })
    expect(snippet).toContain("const actor = as.anon()")
    expect(snippet).toContain(
      'expect(actor).cannot.update(doc({"_id":"t1"}), {"$set":{"done":true}})',
    )
  })
})
