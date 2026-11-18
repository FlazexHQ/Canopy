import { Authenticator, type Principal, resolveClientAddress } from "@canopy/auth"
import { type CoreEngine, selectEngine } from "@canopy/native"
import {
  ContextResolver,
  driverContextReader,
  onceVariableIssue,
  type PolicyEngine,
  type PolicySet,
  usesNow,
} from "@canopy/policy"
import { CanopyError, CloseCode, canonicalString, ErrorCode } from "@canopy/protocol"
import { BSON } from "mongodb"
import { EchoWaiter } from "./echo.ts"
import type { ControlEvent } from "./event.ts"
import { EventLog } from "./event-log.ts"
import { Fanout } from "./fanout.ts"
import { Ingestor, metaCheckpoints, noCheckpoints } from "./ingestor.ts"
import { connectionInfos, observerInfos, statsOf } from "./introspection.ts"
import { type Logger, redacting, silentLogger } from "./logger.ts"
import { RealtimeMetrics } from "./metrics.ts"
import { MutationRunner } from "./mutation-runner.ts"
import { ObserverPool } from "./observer-pool.ts"
import { PollingObserver } from "./observers.ts"
import {
  databasePolicies,
  directoryPolicies,
  type PolicySource,
  staticPolicies,
} from "./policy-source.ts"
import {
  type ConnectInfo,
  type ConnectionHandler,
  type ConnectionInfo,
  DEFAULT_REALTIME_LIMITS,
  type EventSummary,
  type EventTrace,
  type ObserverInfo,
  type RealtimeLimits,
  type RealtimeOptions,
  type RealtimeStats,
} from "./realtime-types.ts"
import type { RealtimeSocket } from "./session.ts"
import { SessionContexts } from "./session-contexts.ts"
import { SessionLifecycle } from "./session-lifecycle.ts"
import { SessionTable } from "./session-table.ts"
import { MongoSnapshotReader } from "./snapshot.ts"
import { Subscriptions } from "./subscriptions.ts"

/**
 * The realtime engine: one change stream, shared observers, authorized fan out over the
 * `canopy.v1` protocol. Create it with {@link createRealtime}, then mount it with `attach()` (Node) or
 * `bun()` (Bun).
 */
export class Realtime {
  readonly metrics: RealtimeMetrics = new RealtimeMetrics()
  private readonly core: CoreEngine
  private engine: PolicyEngine
  private readonly options: RealtimeOptions
  private readonly limits: RealtimeLimits
  private readonly logger: Logger
  private readonly reader: MongoSnapshotReader
  private readonly sessions = new SessionTable()
  private readonly pool: ObserverPool
  private readonly sessionContexts: SessionContexts
  private readonly subscriptions: Subscriptions
  private readonly lifecycle: SessionLifecycle
  private readonly fanout: Fanout
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
  private readonly events: EventLog

