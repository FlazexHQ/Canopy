import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { ConfigError, formatConfig } from "../src/index.ts"
import { findConfig, loadConfig, parseEnvFile } from "../src/load.ts"

const URI = "mongodb://localhost:27017/app?replicaSet=rs0"
const scratch = fileURLToPath(new URL("./.tmp/", import.meta.url))
const dirs: string[] = []

async function project(files: Record<string, string>): Promise<string> {
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, "p-"))
  dirs.push(root)
  for (const [name, text] of Object.entries(files)) {
    const path = join(root, name)
    await mkdir(join(path, ".."), { recursive: true })
    await writeFile(path, text)
  }
  return root
}

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("loadConfig", () => {
  it("finds canopy/canopy.config.ts from a nested directory and resolves paths next to it", async () => {
    const root = await project({
      "canopy/canopy.config.ts": `import { defineConfig, env } from "@canopy/config"
export default defineConfig({
  mongodb: { uri: env("MONGODB_URI") },
  policies: { dir: "./policies" },
  types: { out: "../src/canopy.gen.ts" },
})
`,
      "src/deep/.keep": "",
    })
    const cwd = join(root, "src", "deep")
    expect(await findConfig(cwd)).toBe(join(root, "canopy", "canopy.config.ts"))
    const loaded = await loadConfig({ command: "start", cwd, env: { MONGODB_URI: URI } })
    expect(loaded.file).toBe(join(root, "canopy", "canopy.config.ts"))
    expect(loaded.config.policies).toEqual({ dir: join(root, "canopy", "policies"), watch: true })
    expect(loaded.config.types.out).toBe(join(root, "src", "canopy.gen.ts"))
  })

  it("calls a config function with the mode and the command", async () => {
    const root = await project({
      "canopy.config.mjs": `export default ({ mode, command }) => ({
  mongodb: { uri: "${URI}" },
  server: { nodeId: mode + ":" + command },
})
`,
    })
    const loaded = await loadConfig({
      command: "realtime",
      cwd: root,
      env: { CANOPY_ENV: "production" },
    })
    expect(loaded.config.server.nodeId).toBe("production:realtime")
    expect(loaded.config.environment).toBe("production")
  })

  it("loads env files in order when asked, and real variables still win", async () => {
    const root = await project({
      "canopy.config.mjs": `export default {}`,
      ".env": "MONGODB_URI=mongodb://from-dotenv:27017/app\nPORT=1000\nCANOPY_LOG_LEVEL=debug\n",
      ".env.local": "PORT=2000\n",
      ".env.development": "METRICS_PORT=3000\n",
      ".env.development.local": "# local only\nexport CANOPY_NODE_ID='n9' # comment\n",
      ".env.production": "PORT=9999\n",
    })
    const loaded = await loadConfig({
      command: "start",
      cwd: root,
      env: { CANOPY_LOG_LEVEL: "warn" },
      envFiles: true,
    })
    expect(loaded.config.mongodb.uri).toBe("mongodb://from-dotenv:27017/app")
    expect(loaded.config.server).toMatchObject({ port: 2000, metricsPort: 3000, nodeId: "n9" })
    expect(loaded.config.log.level).toBe("warn")
    const printed = formatConfig(loaded, { sources: true })
    expect(printed).toContain(`server.port = 2000  (PORT from ${join(root, ".env.local")})`)
    expect(printed).toContain('log.level = "warn"  (env CANOPY_LOG_LEVEL)')
  })

  it("ignores env files unless asked", async () => {
    const root = await project({
      "canopy.config.mjs": `export default {}`,
      ".env": `MONGODB_URI=${URI}\n`,
    })
    await expect(loadConfig({ command: "start", cwd: root, env: {} })).rejects.toBeInstanceOf(
      ConfigError,
    )
  })

  it("runs without a config file from variables alone", async () => {
    const root = await project({ "README.md": "no config here" })
    const loaded = await loadConfig({
      command: "realtime",
      cwd: root,
      env: { MONGODB_URI: URI, CANOPY_POLICIES: "policies" },
    })
    expect(loaded.file).toBeUndefined()
    expect(loaded.config.policies).toEqual({ dir: join(root, "policies"), watch: true })
  })

  it("uses an explicit file and explains a missing default export", async () => {
    const root = await project({
      "config/custom.mjs": `export default { mongodb: { uri: "${URI}" }, server: { port: 4321 } }`,
      "config/broken.mjs": `export const config = {}`,
    })
    const loaded = await loadConfig({
      command: "start",
      cwd: root,
      file: "config/custom.mjs",
      env: {},
    })
    expect(loaded.config.server.port).toBe(4321)
    await expect(
      loadConfig({ command: "start", cwd: root, file: "config/broken.mjs", env: {} }),
    ).rejects.toThrow("must export its config as default")
  })
})

describe("parseEnvFile", () => {
  it("parses quotes, comments, export and escapes", () => {
    const parsed = parseEnvFile(
      [
        "# comment",
        "A=1",
        "export B = two words ",
        'C="quoted # not a comment"',
        "D='single'",
        'E="line\\nbreak"',
        "F=value # trailing comment",
        "not a pair",
        "G=",
        'H="say \\"hi\\"" # trailing',
      ].join("\n"),
    )
    expect(Object.fromEntries(parsed)).toEqual({
      A: "1",
      B: "two words",
      C: "quoted # not a comment",
      D: "single",
      E: "line\nbreak",
      F: "value",
      G: "",
      H: 'say "hi"',
    })
  })
})
