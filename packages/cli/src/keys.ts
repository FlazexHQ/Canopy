import { ApiKeys, AuditLog, migrateMeta, migrationStatus } from "@canopy/server"
import { confirmed, type Output } from "./output.ts"
import { cliActor, type MetaOptions, withMeta } from "./policies.ts"

/** Options of `canopy keys create`. */
export interface KeyCreateOptions extends MetaOptions {
  readonly kind: "publishable" | "secret"
  readonly name: string
}

const date = (value: Date | undefined): string =>
  value === undefined ? "never" : value.toISOString()

/** `canopy keys list`: the API keys in the meta database, newest first. Secret keys show their prefix only. */
export async function keysList(options: MetaOptions, out: Output): Promise<number> {
  return withMeta(options, out, async (client) => {
    const keys = await new ApiKeys(client.db(options.metaDatabase)).list()
    if (keys.length === 0) {
      out.log("No API keys. Create one with canopy keys create --kind publishable --name web")
      return 0
    }
    for (const key of keys) {
      const state = key.revokedAt === undefined ? "active" : `revoked ${date(key.revokedAt)}`
      out.log(
        `${key.id}  ${key.kind.padEnd(11)}  ${(key.key ?? `${key.prefix}...`).padEnd(24)}  ${JSON.stringify(key.name)}  created ${date(key.createdAt)} by ${key.createdBy}  last used ${date(key.lastUsedAt)}  ${state}`,
      )
    }
    return 0
  })
}

/**
 * `canopy keys create`: creates a key and prints it. A secret key is shown this one time only; the meta
 * database keeps just its hash. The creation is audited.
 */
export async function keysCreate(options: KeyCreateOptions, out: Output): Promise<number> {
  return withMeta(options, out, async (client) => {
    const meta = client.db(options.metaDatabase)
    const actor = cliActor()
    const { key, info } = await new ApiKeys(meta).create({
      kind: options.kind,
      name: options.name,
      createdBy: actor.id,
    })
    await new AuditLog(meta).record({
      action: "key.create",
      actor,
      target: { keyId: info.id, kind: info.kind, name: info.name },
    })
    out.log(`${info.id}  ${info.kind}  ${JSON.stringify(info.name)}`)
    out.log(key)
    if (options.kind === "secret")
      out.log(
        "This is the only time the secret key is shown. Store it in your server's secrets; it bypasses every policy.",
      )
    return 0
  })
}

/** Options of `canopy keys revoke`. */
export interface KeyRevokeOptions extends MetaOptions {
  readonly id: string
  readonly yes: boolean
}

/** `canopy keys revoke <id>`: revokes a key for good after confirmation; open connections using it close. */
export async function keysRevoke(options: KeyRevokeOptions, out: Output): Promise<number> {
  return withMeta(options, out, async (client) => {
    const meta = client.db(options.metaDatabase)
    const keys = new ApiKeys(meta)
    const current = await keys.get(options.id)
    if (current === undefined) {
      out.error(`No API key ${options.id}. List them with canopy keys list.`)
      return 1
    }
    if (current.revokedAt !== undefined) {
      out.log(`${options.id} was already revoked on ${current.revokedAt.toISOString()}`)
      return 0
    }
    const question = `Revoke the ${current.kind} key ${JSON.stringify(current.name)} (${options.id})? Apps using it stop working.`
    if (!(await confirmed(out, question, options.yes))) return 1
    const actor = cliActor()
    const revoked = await keys.revoke(options.id, actor.id)
    await new AuditLog(meta).record({
      action: "key.revoke",
      actor,
      target: { keyId: revoked.id, kind: revoked.kind, name: revoked.name },
    })
    out.log(`revoked  ${revoked.id}`)
    return 0
  })
}

/** Options of `canopy migrate`. */
export interface MigrateCommandOptions extends MetaOptions {
  /** Only list the migrations and whether each ran. */
  readonly status: boolean
}

/**
 * `canopy migrate`: brings the meta database up to date (the server also does this on start), or with
 * `status` lists each migration and when it ran.
 */
export async function migrate(options: MigrateCommandOptions, out: Output): Promise<number> {
  return withMeta(
    options,
    out,
    async (client) => {
      const meta = client.db(options.metaDatabase)
      if (options.status) {
        for (const status of await migrationStatus(meta))
          out.log(
            `${String(status.version).padStart(4)}  ${status.name}  ${status.appliedAt === undefined ? "pending" : `applied ${status.appliedAt.toISOString()}`}`,
          )
        return 0
      }
      const result = await migrateMeta(meta)
      out.log(
        result.applied.length === 0
          ? `${options.metaDatabase} is up to date (version ${result.version})`
          : `Applied ${result.applied.join(", ")}; ${options.metaDatabase} is at version ${result.version}`,
      )
      return 0
    },
    false,
  )
}
