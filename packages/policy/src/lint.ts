import { isLinearRegex } from '@canopy/matcher'
import { isDocument, regexParts } from '@canopy/protocol'
import type { CollectionPolicies, ContextDefinitions, PolicyDefinition } from './model.ts'
import { Role } from './model.ts'
import { claimPaths } from './variables.ts'

/** Severity of a lint finding. Errors fail `canopy policies lint`. */
export type LintSeverity = 'error' | 'warn' | 'info'

/** One lint finding. */
export interface LintFinding {
  readonly rule: string
  readonly severity: LintSeverity
  readonly collection: string
  readonly policy?: string
  readonly message: string
}

/** Extra knowledge some rules need. Rules whose input is missing are skipped. */
export interface LintEnvironment {
  /** Roles the configured token issuers can emit, for `unreachable-role`. */
  readonly knownRoles?: readonly string[]
  /** Indexed field prefixes per collection, for `missing-index`. Each entry lists the fields of one index. */
  readonly indexes?: Readonly<Record<string, readonly (readonly string[])[]>>
}

const WRITE_OPS = new Set(['insert', 'update', 'delete'])

function regexesIn(
  value: unknown,
  out: { pattern: string; options: string }[] = [],
): { pattern: string; options: string }[] {
  const parts = regexParts(value)
  if (parts !== undefined) {
    out.push(parts)
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) regexesIn(item, out)
    return out
  }
  if (!isDocument(value)) return out
  if (typeof value['$regex'] === 'string') {
    out.push({
      pattern: value['$regex'],
      options: typeof value['$options'] === 'string' ? value['$options'] : '',
    })
  }
  for (const key of Object.keys(value)) regexesIn(value[key], out)
  return out
}

function equalityFields(filter: unknown): string[] {
  if (!isDocument(filter)) return []
  const out: string[] = []
  for (const key of Object.keys(filter)) {
    if (key.startsWith('$')) continue
    const value = filter[key]
    if (!isDocument(value) || Object.hasOwn(value, '$auth') || Object.hasOwn(value, '$ctx'))
      out.push(key)
    else if (Object.hasOwn(value, '$eq') || Object.hasOwn(value, '$in')) out.push(key)
  }
  return out
}

/** Runs the core lint rules over a set of collection policies. */
export function lintPolicies(
  definitions: readonly CollectionPolicies[],
  contexts: ContextDefinitions = {},
  env: LintEnvironment = {},
): LintFinding[] {
  const findings: LintFinding[] = []
  const add = (finding: LintFinding): void => {
    findings.push(finding)
  }
  for (const def of definitions) {
    const { collection } = def
    const readers = def.policies.filter((p) => p.kind === 'permissive' && p.ops.includes('read'))
    if (def.exposed && readers.length === 0) {
      add({
        rule: 'exposed-without-read-policy',
        severity: 'warn',
        collection,
        message:
          'The collection is exposed but no permissive policy grants read, so nobody can read it',
      })
    }
    for (const policy of def.policies) lintPolicy(def, policy, env, add)
    for (const kind of ['read', 'write', 'update'] as const) {
      const rules = def.fields?.[kind]
      if (
        rules !== undefined &&
        Object.keys(rules).length > 0 &&
        !Object.hasOwn(rules, 'default')
      ) {
        add({
          rule: 'field-rules-partial',
          severity: 'warn',
          collection,
          message: `fields.${kind} has rules for ${Object.keys(rules).join(', ')} but no default, so every other role can access all fields`,
        })
      }
    }
  }
  for (const [name, lookup] of Object.entries(contexts)) {
    if (!Number.isSafeInteger(lookup.max) || lookup.max <= 0) {
      add({
        rule: 'ctx-unbounded',
        severity: 'error',
        collection: lookup.from,
        message: `The context lookup ${name} has no max`,
      })
    }
  }
  return findings
}

function lintPolicy(
  def: CollectionPolicies,
  policy: PolicyDefinition,
  env: LintEnvironment,
  add: (finding: LintFinding) => void,
): void {
  const { collection } = def
  const base = { collection, policy: policy.name }
  const broad = policy.roles.includes(Role.Public) || policy.roles.includes(Role.Anon)
  const writes = policy.ops.filter((op) => WRITE_OPS.has(op))
  if (policy.kind === 'permissive' && broad && writes.length > 0) {
    const clause = writes.includes('insert') ? (policy.check ?? policy.using) : policy.using
    if (clause === undefined || Object.keys(clause).length === 0) {
      add({
        ...base,
        rule: 'public-allow-all',
        severity: 'error',
        message: `Anyone, including anon, may ${writes.join(', ')} any document`,
      })
    }
  }
  for (const path of [...claimPaths(policy.using), ...claimPaths(policy.check)]) {
    if (path === 'user_metadata' || path.startsWith('user_metadata.')) {
      add({
        ...base,
        rule: 'user-editable-claim',
        severity: 'error',
        message: `The claim ${path} can be edited by the user, so it must not drive authorization`,
      })
    }
  }
  for (const regex of regexesIn(policy.using)) {
    if (!isLinearRegex(regex.pattern, regex.options)) {
      add({
        ...base,
        rule: 'regex-not-linear',
        severity: 'error',
        message: `The using regex /${regex.pattern}/ needs backtracking and cannot run in process`,
      })
    }
  }
  if (policy.ops.includes('update') && policy.check === undefined && policy.using !== undefined) {
    add({
      ...base,
      rule: 'update-without-check',
      severity: 'info',
      message:
        'The using clause doubles as the update check, so an update may not move a document out of it',
    })
  }
  if (env.knownRoles !== undefined) {
    for (const role of policy.roles) {
      if (
        role !== Role.Public &&
        role !== Role.Anon &&
        role !== Role.Authenticated &&
        !env.knownRoles.includes(role)
      ) {
        add({
          ...base,
          rule: 'unreachable-role',
          severity: 'info',
          message: `No token issuer emits the role ${role}`,
        })
      }
    }
  }
  const indexes = env.indexes?.[collection]
  if (indexes !== undefined) {
    for (const field of equalityFields(policy.using)) {
      if (!indexes.some((fields) => fields[0] === field)) {
        add({
          ...base,
          rule: 'missing-index',
          severity: 'warn',
          message: `No index starts with ${field}, which this policy filters on for every query`,
        })
      }
    }
  }
}
