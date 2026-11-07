import type { JWTPayload } from "jose"
import type { Revocation } from "./provider.ts"

/**
 * The revocations still in force, kept in memory so every request can be checked without a database read.
 * Entries are dropped once they expire, since by then every token they cover has expired too.
 */
export class RevocationSet {
  private readonly sessions = new Map<string, number>()
  private readonly users = new Map<string, { at: number; expiresAt: number }>()
  private everyone: { at: number; expiresAt: number } | undefined
  private readonly now: () => number

  constructor(options: { readonly now?: () => number } = {}) {
    this.now = options.now ?? Date.now
  }

  /** Adds a revocation. Expired ones are ignored. */
  add(revocation: Revocation): void {
    const expiresAt = revocation.expiresAt.getTime()
    if (expiresAt <= this.now()) return
    if (revocation.kind === "session") {
      if (revocation.sid === undefined) return
      const current = this.sessions.get(revocation.sid) ?? 0
      this.sessions.set(revocation.sid, Math.max(current, expiresAt))
      return
    }
    const at = revocation.at.getTime()
    if (revocation.kind === "all") {
      this.everyone = {
        at: Math.max(this.everyone?.at ?? 0, at),
        expiresAt: Math.max(this.everyone?.expiresAt ?? 0, expiresAt),
      }
      return
    }
    const current = this.users.get(revocation.sub)
    this.users.set(revocation.sub, {
      at: Math.max(current?.at ?? 0, at),
      expiresAt: Math.max(current?.expiresAt ?? 0, expiresAt),
    })
  }

  /** Whether a verified token is covered by a revocation. */
  has(claims: JWTPayload): boolean {
    const now = this.now()
    const sid = (claims as { sid?: unknown }).sid
    if (typeof sid === "string") {
      const until = this.sessions.get(sid)
      if (until !== undefined && until > now) return true
    }
    const issuedBefore = (entry: { at: number; expiresAt: number } | undefined): boolean =>
      entry !== undefined &&
      entry.expiresAt > now &&
      (typeof claims.iat !== "number" || claims.iat * 1000 <= entry.at)
    if (issuedBefore(this.everyone)) return true
    return typeof claims.sub === "string" && issuedBefore(this.users.get(claims.sub))
  }

  /** Drops expired entries. */
  prune(): void {
    const now = this.now()
    for (const [sid, until] of this.sessions) if (until <= now) this.sessions.delete(sid)
    for (const [sub, entry] of this.users) if (entry.expiresAt <= now) this.users.delete(sub)
    if (this.everyone !== undefined && this.everyone.expiresAt <= now) this.everyone = undefined
  }

  get size(): number {
    return this.sessions.size + this.users.size + (this.everyone === undefined ? 0 : 1)
  }
}
