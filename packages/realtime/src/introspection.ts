import type { ClusterTime } from "@canopy/protocol"
import type { Observer, ObserverType } from "./observers.ts"
import type { ConnectionInfo, ObserverInfo, RealtimeStats, SessionState } from "./realtime-types.ts"
import type { SessionTable } from "./session-table.ts"

/** Engine wide counts over the live sessions and observers. */
export function statsOf(
  sessions: SessionTable,
  observers: Iterable<Observer>,
  engine: {
    readonly policyVersion: string
    readonly streamPosition: ClusterTime
    readonly collections: readonly string[]
  },
): RealtimeStats {
  const types: Record<ObserverType, number> = { filter: 0, window: 0, polling: 0 }
  for (const observer of observers) types[observer.type] += 1
  let connections = 0
  let subscriptions = 0
  for (const state of sessions.values()) {
    if (state.socket !== undefined) connections += 1
    subscriptions += state.subs.size
  }
  return {
    connections,
    sessions: sessions.size,
    subscriptions,
    observers: types,
    subjects: sessions.subjectCount,
    policyVersion: engine.policyVersion,
    streamPosition: engine.streamPosition,
    collections: [...engine.collections],
  }
}

/** What the admin API shows of each session, connected or waiting for a resume. */
export function connectionInfos(sessions: Iterable<SessionState>): ConnectionInfo[] {
  return [...sessions].map((state) => ({
    sid: state.session.sid,
    subject: state.principal.subject,
    roles: [...state.principal.context.roles].sort(),
    keyId: state.principal.keyId,
    connected: state.socket !== undefined,
    openedAt: state.openedAt,
    tokenExpiresAt:
      state.principal.expiresAt === undefined ? undefined : new Date(state.principal.expiresAt),
    subscriptions: [...state.subs.values()].map((sub) => ({
      id: sub.id,
      coll: sub.coll,
      observer: sub.observer.key,
    })),
    documents: state.session.documents,
    queuedBytes: state.session.queuedBytes,
    lastSeq: state.session.lastSeq,
  }))
}

/** What the admin API shows of each shared observer. */
export function observerInfos(observers: Iterable<Observer>): ObserverInfo[] {
  return [...observers].map((observer) => ({
    key: observer.key,
    coll: observer.query.coll,
    type: observer.type,
    status: observer.status,
    subscribers: observer.size,
    filter: observer.query.filter,
    sort: observer.query.sort,
    limit: observer.query.limit,
    clusterTime: observer.clusterTime,
  }))
}
