import { isDocument, ValidationError } from "@canopy/protocol"

/**
 * A validator of untrusted JSON: returns the typed value or throws {@link ValidationError} naming the path of
 * the first problem. Objects refuse unknown fields, so a misspelled option is never silently ignored.
 */
export interface Schema<T> {
  parse(value: unknown, path?: string): T
  /** Set by {@link optional}; such fields may be absent. */
  readonly optional?: true
}

/** The type a schema produces. */
export type Infer<S> = S extends Schema<infer T> ? T : never

function fail(path: string, message: string): never {
  throw new ValidationError(`${path === "" ? "The body" : path} ${message}`, {
    details: { path },
  })
}

/** A string, optionally bounded and matched against a pattern. */
export function string(
  options: { readonly min?: number; readonly max?: number; readonly pattern?: RegExp } = {},
): Schema<string> {
  const min = options.min ?? 0
  const max = options.max ?? 10_000
  return {
    parse(value, path = "") {
      if (typeof value !== "string") fail(path, "must be a string")
      if (value.length < min) fail(path, `must have at least ${min} characters`)
      if (value.length > max) fail(path, `must have at most ${max} characters`)
      if (options.pattern !== undefined && !options.pattern.test(value))
        fail(path, "has an invalid format")
      return value
    },
  }
}

/** An integer within bounds. */
export function integer(
  options: { readonly min?: number; readonly max?: number } = {},
): Schema<number> {
  return {
    parse(value, path = "") {
      if (typeof value !== "number" || !Number.isSafeInteger(value))
        fail(path, "must be an integer")
      if (options.min !== undefined && value < options.min)
        fail(path, `must be at least ${options.min}`)
      if (options.max !== undefined && value > options.max)
        fail(path, `must be at most ${options.max}`)
      return value
    },
  }
}

/** A finite number within bounds. */
export function number(
  options: { readonly min?: number; readonly max?: number } = {},
): Schema<number> {
  return {
    parse(value, path = "") {
      if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "must be a number")
      if (options.min !== undefined && value < options.min)
        fail(path, `must be at least ${options.min}`)
      if (options.max !== undefined && value > options.max)
        fail(path, `must be at most ${options.max}`)
      return value
    },
  }
}

/** A boolean. */
export function boolean(): Schema<boolean> {
  return {
    parse(value, path = "") {
      if (typeof value !== "boolean") fail(path, "must be true or false")
      return value
    },
  }
}

/** One of a fixed set of strings. */
export function oneOf<const T extends string>(...values: readonly T[]): Schema<T> {
  const allowed = new Set<string>(values)
  return {
    parse(value, path = "") {
      if (typeof value !== "string" || !allowed.has(value))
        fail(path, `must be one of ${values.join(", ")}`)
      return value as T
    },
  }
}

/** An array of bounded length. */
export function array<T>(item: Schema<T>, options: { readonly max?: number } = {}): Schema<T[]> {
  const max = options.max ?? 1000
  return {
    parse(value, path = "") {
      if (!Array.isArray(value)) fail(path, "must be an array")
      if (value.length > max) fail(path, `must have at most ${max} items`)
      return value.map((entry, index) => item.parse(entry, `${path}[${index}]`))
    },
  }
}

/** Any JSON document (an object that is not an array). */
export function document(): Schema<Record<string, unknown>> {
  return {
    parse(value, path = "") {
      if (!isDocument(value)) fail(path, "must be an object")
      return value
    },
  }
}

/** Any value, left for the caller to check. */
export function unknownValue(): Schema<unknown> {
  return { parse: (value) => value }
}

/** Makes a field optional. */
export function optional<T>(
  schema: Schema<T>,
): Schema<T | undefined> & { readonly optional: true } {
  return {
    optional: true,
    parse(value, path = "") {
      return value === undefined ? undefined : schema.parse(value, path)
    },
  }
}

/** Accepts `null` as well. */
export function nullable<T>(schema: Schema<T>): Schema<T | null> {
  return {
    parse(value, path = "") {
      return value === null ? null : schema.parse(value, path)
    },
  }
}

type Shape = Readonly<Record<string, Schema<unknown>>>
type OptionalKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends { readonly optional: true } ? K : never
}[keyof S]
type ObjectOf<S extends Shape> = {
  readonly [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]>
} & { readonly [K in OptionalKeys<S>]?: Exclude<Infer<S[K]>, undefined> }

/** An object with exactly these fields. */
export function object<S extends Shape>(shape: S): Schema<ObjectOf<S>> {
  return {
    parse(value, path = "") {
      if (!isDocument(value)) fail(path, "must be an object")
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(shape, key)) fail(path === "" ? key : `${path}.${key}`, "is not allowed")
      }
      const out: Record<string, unknown> = {}
      for (const [key, schema] of Object.entries(shape)) {
        const field = path === "" ? key : `${path}.${key}`
        const raw = value[key]
        if (raw === undefined) {
          if (schema.optional !== true) fail(field, "is required")
          continue
        }
        out[key] = schema.parse(raw, field)
      }
      return out as ObjectOf<S>
    },
  }
}
