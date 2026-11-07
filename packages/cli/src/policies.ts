import { mkdir, stat, writeFile } from "node:fs/promises"
import { userInfo } from "node:os"
import { join, resolve } from "node:path"
import {
  CONTEXT_DOCUMENT_ID,
  type CollectionPolicies,
  type ContextDefinitions,
  fromStored,
  hashCollection,
  hashPolicySet,
  type LintFinding,
  lintPolicies,
  type PolicySet,
  toStored,
} from "@canopy/policy"
import { CanopyError, ErrorCode, isDocument } from "@canopy/protocol"
import { directoryPolicies } from "@canopy/realtime"
import { type Actor, AuditLog, migrationStatus, PolicyStore } from "@canopy/server"
import { MongoClient } from "mongodb"
import { collectionModule, contextModule, UnwritableValueError } from "./dsl-writer.ts"
import { confirmed, messageOf, type Output } from "./output.ts"
import type { AdminClient } from "./remote.ts"

/** Connection settings shared by the commands that use the meta database. */
export interface MetaOptions {
  readonly mongodbUri: string
  readonly metaDatabase: string
}

/** The actor recorded in `policy_history` and `audit_log` for CLI changes. */
export function cliActor(): Actor {
  let user = "unknown"
  try {
    user = userInfo().username
  } catch {}
  return { type: "system", id: `cli:${user}` }
}

/**
 * Opens the meta database, refusing when its migrations have not run, and closes the client afterwards.
 * Returns the exit code of `body`, or 1 after printing why the database could not be used.
 */
export async function withMeta(
  options: MetaOptions,
  out: Output,
  body: (client: MongoClient) => Promise<number>,
  requireMigrations = true,
): Promise<number> {
  const client = new MongoClient(options.mongodbUri, { serverSelectionTimeoutMS: 10_000 })
  try {
    await client.connect()
    if (requireMigrations) {
      const pending = (await migrationStatus(client.db(options.metaDatabase))).filter(
        (status) => status.appliedAt === undefined,
      )
      if (pending.length > 0) {
        out.error(
          `The meta database ${options.metaDatabase} is not migrated (${pending.map((s) => s.name).join(", ")}). Run canopy migrate first.`,
        )
        return 1
      }
    }
    return await body(client)
  } catch (error: unknown) {
    out.error(error instanceof CanopyError ? error.message : `error  ${messageOf(error)}`)
    return 1
  } finally {
    await client.close()
  }
}

function store(client: MongoClient, metaDatabase: string): PolicyStore {
  return new PolicyStore({
    client,
    metaDatabase,
    audit: new AuditLog(client.db(metaDatabase)),
    writable: true,
  })
}

/** The published state of a project: each collection's version and hash, and the context lookups. */
interface PublishedPolicies {
  readonly collections: ReadonlyMap<string, { readonly version: number; readonly hash: string }>
  readonly contexts: ContextDefinitions
  readonly contextVersion: number
}

/** Everything published, as `policies pull` writes it. */
interface PolicySnapshot {
  readonly definitions: ReadonlyMap<string, CollectionPolicies>
  readonly stored: ReadonlyMap<string, { readonly version: number; readonly hash: string }>
  readonly contexts: ContextDefinitions
}

/** One published version, as `policies history` prints it. */
interface PolicyVersionEntry {
  readonly version: number
  readonly publishedAt: Date
  readonly publishedBy: string
  readonly hash: string
  readonly comment?: string
  readonly rollbackOf?: number
}

/**
 * Where the `policies` commands that touch published policies work: the meta database directly, or a
 * remote admin API.
 */
interface PolicyTarget {
  published(): Promise<PublishedPolicies>
  definition(collection: string): Promise<CollectionPolicies | undefined>
  publish(
    definition: CollectionPolicies,
    expectedVersion: number,
    comment: string | undefined,
  ): Promise<{ readonly version: number; readonly findings: readonly LintFinding[] }>
  publishContexts(
    lookups: ContextDefinitions,
    expectedVersion: number,
    comment: string | undefined,
  ): Promise<{ readonly version: number }>
  snapshot(): Promise<PolicySnapshot>
  /** The published version of a collection, or of the context lookups for `_context`; 0 when none. */
  version(collection: string): Promise<number>
  history(collection: string, limit: number | undefined): Promise<PolicyVersionEntry[]>
  /** Republishes `version` as a new version and returns it. */
  rollback(
    collection: string,
    version: number,
    expectedVersion: number,
    comment: string | undefined,
  ): Promise<number>
}

