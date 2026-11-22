import type { Document, ObjectId } from "canopy.js"

/** Ticket states, in workflow order. */
export const STATUSES = ["open", "in_progress", "closed"] as const
export type Status = (typeof STATUSES)[number]

/** Ticket priorities, lowest first. */
export const PRIORITIES = ["low", "normal", "high"] as const
export type Priority = (typeof PRIORITIES)[number]

/** A ticket as the live query delivers it. `internalNotes` arrives only for support agents. */
export interface Ticket extends Document {
  readonly _id: ObjectId
  readonly title: string
  readonly ownerId: string
  readonly ownerName: string
  readonly priority: Priority
  readonly status: Status
  readonly internalNotes?: string
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** The collections the dashboard reads. */
export type Collections = {
  readonly tickets: Ticket
}

/** What `/config.json` returns. */
export interface PublicConfig {
  readonly canopyUrl: string
  readonly publishableKey: string
  readonly auth:
    | {
        readonly kind: "dev"
        readonly users: readonly { readonly id: string; readonly name: string }[]
      }
    | {
        readonly kind: "auth0"
        readonly domain: string
        readonly clientId: string
        readonly audience: string
      }
}

/** A signed in user, however the token was obtained. */
export interface Session {
  readonly label: string
  getToken(): Promise<string>
  signOut(): void
}
