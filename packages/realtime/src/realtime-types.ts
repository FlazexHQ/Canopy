import type { Authenticator, JwtAuthOptions, KeyOptions, Principal, RateLimits } from "@canopy/auth"
import type { EngineKind } from "@canopy/native"
import type { ContextResolver, PolicySet } from "@canopy/policy"
import type { ClusterTime, SubMessage } from "@canopy/protocol"
import type { MongoClient } from "mongodb"
import type { NormalizedEvent } from "./event.ts"
import type { CheckpointStore, FullDocumentMode } from "./ingestor.ts"
import type { Logger } from "./logger.ts"
import type { MutationExecutor } from "./mutations.ts"
import type { Observer, ObserverType } from "./observers.ts"
import type { PolicySource } from "./policy-source.ts"
import type { RealtimeSocket, Session } from "./session.ts"

/** The longest delay timers keep (2147483647 ms, about 24.8 days); longer ones fire after 1 ms instead. */
export const MAX_TIMER_MS = 2_147_483_647

/** Per connection and per node limits. All are configurable. */
export interface RealtimeLimits {
  readonly maxSubscriptionsPerConnection: number
  readonly maxConnectionsPerSubject: number
  readonly maxTrackedDocs: number
  readonly maxWindow: number
  readonly maxFrameBytes: number
  readonly resumeBufferBytes: number
  readonly softQueueBytes: number
  readonly hardQueueBytes: number
  readonly snapshotConcurrency: number
  /** Mutations a connection may have queued or running before further ones are refused. */
  readonly maxPendingMutations: number
}

/** The default limits. */
export const DEFAULT_REALTIME_LIMITS: RealtimeLimits = {
  maxSubscriptionsPerConnection: 100,
  maxConnectionsPerSubject: 20,
  maxTrackedDocs: 10_000,
  maxWindow: 1000,
  maxFrameBytes: 256 * 1024,
  resumeBufferBytes: 2 * 1024 * 1024,
  softQueueBytes: 4 * 1024 * 1024,
  hardQueueBytes: 16 * 1024 * 1024,
  snapshotConcurrency: 32,
  maxPendingMutations: 64,
}

/** Where policies come from. */
export type PolicyOption =
  | { readonly dir: string; readonly watch?: boolean }
  | { readonly source: "database"; readonly watch?: boolean }
  | { readonly set: PolicySet }
  | PolicySource

