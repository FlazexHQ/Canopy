import { chromium } from "D:/Coding/Canopy/node_modules/.bun/@playwright+test@1.64.1/node_modules/@playwright/test/index.js"
import { type ChildProcess, spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(__dirname, "../../..")
const appDir = resolve(__dirname, "app")
const htmlPath = resolve(appDir, "index.html")
const jsPath = resolve(appDir, "dist/app.js")

const APP_PORT = 3333
const CANOPY_PORT = 3000
const MONGODB_URI = "mongodb://localhost:37017/?replicaSet=rs0"
const PUBLISHABLE_KEY = "canopy_pk_dev_test123456"
const SECRET_KEY = "canopy_sk_dev_test123456"
const TOTAL_RUNS = 20

// 1. Static HTTP Server
function startStaticServer(): Promise<Server> {
  return new Promise((done) => {
    const server = createServer((req, res) => {
      const url = req.url ?? "/"
      if (url === "/" || url === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        res.end(readFileSync(htmlPath))
      } else if (url === "/dist/app.js" || url === "/app.js") {
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" })
        res.end(readFileSync(jsPath))
      } else {
        res.writeHead(404)
        res.end("Not Found")
      }
    })
    server.listen(APP_PORT, () => {
      done(server)
    })
  })
}

// 2. Start Canopy dev server
async function startCanopyServer(): Promise<ChildProcess> {
  const proc = spawn("bun", ["run", "dev", "--", "--port", String(CANOPY_PORT)], {
    cwd: rootDir,
    env: {
      ...process.env,
      MONGODB_URI,
      CANOPY_PUBLISHABLE_KEYS: PUBLISHABLE_KEY,
      CANOPY_SECRET_KEYS: SECRET_KEY,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  proc.stdout?.on("data", (d) => {
    const str = d.toString()
    if (str.includes("canopyd listening") || str.includes("Canopy dev")) {
      process.stdout.write(`[server stdout] ${str}`)
    }
  })

  proc.stderr?.on("data", (d) => {
    process.stderr.write(`[server stderr] ${d.toString()}`)
  })

  // Poll until ready
  const start = Date.now()
  while (Date.now() - start < 15000) {
    try {
      const res = await fetch(`http://localhost:${CANOPY_PORT}/rest/v1`, {
        headers: { "x-canopy-key": PUBLISHABLE_KEY },
      })
      if (res.status < 500) {
        return proc
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  proc.kill()
  throw new Error("Canopy server failed to start within 15 seconds")
}

interface RunTiming {
  run: number
  evalMs: number
  firstResultMs: number
}

function calculateStats(values: number[]): {
  median: number
  p95: number
  min: number
  max: number
} {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (index: number): number => sorted[index] ?? Number.NaN
  const middle = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0 ? (at(middle - 1) + at(middle)) / 2 : at(middle)
  const p95 = at(Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95)))
  return { median, p95, min: at(0), max: at(sorted.length - 1) }
}

async function main() {
  const staticServer = await startStaticServer()
  let canopyProc: ChildProcess | undefined
  try {
    canopyProc = await startCanopyServer()
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    })

    const runTimings: RunTiming[] = []

    for (let i = 1; i <= TOTAL_RUNS; i++) {
      const context = await browser.newContext()
      const page = await context.newPage()

      const cdp = await context.newCDPSession(page)
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 })

      await page.goto(`http://localhost:${APP_PORT}`)

      await page.waitForFunction(
        () => (window as unknown as { __done?: boolean }).__done === true,
        { timeout: 15000 },
      )

      const result = await page.evaluate(() => {
        const win = window as unknown as {
          __evalDuration: number
          __firstResultDuration: number
          __error?: string
        }
        return {
          evalMs: win.__evalDuration,
          firstResultMs: win.__firstResultDuration,
          error: win.__error,
        }
      })

      if (result.error) {
        throw new Error(`Run ${i} failed with error: ${result.error}`)
      }

      runTimings.push({
        run: i,
        evalMs: result.evalMs,
        firstResultMs: result.firstResultMs,
      })

      await context.close()
    }

    await browser.close()

    const evalStats = calculateStats(runTimings.map((t) => t.evalMs))
    const firstResultStats = calculateStats(runTimings.map((t) => t.firstResultMs))

    const summary = {
      runs: TOTAL_RUNS,
      throttling: "4x CPU slowdown (CDP Emulation.setCPUThrottlingRate: 4)",
      module_evaluated_ms: evalStats,
      first_live_query_result_ms: firstResultStats,
      all_runs: runTimings,
    }

    const { writeFileSync } = await import("node:fs")
    writeFileSync(resolve(__dirname, "dist/startup.json"), `${JSON.stringify(summary, null, 2)}\n`)
  } finally {
    if (canopyProc) {
      canopyProc.kill()
    }
    staticServer.close()
  }
}

main().catch((err) => {
  console.error("Benchmark failed:", err)
  process.exit(1)
})
