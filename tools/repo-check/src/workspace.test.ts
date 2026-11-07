import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { checkWorkspace, listWorkspacePackages } from "./workspace.ts"

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "repo-check-"))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function write(path: string, content: unknown): Promise<void> {
  const absolute = join(root, path)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(
    absolute,
    typeof content === "string" ? content : JSON.stringify(content, null, 2),
  )
}

async function repo(
  packages: Record<string, { manifest?: object; tsconfig?: object | string }>,
  references?: string[],
) {
  await write("package.json", { private: true, workspaces: { packages: ["packages/*", "apps/*"] } })
  await write("tsconfig.json", {
    files: [],
    references: (references ?? Object.keys(packages)).map((path) => ({ path })),
  })
  for (const [dir, { manifest, tsconfig }] of Object.entries(packages)) {
    await write(
      `${dir}/package.json`,
      manifest ?? { name: `@canopy/${dir.split("/")[1]}`, type: "module" },
    )
    await write(
      `${dir}/tsconfig.json`,
      tsconfig ?? { extends: "../../tsconfig.server.json", compilerOptions: { rootDir: "src" } },
    )
  }
}

const universal = { extends: "../../tsconfig.universal.json", compilerOptions: { rootDir: "src" } }

describe("checkWorkspace", () => {
  it("accepts a consistent workspace", async () => {
    await repo({
      "packages/protocol": { tsconfig: universal },
      "packages/matcher": {
        manifest: {
          name: "@canopy/matcher",
          type: "module",
          dependencies: { "@canopy/protocol": "workspace:*" },
        },
        tsconfig: universal,
      },
      "packages/server": {},
    })
    await write(
      "packages/matcher/src/index.ts",
      "import { x } from '@canopy/protocol/codec'\nexport * from './compare.ts'\n",
    )
    await write(
      "packages/matcher/src/index.test.ts",
      "import { test } from 'vitest'\nimport { readFile } from 'node:fs'\n",
    )
    await write("packages/server/src/index.ts", "import { createServer } from 'node:http'\n")
    expect(await checkWorkspace(root)).toEqual([])
  })

  it("accepts a workspace with no packages and no references", async () => {
    await repo({})
    expect(await checkWorkspace(root)).toEqual([])
  })

  it("reports a package missing from the solution tsconfig", async () => {
    await repo({ "packages/server": {}, "packages/rest": {} }, ["packages/server"])
    expect(await checkWorkspace(root)).toEqual([
      "packages/rest: not referenced from the root tsconfig.json",
    ])
  })

  it("reports a stale reference to a directory without a tsconfig", async () => {
    await repo({ "packages/server": {} }, ["packages/server", "packages/gone"])
    expect(await checkWorkspace(root)).toEqual([
      "tsconfig.json references packages/gone, which has no tsconfig.json",
    ])
  })

  it("normalizes reference paths with ./ prefixes and trailing slashes", async () => {
    await repo({ "packages/server": {} }, ["./packages/server/"])
    expect(await checkWorkspace(root)).toEqual([])
  })

  it("reports bad package names, missing ESM type and duplicate names", async () => {
    await repo({
      "packages/a": { manifest: { name: "canopy-a", type: "module" } },
      "packages/b": { manifest: { name: "@canopy/Bad_Name" } },
      "apps/c": { manifest: { name: "@canopy/dup", type: "module" } },
      "apps/d": { manifest: { name: "@canopy/dup", type: "module" } },
    })
    expect(await checkWorkspace(root)).toEqual([
      "apps/d: the package name @canopy/dup is used twice",
      "packages/a: the package name must match @canopy/<name> in lower case",
      "packages/b: the package name must match @canopy/<name> in lower case",
      'packages/b: package.json must set "type": "module"',
    ])
  })

  it("reports a tsconfig that does not extend a shared variant or omits rootDir", async () => {
    await repo({
      "packages/a": { tsconfig: { compilerOptions: { rootDir: "src" } } },
      "packages/b": {
        tsconfig: { extends: "../../tsconfig.base.json", compilerOptions: { rootDir: "src" } },
      },
      "packages/c": { tsconfig: { extends: "../../tsconfig.server.json" } },
      "packages/d": { tsconfig: "{ not json" },
    })
    expect(await checkWorkspace(root)).toEqual([
      "packages/a: tsconfig.json must extend one of tsconfig.server.json, tsconfig.universal.json, tsconfig.web.json, tsconfig.edge.json",
      "packages/b: tsconfig.json must extend one of tsconfig.server.json, tsconfig.universal.json, tsconfig.web.json, tsconfig.edge.json",
      "packages/c: tsconfig.json must set compilerOptions.rootDir explicitly",
      "packages/d: tsconfig.json is missing or invalid",
    ])
  })

  it("reads tsconfig files with comments and trailing commas", async () => {
    await repo({
      "packages/server": {
        tsconfig:
          '{\n  // shared\n  "extends": "../../tsconfig.server.json",\n  "compilerOptions": { "rootDir": "src", },\n}\n',
      },
    })
    expect(await checkWorkspace(root)).toEqual([])
  })

  it("requires universal packages to extend the universal variant", async () => {
    await repo({ "packages/query": {} })
    expect(await checkWorkspace(root)).toEqual([
      "packages/query: a universal package must extend tsconfig.universal.json",
    ])
  })

  it("rejects runtime dependencies from outside the workspace in universal packages", async () => {
    await repo({
      "packages/policy": {
        manifest: {
          name: "@canopy/policy",
          type: "module",
          dependencies: { zod: "4.0.0", "@canopy/query": "workspace:*" },
          peerDependencies: { mongodb: "7.0.0" },
          devDependencies: { vitest: "5.0.5" },
        },
        tsconfig: universal,
      },
    })
    expect(await checkWorkspace(root)).toEqual([
      "packages/policy: universal packages may only depend on workspace packages at runtime, found zod in dependencies",
      "packages/policy: universal packages may only depend on workspace packages at runtime, found mongodb in peerDependencies",
    ])
  })

  it("rejects Node built ins and outside modules in universal sources but not in their tests", async () => {
    await repo({ "packages/matcher": { tsconfig: universal } })
    await write(
      "packages/matcher/src/deep/index.ts",
      [
        "import { readFile } from 'node:fs/promises'",
        "import path from 'path'",
        "export { sift } from 'sift'",
        "const lazy = await import('node:crypto')",
        "import './local.ts'",
      ].join("\n"),
    )
    await write("packages/matcher/src/deep/index.test.ts", "import { readFile } from 'node:fs'\n")
    expect(await checkWorkspace(root)).toEqual([
      'packages/matcher/src/deep/index.ts: universal packages must not import the Node built in "node:fs/promises"',
      'packages/matcher/src/deep/index.ts: universal packages must not import the Node built in "path"',
      'packages/matcher/src/deep/index.ts: universal packages must not import "sift" from outside the workspace',
      'packages/matcher/src/deep/index.ts: universal packages must not import the Node built in "node:crypto"',
    ])
  })

  it("does not apply universal rules to a same named directory outside packages/", async () => {
    await repo({ "apps/protocol": {} })
    await write("apps/protocol/src/index.ts", "import { readFile } from 'node:fs'\n")
    expect(await checkWorkspace(root)).toEqual([])
  })

  it("reports a missing or invalid root manifest and solution file", async () => {
    expect(await checkWorkspace(root)).toEqual([
      "package.json at the repository root is missing or invalid",
    ])
    await write("package.json", { workspaces: ["packages/*"] })
    expect(await checkWorkspace(root)).toEqual([
      "tsconfig.json at the repository root is missing or invalid",
    ])
  })
})

describe("listWorkspacePackages", () => {
  it("lists directories with a package.json, supports plain paths, and skips dot directories", async () => {
    await write("packages/a/package.json", { name: "@canopy/a" })
    await write("packages/no-manifest/readme.md", "x")
    await write("packages/.hidden/package.json", { name: "@canopy/hidden" })
    await write("examples/todo/package.json", { name: "@canopy/todo" })
    const found = await listWorkspacePackages(root, ["packages/*", "examples/todo", "missing/*"])
    expect(found.map((pkg) => pkg.dir)).toEqual(["examples/todo", "packages/a"])
  })
})
