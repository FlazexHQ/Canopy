import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { isBuiltin } from "node:module"
import { join, posix, relative, resolve } from "node:path"
import ts from "typescript"

/** Directory names of the universal packages, which may only use Web standard APIs. */
export const UNIVERSAL_PACKAGES: readonly string[] = ["protocol", "matcher", "query", "policy"]

/** Shared compiler configurations a workspace package may extend, relative to the repository root. */
export const TSCONFIG_VARIANTS: readonly string[] = [
  "tsconfig.server.json",
  "tsconfig.universal.json",
  "tsconfig.web.json",
  "tsconfig.edge.json",
]

const PACKAGE_NAME = /^@canopy\/[a-z0-9]+(?:-[a-z0-9]+)*$/
const DEPENDENCY_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"] as const

/** A workspace package as found on disk. */
export interface WorkspacePackage {
  /** Directory relative to the repository root, with forward slashes. */
  readonly dir: string
  readonly manifest: Readonly<Record<string, unknown>>
}

/**
 * Checks that every workspace package follows the repository layout: a scoped `@canopy/` name, ESM,
 * a `tsconfig.json` that extends a shared variant and sets `rootDir`, and a reference from the root
 * solution `tsconfig.json`. Universal packages must extend the universal variant, depend only on
 * workspace packages at runtime, and never import Node built in modules.
 *
 * @returns the problems found; an empty array means the workspace is consistent.
 */
export async function checkWorkspace(rootDir: string): Promise<string[]> {
  const problems: string[] = []
  const rootManifest = await readJson(join(rootDir, "package.json"))
  if (!isRecord(rootManifest)) return ["package.json at the repository root is missing or invalid"]

  const packages = await listWorkspacePackages(rootDir, workspaceGlobs(rootManifest))
  const names = new Set<string>()
  for (const pkg of packages) {
    const name = pkg.manifest["name"]
    if (typeof name === "string") {
      if (names.has(name)) problems.push(`${pkg.dir}: the package name ${name} is used twice`)
      names.add(name)
    }
  }

  const references = readReferences(rootDir)
  if (typeof references === "string") return [...problems, references]
  for (const reference of references) {
    if (!existsSync(join(rootDir, reference, "tsconfig.json"))) {
      problems.push(`tsconfig.json references ${reference}, which has no tsconfig.json`)
    }
  }

  for (const pkg of packages) {
    problems.push(...(await checkPackage(rootDir, pkg, references, names)))
  }
  return problems
}

/** Lists workspace packages matched by `globs`. Only `dir/*` and plain directory globs are supported. */
export async function listWorkspacePackages(
  rootDir: string,
  globs: readonly string[],
): Promise<WorkspacePackage[]> {
  const found: WorkspacePackage[] = []
  for (const glob of globs) {
    const dirs = glob.endsWith("/*")
      ? await childDirectories(rootDir, glob.slice(0, -2))
      : [posix.normalize(glob)]
    for (const dir of dirs) {
      const manifest = await readJson(join(rootDir, dir, "package.json"))
      if (isRecord(manifest)) found.push({ dir, manifest })
    }
  }
  return found.sort((a, b) => a.dir.localeCompare(b.dir))
}

async function checkPackage(
  rootDir: string,
  pkg: WorkspacePackage,
  references: ReadonlySet<string>,
  workspaceNames: ReadonlySet<string>,
): Promise<string[]> {
  const { dir, manifest } = pkg
  const problems: string[] = []
  const name = manifest["name"]
  if (typeof name !== "string" || !PACKAGE_NAME.test(name)) {
    problems.push(`${dir}: the package name must match @canopy/<name> in lower case`)
  }
  if (manifest["type"] !== "module") {
    problems.push(`${dir}: package.json must set "type": "module"`)
  }
  if (!references.has(dir)) {
    problems.push(`${dir}: not referenced from the root tsconfig.json`)
  }

  const universal = UNIVERSAL_PACKAGES.includes(posix.basename(dir)) && dir.startsWith("packages/")
  const tsconfigPath = join(rootDir, dir, "tsconfig.json")
  const tsconfig = readTsconfig(tsconfigPath)
  if (tsconfig === undefined) {
    problems.push(`${dir}: tsconfig.json is missing or invalid`)
  } else {
    const extended = typeof tsconfig["extends"] === "string" ? tsconfig["extends"] : undefined
    const variant =
      extended === undefined
        ? undefined
        : relative(rootDir, resolve(rootDir, dir, extended)).replaceAll("\\", "/")
    if (variant === undefined || !TSCONFIG_VARIANTS.includes(variant)) {
      problems.push(`${dir}: tsconfig.json must extend one of ${TSCONFIG_VARIANTS.join(", ")}`)
    } else if (universal && variant !== "tsconfig.universal.json") {
      problems.push(`${dir}: a universal package must extend tsconfig.universal.json`)
    }
    const options = tsconfig["compilerOptions"]
    if (!isRecord(options) || typeof options["rootDir"] !== "string") {
      problems.push(`${dir}: tsconfig.json must set compilerOptions.rootDir explicitly`)
    }
  }

  if (universal) {
    problems.push(...checkUniversalDependencies(dir, manifest))
    problems.push(...(await checkUniversalImports(rootDir, dir, workspaceNames)))
  }
  return problems
}

