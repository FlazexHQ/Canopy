import { type Authenticator, type Principal, retryAfterSeconds } from "@canopy/auth"
import type { PolicyEngine, RequestContext } from "@canopy/policy"
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
  PROTOCOL_VERSION,
  toCanopyError,
  type WireError,
} from "@canopy/protocol"
import type { RealtimeMetrics } from "./metrics.ts"
import type { MutationRunner } from "./mutation-runner.ts"
import {
  type AnonymousSlot,
  type ConnectInfo,
  type ConnectionHandler,
  MAX_TIMER_MS,
  type RealtimeLimits,
  type RealtimeOptions,
  type SessionState,
} from "./realtime-types.ts"
import { type RealtimeSocket, Session } from "./session.ts"
import type { SessionContexts } from "./session-contexts.ts"
import type { SessionTable } from "./session-table.ts"
import type { Subscriptions } from "./subscriptions.ts"

/** Options of {@link SessionLifecycle}. */
export interface SessionLifecycleOptions {
  readonly options: RealtimeOptions
  readonly limits: RealtimeLimits
  readonly metrics: RealtimeMetrics
  readonly auth: Authenticator
  readonly engine: () => PolicyEngine
  /** The change stream position a `welcome` reports. */
  readonly position: () => ClusterTime
  /** Whether the engine is shutting down, so sessions that lose their socket are not kept. */
  readonly closing: () => boolean
  readonly sessions: SessionTable
  readonly subscriptions: Subscriptions
  readonly contexts: SessionContexts
  readonly mutations: MutationRunner
}

function rateLimitedWire(seconds: number): WireError {
  return {
    code: ErrorCode.RateLimited,
    msg: `Too many messages. Retry in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`,
  }
}

function randomId(): string {
  const bytes = new Uint8Array(12)
  globalThis.crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString("base64url")
}

function contextKey(ctx: RequestContext): string {
  return canonicalString({ roles: [...ctx.roles].sort(), claims: ctx.claims, ctx: ctx.ctx ?? null })
}

/**
 * Connections and their sessions: the `hello` handshake and resume, per caller limits, token expiry and
 * reauthentication, dispatch of client frames, and the end of a session (closed, replaced, expired,
 * revoked or drained).
 */
export class SessionLifecycle {
  private readonly deps: SessionLifecycleOptions

  constructor(deps: SessionLifecycleOptions) {
    this.deps = deps
  }

