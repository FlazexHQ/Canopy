import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

/** One exported symbol of a public entry point. */
export interface ApiExport {
  readonly name: string
  readonly kind: string
  readonly doc: string
  readonly signature: string
  readonly members: readonly { readonly name: string; readonly doc: string }[]
  readonly file: string
  readonly line: number
  readonly external: boolean
}

/** A package entry point (`@canopy/client/server`) and what it exports. */
export interface ApiEntry {
  readonly specifier: string
  readonly exports: readonly ApiExport[]
}

/** A published workspace package with its description and entry points. */
export interface ApiPackage {
  readonly name: string
  readonly description: string
  readonly entries: readonly ApiEntry[]
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const out = join(root, "apps", "docs", "src", "content", "docs", "reference", "api")

interface Manifest {
  readonly name: string
  readonly private?: boolean
  readonly description?: string
  readonly exports?: Record<string, unknown>
}

async function publicPackages(): Promise<{ manifest: Manifest; dir: string }[]> {
  const base = join(root, "packages")
  const found: { manifest: Manifest; dir: string }[] = []
  for (const name of (await readdir(base)).sort()) {
    const dir = join(base, name)
    let text: string
    try {
      text = await readFile(join(dir, "package.json"), "utf8")
    } catch {
      continue
    }
    const manifest = JSON.parse(text) as Manifest
    if (manifest.private !== true) found.push({ manifest, dir })
  }
  return found
}

function sourceOf(target: unknown): string | undefined {
  if (typeof target !== "object" || target === null) return undefined
  const source = (target as Record<string, unknown>)["@canopy/source"]
  return typeof source === "string" && /\.tsx?$/.test(source) ? source : undefined
}

function kindOf(symbol: ts.Symbol): string {
  const flags = symbol.flags
  if (flags & ts.SymbolFlags.Class) return "class"
  if (flags & ts.SymbolFlags.Function) return "function"
  if (flags & ts.SymbolFlags.Interface) return "interface"
  if (flags & ts.SymbolFlags.TypeAlias) return "type"
  if (flags & ts.SymbolFlags.Enum) return "enum"
  if (flags & ts.SymbolFlags.Variable) return "const"
  return "export"
}

const text = (parts: readonly ts.SymbolDisplayPart[]): string =>
  ts.displayPartsToString(parts as ts.SymbolDisplayPart[]).trim()

const jsdocOf = (node: ts.Node): string =>
  ts
    .getJSDocCommentsAndTags(node)
    .filter((tag): tag is ts.JSDoc => ts.isJSDoc(tag))
    .map((tag) => ts.getTextOfJSDocComment(tag.comment) ?? "")
    .join("\n")
    .trim()

function docOf(symbol: ts.Symbol, checker: ts.TypeChecker): string {
  const summary = text(symbol.getDocumentationComment(checker))
  if (summary !== "") return summary
  for (const declaration of symbol.declarations ?? []) {
    const doc = jsdocOf(declaration)
    if (doc !== "") return doc
  }
  return ""
}

function signatureOf(name: string, symbol: ts.Symbol, checker: ts.TypeChecker): string {
  const declaration = symbol.declarations?.[0]
  if (declaration === undefined) return name
  if (symbol.flags & ts.SymbolFlags.Function) {
    const type = checker.getTypeOfSymbolAtLocation(symbol, declaration)
    return type
      .getCallSignatures()
      .map(
        (signature) =>
          `function ${name}${checker.signatureToString(signature, undefined, ts.TypeFormatFlags.NoTruncation)}`,
      )
      .join("\n")
  }
  if (ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration)) {
    return declaration.getText()
  }
  if (ts.isClassDeclaration(declaration)) {
    const heritage = (declaration.heritageClauses ?? []).map((clause) => clause.getText()).join(" ")
    const generics = declaration.typeParameters
      ? `<${declaration.typeParameters.map((parameter) => parameter.getText()).join(", ")}>`
      : ""
    return `class ${name}${generics}${heritage === "" ? "" : ` ${heritage}`}`
  }
  const type = checker.getTypeOfSymbolAtLocation(symbol, declaration)
  const shown = checker.typeToString(type, declaration, ts.TypeFormatFlags.NoTruncation)
  return `const ${name}: ${shown.length > 600 ? `${shown.slice(0, 600)}...` : shown}`
}

