import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const env = process.env
if (!env["CANOPY_TEST_MONGODB_URI"] || !(env["CANOPYD_BIN"] || env["CANOPY_GATEWAY_BIN"])) {
  throw new Error("Set CANOPY_TEST_MONGODB_URI and CANOPYD_BIN")
}

const root = fileURLToPath(new URL("../../../", import.meta.url))
let ran = 0
for (const [driver, binary, args] of [
  ["Python", "python", ["--version"]],
  ["Go", env["CANOPY_WIRE_GO"] ?? "go", ["version"]],
  ["Java", env["CANOPY_WIRE_JAVA"] ?? "java", ["-version"]],
] as const) {
  const probe = spawnSync(binary, args, { encoding: "utf8", timeout: 10_000, windowsHide: true })
  if (probe.error && "code" in probe.error && probe.error.code === "ENOENT") {
    process.stdout.write(`Skipping ${driver}: ${binary} is unavailable\n`)
    continue
  }
  if (probe.error || probe.status !== 0) {
    throw new Error(`Could not check ${driver}: ${probe.stderr}`, { cause: probe.error })
  }
  process.stdout.write(`${driver}: ${(probe.stdout || probe.stderr).trim().split("\n")[0]}\n`)
  const result = spawnSync(
    process.execPath,
    ["node_modules/vitest/vitest.mjs", "run", "--project", "server", "wire-unified.test.ts"],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...env, CANOPY_WIRE_TEST_DRIVER: driver },
      windowsHide: true,
    },
  )
  if (result.error) throw result.error
  if (result.status !== 0) process.exitCode = 1
  ran++
}
if (ran === 0) process.stdout.write("No external driver toolchains available\n")
