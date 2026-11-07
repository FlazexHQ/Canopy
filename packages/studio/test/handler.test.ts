import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createStudioHandler, STUDIO_CSP, toNodeListener } from "../src/index.ts"

let root: string
let outside: string
const INDEX = '<!doctype html><script type="module" src="/studio/assets/index-abc123.js"></script>'
const SCRIPT = "console.log('studio')"

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), "canopy-studio-"))
  root = join(base, "app")
  outside = join(base, "secret.txt")
  await mkdir(join(root, "assets"), { recursive: true })
  await writeFile(join(root, "index.html"), INDEX)
  await writeFile(join(root, "assets", "index-abc123.js"), SCRIPT)
  await writeFile(join(root, "assets", "index-abc123.css"), "body{}")
  await writeFile(join(root, "favicon.svg"), "<svg/>")
  await writeFile(join(root, ".env"), "SECRET=1")
  await writeFile(outside, "do not serve")
})

afterAll(async () => {
  await rm(join(root, ".."), { recursive: true, force: true })
})

const get = (path: string, init: RequestInit = {}) =>
  createStudioHandler({ assetsDir: root }).fetch(new Request(`http://localhost${path}`, init))

describe("createStudioHandler", () => {
  it("serves hashed assets with immutable caching and the right type", async () => {
    const response = await get("/studio/assets/index-abc123.js")
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
    expect(await response.text()).toBe(SCRIPT)
    const css = await get("/studio/assets/index-abc123.css")
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8")
  })

  it("falls back to index.html for client side routes, revalidated on every load", async () => {
    for (const path of ["/studio/", "/studio/policies/todos", "/studio/data/todos?view=json"]) {
      const response = await get(path)
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8")
      expect(response.headers.get("cache-control")).toBe("no-cache")
      expect(await response.text()).toBe(INDEX)
    }
  })

  it("redirects the bare base path to the trailing slash, keeping the query", async () => {
    const response = await get("/studio?x=1")
    expect(response.status).toBe(308)
    expect(response.headers.get("location")).toBe("/studio/?x=1")
  })

  it("sets the strict CSP and framing protection on every response", async () => {
    for (const path of [
      "/studio/",
      "/studio/assets/index-abc123.js",
      "/studio/assets/missing.js",
    ]) {
      const response = await get(path)
      const csp = response.headers.get("content-security-policy") ?? ""
      expect(csp).toBe(STUDIO_CSP)
      expect(csp).toContain("frame-ancestors 'none'")
      expect(csp).toContain("script-src 'self'")
      expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/)
      expect(csp).not.toContain("unsafe-eval")
      expect(response.headers.get("x-frame-options")).toBe("DENY")
      expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    }
  })

  it("answers 404 for missing assets instead of the app shell", async () => {
    const response = await get("/studio/assets/gone-123.js")
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain("<!doctype")
    expect((await get("/studio/robots.txt")).status).toBe(404)
  })

  it("never serves files outside the build or dot files", async () => {
    for (const path of [
      "/studio/assets/..%2f..%2fsecret.txt",
      "/studio/..%2fsecret.txt",
      "/studio/assets/%2e%2e/%2e%2e/secret.txt",
      "/studio/.env",
      "/studio/assets/..%5c..%5csecret.txt",
      "/studio/assets/%00.js",
      "/studio/assets/%E0%A4%A",
    ]) {
      const response = await get(path)
      expect(response.status, path).toBe(404)
      expect(await response.text(), path).not.toContain("do not serve")
    }
  })

  it("supports HEAD and conditional requests, and refuses other methods", async () => {
    const head = await get("/studio/favicon.svg", { method: "HEAD" })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe("")
    const etag = head.headers.get("etag")
    expect(etag).toMatch(/^W\/"/)
    const again = await get("/studio/favicon.svg", { headers: { "if-none-match": etag ?? "" } })
    expect(again.status).toBe(304)
    const post = await get("/studio/", { method: "POST" })
    expect(post.status).toBe(405)
    expect(post.headers.get("allow")).toBe("GET, HEAD")
  })

  it("matches only its own base path", () => {
    const handler = createStudioHandler({ assetsDir: root, basePath: "/admin/studio/" })
    expect(handler.basePath).toBe("/admin/studio")
    expect(handler.matches("/admin/studio")).toBe(true)
    expect(handler.matches("/admin/studio/x")).toBe(true)
    expect(handler.matches("/admin/studiox")).toBe(false)
    expect(handler.matches("/studio")).toBe(false)
    expect(() => createStudioHandler({ basePath: "studio" })).toThrow(TypeError)
    expect(() => createStudioHandler({ basePath: "/" })).toThrow(TypeError)
  })

  it("explains how to build Studio when the assets are missing", async () => {
    const handler = createStudioHandler({ assetsDir: join(root, "nope") })
    const response = await handler.fetch(new Request("http://localhost/studio/"))
    expect(response.status).toBe(503)
    expect(await response.text()).toContain("bun --filter @canopy/studio-app build")
  })
})

describe("toNodeListener", () => {
  let server: Server
  let origin: string
  beforeAll(async () => {
    const listener = toNodeListener(createStudioHandler({ assetsDir: root }))
    server = createServer((request, response) =>
      listener(request, response, () => {
        response.statusCode = 418
        response.end("next")
      }),
    )
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()))
  })

  it("serves Studio paths with the handler's headers and passes other paths on", async () => {
    const asset = await fetch(`${origin}/studio/assets/index-abc123.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get("cache-control")).toContain("immutable")
    expect(asset.headers.get("content-security-policy")).toBe(STUDIO_CSP)
    expect(await asset.text()).toBe(SCRIPT)
    const other = await fetch(`${origin}/rest/v1/todos`)
    expect(other.status).toBe(418)
    expect(await other.text()).toBe("next")
  })
})
