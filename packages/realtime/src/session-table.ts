import type { SessionState } from "./realtime-types.ts"

/** The engine's live sessions by `sid`, with the number of sessions each subject holds. */
export class SessionTable {
  private readonly bySid = new Map<string, SessionState>()
  private readonly subjects = new Map<string, number>()

  /** The number of sessions, connected or waiting for a resume. */
  get size(): number {
    return this.bySid.size
  }

  /** The number of distinct subjects with a session. */
  get subjectCount(): number {
    return this.subjects.size
  }

  /** Every session, in the order they were opened. */
  values(): IterableIterator<SessionState> {
    return this.bySid.values()
  }

  /** The session with this `sid`, if it is still open. */
  get(sid: string): SessionState | undefined {
    return this.bySid.get(sid)
  }

  /** Whether the session's `sid` is still open. */
  has(state: SessionState): boolean {
    return this.bySid.has(state.session.sid)
  }

  /** The number of sessions `subject` holds. */
  countOf(subject: string): number {
    return this.subjects.get(subject) ?? 0
  }

  /** Records a new session and counts it against its subject. */
  add(state: SessionState): void {
    this.bySid.set(state.session.sid, state)
    this.subjects.set(state.principal.subject, this.countOf(state.principal.subject) + 1)
  }

  /** Forgets a session and releases its subject's count. */
  remove(state: SessionState): void {
    this.bySid.delete(state.session.sid)
    const count = (this.subjects.get(state.principal.subject) ?? 1) - 1
    if (count <= 0) this.subjects.delete(state.principal.subject)
    else this.subjects.set(state.principal.subject, count)
  }
}
