import { type CanopyClient, createClient } from "@canopy/client"
import { CanopyProvider, createReactDb, useCanopyStatus } from "@canopy/react"
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { createTicket, updateTicket } from "./api.ts"
import {
  type Collections,
  PRIORITIES,
  type Priority,
  type PublicConfig,
  type Session,
  STATUSES,
  type Status,
  type Ticket,
} from "./types.ts"

const STATUS_LABELS: Record<Status, string> = {
  open: "Open",
  in_progress: "In progress",
  closed: "Closed",
}

const CONNECTION_LABELS: Record<string, string> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  offline: "Offline",
  closed: "Closed",
}

function ago(date: Date, now: number): string {
  const seconds = Math.max(0, Math.round((now - date.getTime()) / 1000))
  if (seconds < 45) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return date.toLocaleDateString()
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

function ConnectionBadge(): ReactNode {
  const status = useCanopyStatus()
  return (
    <span className={`badge badge-${status}`} title="Connection to canopy-realtime">
      <span className="dot" />
      {CONNECTION_LABELS[status] ?? status}
    </span>
  )
}

function NewTicket({
  onCreate,
}: {
  readonly onCreate: (title: string, priority: Priority) => Promise<void>
}): ReactNode {
  const [title, setTitle] = useState("")
  const [priority, setPriority] = useState<Priority>("normal")
  const [busy, setBusy] = useState(false)
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (title.trim() === "") return
    setBusy(true)
    onCreate(title.trim(), priority)
      .then(() => setTitle(""))
      .catch(() => {})
      .finally(() => setBusy(false))
  }
  return (
    <form className="new-ticket" onSubmit={submit}>
      <input
        aria-label="Ticket title"
        placeholder="Describe the problem"
        value={title}
        maxLength={200}
        onChange={(event) => setTitle(event.target.value)}
      />
      <select
        aria-label="Priority"
        value={priority}
        onChange={(event) => setPriority(event.target.value as Priority)}
      >
        {PRIORITIES.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
      <button type="submit" disabled={busy || title.trim() === ""}>
        Open ticket
      </button>
    </form>
  )
}

function TicketRow({
  ticket,
  now,
  onChange,
}: {
  readonly ticket: Ticket
  readonly now: number
  readonly onChange: (change: { status?: Status; internalNotes?: string }) => Promise<void>
}): ReactNode {
  const support = ticket.internalNotes !== undefined
  const updated = ticket.updatedAt.getTime()
  const firstSeen = useRef(updated)
  return (
    <li className={`ticket status-${ticket.status}`}>
      {updated === firstSeen.current ? null : <span className="pulse" key={updated} />}
      <div className="ticket-main">
        <span className="title">{ticket.title}</span>
        <span className="meta">
          {ticket.ownerName} ·{" "}
          <span className={`priority priority-${ticket.priority}`}>{ticket.priority}</span>
          {" · "}
          updated {ago(ticket.updatedAt, now)}
        </span>
        {support ? (
          <input
            className="notes"
            aria-label="Internal notes"
            placeholder="Internal notes (support only)"
            defaultValue={ticket.internalNotes}
            onBlur={(event) => {
              if (event.target.value !== ticket.internalNotes) {
                onChange({ internalNotes: event.target.value }).catch(() => {})
              }
            }}
          />
        ) : null}
      </div>
      <select
        aria-label="Status"
        value={ticket.status}
        onChange={(event) => onChange({ status: event.target.value as Status }).catch(() => {})}
      >
        {STATUSES.map((value) => (
          <option key={value} value={value}>
            {STATUS_LABELS[value]}
          </option>
        ))}
      </select>
    </li>
  )
}

function Board({
  client,
  session,
}: {
  readonly client: CanopyClient
  readonly session: Session
}): ReactNode {
  const db = useMemo(() => createReactDb<Collections>(client), [client])
  const tickets = db.tickets.useQuery({}, { sort: { updatedAt: -1 }, limit: 100 })
  const [problem, setProblem] = useState<string>()
  const now = useNow(15_000)

  const report = async (action: Promise<void>): Promise<void> => {
    try {
      await action
      setProblem(undefined)
    } catch (error: unknown) {
      setProblem(error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  const counts = useMemo(() => {
    const result: Record<Status, number> = { open: 0, in_progress: 0, closed: 0 }
    for (const ticket of tickets.data) result[ticket.status] += 1
    return result
  }, [tickets.data])
  const urgent = tickets.data.filter(
    (ticket) => ticket.priority === "high" && ticket.status !== "closed",
  ).length

  return (
    <div className="page">
      <header>
        <div>
          <h1>Helpdesk</h1>
          <p className="subtitle">
            Writes go through the Express API. Every view updates live through Canopy.
          </p>
        </div>
        <div className="who">
          <ConnectionBadge />
          <span className="user">{session.label}</span>
          <button type="button" className="link" onClick={() => session.signOut()}>
            Switch user
          </button>
        </div>
      </header>

      <section className="stats" aria-label="Ticket counts">
        {STATUSES.map((status) => (
          <div key={status} className={`stat status-${status}`}>
            <span className="value">{counts[status]}</span>
            <span className="label">{STATUS_LABELS[status]}</span>
          </div>
        ))}
        <div className="stat urgent">
          <span className="value">{urgent}</span>
          <span className="label">High priority, not closed</span>
        </div>
      </section>

      <NewTicket onCreate={(title, priority) => report(createTicket(session, title, priority))} />
      {problem === undefined ? null : <p className="problem">{problem}</p>}

      {tickets.status === "error" ? (
        <p className="problem">The live query failed: {tickets.error?.message}</p>
      ) : tickets.status === "loading" ? (
        <p className="empty">Loading tickets…</p>
      ) : tickets.data.length === 0 ? (
        <p className="empty">
          No tickets yet. Open one above, or sign in as someone else in another window.
        </p>
      ) : (
        <ul className="tickets">
          {tickets.data.map((ticket) => (
            <TicketRow
              key={String(ticket._id)}
              ticket={ticket}
              now={now}
              onChange={(change) => report(updateTicket(session, String(ticket._id), change))}
            />
          ))}
        </ul>
      )}
      {tickets.status === "stale" ? (
        <p className="empty">Reconnecting, showing the last known state.</p>
      ) : null}
    </div>
  )
}

/** The live dashboard: one Canopy client per signed in user. */
export function Dashboard({
  config,
  session,
}: {
  readonly config: PublicConfig
  readonly session: Session
}): ReactNode {
  const [client, setClient] = useState<CanopyClient>()
  useEffect(() => {
    const next = createClient({
      url: config.canopyUrl,
      publishableKey: config.publishableKey,
      auth: { getToken: () => session.getToken() },
    })
    setClient(next)
    return () => next.close()
  }, [config, session])
  if (client === undefined) return null
  return (
    <CanopyProvider client={client}>
      <Board client={client} session={session} />
    </CanopyProvider>
  )
}
