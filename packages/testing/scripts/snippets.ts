/**
 * Type checks the TypeScript snippets of the documentation: every ```ts and ```tsx block of the README files
 * and of the docs site (except the generated API reference), each as its own module, against the sources of
 * the workspace packages and the installed third party packages. Snippets may use the names of
 * {@link CONTEXT} without declaring them (a `canopy` client typed by the example `./canopy.schema.ts`, an `id`,
 * `render` and the like), import the collections of `./canopy.schema.ts` or the `Database` that
 * `canopy gen types` writes to `./canopy.gen.ts`, and `// @ts-expect-error` marks a line that is meant not to
 * compile. HTML
 * comments right above a block, which the rendered page does not show, adjust it:
 * `<!-- snippet: not checked -->` skips a deliberately incomplete block (code of another platform, a fragment
 * of a larger object), and any other `<!-- snippet: ... -->` is code put before the block, such as
 * `<!-- snippet: declare const showToast: (text: string) => void -->`. Run from the repository root:
 *
 *   bun packages/testing/scripts/snippets.ts
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import ts from "typescript"

const root = resolve(process.argv[2] ?? ".")
const SKIP = "not checked"
const REGISTERED = "registered"
const DIRECTIVE = /^\s*<!--\s*snippet:\s*(.*?)\s*-->\s*$/

/** The generated types file snippets import, as `canopy gen types` would write it for the examples. */
const GENERATED = `import type { DocumentSchema } from "@canopy/client"

export interface Todo {
  readonly _id: string
  title: string
  done: boolean
  ownerId?: string
  createdAt?: Date
  archived?: boolean
}

export interface Post {
  readonly _id: string
  title: string
  body: string
  authorId: string
  published: boolean
  createdAt: Date
}

export interface Order {
  readonly _id: string
  status: "open" | "paid" | "shipped"
  total: number
  ownerId: string
  createdAt: Date
}

export type Database = DocumentSchema<{ todos: Todo; posts: Post; orders: Order }>
`

/**
 * The schema file snippets import, as `canopy pull` would write it, without its `Register` block: snippets
 * share one program, so registering a schema would type every other snippet's client too. The global
 * `canopy` and the `Todo` and `Order` types of {@link CONTEXT} come from it.
 */
const SCHEMA = `import { collection, defineSchema, t } from "@canopy/schema/define"

export const todos = collection("todos", {
  _id: t.string().generate(() => crypto.randomUUID()),
  title: t.string(),
  done: t.bool().default(false),
  tags: t.array(t.string()).optional(),
  due: t.date().nullable().optional(),
  ownerId: t.string().optional(),
  createdAt: t.date().optional(),
  archived: t.bool().optional(),
})

export const notes = collection("notes", {
  _id: t.string(),
  title: t.string(),
  body: t.object({ text: t.string(), format: t.enum(["md", "plain"]) }),
})

export const posts = collection("posts", {
  _id: t.string(),
  title: t.string(),
  body: t.string(),
  authorId: t.string(),
  published: t.bool(),
  createdAt: t.date(),
})

export const orders = collection("orders", {
  _id: t.string(),
  status: t.enum(["open", "paid", "shipped"]),
  total: t.double(),
  ownerId: t.string(),
  createdAt: t.date(),
})

export const schema = defineSchema(todos, notes, posts, orders)
`

/** The names snippets may use without declaring them. */
const CONTEXT = `import type { CanopyClient, Doc, SchemaTypes } from "@canopy/client"
import type { CanopyAuth } from "@canopy/client/auth"
import type { schema } from "./canopy.schema.ts"

declare global {
  type Database = SchemaTypes<typeof schema>
  type Order = Doc<"orders", typeof schema>
  type Todo = Doc<"todos", typeof schema>
  const canopy: CanopyClient<Database>
  const auth: CanopyAuth
  const id: string
  const url: string
  const publishableKey: string
  const email: string
  const password: string
  const code: string
  function render(...values: unknown[]): void
  function getToken(): Promise<string>
}

export {}
`

/** The schema file of the program for `<!-- snippet: registered -->` blocks: the same file, registered. */
const REGISTERED_SCHEMA = `${SCHEMA}
declare module "@canopy/client" {
  interface Register {
    schema: typeof schema
  }
}
`

