import { Authenticator, type JwtAuthOptions, type KeyOptions, type Principal } from "@canopy/auth"
import {
  type CompiledFilter,
  type CompiledProjection,
  compileFilter,
  compileProjection,
  UnsupportedQueryError,
} from "@canopy/matcher"
import {
  type Compiled,
  ContextResolver,
  deniedPaths,
  deniesTextSearch,
  driverContextReader,
  explainAccess,
  explainContext,
  type FieldAccess,
  formatAccessReport,
  onceVariableIssue,
  PolicyEngine,
  type PolicySet,
  projectReadable,
  type RequestContext,
  Role,
  TEXT_SEARCH_DENIED,
  toFilter,
  usesNow,
} from "@canopy/policy"
import {
  CanopyError,
  type ClientMessage,
  CloseCode,
  type ClusterTime,
  canonicalString,
  decodeClientMessage,
  ErrorCode,
  type ExplainAs,
  encodeMessage,
  type HelloMessage,
  type MutMessage,
  PROTOCOL_VERSION,
  type SubMessage,
  toCanopyError,
  type WireError,
  ZERO_CT,
} from "@canopy/protocol"
import { DEFAULT_LIMITS, parseQuery, queryHash } from "@canopy/query"
import { BSON, type MongoClient } from "mongodb"
import { EchoWaiter } from "./echo.ts"
import type { ControlEvent, Doc, NormalizedEvent } from "./event.ts"
import {
  type CheckpointStore,
  type FullDocumentMode,
  Ingestor,
  metaCheckpoints,
  noCheckpoints,
} from "./ingestor.ts"
import { type Logger, redacting, silentLogger } from "./logger.ts"
import { RealtimeMetrics } from "./metrics.ts"
import { isBulk, type MutationExecutor, mutationRequest } from "./mutations.ts"
import {
  FilterObserver,
  type ObservedQuery,
  type Observer,
  type ObserverLimits,
  type ObserverType,
  PollingObserver,
  WindowObserver,
} from "./observers.ts"
import {
  databasePolicies,
  directoryPolicies,
  type PolicySource,
  staticPolicies,
} from "./policy-source.ts"
import { ObserverRegistry } from "./registry.ts"
import { type Coverage, FULL_COVERAGE, type RealtimeSocket, Session } from "./session.ts"
import { MongoSnapshotReader } from "./snapshot.ts"

/** The longest delay timers keep (2147483647 ms, about 24.8 days); longer ones fire after 1 ms instead. */
const MAX_TIMER_MS = 2_147_483_647

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
  /** How many recent event traces {@link Realtime.trace} keeps. Defaults to 0 (tracing off). */
  readonly traceCapacity?: number
  /**
   * Logs a debug line the first time a policy drops out because of a variable issue, naming the policy, the
   * variable and the kind of issue but never the value. For development; off by default.
   */
  readonly logVariableIssues?: boolean
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

/** A connection from any transport. */
export interface ConnectionHandler {
  message(text: string): void
  close(): void
}

interface SubscriptionState {
  readonly id: string
  readonly coll: string
  readonly observer: Observer
  readonly listener: ReturnType<Session["listener"]>
}

interface SessionState {
  readonly session: Session
  readonly key: string
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

function randomId(): string {
  const bytes = new Uint8Array(12)
  globalThis.crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString("base64url")
}

function contextKey(ctx: RequestContext): string {
  return canonicalString({ roles: [...ctx.roles].sort(), claims: ctx.claims, ctx: ctx.ctx ?? null })
}

function coverageOf(projection: CompiledProjection | undefined): Coverage {
  if (projection === undefined) return FULL_COVERAGE
  if (projection.mode === "include") {
    const fields = new Set(projection.paths.map((path) => path.split(".")[0] ?? path))
    fields.add("_id")
    return { covers: (field) => fields.has(field) }
  }
  const hidden = new Set(projection.paths.filter((path) => !path.includes(".")))
  return { covers: (field) => !hidden.has(field) }
}

/** The top level fields a policy clause reads, looking through `$and`, `$or` and `$nor`. */
function clauseFields(clause: unknown): string[] {
  const fields = new Set<string>()
  const walk = (value: unknown): void => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return
    for (const [key, inner] of Object.entries(value)) {
      if (key === "$and" || key === "$or" || key === "$nor") {
        if (Array.isArray(inner)) for (const part of inner) walk(part)
      } else if (!key.startsWith("$")) fields.add(key.split(".")[0] ?? key)
    }
  }
  walk(clause)
  return [...fields].sort()
}

function accessDescriptor(access: FieldAccess): unknown {
  return access.kind === "all" ? "all" : { [access.kind]: [...access.paths].sort() }
}

/**
 * The realtime engine: one change stream, shared observers, authorized fan out over the
 * `canopy.v1` protocol. Create it with {@link createRealtime}, then mount it with `attach()` (Node) or
 * `bun()` (Bun).
 */
export class Realtime {
  readonly metrics: RealtimeMetrics = new RealtimeMetrics()
  private engine: PolicyEngine
  private readonly options: RealtimeOptions
  private readonly limits: RealtimeLimits
  private readonly observerLimits: ObserverLimits
  private readonly logger: Logger
  private readonly auth: Authenticator
  private readonly registry = new ObserverRegistry()
  private readonly reader: MongoSnapshotReader
  private readonly sessions = new Map<string, SessionState>()
  private readonly subjects = new Map<string, number>()
  private readonly lingering = new Map<Observer, ReturnType<typeof setTimeout>>()
  private readonly ingestor: Ingestor
  private readonly echoes = new EchoWaiter()
  private readonly source: PolicySource
  /** The context lookup resolver, shared with REST when the server composes both. */
  readonly contexts: ContextResolver
  private readonly ownsContexts: boolean
  private readonly stopContexts: () => void
  private stopWatching: (() => void) | undefined
  private timeTimer: ReturnType<typeof setInterval> | undefined
  private watched: string[] = []
  private closing = false
  private eventCounter = 0
  private readonly tails = new Set<(event: EventSummary) => void>()
  private readonly traces = new Map<string, EventTrace>()
  /** What a DLS denial is explained against: the first subscriber's own filter and request context. */
  private readonly observerOrigins = new WeakMap<
    Observer,
    {
      readonly filter: Record<string, unknown>
      readonly context: RequestContext
      matcher?: CompiledFilter | null
    }
  >()

