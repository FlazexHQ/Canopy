import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const BIN = fileURLToPath(new URL("../src/bin/canopy-realtime.ts", import.meta.url))

describe("canopy-realtime with built in auth", () => {
  it("refuses to start and points at the server's JWKS instead", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canopy-sidecar-"))
    try {
      const file = join(dir, "canopy.config.mjs")
      await writeFile(
        file,
        'export default { mongodb: { uri: "mongodb://localhost:27017/app?replicaSet=rs0" }, auth: { kind: "builtin" } }\n',
      )
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => !name.startsWith("CANOPY_") && name !== "MONGODB_URI",
        ),
      )
      const child = spawn(
        process.execPath,
        ["--conditions=@canopy/source", BIN, "--config", file],
        {
          cwd: dir,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      )
      let output = ""
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString()
      })
      const code = await new Promise<number | null>((resolve) => child.once("exit", resolve))
      expect(code).toBe(1)
      expect(output).toContain("built in auth runs in the canopy server")
      expect(output).toContain("/auth/v1/.well-known/jwks.json")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