function metaTarget(client: MongoClient, metaDatabase: string): PolicyTarget {
  const policies = store(client, metaDatabase)
  const actor = cliActor()
  const withComment = (comment: string | undefined) => (comment === undefined ? {} : { comment })
  return {
    async published() {
      const all = await policies.all()
      return {
        collections: all.stored,
        contexts: all.contexts,
        contextVersion: (await policies.getContexts())?.version ?? 0,
      }
    },
    async definition(collection) {
      return (await policies.all()).definitions.get(collection)
    },
    async publish(definition, expectedVersion, comment) {
      const result = await policies.publish({
        definition,
        expectedVersion,
        actor,
        ...withComment(comment),
      })
      return { version: result.stored.version, findings: result.findings }
    },
    async publishContexts(lookups, expectedVersion, comment) {
      const result = await policies.publishContexts({
        lookups,
        expectedVersion,
        actor,
        ...withComment(comment),
      })
      return { version: result.stored.version }
    },
    async snapshot() {
      const all = await policies.all()
      return { definitions: all.definitions, stored: all.stored, contexts: all.contexts }
    },
    async version(collection) {
      return collection === CONTEXT_DOCUMENT_ID
        ? ((await policies.getContexts())?.version ?? 0)
        : ((await policies.get(collection))?.version ?? 0)
    },
    async history(collection, limit) {
      return policies.versions(collection, limit === undefined ? {} : { limit })
    },
    async rollback(collection, version, expectedVersion, comment) {
      const input = { version, expectedVersion, actor, ...withComment(comment) }
      const result =
        collection === CONTEXT_DOCUMENT_ID
          ? await policies.rollbackContexts(input)
          : await policies.rollback({ ...input, collection })
      return result.stored.version
    },
  }
}

function versionOf(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0
}

function storedVersion(result: unknown): number {
  return isDocument(result) && isDocument(result["stored"])
    ? versionOf(result["stored"]["version"])
    : 0
}

/** Publishes through `/admin/v1/policies` and `/admin/v1/contexts`, as the admin the token belongs to. */
function remoteTarget(admin: AdminClient): PolicyTarget {
  const withComment = (comment: string | undefined) => (comment === undefined ? {} : { comment })
  const target: PolicyTarget = {
    async published() {
      const list = await admin.get("/policies")
      const contexts = await admin.get("/contexts")
      const collections = new Map<string, { version: number; hash: string }>()
      const data = isDocument(list) && Array.isArray(list["data"]) ? list["data"] : []
      for (const entry of data)
        if (isDocument(entry) && typeof entry["collection"] === "string")
          collections.set(entry["collection"], {
            version: versionOf(entry["version"]),
            hash: String(entry["hash"] ?? ""),
          })
      const stored = isDocument(contexts) ? contexts["stored"] : undefined
      const lookups = isDocument(stored) ? stored["lookups"] : undefined
      return {
        collections,
        contexts: (isDocument(lookups) ? lookups : {}) as ContextDefinitions,
        contextVersion: isDocument(contexts) ? versionOf(contexts["version"]) : 0,
      }
    },
    async definition(collection) {
      const body = await admin.get(`/policies/${encodeURIComponent(collection)}`)
      const stored = isDocument(body) ? body["stored"] : undefined
      return isDocument(stored) ? fromStored(stored) : undefined
    },
    async publish(definition, expectedVersion, comment) {
      const stored = toStored(definition, { version: 0 })
      const result = await admin.post(
        `/policies/${encodeURIComponent(definition.collection)}/publish`,
        {
          definition: {
            exposed: stored.exposed,
            realtime: stored.realtime,
            policies: stored.policies,
            ...(stored.fields === undefined ? {} : { fields: stored.fields }),
            ...(stored.immutable === undefined ? {} : { immutable: stored.immutable }),
          },
          expectedVersion,
          ...withComment(comment),
        },
      )
      const findings =
        isDocument(result) && Array.isArray(result["findings"])
          ? (result["findings"] as LintFinding[])
          : []
      return { version: storedVersion(result), findings }
    },
    async publishContexts(lookups, expectedVersion, comment) {
      const result = await admin.post("/contexts/publish", {
        lookups,
        expectedVersion,
        ...withComment(comment),
      })
      return { version: storedVersion(result) }
    },
    async snapshot() {
      const published = await target.published()
      const definitions = new Map<string, CollectionPolicies>()
      for (const name of published.collections.keys()) {
        const definition = await target.definition(name)
        if (definition !== undefined) definitions.set(name, definition)
      }
      return {
        definitions,
        stored: published.collections,
        contexts: published.contexts,
      }
    },
    async version(collection) {
      const body = await admin.get(
        collection === CONTEXT_DOCUMENT_ID
          ? "/contexts"
          : `/policies/${encodeURIComponent(collection)}`,
      )
      return isDocument(body) ? versionOf(body["version"]) : 0
    },
    async history(collection, limit) {
      const query = limit === undefined ? "" : `?limit=${limit}`
      const body = await admin.get(
        collection === CONTEXT_DOCUMENT_ID
          ? `/contexts/history${query}`
          : `/policies/${encodeURIComponent(collection)}/history${query}`,
      )
      const data = isDocument(body) && Array.isArray(body["data"]) ? body["data"] : []
      return data.filter(isDocument).map((entry) => ({
        version: versionOf(entry["version"]),
        publishedAt: dateOf(entry["publishedAt"]),
        publishedBy: String(entry["publishedBy"] ?? ""),
        hash: String(entry["hash"] ?? ""),
        ...(typeof entry["comment"] === "string" ? { comment: entry["comment"] } : {}),
        ...(typeof entry["rollbackOf"] === "number" ? { rollbackOf: entry["rollbackOf"] } : {}),
      }))
    },
    async rollback(collection, version, expectedVersion, comment) {
      const result = await admin.post(
        collection === CONTEXT_DOCUMENT_ID
          ? "/contexts/rollback"
          : `/policies/${encodeURIComponent(collection)}/rollback`,
        { version, expectedVersion, ...withComment(comment) },
      )
      return storedVersion(result)
    },
  }
  return target
}