  /** Use {@link createRealtime}. */
  constructor(options: RealtimeOptions, set: PolicySet, source: PolicySource) {
    this.options = options
    this.limits = { ...DEFAULT_REALTIME_LIMITS, ...options.limits }
    this.observerLimits = {
      maxTrackedDocs: this.limits.maxTrackedDocs,
      maxBuffer: 100,
      requeryIntervalMs: 50,
      pollMinMs: 250,
      pollMaxMs: 2000,
    }
    this.logger = redacting(options.logger ?? silentLogger)
    this.auth = options.authenticator ?? new Authenticator(options.auth, options.keys)
    this.source = source
    this.engine = this.createEngine(set)
    const db = options.mongo.db(options.database)
    this.ownsContexts = options.contexts === undefined
    this.contexts =
      options.contexts ??
      new ContextResolver({
        reader: driverContextReader(db, BSON),
        onIssue: (issue) =>
          this.metrics.contextFailures.inc({ name: issue.name, kind: issue.kind }),
      })
    this.stopContexts = this.contexts.onInvalidate((keys) => this.contextsInvalidated(keys))
    this.reader = new MongoSnapshotReader(options.mongo, db, {
      concurrency: this.limits.snapshotConcurrency,
      metrics: this.metrics,
    })
    const checkpoints =
      options.checkpoints === "off"
        ? noCheckpoints
        : options.checkpoints === undefined || options.checkpoints === "meta"
          ? metaCheckpoints(
              options.mongo.db(options.metaDatabase ?? "canopy"),
              `app:${options.database}`,
              options.nodeId ?? "n1",
            )
          : options.checkpoints
    this.watched = this.realtimeCollections()
    this.ingestor = new Ingestor({
      client: options.mongo,
      db,
      mode: options.fullDocument ?? "auto",
      collections: () => this.watched,
      checkpoints,
      logger: this.logger,
      metrics: this.metrics,
      handlers: {
        onEvents: (events) => this.processEvents(events),
        onControl: (event) => this.processControl(event),
        onRestart: (reason) => {
          this.contexts.invalidateAll()
          this.resyncAll(reason)
        },
        onProgress: (ct) => {
          for (const observer of this.registry.all()) observer.advance(ct)
          this.echoes.advance(ct)
        },
      },
    })
  }

  /** The policy bundle version (`welcome.pv`). */
  get policyVersion(): string {
    return this.engine.version
  }

  /** The policy engine in use. */
  get policies(): PolicyEngine {
    return this.engine
  }

  private readonly variableIssueLog = onceVariableIssue((message, issue) =>
    this.logger.debug(
      {
        coll: issue.collection,
        policy: issue.policy,
        variable: issue.variable,
        kind: issue.kind,
      },
      message,
    ),
  )

  private createEngine(set: PolicySet): PolicyEngine {
    return new PolicyEngine(set, {
      onVariableIssue: (issue) => {
        this.metrics.variableErrors.inc({ coll: issue.collection, kind: issue.kind })
        if (this.options.logVariableIssues === true) this.variableIssueLog(issue)
      },
      onEvaluationError: (error, coll, op) => {
        this.metrics.denials.inc({ surface: "realtime", coll, op })
        this.logger.error({ err: error, coll, op }, "policy evaluation failed, denying")
      },
    })
  }

  /** The collections the change stream covers: realtime ones and the sources of context lookups. */
  private realtimeCollections(): string[] {
    const names = new Set(
      [...this.engine.set.collections.values()]
        .filter((def) => def.exposed && def.realtime)
        .map((def) => def.collection),
    )
    for (const lookup of Object.values(this.engine.set.contexts)) names.add(lookup.from)
    return [...names].sort()
  }

  private contextOf(state: SessionState): RequestContext {
    return { ...state.principal.context, ctx: state.ctx }
  }

  /**
   * Resolves the named lookups the session does not hold yet (and every name in `force`), through the
   * session's work queue. Transient failures are retried after `contextRetryMs`.
   */
  private loadContext(
    state: SessionState,
    names: readonly string[],
    force: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    const work = state.ctxWork.then(async () => {
      if (!this.sessions.has(state.session.sid)) return
      const wanted = names.filter(
        (name) => force.has(name) || !state.ctxKeys.has(name) || state.ctxFailed.has(name),
      )
      if (wanted.length === 0) return
      const resolved = await this.contexts.resolve(
        this.engine.set.contexts,
        wanted,
        state.principal.context,
      )
      if (!this.sessions.has(state.session.sid)) return
      const released: string[] = []
      const ctx = { ...state.ctx }
      for (const name of wanted) {
        const key = state.ctxKeys.get(name)
        if (key !== undefined) released.push(key)
        state.ctxKeys.delete(name)
        state.ctxFailed.delete(name)
        delete ctx[name]
      }
      Object.assign(ctx, resolved.ctx)
      for (const [name, key] of resolved.keys) {
        if (resolved.failed.has(name)) continue
        state.ctxKeys.set(name, key)
      }
      this.contexts.retain(
        [...resolved.keys].filter(([name]) => !resolved.failed.has(name)).map(([, key]) => key),
      )
      this.contexts.release(released)
      state.ctx = ctx
      if (resolved.failed.size > 0) {
        for (const name of resolved.failed) state.ctxFailed.add(name)
        if (state.ctxRetry === undefined) {
          state.ctxRetry = setTimeout(() => {
            state.ctxRetry = undefined
            this.refreshContext(state, [...state.ctxFailed], "ctx_retry")
          }, this.options.contextRetryMs ?? 5000)
        }
      }
    })
    state.ctxWork = work.catch((error: unknown) =>
      this.logger.error({ err: error }, "context lookup failed"),
    )
    return work
  }

  private clearContext(state: SessionState): void {
    this.contexts.release(state.ctxKeys.values())
    state.ctxKeys.clear()
    state.ctxFailed.clear()
    state.ctx = {}
    if (state.ctxRetry !== undefined) clearTimeout(state.ctxRetry)
    state.ctxRetry = undefined
  }

  private contextsInvalidated(keys: ReadonlySet<string>): void {
    this.metrics.contextInvalidations.inc({}, keys.size)
    for (const state of this.sessions.values()) {
      const names = [...state.ctxKeys].filter(([, key]) => keys.has(key)).map(([name]) => name)
      if (names.length > 0) this.refreshContext(state, names, "ctx")
    }
  }

  /** Re-resolves lookups and moves the subscriptions whose effective query changed to new observers. */
  private refreshContext(state: SessionState, names: readonly string[], reason: string): void {
    this.loadContext(state, names, new Set(names)).then(
      () => {
        if (this.sessions.has(state.session.sid)) this.rebindChanged(state, reason)
      },
      () => {},
    )
  }

  private rebindChanged(state: SessionState, reason: string): void {
    for (const sub of [...state.subs.values()]) {
      const stored = this.queries.get(sub)
      if (stored === undefined) continue
      let plan: ReturnType<Realtime["plan"]>
      try {
        plan = this.plan(this.contextOf(state), stored.msg)
      } catch (error: unknown) {
        this.dropSubscription(state, sub.id)
        state.session.send({ t: "nosub", s: sub.id, err: toCanopyError(error).toWire() })
        continue
      }
      if (plan.key === sub.observer.key) continue
      if (sub.observer.detach(sub.listener)) this.lingerObserver(sub.observer)
      const observer = this.observerFor(plan)
      if (!this.observerOrigins.has(observer))
        this.observerOrigins.set(observer, {
          filter: plan.userFilter,
          context: this.contextOf(state),
        })
      const next: SubscriptionState = { ...sub, observer }
      this.queries.set(next, stored)
      state.subs.set(sub.id, next)
      state.session.rebind(sub.id)
      this.metrics.rebinds.inc({ reason })
      observer.attach(sub.listener)
    }
  }

