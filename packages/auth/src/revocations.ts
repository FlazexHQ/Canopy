import type { JWTPayload } from "jose"
import type { Revocation } from "./provider.ts"

/**
 * The revocations still in force, kept in memory so every request can be checked without a database read.
 * Entries are dropped once they expire, since by then every token they cover has expired too.
 */
export class RevocationSet {
  private readonly sessions = new Map<string, number>()
  private readonly users = new Map<string, { at: number; expiresAt: number }>()
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
    if (typeof claims.sub === "string") {
      const user = this.users.get(claims.sub)
      if (user !== undefined && user.expiresAt > now) {
        if (typeof claims.iat !== "number" || claims.iat * 1000 <= user.at) return true
      }
    }
    return false
  }

  /** Drops expired entries. */
  prune(): void {
    const now = this.now()
    for (const [sid, until] of this.sessions) if (until <= now) this.sessions.delete(sid)
    for (const [sub, entry] of this.users) if (entry.expiresAt <= now) this.users.delete(sub)
  }

  get size(): number {
    return this.sessions.size + this.users.size
  }
}