function isPublicMember(declaration: ts.Declaration): boolean {
  const modifiers = ts.canHaveModifiers(declaration) ? (ts.getModifiers(declaration) ?? []) : []
  if (
    modifiers.some(
      (modifier) =>
        modifier.kind === ts.SyntaxKind.PrivateKeyword ||
        modifier.kind === ts.SyntaxKind.ProtectedKeyword,
    )
  )
    return false
  const name = ts.getNameOfDeclaration(declaration)
  return name === undefined || !ts.isPrivateIdentifier(name)
}

function membersOf(symbol: ts.Symbol, checker: ts.TypeChecker): ApiExport["members"] {
  if (!(symbol.flags & ts.SymbolFlags.Class)) return []
  const members: { name: string; doc: string }[] = []
  const declaration = symbol.declarations?.find(ts.isClassDeclaration)
  if (declaration === undefined) return []
  for (const member of declaration.members) {
    if (!isPublicMember(member) || ts.isClassStaticBlockDeclaration(member)) continue
    const memberName = ts.isConstructorDeclaration(member)
      ? "constructor"
      : member.name === undefined
        ? undefined
        : member.name.getText()
    if (memberName === undefined || members.some((entry) => entry.name === memberName)) continue
    const memberSymbol = ts.isConstructorDeclaration(member)
      ? undefined
      : checker.getSymbolAtLocation(member.name ?? member)
    const doc = memberSymbol === undefined ? jsdocOf(member) : docOf(memberSymbol, checker)
    members.push({ name: memberName, doc })
  }
  return members
}

/** Reads every public entry point of the published packages through the TypeScript checker. */
export async function collect(): Promise<ApiPackage[]> {
  const packages = await publicPackages()
  const entryFiles = new Map<string, { pkg: string; specifier: string }>()
  for (const { manifest, dir } of packages) {
    for (const [key, target] of Object.entries(manifest.exports ?? {})) {
      const source = sourceOf(target)
      if (source === undefined) continue
      const specifier = key === "." ? manifest.name : `${manifest.name}/${key.slice(2)}`
      entryFiles.set(join(dir, source), { pkg: manifest.name, specifier })
    }
  }
  const program = ts.createProgram([...entryFiles.keys()], {
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    customConditions: ["@canopy/source"],
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    jsx: ts.JsxEmit.ReactJSX,
    lib: ["lib.es2024.d.ts", "lib.dom.d.ts"],
    types: ["node"],
  })
  const checker = program.getTypeChecker()
  const byPackage = new Map<string, ApiEntry[]>()
  for (const [file, { pkg, specifier }] of entryFiles) {
    const source = program.getSourceFile(file)
    const moduleSymbol = source === undefined ? undefined : checker.getSymbolAtLocation(source)
    if (moduleSymbol === undefined) throw new Error(`Cannot read the entry point ${file}`)
    const exports: ApiExport[] = []
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const symbol =
        exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported
      const declaration = symbol.declarations?.[0] ?? exported.declarations?.[0]
      const declarationFile = declaration?.getSourceFile()
      const external =
        declarationFile === undefined ||
        declarationFile.fileName.split(/[\\/]/).includes("node_modules")
      const position =
        declaration === undefined || declarationFile === undefined
          ? { line: 0 }
          : declarationFile.getLineAndCharacterOfPosition(declaration.getStart())
      exports.push({
        name: exported.name,
        kind: kindOf(symbol),
        doc: docOf(symbol, checker),
        signature: external ? "" : signatureOf(exported.name, symbol, checker),
        members: external ? [] : membersOf(symbol, checker),
        file:
          declarationFile === undefined
            ? ""
            : relative(root, declarationFile.fileName).split(sep).join("/"),
        line: position.line + 1,
        external,
      })
    }
    exports.sort((a, b) => a.name.localeCompare(b.name))
    const entries = byPackage.get(pkg) ?? []
    entries.push({ specifier, exports })
    byPackage.set(pkg, entries)
  }
  return packages.map(({ manifest }) => ({
    name: manifest.name,
    description: manifest.description ?? "",
    entries: (byPackage.get(manifest.name) ?? []).sort((a, b) =>
      a.specifier.localeCompare(b.specifier),
    ),
  }))
}