  /** Opens the change stream and starts hot reload. */
  async start(): Promise<void> {
    await this.ingestor.start()
    const watchable = this.source.watch
    const wantsWatch =
      !("set" in this.options.policies) &&
      (this.options.policies as { watch?: boolean }).watch !== false
    if (watchable !== undefined && wantsWatch) {
      this.stopWatching = watchable.call(
        this.source,
        (set) => this.reloadPolicies(set),
        (error) =>
          this.logger.error(
            { err: error },
            "policy reload rejected, keeping the previous policies",
          ),
      )
    }
    this.timeTimer = setInterval(
      () => this.refreshTimePolicies(),
      this.options.timePolicyRefreshMs ?? 60_000,
    )
  }

  /** Replaces the policies; subscriptions whose effective query changed are resynced. */
  reloadPolicies(set: PolicySet): void {
    if (set.version === this.engine.version) return
    const contextsChanged =
      canonicalString(set.contexts) !== canonicalString(this.engine.set.contexts)
    this.engine = this.createEngine(set)
    for (const state of this.sessions.values()) {
      if (contextsChanged) this.clearContext(state)
      const affected: string[] = []
      for (const sub of state.subs.values()) {
        if (
          !this.engine.isRealtime(sub.coll) ||
          this.observerKeyFor(state, sub) !== sub.observer.key
        )
          affected.push(sub.id)
      }
      this.resyncSubscriptions(state, affected, "policy")
    }
    const collections = this.realtimeCollections()
    if (canonicalString(collections) !== canonicalString(this.watched)) {
      this.watched = collections
      this.ingestor.reopen()
    }
    this.logger.info({ version: set.version }, "policies reloaded")
  }

  private readonly queries = new WeakMap<SubscriptionState, { msg: SubMessage }>()

  private observerKeyFor(state: SessionState, sub: SubscriptionState): string | undefined {
    const stored = this.queries.get(sub)
    if (stored === undefined) return undefined
    try {
      return this.plan(this.contextOf(state), stored.msg).key
    } catch {
      return undefined
    }
  }

  private resyncSubscriptions(state: SessionState, ids: readonly string[], reason: string): void {
    if (ids.length === 0) return
    for (const id of ids) this.dropSubscription(state, id)
    this.metrics.resyncs.inc({ reason })
    state.session.send({ t: "resync", reason, s: [...ids] })
  }

  private resyncAll(reason: string): void {
    for (const state of this.sessions.values()) {
      const ids = [...state.subs.keys()]
      for (const id of ids) this.dropSubscription(state, id)
      this.metrics.resyncs.inc({ reason })
      state.session.send({ t: "resync", reason })
    }
    for (const observer of [...this.registry.all()]) this.destroyObserver(observer)
  }

  private refreshTimePolicies(): void {
    for (const observer of this.registry.all()) {
      const def = this.engine.collection(observer.query.coll)
      if (
        def?.policies.some((policy) => policy.ops.includes("read") && usesNow(policy.using)) ===
        true
      ) {
        if (observer instanceof PollingObserver) observer.schedule()
        else this.resyncObserver(observer, "time_policy")
      }
    }
  }

  private resyncObserver(observer: Observer, reason: string): void {
    for (const state of this.sessions.values()) {
      const ids = [...state.subs.values()]
        .filter((sub) => sub.observer === observer)
        .map((sub) => sub.id)
      this.resyncSubscriptions(state, ids, reason)
    }
  }

  /** Whether the engine's change stream is open, for readiness probes. */
  get changeStreamOpen(): boolean {
    return this.ingestor.streaming
  }

  /** Accepts a new connection from any transport. */
  connect(socket: RealtimeSocket): ConnectionHandler {
    let state: SessionState | undefined
    let helloPending = true
    let lastInbound = Date.now()
    const helloTimer = setTimeout(() => {
      if (helloPending) socket.close(CloseCode.HelloTimeout, "no hello received")
    }, 10_000)
    const heartbeat = this.options.heartbeatMs ?? 25_000
    const silenceTimer = setInterval(
      () => {
        if (Date.now() - lastInbound > 2 * heartbeat + 10_000)
          socket.close(1001, "heartbeat timeout")
      },
      Math.min(5000, heartbeat),
    )
    this.metrics.connections.add(1)
    let closed = false
    const fail = (code: number, error: CanopyError): void => {
      socket.send(
        encodeMessage({
          t: "err",
          seq: state?.session.lastSeq ?? 0,
          code: error.code,
          msg: error.message,
        }),
      )
      socket.close(code, error.code)
    }
    return {
      message: (text) => {
        lastInbound = Date.now()
        if (text.length > this.limits.maxFrameBytes) {
          socket.close(CloseCode.FrameTooLarge, "frame too large")
          return
        }
        let message: ClientMessage | undefined
        try {
          message = decodeClientMessage(text)
        } catch (error: unknown) {
          fail(CloseCode.ProtocolError, toCanopyError(error))
          return
        }
        if (message === undefined) return
        if (helloPending) {
          if (message.t !== "hello") {
            fail(
              CloseCode.ProtocolError,
              new CanopyError(ErrorCode.ProtocolError, "The first frame must be hello"),
            )
            return
          }
          helloPending = false
          clearTimeout(helloTimer)
          this.hello(socket, message).then(
            (result) => {
              if (closed) {
                result.session.disconnect()
                this.scheduleDrop(result)
                return
              }
              state = result
            },
            (error: unknown) => {
              const canopy = toCanopyError(error)
              fail(
                canopy.code === ErrorCode.Forbidden ? CloseCode.Forbidden : CloseCode.Unauthorized,
                canopy,
              )
            },
          )
          return
        }
        if (state === undefined) {
          fail(
            CloseCode.ProtocolError,
            new CanopyError(ErrorCode.ProtocolError, "Wait for welcome before sending more frames"),
          )
          return
        }
        this.dispatch(state, socket, message)
      },
      close: () => {
        closed = true
        clearTimeout(helloTimer)
        clearInterval(silenceTimer)
        this.metrics.connections.add(-1)
        if (state === undefined) return
        if (state.socket === socket) {
          state.socket = undefined
          state.session.disconnect()
          this.scheduleDrop(state)
        }
      },
    }
  }

