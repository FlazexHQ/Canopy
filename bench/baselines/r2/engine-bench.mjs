import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { runWorkload } from "./engine-workload.mjs"

const root = new URL("../../../", import.meta.url)
const { values } = parseArgs({
  options: {
    "canopy-js": { type: "string" },
    chromium: { type: "boolean" },
    rounds: { type: "string", default: "3" },
  },
})
const rounds = Number(values.rounds)
if (!Number.isSafeInteger(rounds) || rounds < 1)
  throw new Error("--rounds must be a positive integer")
const checkout =
  values["canopy-js"] === undefined
    ? fileURLToPath(new URL("../Canopy.js", root))
    : resolve(values["canopy-js"])
const dist = join(checkout, "dist")
const enginePath = join(dist, "client", "engine.js")

async function measureChromium() {
  const require = createRequire(new URL("apps/studio/package.json", root))
  const { chromium } = require("@playwright/test")
  const { build } = require("esbuild")
  const {
    outputFiles: [bundle],
  } = await build({
    absWorkingDir: fileURLToPath(new URL(".", import.meta.url)),
    stdin: {
      contents: `
        import { loadEngine } from ${JSON.stringify(enginePath.replaceAll("\\", "/"))}
        import { runWorkload } from "./engine-workload.mjs"
        export async function run(reverse) {
          return runWorkload(await loadEngine(), reverse)
        }
      `,
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  })
  const responses = new Map([
    ["/", { contentType: "text/html", body: "<!doctype html><title>R2 engine benchmark</title>" }],
    ["/dist/benchmark.mjs", { contentType: "text/javascript", body: bundle.text }],
  ])
  for (const [module, file] of [
    ["client", "canopy_client_bg.wasm"],
    ["transforms", "canopy_transforms_bg.wasm"],
  ]) {
    responses.set(`/core/wasm/${module}/${file}`, {
      contentType: "application/wasm",
      body: await readFile(join(dist, "core", "wasm", module, file)),
    })
  }

  const browser = await chromium.launch()
  try {
    const samples = []
    for (let round = 0; round < rounds; round += 1) {
      const context = await browser.newContext()
      try {
        await context.route("http://canopy-benchmark.test/**", (route) => {
          const response = responses.get(new URL(route.request().url()).pathname)
          return route.fulfill(response ?? { status: 404 })
        })
        const page = await context.newPage()
        const cdp = await context.newCDPSession(page)
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 })
        await page.goto("http://canopy-benchmark.test/")
        samples.push(
          await page.evaluate(
            async (reverse) => {
              const { run } = await import("/dist/benchmark.mjs")
              return run(reverse)
            },
            round % 2 === 1,
          ),
        )
      } finally {
        await context.close()
      }
    }
    return { runtime: `Chromium ${browser.version()} (4x CPU slowdown)`, samples }
  } finally {
    await browser.close()
  }
}

async function measureHost() {
  const { loadEngine } = await import(pathToFileURL(enginePath).href)
  const engine = await loadEngine()
  const samples = []
  for (let round = 0; round < rounds; round += 1) {
    samples.push(runWorkload(engine, round % 2 === 1))
  }
  const runtime = globalThis.Bun ? `Bun ${Bun.version}` : `Node ${process.versions.node}`
  return { runtime, samples }
}

function spread(values) {
  return { min: Math.min(...values), max: Math.max(...values) }
}

function summarize(samples, group) {
  return Object.fromEntries(
    Object.entries(samples[0][group]).map(([name, first]) => {
      const timings = samples.map((sample) => sample[group][name])
      return [
        name,
        {
          ...(first.reference === undefined ? {} : { reference: first.reference }),
          typescript: spread(timings.map((timing) => timing.typescript)),
          wasm: spread(timings.map((timing) => timing.wasm)),
          ratio: spread(timings.map((timing) => timing.ratio)),
        },
      ]
    }),
  )
}

const { runtime, samples } = await (values.chromium ? measureChromium() : measureHost())
const report = {
  checkout,
  runtime,
  matchNsPerDocument: summarize(samples, "match"),
  updateUsPerOperation: summarize(samples, "update"),
  rounds: samples,
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
