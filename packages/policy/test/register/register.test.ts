import { allow, auth, collection, context, ctx, restrict } from "@canopy/policy"
import { as, describePolicies } from "@canopy/policy/testing"
import type { ObjectId } from "@canopy/protocol"
import { describe, expect, expectTypeOf, it } from "vitest"

interface Project {
  _id: ObjectId
  orgId: string
  ownerId: ObjectId
  name: string
  internalNotes?: string
}

interface Member {
  _id: ObjectId
  userId: string
  projectId: ObjectId
}

/** The shape `canopy gen types` writes. */
interface Database {
  projects: { Document: Project; Insert: Project }
  members: { Document: Member; Insert: Member }
}

const contexts = context({
  projectIds: {
    from: "members",
    where: { userId: auth("sub") },
    select: "projectId",
    max: 500,
    ttl: "1m",
  },
})

declare module "@canopy/policy" {
  interface Register {
    database: Database
    claims: { sub: string; org_ids: string[] }
    roles: "support"
    context: typeof contexts
  }
}

/** Type checks run by `tsc -b`; this function is never called. */
function checks(): void {
  collection("projects", {
    exposed: true,
    policies: [
      allow.read("authenticated").where({ _id: { $in: ctx("projectIds") } }),
      allow.read("authenticated").where({ orgId: { $in: auth("org_ids") } }),
      allow.update("support").where({ ownerId: auth("sub", "objectId") }),
      restrict.delete("authenticated").where({ ownerId: auth("sub", "objectId") }),
    ],
    fields: { read: { default: { omit: ["internalNotes"] } } },
    immutable: ["ownerId"],
  })
  // @ts-expect-error unknown collection
  collection("project", {})
  // @ts-expect-error a typo in an omit list would leak the field
  collection("projects", { fields: { read: { default: { omit: ["internalNote"] } } } })
  // @ts-expect-error unknown role
  allow.read("suport")
  // @ts-expect-error unknown claim
  auth("org_id")
  // @ts-expect-error unknown context lookup
  ctx("projectId")
  collection("projects", {
    // @ts-expect-error a string claim against an ObjectId field
    policies: [allow.read("authenticated").where({ ownerId: auth("sub") })],
  })
}

/** Policy tests are typed by the same declaration. */
function testChecks(id: ObjectId): void {
  describePolicies("projects", ({ doc, expect }) => {
    const alice = as.user({ sub: "u_alice", org_ids: ["o1"] })
    const project = doc({ _id: id, orgId: "o1", ownerId: id, name: "p" })
    expect(alice).can.read(project)
    expect(alice).cannot.update({ ...project, orgId: "o2" }, { $set: { name: "q" } })
    // @ts-expect-error typo in a test document
    expect(alice).can.read({ nmae: "p" })
    // @ts-expect-error wrong type in a test document
    doc({ ownerId: "u_alice" })
  })
  // @ts-expect-error unknown claim in a test actor
  as.user({ sbu: "u_alice" })
  // @ts-expect-error unknown collection
  describePolicies("project", () => {})
}

describe("the Register declaration", () => {
  it("types the top level DSL", () => {
    expectTypeOf(checks).toBeFunction()
    expectTypeOf(testChecks).toBeFunction()
    expect(contexts.projectIds).toEqual({
      from: "members",
      where: { userId: { $auth: "sub" } },
      select: "projectId",
      max: 500,
      ttl: "1m",
    })
  })
})