  private async hello(socket: RealtimeSocket, hello: HelloMessage): Promise<SessionState> {
    if (hello.v !== PROTOCOL_VERSION) {
      socket.close(CloseCode.UnsupportedVersion, "unsupported protocol version")
      throw new CanopyError(ErrorCode.ProtocolError, "Unsupported protocol version")
    }
    const principal = await this.auth.authenticate(hello.key, hello.token)
    const caps = new Set((hello.caps ?? []).filter((cap) => cap === "batch" || cap === "diff"))
    const welcome = (sid: string, resumed: boolean) => ({
      t: "welcome" as const,
      sid,
      v: PROTOCOL_VERSION,
      resumed,
      hb: this.options.heartbeatMs ?? 25_000,
      pv: this.engine.version,
      ct: this.ingestor.position,
      caps: [...caps],
      limits: { subs: this.limits.maxSubscriptionsPerConnection },
    })
    const resume = hello.resume
    if (resume !== undefined) {
      const existing = this.sessions.get(resume.sid)
      if (
        existing !== undefined &&
        existing.principal.subject === principal.subject &&
        contextKey(existing.principal.context) === contextKey(principal.context)
      ) {
        const previous = existing.socket
        if (previous !== undefined) {
          existing.socket = undefined
          existing.session.disconnect()
          previous.close(CloseCode.Normal, "resumed on another connection")
        }
        if (existing.session.canReplay(resume.seq)) {
          if (existing.dropTimer !== undefined) clearTimeout(existing.dropTimer)
          existing.dropTimer = undefined
          existing.socket = socket
          existing.principal = principal
          existing.session.connect(socket, welcome(existing.session.sid, true))
          existing.session.replayAfter(resume.seq)
          this.armExpiry(existing)
          return existing
        }
        this.destroySession(existing)
      }
    }
    const count = this.makeRoom(principal.subject)
    if (principal.subject !== "anon" && count >= this.limits.maxConnectionsPerSubject) {
      socket.close(CloseCode.RateLimited, "too many connections")
      throw new CanopyError(ErrorCode.RateLimited, "Too many connections for this subject")
    }
    const sid = `${this.options.nodeId ?? "n1"}.${randomId()}`
    const session = new Session(sid, caps, {
      resumeBufferBytes: this.limits.resumeBufferBytes,
      softQueueBytes: this.limits.softQueueBytes,
      hardQueueBytes: this.limits.hardQueueBytes,
    })
    const state: SessionState = {
      session,
      key: hello.key,
      openedAt: new Date(),
      principal,
      subs: new Map(),
      expiryTimer: undefined,
      graceTimer: undefined,
      dropTimer: undefined,
      socket,
      mutations: Promise.resolve(),
      pendingMutations: 0,
      ctx: {},
      ctxKeys: new Map(),
      ctxWork: Promise.resolve(),
      pendingSubs: new Map(),
      ctxRetry: undefined,
      ctxFailed: new Set(),
    }
    session.onSlowConsumer = () => {
      this.metrics.slowConsumers.inc()
      state.socket?.close(CloseCode.SlowConsumer, "slow consumer")
      this.destroySession(state)
    }
    session.onSubscriptionFailed = (subId, error) => this.subscriptionFailed(state, subId, error)
    this.sessions.set(sid, state)
    this.subjects.set(principal.subject, count + 1)
    session.connect(socket, welcome(sid, false))
    this.armExpiry(state)
    return state
  }

  private armExpiry(state: SessionState): void {
    if (state.expiryTimer !== undefined) clearTimeout(state.expiryTimer)
    if (state.graceTimer !== undefined) clearTimeout(state.graceTimer)
    state.expiryTimer = undefined
    state.graceTimer = undefined
    const expiresAt = state.principal.expiresAt
    if (expiresAt === undefined) return
    const delay = Math.max(0, expiresAt - Date.now())
    if (delay > MAX_TIMER_MS) {
      state.expiryTimer = setTimeout(() => this.armExpiry(state), MAX_TIMER_MS)
      return
    }
    state.expiryTimer = setTimeout(() => {
      state.session.send({
        t: "err",
        code: ErrorCode.TokenExpired,
        msg: "The token has expired; send auth with a new one",
      })
      state.graceTimer = setTimeout(() => {
        for (const id of [...state.subs.keys()]) {
          this.dropSubscription(state, id)
          state.session.send({
            t: "nosub",
            s: id,
            err: { code: ErrorCode.TokenExpired, msg: "The token expired" },
          })
        }
        state.session.close(CloseCode.Unauthorized, "token expired")
        this.destroySession(state)
      }, this.options.expiryGraceMs ?? 30_000)
    }, delay)
  }

  private dispatch(state: SessionState, socket: RealtimeSocket, message: ClientMessage): void {
    switch (message.t) {
      case "ping":
        socket.send(encodeMessage({ t: "pong", ts: message.ts }))
        return
      case "sub":
        this.subscribe(state, message)
        return
      case "unsub":
        if (state.pendingSubs.delete(message.id)) {
          state.session.send({ t: "nosub", s: message.id })
        } else if (state.subs.has(message.id)) {
          this.dropSubscription(state, message.id)
          state.session.send({ t: "nosub", s: message.id })
        }
        return
      case "auth":
        this.reauthenticate(state, message.token)
        return
      case "mut":
        this.enqueueMutation(state, message)
        return
      case "bye":
        this.destroySession(state)
        socket.close(CloseCode.Normal, "bye")
        return
      case "hello":
        socket.close(CloseCode.ProtocolError, "duplicate hello")
        return
    }
  }

  /** Queues a mutation behind the connection's earlier ones, so they commit in arrival order. */
  private enqueueMutation(state: SessionState, message: MutMessage): void {
    const executor = this.options.mutations
    const refuse = (code: ErrorCode, msg: string): void =>
      state.session.send({ t: "ack", m: message.id, ok: false, err: { code, msg } })
    if (executor === undefined) {
      refuse(ErrorCode.Unavailable, "Mutations over the socket are not enabled on this server")
      return
    }
    if (state.principal.readOnly === true) {
      refuse(ErrorCode.Forbidden, "A view token may not write")
      return
    }
    if (state.pendingMutations >= this.limits.maxPendingMutations) {
      refuse(
        ErrorCode.RateLimited,
        `At most ${this.limits.maxPendingMutations} mutations may be pending per connection`,
      )
      return
    }
    state.pendingMutations += 1
    state.mutations = state.mutations
      .then(() => this.runMutation(state, executor, message))
      .finally(() => {
        state.pendingMutations -= 1
      })
  }

