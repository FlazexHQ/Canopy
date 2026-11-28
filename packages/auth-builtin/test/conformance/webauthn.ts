import { createHash, createPrivateKey, type KeyObject, sign } from "node:crypto"
import { derivedJwk } from "./determinism.ts"

/** A CBOR value the encoder below writes: the subset WebAuthn uses. */
type Cbor = number | string | Uint8Array | readonly Cbor[] | CborMap

/** A CBOR map with its keys in the order given. */
class CborMap {
  readonly entries: readonly (readonly [number | string, Cbor])[]

  constructor(entries: readonly (readonly [number | string, Cbor])[]) {
    this.entries = entries
  }
}

function head(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length])
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length])
  if (length < 0x10000) {
    const out = Buffer.alloc(3)
    out[0] = (major << 5) | 25
    out.writeUInt16BE(length, 1)
    return out
  }
  const out = Buffer.alloc(5)
  out[0] = (major << 5) | 26
  out.writeUInt32BE(length, 1)
  return out
}

/** Encodes a value as definite length CBOR. */
function cbor(value: Cbor): Buffer {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error("Only integers are encoded")
    return value >= 0 ? head(0, value) : head(1, -1 - value)
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8")
    return Buffer.concat([head(3, bytes.length), bytes])
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value])
  if (value instanceof CborMap)
    return Buffer.concat([
      head(5, value.entries.length),
      ...value.entries.flatMap(([key, item]) => [cbor(key), cbor(item)]),
    ])
  return Buffer.concat([head(4, value.length), ...value.map(cbor)])
}

const sha256 = (data: Uint8Array | string): Buffer => createHash("sha256").update(data).digest()

const FLAG_UP = 0x01
const FLAG_UV = 0x04
const FLAG_BE = 0x08
const FLAG_BS = 0x10
const FLAG_AT = 0x40

/** Settings of a {@link SoftwareAuthenticator}. */
export interface AuthenticatorOptions {
  /** A name for the oracle files. */
  readonly name: string
  /** The credential key: ES256 (COSE -7) on P-256 or EdDSA (COSE -8) on Ed25519. */
  readonly algorithm: "ES256" | "EdDSA"
  /** `none` or `packed` self attestation. */
  readonly attestation: "none" | "packed"
  /** Derives the credential key, the credential id and the AAGUID. */
  readonly seed: string
  /** Whether the signature counter counts; a synced passkey keeps it at zero. */
  readonly counting: boolean
  /** Whether the credential is backed up (a synced passkey). */
  readonly backedUp: boolean
}

/** The parts of the creation or request options the authenticator reads. */
interface PublicKeyOptions {
  readonly challenge: string
  readonly rpId: string
  readonly userId?: string
}

/** What a client sends to `verify-registration` or `verify-authentication`. */
export interface CredentialJson {
  readonly id: string
  readonly rawId: string
  readonly type: "public-key"
  readonly response: Readonly<Record<string, unknown>>
  readonly authenticatorAttachment: "platform"
  readonly clientExtensionResults: Readonly<Record<string, never>>
}

/** Faults a ceremony can be made to carry, for the refusal cases. */
export interface Faults {
  readonly origin?: string
  readonly type?: string
  readonly challenge?: string
  readonly rpId?: string
  readonly noUserVerification?: boolean
  readonly badSignature?: boolean
  readonly counter?: number
}

/**
 * A WebAuthn authenticator in software: one credential, its key derived from a seed, answering registration
 * with a `none` or `packed` self attestation and authentication with an assertion, like a platform
 * authenticator with user verification.
 */
export class SoftwareAuthenticator {
  readonly options: AuthenticatorOptions
  readonly credentialId: Buffer
  readonly aaguid: Buffer
  readonly jwk: Record<string, string>
  private readonly key: KeyObject
  private counter = 0

  constructor(options: AuthenticatorOptions) {
    this.options = options
    this.credentialId = sha256(`credential id ${options.seed}`).subarray(0, 16)
    this.aaguid = sha256(`aaguid ${options.seed}`).subarray(0, 16)
    const jwk = derivedJwk(
      options.algorithm === "ES256" ? "P-256" : "Ed25519",
      sha256(`credential key ${options.seed}`),
    )
    this.jwk = jwk
    this.key = createPrivateKey({ key: jwk, format: "jwk" })
  }

