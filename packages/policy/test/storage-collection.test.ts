import { testPolicyEngine } from "@canopy/testing"
import { describe, expect, it } from "vitest"
import {
  allow,
  auth,
  collection,
  createPolicySet,
  type RequestContext,
  STORAGE_COLLECTION,
  toFilter,
} from "../src/index.ts"

const alice: RequestContext = {
  roles: new Set(["authenticated"]),
  claims: { sub: "alice" },
  now: new Date(0),
}

describe("the storage.objects policy collection", () => {
  const objects = collection(STORAGE_COLLECTION, {
    exposed: true,
    policies: [allow.read("authenticated").where({ owner: auth("sub") })],
  })
  const engine = testPolicyEngine(createPolicySet([objects]))

  it("grants storage reads but is never exposed as an app collection", () => {
    expect(engine.hasGrant(STORAGE_COLLECTION, "read", alice)).toBe(true)
    expect(toFilter(engine.using(STORAGE_COLLECTION, "read", alice))).toEqual({ owner: "alice" })
    expect(engine.isExposed(STORAGE_COLLECTION)).toBe(false)
    expect(engine.isRealtime(STORAGE_COLLECTION)).toBe(false)
  })

  it("cannot be followed in realtime", () => {
    expect(() =>
      createPolicySet([
        collection(STORAGE_COLLECTION, {
          exposed: true,
          realtime: true,
          policies: [allow.read("authenticated")],
        }),
      ]),
    ).toThrow(/cannot be followed in realtime/)
  })
})
