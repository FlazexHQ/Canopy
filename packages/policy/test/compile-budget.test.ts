import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { join, relative, resolve } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const COLLECTIONS = 50
const FIELDS = 40
/**
 * The type instantiation budget for the large schema below, which TypeScript 6.0 checks with about 214,000
 * instantiations in under half a second. The count is deterministic, unlike the time, and the budget fails
 * when the policy types become much more expensive.
 */
const INSTANTIATION_BUDGET = 500_000

const run = promisify(execFile)
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc")
const cache = resolve(import.meta.dirname, "../node_modules/.cache")

function field(index: number): string {
  switch (index % 5) {
    case 0:
      return `f${index}: string`
    case 1:
      return `f${index}?: number`
    case 2:
      return `f${index}: ObjectId`
    case 3:
      return `f${index}: string[]`
    default:
      return `f${index}?: { a: string; b: { c: number; d?: Date } }`
  }
}

function schema(dir: string): string {
  const source = relative(dir, resolve(import.meta.dirname, "../src/index.ts"))
  const lines = [
    `import type { ObjectId } from "@canopy/protocol"`,
    `import { createPolicyKit } from ${JSON.stringify(source)}`,
  ]
  for (let c = 0; c < COLLECTIONS; c += 1) {
    const fields = Array.from({ length: FIELDS }, (_, index) => `  ${field(index)}`)
    lines.push(`interface Doc${c} {\n  _id: ObjectId\n${fields.join("\n")}\n}`)
  }
  lines.push(
    `interface Database {\n${Array.from({ length: COLLECTIONS }, (_, c) => `  c${c}: { Document: Doc${c}; Insert: Doc${c} }`).join("\n")}\n}`,
    `interface Claims { sub: string; org_ids: string[]; app_metadata: { tenant_id: string } }`,
    `const base = createPolicyKit<{ database: Database; claims: Claims; roles: "staff"; context: {} }>()`,
    `const contexts = base.context({ ids: { from: "c0", where: { f0: base.auth("sub") }, select: "f2", max: 10, ttl: "PT1M" } })`,
    `const { allow, restrict, auth, ctx, now, collection } = createPolicyKit<{ database: Database; claims: Claims; roles: "staff"; context: typeof contexts }>()`,
  )
  for (let c = 0; c < COLLECTIONS; c += 1) {
    lines.push(`export const p${c} = collection("c${c}", {
  exposed: true,
  policies: [
    allow.read("authenticated").where({ f0: auth("sub"), "f4.b.c": { $gt: 1 } }),
    allow.read("authenticated").where({ f2: { $in: ctx("ids") } }),
    allow.read("staff").where({ $or: [{ f3: { $in: auth("org_ids") } }, { f5: "x" }] }),
    allow.update("authenticated").where({ f7: auth("sub", "objectId") }).check({ "f9.b.d": { $lt: now() } }),
    restrict.delete("authenticated").where({ f1: { $exists: false } }),
  ],
  fields: { read: { default: { omit: ["f10", "f14.b"] } }, write: { staff: { only: ["f15", "f20"] } } },
  immutable: ["f0", "f2"],
})`)
  }
  lines.push(`export function errors(): void {
  collection("c49", {
    // @ts-expect-error typo in a where field
    policies: [allow.read("authenticated").where({ f00: auth("sub") })],
  })
  // @ts-expect-error typo in an omit list
  collection("c49", { fields: { read: { default: { omit: ["f399"] } } } })
  collection("c49", {
    // @ts-expect-error a string claim against an ObjectId field
    policies: [allow.read("authenticated").where({ f2: auth("sub") })],
  })
}`)
  return `${lines.join("\n\n")}\n`
}

describe("typed policies on a large schema", () => {
  it(`check ${COLLECTIONS} collections of ${FIELDS} fields within the instantiation budget`, {
    timeout: 120_000,
  }, async () => {
    await mkdir(cache, { recursive: true })
    const dir = await mkdtemp(join(cache, "budget-"))
    try {
      await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }))
      await writeFile(join(dir, "policies.ts"), schema(dir))
      await writeFile(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          extends: resolve(import.meta.dirname, "../../../tsconfig.universal.json"),
          compilerOptions: {
            noEmit: true,
            composite: false,
            incremental: false,
            declaration: false,
            declarationMap: false,
            isolatedDeclarations: false,
            allowImportingTsExtensions: true,
            customConditions: ["@canopy/source"],
          },
          files: ["policies.ts"],
        }),
      )
      const result = await run(
        process.execPath,
        [tsc, "-p", join(dir, "tsconfig.json"), "--extendedDiagnostics"],
        { maxBuffer: 16 * 1024 * 1024 },
      ).catch((error: unknown) => {
        const failed = error as { stdout?: string; stderr?: string }
        throw new Error(`tsc failed:\n${failed.stdout ?? ""}${failed.stderr ?? ""}`)
      })
      const instantiations = Number(/Instantiations:\s+(\d+)/.exec(result.stdout)?.[1] ?? NaN)
      expect(instantiations).toBeGreaterThan(0)
      expect(instantiations).toBeLessThan(INSTANTIATION_BUDGET)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