  /** Use {@link createRealtime}. */
  constructor(options: RealtimeOptions, set: PolicySet, source: PolicySource) {
    this.options = options
    this.limits = { ...DEFAULT_REALTIME_LIMITS, ...options.limits }
    this.logger = redacting(options.logger ?? silentLogger)
    this.events = new EventLog({
      nodeId: options.nodeId ?? "n1",
      capacity: options.traceCapacity ?? 0,
      logger: this.logger,
    })
    const auth = options.authenticator ?? new Authenticator(options.auth, options.keys)
    this.source = source
    this.core = selectEngine(options.engine)
    this.engine = this.createEngine(set)
    const engine = (): PolicyEngine => this.engine
    const db = options.mongo.db(options.database)
    this.ownsContexts = options.contexts === undefined
    this.contexts =
      options.contexts ??
      new ContextResolver({
        reader: driverContextReader(db, BSON),
        onIssue: (issue) =>
          this.metrics.contextFailures.inc({ name: issue.name, kind: issue.kind }),
      })
    this.reader = new MongoSnapshotReader(options.mongo, db, {
      concurrency: this.limits.snapshotConcurrency,
      metrics: this.metrics,
    })
    this.pool = new ObserverPool({
      core: this.core,
      reader: this.reader,
      limits: {
        maxTrackedDocs: this.limits.maxTrackedDocs,
        maxBuffer: 100,
        requeryIntervalMs: 50,
        pollMinMs: 250,
        pollMaxMs: 2000,
      },
      metrics: this.metrics,
      lingerMs: options.observerLingerMs ?? 30_000,
    })
    this.sessionContexts = new SessionContexts({
      resolver: this.contexts,
      engine,
      sessions: this.sessions,
      metrics: this.metrics,
      logger: this.logger,
      retryMs: options.contextRetryMs ?? 5000,
      onRefreshed: (state, reason) => this.subscriptions.rebindChanged(state, reason),
    })
    this.subscriptions = new Subscriptions({
      core: this.core,
      engine,
      sessions: this.sessions,
      contexts: this.sessionContexts,
      resolver: this.contexts,
      pool: this.pool,
      limits: this.limits,
      metrics: this.metrics,
    })
    this.lifecycle = new SessionLifecycle({
      options,
      limits: this.limits,
      metrics: this.metrics,
      auth,
      engine,
      position: () => this.ingestor.position,
      closing: () => this.closing,
      sessions: this.sessions,
      subscriptions: this.subscriptions,
      contexts: this.sessionContexts,
      mutations: new MutationRunner({
        executor: options.mutations,
        engine,
        sessions: this.sessions,
        contexts: this.sessionContexts,
        echoes: this.echoes,
        watched: () => this.watched,
        maxPending: this.limits.maxPendingMutations,
        echoTimeoutMs: options.echoTimeoutMs ?? 2000,
        metrics: this.metrics,
        logger: this.logger,
      }),
    })
    this.fanout = new Fanout({
      core: this.core,
      engine,
      pool: this.pool,
      reader: this.reader,
      resolver: this.contexts,
      sessions: this.sessions,
      events: this.events,
      echoes: this.echoes,
      metrics: this.metrics,
    })
    this.stopContexts = this.contexts.onInvalidate((keys) => this.sessionContexts.invalidated(keys))
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
        onEvents: (events) =>
          this.options.span === undefined
            ? this.fanout.process(events)
            : this.options.span("canopy.realtime.fanout", { events: events.length }, () =>
                this.fanout.process(events),
              ),
        onControl: (event) => this.processControl(event),
        onRestart: (reason) => {
          this.contexts.invalidateAll()
          this.subscriptions.resyncAll(reason)
        },
        onProgress: (ct) => {
          for (const observer of this.pool.all()) observer.advance(ct)
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
    const { span } = this.options
    if (span === undefined) return this.buildEngine(set)
    return span("canopy.policy.load", { version: set.version }, () => this.buildEngine(set))
  }

  private buildEngine(set: PolicySet): PolicyEngine {
    return this.core.createPolicyEngine(set, {
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
        .filter((def) => this.engine.isRealtime(def.collection))
        .map((def) => def.collection),
    )
    for (const lookup of Object.values(this.engine.set.contexts)) names.add(lookup.from)
    return [...names].sort()
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
      if (contextsChanged) this.sessionContexts.clear(state)
      const affected: string[] = []
      for (const sub of state.subs.values()) {
        if (
          !this.engine.isRealtime(sub.coll) ||
          this.subscriptions.observerKeyFor(state, sub) !== sub.observer.key
        )
          affected.push(sub.id)
      }
      this.subscriptions.resync(state, affected, "policy")
    }
    const collections = this.realtimeCollections()
    if (canonicalString(collections) !== canonicalString(this.watched)) {
      this.watched = collections
      this.ingestor.reopen()
    }
    this.logger.info({ version: set.version }, "policies reloaded")
  }

  private refreshTimePolicies(): void {
    for (const observer of this.pool.all()) {
      const def = this.engine.collection(observer.query.coll)
      if (
        def?.policies.some((policy) => policy.ops.includes("read") && usesNow(policy.using)) ===
        true
      ) {
        if (observer instanceof PollingObserver) observer.schedule()
        else this.subscriptions.resyncObserver(observer, "time_policy")
      }
    }
  }

  /** Whether the engine's change stream is open, for readiness probes. */
  get changeStreamOpen(): boolean {
    return this.ingestor.streaming
  }

  /** Accepts a new connection from any transport. */
  connect(socket: RealtimeSocket, info: ConnectInfo = {}): ConnectionHandler {
    return this.lifecycle.connect(socket, info)
  }

  private processControl(event: ControlEvent): void {
    this.contexts.invalidateAll()
    if ((event.kind === "drop" || event.kind === "rename") && event.coll !== undefined) {
      const error = new CanopyError(
        ErrorCode.CollectionDropped,
        `The collection ${event.coll} was dropped or renamed`,
      )
      for (const observer of [...this.pool.all()]) {
        if (observer.query.coll !== event.coll) continue
        observer.fail(error)
        this.pool.destroy(observer)
      }
      return
    }
    this.ingestor.reopen()
    this.subscriptions.resyncAll(event.kind)
  }

  /** Engine wide counts. */
  stats(): RealtimeStats {
    return statsOf(this.sessions, this.pool.all(), {
      policyVersion: this.engine.version,
      streamPosition: this.ingestor.position,
      collections: this.watched,
    })
  }

  /** Every session, connected or waiting for a resume. */
  connections(): ConnectionInfo[] {
    return connectionInfos(this.sessions.values())
  }

  /** Every shared observer. */
  observers(): ObserverInfo[] {
    return observerInfos(this.pool.all())
  }

  /** Calls `listener` with a summary of every change event processed from now on. Returns an unsubscribe. */
  tail(listener: (event: EventSummary) => void): () => void {
    return this.events.tail(listener)
  }

  /** The trace of a recent event, while it is within `traceCapacity`. */
  trace(id: string): EventTrace | undefined {
    return this.events.trace(id)
  }

  /** The most recent traced events, newest first. */
  recentEvents(limit = 50): EventSummary[] {
    return this.events.recent(limit)
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
    return this.lifecycle.closeMatching(matches, code, reason)
  }

  /**
   * Drains and stops: every session gets `reconnect` with a random delay within `drainMs`,
   * then sockets close with 1012 and the stream position is checkpointed.
   */
  async close(options: { readonly drainMs?: number } = {}): Promise<void> {
    if (this.closing) return
    this.closing = true
    await this.lifecycle.drain(options.drainMs ?? 0)
    this.pool.destroyAll()
    this.stopWatching?.()
    this.events.close()
    this.stopContexts()
    if (this.ownsContexts) this.contexts.close()
    if (this.timeTimer !== undefined) clearInterval(this.timeTimer)
    this.echoes.close()
    await this.ingestor.stop()
  }

  /**
   * The client address of a connection: the socket peer, or the forwarded address behind a trusted proxy
   * (the proxies of the rate limits). Pass it to {@link Realtime.connect} as `info.address`.
   */
  clientAddress(headers: Headers, peer: string | undefined): string {
    const limits = this.options.rateLimits
    return limits === undefined
      ? resolveClientAddress(headers, peer, [])
      : limits.addressOf(headers, peer)
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
