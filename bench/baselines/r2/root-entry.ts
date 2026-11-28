import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { brotliCompressSync, constants, gzipSync } from "node:zlib"

/**
 * Builds the R0 live query app (`bench/baselines/r0/app/main.ts`) against a Canopy.js source tree with code
 * splitting, as a production browser build, and reports the size of the entry chunk, the lazily loaded
 * chunks and the Wasm assets of the client core.
 *
 *   bun bench/baselines/r2/root-entry.ts --src ../Canopy.js/src --out <dir>
 *
 * `--src` is the `src` folder of a Canopy.js checkout; the app's `canopy.js` import is pointed at its
 * `client/index.ts`. The Wasm files are copied next to the chunks under `core/wasm`, where the loader
 * resolves them, so `--out` can be served as is.
 */

function argument(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (value === undefined) throw new Error(`${name} is required`)
  return resolve(value)
}

function sizes(bytes: Uint8Array): { raw: number; gzip: number; brotli: number } {
  return {
    raw: bytes.byteLength,
    gzip: gzipSync(bytes, { level: 9 }).byteLength,
    brotli: brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY },
    }).byteLength,
  }
}

const src = argument("--src")
const out = argument("--out")
const app = new URL("../r0/app/", import.meta.url)
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const main = readFileSync(new URL("main.ts", app), "utf8").replace(
  'from "canopy.js"',
  `from ${JSON.stringify(join(src, "client", "index.ts").replaceAll("\\", "/"))}`,
)
const entry = join(out, "main.ts")
writeFileSync(entry, main)
const result = await Bun.build({
  entrypoints: [entry],
  outdir: join(out, "dist"),
  target: "browser",
  minify: true,
  splitting: true,
  naming: { entry: "app.js", chunk: "[name]-[hash].js", asset: "[name]-[hash].[ext]" },
})
if (!result.success) throw new AggregateError(result.logs, "The build failed")
rmSync(entry)
const report: Record<string, { raw: number; gzip: number; brotli: number }> = {}
for (const output of result.outputs) {
  report[relative(out, output.path).replaceAll("\\", "/")] = sizes(
    new Uint8Array(await output.arrayBuffer()),
  )
}
const wasm = join(src, "core", "wasm")
for (const module of ["client", "transforms"]) {
  const dir = join(wasm, module)
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    continue
  }
  for (const name of entries.filter((file) => file.endsWith(".wasm"))) {
    const bytes = readFileSync(join(dir, name))
    const target = join(out, "core", "wasm", module)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, name), bytes)
    report[`core/wasm/${module}/${name}`] = sizes(bytes)
  }
}
const total = Object.entries(report).reduce(
  (sum, [name, size]) => (statSync(join(out, name)).isFile() ? sum + size.brotli : sum),
  0,
)
process.stdout.write(`${JSON.stringify({ outputs: report, brotliTotal: total }, null, 2)}\n`)
