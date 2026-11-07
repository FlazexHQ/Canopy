import { describe, expect, it } from "vitest"
import { allow, auth, collection, lintPolicies, restrict } from "../src/index.ts"

const tasks = collection("tasks", {
  exposed: true,
  policies: [
    allow
      .read("authenticated")
      .where({ $or: [{ ownreId: auth("sub") }, { "meta.owner": auth("sub") }] })
      .named("typo in where"),
    allow
      .insert("authenticated")
      .check({ ownerId: auth("sub"), "items.0.sku": { $exists: true } })
      .named("valid check"),
    restrict
      .delete("authenticated")
      .where({ $and: [{ archived: { $ne: true } }, { _id: { $exists: true } }] })
      .named("valid restrictive"),
  ],
  fields: {
    read: { default: { omit: ["internalNote"] }, staff: { only: ["*"] } },
    write: { default: { only: ["title", "meta"] } },
  },
  immutable: ["ownerId", "createdAt"],
})

const sampled = ["_id", "ownerId", "title", "archived", "internalNotes", "meta.owner", "items.sku"]

describe("the unknown-field lint rule", () => {
  it("warns about every path no sampled document has, and nothing else", () => {
    const findings = lintPolicies([tasks], {}, { fields: { tasks: sampled } }).filter(
      (finding) => finding.rule === "unknown-field",
    )
    expect(findings).toEqual([
      {
        rule: "unknown-field",
        severity: "warn",
        collection: "tasks",
        policy: "typo in where",
        message: "where names the field ownreId, which no sampled document of tasks has",
      },
      {
        rule: "unknown-field",
        severity: "warn",
        collection: "tasks",
        message:
          "fields.read.default.omit names the field internalNote, which no sampled document of tasks has",
      },
      {
        rule: "unknown-field",
        severity: "warn",
        collection: "tasks",
        message: "immutable names the field createdAt, which no sampled document of tasks has",
      },
    ])
  })

  it("is skipped without sampled fields", () => {
    for (const env of [{}, { fields: { tasks: [] } }, { fields: { other: sampled } }])
      expect(lintPolicies([tasks], {}, env).some((f) => f.rule === "unknown-field")).toBe(false)
  })
})