function dateOf(value: unknown): Date {
  if (value instanceof Date) return value
  const date = new Date(typeof value === "string" || typeof value === "number" ? value : Number.NaN)
  return Number.isNaN(date.getTime()) ? new Date(0) : date
}

/** Runs `body` against the remote admin API when one is given, else against the meta database. */
async function withTarget(
  options: MetaOptions & { readonly remote?: AdminClient },
  out: Output,
  body: (target: PolicyTarget) => Promise<number>,
): Promise<number> {
  const remote = options.remote
  if (remote === undefined)
    return withMeta(options, out, (client) => body(metaTarget(client, options.metaDatabase)))
  try {
    return await body(remoteTarget(remote))
  } catch (error: unknown) {
    out.error(error instanceof CanopyError ? error.message : `error  ${messageOf(error)}`)
    return 1
  }
}

async function loadLocal(dir: string, out: Output): Promise<PolicySet | undefined> {
  try {
    return await directoryPolicies(dir).load()
  } catch (error: unknown) {
    out.error(`Policies in ${dir} do not load: ${messageOf(error)}`)
    return undefined
  }
}

const sameContexts = (a: ContextDefinitions, b: ContextDefinitions): boolean =>
  hashPolicySet(new Map(), a) === hashPolicySet(new Map(), b)

function select<T>(names: readonly string[], all: ReadonlyMap<string, T>): string[] {
  return names.length === 0 ? [...all.keys()] : [...names]
}

/** What differs between a local and a stored definition, one line per difference. */
function describeChanges(local: CollectionPolicies, stored: CollectionPolicies): string[] {
  const lines: string[] = []
  const policyHash = (def: CollectionPolicies, name: string): string | undefined => {
    const policy = def.policies.find((p) => p.name === name)
    return policy === undefined
      ? undefined
      : hashCollection({ collection: "", exposed: false, realtime: false, policies: [policy] })
  }
  for (const key of ["exposed", "realtime"] as const)
    if (local[key] !== stored[key])
      lines.push(`${key}: ${String(local[key])} locally, ${String(stored[key])} in the database`)
  const names = new Set([...local.policies, ...stored.policies].map((policy) => policy.name))
  for (const name of names) {
    const mine = policyHash(local, name)
    const theirs = policyHash(stored, name)
    if (theirs === undefined) lines.push(`policy "${name}": only local`)
    else if (mine === undefined) lines.push(`policy "${name}": only in the database`)
    else if (mine !== theirs) lines.push(`policy "${name}": differs`)
  }
  const order = (def: CollectionPolicies): string => def.policies.map((p) => p.name).join("\n")
  if (lines.length === 0 && order(local) !== order(stored)) lines.push("policy order differs")
  const rest = (def: CollectionPolicies): string =>
    hashCollection({ ...def, exposed: false, realtime: false, policies: [] })
  if (rest(local) !== rest(stored)) lines.push("fields or immutable differ")
  return lines
}

