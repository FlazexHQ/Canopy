import { testPolicyEngine } from "@canopy/testing"
import { describe, expect, it } from "vitest"
import { allow, auth, collection, createPolicySet } from "../src/index.ts"
import {
  as,
  describePolicies,
  memoryBackend,
  type PolicyBackend,
  policyCoverage,
  runPolicyTests,
  takeRegisteredSuites,
} from "../src/testing.ts"
import { todos } from "./fixtures.ts"

const engine = testPolicyEngine(createPolicySet([todos]))

describe("policy test runner", () => {
  it("passes the documented todos example in memory", async () => {
    takeRegisteredSuites()
    describePolicies("todos", ({ doc, expect: expectThat }) => {
      const alice = as.user({ sub: "u_alice", org_ids: ["o1"] })
      const bob = as.user({ sub: "u_bob", org_ids: ["o1"] })
      const t = doc({
        _id: "t1",
        ownerId: "u_alice",
        orgId: "o1",
        shared: false,
        internalNotes: "x",
      })

      expectThat(alice).can.read(t).withoutFields(["internalNotes"])
      expectThat(bob).cannot.read(t)
      expectThat(bob).can.read({ ...t, shared: true })
      expectThat(alice).cannot.update(t, { $set: { ownerId: "u_bob" } })
      expectThat(alice).can.update(t, { $set: { done: true } })
      expectThat(alice).cannot.update(t, { $set: { internalNotes: "y" } })
      expectThat(alice).cannot.delete({ ...t, archived: true })
      expectThat(alice).can.delete(t)
      expectThat(as.anon()).cannot.read(t)
      expectThat(alice).can.insert({ _id: "t2", title: "x", ownerId: "u_alice" })
      expectThat(alice).cannot.insert({ _id: "t3", title: "x", ownerId: "u_bob" })
      expectThat(as.service()).can.read(t).withFields(["internalNotes"])
    })
    const suites = takeRegisteredSuites()
    expect(suites).toHaveLength(1)
    const results = await runPolicyTests(suites, [memoryBackend(engine)])
    expect(results.filter((result) => !result.passed).map((result) => result.failures)).toEqual([])
    expect(results).toHaveLength(12)
  })

  it("refuses writes to an immutable field inside array elements", async () => {
    const orders = collection("orders", {
      exposed: true,
      policies: [
        allow.read("authenticated").where({ ownerId: auth("sub") }),
        allow.update("authenticated").where({ ownerId: auth("sub") }),
      ],
      immutable: ["lines.sku"],
    })
    takeRegisteredSuites()
    describePolicies("orders", ({ doc, expect: expectThat }) => {
      const alice = as.user({ sub: "u_alice" })
      const order = doc({ _id: "o1", ownerId: "u_alice", lines: [{ sku: "a", qty: 1 }] })
      expectThat(alice).cannot.update(order, { $set: { "lines.0.sku": "b" } })
      expectThat(alice).cannot.update(order, { $set: { "lines.0": { sku: "b", qty: 1 } } })
      expectThat(alice).can.update(order, { $inc: { "lines.0.qty": 1 } })
    })
    const results = await runPolicyTests(takeRegisteredSuites(), [
      memoryBackend(testPolicyEngine(createPolicySet([orders]))),
    ])
    expect(results.filter((result) => !result.passed).map((result) => result.failures)).toEqual([])
    expect(results).toHaveLength(3)
  })

  it("fails a case whose expectation is wrong, with a reason", async () => {
    const suite = describePolicies("todos", ({ expect: expectThat }) => {
      expectThat(as.user({ sub: "u_bob" })).can.read({ _id: 1, ownerId: "u_alice" })
    })
    takeRegisteredSuites()
    const [result] = await runPolicyTests([suite], [memoryBackend(engine)])
    expect(result?.passed).toBe(false)
    expect(result?.failures[0]).toContain("USING(read) does not match")
  })

  it("fails when two backends disagree, even if one matches the expectation", async () => {
    const suite = describePolicies("todos", ({ expect: expectThat }) => {
      expectThat(as.user({ sub: "u1" })).can.read({ _id: 1, ownerId: "u1" })
    })
    takeRegisteredSuites()
    const lying: PolicyBackend = {
      name: "mongodb",
      evaluate: async () => ({ allowed: false, reason: "not found" }),
    }
    const [result] = await runPolicyTests([suite], [memoryBackend(engine), lying])
    expect(result?.passed).toBe(false)
    expect(result?.failures.some((failure) => failure.startsWith("backends disagree"))).toBe(true)
  })

  it("reports policy coverage", () => {
    const suite = describePolicies("todos", ({ expect: expectThat }) => {
      expectThat(as.user({ sub: "u1" })).can.read({ _id: 1, ownerId: "u1" })
    })
    takeRegisteredSuites()
    const coverage = policyCoverage(engine, [suite]).get("todos")
    expect([...(coverage?.exercised ?? [])]).toEqual(["read own"])
    expect(coverage?.unexercised).toContain("archived is permanent")
  })
})
