import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const run = promisify(execFile)
const probes = fileURLToPath(new URL("../../../bench/workloads/wire/s13-drivers/", import.meta.url))

export async function runWireDriver(
  driver: string,
  fixture: {
    url: string
    token: string
    database: string
    collectionName: string
    operation: unknown
  },
): Promise<unknown> {
  const { url, token, database, collectionName, operation } = fixture
  const scratch = await mkdtemp(join(tmpdir(), "canopy-wire-"))
  try {
    const input = join(scratch, "input.json")
    const result = join(scratch, "result.json")
    await writeFile(input, JSON.stringify({ operation, result }))
    const env = {
      ...process.env,
      CANOPY_S13_URL: url,
      CANOPY_S13_TOKEN: token,
      CANOPY_S13_CRUD_CASE: input,
      CANOPY_S13_DATABASE: database,
      CANOPY_S13_COLLECTION: collectionName,
    }
    const tools = process.env["CANOPY_WIRE_DRIVER_TOOLS"]
    switch (driver) {
      case "Python":
        await run("python", [join(probes, "probe.py")], {
          env: { ...env, ...(tools === undefined ? {} : { PYTHONPATH: join(tools, "python") }) },
          timeout: 60_000,
        })
        break
      case "Go":
        await run(process.env["CANOPY_WIRE_GO"] ?? "go", ["run", "-mod=readonly", "."], {
          cwd: join(probes, "go"),
          env,
          timeout: 90_000,
        })
        break
      case "Java":
        if (tools === undefined)
          throw new Error("Set CANOPY_WIRE_DRIVER_TOOLS to the Java driver JAR directory")
        await run(
          process.env["CANOPY_WIRE_JAVA"] ?? "java",
          ["-cp", join(tools, "*"), join(probes, "Probe.java")],
          {
            env,
            timeout: 60_000,
          },
        )
        break
      default:
        throw new Error(`Unsupported driver ${driver}`)
    }
    return JSON.parse(await readFile(result, "utf8")) as unknown
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
