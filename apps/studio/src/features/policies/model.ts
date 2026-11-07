import {
  type CollectionPolicies,
  fromStored,
  type LintFinding,
  lintPolicies,
  validateCollectionPolicies,
} from "@canopy/policy"
import { canonicalString } from "@canopy/protocol"
import type { PolicyDraft } from "../../api/client.ts"
import type { StoredCollection, StoredPolicy, ViewAs } from "../../api/contract.ts"

/** An empty draft: the collection is not exposed and nobody but `service` can do anything. */
export function emptyDraft(collection: string): PolicyDraft {
  return { _id: collection, exposed: false, realtime: false, policies: [] }
}

/** The editable body of a published version. */
export function draftOf(stored: StoredCollection | null, collection: string): PolicyDraft {
  if (stored === null) return emptyDraft(collection)
  return {
    _id: stored._id,
    exposed: stored.exposed,
    realtime: stored.realtime,
    policies: stored.policies,
    ...(stored.fields === undefined || stored.fields === null ? {} : { fields: stored.fields }),
    ...(stored.immutable === undefined || stored.immutable.length === 0
      ? {}
      : { immutable: stored.immutable }),
  }
}

/** Canonical text of a draft, used for comparing and diffing. */
export function draftText(draft: PolicyDraft): string {
  const body = {
    _id: draft._id,
    exposed: draft.exposed,
    realtime: draft.realtime,
    policies: draft.policies.map((policy) => ({
      name: policy.name,
      kind: policy.kind,
      ops: policy.ops,
      roles: policy.roles,
      ...(policy.using === undefined ? {} : { using: JSON.parse(policy.using) as unknown }),
      ...(policy.check === undefined ? {} : { check: JSON.parse(policy.check) as unknown }),
    })),
    ...(draft.fields === undefined || draft.fields === null ? {} : { fields: draft.fields }),
    ...(draft.immutable === undefined || draft.immutable.length === 0
      ? {}
      : { immutable: draft.immutable }),
  }
  return JSON.stringify(body, null, 2)
}

export function sameDraft(a: PolicyDraft, b: PolicyDraft): boolean {
  return draftText(a) === draftText(b)
}

/** Converts a draft to authoring form; throws when a clause is not valid EJSON. */
export function toAuthoring(draft: PolicyDraft): CollectionPolicies {
  return fromStored(draft)
}

/** The outcome of checking a draft locally with the same compiler and linter as the server. */
export interface DraftCheck {
  readonly errors: readonly string[]
  readonly lint: readonly LintFinding[]
}

/**
 * Validates a draft with `@canopy/policy` (clause syntax, allowed operators, variable positions, limits)
 * and runs the lint rules that need no database access.
 */
export function checkDraft(draft: PolicyDraft): DraftCheck {
  let authoring: CollectionPolicies
  try {
    authoring = toAuthoring(draft)
  } catch (error: unknown) {
    return { errors: [error instanceof Error ? error.message : String(error)], lint: [] }
  }
  const errors: string[] = []
  try {
    validateCollectionPolicies(authoring)
  } catch (error: unknown) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  return { errors, lint: lintPolicies([authoring]) }
}

/** Parses a draft from the EJSON view; the text is the canonical form of {@link draftText}. */
export function draftFromText(text: string, collection: string): PolicyDraft {
  const raw = JSON.parse(text) as unknown
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError("The policy document must be a JSON object")
  }
  const value = raw as Record<string, unknown>
  if (value["_id"] !== undefined && value["_id"] !== collection) {
    throw new TypeError(`The policy document is for ${String(value["_id"])}, not ${collection}`)
  }
  const policies = value["policies"]
  if (!Array.isArray(policies)) throw new TypeError("policies must be an array")
  return {
    _id: collection,
    exposed: value["exposed"] === true,
    realtime: value["realtime"] === true,
    policies: policies.map((entry, index): StoredPolicy => {
      if (typeof entry !== "object" || entry === null) {
        throw new TypeError(`policies[${index}] must be an object`)
      }
      const policy = entry as Record<string, unknown>
      const clause = (key: "using" | "check") => {
        const clauseValue = policy[key]
        if (clauseValue === undefined) return {}
        if (typeof clauseValue !== "object" || clauseValue === null || Array.isArray(clauseValue)) {
          throw new TypeError(`policies[${index}].${key} must be an object`)
        }
        return { [key]: canonicalString(clauseValue) }
      }
      return {
        name: String(policy["name"] ?? ""),
        kind: policy["kind"] === "restrictive" ? "restrictive" : "permissive",
        ops: (Array.isArray(policy["ops"]) ? policy["ops"] : []) as StoredPolicy["ops"],
        roles: (Array.isArray(policy["roles"]) ? policy["roles"] : []).map(String),
        ...clause("using"),
        ...clause("check"),
      }
    }),
    ...(typeof value["fields"] === "object" && value["fields"] !== null
      ? { fields: value["fields"] as NonNullable<PolicyDraft["fields"]> }
      : {}),
    ...(Array.isArray(value["immutable"]) ? { immutable: value["immutable"].map(String) } : {}),
  }
}