function checkUniversalDependencies(
  dir: string,
  manifest: Readonly<Record<string, unknown>>,
): string[] {
  const problems: string[] = []
  for (const field of DEPENDENCY_FIELDS) {
    const deps = manifest[field]
    if (deps === undefined) continue
    if (!isRecord(deps)) {
      problems.push(`${dir}: ${field} must be an object`)
      continue
    }
    for (const [dependency, spec] of Object.entries(deps)) {
      if (typeof spec !== "string" || !spec.startsWith("workspace:")) {
        problems.push(
          `${dir}: universal packages may only depend on workspace packages at runtime, found ${dependency} in ${field}`,
        )
      }
    }
  }
  return problems
}

async function checkUniversalImports(
  rootDir: string,
  dir: string,
  workspaceNames: ReadonlySet<string>,
): Promise<string[]> {
  const problems: string[] = []
  const srcDir = join(rootDir, dir, "src")
  if (!existsSync(srcDir)) return problems
  for (const file of await sourceFiles(srcDir)) {
    if (/\.(?:test|spec|bench)\.[cm]?tsx?$/.test(file)) continue
    const text = await readFile(join(srcDir, file), "utf8")
    for (const { fileName: specifier } of ts.preProcessFile(text, true, true).importedFiles) {
      const where = `${dir}/src/${file}`
      if (specifier.startsWith("node:") || isBuiltin(specifier)) {
        problems.push(
          `${where}: universal packages must not import the Node built in "${specifier}"`,
        )
      } else if (!specifier.startsWith(".") && !workspaceNames.has(packageNameOf(specifier))) {
        problems.push(
          `${where}: universal packages must not import "${specifier}" from outside the workspace`,
        )
      }
    }
  }
  return problems
}

function packageNameOf(specifier: string): string {
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier)
}

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && /\.[cm]?tsx?$/.test(entry.name))
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .sort()
}

function workspaceGlobs(rootManifest: Readonly<Record<string, unknown>>): string[] {
  const workspaces = rootManifest["workspaces"]
  const globs = Array.isArray(workspaces)
    ? workspaces
    : isRecord(workspaces) && Array.isArray(workspaces["packages"])
      ? workspaces["packages"]
      : []
  return globs.filter((glob): glob is string => typeof glob === "string")
}

function readReferences(rootDir: string): Set<string> | string {
  const solution = readTsconfig(join(rootDir, "tsconfig.json"))
  if (solution === undefined) return "tsconfig.json at the repository root is missing or invalid"
  const references = solution["references"]
  const paths = new Set<string>()
  if (!Array.isArray(references)) return paths
  for (const reference of references) {
    if (isRecord(reference) && typeof reference["path"] === "string") {
      paths.add(posix.normalize(reference["path"].replaceAll("\\", "/")).replace(/\/$/, ""))
    }
  }
  return paths
}

async function childDirectories(rootDir: string, parent: string): Promise<string[]> {
  const absolute = join(rootDir, parent)
  if (!existsSync(absolute)) return []
  const entries = await readdir(absolute, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => posix.join(parent, entry.name))
}

function readTsconfig(path: string): Record<string, unknown> | undefined {
  const { config, error } = ts.readConfigFile(path.replaceAll("\\", "/"), ts.sys.readFile)
  return error === undefined && isRecord(config) ? config : undefined
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return undefined
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
