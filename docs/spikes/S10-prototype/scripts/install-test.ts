import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { extname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Installs `@canopy-s10/native` from a registry into a fresh project with one package manager, lists which of
 * its platform packages the manager installed, and runs `scripts/smoke.mjs` (the MongoDB filter vectors)
 * through the installed package on each runtime given. With `--platform freebsd`, the manager is told to
 * install for a platform that has no prebuilt package, which must leave only the WebAssembly fallback.
 *
 *   node scripts/install-test.ts --registry http://127.0.0.1:4873/ --pm npm --command <npm-cli.js>
 *     [--yarn-linker pnp|node-modules] [--platform freebsd] [--runtimes node,bun,<deno path>]
 *
 * `--pm yarn1` runs Yarn 1, which reads the registry from `.npmrc` and has no platform override.
 *
 * `--command` is the package manager's executable or its JavaScript entry point (run with this runtime), so
 * no shell is needed for the `.cmd` shims on Windows.
 */
const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i]?.replace(/^--/, "") ?? "", process.argv[i + 1] ?? "")
}
const registry = args.get("registry") ?? "http://127.0.0.1:4873/"
const pm = args.get("pm") ?? "npm"
const command = args.get("command") ?? pm
const linker = args.get("yarn-linker") ?? "node-modules"
const foreign = args.get("platform") === "freebsd"
const runtimes = (args.get("runtimes") ?? "node").split(",")
const expected = foreign ? "wasm" : "native"

const here = fileURLToPath(new URL(".", import.meta.url))
const vectors = join(here, "..", "..", "..", "..", "crates", "canopy-matcher", "tests", "vectors", "filters.json")
const project = mkdtempSync(join(tmpdir(), `s10-${pm}-`))
const host = new URL(registry).host

