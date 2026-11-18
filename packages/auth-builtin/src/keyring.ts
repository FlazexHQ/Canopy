import { CanopyError, ErrorCode } from "@canopy/protocol"
import {
  type CryptoKey,
  importJWK,
  type JSONWebKeySet,
  type JWK,
  type JWTVerifyGetKey,
  errors as joseErrors,
} from "jose"
import type { Collection } from "mongodb"
import { acquireLease, type LeaseDocument, releaseLease } from "./lease.ts"
import { type AuthLogger, silentAuthLogger } from "./logger.ts"

/** The signing algorithms built in auth offers. */
export type SigningAlgorithm = "EdDSA" | "ES256"

/** Key material as the JWT engine stores it: the private key may be encrypted. */
export interface KeyMaterial {
  readonly publicKey: string
  readonly privateKey: string
  readonly alg: SigningAlgorithm
  readonly crv?: "Ed25519" | "P-256"
}

/**
 * A signing key in `canopy_auth.signing_keys`. It signs from `createdAt` until `expiresAt`, stays published
 * for verification until `expiresAt` plus the grace period, and is published as soon as it exists, so a key
 * created ahead of time (the standby) reaches remote verifiers before it signs anything.
 */
export interface SigningKeyDocument {
  _id: string
  publicKey: string
  privateKey: string
  alg: SigningAlgorithm
  crv?: "Ed25519" | "P-256"
  createdAt: Date
  expiresAt: Date
  revokedAt?: Date
}

/** A key as the JWT engine reads it. */
export interface EngineKey {
  readonly id: string
  readonly publicKey: string
  readonly privateKey: string
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly alg: SigningAlgorithm
  readonly crv?: "Ed25519" | "P-256"
}

/** A key's state, for the admin API and the CLI. */
export interface SigningKeyInfo {
  readonly kid: string
  readonly alg: SigningAlgorithm
  readonly state: "standby" | "active" | "retired" | "revoked"
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly revokedAt: Date | undefined
}

/** Settings of {@link KeyRing}. */
export interface KeyRingOptions {
  readonly keys: Collection<SigningKeyDocument>
  readonly leases: Collection<LeaseDocument>
  /** Creates key material for the configured algorithm. */
  readonly mint: () => Promise<KeyMaterial>
  readonly algorithm: SigningAlgorithm
  /** How long a key signs. */
  readonly intervalMs: number
  /** How long a retired key stays published. Must cover the access token lifetime. */
  readonly graceMs: number
  /** How often keys are reloaded and the rotation job runs. @default 30000 */
  readonly refreshMs?: number
  readonly owner?: string
  readonly logger?: AuthLogger
  readonly now?: () => number
}

const LEASE = "signing-keys"

/**
 * Canopy's signing keys. One node at a time (holding a lease) rotates them on a schedule: there is always
 * an active key and a standby key that is already published and takes over when the active one expires, so
 * no request ever mints a key and remote verifiers learn new keys before they sign. `revoke` removes a key at
 * once, for emergencies.
 */
export class KeyRing {
  private readonly options: KeyRingOptions
  private readonly owner: string
  private readonly logger: AuthLogger
  private readonly now: () => number
  private cache: SigningKeyDocument[] = []
  private readonly imported = new Map<string, Promise<CryptoKey>>()
  private timer: ReturnType<typeof setInterval> | undefined
  private reloading: Promise<void> | undefined
  private lastReload = 0
  private readonly listeners = new Set<() => void>()

  constructor(options: KeyRingOptions) {
    if (options.graceMs < 0 || options.intervalMs <= 0)
      throw new RangeError(
        "The rotation interval must be positive and the grace period not negative",
      )
    this.options = options
    this.owner = options.owner ?? crypto.randomUUID()
    this.logger = options.logger ?? silentAuthLogger
    this.now = options.now ?? Date.now
  }

