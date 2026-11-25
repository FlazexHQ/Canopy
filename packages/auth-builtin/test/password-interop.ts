import { readFileSync } from "node:fs"
import { symmetricEncrypt } from "better-auth/crypto"
import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from "jose"
import { hashArgon2id } from "../src/password-hashing.ts"
import { verifyAppPassword } from "../src/passwords.ts"
import { decryptBetterAuth, signedCookieValue } from "./conformance/formats.ts"

const input: unknown = JSON.parse(readFileSync(0, "utf8"))
const mode = process.argv[2]
if (mode === "tokens") {
  if (!Array.isArray(input)) throw new Error("Expected token verification cases")
  for (const entry of input) {
    const { token, jwks, publicUrl, now, valid } = entry as {
      token: string
      jwks: JSONWebKeySet
      publicUrl: string
      now: number
      valid: boolean
    }
    const verified = await jwtVerify(token, createLocalJWKSet(jwks), {
      algorithms: ["EdDSA", "ES256"],
      issuer: `${publicUrl}/auth/v1`,
      audience: publicUrl,
      clockTolerance: 60,
      requiredClaims: ["exp", "iat", "sub"],
      currentDate: new Date(now),
    }).then(
      () => true,
      () => false,
    )
    if (verified !== valid) throw new Error("Unexpected access token verification result")
  }
} else if (mode === "encrypt" || mode === "decrypt" || mode === "cookies") {
  if (
    typeof input !== "object" ||
    input === null ||
    !("secret" in input) ||
    typeof input.secret !== "string"
  ) {
    throw new Error("Expected an auth secret")
  }
  if (mode === "cookies") {
    if (!("payloads" in input) || !Array.isArray(input.payloads)) {
      throw new Error("Expected cookie payloads")
    }
    const secret = input.secret
    process.stdout.write(
      JSON.stringify(
        input.payloads.map((payload: unknown) => {
          if (typeof payload !== "string") throw new Error("Expected a cookie payload")
          const value = signedCookieValue(secret, payload)
          return { value, wire: encodeURIComponent(value) }
        }),
      ),
    )
  } else {
    if (!("data" in input) || typeof input.data !== "string") throw new Error("Expected data")
    process.stdout.write(
      mode === "encrypt"
        ? await symmetricEncrypt({ key: input.secret, data: input.data })
        : decryptBetterAuth(input.secret, input.data),
    )
  }
} else {
  if (
    typeof input !== "object" ||
    input === null ||
    !("password" in input) ||
    typeof input.password !== "string"
  ) {
    throw new Error("Expected a password")
  }

  switch (mode) {
    case "hash":
      process.stdout.write(await hashArgon2id(input.password))
      break
    case "verify":
      if (!("hash" in input) || typeof input.hash !== "string") throw new Error("Expected a hash")
      process.exitCode = (await verifyAppPassword(input.password, input.hash)) ? 0 : 1
      break
    default:
      throw new Error("Expected hash or verify")
  }
}
