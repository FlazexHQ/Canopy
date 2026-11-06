import { type Connection, type InferSchemaType, type Model, Schema } from 'mongoose'

/** Ticket states, in workflow order. */
export const STATUSES = ['open', 'in_progress', 'closed'] as const

/** Ticket priorities, lowest first. */
export const PRIORITIES = ['low', 'normal', 'high'] as const

const ticketSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, minlength: 1, maxlength: 200 },
    ownerId: { type: String, required: true },
    ownerName: { type: String, required: true },
    priority: { type: String, enum: PRIORITIES, default: 'normal' },
    status: { type: String, enum: STATUSES, default: 'open' },
    internalNotes: { type: String, default: '', maxlength: 2000 },
  },
  { timestamps: true },
)
ticketSchema.index({ updatedAt: -1 })
ticketSchema.index({ ownerId: 1, updatedAt: -1 })

/** A helpdesk ticket as stored in the `tickets` collection. */
export type Ticket = InferSchemaType<typeof ticketSchema>

/** Registers the ticket model on a connection. */
export function ticketModel(connection: Connection): Model<Ticket> {
  return connection.model<Ticket>('Ticket', ticketSchema)
}
