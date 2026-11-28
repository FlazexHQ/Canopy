import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStudioHandler } from "../../src/handler.ts"
import { studioService } from "../../src/service.ts"

const assets = {
  "index.html": "<!doctype html><title>Studio fixture</title>",
  "assets/app.123.js": "export const fixture = true\n",
  "manifest.webmanifest": "{}\n",
  "assets/raw": "fixture bytes",
}

const modified = 1_700_000_000
const etag = `W/"${assets["index.html"].length.toString(16)}-${(modified * 1000).toString(16)}"`

const cases = [
  { id: "health", target: "/healthz" },
  { id: "readiness", target: "/readyz" },
  { id: "origin-redirect", target: "/?source=fixture" },
  { id: "studio-redirect", target: "/studio?source=fixture" },
  { id: "index", target: "/studio/" },
  { id: "index-explicit", target: "/studio/index.html" },
  { id: "spa-fallback", target: "/studio/data/notes" },
  { id: "index-head", target: "/studio/", method: "HEAD" },
  { id: "index-revalidate", target: "/studio/", headers: { "if-none-match": etag } },
  { id: "hashed-asset", target: "/studio/assets/app.123.js" },
  { id: "unknown-media-type", target: "/studio/assets/raw" },
  { id: "manifest", target: "/studio/manifest.webmanifest" },
  { id: "asset-missing", target: "/studio/assets/missing" },
  { id: "file-missing", target: "/studio/missing.txt" },
  { id: "malformed-path", target: "/studio/%FF" },
  { id: "method-refused", target: "/studio/", method: "POST" },
  { id: "outside-studio", target: "/rest/v1/notes" },
  { id: "unbuilt", target: "/studio/", unbuilt: true },
] as const

/** Captures the standalone Studio service against a fixed asset fixture. */
export async function recordStudio(dir: string, check: boolean): Promise<boolean> {
  const fixture = await mkdtemp(join(tmpdir(), "canopy-studio-oracle-"))
  try {
    await mkdir(join(fixture, "assets"))
    for (const [name, body] of Object.entries(assets)) {
      const file = join(fixture, name)
      await writeFile(file, body)
      await utimes(file, modified, modified)
    }
    const serve = studioService(createStudioHandler({ assetsDir: fixture }).fetch)
    const unbuilt = studioService(
      createStudioHandler({ assetsDir: join(fixture, "unbuilt") }).fetch,
    )
    const origin = "https://studio.example.test"
    const output = []
    for (const spec of cases) {
      const method = "method" in spec ? spec.method : "GET"
      const headers = "headers" in spec ? spec.headers : {}
      const response = await ("unbuilt" in spec ? unbuilt : serve)(
        new Request(origin + spec.target, { method, headers }),
      )
      output.push({
        id: spec.id,
        request: { method, target: spec.target, headers },
        response: {
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: await response.text(),
        },
      })
    }
    const content = `${JSON.stringify({ origin, modified, assets, cases: output }, null, 2)}\n`
    const path = join(dir, process.versions["bun"] === undefined ? "node.json" : "bun.json")
    if (check) return (await readFile(path, "utf8")).replaceAll("\r\n", "\n") === content
    await mkdir(dir, { recursive: true })
    await writeFile(path, content)
    return true
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
}
