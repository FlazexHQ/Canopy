import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { checkCargo } from "./cargo.ts"

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "repo-check-cargo-"))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function write(path: string, content: string): Promise<void> {
  const absolute = join(root, path)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, content)
}

const WORKSPACE = `[workspace]
resolver = "3"
members = ["crates/*", "packages/native"]

[workspace.package]
version = "0.0.0"
edition = "2024"
rust-version = "1.85"
publish = false
repository = "https://example.com/canopy"

[workspace.lints.rust]
unsafe_code = "forbid"
missing_docs = "deny"

[workspace.lints.clippy]
unwrap_used = "deny"
expect_used = "deny"
panic = { level = "deny", priority = 1 }
`

function crate(name: string, extra = "[lints]\nworkspace = true\n"): string {
  return `[package]
name = "${name}"
description = "The ${name} crate."
version.workspace = true
edition.workspace = true
rust-version.workspace = true
publish.workspace = true
repository.workspace = true

${extra}`
}

async function valid(): Promise<void> {
  await write("Cargo.toml", WORKSPACE)
  await write("Cargo.lock", "version = 4\n")
  await write("rust-toolchain.toml", '[toolchain]\nchannel = "1.100.0"\n')
  await write("crates/canopy-protocol/Cargo.toml", crate("canopy-protocol"))
  await write(
    "crates/canopy-matcher/Cargo.toml",
    crate(
      "canopy-matcher",
      '[dependencies]\ncanopy-protocol = { path = "../canopy-protocol" }\n\n[lints]\nworkspace = true\n',
    ),
  )
  await write(
    "packages/native/Cargo.toml",
    crate(
      "canopy-native",
      '[dependencies]\ncanopy-matcher = { path = "../../crates/canopy-matcher" }\n',
    ),
  )
  await write("packages/native/package.json", "{}")
}

describe("checkCargo", () => {
  it("has nothing to check without a root Cargo.toml", async () => {
    expect(await checkCargo(root)).toEqual([])
  })

  it("accepts a consistent workspace", async () => {
    await valid()
    expect(await checkCargo(root)).toEqual([])
  })

  it("accepts the canopyd data plane crate", async () => {
    await valid()
    await write("crates/canopyd/Cargo.toml", crate("canopyd"))
    expect(await checkCargo(root)).toEqual([])
  })

  it("finds crates that are not members and members without a manifest", async () => {
    await valid()
    await write(
      "Cargo.toml",
      WORKSPACE.replace(
        'members = ["crates/*", "packages/native"]',
        'members = ["packages/native", "tools/gone"]',
      ),
    )
    expect(await checkCargo(root)).toEqual([
      "crates/canopy-matcher: not a member of the Cargo workspace",
      "crates/canopy-protocol: not a member of the Cargo workspace",
      "packages/native/Cargo.toml: canopy-matcher points at ../../crates/canopy-matcher, which is not a workspace member",
      "tools/gone: a workspace member without Cargo.toml",
    ])
  })

  it("requires publish = false, the shared keys and the core lints", async () => {
    await valid()
    await write(
      "Cargo.toml",
      WORKSPACE.replace("publish = false", "publish = true")
        .replace('edition = "2024"\n', "")
        .replace('unsafe_code = "forbid"', 'unsafe_code = "deny"')
        .replace('panic = { level = "deny", priority = 1 }', 'panic = "warn"'),
    )
    expect(await checkCargo(root)).toEqual([
      "Cargo.toml: [workspace.package] must set publish = false",
      "Cargo.toml: [workspace.package] must set edition",
      'Cargo.toml: [workspace.lints.rust] must set unsafe_code = "forbid"',
      'Cargo.toml: [workspace.lints.clippy] must set panic = "deny"',
    ])
  })

  it("checks the name, description, inherited keys and lints of each crate", async () => {
    await valid()
    await write(
      "crates/canopy-protocol/Cargo.toml",
      crate("protocol", "")
        .replace('description = "The protocol crate."\n', "")
        .replace("edition.workspace = true", 'edition = "2021"'),
    )
    expect(await checkCargo(root)).toEqual([
      "crates/canopy-protocol/Cargo.toml: the crate must be named canopy-protocol",
      "crates/canopy-protocol/Cargo.toml: [package] must have a description",
      "crates/canopy-protocol/Cargo.toml: [package] must set edition.workspace = true",
      "crates/canopy-protocol/Cargo.toml: a core crate must set [lints] workspace = true",
    ])
  })

  it("requires the license of the workspace once it sets one", async () => {
    await valid()
    await write(
      "Cargo.toml",
      WORKSPACE.replace("publish = false", 'publish = false\nlicense = "MIT"'),
    )
    const problems = await checkCargo(root)
    expect(problems).toHaveLength(3)
    expect(problems).toContain(
      "crates/canopy-matcher/Cargo.toml: [package] must set license.workspace = true",
    )
  })

  it("requires a port crate outside crates/ to sit beside its npm package", async () => {
    await valid()
    await rm(join(root, "packages/native/package.json"))
    expect(await checkCargo(root)).toEqual([
      "packages/native: a crate outside crates/ is a port and must sit beside its npm package",
    ])
  })

  it("requires the lockfile and an exact toolchain", async () => {
    await valid()
    await rm(join(root, "Cargo.lock"))
    await write("rust-toolchain.toml", '[toolchain]\nchannel = "stable"\n')
    expect(await checkCargo(root)).toEqual([
      "Cargo.lock is missing: the Rust lockfile is committed",
      "rust-toolchain.toml: [toolchain] must pin channel to an exact version",
    ])
  })

  it("reports a manifest it cannot read", async () => {
    await valid()
    await write("crates/canopy-protocol/Cargo.toml", "[package\nname = 1")
    expect(await checkCargo(root)).toEqual([
      "crates/canopy-protocol/Cargo.toml: line 1: a table header must end with ]",
    ])
  })
})