/** Options for {@link createRealtime}. */
export interface RealtimeOptions {
  /** A connected or connectable client. Its pool is shared with the application. */
  readonly mongo: MongoClient
  /** The app database to watch. */
  readonly database: string
  /** Canopy's own database. Defaults to `canopy`. */
  readonly metaDatabase?: string
  readonly auth?: JwtAuthOptions
  readonly keys?: KeyOptions
  readonly policies: PolicyOption
  readonly fullDocument?: FullDocumentMode
  /** Where the stream position is kept. `meta` uses `canopy.checkpoints`; `off` starts from now. */
  readonly checkpoints?: "meta" | "off" | CheckpointStore
  readonly limits?: Partial<RealtimeLimits>
  readonly logger?: Logger
  /** Prefix of session IDs, for routing to the right node. */
  readonly nodeId?: string
  readonly heartbeatMs?: number
  readonly resumeWindowMs?: number
  readonly observerLingerMs?: number
  /** Interval for re-snapshotting subscriptions whose policy uses `$now`. Defaults to 60 s. */
  readonly timePolicyRefreshMs?: number
  /** Grace period after a token expires, for the client to send `auth`. Defaults to 30 s. */
  readonly expiryGraceMs?: number
  /**
   * Runs `mut` frames, usually the `WritePath` of `@canopy/rest`. Without it, mutations over the socket
   * are refused with `CANOPY_UNAVAILABLE`.
   */
  readonly mutations?: MutationExecutor
  /** How long an `ack` waits for its echo before it is sent with post images instead. Defaults to 2 s. */
  readonly echoTimeoutMs?: number
  /**
   * Resolves context lookups (`$ctx`). Pass a shared resolver so the REST handler sees the same cache and
   * its invalidations. Defaults to one that reads the app database with a 1 s timeout.
   */
  readonly contexts?: ContextResolver
  /** How long to wait before retrying a context lookup that failed with an error or a timeout. Defaults to 5 s. */
  readonly contextRetryMs?: number
  /**
   * Verifies `hello` credentials. Pass the server's authenticator to share its key store; otherwise one is
   * built from `auth` and `keys`.
   */
  readonly authenticator?: Authenticator
  /**
   * Limits the frames that start work (`sub`, `mut` and `auth`) per caller, and the open connections of
   * anonymous callers per client address. A frame over the budget is answered with `CANOPY_RATE_LIMITED`
   * in the frame's own reply (`nosub`, a failed `ack` or `err`) and the connection stays open; a
   * connection over the address cap is closed with `4029`. Callers with the `service` role are exempt
   * unless the limits say otherwise. Counted in memory, so each instance limits on its own.
   */
  readonly rateLimits?: RateLimits
  /** How many recent event traces {@link Realtime.trace} keeps. Defaults to 0 (tracing off). */
  readonly traceCapacity?: number
  /**
   * Wraps work in a span of the host's tracer (OpenTelemetry in `@canopy/server`): each batch of change
   * events fanned out (`canopy.realtime.fanout`) and each policy set loaded (`canopy.policy.load`).
   */
  readonly span?: <T>(
    name: string,
    attributes: Readonly<Record<string, string | number | boolean>>,
    run: () => T,
  ) => T
  /**
   * Logs a debug line the first time a policy drops out because of a variable issue, naming the policy, the
   * variable and the kind of issue but never the value. For development; off by default.
   */
  readonly logVariableIssues?: boolean
  /**
   * Which implementation evaluates policies and matches change events: `ts` (the TypeScript packages, the
   * default), `native` (the Rust core as a Node-API addon) or `wasm` (the Rust core as WebAssembly). Both
   * give equal results; `native` and `wasm` refuse to start when their build cannot load.
   */
  readonly engine?: EngineKind
}

/** A connection, for the realtime inspector. */
export interface ConnectionInfo {
  readonly sid: string
  readonly subject: string
  readonly roles: readonly string[]
  /** The stored API key the connection authenticated with. */
  readonly keyId: string | undefined
  /** False while the session waits for the client to resume. */
  readonly connected: boolean
  readonly openedAt: Date
  readonly tokenExpiresAt: Date | undefined
  readonly subscriptions: readonly {
    readonly id: string
    readonly coll: string
    readonly observer: string
  }[]
  /** Documents held for the client. */
  readonly documents: number
  readonly queuedBytes: number
  readonly lastSeq: number
}

/** A shared observer, for the realtime inspector. */
export interface ObserverInfo {
  readonly key: string
  readonly coll: string
  readonly type: ObserverType
  readonly status: Observer["status"]
  readonly subscribers: number
  /** The effective filter: the subscription's filter and the read policies. */
  readonly filter: Record<string, unknown>
  readonly sort: Readonly<Record<string, 1 | -1>> | undefined
  readonly limit: number | undefined
  readonly clusterTime: ClusterTime
}

/** Engine wide counts, for the realtime inspector. */
export interface RealtimeStats {
  /** Sessions with a socket attached. */
  readonly connections: number
  /** Every session, including those waiting for a resume. */
  readonly sessions: number
  readonly subscriptions: number
  readonly observers: Readonly<Record<ObserverType, number>>
  readonly subjects: number
  readonly policyVersion: string
  /** The cluster time the change stream has reached. */
  readonly streamPosition: ClusterTime
  readonly collections: readonly string[]
}

