import type { CollectionSchema, ObjectShape, Shape } from "./shape.ts"

/** Options for emitting an editable schema definition with {@link emitSchemaFile}. */
export interface EmitOptions {
  /** Writes JavaScript without a module augmentation. */
  readonly js?: boolean
  /** Module the builders are imported from. Defaults to `@canopy/schema/define`. */
  readonly importFrom?: string
  /** Module whose Register interface the file augments. Defaults to `@canopy/client`. */
  readonly registerModule?: string
}

const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const reserved = (
  "arguments await break case catch class const continue debugger default delete do else enum eval " +
  "export extends false finally for function if implements import in instanceof interface let new " +
  "null package private protected public return static super switch this throw true try typeof " +
  "var void while with yield schema collection defineSchema t"
).split(" ")
const review = "inferred from sampled documents, review"

function binding(name: string, used: Set<string>): string {
  const camel = name
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((word, i) => (i === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join("")
  let result = camel
  if (!identifier.test(camel) || used.has(camel)) {
    const prefix = camel && !identifier.test(camel) ? "_" : ""
    const base = `${prefix}${camel}Collection`
    result = base
    for (let i = 2; used.has(result); i++) result = `${base}${i}`
  }
  used.add(result)
  return result
}

function fields(shape: ObjectShape, indent: string, inferred: boolean, root: boolean): string {
  const inner = `${indent}  `
  const lines: string[] = []
  for (const [key, field] of Object.entries(shape.fields).sort(([a], [b]) =>
    a === b ? 0 : a === "_id" || (b !== "_id" && a < b) ? -1 : 1,
  )) {
    const id = root && key === "_id"
    if (id && field.required && field.shape.kind === "scalar" && field.shape.type === "objectId")
      continue
    const notes = new Set<string>()
    let value = expression(field.shape, inner, inferred, notes)
    if (!id && !field.required) {
      value += ".optional()"
      if (inferred) notes.add(review)
    }
    const property =
      key === "__proto__" ? '["__proto__"]' : identifier.test(key) ? key : JSON.stringify(key)
    const comments = [...notes].map((note) => ` // TODO(canopy pull): ${note}`).join("")
    lines.push(`${inner}${property}: ${value},${comments}`)
  }
  return lines.length ? `{\n${lines.join("\n")}\n${indent}}` : "{}"
}

function expression(shape: Shape, indent: string, inferred: boolean, notes: Set<string>): string {
  switch (shape.kind) {
    case "any":
      return "t.any()"
    case "object":
      return `t.object(${fields(shape, indent, inferred, false)})`
    case "array":
      return `t.array(${expression(shape.items, indent, inferred, notes)})`
    case "union": {
      const nonNull = shape.of.filter((s) => !(s.kind === "scalar" && s.type === "null"))
      if (!nonNull.length) {
        if (shape.of.length) notes.add("null has no builder")
        return "t.any()"
      }
      const memberNotes = new Set<string>()
      const members = nonNull.map((s) => expression(s, indent, inferred, memberNotes))
      const collapsed = members.includes("t.any()")
      for (const note of memberNotes) if (!collapsed || note !== review) notes.add(note)
      if (collapsed) return "t.any()"
      const value = members.length === 1 ? members.join("") : `t.union(${members.join(", ")})`
      return nonNull.length === shape.of.length ? value : `${value}.nullable()`
    }
    case "scalar":
      switch (shape.type) {
        case "null":
        case "timestamp":
        case "regex":
        case "minKey":
        case "maxKey":
        case "javascript":
          notes.add(`${shape.type} has no builder`)
          return "t.any()"
        case "binData":
          return "t.binary()"
        case "string":
          if (shape.values?.length) {
            if (inferred) notes.add(review)
            return `t.enum([${[...shape.values]
              .sort()
              .map((v) => JSON.stringify(v))
              .join(", ")}])`
          }
          return "t.string()"
        default:
          return `t.${shape.type}()`
      }
  }
}

/** Emits an editable collection definition file from database schemas in collection name order. */
export function emitSchemaFile(
  schemas: readonly CollectionSchema[],
  options: EmitOptions = {},
): string {
  const used = new Set(reserved)
  const names: string[] = []
  const blocks: string[] = []
  let usesFields = false
  for (const schema of [...schemas].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const name = binding(schema.name, used)
    const body = fields(schema.shape, "", schema.source === "inferred", true)
    names.push(name)
    if (body !== "{}") usesFields = true
    blocks.push(`export const ${name} = collection(${JSON.stringify(schema.name)}, ${body})`)
  }
  const imports = [
    ...(names.length ? ["collection"] : []),
    "defineSchema",
    ...(usesFields ? ["t"] : []),
  ]
  blocks.unshift(
    "// Written by canopy pull. This file is yours now: edit it, review it and commit it.\n" +
      `import { ${imports.join(", ")} } from ${JSON.stringify(options.importFrom ?? "@canopy/schema/define")}`,
  )
  blocks.push(`export const schema = defineSchema(${names.join(", ")})`)
  if (!options.js)
    blocks.push(
      `declare module ${JSON.stringify(options.registerModule ?? "@canopy/client")} {\n  interface Register {\n    schema: typeof schema\n  }\n}`,
    )
  return `${blocks.join("\n\n")}\n`
}
