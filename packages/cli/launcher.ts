#!/usr/bin/env node
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { constants } from "node:os"
import { dirname } from "node:path"
import { hostTarget } from "../native/src/targets.ts"
import { ensureExecutable, gatewayPackage } from "../realtime/src/gateway-package.ts"

const require = createRequire(import.meta.url)
const target = hostTarget()
const packageName = target === undefined ? undefined : gatewayPackage(target)

function resolveOptional(specifier: string): string | undefined {
  try {
    return require.resolve(specifier)
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "MODULE_NOT_FOUND" || error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED")
    )
      return undefined
    throw error
  }
}

const override = process.env["CANOPY_BINARY"]
const studioOverride = process.env["CANOPY_STUDIO_DIR"]
const binary =
  override || (packageName === undefined ? undefined : resolveOptional(`${packageName}/canopy`))
if (binary === undefined) {
  const detail =
    packageName === undefined
      ? `There is no prebuilt executable for ${process.platform} ${process.arch}.`
      : `The platform package ${packageName} is missing. Reinstall @canopy/cli with optional dependencies enabled.`
  process.stderr.write(`canopy: ${detail} Set CANOPY_BINARY to use a local executable.\n`)
  process.exit(1)
}

const env = { ...process.env }
if (studioOverride === undefined) {
  const studio = resolveOptional("@canopy/studio-assets/index.html")
  if (studio !== undefined) env["CANOPY_STUDIO_DIR"] = dirname(studio)
}
if (!override && process.platform !== "win32") ensureExecutable(binary)

const child = spawn(binary, process.argv.slice(2), { env, stdio: "inherit" })
const signals = ["SIGINT", "SIGTERM", "SIGBREAK"] as const
const forward = (signal: (typeof signals)[number]) => {
  // Windows delivers console events to both processes. child.kill would terminate the child.
  if (process.platform !== "win32" || signal === "SIGTERM") child.kill(signal)
}
for (const signal of signals) {
  if (signal !== "SIGBREAK" || process.platform === "win32") process.on(signal, forward)
}
child.once("error", (error) => {
  process.stderr.write(`canopy: Could not start ${binary}: ${error.message}\n`)
  process.exitCode = 1
})
child.once("close", (code, signal) => {
  for (const name of signals) process.off(name, forward)
  if (signal === null) {
    process.exitCode = code ?? 1
  } else {
    process.exitCode = 128 + constants.signals[signal]
    if (process.platform !== "win32") process.kill(process.pid, signal)
  }
})
