/** Inputs of the SDK snippets. */
export interface SnippetInput {
  readonly url: string
  readonly collection: string
  /** The publishable key, or undefined to show a placeholder. */
  readonly publishableKey: string | undefined
}

const PLACEHOLDER_KEY = "canopy_pk_YOUR_PUBLISHABLE_KEY"

function ident(collection: string): string {
  const camel = collection.replace(/[^A-Za-z0-9]+(.)?/g, (_, next: string | undefined) =>
    next === undefined ? "" : next.toUpperCase(),
  )
  return /^[A-Za-z_$]/.test(camel) ? camel : `c${camel}`
}

/** Creating the client with `canopy.js`. */
export function setupSnippet(input: SnippetInput): string {
  return [
    'import { createClient } from "canopy.js"',
    "",
    "export const canopy = createClient({",
    `  url: ${JSON.stringify(input.url)},`,
    `  publishableKey: ${JSON.stringify(input.publishableKey ?? PLACEHOLDER_KEY)},`,
    "  auth: { getToken: () => getTokenFromYourIdentityProvider() },",
    "})",
    "",
  ].join("\n")
}

/** A live query on a collection. */
export function querySnippet(input: SnippetInput): string {
  const name = ident(input.collection)
  return [
    `const ${name} = canopy.from(${JSON.stringify(input.collection)}).find({}).sort({ _id: -1 }).limit(20)`,
    `const stop = ${name}.subscribe((state) => console.log(state.status, state.data))`,
    "",
  ].join("\n")
}

/** An optimistic insert. */
export function insertSnippet(input: SnippetInput): string {
  return [
    `const result = await canopy.from(${JSON.stringify(input.collection)}).insert({ title: "Hello" })`,
    "",
  ].join("\n")
}

/** Following documents live in React with `canopy.js/react`. */
export function reactSnippet(input: SnippetInput): string {
  const name = ident(input.collection)
  const component = `${name.charAt(0).toUpperCase()}${name.slice(1)}List`
  return [
    'import { CanopyProvider, createReactDb, useCanopy } from "canopy.js/react"',
    'import { useMemo } from "react"',
    "",
    `function ${component}() {`,
    "  const client = useCanopy()",
    "  const db = useMemo(() => createReactDb(client), [client])",
    `  const { data, status } = db[${JSON.stringify(input.collection)}].useQuery({}, { sort: { _id: -1 } })`,
    '  if (status === "loading") return <p>Loading</p>',
    "  return <ul>{data.map((doc) => <li key={String(doc._id)}>{JSON.stringify(doc)}</li>)}</ul>",
    "}",
    "",
    "// Wrap the app once: <CanopyProvider client={canopy}>…</CanopyProvider>",
    "",
  ].join("\n")
}

/** The type generation commands. */
export const TYPEGEN_COMMANDS = {
  generate: "canopy gen types",
  role: "canopy gen types --role authenticated",
  check: "canopy gen types --check",
} as const
