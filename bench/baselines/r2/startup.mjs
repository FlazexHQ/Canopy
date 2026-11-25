import { once } from "node:events"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { extname, join, normalize, resolve, sep } from "node:path"

/**
 * Measures the first live query of the R0 app built by `root-entry.ts`: headless Chromium at 4x CPU
 * slowdown loads the page and records when the module is evaluated and when the live query first reports
 * `ready`, as the R0 startup baseline does. It needs a Canopy server on port 3000 accepting the R0
 * publishable key (`bun run dev --port 3000` with `CANOPY_PUBLISHABLE_KEYS=canopy_pk_dev_test123456`).
 *
 *   node bench/baselines/r2/startup.mjs --dir <out of root-entry.ts> [--runs 20] [--csp strict]
 *
 * `--csp strict` serves the page with `script-src 'self'` (plus a nonce for the timing script) and no
 * `'wasm-unsafe-eval'`, so the client core loads as its JavaScript translation.
 */
const root = new URL("../../../", import.meta.url)
const require = createRequire(new URL("apps/studio/package.json", root))
const { chromium } = require("@playwright/test")

function option(name, fallback) {
  const index = process.argv.indexOf(name)
  return index < 0 ? fallback : process.argv[index + 1]
}

const dir = resolve(option("--dir"))
const runs = Number(option("--runs", "20"))
const strict = option("--csp", "none") === "strict"
const nonce = "r2startup"
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
}
const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Canopy R2 Startup</title>
    <script nonce="${nonce}">window.__scriptStart = performance.now()</script>
    <script type="module" src="/dist/app.js"></script>
  </head>
  <body><div id="status">loading</div></body>
</html>
`

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname
  if (strict) response.setHeader("Content-Security-Policy", `script-src 'self' 'nonce-${nonce}'`)
  if (path === "/" || path === "/index.html") {
    response.setHeader("Content-Type", types[".html"])
    return response.end(page)
  }
  const file = normalize(join(dir, path))
  if (!file.startsWith(dir + sep)) {
    response.statusCode = 404
    return response.end()
  }
  try {
    const body = await readFile(file)
    response.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream")
    return response.end(body)
  } catch {
    response.statusCode = 404
    return response.end()
  }
})
server.listen(0, "127.0.0.1")
await once(server, "listening")
const address = server.address()
const origin = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (index) => sorted[index] ?? Number.NaN
  const middle = Math.floor(sorted.length / 2)
  return {
    median: sorted.length % 2 === 0 ? (at(middle - 1) + at(middle)) / 2 : at(middle),
    p95: at(Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))),
    min: at(0),
    max: at(sorted.length - 1),
  }
}

const browser = await chromium.launch({ headless: true })
try {
  const evaluated = []
  const first = []
  const wasmRequests = []
  for (let run = 0; run < runs; run++) {
    const context = await browser.newContext()
    const tab = await context.newPage()
    let wasm = 0
    tab.on("request", (request) => {
      if (request.url().endsWith(".wasm")) wasm += 1
    })
    const cdp = await context.newCDPSession(tab)
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 })
    await tab.goto(origin)
    await tab.waitForFunction(() => window.__done === true, undefined, { timeout: 30_000 })
    const result = await tab.evaluate(() => ({
      evalMs: window.__evalDuration,
      firstResultMs: window.__firstResultDuration,
      error: window.__error,
    }))
    if (result.error !== undefined) throw new Error(`Run ${run + 1} failed: ${result.error}`)
    evaluated.push(result.evalMs)
    first.push(result.firstResultMs)
    wasmRequests.push(wasm)
    await context.close()
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        runs,
        csp: strict ? `script-src 'self' 'nonce-${nonce}'` : "none",
        throttling: "4x CPU slowdown",
        module_evaluated_ms: stats(evaluated),
        first_live_query_result_ms: stats(first),
        wasm_requests_per_run: [...new Set(wasmRequests)],
      },
      null,
      2,
    )}\n`,
  )
} finally {
  await browser.close()
  server.close()
}
