import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { hostTarget, NATIVE_TARGETS, type NativeTarget, targetFor } from "@canopy/native"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  optionalDependencies,
  pack,
  platformManifest,
  type Release,
  stagePlatformPackage,
  stageStudioPackage,
  tarballName,
  verifyLauncherTarball,
  verifyPlatformTarball,
  verifyStudioTarball,
} from "../scripts/canopyd-packages.ts"
import { gatewayExecutable, gatewayPackage } from "../src/gateway-package.ts"

const RELEASE: Release = {
  version: "1.2.3",
  license: "UNLICENSED",
  repository: {
    type: "git",
    url: "git+https://github.com/FlazexHQ/Canopy.git",
    directory: "packages/realtime",
  },
}

function target(os: string, cpu: string, libc?: "glibc" | "musl"): NativeTarget {
  const found = targetFor(os, cpu, libc)
  if (found === undefined) throw new Error(`no target ${os} ${cpu} ${libc ?? ""}`)
  return found
}

/** The first bytes of an executable for `os` and `cpu`, as the PE, ELF and Mach-O formats lay them out. */
function executable(os: NativeTarget["os"], cpu: string, linked = ""): Buffer {
  const body = Buffer.alloc(256)
  if (os === "win32") {
    body.write("MZ", 0, "latin1")
    body.writeUInt32LE(0x80, 0x3c)
    body.write("PE\0\0", 0x80, "latin1")
    body.writeUInt16LE(cpu === "x64" ? 0x8664 : 0xaa64, 0x84)
  } else if (os === "linux") {
    body.write("\x7fELF", 0, "latin1")
    body[4] = 2
    body[5] = 1
    body.writeUInt16LE(3, 16)
    body.writeUInt16LE(cpu === "x64" ? 62 : 183, 18)
  } else {
    body.writeUInt32LE(0xfeedfacf, 0)
    body.writeUInt32LE(cpu === "x64" ? 0x01000007 : 0x0100000c, 4)
  }
  return Buffer.concat([body, Buffer.from(linked, "latin1")])
}

/** The executable a correct release build of `forTarget` would be. */
function releaseBuild(forTarget: NativeTarget): Buffer {
  return executable(
    forTarget.os,
    forTarget.cpu,
    forTarget.libc === "glibc" ? "memcpy\0GLIBC_2.2.5\0GLIBC_2.17\0" : "",
  )
}

interface Entry {
  readonly path: string
  readonly body: Buffer
  readonly mode: number
}

/** A gzipped ustar archive of `entries`, the format of npm package tarballs. */
function tarball(entries: readonly Entry[]): Buffer {
  const blocks: Buffer[] = []
  for (const { path, body, mode } of entries) {
    const header = Buffer.alloc(512)
    header.write(path, 0, 100, "utf8")
    header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, "latin1")
    header.write("0000000\0", 108, "latin1")
    header.write("0000000\0", 116, "latin1")
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, "latin1")
    header.write("00000000000\0", 136, "latin1")
    header.write("        ", 148, "latin1")
    header.write("0", 156, "latin1")
    header.write("ustar\0" + "00", 257, "latin1")
    const sum = header.reduce((total, byte) => total + byte, 0)
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1")
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopyd-pack-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Writes the tarball of a platform package for `forTarget` and returns its path. */
async function platformTarball(
  forTarget: NativeTarget,
  options: {
    readonly manifest?: Record<string, unknown>
    readonly binary?: Buffer
    readonly cli?: Buffer
    readonly mode?: number
  } = {},
): Promise<string> {
  const manifest = options.manifest ?? platformManifest(forTarget, RELEASE)
  const file = join(dir, `${forTarget.suffix}.tgz`)
  await writeFile(
    file,
    tarball([
      {
        path: "package/package.json",
        body: Buffer.from(JSON.stringify(manifest)),
        mode: 0o644,
      },
      {
        path: `package/${gatewayExecutable(forTarget.os)}`,
        body: options.binary ?? releaseBuild(forTarget),
        mode: options.mode ?? 0o755,
      },
      {
        path: forTarget.os === "win32" ? "package/canopy.exe" : "package/canopy",
        body: options.cli ?? releaseBuild(forTarget),
        mode: 0o755,
      },
    ]),
  )
  return file
}