  /**
   * Commits one mutation and sends its `ack` after its echo: once the change events of the write were
   * fanned out, the `ack` is enqueued behind them on this connection (`echo: true`). When that cannot be
   * promised (a bulk write, a collection without realtime, a subscription that defers events to a later
   * snapshot, a timeout, or a replay, whose events were sent with the original write) the `ack` carries
   * the readable post images and `echo: false`. A write whose echo is expected runs without reading its
   * documents back; they are read only when the echo does not come. A single document write that found no
   * visible document fails with `CANOPY_NOT_FOUND`, as it does over REST.
   */
  private async runMutation(
    state: SessionState,
    executor: MutationExecutor,
    message: MutMessage,
  ): Promise<void> {
    const started = performance.now()
    try {
      await this.loadContext(
        state,
        this.engine.contextNames([message.c], state.principal.context.roles),
      )
      const principal = state.principal
      const caller = { context: this.contextOf(state), subject: principal.subject }
      const request = mutationRequest(message)
      const lean =
        executor.documentsOf !== undefined &&
        !isBulk(message.op) &&
        message.op !== "delete" &&
        this.watched.includes(message.c)
      const result = await executor.execute(caller, request, {
        mutationId: message.id,
        ...(lean ? { returnDocuments: false } : {}),
      })
      if (
        (message.op === "update" || message.op === "replace" || message.op === "delete") &&
        result.matched === 0 &&
        result.deleted === 0 &&
        result.changedIds.length === 0
      )
        throw new CanopyError(ErrorCode.NotFound, "Document not found")
      let echo = false
      if (!result.replayed && !isBulk(message.op) && this.watched.includes(message.c)) {
        echo =
          result.changedIds.length === 0 ||
          (await this.echoes.wait(
            message.c,
            result.changedIds,
            result.ct,
            this.options.echoTimeoutMs ?? 2000,
          ))
        if (echo) echo = this.settledFor(state, message.c)
      }
      if (!this.sessions.has(state.session.sid)) return
      const documents =
        echo || result.documents !== undefined || !lean
          ? result.documents
          : await executor.documentsOf?.(caller, request, result)
      if (!this.sessions.has(state.session.sid)) return
      const docs = echo
        ? undefined
        : documents?.filter((doc): doc is Record<string, unknown> => doc !== null)
      state.session.send({
        t: "ack",
        m: message.id,
        ok: true,
        ct: result.ct,
        echo,
        res: {
          matched: result.matched,
          modified: result.modified,
          ...(result.insertedIds.length === 0 ? {} : { insertedIds: result.insertedIds }),
          ...(docs === undefined ? {} : { docs }),
        },
        replayed: result.replayed,
      })
      this.metrics.mutations.inc({
        coll: message.c,
        op: message.op,
        result: echo ? "echo" : "docs",
      })
    } catch (error: unknown) {
      const canopy = toCanopyError(error)
      if (canopy.code === ErrorCode.Internal)
        this.logger.error({ err: error, coll: message.c, op: message.op }, "mutation failed")
      this.metrics.mutations.inc({ coll: message.c, op: message.op, result: "error" })
      if (this.sessions.has(state.session.sid))
        state.session.send({ t: "ack", m: message.id, ok: false, err: canopy.toWire() })
    } finally {
      this.metrics.mutationSeconds.observe((performance.now() - started) / 1000)
    }
  }

  /** Whether every subscription of the connection on `coll` receives events as they are applied. */
  private settledFor(state: SessionState, coll: string): boolean {
    for (const sub of state.subs.values()) {
      if (sub.coll === coll && !sub.observer.settled()) return false
    }
    return true
  }

  private reauthenticate(state: SessionState, token: string): void {
    const before = contextKey(state.principal.context)
    this.auth.authenticate(state.key, token).then(
      (principal) => {
        if (
          principal.subject !== state.principal.subject &&
          state.principal.subject !== "anon" &&
          principal.subject !== "anon"
        ) {
          state.session.send({
            t: "err",
            code: ErrorCode.Forbidden,
            msg: "auth may not switch to another subject",
          })
          state.session.close(CloseCode.Forbidden, "subject changed")
          this.destroySession(state)
          return
        }
        state.principal = principal
        this.armExpiry(state)
        if (contextKey(principal.context) !== before) {
          const resyncChanged = (): void => {
            if (!this.sessions.has(state.session.sid)) return
            const affected = [...state.subs.values()]
              .filter((sub) => this.observerKeyFor(state, sub) !== sub.observer.key)
              .map((sub) => sub.id)
            this.resyncSubscriptions(state, affected, "auth")
          }
          const names = this.engine.contextNames(
            new Set([...state.subs.values()].map((sub) => sub.coll)),
            principal.context.roles,
          )
          if (state.ctxKeys.size === 0 && names.length === 0) {
            resyncChanged()
            return
          }
          this.clearContext(state)
          this.loadContext(state, names).then(resyncChanged, () => {})
        }
      },
      (error: unknown) => {
        const canopy = toCanopyError(error)
        state.session.send({ t: "err", code: canopy.code, msg: canopy.message })
        state.session.close(CloseCode.Unauthorized, canopy.code)
        this.destroySession(state)
      },
    )
  }

  private plan(
    ctx: RequestContext,
    message: SubMessage,
  ): {
    key: string
    query: ObservedQuery
    type: "filter" | "window" | "polling"
    projection: CompiledProjection | undefined
    /** The subscription's own filter, before the read policies. */
    userFilter: Record<string, unknown>
  } {
    const coll = message.c
    if (!this.engine.isRealtime(coll))
      throw new CanopyError(ErrorCode.NotFound, `No realtime collection ${coll}`)
    const parsed = parseQuery(message.q, { ...DEFAULT_LIMITS, maxLimit: this.limits.maxWindow })
    const readable = this.engine.readable(coll, ctx)
    if (deniesTextSearch(readable, parsed.filter.filter))
      throw new CanopyError(ErrorCode.InvalidQuery, TEXT_SEARCH_DENIED)
    const denied = deniedPaths(readable, parsed.paths)
    if (denied.length > 0) {
      throw new CanopyError(
        ErrorCode.InvalidQuery,
        `The query references fields that are not readable: ${denied.join(", ")}`,
      )
    }
    const effective: Compiled = this.engine.effectiveRead(coll, parsed.filter.filter, ctx)
    if (effective.kind === "deny")
      this.metrics.denials.inc({ surface: "realtime", coll, op: "read" })
    const filter = toFilter(effective)
    let type: "filter" | "window" | "polling" = parsed.filter.matcherSafe
      ? parsed.limit === undefined
        ? "filter"
        : "window"
      : "polling"
    if (type !== "polling") {
      try {
        compileFilter(filter)
      } catch (error: unknown) {
        if (!(error instanceof UnsupportedQueryError)) throw error
        type = "polling"
      }
    }
    const projection =
      parsed.fields === undefined ? undefined : compileProjection(parsed.fields.projection)
    const sort = parsed.sort?.sort
    const key = queryHash({
      collection: coll,
      filter,
      sort,
      limit: parsed.limit,
      projection: { readable: accessDescriptor(readable), type } as Record<string, unknown>,
    })
    return {
      key,
      type,
      projection,
      userFilter: parsed.filter.filter,
      query: {
        coll,
        filter,
        sort,
        limit: parsed.limit,
        readable: (doc: Doc) => projectReadable(readable, doc),
      },
    }
  }

  private readonly explanations = new WeakMap<SubMessage, Record<string, unknown>>()

