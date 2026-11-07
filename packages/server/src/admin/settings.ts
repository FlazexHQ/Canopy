import type { Collection, Db } from "mongodb"
import type { Actor, AuditLog, RequestOrigin } from "../audit.ts"
import { integer, nullable, object, optional } from "../schema.ts"

/** Settings changed at runtime through the admin API, stored in `canopy.settings`. */
export interface Settings {
  /** How many days audit entries are kept; `null` keeps them forever. */
  readonly auditRetentionDays: number | null
}

/** The defaults of {@link Settings}. */
export const DEFAULT_SETTINGS: Settings = { auditRetentionDays: null }

/** The body of `PATCH /admin/v1/settings`. */
export const settingsPatch = object({
  auditRetentionDays: optional(nullable(integer({ min: 1, max: 36_500 }))),
})

interface SettingsDocument {
  _id: string
  auditRetentionDays?: number | null
  updatedAt?: Date
  updatedBy?: string
}

/** Reads and changes {@link Settings}, applying each change (such as the audit TTL) as it is saved. */
export class SettingsStore {
  private readonly collection: Collection<SettingsDocument>
  private readonly audit: AuditLog

  constructor(meta: Db, audit: AuditLog) {
    this.collection = meta.collection<SettingsDocument>("settings")
    this.audit = audit
  }

  async get(): Promise<Settings> {
    const doc = await this.collection.findOne({ _id: "settings" })
    return { auditRetentionDays: doc?.auditRetentionDays ?? DEFAULT_SETTINGS.auditRetentionDays }
  }

  async update(patch: Partial<Settings>, actor: Actor, origin: RequestOrigin): Promise<Settings> {
    const before = await this.get()
    const after: Settings = { ...before, ...patch }
    if (patch.auditRetentionDays !== undefined)
      await this.audit.setRetention(patch.auditRetentionDays)
    await this.collection.updateOne(
      { _id: "settings" },
      { $set: { ...after, updatedAt: new Date(), updatedBy: actor.id } },
      { upsert: true },
    )
    await this.audit.record({ action: "settings.update", actor, diff: { before, after }, origin })
    return after
  }
}
