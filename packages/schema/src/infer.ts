import { bsonTypeOf } from "@canopy/matcher"
import { binaryParts, isDocument } from "@canopy/protocol"
import {
  type CollectionSchema,
  type Field,
  type ObjectShape,
  type ScalarType,
  type Shape,
  union,
} from "./shape.ts"

/** Options for {@link inferSchema}. */
export interface InferOptions {
  /**
   * Turn low cardinality string fields into literal unions: at most `maxValues` distinct values across at
   * least `minSamples` occurrences. Off by default.
   */
  readonly enums?: boolean | { readonly maxValues?: number; readonly minSamples?: number }
}

const ENUM_MAX_VALUES = 20
const ENUM_MIN_SAMPLES = 200
const ORDER: readonly ScalarType[] = [
  "null",
  "bool",
  "int",
  "long",
  "double",
  "decimal",
  "string",
  "objectId",
  "uuid",
  "binData",
  "date",
  "timestamp",
  "regex",
  "javascript",
  "minKey",
  "maxKey",
]

class ValueStats {
  count = 0
  readonly scalars = new Set<ScalarType>()
  strings: Map<string, number> | undefined = new Map()
  stringCount = 0
  object: ObjectStats | undefined
  items: ValueStats | undefined
  unknown = false

  add(value: unknown, maxValues: number): void {
    this.count += 1
    const type = bsonTypeOf(value)
    switch (type) {
      case "missing":
      case "undefined":
        this.scalars.add("null")
        return
      case "object":
        if (!isDocument(value)) {
          this.unknown = true
          return
        }
        this.object ??= new ObjectStats()
        this.object.add(value, maxValues)
        return
      case "array": {
        this.items ??= new ValueStats()
        for (const item of value as unknown[]) this.items.add(item, maxValues)
        return
      }
      case "binData":
        this.scalars.add(binaryParts(value)?.subType === 4 ? "uuid" : "binData")
        return
      case "symbol":
        this.addString(String(value), maxValues)
        return
      case "string":
        this.addString(value as string, maxValues)
        return
      default:
        this.scalars.add(type)
    }
  }

  private addString(value: string, maxValues: number): void {
    this.scalars.add("string")
    this.stringCount += 1
    if (this.strings === undefined) return
    this.strings.set(value, (this.strings.get(value) ?? 0) + 1)
    if (this.strings.size > maxValues) this.strings = undefined
  }

  shape(enums: { readonly maxValues: number; readonly minSamples: number } | undefined): Shape {
    if (this.unknown) return { kind: "any" }
    const parts: Shape[] = []
    for (const type of ORDER) {
      if (!this.scalars.has(type)) continue
      if (
        type === "string" &&
        enums !== undefined &&
        this.strings !== undefined &&
        this.stringCount >= enums.minSamples
      ) {
        parts.push({ kind: "scalar", type, values: [...this.strings.keys()].sort() })
      } else parts.push({ kind: "scalar", type })
    }
    if (this.object !== undefined) parts.push(this.object.shape(enums))
    if (this.items !== undefined) parts.push({ kind: "array", items: this.items.shape(enums) })
    return union(parts)
  }
}

class ObjectStats {
  count = 0
  readonly fields = new Map<string, ValueStats>()

  add(doc: Record<string, unknown>, maxValues: number): void {
    this.count += 1
    for (const key of Object.keys(doc)) {
      const value = doc[key]
      if (value === undefined) continue
      let stats = this.fields.get(key)
      if (stats === undefined) {
        stats = new ValueStats()
        this.fields.set(key, stats)
      }
      stats.add(value, maxValues)
    }
  }

  shape(
    enums: { readonly maxValues: number; readonly minSamples: number } | undefined,
  ): ObjectShape {
    const fields: Record<string, Field> = {}
    for (const key of [...this.fields.keys()].sort()) {
      const stats = this.fields.get(key)
      if (stats === undefined) continue
      fields[key] = { shape: stats.shape(enums), required: stats.count === this.count }
    }
    return { kind: "object", fields, open: true }
  }
}

/**
 * Infers a collection schema from sampled documents: a field present in every sample is required, others
 * are optional, the types of a field are unioned, and subdocuments and array elements are inferred the
 * same way. Objects stay open, because a sample can miss fields. The result does not depend on the order
 * of the documents.
 */
export function inferSchema(
  name: string,
  docs: readonly Record<string, unknown>[],
  options: InferOptions = {},
): CollectionSchema {
  const setting = options.enums
  const enums =
    setting === undefined || setting === false
      ? undefined
      : {
          maxValues: (setting === true ? undefined : setting.maxValues) ?? ENUM_MAX_VALUES,
          minSamples: (setting === true ? undefined : setting.minSamples) ?? ENUM_MIN_SAMPLES,
        }
  const stats = new ObjectStats()
  for (const doc of docs) stats.add(doc, enums?.maxValues ?? ENUM_MAX_VALUES)
  const shape = stats.shape(enums)
  return {
    name,
    shape: docs.length === 0 ? { kind: "object", fields: {}, open: true } : shape,
    source: "inferred",
    sampled: docs.length,
  }
}