  /**
   * The access report a `sub` asked for with `o.explain`: for the connection itself (`true`) or for a
   * stated caller, whose context lookups are resolved unless `ctx` is given. It names the policies, their
   * outcomes and the effective filter; a policy that dropped out is described by its variable's name and
   * kind, never by the value that made it fail.
   */
  private async explainSubscription(
    state: SessionState,
    message: SubMessage,
    explain: true | ExplainAs,
  ): Promise<Record<string, unknown>> {
    const engine = this.engine
    const coll = message.c
    if (!engine.isRealtime(coll))
      throw new CanopyError(ErrorCode.NotFound, `No realtime collection ${coll}`)
    const parsed = parseQuery(message.q, { ...DEFAULT_LIMITS, maxLimit: this.limits.maxWindow })
    let context: RequestContext
    if (explain === true) context = this.contextOf(state)
    else {
      context = explainContext({
        claims: explain.claims ?? null,
        roles: explain.roles ?? [],
        ...(explain.ctx === undefined ? {} : { ctx: explain.ctx }),
      })
      const names = engine.contextNames([coll], context.roles)
      if (explain.ctx === undefined && names.length > 0)
        context = {
          ...context,
          ctx: (await this.contexts.resolve(engine.set.contexts, names, context)).ctx,
        }
    }
    const report = explainAccess(engine, {
      collection: coll,
      op: "read",
      context,
      filter: parsed.filter.filter,
    })
    return {
      ...report,
      effectiveFilter: toFilter(report.effective),
      text: formatAccessReport(report),
    }
  }

  private subscribe(state: SessionState, message: SubMessage): void {
    if (state.subs.has(message.id)) this.dropSubscription(state, message.id)
    state.pendingSubs.delete(message.id)
    if (state.subs.size + state.pendingSubs.size >= this.limits.maxSubscriptionsPerConnection) {
      state.session.send({
        t: "nosub",
        s: message.id,
        err: {
          code: ErrorCode.LimitSubscriptions,
          msg: `At most ${this.limits.maxSubscriptionsPerConnection} subscriptions per connection`,
        },
      })
      return
    }
    const explain = message.o?.explain
    if (explain !== undefined && !this.explanations.has(message)) {
      if (!state.principal.context.roles.has(Role.Service)) {
        state.session.send({
          t: "nosub",
          s: message.id,
          err: {
            code: ErrorCode.Forbidden,
            msg: "Explanations are only available with a secret key",
          },
        })
        return
      }
      state.pendingSubs.set(message.id, message)
      this.explainSubscription(state, message, explain).then(
        (report) => {
          if (state.pendingSubs.get(message.id) !== message) return
          state.pendingSubs.delete(message.id)
          this.explanations.set(message, report)
          if (this.sessions.has(state.session.sid)) this.subscribe(state, message)
        },
        (error: unknown) => {
          if (state.pendingSubs.get(message.id) !== message) return
          state.pendingSubs.delete(message.id)
          state.session.send({ t: "nosub", s: message.id, err: toCanopyError(error).toWire() })
        },
      )
      return
    }
    const names = this.engine.isRealtime(message.c)
      ? this.engine.contextNames([message.c], state.principal.context.roles)
      : []
    if (names.every((name) => state.ctxKeys.has(name) && !state.ctxFailed.has(name))) {
      this.subscribeNow(state, message)
      return
    }
    state.pendingSubs.set(message.id, message)
    this.loadContext(state, names).then(
      () => {
        if (state.pendingSubs.get(message.id) !== message) return
        state.pendingSubs.delete(message.id)
        if (this.sessions.has(state.session.sid)) this.subscribeNow(state, message)
      },
      () => {},
    )
  }

  private subscribeNow(state: SessionState, message: SubMessage): void {
    let plan: ReturnType<Realtime["plan"]>
    try {
      plan = this.plan(this.contextOf(state), message)
    } catch (error: unknown) {
      state.session.send({ t: "nosub", s: message.id, err: toCanopyError(error).toWire() })
      return
    }
    const observer = this.observerFor(plan)
    const projection = plan.projection
    const project =
      projection === undefined ? (doc: Doc) => doc : (doc: Doc) => projection.apply(doc)
    if (!this.observerOrigins.has(observer))
      this.observerOrigins.set(observer, {
        filter: plan.userFilter,
        context: this.contextOf(state),
      })
    const listener = state.session.listener(message.c, message.id, project, coverageOf(projection))
    const report = this.explanations.get(message)
    if (report !== undefined) {
      this.explanations.delete(message)
      state.session.explainOnReady(message.id, report)
    }
    const sub: SubscriptionState = { id: message.id, coll: message.c, observer, listener }
    this.queries.set(sub, { msg: message })
    state.subs.set(message.id, sub)
    this.metrics.subscriptions.add(1)
    observer.attach(listener)
  }

  private observerFor(plan: ReturnType<Realtime["plan"]>): Observer {
    const existing = this.registry.get(plan.key)
    if (existing?.isFailed() === true) this.destroyObserver(existing)
    else if (existing !== undefined) {
      const linger = this.lingering.get(existing)
      if (linger !== undefined) {
        clearTimeout(linger)
        this.lingering.delete(existing)
      }
      return existing
    }
    let observer: Observer
    if (plan.type === "polling") {
      observer = new PollingObserver(
        plan.key,
        plan.query,
        this.reader,
        this.registry,
        this.observerLimits,
      )
    } else {
      const matcher = compileFilter(plan.query.filter)
      observer =
        plan.type === "window"
          ? new WindowObserver(
              plan.key,
              plan.query,
              matcher,
              this.reader,
              this.registry,
              this.observerLimits,
            )
          : new FilterObserver(
              plan.key,
              plan.query,
              matcher,
              this.reader,
              this.registry,
              this.observerLimits,
            )
    }
    this.registry.add(observer)
    this.metrics.observers.add(1, { type: observer.type })
    return observer
  }

  private dropSubscription(state: SessionState, id: string): void {
    const sub = state.subs.get(id)
    if (sub === undefined) return
    state.subs.delete(id)
    state.session.forget(id)
    this.metrics.subscriptions.add(-1)
    if (!sub.observer.detach(sub.listener)) return
    if (sub.observer.isFailed()) this.destroyObserver(sub.observer)
    else this.lingerObserver(sub.observer)
  }

  private subscriptionFailed(state: SessionState, subId: string, error: WireError): void {
    const sub = state.subs.get(subId)
    if (sub === undefined) return
    this.dropSubscription(state, subId)
    state.session.send({ t: "nosub", s: subId, err: error })
  }

  private lingerObserver(observer: Observer): void {
    const linger = this.options.observerLingerMs ?? 30_000
    if (this.lingering.has(observer)) return
    this.lingering.set(
      observer,
      setTimeout(() => {
        this.lingering.delete(observer)
        if (observer.size === 0) this.destroyObserver(observer)
      }, linger),
    )
  }

