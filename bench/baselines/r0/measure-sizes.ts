import { execSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { brotliCompressSync, constants, gzipSync } from "node:zlib"

const entries = [
  { name: "root_entry_app", file: "bench/baselines/r0/app/main.ts" },
  { name: "policy", file: "bench/baselines/r0/entries/policy.ts" },
  { name: "schema", file: "bench/baselines/r0/entries/schema.ts" },
  { name: "config", file: "bench/baselines/r0/entries/config.ts" },
  { name: "matcher_full", file: "bench/baselines/r0/entries/matcher.ts" },
  { name: "matcher_lite", file: "bench/baselines/r0/entries/matcher-lite.ts" },
  { name: "query", file: "bench/baselines/r0/entries/query.ts" },
  { name: "ejson", file: "bench/baselines/r0/entries/ejson.ts" },
  { name: "protocol", file: "bench/baselines/r0/entries/protocol.ts" },
]

mkdirSync("bench/baselines/r0/dist", { recursive: true })

const results: Record<string, { raw: number; gzip: number; brotli: number }> = {}

for (const entry of entries) {
  const outFile = join("bench/baselines/r0/dist", `${entry.name}.js`)
  execSync(`bun build --minify --target=browser ${entry.file} --outfile ${outFile}`, {
    stdio: "inherit",
  })
  const content = readFileSync(outFile)
  const raw = content.byteLength
  const gzip = gzipSync(content, { level: 9 }).byteLength
  const brotli = brotliCompressSync(content, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
    },
  }).byteLength

  results[entry.name] = { raw, gzip, brotli }
}

writeFileSync("bench/baselines/r0/dist/sizes.json", `${JSON.stringify(results, null, 2)}\n`)