/** Options of `canopy policies diff`. */
export interface DiffOptions extends MetaOptions {
  readonly dir: string
  readonly collections: readonly string[]
  /** Exit 1 when anything differs, for scheduled drift checks. */
  readonly failOnDrift: boolean
  /** Compare with a remote project through its admin API (`--env`) instead of the meta database. */
  readonly remote?: AdminClient
}

/**
 * `canopy policies diff`: compares the policy directory with the published policies, by content hash,
 * and explains each difference. With `failOnDrift` any difference fails, so a scheduled job catches
 * edits made in Studio that never reached Git.
 */
export async function policiesDiff(options: DiffOptions, out: Output): Promise<number> {
  const local = await loadLocal(options.dir, out)
  if (local === undefined) return 1
  return withTarget(options, out, async (target) => {
    const remote = await target.published()
    const names = new Set([
      ...select(options.collections, local.collections),
      ...(options.collections.length === 0 ? remote.collections.keys() : []),
    ])
    let drift = 0
    for (const name of [...names].sort()) {
      const mine = local.collections.get(name)
      const theirs = remote.collections.get(name)
      if (mine === undefined && theirs === undefined) {
        out.error(`${name}: no policies locally or in the database`)
        drift += 1
      } else if (theirs === undefined) {
        out.log(`only local     ${name}`)
        drift += 1
      } else if (mine === undefined) {
        out.log(`only database  ${name}  v${theirs.version}`)
        drift += 1
      } else if (hashCollection(mine) === theirs.hash) {
        out.log(`same           ${name}  v${theirs.version}`)
      } else {
        out.log(`changed        ${name}  v${theirs.version} in the database`)
        const theirDef = await target.definition(name)
        if (theirDef !== undefined)
          for (const line of describeChanges(mine, theirDef)) out.log(`                 ${line}`)
        drift += 1
      }
    }
    if (options.collections.length === 0 && !sameContexts(local.contexts, remote.contexts)) {
      out.log("changed        context lookups (_context)")
      drift += 1
    }
    out.log(
      drift === 0
        ? "No drift: the database matches the policy directory."
        : `${drift} ${drift === 1 ? "difference" : "differences"}`,
    )
    return options.failOnDrift && drift > 0 ? 1 : 0
  })
}

/**
 * Parses `--expect-version`: a bare number for a single collection, or `collection=version` pairs
 * separated by commas, where `_context=<n>` pins the context lookup document. Returns a message for
 * malformed input.
 */
export function parseExpectedVersions(
  text: string,
  collections: readonly string[],
): Map<string, number> | string {
  if (/^\d+$/.test(text)) {
    const [only] = collections
    if (collections.length !== 1 || only === undefined)
      return `A bare --expect-version applies to one collection, but ${collections.length} would be published (${collections.join(", ")}). Use collection=version pairs.`
    return new Map([[only, Number(text)]])
  }
  const out = new Map<string, number>()
  for (const part of text.split(",")) {
    const match = /^\s*([^=\s]+)\s*=\s*(\d+)\s*$/.exec(part)
    if (match === null)
      return `Cannot read --expect-version ${JSON.stringify(text)}: expected todos=3,notes=5`
    out.set(match[1] ?? "", Number(match[2]))
  }
  return out
}

/** Options of `canopy policies push`. */
export interface PushOptions extends MetaOptions {
  readonly dir: string
  readonly collections: readonly string[]
  /** `--expect-version`: a version, or `collection=version` pairs. */
  readonly expectVersion?: string
  readonly comment?: string
  readonly dryRun?: boolean
  /** Publish to a remote project through its admin API (`--env`) instead of the meta database. */
  readonly remote?: AdminClient
}

function conflictHint(error: unknown, out: Output): void {
  if (error instanceof CanopyError && error.code === ErrorCode.Conflict)
    out.error("Someone published in between: run canopy policies diff, then push again.")
}

/**
 * `canopy policies push`: publishes every collection of the policy directory whose content differs from
 * the published version. Each publish is validated and linted against the whole set, recorded in
 * `policy_history` and the audit log, and conditional on the expected version: from `--expect-version`
 * when given (every changed collection must then be listed; `_context=<n>` optionally pins the context
 * lookups too), otherwise the version read at the start. All expectations are checked before anything is
 * published. Prints the resulting versions.
 */