  private destroyObserver(observer: Observer): void {
    const linger = this.lingering.get(observer)
    if (linger !== undefined) clearTimeout(linger)
    this.lingering.delete(observer)
    if (this.registry.get(observer.key) !== observer) return
    if (observer instanceof WindowObserver || observer instanceof PollingObserver)
      observer.dispose()
    this.registry.remove(observer)
    this.metrics.observers.add(-1, { type: observer.type })
  }

  /**
   * The subject's session count once there is room for a new session: at the limit, its oldest sessions
   * that only wait for a resume (their tab was closed or reloaded) are dropped first, so only connected
   * sessions count against `maxConnectionsPerSubject`.
   */
  private makeRoom(subject: string): number {
    let count = this.subjects.get(subject) ?? 0
    if (subject === "anon" || count < this.limits.maxConnectionsPerSubject) return count
    const waiting = [...this.sessions.values()]
      .filter((state) => state.principal.subject === subject && state.socket === undefined)
      .sort((a, b) => (a.session.disconnectedAt ?? 0) - (b.session.disconnectedAt ?? 0))
    for (const state of waiting) {
      if (count < this.limits.maxConnectionsPerSubject) break
      this.destroySession(state)
      count = this.subjects.get(subject) ?? 0
    }
    return count
  }

  /**
   * Keeps a session whose socket went away for the resume window. A session that already ended (`bye`, an
   * engine shutdown) has nothing to resume, and a timer for it would only hold its memory and keep the
   * process alive until it fires.
   */
  private scheduleDrop(state: SessionState): void {
    if (this.closing || !this.sessions.has(state.session.sid)) return
    if (state.dropTimer !== undefined) clearTimeout(state.dropTimer)
    state.dropTimer = setTimeout(
      () => this.destroySession(state),
      this.options.resumeWindowMs ?? 120_000,
    )
  }

  private destroySession(state: SessionState): void {
    if (!this.sessions.has(state.session.sid)) return
    for (const id of [...state.subs.keys()]) this.dropSubscription(state, id)
    state.pendingSubs.clear()
    this.clearContext(state)
    for (const timer of [state.expiryTimer, state.graceTimer, state.dropTimer])
      if (timer !== undefined) clearTimeout(timer)
    this.sessions.delete(state.session.sid)
    const count = (this.subjects.get(state.principal.subject) ?? 1) - 1
    if (count <= 0) this.subjects.delete(state.principal.subject)
    else this.subjects.set(state.principal.subject, count)
  }

  private async processEvents(events: NormalizedEvent[]): Promise<void> {
    const lookups = new Map<string, NormalizedEvent[]>()
    for (const event of events) {
      if (event.op !== "update" || event.post !== undefined) continue
      if (this.registry.candidates(event).size === 0 && !this.contexts.watches(event.coll)) continue
      const list = lookups.get(event.coll) ?? []
      list.push(event)
      lookups.set(event.coll, list)
    }
    for (const [coll, list] of lookups) {
      const found = await this.reader.lookup(
        coll,
        list.map((event) => event.id),
      )
      for (const event of list) event.post = found.get(event.key) ?? null
    }
    for (const event of events) {
      if (this.contexts.watches(event.coll))
        this.contexts.invalidate({
          coll: event.coll,
          id: event.id,
          pre: event.pre,
          post: event.post,
        })
    }
    let last: ClusterTime = ZERO_CT
    const tracing = (this.options.traceCapacity ?? 0) > 0
    const observed = tracing || this.tails.size > 0
    let subscribers: Map<Observer, ObserverOutcome["subscribers"][number][]> | undefined
    for (const event of events) {
      const started = performance.now()
      const candidates = this.registry.candidates(event)
      this.metrics.candidates.observe(candidates.size)
      const outcomes: ObserverOutcome[] = []
      for (const observer of candidates) {
        this.metrics.matchEvaluations.inc()
        const before = tracing && observer.has(event.key)
        observer.apply(event)
        if (!tracing) continue
        const after = observer.has(event.key)
        subscribers ??= this.subscribersByObserver()
        const dls = after ? undefined : this.dlsDenial(observer, event.post)
        outcomes.push({
          observer: observer.key,
          type: observer.type,
          outcome: before ? (after ? "updated" : "left") : after ? "entered" : "unmatched",
          subscribers: subscribers.get(observer) ?? [],
          ...(dls === undefined ? {} : { dls }),
        })
      }
      this.metrics.fanoutLatency.observe((performance.now() - started) / 1000)
      last = event.ct
      if (observed) this.record(event, outcomes, tracing)
    }
    for (const observer of this.registry.all()) observer.advance(last)
    this.echoes.processed(events)
  }

  /**
   * Explains why DLS kept `doc` from an observer: only when the subscription's own filter matches it, so
   * documents the query itself excludes are not blamed on a policy. Policy clauses are matched in memory
   * and reported by name; nothing of the document or the resolved clauses is kept.
   */
  private dlsDenial(observer: Observer, doc: Doc | null | undefined): DlsDenial | undefined {
    if (doc === null || doc === undefined) return undefined
    const origin = this.observerOrigins.get(observer)
    if (origin === undefined) return undefined
    if (origin.matcher === undefined) {
      try {
        origin.matcher = compileFilter(origin.filter)
      } catch {
        origin.matcher = null
      }
    }
    if (origin.matcher === null || !origin.matcher.matches(doc)) return undefined
    const coll = observer.query.coll
    const explanation = this.engine.explain(coll, "read", origin.context, "using")
    if (explanation.bypass) return undefined
    const definitions = this.engine.collection(coll)?.policies ?? []
    const policies: DeniedPolicy[] = []
    for (const policy of explanation.policies) {
      if (!policy.applies && policy.issue === undefined) continue
      let matched = false
      if (policy.applies && policy.resolved !== undefined) {
        try {
          matched = compileFilter(policy.resolved).matches(doc)
        } catch {
          matched = false
        }
      }
      const template = definitions.find((d) => d.name === policy.name)?.using ?? {}
      policies.push({
        name: policy.name,
        kind: policy.kind,
        matched,
        ...(policy.issue === undefined
          ? {}
          : { issue: { variable: policy.issue.variable, kind: policy.issue.kind } }),
        fields: clauseFields(template),
      })
    }
    const permissive = policies.filter((policy) => policy.kind === "permissive")
    if (!explanation.exposed || permissive.length === 0)
      return {
        reason: "no_grant",
        responsible: [],
        policies,
      }
    if (!permissive.some((policy) => policy.matched))
      return {
        reason: "no_permissive",
        responsible: permissive.map((policy) => policy.name),
        policies,
      }
    const failing = policies.filter((policy) => policy.kind === "restrictive" && !policy.matched)
    if (failing.length === 0) return undefined
    return { reason: "restrictive", responsible: failing.map((policy) => policy.name), policies }
  }

