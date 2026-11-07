import { MONGODB_URI } from "@canopy/testing"
import { describe, expect, it } from "vitest"
import { doctor } from "../src/commands.ts"

async function runDoctor(
  mongodbUri: string,
): Promise<{ code: number; lines: string[]; errors: string[] }> {
  const lines: string[] = []
  const errors: string[] = []
  const code = await doctor(
    { mongodbUri, database: "canopy_doctor_diagnostics" },
    {
      log: (line) => lines.push(...line.split("\n")),
      error: (line) => errors.push(...line.split("\n")),
    },
  )
  return { code, lines, errors }
}

describe("canopy doctor diagnostics", () => {
  it("explains an unreachable host with its fix", async () => {
    const result = await runDoctor("mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=300")
    expect(result.code).toBe(1)
    expect(result.errors).toEqual([
      "error CANOPY_UNAVAILABLE: cannot reach MongoDB",
      "  MongoDB at 127.0.0.1:1 did not accept a connection: the host is wrong or mongod is not running.",
      "  Fix: check that mongod is running and that the host and port of the connection string are right.",
      "       In Docker, use the service name instead of localhost.",
      "  Docs: errors/mongodb-unreachable",
    ])
  })

  const withMongo = MONGODB_URI === undefined ? it.skip : it

  withMongo("explains rejected credentials without printing them", async () => {
    const uri = new URL((MONGODB_URI ?? "").replace(/^mongodb:/, "http:"))
    uri.username = "nobody"
    uri.password = "not-the-password"
    uri.searchParams.set("serverSelectionTimeoutMS", "3000")
    const result = await runDoctor(uri.toString().replace(/^http:/, "mongodb:"))
    expect(result.code).toBe(1)
    expect(result.errors[0]).toBe("error CANOPY_UNAVAILABLE: MongoDB rejected the credentials")
    expect(result.errors.join("\n")).not.toContain("not-the-password")
    expect(result.errors.at(-1)).toBe("  Docs: errors/authentication-failed")
  })

  withMongo("reports the feature compatibility version of a healthy deployment", async () => {
    const result = await runDoctor(MONGODB_URI ?? "")
    expect(result.errors).toEqual([])
    expect(
      result.lines.some((line) => /^ok {4}featureCompatibilityVersion [78]\.\d$/.test(line)),
    ).toBe(true)
  })
})
