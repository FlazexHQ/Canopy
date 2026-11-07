import { MONGODB_URI } from "@canopy/testing"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { run } from "../src/cli.ts"
import type { Output } from "../src/output.ts"

const suite = MONGODB_URI === undefined ? describe.skip : describe

function capture(answer?: boolean): { lines: string[]; errors: string[]; out: Output } {
  const lines: string[] = []
  const errors: string[] = []
  return {
    lines,
    errors,
    out: {
      log: (line) => lines.push(line),
      error: (line) => errors.push(line),
      ...(answer === undefined
        ? {}
        : {
            confirm: async (question: string) => {
              lines.push(`? ${question}`)
              return answer
            },
          }),
    },
  }
}

suite("canopy realtime enable-images | disable-images", () => {
  const database = `canopy_images_${Date.now()}`
  let client: MongoClient
  const images = async (name: string): Promise<boolean> => {
    const [info] = await client.db(database).listCollections({ name }).toArray()
    const options = (info as { options?: Record<string, unknown> } | undefined)?.options ?? {}
    return (
      (options["changeStreamPreAndPostImages"] as { enabled?: boolean } | undefined)?.enabled ===
      true
    )
  }
  const cli = (args: string[], out: Output): Promise<number> =>
    run(["realtime", ...args, "--mongodb-uri", MONGODB_URI ?? "", "--database", database], {}, out)

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI ?? "")
    await client.connect()
    await client.db(database).createCollection("todos")
    await client.db(database).createCollection("notes")
  })
  afterAll(async () => {
    await client.db(database).dropDatabase()
    await client.close()
  })

  it("prints the exact collMod and changes nothing without confirmation", async () => {
    const { lines, errors, out } = capture()
    expect(await cli(["enable-images", "todos"], out)).toBe(1)
    expect(lines).toContain(
      '  db.runCommand({"collMod":"todos","changeStreamPreAndPostImages":{"enabled":true}})',
    )
    expect(errors).toEqual([
      "Not applied: no terminal to confirm on. Pass --yes to apply without a prompt.",
    ])
    expect(await images("todos")).toBe(false)

    const declined = capture(false)
    expect(await cli(["enable-images", "todos"], declined.out)).toBe(1)
    expect(declined.lines).toContain("? Enable pre and post images on 1 collection?")
    expect(await images("todos")).toBe(false)
  })

  it("applies after confirmation or with --yes, and skips collections already set", async () => {
    const asked = capture(true)
    expect(await cli(["enable-images", "todos"], asked.out)).toBe(0)
    expect(await images("todos")).toBe(true)
    expect(await images("notes")).toBe(false)

    const both = capture()
    expect(await cli(["enable-images", "todos", "notes", "--yes"], both.out)).toBe(0)
    expect(both.lines).toContain("todos: pre and post images are already on")
    expect(both.lines.filter((line) => line.startsWith("  db.runCommand"))).toEqual([
      '  db.runCommand({"collMod":"notes","changeStreamPreAndPostImages":{"enabled":true}})',
    ])
    expect(await images("notes")).toBe(true)

    const off = capture(true)
    expect(await cli(["disable-images", "todos"], off.out)).toBe(0)
    expect(await images("todos")).toBe(false)
    expect(await images("notes")).toBe(true)
  })

  it("refuses missing collections instead of creating them", async () => {
    const { errors, out } = capture(true)
    expect(await cli(["enable-images", "todos", "ghosts"], out)).toBe(1)
    expect(errors[0]).toContain("ghosts does not exist")
    expect(await client.db(database).listCollections({ name: "ghosts" }).toArray()).toEqual([])
  })

  it("needs at least one collection", async () => {
    const { errors, out } = capture(true)
    expect(await cli(["enable-images"], out)).toBe(1)
    expect(errors[0]).toContain("Name the collections")
  })
})