  private processControl(event: ControlEvent): void {
    this.contexts.invalidateAll()
    if ((event.kind === "drop" || event.kind === "rename") && event.coll !== undefined) {
      const error = new CanopyError(
        ErrorCode.CollectionDropped,
        `The collection ${event.coll} was dropped or renamed`,
      )
      for (const observer of [...this.registry.all()]) {
        if (observer.query.coll !== event.coll) continue
        observer.fail(error)
        this.destroyObserver(observer)
      }
      return
    }
    this.ingestor.reopen()
    this.resyncAll(event.kind)
  }

  private subscribersByObserver(): Map<Observer, ObserverOutcome["subscribers"][number][]> {
    const out = new Map<Observer, ObserverOutcome["subscribers"][number][]>()
    for (const state of this.sessions.values()) {
      for (const sub of state.subs.values()) {
        const list = out.get(sub.observer) ?? []
        if (list.length < 100)
          list.push({ sid: state.session.sid, sub: sub.id, subject: state.principal.subject })
        out.set(sub.observer, list)
      }
    }
    return out
  }

  private record(event: NormalizedEvent, outcomes: ObserverOutcome[], tracing: boolean): void {
    this.eventCounter += 1
    const summary: EventSummary = {
      id: `${this.options.nodeId ?? "n1"}.${this.eventCounter.toString(36)}`,
      ct: event.ct,
      wallTime: event.wallTime,
      coll: event.coll,
      op: event.op,
      docId: event.id,
      fields:
        event.diff === undefined
          ? undefined
          : [...Object.keys(event.diff.set), ...event.diff.unset],
    }
    if (tracing) {
      this.traces.set(summary.id, {
        ...summary,
        policyVersion: this.engine.version,
        candidates: outcomes,
      })
      const capacity = this.options.traceCapacity ?? 0
      for (const id of this.traces.keys()) {
        if (this.traces.size <= capacity) break
        this.traces.delete(id)
      }
    }
    for (const listener of this.tails) {
      try {
        listener(summary)
      } catch (error: unknown) {
        this.logger.warn({ err: error }, "event tail listener failed")
      }
    }
  }

  /** Engine wide counts. */
  stats(): RealtimeStats {
    const observers: Record<ObserverType, number> = { filter: 0, window: 0, polling: 0 }
    for (const observer of this.registry.all()) observers[observer.type] += 1
    let connections = 0
    let subscriptions = 0
    for (const state of this.sessions.values()) {
      if (state.socket !== undefined) connections += 1
      subscriptions += state.subs.size
    }
    return {
      connections,
      sessions: this.sessions.size,
      subscriptions,
      observers,
      subjects: this.subjects.size,
      policyVersion: this.engine.version,
      streamPosition: this.ingestor.position,
      collections: [...this.watched],
    }
  }

  /** Every session, connected or waiting for a resume. */
  connections(): ConnectionInfo[] {
    return [...this.sessions.values()].map((state) => ({
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

  /** Every shared observer. */
  observers(): ObserverInfo[] {
    return [...this.registry.all()].map((observer) => ({
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

  /** Calls `listener` with a summary of every change event processed from now on. Returns an unsubscribe. */
  tail(listener: (event: EventSummary) => void): () => void {
    this.tails.add(listener)
    return () => {
      this.tails.delete(listener)
    }
  }

  /** The trace of a recent event, while it is within `traceCapacity`. */
  trace(id: string): EventTrace | undefined {
    return this.traces.get(id)
  }

  /** The most recent traced events, newest first. */
  recentEvents(limit = 50): EventSummary[] {
    const out: EventSummary[] = []
    for (const trace of [...this.traces.values()].reverse()) {
      if (out.length >= limit) break
      const { policyVersion: _version, candidates: _candidates, ...summary } = trace
      out.push(summary)
    }
    return out
  }

  /**
   * Ends every session whose principal matches, connected or waiting for a resume: the client gets `err`
   * and the socket closes with `code` (4003 for a revoked key or a banned user, which clients do not retry).
   * Returns the number of sessions ended.
   */
  closeConnections(
    matches: (principal: Principal) => boolean,
    code: number = CloseCode.Forbidden,
    reason = "forbidden",
  ): number {
    let count = 0
    for (const state of [...this.sessions.values()]) {
      if (!matches(state.principal)) continue
      count += 1
      state.session.send({ t: "err", code: ErrorCode.Forbidden, msg: reason })
      state.session.close(code, reason)
      state.socket = undefined
      this.destroySession(state)
    }
    return count
  }

  /**
   * Drains and stops: every session gets `reconnect` with a random delay within `drainMs`,
   * then sockets close with 1012 and the stream position is checkpointed.
   */
  async close(options: { readonly drainMs?: number } = {}): Promise<void> {
    if (this.closing) return
    this.closing = true
    const drainMs = options.drainMs ?? 0
    const timers: ReturnType<typeof setTimeout>[] = []
    for (const state of this.sessions.values()) {
      const retryAfterMs = Math.floor(Math.random() * drainMs)
      state.session.send({ t: "reconnect", retryAfterMs, reason: "shutdown" })
      state.session.flush()
      timers.push(
        setTimeout(() => {
          if (this.sessions.get(state.session.sid) !== state) return
          state.session.close(CloseCode.ServiceRestart, "shutdown")
          this.destroySession(state)
        }, retryAfterMs),
      )
    }
    const deadline = Date.now() + drainMs
    for (;;) {
      for (const state of [...this.sessions.values()])
        if (state.socket === undefined) this.destroySession(state)
      if (this.sessions.size === 0 || Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())))
    }
    for (const timer of timers) clearTimeout(timer)
    for (const state of [...this.sessions.values()]) {
      state.session.close(CloseCode.ServiceRestart, "shutdown")
      this.destroySession(state)
    }
    for (const observer of [...this.registry.all()]) this.destroyObserver(observer)
    this.stopWatching?.()
    this.tails.clear()
    this.stopContexts()
    if (this.ownsContexts) this.contexts.close()
    if (this.timeTimer !== undefined) clearInterval(this.timeTimer)
    this.echoes.close()
    await this.ingestor.stop()
  }

  /** Renders metrics in the Prometheus text format. */
  renderMetrics(): string {
    return this.metrics.render()
  }
}

function sourceOf(options: RealtimeOptions): PolicySource {
  const policies = options.policies
  if ("load" in policies) return policies
  if ("set" in policies) return staticPolicies(policies.set)
  if ("dir" in policies) return directoryPolicies(policies.dir)
  return databasePolicies(options.mongo, options.metaDatabase ?? "canopy")
}

/**
 * Creates and starts the realtime engine. The change stream is open when the promise resolves, so no write
 * made after that is missed.
 */
export async function createRealtime(options: RealtimeOptions): Promise<Realtime> {
  if (options.database === (options.metaDatabase ?? "canopy")) {
    throw new TypeError("The app database and the meta database must differ")
  }
  await options.mongo.connect()
  const source = sourceOf(options)
  const set = await source.load()
  const realtime = new Realtime(options, set, source)
  await realtime.start()
  return realtime
}
