import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { join, posix } from "node:path"
import { parseToml, type TomlTable, type TomlValue } from "./toml.ts"

/** The `[package]` keys every crate takes from `[workspace.package]`. */
export const INHERITED_KEYS: readonly string[] = [
  "version",
  "edition",
  "rust-version",
  "publish",
  "repository",
]

/** Workspace lints the core crates rely on: no unsafe code, documented items, no panicking shortcuts. */
export const REQUIRED_LINTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  rust: { unsafe_code: "forbid", missing_docs: "deny" },
  clippy: { unwrap_used: "deny", expect_used: "deny", panic: "deny" },
}

/**
 * Checks the Cargo workspace: every crate under `crates/` is a member, every member inherits the shared
 * package keys (and the license once the workspace sets one), has a description and the name of its folder,
 * nothing is published, core crates keep the workspace lints, port crates sit beside their npm package, path
 * dependencies point at members, `Cargo.lock` exists and `rust-toolchain.toml` pins an exact version. A
 * repository without a root `Cargo.toml` has nothing to check.
 *
 * @returns the problems found; an empty array means the workspace is consistent.
 */
export async function checkCargo(rootDir: string): Promise<string[]> {
  const rootManifest = await readToml(rootDir, "Cargo.toml")
  if (rootManifest === undefined) return []
  if (typeof rootManifest === "string") return [rootManifest]
  const workspace = table(rootManifest["workspace"])
  if (workspace === undefined) return ["Cargo.toml: the root manifest must declare [workspace]"]

  const problems: string[] = []
  const members = await expandMembers(rootDir, workspace["members"], problems)
  for (const dir of await childDirectories(rootDir, "crates")) {
    if (existsSync(join(rootDir, dir, "Cargo.toml")) && !members.includes(dir)) {
      problems.push(`${dir}: not a member of the Cargo workspace`)
    }
  }

  const shared = table(workspace["package"]) ?? {}
  if (shared["publish"] !== false) {
    problems.push("Cargo.toml: [workspace.package] must set publish = false")
  }
  for (const key of INHERITED_KEYS) {
    if (key !== "publish" && shared[key] === undefined) {
      problems.push(`Cargo.toml: [workspace.package] must set ${key}`)
    }
  }
  const lints = table(workspace["lints"]) ?? {}
  for (const [group, required] of Object.entries(REQUIRED_LINTS)) {
    const declared = table(lints[group]) ?? {}
    for (const [lint, level] of Object.entries(required)) {
      if (levelOf(declared[lint]) !== level) {
        problems.push(`Cargo.toml: [workspace.lints.${group}] must set ${lint} = "${level}"`)
      }
    }
  }

  for (const dir of members) {
    problems.push(...(await checkMember(rootDir, dir, members, shared["license"] !== undefined)))
  }

  if (!existsSync(join(rootDir, "Cargo.lock"))) {
    problems.push("Cargo.lock is missing: the Rust lockfile is committed")
  }
  const toolchain = await readToml(rootDir, "rust-toolchain.toml")
  if (toolchain === undefined) problems.push("rust-toolchain.toml is missing")
  else if (typeof toolchain === "string") problems.push(toolchain)
  else {
    const channel = table(toolchain["toolchain"])?.["channel"]
    if (typeof channel !== "string" || !/^\d+\.\d+\.\d+$/.test(channel)) {
      problems.push("rust-toolchain.toml: [toolchain] must pin channel to an exact version")
    }
  }
  return problems
}

async function checkMember(
  rootDir: string,
  dir: string,
  members: readonly string[],
  licensed: boolean,
): Promise<string[]> {
  const manifest = await readToml(rootDir, `${dir}/Cargo.toml`)
  if (manifest === undefined) return [`${dir}: a workspace member without Cargo.toml`]
  if (typeof manifest === "string") return [manifest]
  const problems: string[] = []
  const where = `${dir}/Cargo.toml`
  const pkg = table(manifest["package"])
  if (pkg === undefined) return [`${where}: [package] is missing`]

  const folder = posix.basename(dir)
  const expected = folder.startsWith("canopy-") ? folder : `canopy-${folder}`
  if (pkg["name"] !== expected) problems.push(`${where}: the crate must be named ${expected}`)
  if (typeof pkg["description"] !== "string" || pkg["description"].trim() === "") {
    problems.push(`${where}: [package] must have a description`)
  }
  for (const key of licensed ? [...INHERITED_KEYS, "license"] : INHERITED_KEYS) {
    if (table(pkg[key])?.["workspace"] !== true) {
      problems.push(`${where}: [package] must set ${key}.workspace = true`)
    }
  }

  if (dir.startsWith("crates/")) {
    if (table(manifest["lints"])?.["workspace"] !== true) {
      problems.push(`${where}: a core crate must set [lints] workspace = true`)
    }
  } else if (!existsSync(join(rootDir, dir, "package.json"))) {
    problems.push(`${dir}: a crate outside crates/ is a port and must sit beside its npm package`)
  }

  for (const section of ["dependencies", "dev-dependencies", "build-dependencies"]) {
    for (const [name, spec] of Object.entries(table(manifest[section]) ?? {})) {
      const path = table(spec)?.["path"]
      if (typeof path !== "string") continue
      const target = posix.normalize(posix.join(dir, path.replaceAll("\\", "/")))
      if (!members.includes(target)) {
        problems.push(`${where}: ${name} points at ${path}, which is not a workspace member`)
      }
    }
  }
  return problems
}

async function expandMembers(
  rootDir: string,
  value: TomlValue | undefined,
  problems: string[],
): Promise<string[]> {
  if (!Array.isArray(value) || value.length === 0) {
    problems.push("Cargo.toml: [workspace] must list members")
    return []
  }
  const members: string[] = []
  for (const glob of value) {
    if (typeof glob !== "string") {
      problems.push("Cargo.toml: every workspace member must be a string")
      continue
    }
    if (glob.endsWith("/*")) members.push(...(await childDirectories(rootDir, glob.slice(0, -2))))
    else if (glob.includes("*")) problems.push(`Cargo.toml: only dir/* member globs are supported`)
    else members.push(posix.normalize(glob))
  }
  return [...new Set(members)].sort()
}

function levelOf(value: TomlValue | undefined): string | undefined {
  if (typeof value === "string") return value
  const level = table(value)?.["level"]
  return typeof level === "string" ? level : undefined
}

function table(value: TomlValue | undefined): TomlTable | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as TomlTable)
    : undefined
}

async function childDirectories(rootDir: string, parent: string): Promise<string[]> {
  const absolute = join(rootDir, parent)
  if (!existsSync(absolute)) return []
  const entries = await readdir(absolute, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => posix.join(parent, entry.name))
}

/** Reads a TOML file: the parsed table, `undefined` when it does not exist, or the problem as text. */
async function readToml(rootDir: string, file: string): Promise<TomlTable | string | undefined> {
  let text: string
  try {
    text = await readFile(join(rootDir, file), "utf8")
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
  try {
    return parseToml(text)
  } catch (error: unknown) {
    if (error instanceof Error) return `${file}: ${error.message}`
    throw error
  }
}