describe("platformManifest", () => {
  it("restricts each package to its operating system, processor and C library", () => {
    const fields = NATIVE_TARGETS.map((each) => {
      const { name, os, cpu, libc, files } = platformManifest(each, RELEASE)
      return { name, os, cpu, libc, files }
    })
    expect(fields).toEqual([
      {
        name: "@canopy/canopyd-win32-x64-msvc",
        os: ["win32"],
        cpu: ["x64"],
        libc: undefined,
        files: ["canopyd.exe", "canopy.exe"],
      },
      {
        name: "@canopy/canopyd-win32-arm64-msvc",
        os: ["win32"],
        cpu: ["arm64"],
        libc: undefined,
        files: ["canopyd.exe", "canopy.exe"],
      },
      {
        name: "@canopy/canopyd-darwin-x64",
        os: ["darwin"],
        cpu: ["x64"],
        libc: undefined,
        files: ["canopyd", "canopy"],
      },
      {
        name: "@canopy/canopyd-darwin-arm64",
        os: ["darwin"],
        cpu: ["arm64"],
        libc: undefined,
        files: ["canopyd", "canopy"],
      },
      {
        name: "@canopy/canopyd-linux-x64-gnu",
        os: ["linux"],
        cpu: ["x64"],
        libc: ["glibc"],
        files: ["canopyd", "canopy"],
      },
      {
        name: "@canopy/canopyd-linux-x64-musl",
        os: ["linux"],
        cpu: ["x64"],
        libc: ["musl"],
        files: ["canopyd", "canopy"],
      },
      {
        name: "@canopy/canopyd-linux-arm64-gnu",
        os: ["linux"],
        cpu: ["arm64"],
        libc: ["glibc"],
        files: ["canopyd", "canopy"],
      },
      {
        name: "@canopy/canopyd-linux-arm64-musl",
        os: ["linux"],
        cpu: ["arm64"],
        libc: ["musl"],
        files: ["canopyd", "canopy"],
      },
    ])
  })

  it("takes release metadata, exposes executable paths and asks Yarn to unplug it", () => {
    const manifest = platformManifest(target("darwin", "arm64"), RELEASE)
    expect(manifest["version"]).toBe("1.2.3")
    expect(manifest["license"]).toBe("UNLICENSED")
    expect(manifest["preferUnplugged"]).toBe(true)
    expect(manifest["main"]).toBeUndefined()
    expect(manifest["bin"]).toBeUndefined()
    for (const each of NATIVE_TARGETS)
      expect(platformManifest(each, RELEASE)["dependencies"]).toEqual({
        "@canopy/studio-assets": "1.2.3",
      })
    expect(manifest["exports"]).toEqual({
      "./package.json": "./package.json",
      "./canopy": "./canopy",
      "./canopyd": "./canopyd",
    })
    expect(platformManifest(target("win32", "arm64"), RELEASE)["exports"]).toEqual({
      "./package.json": "./package.json",
      "./canopy": "./canopy.exe",
      "./canopyd.exe": "./canopyd.exe",
    })
    expect(manifest["description"]).toContain("aarch64-apple-darwin")
    expect("libc" in manifest).toBe(false)
  })
})

describe("stagePlatformPackage", () => {
  it("writes the manifest, both executables and a README for every target", async () => {
    const binary = join(dir, "built")
    const cli = join(dir, "built-cli")
    await writeFile(binary, "canopyd build")
    await writeFile(cli, "canopy build")
    for (const each of NATIVE_TARGETS) {
      const folder = join(dir, "staging", each.suffix)
      const cliFile = each.os === "win32" ? "canopy.exe" : "canopy"
      stagePlatformPackage(each, { gateway: binary, cli }, folder, RELEASE)
      expect((await readdir(folder)).sort()).toEqual(
        ["README.md", cliFile, gatewayExecutable(each.os), "package.json"].sort(),
      )
      expect(JSON.parse(await readFile(join(folder, "package.json"), "utf8"))).toEqual(
        platformManifest(each, RELEASE),
      )
      expect(await readFile(join(folder, gatewayExecutable(each.os)), "utf8")).toBe("canopyd build")
      expect(await readFile(join(folder, cliFile), "utf8")).toBe("canopy build")
      const readme = await readFile(join(folder, "README.md"), "utf8")
      expect(readme).toContain(`# ${gatewayPackage(each)}`)
      expect(readme).toContain(each.triple)
      if (process.platform !== "win32" && each.os !== "win32") {
        expect((await stat(join(folder, "canopyd"))).mode & 0o777).toBe(0o755)
        expect((await stat(join(folder, cliFile))).mode & 0o777).toBe(0o755)
      }
    }
  })

  it("replaces what a previous run left in the folder", async () => {
    const binary = join(dir, "built")
    await writeFile(binary, "")
    const folder = join(dir, "staging")
    stagePlatformPackage(target("win32", "x64"), { gateway: binary, cli: binary }, folder, RELEASE)
    stagePlatformPackage(
      target("linux", "arm64", "musl"),
      { gateway: binary, cli: binary },
      folder,
      RELEASE,
    )
    expect((await readdir(folder)).sort()).toEqual([
      "README.md",
      "canopy",
      "canopyd",
      "package.json",
    ])
  })
})