const manifest: Record<string, unknown> = {
  name: "s10-install-test",
  private: true,
  type: "module",
  dependencies: { "@canopy-s10/native": "0.0.0" },
}
writeFileSync(join(project, ".npmrc"), `registry=${registry}\n`)
if (pm === "yarn") {
  const architectures = foreign ? "supportedArchitectures:\n  os: [freebsd]\n  cpu: [x64]\n" : ""
  writeFileSync(
    join(project, ".yarnrc.yml"),
    `npmRegistryServer: "${registry}"\nunsafeHttpWhitelist: ["${host.split(":")[0]}"]\nnodeLinker: ${linker}\nenableTelemetry: false\nnpmPreapprovedPackages: ["@canopy-s10/*"]\n${architectures}`,
  )
  writeFileSync(join(project, "yarn.lock"), "")
}
if (pm === "pnpm" && foreign) {
  writeFileSync(
    join(project, "pnpm-workspace.yaml"),
    "supportedArchitectures:\n  os: [freebsd]\n  cpu: [x64]\n",
  )
}
writeFileSync(join(project, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
copyFileSync(join(here, "smoke.mjs"), join(project, "smoke.mjs"))
copyFileSync(vectors, join(project, "filters.json"))

function spawn(executable: string, argv: readonly string[]) {
  const script = [".js", ".cjs", ".mjs"].includes(extname(executable))
  const env = { ...process.env, npm_config_registry: registry, YARN_ENABLE_IMMUTABLE_INSTALLS: "false" }
  return script
    ? spawnSync(process.execPath, [executable, ...argv], { cwd: project, encoding: "utf8", env })
    : spawnSync(executable, argv, { cwd: project, encoding: "utf8", env })
}

const install: Record<string, readonly string[]> = {
  npm: ["install", "--no-audit", "--no-fund", ...(foreign ? ["--os=freebsd", "--cpu=x64"] : [])],
  pnpm: ["install"],
  yarn: ["install"],
  yarn1: ["install", "--non-interactive"],
  bun: ["install", ...(foreign ? ["--os=freebsd", "--cpu=x64"] : [])],
}
const started = performance.now()
const installed = spawn(command, install[pm] ?? ["install"])
const seconds = ((performance.now() - started) / 1000).toFixed(1)
if (installed.status !== 0) {
  process.stderr.write(`${installed.stdout}\n${installed.stderr}\n`)
  throw new Error(`${pm} install failed in ${project}`)
}

function platformPackages(): string[] {
  const found = new Set<string>()
  const scoped = join(project, "node_modules", "@canopy-s10")
  if (existsSync(scoped)) for (const name of readdirSync(scoped)) found.add(name)
  const store = join(project, "node_modules", ".pnpm")
  if (existsSync(store)) {
    for (const name of readdirSync(store)) {
      const match = /^@canopy-s10\+(native[^@]*)@/.exec(name)
      if (match?.[1]) found.add(match[1])
    }
  }
  const pnp = join(project, ".pnp.cjs")
  if (existsSync(pnp)) {
    const names = new Set<string>()
    for (const match of readFileSync(pnp, "utf8").matchAll(/"@canopy-s10\/(native-[a-z0-9-]+)"/g)) {
      if (match[1]) names.add(match[1])
    }
    const probe = `const pnp = require("pnpapi"); const fs = require("fs"); const path = require("path");
      const root = path.dirname(require.resolve("@canopy-s10/native/package.json"));
      for (const name of ${JSON.stringify([...names])}) {
        const location = pnp.resolveToUnqualified("@canopy-s10/" + name, root + path.sep);
        if (location && fs.existsSync(path.join(location, "package.json"))) console.log(name);
      }`
    const present = spawn(command, ["node", "-e", probe.replace(/\s*\n\s*/g, " ")])
    if (present.status !== 0) process.stderr.write(present.stderr)
    for (const name of present.stdout.split(/\r?\n/)) if (name.trim()) found.add(name.trim())
  }
  found.delete("native")
  return [...found].sort()
}

const packages = platformPackages()
const lines = [`${pm}${pm === "yarn" ? ` (${linker})` : ""}${foreign ? " for freebsd x64" : ""}: installed in ${seconds} s, platform packages [${packages.join(", ")}]`]
let failed = false
const wanted = foreign ? ["native-wasm32-wasi"] : ["native-wasm32-wasi", "native-win32-x64-msvc"]
if (process.platform === "win32" && process.arch === "x64" && packages.join(",") !== wanted.join(",")) {
  lines.push(`  expected exactly [${wanted.join(", ")}]`)
  failed = true
}

const smokeArgs = ["smoke.mjs", "--module", "@canopy-s10/native", "--vectors", "filters.json", "--expect", expected]
for (const runtime of runtimes) {
  if (pm === "yarn" && linker === "pnp" && runtime !== "node") {
    lines.push(`  ${runtime.split(/[\/]/).pop()}: skipped, Plug'n'Play runs through Node's loader only`)
    continue
  }
  const result =
    pm === "yarn" && linker === "pnp"
      ? spawn(command, ["node", ...smokeArgs])
      : runtime.toLowerCase().includes("deno")
      ? spawnSync(runtime, ["run", "--node-modules-dir=manual", "--allow-read", "--allow-env", ...(foreign ? [] : ["--allow-ffi"]), ...smokeArgs], { cwd: project, encoding: "utf8" })
      : spawnSync(runtime === "node" ? process.execPath : runtime, smokeArgs, { cwd: project, encoding: "utf8" })
  const output = `${result.stdout}${result.stderr}`.trim().split("\n")
  lines.push(`  ${runtime.split(/[\\/]/).pop()}: ${result.status === 0 ? "ok" : "FAILED"}, ${output.at(-1)}`)
  if (result.status !== 0) {
    failed = true
    lines.push(...output.slice(0, 12).map((text) => `    ${text}`))
  }
}
process.stdout.write(`${lines.join("\n")}\n  project: ${project}\n`)
if (failed) process.exit(1)
