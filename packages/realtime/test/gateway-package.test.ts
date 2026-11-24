import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { NATIVE_TARGETS, type NativeTarget, targetFor } from "@canopy/native"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { findGatewayBinary, missingGatewayMessage } from "../src/gateway.ts"
import { gatewayExecutable, gatewayPackage, packagedGateway } from "../src/gateway-package.ts"

const HOST_BINARY = gatewayExecutable(process.platform)

function target(os: string, cpu: string, libc?: "glibc" | "musl"): NativeTarget {
  const found = targetFor(os, cpu, libc)
  if (found === undefined) throw new Error(`no target ${os} ${cpu} ${libc ?? ""}`)
  return found
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopyd-package-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Installs a fake platform package into `nodeModules` and returns the path of its executable. */
async function install(
  nodeModules: string,
  forTarget: NativeTarget,
  options: { readonly manifest?: boolean; readonly executable?: boolean } = {},
): Promise<string> {
  const folder = join(nodeModules, ...gatewayPackage(forTarget).split("/"))
  await mkdir(folder, { recursive: true })
  if (options.manifest !== false)
    await writeFile(
      join(folder, "package.json"),
      JSON.stringify({ name: gatewayPackage(forTarget), version: "0.0.0" }),
    )
  const binary = join(folder, gatewayExecutable(forTarget.os))
  if (options.executable !== false) await writeFile(binary, "")
  return binary
}

/** A folder standing for the compiled `@canopy/realtime` inside `nodeModules`. */
async function launcher(nodeModules: string): Promise<string> {
  const folder = join(nodeModules, "@canopy", "realtime", "dist")
  await mkdir(folder, { recursive: true })
  return folder
}

describe("gatewayPackage", () => {
  it("names one package per target with the suffixes of @canopy/native", () => {
    expect(NATIVE_TARGETS.map(gatewayPackage)).toEqual([
      "@canopy/canopyd-win32-x64-msvc",
      "@canopy/canopyd-win32-arm64-msvc",
      "@canopy/canopyd-darwin-x64",
      "@canopy/canopyd-darwin-arm64",
      "@canopy/canopyd-linux-x64-gnu",
      "@canopy/canopyd-linux-x64-musl",
      "@canopy/canopyd-linux-arm64-gnu",
      "@canopy/canopyd-linux-arm64-musl",
    ])
    expect(gatewayExecutable("win32")).toBe("canopyd.exe")
    expect(gatewayExecutable("linux")).toBe("canopyd")
    expect(gatewayExecutable("darwin")).toBe("canopyd")
  })
})

describe("packagedGateway", () => {
  it("finds the package of every target from an npm layout", async () => {
    const nodeModules = join(dir, "app", "node_modules")
    const from = await launcher(nodeModules)
    for (const each of NATIVE_TARGETS) {
      const binary = await install(nodeModules, each)
      expect(packagedGateway(each, from)).toBe(binary)
    }
  })

  it("finds it beside the launcher in the pnpm and Bun isolated layouts", async () => {
    const linux = target("linux", "arm64", "musl")
    for (const store of [".pnpm/@canopy+realtime@0.0.0", ".bun/@canopy+realtime@0.0.0"]) {
      const nodeModules = join(dir, store, "node_modules")
      const from = await launcher(nodeModules)
      const binary = await install(nodeModules, linux)
      expect(packagedGateway(linux, from)).toBe(binary)
    }
  })

  it("picks the package of the C library it is asked for", async () => {
    const gnuOnly = join(dir, "gnu", "node_modules")
    const gnuFrom = await launcher(gnuOnly)
    const gnu = await install(gnuOnly, target("linux", "x64", "glibc"))
    expect(packagedGateway(target("linux", "x64", "glibc"), gnuFrom)).toBe(gnu)
    expect(packagedGateway(target("linux", "x64", "musl"), gnuFrom)).toBeUndefined()
    expect(packagedGateway(target("linux", "arm64", "glibc"), gnuFrom)).toBeUndefined()
    const muslOnly = join(dir, "musl", "node_modules")
    const muslFrom = await launcher(muslOnly)
    const musl = await install(muslOnly, target("linux", "x64", "musl"))
    expect(packagedGateway(target("linux", "x64", "musl"), muslFrom)).toBe(musl)
    expect(packagedGateway(target("linux", "x64", "glibc"), muslFrom)).toBeUndefined()
  })

  it("finds nothing without a target, a resolvable package or its executable", async () => {
    const nodeModules = join(dir, "node_modules")
    const from = await launcher(nodeModules)
    const darwin = target("darwin", "arm64")
    const win = target("win32", "x64")
    expect(packagedGateway(undefined, from)).toBeUndefined()
    await install(nodeModules, darwin, { manifest: false })
    expect(packagedGateway(darwin, from)).toBeUndefined()
    await install(nodeModules, win, { executable: false })
    expect(packagedGateway(win, from)).toBeUndefined()
  })

  it.skipIf(process.platform === "win32")(
    "makes an executable unpacked without its permission bits runnable",
    async () => {
      const nodeModules = join(dir, "node_modules")
      const from = await launcher(nodeModules)
      const linux = target("linux", "x64", "glibc")
      const binary = await install(nodeModules, linux)
      await chmod(binary, 0o644)
      expect(packagedGateway(linux, from)).toBe(binary)
      expect((await stat(binary)).mode & 0o777).toBe(0o755)
      await chmod(binary, 0o600)
      packagedGateway(linux, from)
      expect((await stat(binary)).mode & 0o777).toBe(0o700)
    },
  )
})

describe("findGatewayBinary with a platform package", () => {
  it("prefers CANOPYD_BIN, then the platform package, then a Cargo build, the executable's folder and PATH", async () => {
    const host = target("linux", "x64", "musl")
    for (const folder of ["beside", "path"]) {
      await mkdir(join(dir, folder), { recursive: true })
      await writeFile(join(dir, folder, HOST_BINARY), "")
    }
    const exec = join(dir, "beside", "canopy")
    const path = join(dir, "path")
    const repo = async (name: string): Promise<{ from: string; cargo: string }> => {
      await mkdir(join(dir, name, "target", "release"), { recursive: true })
      const cargo = join(dir, name, "target", "release", HOST_BINARY)
      await writeFile(cargo, "")
      return { from: await launcher(join(dir, name, "node_modules")), cargo }
    }

    const bare = await repo("bare")
    expect(findGatewayBinary({ PATH: path }, exec, bare.from, host)).toBe(bare.cargo)

    const installed = await repo("installed")
    const packaged = await install(join(dir, "installed", "node_modules"), host)
    expect(findGatewayBinary({ PATH: path }, exec, installed.from, host)).toBe(packaged)
    expect(
      findGatewayBinary({ CANOPYD_BIN: "own/canopyd", PATH: path }, exec, installed.from, host),
    ).toBe(join(process.cwd(), "own", "canopyd"))
    expect(
      findGatewayBinary({ PATH: path }, exec, installed.from, target("linux", "x64", "glibc")),
    ).toBe(installed.cargo)
    expect(findGatewayBinary({ PATH: path }, exec, installed.from, target("darwin", "arm64"))).toBe(
      installed.cargo,
    )

    await rm(join(dir, "installed", "target"), { recursive: true })
    expect(findGatewayBinary({ PATH: path }, exec, installed.from, target("darwin", "x64"))).toBe(
      join(dir, "beside", HOST_BINARY),
    )
    expect(
      findGatewayBinary(
        { PATH: [join(dir, "none"), path].join(delimiter) },
        join(dir, "x"),
        installed.from,
        target("win32", "arm64"),
      ),
    ).toBe(join(path, HOST_BINARY))
    expect(findGatewayBinary({ PATH: path }, join(dir, "x"), installed.from, host)).toBe(packaged)
  })
})

describe("missingGatewayMessage", () => {
  it("names the platform package to install", () => {
    const musl = missingGatewayMessage(target("linux", "arm64", "musl"))
    expect(musl).toContain("Install @canopy/canopyd-linux-arm64-musl")
    expect(musl).toContain("linux arm64 (musl)")
    expect(musl).toContain("CANOPYD_BIN")
    expect(musl).toContain("cargo build --release -p canopyd")
    expect(missingGatewayMessage(target("win32", "x64"))).toContain(
      "Install @canopy/canopyd-win32-x64-msvc, the prebuilt canopyd for win32 x64 that",
    )
  })

  it("says when the platform has no prebuilt canopyd", () => {
    const message = missingGatewayMessage(undefined)
    expect(message).not.toContain("@canopy/canopyd-")
    expect(message).toContain(`none is prebuilt for ${process.platform} ${process.arch}`)
    expect(message).toContain("cargo build --release -p canopyd")
  })
})
