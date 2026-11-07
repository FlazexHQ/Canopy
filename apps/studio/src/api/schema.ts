/**
 * A small structural validator for admin API responses. Responses arrive as `unknown` and are checked before
 * use, so a contract change on the server surfaces as one clear error instead of a broken screen.
 */
export interface Schema<T> {
  readonly describe: string
  parse(value: unknown, path?: string): T
}

/** The type a schema produces. */
export type Infer<S> = S extends Schema<infer T> ? T : never

/** Thrown when a response does not match the documented contract. */
export class ContractError extends TypeError {
  readonly path: string
  constructor(path: string, expected: string, value: unknown) {
    const got = value === null ? "null" : Array.isArray(value) ? "array" : typeof value
    super(`Unexpected admin API response at ${path || "(root)"}: expected ${expected}, got ${got}`)
    this.name = "ContractError"
    this.path = path
  }
}

const primitive = <T>(describe: string, check: (value: unknown) => value is T): Schema<T> => ({
  describe,
  parse(value, path = "") {
    if (!check(value)) throw new ContractError(path, describe, value)
    return value
  },
})

export const string: Schema<string> = primitive(
  "string",
  (value): value is string => typeof value === "string",
)
export const number: Schema<number> = primitive(
  "number",
  (value): value is number => typeof value === "number" && Number.isFinite(value),
)
export const boolean: Schema<boolean> = primitive(
  "boolean",
  (value): value is boolean => typeof value === "boolean",
)
export const unknown: Schema<unknown> = { describe: "any value", parse: (value) => value }

/** A plain JSON object with arbitrary members, for example an EJSON document or filter. */
export const json: Schema<Record<string, unknown>> = primitive(
  "object",
  (value): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value),
)

export function literal<const T extends readonly (string | number | boolean)[]>(
  ...values: T
): Schema<T[number]> {
  return primitive(
    values.map((value) => JSON.stringify(value)).join(" | "),
    (value): value is T[number] => values.includes(value as T[number]),
  )
}

export function array<T>(item: Schema<T>): Schema<T[]> {
  return {
    describe: `${item.describe}[]`,
    parse(value, path = "") {
      if (!Array.isArray(value)) throw new ContractError(path, `${item.describe}[]`, value)
      return value.map((entry, index) => item.parse(entry, `${path}[${index}]`))
    },
  }
}

export function nullable<T>(inner: Schema<T>): Schema<T | null> {
  return {
    describe: `${inner.describe} | null`,
    parse: (value, path = "") => (value === null ? null : inner.parse(value, path)),
  }
}

const OPTIONAL = Symbol("optional")

/** A member that may be absent (or `undefined`). */
export interface Optional<T> extends Schema<T | undefined> {
  readonly [OPTIONAL]: true
}

export function optional<T>(inner: Schema<T>): Optional<T> {
  return {
    [OPTIONAL]: true,
    describe: `${inner.describe} | undefined`,
    parse: (value, path = "") => (value === undefined ? undefined : inner.parse(value, path)),
  }
}

type Shape = Readonly<Record<string, Schema<unknown>>>
type RequiredKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends Optional<unknown> ? never : K
}[keyof S]
type OptionalKeys<S extends Shape> = Exclude<keyof S, RequiredKeys<S>>

/** The object type a shape describes; optional members stay optional. */
export type ObjectOf<S extends Shape> = {
  readonly [K in RequiredKeys<S>]: Infer<S[K]>
} & { readonly [K in OptionalKeys<S>]?: Exclude<Infer<S[K]>, undefined> }

/** An object with known members. Unknown members are dropped, so additions on the server are harmless. */
export function object<S extends Shape>(shape: S): Schema<ObjectOf<S>> {
  return {
    describe: "object",
    parse(value, path = "") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ContractError(path, "object", value)
      }
      const input = value as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const [key, schema] of Object.entries(shape)) {
        const parsed = schema.parse(input[key], path === "" ? key : `${path}.${key}`)
        if (parsed !== undefined) out[key] = parsed
      }
      return out as ObjectOf<S>
    },
  }
}

export function record<T>(item: Schema<T>): Schema<Record<string, T>> {
  return {
    describe: `Record<string, ${item.describe}>`,
    parse(value, path = "") {
      const input = json.parse(value, path)
      const out: Record<string, T> = {}
      for (const [key, entry] of Object.entries(input))
        out[key] = item.parse(entry, `${path}.${key}`)
      return out
    },
  }
}

/**
 * A timestamp sent either as an ISO string or as EJSON `{ "$date": … }`, normalized to an ISO string.
 */
export const date: Schema<string> = {
  describe: "date",
  parse(value, path = "") {
    if (typeof value === "string") return value
    if (typeof value === "object" && value !== null && "$date" in value) {
      const inner = (value as { $date: unknown }).$date
      if (typeof inner === "string") return inner
      if (typeof inner === "number") return new Date(inner).toISOString()
      if (typeof inner === "object" && inner !== null && "$numberLong" in inner) {
        return new Date(Number((inner as { $numberLong: unknown }).$numberLong)).toISOString()
      }
    }
    throw new ContractError(path, "date", value)
  },
}
