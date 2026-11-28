import assert from "node:assert/strict"
import { once } from "node:events"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { brotliCompressSync, constants, gzipSync } from "node:zlib"
import { EJSON, serialize } from "bson"
import { canonicalString, parse } from "../../../packages/protocol/src/ejson.ts"
import { benchDocument, SCENARIOS } from "../../workloads/matcher/scenarios.ts"

const root = new URL("../../../", import.meta.url)
const generated = new URL("packages/wasm/generated/", root)
const runs = 50
const modules = ["client", "transforms", "authoring"]

function summary(values) {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return {
    median: (sorted[middle - 1] + sorted[middle]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
  }
}

function size(bytes) {
  return {
    raw: bytes.length,
    gzip: gzipSync(bytes, { level: 9 }).length,
    brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  }
}

function sections(bytes) {
  let offset = 8
  const sizes = {}
  while (offset < bytes.length) {
    const kind = bytes[offset++]
    let length = 0
    let shift = 0
    let digit
    do {
      digit = bytes[offset++]
      length += (digit & 127) * 2 ** shift
      shift += 7
    } while (digit & 128)
    assert.ok(offset + length <= bytes.length)
    sizes[kind] = (sizes[kind] ?? 0) + length
    offset += length
  }
  return sizes
}

function uniqueModule(bytes, run) {
  return Buffer.concat([bytes, Buffer.from([0, 5, 3, 114, 117, 110, run])])
}

function matcher(core) {
  const docs = Array.from({ length: 1000 }, (_, i) => benchDocument(i))
  const page = core.DocumentPage.fromBson(Buffer.concat(docs.map((doc) => serialize(doc))))
  try {
    return Object.fromEntries(
      Object.entries(SCENARIOS).map(([name, { filter, handWritten }]) => {
        const compiled = core.Filter.fromEjson(EJSON.stringify(filter, { relaxed: false }))
        try {
          const check = () => {
            let matches = 0
            for (const decision of page.matchFilter(compiled)) {
              if (decision === 2) throw new Error(`Undecided in ${name}`)
              matches += decision
            }
            return matches
          }
          const expected = docs.filter(handWritten).length
          for (let i = 0; i < 30; i++) assert.equal(check(), expected)
          const timings = []
          for (let round = 0; round < 7; round++) {
            const start = performance.now()
            let total = 0
            for (let i = 0; i < 100; i++) total += check()
            timings.push((performance.now() - start) * 10)
            assert.equal(total, 100 * expected)
          }
          return [name, { nsPerDoc: Math.min(...timings), matches: expected }]
        } finally {
          compiled.free()
        }
      }),
    )
  } finally {
    page.free()
  }
}

async function frameCodec(core, fallback) {
  const url = new URL("conformance/protocol/07-typed-values.json", root)
  const fixture = JSON.parse(await readFile(url, "utf8"))
  const frames = fixture.steps
    .flatMap((step) => step.server ?? [])
    .map((frame) => JSON.stringify(frame))
  const typescript = (text) => canonicalString(parse(text))
  const expected = frames.map(typescript)
  return Object.fromEntries(
    Object.entries({
      typescript,
      wasm: core.canonicalEjson,
      wasm2js: fallback.canonicalEjson,
    }).map(([name, codec]) => {
      assert.deepEqual(frames.map(codec), expected)
      const measure = (rounds) => {
        let length = 0
        const start = performance.now()
        for (let i = 0; i < rounds; i++) {
          for (const frame of frames) length += codec(frame).length
        }
        assert.equal(length, rounds * expected.reduce((total, text) => total + text.length, 0))
        return ((performance.now() - start) * 1000) / (rounds * frames.length)
      }
      measure(100)
      return [name, Math.min(...Array.from({ length: 7 }, () => measure(1000)))]
    }),
  )
}

async function browserTimings() {
  const require = createRequire(new URL("apps/studio/package.json", root))
  const { chromium } = require("@playwright/test")
  const assets = new Map()
  for (const name of modules) {
    for (const suffix of [".js", "_bg.wasm"]) {
      const path = `${name}/canopy_${name}${suffix}`
      assets.set(`/${path}`, await readFile(new URL(path, generated)))
    }
  }
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname
    const body = assets.get(path)
    response.setHeader("Cache-Control", "no-store")
    if (path === "/") return response.end("<!doctype html><title>Canopy Wasm startup</title>")
    if (body === undefined) {
      response.statusCode = 404
      return response.end()
    }
    const wasm = path.endsWith(".wasm")
    response.setHeader("Content-Type", wasm ? "application/wasm" : "text/javascript")
    const run = Number(new URL(request.url ?? "/", "http://localhost").searchParams.get("run"))
    return response.end(wasm ? uniqueModule(body, run) : body)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  let browser
  try {
    browser = await chromium.launch({ headless: true })
    const results = {}
    for (const name of modules) {
      const values = []
      for (let i = 0; i < runs; i++) {
        const page = await browser.newPage()
        try {
          const cdp = await page.context().newCDPSession(page)
          await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 })
          await page.goto(`http://127.0.0.1:${server.address().port}/`)
          values.push(
            await page.evaluate(
              async ({ name, i }) => {
                const module = await import(`/${name}/canopy_${name}.js?run=${i}`)
                const response = await fetch(`/${name}/canopy_${name}_bg.wasm?run=${i}`)
                const start = performance.now()
                await module.default({ module_or_path: response })
                return performance.now() - start
              },
              { name, i },
            ),
          )
        } finally {
          await page.close()
        }
      }
      results[name] = summary(values)
    }
    return { version: browser.version(), ...results }
  } finally {
    await browser?.close()
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

const results = { runtime: process.versions.bun ? `Bun ${process.versions.bun}` : process.version }
for (const name of modules) {
  const prefix = new URL(`${name}/canopy_${name}`, generated).href
  const bytes = await readFile(new URL(`${prefix}_bg.wasm`))
  const glue = await readFile(new URL(`${prefix}.js`))
  const fallbackGlue = await readFile(new URL(`${prefix}_js.js`))
  const fallbackCode = await readFile(new URL(`${prefix}_translated.js`))
  const times = []
  const fallbackTimes = []
  let core
  for (let i = 0; i < runs; i++) {
    core = await import(`${prefix}.js?run=${i}`)
    const input = uniqueModule(bytes, i)
    const start = performance.now()
    core.initSync({ module: input })
    times.push(performance.now() - start)
    const fallbackStart = performance.now()
    await import(`${prefix}_js.js?run=${i}`)
    fallbackTimes.push(performance.now() - fallbackStart)
  }
  results[name] = {
    wasm: size(bytes),
    glue: size(glue),
    fallbackGlue: size(fallbackGlue),
    fallbackCode: size(fallbackCode),
    sections: sections(bytes),
    compileAndInstantiateMs: summary(times),
    fallbackImportMs: summary(fallbackTimes),
  }
  if (name === "client") {
    const fallback = await import(`${prefix}_js.js`)
    results[name].wasmMatcher = matcher(core)
    results[name].jsMatcher = matcher(fallback)
    results[name].frameCodecUsPerFrame = await frameCodec(core, fallback)
  }
}
if (process.argv.includes("--chromium")) results.chromium = await browserTimings()
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