export async function policiesPush(options: PushOptions, out: Output): Promise<number> {
  const local = await loadLocal(options.dir, out)
  if (local === undefined) return 1
  for (const name of options.collections)
    if (!local.collections.has(name)) {
      out.error(`${name} has no policies in ${options.dir}`)
      return 1
    }
  const names = select(options.collections, local.collections).sort()
  const errors = lintPolicies(
    names.flatMap((name) => local.collections.get(name) ?? []),
    local.contexts,
  ).filter((finding) => finding.severity === "error")
  if (errors.length > 0) {
    for (const finding of errors)
      out.error(`error  ${finding.rule}  ${finding.collection}: ${finding.message}`)
    out.error("Not pushed: fix the lint errors first (canopy policies lint).")
    return 1
  }
  return withTarget(options, out, async (target) => {
    const remote = await target.published()
    const changed = names.filter((name) => {
      const def = local.collections.get(name)
      return def !== undefined && remote.collections.get(name)?.hash !== hashCollection(def)
    })
    const contextsChanged =
      options.collections.length === 0 && !sameContexts(local.contexts, remote.contexts)
    const contextVersion = remote.contextVersion
    let expected = new Map(
      changed.map((name) => [name, remote.collections.get(name)?.version ?? 0]),
    )
    if (options.expectVersion !== undefined) {
      const parsed = parseExpectedVersions(
        options.expectVersion,
        changed.length === 0 ? names : changed,
      )
      if (typeof parsed === "string") {
        out.error(parsed)
        return 1
      }
      const missing = changed.filter((name) => !parsed.has(name))
      if (missing.length > 0) {
        out.error(`--expect-version does not name ${missing.join(", ")}, which would be published`)
        return 1
      }
      const current = (name: string): number =>
        name === CONTEXT_DOCUMENT_ID ? contextVersion : (remote.collections.get(name)?.version ?? 0)
      const stale = [...parsed].filter(([name, version]) => current(name) !== version)
      if (stale.length > 0) {
        for (const [name, version] of stale)
          out.error(
            `${name} is at version ${current(name)} in the database, not ${version}. Someone published in between: run canopy policies diff, then push again.`,
          )
        return 1
      }
      expected = new Map(changed.map((name) => [name, parsed.get(name) ?? 0]))
    }
    const versions = new Map(
      names.map((name) => [name, remote.collections.get(name)?.version ?? 0]),
    )
    for (const name of names)
      if (!changed.includes(name)) out.log(`unchanged  ${name}  v${versions.get(name) ?? 0}`)
    if (!contextsChanged && options.collections.length === 0 && contextVersion > 0)
      out.log(`unchanged  _context  v${contextVersion}`)
    if (options.dryRun === true) {
      if (contextsChanged) out.log(`would publish  _context  v${contextVersion + 1}`)
      for (const name of changed)
        out.log(`would publish  ${name}  v${(expected.get(name) ?? 0) + 1}`)
      return 0
    }
    if (contextsChanged) {
      try {
        const result = await target.publishContexts(local.contexts, contextVersion, options.comment)
        out.log(`published  _context  v${result.version}`)
      } catch (error: unknown) {
        out.error(`_context: ${messageOf(error)}`)
        conflictHint(error, out)
        return 1
      }
    }
    for (const name of changed) {
      const definition = local.collections.get(name)
      if (definition === undefined) continue
      try {
        const result = await target.publish(definition, expected.get(name) ?? 0, options.comment)
        versions.set(name, result.version)
        out.log(`published  ${name}  v${result.version}`)
        for (const finding of result.findings.filter((f) => f.severity === "warn"))
          out.log(`  warn  ${finding.rule}: ${finding.message}`)
      } catch (error: unknown) {
        out.error(`${name}: ${messageOf(error)}`)
        conflictHint(error, out)
        return 1
      }
    }
    out.log(`versions: ${names.map((name) => `${name}=${versions.get(name) ?? 0}`).join(",")}`)
    return 0
  })
}

