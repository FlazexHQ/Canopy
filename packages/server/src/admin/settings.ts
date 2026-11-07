import { isAddressRule } from "@canopy/auth"
import { ValidationError } from "@canopy/protocol"
import type { Collection, Db } from "mongodb"
import type { Actor, AuditLog, RequestOrigin } from "../audit.ts"
import type { RequestLog } from "../request-log.ts"
import { array, integer, nullable, number, object, optional, string } from "../schema.ts"

/** Settings changed at runtime through the admin API, stored in `canopy.settings`. */
export interface Settings {
  /** How many days audit entries are kept; `null` keeps them forever. */
  readonly auditRetentionDays: number | null
  /**
   * The share of requests written to the request log, from 0 (off) to 1 (all). Server errors (5xx) are
   * kept whenever it is above 0.
   */
  readonly requestLogSampleRate: number
  /** How many days request log entries are kept. */
  readonly requestLogRetentionDays: number
  /**
   * Addresses and CIDR ranges (IPv4 or IPv6) that may reach `/admin` and `/studio` on either listener.
   * Empty allows every address.
   */
  readonly adminAllowlist: readonly string[]
}

/** The defaults of {@link Settings}. */
export const DEFAULT_SETTINGS: Settings = {
  auditRetentionDays: null,
  requestLogSampleRate: 0.01,
  requestLogRetentionDays: 7,
  adminAllowlist: [],
}

/** The body of `PATCH /admin/v1/settings`. */
export const settingsPatch = object({
  auditRetentionDays: optional(nullable(integer({ min: 1, max: 36_500 }))),
  requestLogSampleRate: optional(number({ min: 0, max: 1 })),
  requestLogRetentionDays: optional(integer({ min: 1, max: 90 })),
  adminAllowlist: optional(array(string({ min: 1, max: 64 }), { max: 256 })),
})

interface SettingsDocument {
  _id: string
  auditRetentionDays?: number | null
  requestLogSampleRate?: number
  requestLogRetentionDays?: number
  adminAllowlist?: string[]
  updatedAt?: Date
  updatedBy?: string
}

function fromDocument(doc: SettingsDocument | null): Settings {
  return {
    auditRetentionDays: doc?.auditRetentionDays ?? DEFAULT_SETTINGS.auditRetentionDays,
    requestLogSampleRate: doc?.requestLogSampleRate ?? DEFAULT_SETTINGS.requestLogSampleRate,
    requestLogRetentionDays:
      doc?.requestLogRetentionDays ?? DEFAULT_SETTINGS.requestLogRetentionDays,
    adminAllowlist: doc?.adminAllowlist ?? DEFAULT_SETTINGS.adminAllowlist,
  }
}

/**
 * Reads and changes {@link Settings}, applying each change (the audit and request log TTLs, sampling) as it
 * is saved. {@link current} is an in memory snapshot for checks on every request; other nodes pick up a
 * change at their next {@link refresh}.
 */
export class SettingsStore {
  private readonly collection: Collection<SettingsDocument>
  private readonly audit: AuditLog
  private readonly requestLog: RequestLog | undefined
  private snapshot: Settings = DEFAULT_SETTINGS

  constructor(meta: Db, audit: AuditLog, options: { readonly requestLog?: RequestLog } = {}) {
    this.collection = meta.collection<SettingsDocument>("settings")
    this.audit = audit
    this.requestLog = options.requestLog
  }

  /** The settings as last read or saved by this node. */
  get current(): Settings {
    return this.snapshot
  }

  async get(): Promise<Settings> {
    return fromDocument(await this.collection.findOne({ _id: "settings" }))
  }

  /** Reads the stored settings into {@link current} and applies the request log sampling. */
  async refresh(): Promise<Settings> {
    const settings = await this.get()
    this.apply(settings)
    return settings
  }

  private apply(settings: Settings): void {
    this.snapshot = settings
    this.requestLog?.configure({
      sampleRate: settings.requestLogSampleRate,
      retentionDays: settings.requestLogRetentionDays,
    })
  }

  async update(patch: Partial<Settings>, actor: Actor, origin: RequestOrigin): Promise<Settings> {
    const invalid = (patch.adminAllowlist ?? []).filter((rule) => !isAddressRule(rule))
    if (invalid.length > 0)
      throw new ValidationError(
        `adminAllowlist has entries that are not addresses or CIDR ranges: ${invalid.join(", ")}`,
        { details: { path: "adminAllowlist" } },
      )
    const before = await this.get()
    const after: Settings = { ...before, ...patch }
    if (patch.auditRetentionDays !== undefined)
      await this.audit.setRetention(patch.auditRetentionDays)
    if (patch.requestLogRetentionDays !== undefined)
      await this.requestLog?.setRetention(patch.requestLogRetentionDays)
    await this.collection.updateOne(
      { _id: "settings" },
      {
        $set: {
          ...after,
          adminAllowlist: [...after.adminAllowlist],
          updatedAt: new Date(),
          updatedBy: actor.id,
        },
      },
      { upsert: true },
    )
    this.apply(after)
    await this.audit.record({ action: "settings.update", actor, diff: { before, after }, origin })
    return after
  }
}
