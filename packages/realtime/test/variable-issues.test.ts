import { allow, auth, collection } from "@canopy/policy"
import { MONGODB_URI } from "@canopy/testing"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import type { Logger } from "../src/index.ts"
import { type Keys, makeKeys, type Running, startEngine } from "./harness.ts"

const notes = collection("notes", {
  exposed: true,
  realtime: true,
  policies: [
    allow
      .read("authenticated")
      .where({ orgId: { $in: auth("org_ids") } })
      .named("org notes"),
  ],
})

const suite = MONGODB_URI === undefined ? describe.skip : describe

suite("logVariableIssues", () => {
  let keys: Keys
  let running: Running | undefined
  beforeAll(async () => {
    keys = await makeKeys()
  })
  afterEach(async () => {
    await running?.stop()
    running = undefined
  })

  const capture = (): {
    logger: Logger
    debug: [Record<string, unknown>, string | undefined][]
  } => {
    const debug: [Record<string, unknown>, string | undefined][] = []
    const noop = (): void => {}
    return {
      debug,
      logger: {
        debug: (object, message) => debug.push([object, message]),
        info: noop,
        warn: noop,
        error: noop,
      },
    }
  }
  const user = {
    roles: new Set(["authenticated"]),
    claims: { sub: "u1", org_ids: "SECRET_NOT_A_LIST" },
    now: new Date(),
  }

  it("logs each variable issue once, without the claim value", async () => {
    const { logger, debug } = capture()
    const db = `canopy_varlog_${process.pid}_${Math.floor(Math.random() * 1e6)}`
    running = await startEngine(MONGODB_URI ?? "", db, keys, [notes], {
      logger,
      logVariableIssues: true,
    })
    for (let i = 0; i < 3; i += 1) running.realtime.policies.using("notes", "read", user)
    expect(debug).toHaveLength(1)
    expect(debug[0]?.[1]).toBe(
      'policy "org notes" on notes did not match: claim org_ids has the wrong shape: a list under $in, $nin or $all, a single value elsewhere (fails closed)',
    )
    expect(debug[0]?.[0]).toEqual({
      coll: "notes",
      policy: "org notes",
      variable: "$auth:org_ids",
      kind: "shape",
    })
    expect(JSON.stringify(debug)).not.toContain("SECRET")
  })

  it("stays quiet by default", async () => {
    const { logger, debug } = capture()
    const db = `canopy_varlog_${process.pid}_${Math.floor(Math.random() * 1e6)}`
    running = await startEngine(MONGODB_URI ?? "", db, keys, [notes], { logger })
    running.realtime.policies.using("notes", "read", user)
    expect(debug.filter(([, message]) => message?.includes("did not match") === true)).toEqual([])
  })
})
