import type { FieldAccess } from "@canopy/policy"
import { type Field, type ObjectShape, type Shape, union } from "./shape.ts"

/** What happens to fields a role cannot access: dropped, or kept as optional. */
export type RestrictMode = "remove" | "optional"

function within(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}.`)
}

type Decision = "keep" | "drop" | "descend"

function decide(access: FieldAccess, path: string): Decision {
  if (path === "_id" || access.kind === "all") return "keep"
  if (access.kind === "only") {
    if (access.paths.some((allowed) => within(path, allowed))) return "keep"
    return access.paths.some((allowed) => within(allowed, path)) ? "descend" : "drop"
  }
  if (access.paths.some((hidden) => within(path, hidden))) return "drop"
  return access.paths.some((hidden) => within(hidden, path)) ? "descend" : "keep"
}

/**
 * Applies field rules to a shape, the way documents are projected for a role: under `only` a field stays
 * when it lies within an allowed path, and under `omit` it stays unless it lies within a hidden path.
 * Subdocuments that are partly accessible are restricted field by field, through arrays as well. With
 * `optional`, inaccessible fields are kept but no longer required, for types that describe the schema
 * rather than the permissions.
 */
export function restrictShape(
  shape: ObjectShape,
  access: FieldAccess,
  mode: RestrictMode = "remove",
): ObjectShape {
  return restrictObject(shape, access, mode, "")
}

function restrictObject(
  shape: ObjectShape,
  access: FieldAccess,
  mode: RestrictMode,
  prefix: string,
): ObjectShape {
  const fields: Record<string, Field> = {}
  for (const [key, field] of Object.entries(shape.fields)) {
    const path = prefix === "" ? key : `${prefix}.${key}`
    const decision = decide(access, path)
    if (decision === "keep") fields[key] = field
    else if (decision === "descend")
      fields[key] = {
        shape: restrictNested(field.shape, access, mode, path),
        required: field.required,
      }
    else if (mode === "optional") fields[key] = { shape: field.shape, required: false }
  }
  return { kind: "object", fields, open: shape.open && access.kind !== "only" }
}

function restrictNested(
  shape: Shape,
  access: FieldAccess,
  mode: RestrictMode,
  path: string,
): Shape {
  switch (shape.kind) {
    case "object":
      return restrictObject(shape, access, mode, path)
    case "array":
      return { kind: "array", items: restrictNested(shape.items, access, mode, path) }
    case "union":
      return union(shape.of.map((member) => restrictNested(member, access, mode, path)))
    default:
      return shape
  }
}
