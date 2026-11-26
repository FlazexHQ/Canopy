import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { publishTarballs } from "../scripts/publish-tarballs.ts"

let temporary: string
let native: string
let canopyd: string

beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), "canopy-publish-"))
  native = join(temporary, "native")
  canopyd = join(temporary, "canopyd")
  mkdirSync(native)
  mkdirSync(canopyd)
})

afterEach(() => {
  rmSync(temporary, { recursive: true, force: true })
})

function pack(folder: string, filename: string, manifest: Record<string, unknown>): string {
  const file = join(folder, `${filename}.tgz`)
  const body = Buffer.from(JSON.stringify({ version: "1.2.3", ...manifest }))
  const header = Buffer.alloc(512)
  header.write("package/package.json")
  header.write("0000644\0", 100)
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124)
  header.write("        ", 148)
  header.write("0", 156)
  header.write("ustar\x0000", 257)
  const checksum = header.reduce((total, byte) => total + byte, 0)
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148)
  writeFileSync(
    file,
    gzipSync(
      Buffer.concat([header, body, Buffer.alloc(((512 - (body.length % 512)) % 512) + 1024)]),
    ),
  )
  return file
}

function stubs() {
  return {
    isPublished: vi
      .fn<(name: string, version: string) => Promise<boolean>>()
      .mockResolvedValue(false),
    runNpm: vi.fn<(args: readonly string[]) => void>(),
    warn: vi.fn(),
  }
}

describe("publishTarballs", () => {
  it("publishes shared Studio first and platform packages before either launcher", async () => {
    const setup = [
      [native, "@canopy/native", "@canopy/native-linux-x64-gnu"],
      [canopyd, "@canopy/realtime", "@canopy/canopyd-linux-x64-gnu"],
    ] as const
    const files = setup.map(([folder, launcher, platform]) => ({
      launcher: pack(folder, "a-launcher", {
        name: launcher,
        license: "MIT",
        optionalDependencies: { [platform]: "1.2.3" },
      }),
      platform: pack(folder, "z-platform", { name: platform, license: "MIT" }),
    }))
    const studio = pack(canopyd, "zz-studio", { name: "@canopy/studio-assets", license: "MIT" })
    const operations = stubs()
    await publishTarballs([native, canopyd], true, operations)
    expect(operations.runNpm.mock.calls.map(([args]) => args.slice(0, 2))).toEqual([
      ["publish", studio],
      ["publish", files[0]?.platform],
      ["publish", files[1]?.platform],
      ["publish", files[0]?.launcher],
      ["publish", files[1]?.launcher],
    ])
    for (const [args] of operations.runNpm.mock.calls) {
      expect(args).toContain("--provenance")
      expect(args).not.toContain("--dry-run")
    }
  })

  it.each([{ license: "UNLICENSED" }, {}])("refuses the whole release for %j", async (manifest) => {
    pack(native, "native", { name: "@canopy/native-linux-x64-gnu", license: "MIT" })
    pack(canopyd, "canopyd", { name: "@canopy/canopyd-linux-x64-gnu", ...manifest })
    const operations = stubs()
    await expect(publishTarballs([native, canopyd], true, operations)).rejects.toThrow(
      "Missing license or UNLICENSED: @canopy/canopyd-linux-x64-gnu",
    )
    expect(operations.isPublished).not.toHaveBeenCalled()
    expect(operations.runNpm).not.toHaveBeenCalled()
  })

  it("looks up each exact version and skips a published platform version", async () => {
    const platform = "@canopy/native-linux-x64-gnu"
    const launcher = "@canopy/native"
    pack(native, "a-launcher", { name: launcher, license: "MIT" })
    pack(native, "z-platform", { name: platform, version: "1.2.2", license: "MIT" })
    const operations = stubs()
    operations.isPublished.mockImplementation(
      async (name, version) => name === platform && version === "1.2.2",
    )
    await publishTarballs([native], true, operations)
    expect(operations.isPublished.mock.calls).toEqual([
      [platform, "1.2.2"],
      [launcher, "1.2.3"],
    ])
    expect(operations.runNpm).toHaveBeenCalledExactlyOnceWith([
      "publish",
      join(native, "a-launcher.tgz"),
      "--access",
      "public",
      "--registry",
      "https://registry.npmjs.org/",
      "--ignore-scripts",
      "--provenance",
    ])
  })

  it("warns and dry runs every tarball without looking up published versions", async () => {
    const paths = [
      pack(native, "native", { name: "@canopy/native", license: "UNLICENSED" }),
      pack(canopyd, "realtime", { name: "@canopy/realtime" }),
    ]
    const operations = stubs()
    await publishTarballs([native, canopyd], false, operations)
    expect(operations.isPublished).not.toHaveBeenCalled()
    expect(operations.warn).toHaveBeenCalledExactlyOnceWith(
      "Missing license or UNLICENSED: @canopy/native, @canopy/realtime",
    )
    expect(operations.runNpm.mock.calls).toEqual(
      paths.map((path) => [
        [
          "publish",
          path,
          "--access",
          "public",
          "--registry",
          "https://registry.npmjs.org/",
          "--ignore-scripts",
          "--dry-run",
          "--offline",
          "--force",
        ],
      ]),
    )
  })
})
