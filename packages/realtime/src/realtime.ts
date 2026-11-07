import { Authenticator, type JwtAuthOptions, type KeyOptions, type Principal } from "@canopy/auth"
import {
  type CompiledProjection,
  compileFilter,
  compileProjection,
  UnsupportedQueryError,
} from "@canopy/matcher"
import {
  type Compiled,
  deniedPaths,
  type FieldAccess,
  PolicyEngine,
  type PolicySet,
  projectReadable,
  type RequestContext,
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
  encodeMessage,
  type HelloMessage,
  type MutMessage,
  PROTOCOL_VERSION,
  type SubMessage,
  toCanopyError,
  type WireError,
} from "@canopy/protocol"
import { DEFAULT_LIMITS, parseQuery, queryHash } from "@canopy/query"
import type { MongoClient } from "mongodb"
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
  principal: Principal
  readonly subs: Map<string, SubscriptionState>
  expiryTimer: ReturnType<typeof setTimeout> | undefined
  graceTimer: ReturnType<typeof setTimeout> | undefined
  dropTimer: ReturnType<typeof setTimeout> | undefined
  socket: RealtimeSocket | undefined
  mutations: Promise<void>
  pendingMutations: number
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
  private stopWatching: (() => void) | undefined
  private timeTimer: ReturnType<typeof setInterval> | undefined
  private watched: string[] = []
  private closing = false

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
    this.auth = new Authenticator(options.auth, options.keys)
    this.source = source
    this.engine = this.createEngine(set)
    const db = options.mongo.db(options.database)
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
        onRestart: (reason) => this.resyncAll(reason),
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

  private createEngine(set: PolicySet): PolicyEngine {
    return new PolicyEngine(set, {
      onVariableIssue: (issue) =>
        this.metrics.variableErrors.inc({ coll: issue.collection, kind: issue.kind }),
      onEvaluationError: (error, coll, op) => {
        this.metrics.denials.inc({ surface: "realtime", coll, op })
        this.logger.error({ err: error, coll, op }, "policy evaluation failed, denying")
      },
    })
  }

  private realtimeCollections(): string[] {
    return [...this.engine.set.collections.values()]
      .filter((def) => def.exposed && def.realtime)
      .map((def) => def.collection)
      .sort()
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
    this.engine = this.createEngine(set)
    for (const state of this.sessions.values()) {
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
      return this.plan(state.principal.context, stored.msg).key
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
    const count = this.subjects.get(principal.subject) ?? 0
    if (principal.subject !== "anon" && count >= this.limits.maxConnectionsPerSubject) {
      socket.close(CloseCode.RateLimited, "too many connections")
      throw new CanopyError(ErrorCode.RateLimited, "Too many connections for this subject")
    }
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
    const sid = `${this.options.nodeId ?? "n1"}.${randomId()}`
    const session = new Session(sid, caps, {
      resumeBufferBytes: this.limits.resumeBufferBytes,
      softQueueBytes: this.limits.softQueueBytes,
      hardQueueBytes: this.limits.hardQueueBytes,
    })
    const state: SessionState = {
      session,
      key: hello.key,
      principal,
      subs: new Map(),
      expiryTimer: undefined,
      graceTimer: undefined,
      dropTimer: undefined,
      socket,
      mutations: Promise.resolve(),
      pendingMutations: 0,
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
    state.expiryTimer = setTimeout(
      () => {
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
      },
      Math.min(delay, 2 ** 31 - 1),
    )
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
        if (state.subs.has(message.id)) {
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
   * the readable post images and `echo: false`.
   */
  private async runMutation(
    state: SessionState,
    executor: MutationExecutor,
    message: MutMessage,
  ): Promise<void> {
    const started = performance.now()
    try {
      const principal = state.principal
      const result = await executor.execute(
        { context: principal.context, subject: principal.subject },
        mutationRequest(message),
        { mutationId: message.id },
      )
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
      const docs = echo
        ? undefined
        : result.documents?.filter((doc): doc is Record<string, unknown> => doc !== null)
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
          const affected = [...state.subs.values()]
            .filter((sub) => this.observerKeyFor(state, sub) !== sub.observer.key)
            .map((sub) => sub.id)
          this.resyncSubscriptions(state, affected, "auth")
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
  } {
    const coll = message.c
    if (!this.engine.isRealtime(coll))
      throw new CanopyError(ErrorCode.NotFound, `No realtime collection ${coll}`)
    const parsed = parseQuery(message.q, { ...DEFAULT_LIMITS, maxLimit: this.limits.maxWindow })
    const readable = this.engine.readable(coll, ctx)
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
      query: {
        coll,
        filter,
        sort,
        limit: parsed.limit,
        readable: (doc: Doc) => projectReadable(readable, doc),
      },
    }
  }

  private subscribe(state: SessionState, message: SubMessage): void {
    if (state.subs.has(message.id)) this.dropSubscription(state, message.id)
    if (state.subs.size >= this.limits.maxSubscriptionsPerConnection) {
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
    let plan: ReturnType<Realtime["plan"]>
    try {
      plan = this.plan(state.principal.context, message)
    } catch (error: unknown) {
      state.session.send({ t: "nosub", s: message.id, err: toCanopyError(error).toWire() })
      return
    }
    const observer = this.observerFor(plan)
    const projection = plan.projection
    const project =
      projection === undefined ? (doc: Doc) => doc : (doc: Doc) => projection.apply(doc)
    const listener = state.session.listener(message.c, message.id, project, coverageOf(projection))
    const sub: SubscriptionState = { id: message.id, coll: message.c, observer, listener }
    this.queries.set(sub, { msg: message })
    state.subs.set(message.id, sub)
    this.metrics.subscriptions.add(1)
    observer.attach(listener)
  }

  private observerFor(plan: ReturnType<Realtime["plan"]>): Observer {
    const existing = this.registry.get(plan.key)
    if (existing !== undefined) {
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
    if (sub.observer.detach(sub.listener)) this.lingerObserver(sub.observer)
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

  private scheduleDrop(state: SessionState): void {
    if (state.dropTimer !== undefined) clearTimeout(state.dropTimer)
    state.dropTimer = setTimeout(
      () => this.destroySession(state),
      this.options.resumeWindowMs ?? 120_000,
    )
  }

  private destroySession(state: SessionState): void {
    if (!this.sessions.has(state.session.sid)) return
    for (const id of [...state.subs.keys()]) this.dropSubscription(state, id)
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
      if (this.registry.candidates(event).size === 0) continue
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
    let last: ClusterTime = "0"
    for (const event of events) {
      const started = performance.now()
      const candidates = this.registry.candidates(event)
      this.metrics.candidates.observe(candidates.size)
      for (const observer of candidates) {
        this.metrics.matchEvaluations.inc()
        observer.apply(event)
      }
      this.metrics.fanoutLatency.observe((performance.now() - started) / 1000)
      last = event.ct
    }
    for (const observer of this.registry.all()) observer.advance(last)
    this.echoes.processed(events)
  }

  private processControl(event: ControlEvent): void {
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

  /**
   * Drains and stops: every session gets `reconnect` with a random delay within `drainMs`,
   * then sockets close with 1012 and the stream position is checkpointed.
   */
  async close(options: { readonly drainMs?: number } = {}): Promise<void> {
    if (this.closing) return
    this.closing = true
    const drainMs = options.drainMs ?? 0
    for (const state of this.sessions.values()) {
      state.session.send({
        t: "reconnect",
        retryAfterMs: Math.floor(Math.random() * drainMs),
        reason: "shutdown",
      })
      state.session.flush()
    }
    if (drainMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(drainMs, 1000)))
    for (const state of [...this.sessions.values()]) {
      state.session.close(CloseCode.ServiceRestart, "shutdown")
      this.destroySession(state)
    }
    for (const observer of [...this.registry.all()]) this.destroyObserver(observer)
    this.stopWatching?.()
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
