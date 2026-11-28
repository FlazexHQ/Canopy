import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, expect, it } from "vitest"

const target = fileURLToPath(new URL("../../../target", import.meta.url))
const env = { ...process.env }
delete env["CANOPY_BINARY"]
delete env["NODE_OPTIONS"]
let dir: string
let launcher: string
let preload: string

beforeAll(() => {
  mkdirSync(target, { recursive: true })
  dir = mkdtempSync(join(target, "cli-launcher-"))
  launcher = join(dir, "launcher.mjs")
  preload = join(dir, "platform.cjs")
  writeFileSync(
    preload,
    `Object.defineProperties(process, {
      platform: { value: process.env.TEST_OS },
      arch: { value: process.env.TEST_CPU },
    })
    process.report.getReport = () => ({ header: {
      glibcVersionRuntime: process.env.TEST_LIBC === "glibc" ? "2.17" : undefined,
    } })`,
  )
  const prebuilt = process.env["CANOPY_TEST_LAUNCHER"]
  if (prebuilt !== undefined) {
    copyFileSync(prebuilt, launcher)
    return
  }
  const build = fileURLToPath(new URL("../build-launcher.ts", import.meta.url))
  const result = spawnSync("bun", [build, dir], { encoding: "utf8" })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
})

afterAll(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
})

it.each([
  ["win32", "x64", "", "win32-x64-msvc"],
  ["win32", "arm64", "", "win32-arm64-msvc"],
  ["darwin", "x64", "", "darwin-x64"],
  ["darwin", "arm64", "", "darwin-arm64"],
  ["linux", "x64", "glibc", "linux-x64-gnu"],
  ["linux", "x64", "musl", "linux-x64-musl"],
  ["linux", "arm64", "glibc", "linux-arm64-gnu"],
  ["linux", "arm64", "musl", "linux-arm64-musl"],
])("names the missing platform package for %s %s %s", (os, cpu, libc, suffix) => {
  const result = spawnSync("node", ["--require", preload, launcher, "--help"], {
    env: { ...env, TEST_OS: os, TEST_CPU: cpu, TEST_LIBC: libc },
    encoding: "utf8",
  })
  expect(result.status).toBe(1)
  expect(result.stdout).toBe("")
  expect(result.stderr.trim()).toBe(
    `canopy: The platform package @canopy/canopyd-${suffix} is missing. Reinstall @canopy/cli with optional dependencies enabled. Set CANOPY_BINARY to use a local executable.`,
  )
})

it("reports an unsupported platform", () => {
  const result = spawnSync("node", ["--require", preload, launcher, "--help"], {
    env: { ...env, TEST_OS: "freebsd", TEST_CPU: "x64" },
    encoding: "utf8",
  })
  expect(result.status).toBe(1)
  expect(result.stderr.trim()).toBe(
    "canopy: There is no prebuilt executable for freebsd x64. Set CANOPY_BINARY to use a local executable.",
  )
})

it.skipIf(process.platform === "win32").each(["SIGINT", "SIGTERM"] as const)(
  "forwards %s to the child and propagates its exit code",
  async (signal) => {
    const fixture = join(dir, signal)
    writeFileSync(
      fixture,
      `#!/usr/bin/env node
process.on(${JSON.stringify(signal)}, () => process.exit(42))
setTimeout(() => process.exit(99), 5000)
process.stdout.write("ready\\n")
`,
      { mode: 0o755 },
    )
    const child = spawn("node", [launcher], {
      env: { ...env, CANOPY_BINARY: fixture },
      stdio: ["ignore", "pipe", "inherit"],
    })
    const closed = once(child, "close")
    try {
      const ready = once(child.stdout, "data", { signal: AbortSignal.timeout(3000) })
      const [line] = await Promise.race([ready, closed])
      expect(String(line).trim()).toBe("ready")
      expect(child.kill(signal)).toBe(true)
      expect(await closed).toEqual([42, null])
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
      await closed
    }
  },
)

it("passes arguments and Studio settings to an override executable", () => {
  const studio = join(dir, "node_modules", "@canopy", "studio-assets")
  mkdirSync(studio, { recursive: true })
  writeFileSync(join(studio, "index.html"), "<html></html>")
  const script = join(dir, "print-settings.cjs")
  writeFileSync(
    script,
    "console.log(JSON.stringify([process.env.CANOPY_STUDIO_DIR, ...process.argv.slice(2)]))",
  )
  const inherited: NodeJS.ProcessEnv = { ...env, CANOPY_BINARY: "node" }
  delete inherited["CANOPY_STUDIO_DIR"]
  const args = [launcher, script, "argument with spaces"]
  for (const expected of [studio, "custom Studio"]) {
    const result = spawnSync("node", args, {
      env: expected === studio ? inherited : { ...inherited, CANOPY_STUDIO_DIR: expected },
      encoding: "utf8",
    })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([expected, "argument with spaces"])
  }
})