/** The names registered snippets may use: the same, with `canopy` typed by the registered schema. */
const REGISTERED_CONTEXT = CONTEXT.replace(
  "const canopy: CanopyClient<Database>",
  "const canopy: CanopyClient",
)

/** Modules snippets import that the repository does not install, and globals of the build tools. */
const AMBIENT = `interface ImportMeta {
  readonly env: { readonly DEV: boolean; readonly PROD: boolean; readonly [name: string]: unknown }
}

declare module "*.vue" {
  const component: import("vue").Component
  export default component
}

declare module "react-native" {
  export const AppState: {
    readonly currentState: string | null
    addEventListener(type: "change", listener: (state: string) => void): { remove(): void }
  }
}

declare module "@react-native-community/netinfo" {
  const NetInfo: {
    addEventListener(
      listener: (state: { isConnected: boolean | null; isInternetReachable: boolean | null }) => void,
    ): () => void
  }
  export default NetInfo
}

declare module "react-native-mmkv" {
  export class MMKV {
    constructor(options?: { id?: string })
    getString(key: string): string | undefined
    set(key: string, value: string): void
    delete(key: string): void
    getAllKeys(): string[]
  }
}

declare module "next/headers" {
  export function cookies(): Promise<{ getAll(): { name: string; value: string }[] }>
}
`

interface Snippet {
  readonly file: string
  readonly line: number
  readonly lang: "ts" | "tsx"
  readonly code: string
  /** Lines of code put before the block. */
  readonly setup: readonly string[]
  /** Whether the block is checked in the program that registers the example schema. */
  readonly registered: boolean
}

function markdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory())
      return path.endsWith(join("reference", "api")) ? [] : markdownFiles(path)
    return /\.mdx?$/.test(name) ? [path] : []
  })
}

function sources(): string[] {
  const readmes = [join(root, "README.md")]
  for (const group of ["packages", "examples"]) {
    const dir = join(root, group)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) readmes.push(join(dir, name, "README.md"))
  }
  return [
    ...readmes.filter((path) => existsSync(path)),
    ...markdownFiles(join(root, "apps", "docs", "src", "content", "docs")),
  ]
}

function snippetsOf(file: string): Snippet[] {
  const lines = readFileSync(file, "utf8").split(/\r?\n/)
  const found: Snippet[] = []
  for (let index = 0; index < lines.length; index++) {
    const open = /^(\s*)```(ts|tsx|typescript)\b/.exec(lines[index] ?? "")
    if (open === null) continue
    const indent = open[1]?.length ?? 0
    const body: string[] = []
    let end = index + 1
    while (end < lines.length && !/^\s*```\s*$/.test(lines[end] ?? "")) {
      body.push((lines[end] ?? "").slice(indent))
      end++
    }
    const setup: string[] = []
    let above = index - 1
    while (above >= 0 && (lines[above] ?? "").trim() === "") above--
    for (let match = DIRECTIVE.exec(lines[above] ?? ""); match !== null; ) {
      setup.unshift(match[1] ?? "")
      above--
      match = DIRECTIVE.exec(lines[above] ?? "")
    }
    if (!setup.includes(SKIP))
      found.push({
        file,
        line: index + 1,
        lang: open[2] === "tsx" ? "tsx" : "ts",
        code: body.join("\n"),
        setup: setup.filter((line) => line !== REGISTERED),
        registered: setup.includes(REGISTERED),
      })
    index = end
  }
  return found
}

/** Where a bare specifier's package lives: the workspace sources, `@types`, or the installed package. */
function packageDirs(): Map<string, string> {
  const dirs = new Map<string, string>()
  const store = join(root, "node_modules", ".bun")
  if (existsSync(store)) {
    for (const entry of readdirSync(store).sort()) {
      const at = entry.lastIndexOf("@")
      if (at <= 0) continue
      const name = entry.slice(0, at).replace("+", "/")
      const dir = join(store, entry, "node_modules", name)
      if (existsSync(join(dir, "package.json"))) dirs.set(name, dir)
    }
  }
  return dirs
}

