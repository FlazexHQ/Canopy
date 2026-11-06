import type { Priority, Session, Status } from './types.ts'

async function call(session: Session, method: string, path: string, body: unknown): Promise<void> {
  const response = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${await session.getToken()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(detail.error ?? `${method} ${path} failed with ${response.status}`)
  }
}

/** Creates a ticket through the app's own REST API. The dashboard sees it through the live query. */
export function createTicket(session: Session, title: string, priority: Priority): Promise<void> {
  return call(session, 'POST', '/api/tickets', { title, priority })
}

/** Changes a ticket through the app's own REST API. */
export function updateTicket(
  session: Session,
  id: string,
  change: {
    readonly status?: Status
    readonly priority?: Priority
    readonly internalNotes?: string
  },
): Promise<void> {
  return call(session, 'PATCH', `/api/tickets/${encodeURIComponent(id)}`, change)
}
