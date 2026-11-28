import { createHash, pbkdf2Sync, scryptSync } from "node:crypto"
import type { ImportedPasswordHash } from "@canopy/auth"
import { argon2id, bcrypt } from "hash-wasm"

/** A password hash of another system, with the password it was made from. */
export interface LegacyUser {
  readonly email: string
  readonly password: string
  readonly kind: string
  readonly passwordHash: ImportedPasswordHash
}

const salt = (label: string, length = 16): Buffer =>
  createHash("sha256").update(`canopy auth oracle salt ${label}`).digest().subarray(0, length)

function pbkdf2(
  algorithm: "pbkdf2-sha1" | "pbkdf2-sha256" | "pbkdf2-sha512",
  password: string,
): ImportedPasswordHash {
  const iterations = 1000
  const digest = algorithm.slice("pbkdf2-".length)
  const bytes = digest === "sha1" ? 20 : digest === "sha256" ? 32 : 64
  const saltBytes = salt(algorithm)
  return {
    algorithm,
    iterations,
    salt: saltBytes.toString("base64"),
    hash: pbkdf2Sync(password, saltBytes, iterations, bytes, digest).toString("base64"),
  }
}

/**
 * One user for each imported hash kind, made from fixed salts so the hashes never change: bcrypt (cost 4),
 * PBKDF2 with SHA-1, SHA-256 and SHA-512, Firebase's modified scrypt (its published example) and Argon2id
 * with other parameters than the native ones.
 */
export async function legacyUsers(): Promise<LegacyUser[]> {
  return [
    {
      email: "bcrypt@example.com",
      password: "bcrypt password 1",
      kind: "bcrypt",
      passwordHash: {
        algorithm: "bcrypt",
        hash: await bcrypt({
          password: "bcrypt password 1",
          salt: salt("bcrypt"),
          costFactor: 4,
          outputType: "encoded",
        }),
      },
    },
    ...(["pbkdf2-sha1", "pbkdf2-sha256", "pbkdf2-sha512"] as const).map((algorithm) => ({
      email: `${algorithm}@example.com`,
      password: `${algorithm} password 1`,
      kind: algorithm,
      passwordHash: pbkdf2(algorithm, `${algorithm} password 1`),
    })),
    {
      email: "firebase@example.com",
      password: "user1password",
      kind: "firebase-scrypt",
      passwordHash: {
        algorithm: "firebase-scrypt",
        signerKey:
          "jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZJzxUECKbm0QsEmYUSDzZvpjeJ9WmXA==",
        saltSeparator: "Bw==",
        rounds: 8,
        memCost: 14,
        salt: "42xEC+ixf3L2lw==",
        hash: "lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ==",
      },
    },
    {
      email: "argon2@example.com",
      password: "argon2 password 1",
      kind: "argon2id",
      passwordHash: {
        algorithm: "argon2id",
        hash: await argon2id({
          password: "argon2 password 1",
          salt: salt("argon2id"),
          parallelism: 1,
          iterations: 2,
          memorySize: 64,
          hashLength: 32,
          outputType: "encoded",
        }),
      },
    },
  ]
}

/** A Better Auth scrypt hash (its format before Canopy hashed with Argon2id), from a fixed salt. */
export function betterAuthScrypt(password: string): string {
  const saltHex = salt("better auth scrypt").toString("hex")
  const key = scryptSync(password.normalize("NFKC"), saltHex, 64, {
    N: 16_384,
    r: 16,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  })
  return `${saltHex}:${key.toString("hex")}`
}