describe("optionalDependencies", () => {
  it("names each platform package at the launcher's version", () => {
    expect(
      optionalDependencies([target("win32", "arm64"), target("linux", "x64", "musl")], "2.0.0"),
    ).toEqual({
      "@canopy/canopyd-win32-arm64-msvc": "2.0.0",
      "@canopy/canopyd-linux-x64-musl": "2.0.0",
    })
    expect(Object.keys(optionalDependencies(NATIVE_TARGETS, "1.0.0"))).toHaveLength(8)
  })

  it("matches the tarball names of bun pm pack", () => {
    expect(tarballName("@canopy/canopyd-darwin-x64", "1.2.3")).toBe(
      "canopy-canopyd-darwin-x64-1.2.3.tgz",
    )
  })
})

describe("verifyPlatformTarball", () => {
  it("accepts a correct package of every target", async () => {
    for (const each of NATIVE_TARGETS)
      expect(verifyPlatformTarball(await platformTarball(each), each, RELEASE, true)).toEqual([])
  })

  it("refuses a package whose fields name another platform", async () => {
    const musl = target("linux", "x64", "musl")
    const gnu = target("linux", "x64", "glibc")
    const file = await platformTarball(musl, {
      manifest: { ...platformManifest(gnu, RELEASE), version: "1.2.4" },
    })
    expect(verifyPlatformTarball(file, musl, RELEASE, false)).toEqual([
      `${file}: name is "@canopy/canopyd-linux-x64-gnu", not "@canopy/canopyd-linux-x64-musl"`,
      `${file}: version is "1.2.4", not "1.2.3"`,
      `${file}: libc is ["glibc"], not ["musl"]`,
    ])
  })

  it("refuses an executable for another processor or operating system", async () => {
    const arm = target("darwin", "arm64")
    const intel = await platformTarball(arm, { cli: executable("darwin", "x64") })
    expect(verifyPlatformTarball(intel, arm, RELEASE, false)).toEqual([
      `${intel}: canopy is {"format":"macho","cpu":"x64"}, not {"format":"macho","cpu":"arm64"}`,
    ])
    const win = target("win32", "x64")
    const elf = await platformTarball(win, { binary: executable("linux", "x64") })
    expect(verifyPlatformTarball(elf, win, RELEASE, false)).toEqual([
      `${elf}: canopyd.exe is {"format":"elf","cpu":"x64"}, not {"format":"pe","cpu":"x64"}`,
    ])
  })

  it("refuses an executable without its execute bits outside Windows", async () => {
    const linux = target("linux", "arm64", "glibc")
    const file = await platformTarball(linux, { mode: 0o644 })
    expect(verifyPlatformTarball(file, linux, RELEASE, false)).toEqual([
      `${file}: canopyd is not executable`,
    ])
    const win = target("win32", "arm64")
    expect(
      verifyPlatformTarball(await platformTarball(win, { mode: 0o644 }), win, RELEASE, false),
    ).toEqual([])
  })

  it("checks the glibc a Linux build links against only with the baseline check", async () => {
    const gnu = target("linux", "x64", "glibc")
    const newer = await platformTarball(gnu, {
      cli: executable("linux", "x64", "GLIBC_2.17\0GLIBC_2.34\0"),
    })
    expect(verifyPlatformTarball(newer, gnu, RELEASE, true)).toEqual([
      `${newer}: canopy needs glibc 2.34, newer than 2.17`,
    ])
    expect(verifyPlatformTarball(newer, gnu, RELEASE, false)).toEqual([])
    const musl = target("linux", "arm64", "musl")
    const dynamic = await platformTarball(musl, {
      binary: executable("linux", "arm64", "GLIBC_2.17\0"),
    })
    expect(verifyPlatformTarball(dynamic, musl, RELEASE, true)).toEqual([
      `${dynamic}: canopyd references glibc 2.17`,
    ])
  })

  it("reports missing executables", async () => {
    const darwin = target("darwin", "x64")
    const file = join(dir, "empty.tgz")
    await writeFile(
      file,
      tarball([
        {
          path: "package/package.json",
          body: Buffer.from(JSON.stringify(platformManifest(darwin, RELEASE))),
          mode: 0o644,
        },
      ]),
    )
    expect(verifyPlatformTarball(file, darwin, RELEASE, true)).toEqual([
      `${file}: canopyd is missing`,
      `${file}: canopy is missing`,
    ])
  })
})