/** One change event as the tail shows it: no field values, only names. */
export interface EventSummary {
  readonly id: string
  readonly ct: ClusterTime
  readonly wallTime: Date | undefined
  readonly coll: string
  readonly op: NormalizedEvent["op"]
  readonly docId: unknown
  /** The fields an update set or removed, when the event carries a diff. */
  readonly fields: readonly string[] | undefined
}

/**
 * One read policy as a DLS denial reports it: its name and whether it matched the document, never the
 * resolved clause or a field value.
 */
export interface DeniedPolicy {
  readonly name: string
  readonly kind: "permissive" | "restrictive"
  /** Whether the policy's resolved `using` clause matched the document. */
  readonly matched: boolean
  /** The variable that made the policy drop out (by name and kind, never its value). */
  readonly issue?: { readonly variable: string; readonly kind: string }
  /** The top level fields the clause reads, so a caller can hide outcomes over fields it may not see. */
  readonly fields: readonly string[]
}

/** Why DLS kept a document from an observer whose own filter matched it. */
export interface DlsDenial {
  /**
   * `no_grant`: no read policy covers the subscribers' roles; `no_permissive`: no permissive policy
   * matched the document; `restrictive`: a restrictive policy did not match it.
   */
  readonly reason: "no_grant" | "no_permissive" | "restrictive"
  /** The names of the policies responsible: every permissive one for `no_permissive`, else the failing restrictive ones. */
  readonly responsible: readonly string[]
  readonly policies: readonly DeniedPolicy[]
}

/** How one candidate observer handled an event. */
export interface ObserverOutcome {
  readonly observer: string
  readonly type: ObserverType
  /** `entered`, `updated` and `left` reach subscribers; `unmatched` means the effective filter excluded it. */
  readonly outcome: "entered" | "updated" | "left" | "unmatched"
  readonly subscribers: readonly {
    readonly sid: string
    readonly sub: string
    readonly subject: string
  }[]
  /**
   * Set when the outcome is `unmatched` or `left` because of DLS: the subscription's own filter matches the
   * new document but the read policies of its subscribers do not.
   */
  readonly dls?: DlsDenial
}

/** The route of one event through the engine. */
export interface EventTrace extends EventSummary {
  readonly policyVersion: string
  readonly candidates: readonly ObserverOutcome[]
}

/** What a transport knows about a connection besides its socket. */
export interface ConnectInfo {
  /**
   * The client address, from {@link Realtime.clientAddress}. Anonymous connections without one are in
   * process (GraphQL subscriptions) and are limited by the transport that carries them.
   */
  readonly address?: string
}

/** A connection from any transport. */
export interface ConnectionHandler {
  message(text: string): void
  close(): void
}

export interface SubscriptionState {
  readonly id: string
  readonly coll: string
  readonly observer: Observer
  readonly listener: ReturnType<Session["listener"]>
}

export interface SessionState {
  readonly session: Session
  readonly key: string
  /** The client address of the current connection, when the transport knows it. */
  address: string | undefined
  readonly openedAt: Date
  principal: Principal
  readonly subs: Map<string, SubscriptionState>
  expiryTimer: ReturnType<typeof setTimeout> | undefined
  graceTimer: ReturnType<typeof setTimeout> | undefined
  dropTimer: ReturnType<typeof setTimeout> | undefined
  socket: RealtimeSocket | undefined
  mutations: Promise<void>
  pendingMutations: number
  /** Resolved context lookups (`$ctx`) of this session. */
  ctx: Record<string, unknown>
  /** The resolver cache entry behind each resolved lookup, held while the session lives. */
  readonly ctxKeys: Map<string, string>
  /** Context work runs one at a time per session, so lookups and their retains never interleave. */
  ctxWork: Promise<void>
  /** Subscriptions waiting for their context lookups. */
  readonly pendingSubs: Map<string, SubMessage>
  ctxRetry: ReturnType<typeof setTimeout> | undefined
  readonly ctxFailed: Set<string>
}

export interface AnonymousSlot {
  release: (() => void) | undefined
}