/** Options of `canopy policies pull`. */
export interface PullOptions extends MetaOptions {
  /** Where the modules are written. */
  readonly dir: string
  readonly collections: readonly string[]
  /** Replace existing files. */
  readonly force: boolean
  /** Pull from a remote project through its admin API (`--env`) instead of the meta database. */
  readonly remote?: AdminClient
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * `canopy policies pull`: writes the published policies into the policy directory as TypeScript DSL
 * modules (`<collection>.ts`, and `_context.ts` for context lookups), so changes made in Studio can be
 * committed. Existing files are replaced only with `force`. Afterwards the directory is loaded again and
 * every pulled collection must hash to its published version.
 */
export async function policiesPull(options: PullOptions, out: Output): Promise<number> {
  return withTarget(options, out, async (target) => {
    const remote = await target.snapshot()
    const names = select(options.collections, remote.definitions).sort()
    const files = new Map<string, string>()
    for (const name of names) {
      const def = remote.definitions.get(name)
      if (def === undefined) {
        out.error(`${name} has no published policies`)
        return 1
      }
      const file = join(resolve(options.dir), `${name.replaceAll(/[^A-Za-z0-9._-]/g, "_")}.ts`)
      try {
        files.set(file, collectionModule(def))
      } catch (error: unknown) {
        if (!(error instanceof UnwritableValueError)) throw error
        out.error(`${name}: ${error.message}; edit it in Studio or write the module by hand`)
        return 1
      }
    }
    if (options.collections.length === 0 && Object.keys(remote.contexts).length > 0)
      files.set(join(resolve(options.dir), "_context.ts"), contextModule(remote.contexts))
    const blocked: string[] = []
    for (const file of files.keys()) if (!options.force && (await exists(file))) blocked.push(file)
    if (blocked.length > 0) {
      out.error(`Not pulled: ${blocked.join(", ")} already exist. Pass --force to replace them.`)
      return 1
    }
    await mkdir(resolve(options.dir), { recursive: true })
    for (const [file, content] of files) {
      await writeFile(file, content)
      out.log(`wrote  ${file}`)
    }
    const reloaded = await loadLocal(options.dir, out)
    if (reloaded === undefined) return 1
    let mismatched = 0
    for (const name of names) {
      const def = reloaded.collections.get(name)
      const stored = remote.stored.get(name)
      if (def === undefined || stored === undefined || hashCollection(def) !== stored.hash) {
        out.error(`${name}: the pulled module does not reproduce version ${stored?.version ?? 0}`)
        mismatched += 1
      }
    }
    if (mismatched > 0) return 1
    out.log(
      `Pulled ${names.length} ${names.length === 1 ? "collection" : "collections"}: ${names.map((name) => `${name}=${remote.stored.get(name)?.version ?? 0}`).join(",")}`,
    )
    return 0
  })
}

/** Options of `canopy policies history`. */
export interface HistoryOptions extends MetaOptions {
  readonly collection: string
  readonly limit?: number
  /** Read the history of a remote project through its admin API (`--env`). */
  readonly remote?: AdminClient
}

/** `canopy policies history <collection>`: the published versions, newest first. */
export async function policiesHistory(options: HistoryOptions, out: Output): Promise<number> {
  return withTarget(options, out, async (target) => {
    const current = await target.version(options.collection)
    const entries = await target.history(options.collection, options.limit)
    if (entries.length === 0) {
      out.error(`${options.collection} has no published versions`)
      return 1
    }
    for (const entry of entries) {
      const notes = [
        entry.version === current ? "current" : undefined,
        entry.rollbackOf === undefined ? undefined : `rollback of v${entry.rollbackOf}`,
        entry.comment === undefined ? undefined : JSON.stringify(entry.comment),
      ].filter((note) => note !== undefined)
      out.log(
        `v${entry.version}  ${entry.publishedAt.toISOString()}  ${entry.publishedBy}  ${entry.hash.slice(0, 19)}${notes.length === 0 ? "" : `  ${notes.join("  ")}`}`,
      )
    }
    return 0
  })
}

/** Options of `canopy policies rollback`. */
export interface RollbackOptions extends MetaOptions {
  readonly collection: string
  readonly version: number
  readonly expectVersion?: number
  readonly comment?: string
  readonly yes: boolean
  /** Roll back on a remote project through its admin API (`--env`). */
  readonly remote?: AdminClient
}

/**
 * `canopy policies rollback <collection> <version>`: republishes an earlier version as a new one, after
 * confirmation. The rollback is itself versioned and audited.
 */
export async function policiesRollback(options: RollbackOptions, out: Output): Promise<number> {
  return withTarget(options, out, async (target) => {
    const current = await target.version(options.collection)
    const expected = options.expectVersion ?? current
    const question = `Republish ${options.collection} v${options.version} as v${current + 1}?`
    if (!(await confirmed(out, question, options.yes))) return 1
    const version = await target.rollback(
      options.collection,
      options.version,
      expected,
      options.comment,
    )
    out.log(`published  ${options.collection}  v${version}  (rollback of v${options.version})`)
    return 0
  })
}