/** The exports that carry no TSDoc summary. Re-exports of third party packages are exempt. */
export function undocumented(
  packages: readonly ApiPackage[],
): { specifier: string; item: ApiExport }[] {
  const missing: { specifier: string; item: ApiExport }[] = []
  for (const pkg of packages)
    for (const entry of pkg.entries)
      for (const item of entry.exports)
        if (!item.external && item.doc === "") missing.push({ specifier: entry.specifier, item })
  return missing
}

const escapeHtml = (value: string): string => value.replaceAll("<", "&lt;").replaceAll(">", "&gt;")

const prose = (value: string): string =>
  value
    .replace(
      /\{@link(?:code|plain)?\s+([^}|\s]+)(?:\s*\|\s*([^}]+)|\s+([^}]+))?\s*\}/g,
      (_match, target: string, piped?: string, spaced?: string) => {
        const label = piped ?? spaced
        return label === undefined ? `\`${target}\`` : label.trim()
      },
    )
    .split(/(```[\s\S]*?```|`[^`]*`)/)
    .map((part, index) => (index % 2 === 1 ? part : escapeHtml(part)))
    .join("")

const yamlString = (value: string): string => JSON.stringify(value)

/** Renders one package as a Starlight page. */
export function render(pkg: ApiPackage): string {
  const lines = [
    "---",
    `title: ${yamlString(pkg.name)}`,
    `description: ${yamlString(pkg.description)}`,
    "---",
    "",
    prose(pkg.description),
    "",
    "This page is generated from the TSDoc comments in the source.",
    "",
  ]
  for (const entry of pkg.entries) {
    lines.push(`## \`${entry.specifier}\``, "")
    if (entry.exports.length === 0) lines.push("This entry point has no exports.", "")
    for (const item of entry.exports) {
      lines.push(`### ${item.name}`, "", `<small>${item.kind}</small>`, "")
      if (item.doc !== "") lines.push(prose(item.doc), "")
      if (item.external) lines.push("Re-exported from a third party package.", "")
      if (item.signature !== "") lines.push("```ts", item.signature, "```", "")
      if (item.members.length > 0) {
        lines.push("| Member | Description |", "| --- | --- |")
        for (const member of item.members)
          lines.push(
            `| \`${member.name}\` | ${prose(member.doc).replaceAll("|", "\\|").replaceAll("\n", " ")} |`,
          )
        lines.push("")
      }
    }
  }
  return `${lines.join("\n").trimEnd()}\n`
}

const slug = (name: string): string => name.replace(/^@canopy\//, "")

async function main(argv: readonly string[]): Promise<number> {
  const packages = await collect()
  const missing = undocumented(packages)
  if (argv.includes("--check")) {
    for (const { specifier, item } of missing)
      process.stderr.write(
        `${item.file}:${item.line} ${specifier} exports ${item.name} (${item.kind}) without TSDoc\n`,
      )
    const total = packages.reduce(
      (sum, pkg) => sum + pkg.entries.reduce((count, entry) => count + entry.exports.length, 0),
      0,
    )
    process.stdout.write(
      `${total - missing.length} of ${total} public exports are documented across ${packages.length} packages\n`,
    )
    return missing.length === 0 ? 0 : 1
  }
  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })
  for (const pkg of packages) await writeFile(join(out, `${slug(pkg.name)}.md`), render(pkg))
  process.stdout.write(`Wrote ${packages.length} API reference pages to ${relative(root, out)}\n`)
  return 0
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2))
}
