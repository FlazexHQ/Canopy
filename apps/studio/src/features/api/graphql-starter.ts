import {
  type GraphQLField,
  type GraphQLNamedType,
  type GraphQLSchema,
  getNamedType,
  isEnumType,
  isNonNullType,
  isObjectType,
  isScalarType,
} from "graphql"

/** The root field kinds of a schema. */
export type RootKind = "query" | "mutation" | "subscription"

/** A root field as the docs panel lists it. */
export interface RootField {
  readonly kind: RootKind
  readonly name: string
  /** `name(arg: Type, …): Type`. */
  readonly signature: string
  readonly description: string | undefined
}

function rootType(schema: GraphQLSchema, kind: RootKind) {
  if (kind === "query") return schema.getQueryType()
  if (kind === "mutation") return schema.getMutationType()
  return schema.getSubscriptionType()
}

/** Lists the root fields of each kind, in schema order. */
export function rootFields(schema: GraphQLSchema): RootField[] {
  const out: RootField[] = []
  for (const kind of ["query", "mutation", "subscription"] as const) {
    const type = rootType(schema, kind)
    if (type === null || type === undefined) continue
    for (const field of Object.values(type.getFields())) {
      const args = field.args.map((arg) => `${arg.name}: ${String(arg.type)}`).join(", ")
      out.push({
        kind,
        name: field.name,
        signature: `${field.name}${args === "" ? "" : `(${args})`}: ${String(field.type)}`,
        description: field.description ?? undefined,
      })
    }
  }
  return out
}

function leaves(type: GraphQLNamedType, depth: number): string[] {
  if (!isObjectType(type)) return []
  const out: string[] = []
  for (const field of Object.values(type.getFields())) {
    if (field.args.some((arg) => isNonNullType(arg.type) && arg.defaultValue === undefined))
      continue
    const named = getNamedType(field.type)
    if (isScalarType(named) || isEnumType(named)) out.push(field.name)
    else if (depth > 0 && field.name === "nodes") {
      const inner = leaves(named, depth - 1)
      if (inner.length > 0) out.push(`nodes {\n${indent(inner)}\n}`)
    }
  }
  return out
}

function indent(lines: readonly string[]): string {
  return lines
    .join("\n")
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")
}

function placeholder(field: GraphQLField<unknown, unknown>): string {
  const required = field.args.filter(
    (arg) => isNonNullType(arg.type) && arg.defaultValue === undefined,
  )
  const args = required.map((arg) => `${arg.name}: $${arg.name}`)
  if (field.args.some((arg) => arg.name === "limit")) args.push("limit: 10")
  return args.length === 0 ? "" : `(${args.join(", ")})`
}

/**
 * A starter operation for one root field: required arguments become variables, lists get `limit: 10`,
 * and the selection holds the field's scalar fields (and a connection's `nodes`).
 */
export function starterOperation(schema: GraphQLSchema, kind: RootKind, name: string): string {
  const field = rootType(schema, kind)?.getFields()[name]
  if (field === undefined) return `${kind} {\n  __typename\n}`
  const required = field.args.filter(
    (arg) => isNonNullType(arg.type) && arg.defaultValue === undefined,
  )
  const variables =
    required.length === 0
      ? ""
      : `(${required.map((arg) => `$${arg.name}: ${String(arg.type)}`).join(", ")})`
  const selection = leaves(getNamedType(field.type), 1)
  const body = selection.length === 0 ? "" : ` {\n${indent(indent(selection).split("\n"))}\n  }`
  return `${kind}${variables} {\n  ${name}${placeholder(field)}${body}\n}\n`
}

/** The first starter worth showing: the first list query, or `__typename` when there is none. */
export function initialOperation(schema: GraphQLSchema): string {
  const first = rootFields(schema).find(
    (field) => field.kind === "query" && field.name !== "_empty",
  )
  return first === undefined
    ? "query {\n  __typename\n}\n"
    : starterOperation(schema, "query", first.name)
}