function tsValue(value: unknown, indent: string): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]"
    return `[${value.map((item) => tsValue(item, indent)).join(", ")}]`
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
    if (entries.length === 1) {
      const [[key, inner]] = entries as [[string, unknown]]
      if (key === "$auth" && typeof inner === "string") return `auth(${JSON.stringify(inner)})`
      if (key === "$ctx" && typeof inner === "string") return `ctx(${JSON.stringify(inner)})`
      if (key === "$now" && typeof inner === "object" && inner !== null) {
        const offset = (inner as { offset?: unknown }).offset
        return typeof offset === "string" ? `now(${JSON.stringify(offset)})` : "now()"
      }
    }
    if (entries.length === 2 && "$auth" in value && "as" in value) {
      const variable = value as { $auth: unknown; as: unknown }
      return `auth(${JSON.stringify(variable.$auth)}, ${JSON.stringify(variable.as)})`
    }
    if (entries.length === 0) return "{}"
    const inner = `${indent}  `
    const body = entries
      .map(([key, item]) => {
        const name = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)
        return `${inner}${name}: ${tsValue(item, inner)},`
      })
      .join("\n")
    return `{\n${body}\n${indent}}`
  }
  return JSON.stringify(value)
}

const SINGLE_OPS = new Set(["read", "insert", "update", "delete"])

/**
 * Renders a draft as the TypeScript DSL (`canopy/policies/<collection>.ts`). The DSL compiles to exactly
 * this stored form, so `canopy policies pull` and this view agree.
 */
export function toDsl(draft: PolicyDraft): string {
  const authoring = toAuthoring(draft)
  const used = new Set<string>(["collection"])
  const lines = authoring.policies.map((policy) => {
    const builder = policy.kind === "permissive" ? "allow" : "restrict"
    used.add(builder)
    const roles = policy.roles.map((role) => JSON.stringify(role)).join(", ")
    const [only] = policy.ops
    let call =
      policy.ops.length === 1 && only !== undefined && SINGLE_OPS.has(only)
        ? `${builder}.${only}(${roles})`
        : `${builder}.ops(${JSON.stringify(policy.ops)}, ${roles})`
    if (policy.using !== undefined) call += `\n      .where(${tsValue(policy.using, "      ")})`
    if (policy.check !== undefined) call += `\n      .check(${tsValue(policy.check, "      ")})`
    call += `\n      .named(${JSON.stringify(policy.name)})`
    return `    ${call},`
  })
  const text = lines.join("\n")
  for (const name of ["auth", "ctx", "now"]) if (text.includes(`${name}(`)) used.add(name)
  const imports = [...used].sort().join(", ")
  const parts = [
    `import { ${imports} } from "@canopy/policy"`,
    "",
    `export default collection(${JSON.stringify(authoring.collection)}, {`,
    `  exposed: ${authoring.exposed},`,
    `  realtime: ${authoring.realtime},`,
    `  policies: [${lines.length === 0 ? "]," : `\n${text}\n  ],`}`,
  ]
  if (authoring.fields !== undefined) parts.push(`  fields: ${tsValue(authoring.fields, "  ")},`)
  if (authoring.immutable !== undefined && authoring.immutable.length > 0) {
    parts.push(`  immutable: ${tsValue(authoring.immutable, "  ")},`)
  }
  parts.push("})", "")
  return parts.join("\n")
}

/** One line of a diff. */
export interface DiffLine {
  readonly kind: "same" | "added" | "removed"
  readonly text: string
}

/** A line diff based on the longest common subsequence. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n")
  const b = after.split("\n")
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const row = table[i] as number[]
    const below = table[i + 1] as number[]
    for (let j = b.length - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] ?? "" })
      i += 1
      j += 1
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      out.push({ kind: "removed", text: a[i] ?? "" })
      i += 1
    } else {
      out.push({ kind: "added", text: b[j] ?? "" })
      j += 1
    }
  }
  while (i < a.length) out.push({ kind: "removed", text: a[i++] ?? "" })
  while (j < b.length) out.push({ kind: "added", text: b[j++] ?? "" })
  return out
}

/** Starter policy templates offered by the setup wizard and the policy editor. */
export const TEMPLATE_IDS = ["owner-only", "tenant-scoped", "public-read", "write-only"] as const
export type TemplateId = (typeof TEMPLATE_IDS)[number]

/** Field names a template refers to. */
export interface TemplateOptions {
  readonly ownerField?: string
  readonly tenantField?: string
  readonly tenantClaim?: string
}