function workspacePaths(): Record<string, string[]> {
  const paths: Record<string, string[]> = {}
  for (const name of readdirSync(join(root, "packages"))) {
    const manifestPath = join(root, "packages", name, "package.json")
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name?: string
      exports?: Record<string, unknown>
    }
    if (manifest.name === undefined || manifest.exports === undefined) continue
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      if (typeof target !== "object" || target === null) continue
      const source = (target as Record<string, unknown>)["@canopy/source"]
      if (typeof source !== "string") continue
      const specifier = subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`
      paths[specifier] = [join(root, "packages", name, source)]
    }
  }
  return paths
}

/** Maps the third party packages snippets import to their installed types or sources. */
function installedPaths(
  snippets: readonly Snippet[],
  installed: ReadonlyMap<string, string>,
): Record<string, string[]> {
  const paths = workspacePaths()
  for (const snippet of snippets) {
    for (const match of snippet.code.matchAll(
      /from\s+["']([^"'.][^"']*)["']|import\(\s*["']([^"'.][^"']*)["']\s*\)/g,
    )) {
      const specifier = match[1] ?? match[2] ?? ""
      if (specifier.startsWith("node:") || paths[specifier] !== undefined) continue
      const parts = specifier.split("/")
      const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "")
      const typesName = name.startsWith("@")
        ? `@types/${name.slice(1).replace("/", "__")}`
        : `@types/${name}`
      const dir = installed.get(typesName) ?? installed.get(name)
      if (dir === undefined) continue
      paths[name] = [dir]
      paths[`${name}/*`] = [`${dir}/*`]
    }
  }
  return paths
}

/** The diagnostics of one program of snippets, as `file:line  message` lines. */
function check(
  snippets: readonly Snippet[],
  out: string,
  schema: string,
  context: string,
  paths: Record<string, string[]>,
  installed: ReadonlyMap<string, string>,
): string[] {
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const files: string[] = []
  writeFileSync(join(out, "canopy.gen.ts"), GENERATED)
  writeFileSync(join(out, "canopy.schema.ts"), schema)
  writeFileSync(
    join(out, "todo-list.tsx"),
    "export function TodoList(): null {\n  return null\n}\n",
  )
  const contextFile = join(out, "context.ts")
  writeFileSync(contextFile, context)
  const ambient = join(out, "ambient.d.ts")
  writeFileSync(ambient, AMBIENT)
  for (const [index, snippet] of snippets.entries()) {
    const path = join(out, `snippet-${index}.${snippet.lang}`)
    writeFileSync(path, [...snippet.setup, snippet.code, "export {}", ""].join("\n"))
    files.push(path)
  }
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    customConditions: ["@canopy/source"],
    types: [],
    typeRoots: [],
    paths,
  }
  const nodeTypes = installed.get("@types/node")
  if (nodeTypes !== undefined) {
    options.typeRoots = [dirname(nodeTypes)]
    options.types = ["node"]
  }
  const program = ts.createProgram([...files, contextFile, ambient], options)
  const checked = new Set([
    ...files,
    contextFile,
    ambient,
    join(out, "canopy.gen.ts"),
    join(out, "canopy.schema.ts"),
  ])
  const lines: string[] = []
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    const fileName = diagnostic.file === undefined ? "" : resolve(diagnostic.file.fileName)
    if (diagnostic.file !== undefined && !checked.has(fileName)) continue
    const snippet = snippets[files.indexOf(fileName)]
    const where =
      snippet === undefined
        ? relative(root, fileName) || "(program)"
        : `${relative(root, snippet.file)}:${
            snippet.line +
            Math.max(
              0,
              1 +
                (diagnostic.file !== undefined && diagnostic.start !== undefined
                  ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line
                  : 0) -
                snippet.setup.length,
            )
          }`
    lines.push(`${where}  ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`)
  }
  return lines
}

function main(): void {
  const snippets = sources().flatMap(snippetsOf)
  const cache = join(root, "node_modules", ".cache")
  const installed = packageDirs()
  const paths = installedPaths(snippets, installed)
  const errors = [
    ...check(
      snippets.filter((snippet) => !snippet.registered),
      join(cache, "canopy-snippets"),
      SCHEMA,
      CONTEXT,
      paths,
      installed,
    ),
    ...check(
      snippets.filter((snippet) => snippet.registered),
      join(cache, "canopy-snippets-registered"),
      REGISTERED_SCHEMA,
      REGISTERED_CONTEXT,
      paths,
      installed,
    ),
  ]
  for (const line of errors) process.stderr.write(`${line}\n`)
  if (errors.length > 0) {
    process.stderr.write(`\n${errors.length} errors in ${snippets.length} snippets.\n`)
    process.exit(1)
  }
  process.stdout.write(`${snippets.length} snippets type check.\n`)
}

main()
