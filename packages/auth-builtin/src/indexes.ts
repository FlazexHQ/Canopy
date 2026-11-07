import type { Db, IndexDescription } from "mongodb"
import { AUTH_COLLECTIONS } from "./engine.ts"

/**
 * The indexes of `canopy_auth`. Better Auth's MongoDB adapter creates none, so without them nothing stops two
 * concurrent sign ups from creating two users with one email, and every session lookup scans the collection.
 */
export const AUTH_INDEXES: Readonly<Record<string, readonly IndexDescription[]>> = {
  [AUTH_COLLECTIONS.users]: [{ key: { email: 1 }, name: "email", unique: true }],
  [AUTH_COLLECTIONS.sessions]: [
    { key: { token: 1 }, name: "token", unique: true },
    { key: { userId: 1 }, name: "user" },
    { key: { expiresAt: 1 }, name: "ttl_expires", expireAfterSeconds: 0 },
  ],
  [AUTH_COLLECTIONS.accounts]: [
    { key: { providerId: 1, accountId: 1 }, name: "provider_account", unique: true },
    { key: { userId: 1 }, name: "user" },
  ],
  [AUTH_COLLECTIONS.verifications]: [
    { key: { identifier: 1 }, name: "identifier" },
    { key: { expiresAt: 1 }, name: "ttl_expires", expireAfterSeconds: 3600 },
  ],
  [AUTH_COLLECTIONS.rateLimits]: [{ key: { key: 1 }, name: "key", unique: true }],
  [AUTH_COLLECTIONS.signingKeys]: [{ key: { createdAt: -1 }, name: "created" }],
  [AUTH_COLLECTIONS.identifierLimits]: [
    { key: { expiresAt: 1 }, name: "ttl_expires", expireAfterSeconds: 0 },
  ],
}

/** Creates the `canopy_auth` collections and indexes. Safe to run on every start and on several nodes. */
export async function ensureAuthIndexes(db: Db): Promise<void> {
  const existing = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name),
  )
  for (const [name, indexes] of Object.entries(AUTH_INDEXES)) {
    if (!existing.has(name)) {
      try {
        await db.createCollection(name)
      } catch (error: unknown) {
        if (!(error instanceof Error && "code" in error && error.code === 48)) throw error
      }
    }
    if (indexes.length > 0) await db.collection(name).createIndexes([...indexes])
  }
}