describe("verifyLauncherTarball", () => {
  const optional = { "@canopy/canopyd-darwin-arm64": "1.2.3" }
  const launcher = (manifest: Record<string, unknown>, built: boolean): Buffer =>
    tarball([
      { path: "package/package.json", body: Buffer.from(JSON.stringify(manifest)), mode: 0o644 },
      ...(built
        ? ["dist/index.js", "dist/index.d.ts", "dist/gateway-package.js"].map((path) => ({
            path: `package/${path}`,
            body: Buffer.from(""),
            mode: 0o644,
          }))
        : []),
    ])

  it("accepts the launcher naming exactly the packed platform packages", async () => {
    const file = join(dir, "launcher.tgz")
    await writeFile(
      file,
      launcher(
        { name: "@canopy/realtime", version: "1.2.3", optionalDependencies: optional },
        true,
      ),
    )
    expect(verifyLauncherTarball(file, "@canopy/realtime", "1.2.3", optional)).toEqual([])
  })

  it("refuses a launcher without the optional dependencies or its build", async () => {
    const file = join(dir, "launcher.tgz")
    await writeFile(file, launcher({ name: "@canopy/realtime", version: "1.2.3" }, false))
    expect(verifyLauncherTarball(file, "@canopy/realtime", "1.2.3", optional)).toEqual([
      `${file}: optionalDependencies is undefined, not {"@canopy/canopyd-darwin-arm64":"1.2.3"}`,
      `${file}: dist/index.js is missing`,
      `${file}: dist/index.d.ts is missing`,
      `${file}: dist/gateway-package.js is missing`,
    ])
  })
})

const bun = process.versions["bun"] === undefined ? "bun" : process.execPath
const hasBun = spawnSync(bun, ["--version"]).status === 0
const host = hostTarget()

describe("pack", () => {
  it.skipIf(!hasBun)(
    "packs the shared Studio app and keeps notices outside the served directory",
    async () => {
      const build = join(dir, "studio")
      await mkdir(join(build, "assets"), { recursive: true })
      await writeFile(join(build, "index.html"), "<title>Canopy Studio</title>")
      await writeFile(join(build, "assets", "entry.js"), "export {}")
      await writeFile(join(build, "THIRD-PARTY-NOTICES.md"), "# Licenses\n")
      const folder = join(dir, "studio-package")
      stageStudioPackage(build, folder, RELEASE)
      expect((await readdir(join(folder, "app"))).sort()).toEqual(["assets", "index.html"])
      expect(await readFile(join(folder, "THIRD-PARTY-NOTICES.md"), "utf8")).toBe("# Licenses\n")
      const packs = join(dir, "packs")
      pack(bun, folder, packs)
      expect(verifyStudioTarball(join(packs, "canopy-studio-assets-1.2.3.tgz"), RELEASE)).toEqual(
        [],
      )
    },
  )

  it.skipIf(!hasBun || host === undefined)(
    "packs a staged package of this platform that passes the checks",
    async () => {
      if (host === undefined) return
      const binary = join(dir, "built")
      await writeFile(binary, releaseBuild(host))
      const folder = join(dir, "staging")
      stagePlatformPackage(host, { gateway: binary, cli: binary }, folder, RELEASE)
      const packs = join(dir, "packs")
      pack(bun, folder, packs)
      const file = join(packs, tarballName(gatewayPackage(host), RELEASE.version))
      expect(verifyPlatformTarball(file, host, RELEASE, true)).toEqual([])
    },
  )
})