function stored(
  name: string,
  kind: StoredPolicy["kind"],
  ops: StoredPolicy["ops"],
  roles: string[],
  clauses: { using?: Record<string, unknown>; check?: Record<string, unknown> },
): StoredPolicy {
  return {
    name,
    kind,
    ops,
    roles,
    ...(clauses.using === undefined ? {} : { using: canonicalString(clauses.using) }),
    ...(clauses.check === undefined ? {} : { check: canonicalString(clauses.check) }),
  }
}

/**
 * Builds a starter draft: `owner-only` (each user sees and edits their own documents), `tenant-scoped`
 * (members of a tenant share its documents), `public-read` (anyone reads, owners write) and `write-only`
 * (signed in users submit documents nobody else can read).
 */
export function templateDraft(
  collection: string,
  template: TemplateId,
  options: TemplateOptions = {},
): PolicyDraft {
  const owner = options.ownerField ?? "ownerId"
  const tenant = options.tenantField ?? "orgId"
  const claim = options.tenantClaim ?? "org_id"
  const own = { [owner]: { $auth: "sub" } }
  const ownerPolicies = [
    stored("read own", "permissive", ["read"], ["authenticated"], { using: own }),
    stored("create own", "permissive", ["insert"], ["authenticated"], { check: own }),
    stored("edit own", "permissive", ["update"], ["authenticated"], { using: own }),
    stored("delete own", "permissive", ["delete"], ["authenticated"], { using: own }),
  ]
  const base = { _id: collection, exposed: true, realtime: true }
  switch (template) {
    case "owner-only":
      return { ...base, policies: ownerPolicies, immutable: [owner] }
    case "tenant-scoped": {
      const scoped = { [tenant]: { $auth: claim } }
      return {
        ...base,
        policies: [
          stored("read in my tenant", "permissive", ["read"], ["authenticated"], { using: scoped }),
          stored("create in my tenant", "permissive", ["insert"], ["authenticated"], {
            check: scoped,
          }),
          stored("edit in my tenant", "permissive", ["update"], ["authenticated"], {
            using: scoped,
          }),
          stored("delete in my tenant", "permissive", ["delete"], ["authenticated"], {
            using: scoped,
          }),
        ],
        immutable: [tenant],
      }
    }
    case "public-read":
      return {
        ...base,
        policies: [
          stored("anyone reads", "permissive", ["read"], ["public"], {}),
          ...ownerPolicies.filter((policy) => !policy.ops.includes("read")),
        ],
        immutable: [owner],
      }
    case "write-only":
      return {
        ...base,
        realtime: false,
        policies: [
          stored("submit", "permissive", ["insert"], ["authenticated"], {
            check: { submittedBy: { $auth: "sub" } },
          }),
        ],
        immutable: ["submittedBy"],
      }
  }
}

/** One simulator case turned into a policy test. */
export interface TestCaseInput {
  readonly collection: string
  readonly as: ViewAs
  readonly op: "read" | "insert" | "update" | "delete"
  readonly document: Readonly<Record<string, unknown>>
  readonly update?: Readonly<Record<string, unknown>>
  readonly allowed: boolean
  readonly hiddenFields?: readonly string[]
}

function actorCode(as: ViewAs): string {
  if (as.roles.includes("anon")) return "as.anon()"
  if (as.roles.includes("service")) return "as.service()"
  const extra = as.roles.filter((role) => role !== "authenticated")
  const claims = JSON.stringify(as.claims)
  return extra.length === 0
    ? `as.user(${claims})`
    : `as.user(${claims}, { roles: ${JSON.stringify(extra)} })`
}

/**
 * Turns a simulator case into a `describePolicies` snippet for `canopy/policies/<collection>.test.ts`, so
 * what was checked by hand keeps being checked by `canopy policies test`.
 */
export function testSnippet(input: TestCaseInput): string {
  const verb = input.allowed ? "can" : "cannot"
  const doc = JSON.stringify(input.document)
  let call: string
  switch (input.op) {
    case "read":
      call = `expect(actor).${verb}.read(doc(${doc}))`
      if (input.allowed && input.hiddenFields !== undefined && input.hiddenFields.length > 0) {
        call += `.withoutFields(${JSON.stringify(input.hiddenFields)})`
      }
      break
    case "update":
      call = `expect(actor).${verb}.update(doc(${doc}), ${JSON.stringify(input.update ?? {})})`
      break
    default:
      call = `expect(actor).${verb}.${input.op}(doc(${doc}))`
  }
  return [
    'import { as, describePolicies } from "@canopy/policy/testing"',
    "",
    `describePolicies(${JSON.stringify(input.collection)}, ({ doc, expect }) => {`,
    `  const actor = ${actorCode(input.as)}`,
    `  ${call}`,
    "})",
    "",
  ].join("\n")
}
