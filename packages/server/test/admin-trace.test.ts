import { allow, auth, collection, createPolicySet, restrict } from "@canopy/policy"
import type { EventTrace } from "@canopy/realtime"
import { testPolicyEngine } from "@canopy/testing"
import { describe, expect, it } from "vitest"
import { maskTrace } from "../src/admin/trace.ts"

const engine = testPolicyEngine(
  createPolicySet([
    collection("staff", {
      exposed: true,
      realtime: true,
      policies: [
        allow
          .read("authenticated")
          .where({ ownerId: auth("sub") })
          .named("own"),
        restrict
          .read("authenticated")
          .where({ salary: { $lt: 100_000 } })
          .named("below band"),
      ],
      fields: { read: { default: { omit: ["salary"] } } },
    }),
  ]),
)

const subscribers = [{ sid: "s1", sub: "a", subject: "alice" }]

function trace(policies: readonly { name: string; fields: string[] }[]): EventTrace {
  return {
    id: "n1.1",
    ct: "1",
    wallTime: undefined,
    coll: "staff",
    op: "update",
    docId: "d1",
    fields: ["salary"],
    policyVersion: engine.version,
    candidates: [
      {
        observer: "o1",
        type: "filter",
        outcome: "left",
        subscribers,
        dls: {
          reason: "restrictive",
          responsible: ["below band"],
          policies: policies.map((policy) => ({
            name: policy.name,
            kind: policy.name === "own" ? "permissive" : "restrictive",
            matched: policy.name === "own",
            fields: policy.fields,
          })),
        },
      },
      { observer: "o2", type: "filter", outcome: "entered", subscribers },
    ],
  }
}

describe("maskTrace", () => {
  it("hides DLS outcomes over fields hidden from authenticated, and keeps the rest", () => {
    const masked = maskTrace(
      trace([
        { name: "own", fields: ["ownerId"] },
        { name: "below band", fields: ["salary"] },
      ]),
      engine,
    )
    expect(masked.candidates[0]?.dls).toEqual({ masked: true })
    expect(JSON.stringify(masked)).not.toContain("below band")
    expect(masked.candidates[1]).toEqual({
      observer: "o2",
      type: "filter",
      outcome: "entered",
      subscribers,
    })
    expect(masked.fields).toEqual(["salary"])

    const visible = trace([{ name: "own", fields: ["ownerId"] }])
    expect(maskTrace(visible, engine).candidates[0]?.dls).toEqual(visible.candidates[0]?.dls)
  })
})
