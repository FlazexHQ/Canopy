import { MongoClient } from "mongodb"
import { confirmed, messageOf, type Output } from "./output.ts"

/** Options of `canopy realtime enable-images` and `disable-images`. */
export interface ImagesOptions {
  readonly mongodbUri: string
  readonly database: string
  readonly collections: readonly string[]
  readonly enable: boolean
  /** Apply without asking. */
  readonly yes?: boolean
}

/** The `collMod` command that turns pre and post images on or off for one collection. */
function imagesCommand(
  collection: string,
  enable: boolean,
): { collMod: string; changeStreamPreAndPostImages: { enabled: boolean } } {
  return { collMod: collection, changeStreamPreAndPostImages: { enabled: enable } }
}

/**
 * `canopy realtime enable-images | disable-images`: prints the exact `collMod` for each collection whose
 * setting would change, asks for confirmation (or takes `--yes`), then runs it. Collections that do not
 * exist are refused rather than created, and collections already in the requested state are skipped.
 */
export async function realtimeImages(options: ImagesOptions, out: Output): Promise<number> {
  if (options.collections.length === 0) {
    out.error(
      `Name the collections: canopy realtime ${options.enable ? "enable" : "disable"}-images <collection...>`,
    )
    return 1
  }
  const client = new MongoClient(options.mongodbUri, { serverSelectionTimeoutMS: 10_000 })
  try {
    await client.connect()
    const db = client.db(options.database)
    const infos = new Map(
      (await db.listCollections({ name: { $in: [...options.collections] } }).toArray()).map(
        (info) => [info.name, info],
      ),
    )
    const missing = options.collections.filter((name) => !infos.has(name))
    if (missing.length > 0) {
      out.error(
        `${missing.join(", ")} ${missing.length === 1 ? "does" : "do"} not exist in ${options.database}. Canopy never creates collections in the app database.`,
      )
      return 1
    }
    const pending = options.collections.filter((name) => {
      const info = infos.get(name) as { options?: Record<string, unknown> } | undefined
      const current = info?.options?.["changeStreamPreAndPostImages"] as
        | { enabled?: boolean }
        | undefined
      const enabled = current?.enabled === true
      if (enabled === options.enable)
        out.log(`${name}: pre and post images are already ${enabled ? "on" : "off"}`)
      return enabled !== options.enable
    })
    if (pending.length === 0) return 0
    out.log(`Will run on ${options.database}:`)
    for (const name of pending)
      out.log(`  db.runCommand(${JSON.stringify(imagesCommand(name, options.enable))})`)
    if (options.enable) {
      out.log(
        "Pre images are kept in config.system.preimages until the oplog rolls past them. Bound their size with",
      )
      out.log(
        "  db.adminCommand({ setClusterParameter: { changeStreamOptions: { preAndPostImages: { expireAfterSeconds: 3600 } } } })",
      )
    }
    const question = `${options.enable ? "Enable" : "Disable"} pre and post images on ${pending.length} ${pending.length === 1 ? "collection" : "collections"}?`
    if (!(await confirmed(out, question, options.yes === true))) return 1
    for (const name of pending) {
      try {
        await db.command(imagesCommand(name, options.enable))
        out.log(`${name}: pre and post images ${options.enable ? "on" : "off"}`)
      } catch (error: unknown) {
        out.error(`${name}: collMod failed: ${messageOf(error)}`)
        return 1
      }
    }
    return 0
  } catch (error: unknown) {
    out.error(`Cannot reach MongoDB: ${messageOf(error)}`)
    return 1
  } finally {
    await client.close()
  }
}
