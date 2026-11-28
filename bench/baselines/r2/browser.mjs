import assert from "node:assert/strict"
import { once } from "node:events"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import process from "node:process"
import { fileURLToPath } from "node:url"

const root = new URL("../../../", import.meta.url)
const require = createRequire(new URL("apps/studio/package.json", root))
const { chromium, firefox, webkit } = require("@playwright/test")
const runner = new URL("./", import.meta.url)
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost")
  const path = url.pathname
  if (path === "/") {
    const allowWasm = url.searchParams.get("mode") === "wasm"
    response.writeHead(200, {
      "Content-Type": "text/html",
      "Content-Security-Policy": allowWasm
        ? "script-src 'self' 'wasm-unsafe-eval'"
        : "script-src 'self'",
    })
    response.end('<!doctype html><script type="module" src="/browser-page.mjs"></script>')
    return
  }

  let source
  if (["/browser-page.mjs", "/assertions.mjs", "/replay.mjs"].includes(path)) {
    source = new URL(path.slice(1), runner)
  } else if (path === "/bson.mjs") {
    source = fileURLToPath(new URL("../../node_modules/bson/lib/bson.mjs", runner))
  } else if (/^\/generated\/(client|authoring|transforms)\/[\w.]+$/.test(path)) {
    source = new URL(`packages/wasm${path}`, root)
  } else if (/^\/conformance\/[\w/-]+\.json$/.test(path)) {
    source = new URL(path.slice(1), root)
  }
  if (!source) {
    response.writeHead(404).end()
    return
  }
  try {
    const data = await readFile(source)
    const type = path.endsWith(".wasm")
      ? "application/wasm"
      : path.endsWith(".json")
        ? "application/json"
        : "text/javascript"
    response.writeHead(200, { "Content-Type": type }).end(data)
  } catch (error) {
    response.writeHead(500).end(String(error))
  }
})

server.listen(0, "127.0.0.1")
await once(server, "listening")
try {
  for (const engine of [chromium, firefox, webkit]) {
    const browser = await engine.launch()
    try {
      for (const mode of ["wasm", "blocked", "js"]) {
        const page = await browser.newPage()
        try {
          const requests = []
          page.on("request", (request) => requests.push(new URL(request.url()).pathname))
          await page.goto(`http://127.0.0.1:${server.address().port}/?mode=${mode}`)
          await page.waitForFunction(() => globalThis.replayResult !== undefined)
          const { result, error, stack } = await page.evaluate(() => globalThis.replayResult)
          if (error) throw new Error(`${error}\n${stack}`)
          if (mode !== "blocked") {
            const matcher = requests.indexOf("/conformance/matcher/filters.json")
            const transforms = requests.findIndex((path) =>
              path.startsWith("/generated/transforms/"),
            )
            assert.ok(
              matcher >= 0 && transforms > matcher,
              "Transforms must load after matcher replay starts",
            )
          }
          if (mode === "js") {
            assert.ok(!requests.some((path) => path.endsWith(".wasm")))
          }
          process.stdout.write(
            `${engine.name()} ${browser.version()} ${mode}: ${JSON.stringify(result)}\n`,
          )
        } catch (error) {
          process.stderr.write(`${engine.name()} ${mode}: ${error.stack}\n`)
          process.exitCode = 1
        } finally {
          await page.close()
        }
      }
    } finally {
      await browser.close()
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve))
}
