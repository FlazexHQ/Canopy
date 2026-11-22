import type { CollectionPolicies, ContextDefinitions, PolicyDefinition } from "@canopy/policy"

/** Thrown for a value the TypeScript DSL cannot spell, such as an ObjectId inside a clause. */
export class UnwritableValueError extends TypeError {
  constructor(value: unknown) {
    super(`No TypeScript literal for ${Object.prototype.toString.call(value)}`)
    this.name = "UnwritableValueError"
  }
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

function isPlain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

class Writer {
  readonly helpers = new Set<string>()

  literal(value: unknown): string {
    if (value === null) return "null"
    if (typeof value === "string") return JSON.stringify(value)
    if (typeof value === "boolean") return String(value)
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Object.is(value, -0)) throw new UnwritableValueError(value)
      return String(value)
    }
    if (value instanceof Date) return `new Date(${JSON.stringify(value.toISOString())})`
    if (Array.isArray(value)) return `[${value.map((item) => this.literal(item)).join(", ")}]`
    if (!isPlain(value)) throw new UnwritableValueError(value)
    const variable = this.variable(value)
    if (variable !== undefined) return variable
    const entries = Object.entries(value).map(
      ([key, item]) => `${IDENTIFIER.test(key) ? key : JSON.stringify(key)}: ${this.literal(item)}`,
    )
    return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`
  }

  private variable(value: Record<string, unknown>): string | undefined {
    const authPath = value["$auth"]
    if (typeof authPath === "string" && onlyKeys(value, ["$auth", "as"])) {
      const as = value["as"]
      if (as !== undefined && typeof as !== "string") return undefined
      this.helpers.add("auth")
      return `auth(${JSON.stringify(authPath)}${as === undefined ? "" : `, ${JSON.stringify(as)}`})`
    }
    const ctxName = value["$ctx"]
    if (typeof ctxName === "string" && onlyKeys(value, ["$ctx"])) {
      this.helpers.add("ctx")
      return `ctx(${JSON.stringify(ctxName)})`
    }
    const now = value["$now"]
    if (isPlain(now) && onlyKeys(value, ["$now"]) && onlyKeys(now, ["offset"])) {
      const offset = now["offset"]
      if (offset !== undefined && typeof offset !== "string") return undefined
      this.helpers.add("now")
      return `now(${offset === undefined ? "" : JSON.stringify(offset)})`
    }
    return undefined
  }

  policy(policy: PolicyDefinition): string {
    const builder = policy.kind === "permissive" ? "allow" : "restrict"
    this.helpers.add(builder)
    const roles = policy.roles.map((role) => JSON.stringify(role))
    const [single] = policy.ops
    const start =
      policy.ops.length === 1 && single !== undefined
        ? `${builder}.${single}(${roles.join(", ")})`
        : `${builder}.ops(${[this.literal([...policy.ops]), ...roles].join(", ")})`
    const lines = [`    ${start}`]
    if (policy.using !== undefined) lines.push(`      .where(${this.literal(policy.using)})`)
    if (policy.check !== undefined) lines.push(`      .check(${this.literal(policy.check)})`)
    lines.push(`      .named(${JSON.stringify(policy.name)}),`)
    return lines.join("\n")
  }
}

function module(helpers: ReadonlySet<string>, body: string): string {
  const names = [...helpers].sort()
  return `import { ${names.join(", ")} } from "canopy.js/policy"\n\n${body}`
}

/**
 * Writes the policies of a collection as a TypeScript module in the policy DSL, the same form
 * `canopy init` and hand written files use. Loading the module gives back an equal definition (equal
 * `hashCollection`). Throws {@link UnwritableValueError} for clause values the DSL cannot express.
 */
export function collectionModule(def: CollectionPolicies): string {
  const writer = new Writer()
  writer.helpers.add("collection")
  const options = [`  exposed: ${def.exposed},`, `  realtime: ${def.realtime},`]
  options.push(
    def.policies.length === 0
      ? "  policies: [],"
      : `  policies: [\n${def.policies.map((policy) => writer.policy(policy)).join("\n")}\n  ],`,
  )
  if (def.fields !== undefined) options.push(`  fields: ${writer.literal(def.fields)},`)
  if (def.immutable !== undefined) options.push(`  immutable: ${writer.literal(def.immutable)},`)
  return module(
    writer.helpers,
    `export default collection(${JSON.stringify(def.collection)}, {\n${options.join("\n")}\n})\n`,
  )
}

/** Writes context lookup declarations as the `_context.ts` module of a policy directory. */
export function contextModule(contexts: ContextDefinitions): string {
  const writer = new Writer()
  writer.helpers.add("context")
  const entries = Object.entries(contexts).map(
    ([name, lookup]) =>
      `  ${IDENTIFIER.test(name) ? name : JSON.stringify(name)}: ${writer.literal({ ...lookup })},`,
  )
  return module(writer.helpers, `export default context({\n${entries.join("\n")}\n})\n`)
}
