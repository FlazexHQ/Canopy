import { equal, match } from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { hostTarget } from "../../native/src/targets.ts"
import { gatewayPackage, packagedGateway } from "../src/gateway-package.ts"
import { STUDIO_PACKAGE } from "./canopyd-packages.ts"

/**
 * Installs this machine's platform tarball from `pack-canopyd.ts` with npm and checks help for both
 * binaries, the CLI version and Studio HTTP serving. Runs on Node.js 24 or newer, including on Alpine Linux:
 *
 *   node packages/realtime/scripts/smoke-canopyd.ts [packs folder] [scratch parent]
 */
interface Packed {
  readonly name: string
  readonly file: string
}

const folder = resolve(process.argv[2] ?? fileURLToPath(new URL("../packs", import.meta.url)))
const packs = JSON.parse(readFileSync(join(folder, "packs.json"), "utf8")) as Packed[]
const target = hostTarget()
if (target === undefined)
  throw new Error(`No prebuilt canopyd for ${process.platform} ${process.arch}`)
const name = gatewayPackage(target)
const packed = packs.find((entry) => entry.name === name)
if (packed === undefined) throw new Error(`${folder} has no ${name}`)
const launcher = packs.find((entry) => entry.name === "@canopy/cli")
if (launcher === undefined) throw new Error(`${folder} has no @canopy/cli`)
const studio = packs.find((entry) => entry.name === STUDIO_PACKAGE)
if (studio === undefined) throw new Error(`${folder} has no ${STUDIO_PACKAGE}`)

function run(binary: string, ...args: string[]): string {
  const env = { ...process.env }
  delete env["CANOPY_BINARY"]
  const result = spawnSync(binary, args, { encoding: "utf8", env })
  if (result.status !== 0)
    throw new Error(
      `${binary} ${flag} exited with ${String(result.status ?? result.error)}\n${result.stderr}`,
    )
  return result.stdout + result.stderr
}

async function checkStudio(binary: string, index: string, cwd: string): Promise<void> {
  const child = spawn(binary, [], {
    cwd,
    env: {
      ...process.env,
      CANOPY_ROLE: "studio",
      CANOPY_STUDIO_DIR: dirname(index),
      MONGODB_URI: "invalid",
      HOST: "127.0.0.1",
      PORT: "0",
    },
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  })
  const closed = once(child, "close")
  const lines = createInterface({ input: child.stdout })
  try {
    const [line] = await Promise.race([
      once(lines, "line", { signal: AbortSignal.timeout(10_000) }),
      closed.then(([code, signal]) => {
        throw new Error(`canopyd exited before listening (${code ?? signal})`)
      }),
    ])
    const { t, port } = JSON.parse(line) as { t: string; port: number }
    equal(t, "listening")
    const origin = `http://127.0.0.1:${port}`
    const response = await fetch(origin, { signal: AbortSignal.timeout(10_000) })
    equal(response.status, 200)
    equal(response.url, `${origin}/studio/`)
    match(response.headers.get("content-type") ?? "", /^text\/html\b/)
    const oracle = JSON.parse(
      readFileSync(new URL("../../../conformance/http/studio/bun.json", import.meta.url), "utf8"),
    ) as { cases: { id: string; response: { headers: Record<string, string> } }[] }
    const csp = oracle.cases.find(({ id }) => id === "index")?.response.headers[
      "content-security-policy"
    ]
    if (!csp) throw new Error("Studio index CSP is missing from the HTTP oracle")
    equal(response.headers.get("content-security-policy"), csp)
    equal(await response.text(), readFileSync(index, "utf8"))
  } finally {
    lines.close()
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await closed
  }
}

const scratch = mkdtempSync(join(resolve(process.argv[3] ?? tmpdir()), "canopyd-smoke-"))
try {
  const manifest = join(scratch, "package.json")
  writeFileSync(manifest, '{"private":true}\n')
  const npm = process.platform === "win32" ? process.execPath : "npm"
  const npmArgs =
    process.platform === "win32"
      ? [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]
      : []
  const install = spawnSync(
    npm,
    [
      ...npmArgs,
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-save",
      "--update-notifier=false",
      "--cache",
      join(scratch, "npm-cache"),
      join(folder, launcher.file),
      join(folder, packed.file),
      join(folder, studio.file),
    ],
    { cwd: scratch, stdio: "inherit" },
  )
  if (install.error !== undefined) throw install.error
  if (install.status !== 0) throw new Error(`npm install failed with ${String(install.status)}`)
  const binary = packagedGateway(target, scratch)
  if (binary === undefined) throw new Error(`${name} does not resolve from ${scratch}`)
  const cli = createRequire(manifest).resolve(`${name}/canopy`)
  const index = createRequire(cli).resolve(`${STUDIO_PACKAGE}/index.html`)
  const launcherManifest = createRequire(manifest).resolve("@canopy/cli/package.json")
  const { bin } = JSON.parse(readFileSync(launcherManifest, "utf8")) as { bin: { canopy: string } }
  const entry = join(dirname(launcherManifest), bin.canopy)
  match(run(binary, "--help"), /Usage: canopyd\b/)
  match(run(process.execPath, entry, "--version").trim(), /^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/)
  match(run(process.execPath, entry, "--help"), /Usage: canopy\s/)
  await checkStudio(binary, index, scratch)
  process.stdout.write(`${name} passed canopy --version, canopy --help and canopyd --help\n`)
  process.stdout.write(
    "Studio served the installed page with the expected CSP after redirecting /\n",
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
