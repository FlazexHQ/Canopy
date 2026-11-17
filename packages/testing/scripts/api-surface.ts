import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

/**
 * Writes the public API of every published package to `api/<package>.api.md`: each entry point's exports
 * as declarations without comments, class members included. The files are committed, so a pull request
 * shows every change to a public surface as a diff, and `--check` (run by `bun run lint:api` and CI) fails
 * when a file is out of date.
 *
 *   bun packages/testing/scripts/api-surface.ts          rewrite the files
 *   bun packages/testing/scripts/api-surface.ts --check  fail when one differs
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const out = join(root, "api")

interface Manifest {
  readonly name: string
  readonly private?: boolean
  readonly exports?: Record<string, unknown>
}

function sourceOf(target: unknown): string | undefined {
  if (typeof target !== "object" || target === null) return undefined
  const source = Reflect.get(target, "@canopy/source")
  return typeof source === "string" && /\.tsx?$/.test(source) ? source : undefined
}

async function entryPoints(): Promise<Map<string, { pkg: string; specifier: string }>> {
  const entries = new Map<string, { pkg: string; specifier: string }>()
  const base = join(root, "packages")
  for (const name of (await readdir(base)).sort()) {
    let text: string
    try {
      text = await readFile(join(base, name, "package.json"), "utf8")
    } catch {
      continue
    }
    const manifest = JSON.parse(text) as Manifest
    if (manifest.private === true) continue
    for (const [key, target] of Object.entries(manifest.exports ?? {})) {
      const source = sourceOf(target)
      if (source === undefined) continue
      const specifier = key === "." ? manifest.name : `${manifest.name}/${key.slice(2)}`
      entries.set(join(base, name, source), { pkg: manifest.name, specifier })
    }
  }
  return entries
}

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed })
const FLAGS = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseFullyQualifiedType

function isPublic(member: ts.ClassElement): boolean {
  const modifiers = ts.canHaveModifiers(member) ? (ts.getModifiers(member) ?? []) : []
  if (
    modifiers.some(
      (modifier) =>
        modifier.kind === ts.SyntaxKind.PrivateKeyword ||
        modifier.kind === ts.SyntaxKind.ProtectedKeyword,
    )
  )
    return false
  const name = member.name
  return name === undefined || !ts.isPrivateIdentifier(name)
}

function modifiersOf(member: ts.ClassElement): string {
  const modifiers = ts.canHaveModifiers(member) ? (ts.getModifiers(member) ?? []) : []
  return modifiers
    .filter(
      (modifier) =>
        modifier.kind === ts.SyntaxKind.StaticKeyword ||
        modifier.kind === ts.SyntaxKind.ReadonlyKeyword ||
        modifier.kind === ts.SyntaxKind.AbstractKeyword,
    )
    .map((modifier) => `${modifier.getText()} `)
    .join("")
}

function classSurface(
  name: string,
  declaration: ts.ClassDeclaration,
  checker: ts.TypeChecker,
): string {
  const generics = declaration.typeParameters
    ? `<${declaration.typeParameters.map((parameter) => parameter.getText()).join(", ")}>`
    : ""
  const heritage = (declaration.heritageClauses ?? []).map((clause) => clause.getText()).join(" ")
  const lines = [`class ${name}${generics}${heritage === "" ? "" : ` ${heritage}`} {`]
  for (const member of declaration.members) {
    if (!isPublic(member) || ts.isClassStaticBlockDeclaration(member)) continue
    const prefix = modifiersOf(member)
    if (ts.isConstructorDeclaration(member)) {
      const signature = checker.getSignatureFromDeclaration(member)
      if (signature !== undefined)
        lines.push(`  constructor${checker.signatureToString(signature, member, FLAGS)}`)
      continue
    }
    const symbol = member.name === undefined ? undefined : checker.getSymbolAtLocation(member.name)
    if (symbol === undefined || member.name === undefined) continue
    const memberName = member.name.getText()
    if (ts.isMethodDeclaration(member)) {
      const signature = checker.getSignatureFromDeclaration(member)
      if (signature !== undefined)
        lines.push(`  ${prefix}${memberName}${checker.signatureToString(signature, member, FLAGS)}`)
      continue
    }
    const type = checker.getTypeOfSymbolAtLocation(symbol, member)
    const shown = checker.typeToString(type, member, FLAGS)
    if (ts.isGetAccessorDeclaration(member)) lines.push(`  ${prefix}get ${memberName}(): ${shown}`)
    else if (ts.isSetAccessorDeclaration(member))
      lines.push(`  ${prefix}set ${memberName}(value: ${shown})`)
    else lines.push(`  ${prefix}${memberName}: ${shown}`)
  }
  lines.push("}")
  return lines.join("\n")
}

function surfaceOf(name: string, symbol: ts.Symbol, checker: ts.TypeChecker): string {
  const declarations = symbol.declarations ?? []
  const parts: string[] = []
  for (const declaration of declarations) {
    if (ts.isClassDeclaration(declaration)) parts.push(classSurface(name, declaration, checker))
    else if (
      ts.isInterfaceDeclaration(declaration) ||
      ts.isTypeAliasDeclaration(declaration) ||
      ts.isEnumDeclaration(declaration)
    )
      parts.push(
        printer.printNode(ts.EmitHint.Unspecified, declaration, declaration.getSourceFile()),
      )
    else if (ts.isFunctionDeclaration(declaration)) {
      const signature = checker.getSignatureFromDeclaration(declaration)
      if (signature !== undefined)
        parts.push(`function ${name}${checker.signatureToString(signature, declaration, FLAGS)}`)
    } else if (ts.isVariableDeclaration(declaration)) {
      const type = checker.getTypeOfSymbolAtLocation(symbol, declaration)
      parts.push(`const ${name}: ${checker.typeToString(type, declaration, FLAGS)}`)
    } else if (ts.isModuleDeclaration(declaration)) parts.push(`namespace ${name}`)
  }
  return parts.length === 0 ? `export ${name}` : parts.join("\n")
}

/** The rendered API files, by file name. */
async function render(): Promise<Map<string, string>> {
  const entries = await entryPoints()
  const program = ts.createProgram([...entries.keys()], {
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    customConditions: ["@canopy/source"],
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    exactOptionalPropertyTypes: true,
    jsx: ts.JsxEmit.ReactJSX,
    lib: ["lib.es2024.d.ts", "lib.dom.d.ts"],
    types: ["node"],
  })
  const checker = program.getTypeChecker()
  const byPackage = new Map<string, { specifier: string; body: string }[]>()
  for (const [file, { pkg, specifier }] of entries) {
    const source = program.getSourceFile(file)
    const moduleSymbol = source === undefined ? undefined : checker.getSymbolAtLocation(source)
    if (moduleSymbol === undefined) throw new Error(`Cannot read the entry point ${file}`)
    const exports = checker
      .getExportsOfModule(moduleSymbol)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((exported) => {
        const symbol =
          exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported
        const external = (symbol.declarations ?? []).some((declaration) =>
          declaration.getSourceFile().fileName.split(/[\\/]/).includes("node_modules"),
        )
        return external
          ? `export { ${exported.name} } from a dependency`
          : surfaceOf(exported.name, symbol, checker)
      })
    const list = byPackage.get(pkg) ?? []
    list.push({ specifier, body: exports.join("\n\n") })
    byPackage.set(pkg, list)
  }
  const files = new Map<string, string>()
  for (const [pkg, list] of byPackage) {
    const lines = [
      `# ${pkg}`,
      "",
      "Generated by `bun run api`. Review changes to this file: they are changes to the public API.",
      "",
    ]
    for (const { specifier, body } of list.sort((a, b) => a.specifier.localeCompare(b.specifier)))
      lines.push(`## ${specifier}`, "", "```ts", body, "```", "")
    files.set(`${pkg.replace(/^@canopy\//, "")}.api.md`, `${lines.join("\n").trimEnd()}\n`)
  }
  return files
}

async function main(argv: readonly string[]): Promise<number> {
  const files = await render()
  if (argv.includes("--check")) {
    const stale: string[] = []
    const present = new Set(await readdir(out).catch(() => []))
    for (const [name, text] of files) {
      const current = await readFile(join(out, name), "utf8").catch(() => undefined)
      if (current?.replaceAll("\r\n", "\n") !== text) stale.push(name)
      present.delete(name)
    }
    for (const name of present) stale.push(`${name} (no such package)`)
    for (const name of stale) process.stderr.write(`api/${name} is out of date\n`)
    if (stale.length > 0) {
      process.stderr.write("The public API changed. Run bun run api and commit the result.\n")
      return 1
    }
    process.stdout.write(`${files.size} API files are up to date\n`)
    return 0
  }
  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })
  for (const [name, text] of files) await writeFile(join(out, name), text)
  process.stdout.write(`Wrote ${files.size} API files to api/\n`)
  return 0
}

process.exitCode = await main(process.argv.slice(2))
