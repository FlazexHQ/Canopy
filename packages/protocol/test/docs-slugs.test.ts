import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("../../../", import.meta.url))
const pages = join(root, "apps", "docs", "src", "content", "docs", "errors")

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

describe("diagnostic docs", () => {
  it("has a page for every docs slug a diagnostic names", () => {
    const slugs = new Set<string>()
    for (const pkg of readdirSync(join(root, "packages"))) {
      const src = join(root, "packages", pkg, "src")
      if (!existsSync(src)) continue
      for (const file of sources(src))
        for (const match of readFileSync(file, "utf8").matchAll(/\bdocs: "([a-z0-9-]+)"/g))
          if (match[1] !== undefined) slugs.add(match[1])
    }
    expect(slugs.size).toBeGreaterThan(5)
    const missing = [...slugs].filter((slug) => !existsSync(join(pages, `${slug}.md`)))
    expect(missing).toEqual([])
  })
})
