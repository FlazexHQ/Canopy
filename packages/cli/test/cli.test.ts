import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { MONGODB_URI } from "@canopy/testing"
import { afterAll, describe, expect, it } from "vitest"
import { parseArgs, run } from "../src/cli.ts"

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

function capture(): {
  lines: string[]
  errors: string[]
  out: { log(line: string): void; error(line: string): void }
} {
  const lines: string[] = []
  const errors: string[] = []
  return {
    lines,
    errors,
    out: { log: (line) => lines.push(line), error: (line) => errors.push(line) },
  }
}

describe("canopy cli", () => {
  it("parses flags", () => {
    const { positional, flags } = parseArgs([
      "policies",
      "lint",
      "--dir",
      "x",
      "--mongodb-uri=mongodb://h",
      "--help",
    ])
    expect(positional).toEqual(["policies", "lint"])
    expect(flags.get("dir")).toBe("x")
    expect(flags.get("mongodb-uri")).toBe("mongodb://h")
    expect(flags.get("help")).toBe(true)
  })

  it("lints clean policies with exit code 0", async () => {
    const { lines, errors, out } = capture()
    expect(await run(["policies", "lint", "--dir", fixture("good")], {}, out)).toBe(0)
    expect(errors).toEqual([])
    expect(lines.at(-1)).toMatch(/^1 collections, \d+ findings, 0 errors$/)
  })

  it("fails lint on dangerous policies and names the rules", async () => {
    const { errors, out } = capture()
    expect(await run(["policies", "lint", "--dir", fixture("bad")], {}, out)).toBe(1)
    expect(errors.join("\n")).toContain("public-allow-all")
    expect(errors.join("\n")).toContain("user-editable-claim")
  })

  it("runs policy tests in memory", async () => {
    const { lines, errors, out } = capture()
    const code = await run(["policies", "test", "--dir", fixture("good")], {}, out)
    expect(errors).toEqual([])
    expect(code).toBe(0)
    expect(lines.some((line) => line.startsWith("coverage  todos: 5/5"))).toBe(true)
    expect(lines.at(-1)).toBe("11 cases on memory, 0 failed")
  })

  const scratch = fileURLToPath(new URL("./.tmp/cli/", import.meta.url))
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true })
  })
  const project = async (config: string): Promise<string> => {
    await mkdir(scratch, { recursive: true })
    const root = await mkdtemp(join(scratch, "p-"))
    await writeFile(join(root, "canopy.config.mjs"), config)
    return root
  }

  it("rejects unknown options instead of ignoring them", async () => {
    const { errors, out } = capture()
    expect(await run(["gen", "types", "--chek"], {}, out)).toBe(1)
    expect(errors).toEqual(["Unknown option --chek for gen types. Did you mean --check?"])
    const other = capture()
    expect(await run(["policies", "lint", "--sources"], {}, other.out)).toBe(1)
    expect(other.errors[0]).toBe("Unknown option --sources for policies lint.")
  })

  it("takes the policy directory from the config file", async () => {
    const root = await project(
      `export default { policies: { dir: ${JSON.stringify(fixture("good"))} } }`,
    )
    const { lines, errors, out } = capture()
    expect(await run(["policies", "lint"], {}, out, root)).toBe(0)
    expect(errors).toEqual([])
    expect(lines.at(-1)).toMatch(/^1 collections, \d+ findings, 0 errors$/)
  })

  it("prints the resolved config with secrets masked and sources", async () => {
    const root = await project(
      `export default { mongodb: { uri: "mongodb://u:pw@db.test/app" }, keys: { secret: ["canopy_sk_x"] } }`,
    )
    const { lines, errors, out } = capture()
    expect(await run(["config", "print", "--sources"], { PORT: "7000" }, out, root)).toBe(0)
    expect(errors).toEqual([])
    const printed = lines.join("\n")
    expect(printed).toContain('mongodb.uri = "mongodb://u:••••@db.test/app"  (config file)')
    expect(printed).toContain('keys.secret = ["••••"]  (config file)')
    expect(printed).toContain("server.port = 7000  (env PORT)")
    expect(printed).not.toContain("canopy_sk_x")
    expect(printed).not.toContain(":pw@")
  })

  it("reports config problems and exits 1", async () => {
    const root = await project(`export default { realtime: { fullDocument: "lookup" } }`)
    const { errors, out } = capture()
    expect(await run(["config", "print"], {}, out, root)).toBe(1)
    expect(errors[0]).toContain("realtime.fullDocument")
    expect(errors[0]).toContain("mongodb.uri")
  })

  it("refuses stray arguments and bad ports before doing anything", async () => {
    const stray = capture()
    expect(await run(["init", "now"], {}, stray.out)).toBe(1)
    expect(stray.errors).toEqual(["Unexpected argument now for init"])
    const badPort = capture()
    expect(await run(["dev", "--with-mongo", "--mongo-port", "x"], {}, badPort.out)).toBe(1)
    expect(badPort.errors).toEqual(["--mongo-port needs a port number between 0 and 65535"])
    const flag = capture()
    expect(await run(["indexes", "advise", "--yes"], {}, flag.out)).toBe(1)
    expect(flag.errors).toEqual(["Unknown option --yes for indexes advise."])
  })

  it("prints the version of the package with --version, alone or after a command", async () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string }
    const alone = capture()
    expect(await run(["--version"], {}, alone.out)).toBe(0)
    expect(alone.lines).toEqual([manifest.version])
    const after = capture()
    expect(await run(["doctor", "--version"], {}, after.out)).toBe(0)
    expect(after.lines).toEqual([manifest.version])
  })

  it("lists the commands in the usage", async () => {
    const { lines, out } = capture()
    expect(await run(["--help"], {}, out)).toBe(0)
    for (const command of ["init", "dev", "realtime enable-images", "indexes create"])
      expect(lines[0]).toContain(`  ${command} `)
  })

  it("shows usage for unknown commands", async () => {
    const { errors, out } = capture()
    expect(await run(["frobnicate"], {}, out)).toBe(1)
    expect(errors[0]).toContain("Unknown command: frobnicate\n")
    const typo = capture()
    expect(await run(["doctr"], {}, typo.out)).toBe(1)
    expect(typo.errors[0]).toContain("Unknown command: doctr. Did you mean canopy doctor?")
  })

  const withMongo = MONGODB_URI === undefined ? it.skip : it

  withMongo("runs policy tests against MongoDB too, and the two backends agree", async () => {
    const { lines, errors, out } = capture()
    const code = await run(
      ["policies", "test", "--dir", fixture("good"), "--mongodb-uri", MONGODB_URI ?? ""],
      {},
      out,
    )
    expect(errors).toEqual([])
    expect(code).toBe(0)
    expect(lines.at(-1)).toBe("11 cases on memory and mongodb, 0 failed")
  })

  withMongo("doctor reports a healthy replica set", async () => {
    const { lines, errors, out } = capture()
    const code = await run(
      [
        "doctor",
        "--mongodb-uri",
        MONGODB_URI ?? "",
        "--database",
        "canopy_doctor",
        "--dir",
        fixture("good"),
      ],
      {},
      out,
    )
    expect(errors).toEqual([])
    expect(code).toBe(0)
    expect(lines.some((line) => line.startsWith("ok    topology: replica set"))).toBe(true)
    expect(lines.some((line) => line.includes("change streams can be opened"))).toBe(true)
  })
})