  /** Accepts a new connection from any transport. */
  connect(socket: RealtimeSocket, info: ConnectInfo = {}): ConnectionHandler {
    const { options, limits, metrics } = this.deps
    let state: SessionState | undefined
    const slot: AnonymousSlot = { release: undefined }
    let helloPending = true
    let lastInbound = Date.now()
    const helloTimer = setTimeout(() => {
      if (helloPending) socket.close(CloseCode.HelloTimeout, "no hello received")
    }, 10_000)
    const heartbeat = options.heartbeatMs ?? 25_000
    const silenceTimer = setInterval(
      () => {
        if (Date.now() - lastInbound > 2 * heartbeat + 10_000)
          socket.close(1001, "heartbeat timeout")
      },
      Math.min(5000, heartbeat),
    )
    metrics.connections.add(1)
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
        if (text.length > limits.maxFrameBytes) {
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
          this.hello(socket, message, info.address, slot).then(
            (result) => {
              if (closed) {
                slot.release?.()
                result.session.disconnect()
                this.scheduleDrop(result)
                return
              }
              state = result
            },
            (error: unknown) => {
              const canopy = toCanopyError(error)
              fail(
                canopy.code === ErrorCode.Forbidden
                  ? CloseCode.Forbidden
                  : canopy.code === ErrorCode.RateLimited
                    ? CloseCode.RateLimited
                    : CloseCode.Unauthorized,
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
        slot.release?.()
        clearTimeout(helloTimer)
        clearInterval(silenceTimer)
        metrics.connections.add(-1)
        if (state === undefined) return
        if (state.socket === socket) {
          state.socket = undefined
          state.session.disconnect()
          this.scheduleDrop(state)
        }
      },
    }
  }

  private async hello(
    socket: RealtimeSocket,
    hello: HelloMessage,
    address: string | undefined,
    slot: AnonymousSlot,
  ): Promise<SessionState> {
    const { options, limits, metrics, sessions } = this.deps
    if (hello.v !== PROTOCOL_VERSION) {
      socket.close(CloseCode.UnsupportedVersion, "unsupported protocol version")
      throw new CanopyError(ErrorCode.ProtocolError, "Unsupported protocol version")
    }
    const rateLimits = options.rateLimits
    const authenticate = () => this.deps.auth.authenticate(hello.key, hello.token)
    const principal =
      rateLimits === undefined || address === undefined
        ? await authenticate()
        : await rateLimits.guardAuthentication(address, authenticate).catch((error: unknown) => {
            if (toCanopyError(error).code === ErrorCode.RateLimited)
              metrics.rateLimited.inc({ kind: "authentication" })
            throw error
          })
    if (rateLimits !== undefined && principal.subject === "anon" && address !== undefined) {
      slot.release?.()
      slot.release = rateLimits.openAnonymousConnection(address)
      if (slot.release === undefined) {
        metrics.rateLimited.inc({ kind: "connection" })
        throw new CanopyError(ErrorCode.RateLimited, "Too many connections from this address")
      }
    }
    const caps = new Set((hello.caps ?? []).filter((cap) => cap === "batch" || cap === "diff"))
    const welcome = (sid: string, resumed: boolean) => ({
      t: "welcome" as const,
      sid,
      v: PROTOCOL_VERSION,
      resumed,
      hb: options.heartbeatMs ?? 25_000,
      pv: this.deps.engine().version,
      ct: this.deps.position(),
      caps: [...caps],
      capabilities: { mutations: options.mutations !== undefined },
      limits: { subs: limits.maxSubscriptionsPerConnection },
    })
    const resume = hello.resume
    if (resume !== undefined) {
      const existing = sessions.get(resume.sid)
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
          existing.address = address
          existing.principal = principal
          existing.session.connect(socket, welcome(existing.session.sid, true))
          existing.session.replayAfter(resume.seq)
          this.armExpiry(existing)
          return existing
        }
        this.destroy(existing)
      }
    }
    const count = this.makeRoom(principal.subject)
    if (principal.subject !== "anon" && count >= limits.maxConnectionsPerSubject) {
      throw new CanopyError(ErrorCode.RateLimited, "Too many connections for this subject")
    }
    const sid = `${options.nodeId ?? "n1"}.${randomId()}`
    const session = new Session(sid, caps, {
      resumeBufferBytes: limits.resumeBufferBytes,
      softQueueBytes: limits.softQueueBytes,
      hardQueueBytes: limits.hardQueueBytes,
    })
    const state: SessionState = {
      session,
      key: hello.key,
      address,
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
      metrics.slowConsumers.inc()
      state.socket?.close(CloseCode.SlowConsumer, "slow consumer")
      this.destroy(state)
    }
    session.onSubscriptionFailed = (subId, error) =>
      this.deps.subscriptions.failed(state, subId, error)
    sessions.add(state)
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
          this.deps.subscriptions.drop(state, id)
          state.session.send({
            t: "nosub",
            s: id,
            err: { code: ErrorCode.TokenExpired, msg: "The token expired" },
          })
        }
        state.session.close(CloseCode.Unauthorized, "token expired")
        this.destroy(state)
      }, this.deps.options.expiryGraceMs ?? 30_000)
    }, delay)
  }

  /**
   * Spends a token of the caller's message budget. Returns the seconds to wait when it is over, else 0.
   * Anonymous connections without an address are in process and limited by their transport.
   */
  private overBudget(state: SessionState): number {
    const limits = this.deps.options.rateLimits
    if (limits === undefined) return 0
    const { principal } = state
    if (principal.subject === "anon" && state.address === undefined) return 0
    const wait = limits.message({
      key: principal.keyId ?? state.key,
      subject: principal.subject,
      roles: principal.context.roles,
      address: state.address ?? "",
    })
    if (wait === 0) return 0
    this.deps.metrics.rateLimited.inc({ kind: "message" })
    return retryAfterSeconds(wait)
  }

  private dispatch(state: SessionState, socket: RealtimeSocket, message: ClientMessage): void {
    const { subscriptions } = this.deps
    switch (message.t) {
      case "ping":
        socket.send(encodeMessage({ t: "pong", ts: message.ts }))
        return
      case "sub": {
        const wait = this.overBudget(state)
        if (wait > 0) {
          state.session.send({ t: "nosub", s: message.id, err: rateLimitedWire(wait) })
          return
        }
        subscriptions.subscribe(state, message)
        return
      }
      case "unsub":
        if (state.pendingSubs.delete(message.id)) {
          state.session.send({ t: "nosub", s: message.id })
        } else if (state.subs.has(message.id)) {
          subscriptions.drop(state, message.id)
          state.session.send({ t: "nosub", s: message.id })
        }
        return
      case "auth": {
        const wait = this.overBudget(state)
        if (wait > 0) {
          state.session.send({ t: "err", ...rateLimitedWire(wait) })
          return
        }
        this.reauthenticate(state, message.token)
        return
      }
      case "mut": {
        const wait = this.overBudget(state)
        if (wait > 0) {
          state.session.send({ t: "ack", m: message.id, ok: false, err: rateLimitedWire(wait) })
          return
        }
        this.deps.mutations.enqueue(state, message)
        return
      }
      case "bye":
        this.destroy(state)
        socket.close(CloseCode.Normal, "bye")
        return
      case "hello":
        socket.close(CloseCode.ProtocolError, "duplicate hello")
        return
    }
  }

  private reauthenticate(state: SessionState, token: string): void {
    const { sessions, subscriptions, contexts } = this.deps
    const before = contextKey(state.principal.context)
    this.deps.auth.authenticate(state.key, token).then(
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
          this.destroy(state)
          return
        }
        state.principal = principal
        this.armExpiry(state)
        if (contextKey(principal.context) !== before) {
          const resyncChanged = (): void => {
            if (!sessions.has(state)) return
            const affected = [...state.subs.values()]
              .filter((sub) => subscriptions.observerKeyFor(state, sub) !== sub.observer.key)
              .map((sub) => sub.id)
            subscriptions.resync(state, affected, "auth")
          }
          const names = this.deps
            .engine()
            .contextNames(
              new Set([...state.subs.values()].map((sub) => sub.coll)),
              principal.context.roles,
            )
          if (state.ctxKeys.size === 0 && names.length === 0) {
            resyncChanged()
            return
          }
          contexts.clear(state)
          contexts.load(state, names).then(resyncChanged, () => {})
        }
      },
      (error: unknown) => {
        const canopy = toCanopyError(error)
        state.session.send({ t: "err", code: canopy.code, msg: canopy.message })
        state.session.close(CloseCode.Unauthorized, canopy.code)
        this.destroy(state)
      },
    )
  }

  /**
   * The subject's session count once there is room for a new session: at the limit, its oldest sessions
   * that only wait for a resume (their tab was closed or reloaded) are dropped first, so only connected
   * sessions count against `maxConnectionsPerSubject`.
   */
  private makeRoom(subject: string): number {
    const { sessions, limits } = this.deps
    let count = sessions.countOf(subject)
    if (subject === "anon" || count < limits.maxConnectionsPerSubject) return count
    const waiting = [...sessions.values()]
      .filter((state) => state.principal.subject === subject && state.socket === undefined)
      .sort((a, b) => (a.session.disconnectedAt ?? 0) - (b.session.disconnectedAt ?? 0))
    for (const state of waiting) {
      if (count < limits.maxConnectionsPerSubject) break
      this.destroy(state)
      count = sessions.countOf(subject)
    }
    return count
  }

  /**
   * Keeps a session whose socket went away for the resume window. A session that already ended (`bye`, an
   * engine shutdown) has nothing to resume, and a timer for it would only hold its memory and keep the
   * process alive until it fires.
   */
  private scheduleDrop(state: SessionState): void {
    if (this.deps.closing() || !this.deps.sessions.has(state)) return
    if (state.dropTimer !== undefined) clearTimeout(state.dropTimer)
    state.dropTimer = setTimeout(
      () => this.destroy(state),
      this.deps.options.resumeWindowMs ?? 120_000,
    )
  }

  /** Ends a session: drops its subscriptions, releases its context lookups and stops its timers. */
  destroy(state: SessionState): void {
    const { sessions, subscriptions } = this.deps
    if (!sessions.has(state)) return
    for (const id of [...state.subs.keys()]) subscriptions.drop(state, id)
    state.pendingSubs.clear()
    this.deps.contexts.clear(state)
    for (const timer of [state.expiryTimer, state.graceTimer, state.dropTimer])
      if (timer !== undefined) clearTimeout(timer)
    sessions.remove(state)
  }

  /**
   * Ends every session whose principal matches, connected or waiting for a resume: the client gets `err`
   * and the socket closes with `code`. Returns the number of sessions ended.
   */
  closeMatching(matches: (principal: Principal) => boolean, code: number, reason: string): number {
    let count = 0
    for (const state of [...this.deps.sessions.values()]) {
      if (!matches(state.principal)) continue
      count += 1
      state.session.send({ t: "err", code: ErrorCode.Forbidden, msg: reason })
      state.session.close(code, reason)
      state.socket = undefined
      this.destroy(state)
    }
    return count
  }

  /**
   * Sends every session `reconnect` with a random delay within `drainMs`, closes each socket with 1012
   * when its delay has passed, and ends every session by the end of the window.
   */
  async drain(drainMs: number): Promise<void> {
    const { sessions } = this.deps
    const timers: ReturnType<typeof setTimeout>[] = []
    for (const state of sessions.values()) {
      const retryAfterMs = Math.floor(Math.random() * drainMs)
      state.session.send({ t: "reconnect", retryAfterMs, reason: "shutdown" })
      state.session.flush()
      timers.push(
        setTimeout(() => {
          if (sessions.get(state.session.sid) !== state) return
          state.session.close(CloseCode.ServiceRestart, "shutdown")
          this.destroy(state)
        }, retryAfterMs),
      )
    }
    const deadline = Date.now() + drainMs
    for (;;) {
      for (const state of [...sessions.values()])
        if (state.socket === undefined) this.destroy(state)
      if (sessions.size === 0 || Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())))
    }
    for (const timer of timers) clearTimeout(timer)
    for (const state of [...sessions.values()]) {
      state.session.close(CloseCode.ServiceRestart, "shutdown")
      this.destroy(state)
    }
  }
}
