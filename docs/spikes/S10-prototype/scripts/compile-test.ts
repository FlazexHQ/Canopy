import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Checks that `bun build --compile` embeds the addon. A generated entry imports the host's `.node` file by a
 * literal path (the only form the bundler embeds), registers it for the loader, and runs one match; the
 * executable is written to an empty temporary folder, outside any `node_modules`, and runs there. The
 * loader alone is not enough, since
 * its `require` calls are computed at run time. Run with Bun after `bun scripts/build.ts`.
 */
const root = fileURLToPath(new URL("..", import.meta.url))
const work = join(root, "packs", "compile")
const suffixes: Record<string, string> = {
  "win32-x64": "win32-x64-msvc",
  "win32-arm64": "win32-arm64-msvc",
  "darwin-x64": "darwin-x64",
  "darwin-arm64": "darwin-arm64",
  "linux-x64": "linux-x64-gnu",
  "linux-arm64": "linux-arm64-gnu",
}
const suffix = suffixes[`${process.platform}-${process.arch}`]
if (suffix === undefined) throw new Error(`no target for ${process.platform} ${process.arch}`)
const addon = join(root, `canopy-native.${suffix}.node`).replaceAll("\\", "/")
const loader = join(root, "index.js").replaceAll("\\", "/")

rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const run = mkdtempSync(join(tmpdir(), "s10-compiled-"))
writeFileSync(
  join(work, "register.ts"),
  `import binding from ${JSON.stringify(addon)}\n;(globalThis as Record<symbol, unknown>)[Symbol.for("canopy.native.binding")] = binding\n`,
)
writeFileSync(
  join(work, "entry.ts"),
  `import "./register.ts"
import { Filter, engine, loadedFrom } from ${JSON.stringify(loader)}
const document = new Uint8Array([12, 0, 0, 0, 16, 97, 0, 1, 0, 0, 0, 0])
const matched = Filter.fromEjson('{"a": {"$gte": 1}}').matches(document)
const refused = Filter.fromEjson('{"a": {"$lt": 1}}').matches(document)
if (!matched || refused) throw new Error("wrong match result")
process.stdout.write(\`engine \${engine()} from \${loadedFrom}\\n\`)
`,
)
const executable = join(run, process.platform === "win32" ? "s10.exe" : "s10")
const built = spawnSync(
  process.execPath,
  ["build", "--compile", "--minify", join(work, "entry.ts"), "--outfile", executable],
  { stdio: "inherit" },
)
if (built.status !== 0) throw new Error("bun build --compile failed")
const ran = spawnSync(executable, [], { cwd: run, encoding: "utf8" })
process.stdout.write(`${ran.stdout}${ran.stderr}`)
if (ran.status !== 0 || !ran.stdout.includes("engine native from embedded")) process.exit(1)
