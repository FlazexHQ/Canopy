import {
  Binary,
  binaryParts,
  Decimal128,
  decimalString,
  decode,
  encode,
  Long,
  longValue,
  ObjectId,
  objectIdHex,
} from "@canopy/protocol"
import { GraphQLError, GraphQLScalarType, Kind, type ValueNode } from "graphql"

function invalid(type: string, value: unknown): GraphQLError {
  return new GraphQLError(`${type} cannot represent ${JSON.stringify(encode(value)) ?? "it"}`, {
    extensions: { code: "CANOPY_INVALID_QUERY" },
  })
}

function literalString(type: string, ast: ValueNode): string {
  if (ast.kind !== Kind.STRING) throw new GraphQLError(`${type} must be a string`)
  return ast.value
}

const HEX = /^[0-9a-fA-F]{24}$/

function parseObjectId(value: unknown): ObjectId {
  if (typeof value === "string" && HEX.test(value)) return new ObjectId(value.toLowerCase())
  if (typeof value === "object" && value !== null) {
    const hex = (value as { $oid?: unknown }).$oid
    if (typeof hex === "string" && HEX.test(hex)) return new ObjectId(hex.toLowerCase())
  }
  throw invalid("ObjectId", value)
}

/** A 24 character hex ObjectId. */
export const ObjectIdScalar = new GraphQLScalarType({
  name: "ObjectId",
  description: "A BSON ObjectId as 24 hexadecimal characters.",
  serialize(value) {
    const hex = objectIdHex(value)
    if (hex === undefined) throw invalid("ObjectId", value)
    return hex
  },
  parseValue: parseObjectId,
  parseLiteral: (ast) => parseObjectId(literalString("ObjectId", ast)),
})

function parseDate(value: unknown): Date {
  const date =
    typeof value === "string" || typeof value === "number" ? new Date(value) : new Date(Number.NaN)
  if (Number.isNaN(date.getTime())) throw invalid("DateTime", value)
  return date
}

/** A BSON date as an ISO 8601 string. */
export const DateTimeScalar = new GraphQLScalarType({
  name: "DateTime",
  description: "A BSON date as an ISO 8601 string in UTC; inputs also accept epoch milliseconds.",
  serialize(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
    throw invalid("DateTime", value)
  },
  parseValue: parseDate,
  parseLiteral(ast) {
    if (ast.kind === Kind.INT) return parseDate(Number(ast.value))
    return parseDate(literalString("DateTime", ast))
  },
})

function parseLong(value: unknown): Long {
  if (typeof value === "number" && Number.isSafeInteger(value)) return new Long(BigInt(value))
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const big = BigInt(value)
    if (big >= -(2n ** 63n) && big < 2n ** 63n) return new Long(big)
  }
  throw invalid("Long", value)
}

/** A 64 bit integer, as a string so no precision is lost. */
export const LongScalar = new GraphQLScalarType({
  name: "Long",
  description: "A 64 bit integer, serialized as a decimal string so no precision is lost.",
  serialize(value) {
    const long = longValue(value)
    if (long !== undefined) return long.toString()
    if (typeof value === "number" && Number.isSafeInteger(value)) return String(value)
    if (typeof value === "bigint") return value.toString()
    throw invalid("Long", value)
  },
  parseValue: parseLong,
  parseLiteral(ast) {
    if (ast.kind === Kind.INT) return parseLong(ast.value)
    return parseLong(literalString("Long", ast))
  },
})

const DECIMAL = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$|^[-+]?(Infinity|Inf|NaN)$/

function parseDecimal(value: unknown): Decimal128 {
  const text = typeof value === "number" ? String(value) : value
  if (typeof text === "string" && DECIMAL.test(text)) return new Decimal128(text)
  throw invalid("Decimal", value)
}

/** A 128 bit decimal, as a string. */
export const DecimalScalar = new GraphQLScalarType({
  name: "Decimal",
  description: "A BSON Decimal128, serialized as a string.",
  serialize(value) {
    const text = decimalString(value)
    if (text === undefined) throw invalid("Decimal", value)
    return text
  },
  parseValue: parseDecimal,
  parseLiteral(ast) {
    if (ast.kind === Kind.INT || ast.kind === Kind.FLOAT) return parseDecimal(ast.value)
    return parseDecimal(literalString("Decimal", ast))
  },
})

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

function toBase64(bytes: Uint8Array): string {
  let text = ""
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text)
}

function parseBinary(value: unknown): Binary {
  if (typeof value === "string" && value.length % 4 === 0 && BASE64.test(value)) {
    const text = atob(value)
    const bytes = new Uint8Array(text.length)
    for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index)
    return new Binary(bytes, 0)
  }
  throw invalid("Binary", value)
}

/** Binary data as base64. */
export const BinaryScalar = new GraphQLScalarType({
  name: "Binary",
  description: "BSON binary data as standard base64. Inputs are stored with subtype 0.",
  serialize(value) {
    const parts = binaryParts(value)
    if (parts === undefined) throw invalid("Binary", value)
    return toBase64(parts.bytes)
  },
  parseValue: parseBinary,
  parseLiteral: (ast) => parseBinary(literalString("Binary", ast)),
})

function literalValue(
  ast: ValueNode,
  variables: Readonly<Record<string, unknown>> | null,
): unknown {
  switch (ast.kind) {
    case Kind.STRING:
    case Kind.BOOLEAN:
      return ast.value
    case Kind.INT:
    case Kind.FLOAT:
      return Number(ast.value)
    case Kind.NULL:
      return null
    case Kind.ENUM:
      return ast.value
    case Kind.LIST:
      return ast.values.map((item) => literalValue(item, variables))
    case Kind.OBJECT: {
      const out: Record<string, unknown> = {}
      for (const field of ast.fields) out[field.name.value] = literalValue(field.value, variables)
      return out
    }
    case Kind.VARIABLE:
      return variables?.[ast.name.value]
  }
}

function parseJson(value: unknown): unknown {
  try {
    return decode(value)
  } catch (error: unknown) {
    throw new GraphQLError(
      `JSON is not valid Extended JSON: ${error instanceof Error ? error.message : String(error)}`,
      { extensions: { code: "CANOPY_INVALID_QUERY" } },
    )
  }
}

/**
 * Any value, as relaxed Extended JSON. Inputs are read as Extended JSON, so `{"$oid": "…"}` is an
 * ObjectId and `{"$date": "…"}` a date.
 */
export const JsonScalar = new GraphQLScalarType({
  name: "JSON",
  description:
    'Any BSON value as relaxed Extended JSON. Inputs are read as Extended JSON, so {"$oid": "…"} is an ObjectId.',
  serialize: (value) => encode(value),
  parseValue: parseJson,
  parseLiteral: (ast, variables) => parseJson(literalValue(ast, variables ?? null)),
})

/** Every custom scalar, by name. */
export const SCALARS = {
  ObjectId: ObjectIdScalar,
  DateTime: DateTimeScalar,
  Long: LongScalar,
  Decimal: DecimalScalar,
  Binary: BinaryScalar,
  JSON: JsonScalar,
} as const