  /** Sets the signature counter, which the next assertion increments (zero starts again). */
  reset(counter = 0): void {
    this.counter = counter
  }

  /** The credential id, base64url. */
  get id(): string {
    return this.credentialId.toString("base64url")
  }

  private coseKey(): Buffer {
    const x = Buffer.from(this.jwk["x"] ?? "", "base64url")
    if (this.options.algorithm === "EdDSA")
      return cbor(
        new CborMap([
          [1, 1],
          [3, -8],
          [-1, 6],
          [-2, x],
        ]),
      )
    return cbor(
      new CborMap([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, x],
        [-3, Buffer.from(this.jwk["y"] ?? "", "base64url")],
      ]),
    )
  }

  private sign(data: Buffer): Buffer {
    const signature =
      this.options.algorithm === "EdDSA"
        ? sign(null, data, this.key)
        : sign("sha256", data, this.key)
    return signature
  }

  private flags(attested: boolean, faults: Faults): number {
    let flags = FLAG_UP
    if (faults.noUserVerification !== true) flags |= FLAG_UV
    if (this.options.backedUp) flags |= FLAG_BE | FLAG_BS
    if (attested) flags |= FLAG_AT
    return flags
  }

  private nextCounter(faults: Faults): number {
    if (faults.counter !== undefined) return faults.counter
    if (!this.options.counting) return 0
    this.counter++
    return this.counter
  }

  private authenticatorData(rpId: string, flags: number, counter: number, attested?: Buffer) {
    const count = Buffer.alloc(4)
    count.writeUInt32BE(counter)
    return Buffer.concat([sha256(rpId), Buffer.from([flags]), count, attested ?? Buffer.alloc(0)])
  }

  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), "utf8")
  }

  /** Answers `navigator.credentials.create` for the given options and origin. */
  register(options: PublicKeyOptions, origin: string, faults: Faults = {}): CredentialJson {
    const length = Buffer.alloc(2)
    length.writeUInt16BE(this.credentialId.length)
    const attested = Buffer.concat([this.aaguid, length, this.credentialId, this.coseKey()])
    const authData = this.authenticatorData(
      faults.rpId ?? options.rpId,
      this.flags(true, faults),
      this.nextCounter(faults),
      attested,
    )
    const clientDataJSON = this.clientData(
      faults.type ?? "webauthn.create",
      faults.challenge ?? options.challenge,
      faults.origin ?? origin,
    )
    let attStmt = new CborMap([])
    if (this.options.attestation === "packed") {
      const signature = this.sign(Buffer.concat([authData, sha256(clientDataJSON)]))
      attStmt = new CborMap([
        ["alg", this.options.algorithm === "EdDSA" ? -8 : -7],
        ["sig", faults.badSignature === true ? Buffer.alloc(signature.length, 1) : signature],
      ])
    }
    const attestationObject = cbor(
      new CborMap([
        ["fmt", this.options.attestation],
        ["attStmt", attStmt],
        ["authData", authData],
      ]),
    )
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        attestationObject: attestationObject.toString("base64url"),
        transports: ["internal"],
      },
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
    }
  }

  /** Answers `navigator.credentials.get` for the given options and origin. */
  authenticate(
    options: PublicKeyOptions,
    origin: string,
    userHandle: string,
    faults: Faults = {},
  ): CredentialJson {
    const authData = this.authenticatorData(
      faults.rpId ?? options.rpId,
      this.flags(false, faults),
      this.nextCounter(faults),
    )
    const clientDataJSON = this.clientData(
      faults.type ?? "webauthn.get",
      faults.challenge ?? options.challenge,
      faults.origin ?? origin,
    )
    const signature = this.sign(Buffer.concat([authData, sha256(clientDataJSON)]))
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        authenticatorData: authData.toString("base64url"),
        signature: (faults.badSignature === true
          ? Buffer.alloc(signature.length, 1)
          : signature
        ).toString("base64url"),
        userHandle,
      },
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
    }
  }

  /** The authenticator as the manifest describes it, private key included. */
  describe(): Record<string, unknown> {
    return {
      name: this.options.name,
      algorithm: this.options.algorithm,
      attestation: this.options.attestation,
      seed: this.options.seed,
      credentialId: this.id,
      aaguid: this.aaguid.toString("hex"),
      counting: this.options.counting,
      backedUp: this.options.backedUp,
      jwk: this.jwk,
    }
  }
}