  /** Makes sure keys exist, loads them and starts the schedule. */
  async start(): Promise<void> {
    await this.tick()
    for (let attempt = 0; this.activeKey() === undefined && attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      await this.tick()
    }
    if (this.activeKey() === undefined)
      throw new CanopyError(ErrorCode.Unavailable, "No signing key could be created or loaded")
    const refreshMs = this.options.refreshMs ?? 30_000
    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) =>
        this.logger.error({ err: error }, "signing key rotation failed"),
      )
    }, refreshMs)
    this.timer.unref?.()
  }

  /** Runs the rotation job if this node holds the lease, then reloads the keys. */
  async tick(): Promise<void> {
    const refreshMs = this.options.refreshMs ?? 30_000
    const leader = await acquireLease(
      this.options.leases,
      LEASE,
      this.owner,
      Math.max(refreshMs * 3, 10_000),
      new Date(this.now()),
    )
    if (leader) await this.ensure()
    await this.reload()
  }

  /** Calls `listener` whenever the loaded keys change. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async ensure(): Promise<void> {
    const now = this.now()
    const keys = await this.options.keys
      .find({ revokedAt: { $exists: false }, alg: this.options.algorithm })
      .sort({ createdAt: -1 })
      .toArray()
    let active = keys.find((key) => key.createdAt.getTime() <= now && key.expiresAt.getTime() > now)
    if (active === undefined) {
      active = await this.insert(now, now + this.options.intervalMs)
      this.logger.warn({ kid: active._id }, "no active signing key; created one")
    }
    const activeKey = active
    const standby = keys.find((key) => key.createdAt.getTime() > now)
    if (standby === undefined) {
      const from = activeKey.expiresAt.getTime()
      await this.insert(from, from + this.options.intervalMs)
    }
  }

  private async insert(from: number, until: number): Promise<SigningKeyDocument> {
    const material = await this.options.mint()
    const document: SigningKeyDocument = {
      _id: crypto.randomUUID(),
      publicKey: material.publicKey,
      privateKey: material.privateKey,
      alg: material.alg,
      ...(material.crv === undefined ? {} : { crv: material.crv }),
      createdAt: new Date(from),
      expiresAt: new Date(until),
    }
    await this.options.keys.insertOne(document)
    return document
  }

  /** Reads the keys again. */
  async reload(): Promise<void> {
    const keys = await this.options.keys.find({}).sort({ createdAt: -1 }).toArray()
    const before = this.fingerprint(this.cache)
    this.cache = keys
    this.lastReload = this.now()
    for (const kid of this.imported.keys()) {
      const key = keys.find((candidate) => candidate._id === kid)
      if (key === undefined || key.revokedAt !== undefined) this.imported.delete(kid)
    }
    if (this.fingerprint(keys) !== before) for (const listener of this.listeners) listener()
  }

  private fingerprint(keys: readonly SigningKeyDocument[]): string {
    return keys
      .map(
        (key) =>
          `${key._id}:${key.createdAt.getTime()}:${key.expiresAt.getTime()}:${key.revokedAt?.getTime() ?? ""}`,
      )
      .join(",")
  }

  private activeKey(): SigningKeyDocument | undefined {
    const now = this.now()
    return this.cache.find(
      (key) =>
        key.revokedAt === undefined &&
        key.alg === this.options.algorithm &&
        key.createdAt.getTime() <= now &&
        key.expiresAt.getTime() > now,
    )
  }

  private published(): SigningKeyDocument[] {
    const now = this.now()
    return this.cache.filter(
      (key) => key.revokedAt === undefined && key.expiresAt.getTime() + this.options.graceMs > now,
    )
  }

  /** The keys that may sign now, newest first, for the JWT engine. Never includes the standby key. */
  signingKeys(): EngineKey[] {
    const now = this.now()
    return this.cache
      .filter(
        (key) =>
          key.revokedAt === undefined &&
          key.createdAt.getTime() <= now &&
          key.expiresAt.getTime() > now,
      )
      .map((key) => ({
        id: key._id,
        publicKey: key.publicKey,
        privateKey: key.privateKey,
        createdAt: key.createdAt,
        expiresAt: key.expiresAt,
        alg: key.alg,
        ...(key.crv === undefined ? {} : { crv: key.crv }),
      }))
  }

  /** The published key set: standby, active and retired keys within the grace period. */
  jwks(): JSONWebKeySet {
    return {
      keys: this.published().map((key) => ({
        ...(JSON.parse(key.publicKey) as JWK),
        kid: key._id,
        alg: key.alg,
        use: "sig",
      })),
    }
  }

  /** Every key with its state. */
  list(): SigningKeyInfo[] {
    const now = this.now()
    return this.cache.map((key) => ({
      kid: key._id,
      alg: key.alg,
      state:
        key.revokedAt !== undefined
          ? "revoked"
          : key.createdAt.getTime() > now
            ? "standby"
            : key.expiresAt.getTime() > now
              ? "active"
              : "retired",
      createdAt: key.createdAt,
      expiresAt: key.expiresAt,
      revokedAt: key.revokedAt,
    }))
  }

  /**
   * Resolves the verification key of a token from the loaded keys. An unknown `kid` reloads the keys once
   * (at most once a second), so keys made by another node are found without a cache delay.
   */
  readonly resolve: JWTVerifyGetKey = async (header) => {
    const kid = header.kid
    if (kid === undefined) throw new joseErrors.JWKSNoMatchingKey()
    let key = this.published().find((candidate) => candidate._id === kid)
    if (key === undefined && this.now() - this.lastReload >= 1000) {
      this.reloading ??= this.reload().finally(() => {
        this.reloading = undefined
      })
      await this.reloading
      key = this.published().find((candidate) => candidate._id === kid)
    }
    if (key === undefined || (header.alg !== undefined && header.alg !== key.alg))
      throw new joseErrors.JWKSNoMatchingKey()
    let imported = this.imported.get(kid)
    if (imported === undefined) {
      imported = importJWK(JSON.parse(key.publicKey) as JWK, key.alg) as Promise<CryptoKey>
      this.imported.set(kid, imported)
    }
    return imported
  }

  /**
   * Makes the standby key active now and creates a new standby. The previous key stays published for the
   * grace period, so its tokens keep verifying.
   */
  async rotate(): Promise<SigningKeyInfo[]> {
    const now = this.now()
    await this.ensure()
    const keys = await this.options.keys
      .find({ revokedAt: { $exists: false }, alg: this.options.algorithm })
      .sort({ createdAt: 1 })
      .toArray()
    const standby = keys.find((key) => key.createdAt.getTime() > now)
    const active = keys.filter(
      (key) => key.createdAt.getTime() <= now && key.expiresAt.getTime() > now,
    )
    if (standby !== undefined) {
      await this.options.keys.updateOne(
        { _id: standby._id },
        {
          $set: { createdAt: new Date(now), expiresAt: new Date(now + this.options.intervalMs) },
        },
      )
    }
    for (const key of active)
      await this.options.keys.updateOne({ _id: key._id }, { $set: { expiresAt: new Date(now) } })
    await this.ensure()
    await this.reload()
    return this.list()
  }

  /**
   * Revokes a key at once: it leaves the key set and its tokens stop verifying. When it is the active key, the
   * standby takes over first. Other nodes see the change on their next reload.
   */
  async revoke(kid: string): Promise<boolean> {
    const now = this.now()
    const key = await this.options.keys.findOne({ _id: kid })
    if (key === null || key.revokedAt !== undefined) return false
    if (key.createdAt.getTime() <= now && key.expiresAt.getTime() > now) await this.rotate()
    await this.options.keys.updateOne(
      { _id: kid },
      {
        $set: {
          revokedAt: new Date(now),
          expiresAt: new Date(Math.min(now, key.expiresAt.getTime())),
        },
      },
    )
    await this.ensure()
    await this.reload()
    return true
  }

  /** Stops the schedule and gives up the lease. */
  async close(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    await releaseLease(this.options.leases, LEASE, this.owner)
  }
}
