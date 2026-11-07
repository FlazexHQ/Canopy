import { type Collection, MongoServerError } from "mongodb"

/** A lease document: one owner at a time until `expiresAt`. */
export interface LeaseDocument {
  _id: string
  owner: string
  expiresAt: Date
}

/**
 * Takes or renews the lease `name` for `owner`. Returns false while another owner holds an unexpired lease.
 * Used so only one node runs a job such as key rotation.
 */
export async function acquireLease(
  leases: Collection<LeaseDocument>,
  name: string,
  owner: string,
  ttlMs: number,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    await leases.updateOne(
      { _id: name, $or: [{ owner }, { expiresAt: { $lte: now } }] },
      { $set: { owner, expiresAt: new Date(now.getTime() + ttlMs) } },
      { upsert: true },
    )
    return true
  } catch (error: unknown) {
    if (error instanceof MongoServerError && error.code === 11000) return false
    throw error
  }
}

/** Gives the lease up if `owner` holds it. */
export async function releaseLease(
  leases: Collection<LeaseDocument>,
  name: string,
  owner: string,
): Promise<void> {
  await leases.deleteOne({ _id: name, owner })
}
