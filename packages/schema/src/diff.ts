import { ANY, type CollectionSchema, members, type ObjectShape, type Shape } from "./shape.ts"

/** One way a collection's declared schema and its schema in the database differ. */
export interface SchemaDifference {
  readonly collection: string
  /** The dotted path of the field, or `undefined` for the whole collection. */
  readonly path?: string
  readonly kind:
    | "collection-missing"
    | "collection-undeclared"
    | "field-missing"
    | "field-undeclared"
    | "type"
    | "required"
  /** A sentence for the terminal. */
  readonly message: string
}

function describe(shape: Shape): string {
  switch (shape.kind) {
    case "any":
      return "any"
    case "scalar":
      return shape.values === undefined
        ? shape.type
        : shape.values.map((value) => JSON.stringify(value)).join(" | ")
    case "array":
      return `array of ${describe(shape.items)}`
    case "object":
      return "object"
    case "union":
      return shape.of.map(describe).join(" | ")
  }
}

/** A validator cannot tell a UUID from other binary data, so the two compare equal. */
function scalarType(type: string): string {
  return type === "uuid" ? "binData" : type
}

function key(shape: Shape): string {
  switch (shape.kind) {
    case "any":
      return "any"
    case "scalar":
      return shape.values === undefined
        ? scalarType(shape.type)
        : `${shape.type}:${[...shape.values].sort().join(",")}`
    case "array":
      return `[${key(shape.items)}]`
    case "object":
      return "object"
    case "union":
      return [...new Set(shape.of.map(key))].sort().join("|")
  }
}

/**
 * Whether every value of `inner` is also a value of `outer`. With `sampled`, `inner` comes from sampled
 * documents, which record a string field's values only when enums are inferred, so an enum covers a string.
 */
function covers(outer: Shape, inner: Shape, sampled: boolean): boolean {
  if (outer.kind === "any") return true
  return members(inner).every((part) =>
    members(outer).some((candidate) => {
      if (candidate.kind === "any") return true
      if (part.kind === "any") return false
      if (candidate.kind !== part.kind) return false
      if (candidate.kind === "scalar" && part.kind === "scalar") {
        if (scalarType(candidate.type) !== scalarType(part.type)) return false
        if (candidate.values === undefined) return true
        if (sampled && part.values === undefined) return true
        return part.values?.every((value) => candidate.values?.includes(value))
      }
      if (candidate.kind === "array" && part.kind === "array")
        return covers(candidate.items, part.items, sampled)
      return candidate.kind === "object" && part.kind === "object"
    }),
  )
}

function objectsOf(shape: Shape): ObjectShape[] {
  return members(shape).flatMap((part) => {
    if (part.kind === "object") return [part]
    if (part.kind === "array") return objectsOf(part.items)
    return []
  })
}

function compareObjects(
  collection: string,
  declared: ObjectShape,
  actual: ObjectShape,
  prefix: string,
  sampled: boolean,
  out: SchemaDifference[],
): void {
  const names = [
    ...new Set([...Object.keys(declared.fields), ...Object.keys(actual.fields)]),
  ].sort()
  for (const name of names) {
    const path = `${prefix}${name}`
    const mine = declared.fields[name]
    const theirs = actual.fields[name]
    if (mine === undefined) {
      if (theirs !== undefined)
        out.push({
          collection,
          path,
          kind: "field-undeclared",
          message: `${collection}.${path} is in the database (${describe(theirs.shape)}) but not in the schema file`,
        })
      continue
    }
    if (theirs === undefined) {
      if (!actual.open)
        out.push({
          collection,
          path,
          kind: "field-missing",
          message: `${collection}.${path} is in the schema file but the database does not allow it`,
        })
      else if (mine.required)
        out.push({
          collection,
          path,
          kind: "field-missing",
          message: `${collection}.${path} is required in the schema file but the database does not have it`,
        })
      continue
    }
    if (key(mine.shape) !== key(theirs.shape) && !covers(mine.shape, theirs.shape, sampled))
      out.push({
        collection,
        path,
        kind: "type",
        message: `${collection}.${path} is ${describe(mine.shape)} in the schema file but ${describe(theirs.shape)} in the database`,
      })
    if (mine.required !== theirs.required)
      out.push({
        collection,
        path,
        kind: "required",
        message: `${collection}.${path} is ${mine.required ? "required" : "optional"} in the schema file but ${theirs.required ? "required" : "optional"} in the database`,
      })
    const nestedMine = objectsOf(mine.shape)
    const nestedTheirs = objectsOf(theirs.shape)
    if (nestedMine.length === 1 && nestedTheirs.length === 1) {
      const [a] = nestedMine
      const [b] = nestedTheirs
      if (a !== undefined && b !== undefined)
        compareObjects(collection, a, b, `${path}.`, sampled, out)
    }
  }
}

/**
 * Compares the collections declared in code with the schemas read from the database (validators, config or
 * sampled documents). A declared type that admits every value the database holds is not a difference, so a
 * schema may be wider than a sample; a field the database has and the schema file does not declare is.
 * Differences are ordered by collection and path.
 */
export function diffSchemas(
  declared: readonly CollectionSchema[],
  actual: readonly CollectionSchema[],
): SchemaDifference[] {
  const out: SchemaDifference[] = []
  const byName = new Map(actual.map((schema) => [schema.name, schema]))
  const declaredNames = new Set(declared.map((schema) => schema.name))
  for (const schema of [...declared].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const found = byName.get(schema.name)
    if (found === undefined) {
      out.push({
        collection: schema.name,
        kind: "collection-missing",
        message: `${schema.name} is in the schema file but not in the database`,
      })
      continue
    }
    compareObjects(schema.name, schema.shape, found.shape, "", found.source === "inferred", out)
  }
  for (const schema of [...actual].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)))
    if (!declaredNames.has(schema.name))
      out.push({
        collection: schema.name,
        kind: "collection-undeclared",
        message: `${schema.name} is in the database but not in the schema file`,
      })
  return out
}

const BSON_TYPES: Readonly<Record<string, string>> = {
  string: "string",
  int: "int",
  double: "double",
  long: "long",
  decimal: "decimal",
  bool: "bool",
  date: "date",
  objectId: "objectId",
  binData: "binData",
  uuid: "binData",
  null: "null",
  timestamp: "timestamp",
  regex: "regex",
  minKey: "minKey",
  maxKey: "maxKey",
  javascript: "javascript",
}

/**
 * Writes a shape as a MongoDB `$jsonSchema` (with `bsonType`), for `collMod`. Enums keep their values, a
 * nullable value lists `null` as a type, and an object keeps its required fields; `any` places no
 * constraint. Objects allow fields beyond the declared ones, as collection definitions do.
 */
export function toValidator(shape: Shape): Record<string, unknown> {
  switch (shape.kind) {
    case "any":
      return {}
    case "scalar":
      if (shape.type === "string" && shape.values !== undefined)
        return { bsonType: "string", enum: [...shape.values] }
      return { bsonType: BSON_TYPES[shape.type] ?? shape.type }
    case "array":
      return { bsonType: "array", items: toValidator(shape.items) }
    case "union": {
      if (shape.of.some((part) => part.kind === "any")) return {}
      const simple = shape.of.every(
        (part) => part.kind === "scalar" && (part.values === undefined || part.type !== "string"),
      )
      if (simple)
        return {
          bsonType: [
            ...new Set(
              shape.of.map((part) =>
                part.kind === "scalar" ? (BSON_TYPES[part.type] ?? part.type) : "",
              ),
            ),
          ],
        }
      return { anyOf: shape.of.map(toValidator) }
    }
    case "object": {
      const names = Object.keys(shape.fields).sort()
      const required = names.filter((name) => shape.fields[name]?.required === true)
      return {
        bsonType: "object",
        ...(required.length === 0 ? {} : { required }),
        properties: Object.fromEntries(
          names.map((name) => [name, toValidator(shape.fields[name]?.shape ?? ANY)]),
        ),
        ...(shape.open ? {} : { additionalProperties: false }),
      }
    }
  }
}
