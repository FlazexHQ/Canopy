import {
  Authenticator,
  VIEW_TOKEN_AUDIENCE,
  VIEW_TOKEN_CLAIM,
  VIEW_TOKEN_ISSUER,
} from "@canopy/auth"
import { ErrorCode } from "@canopy/protocol"
import { generateKeyPair, SignJWT } from "jose"
import { describe, expect, it } from "vitest"
import { ViewTokens } from "../src/view-tokens.ts"

const KEY = "pk_view"
const MASTER = "m".repeat(48)

function authenticator(tokens: ViewTokens): Authenticator {
  return new Authenticator(undefined, { publishable: [KEY] }, { viewTokens: tokens.verification })
}

async function forged(payload: Record<string, unknown>, ttlSeconds = 60): Promise<string> {
  const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" })
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer(VIEW_TOKEN_ISSUER)
    .setAudience(VIEW_TOKEN_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(privateKey)
}

describe("view tokens", () => {
  it("authenticate as the impersonated user, read only, without accepting user JWTs otherwise", async () => {
    const tokens = new ViewTokens(MASTER)
    const { token, expiresAt } = await tokens.mint({
      roles: ["editor"],
      claims: { sub: "alice", org: "acme" },
    })
    const principal = await authenticator(tokens).authenticate(KEY, token)
    expect(principal.readOnly).toBe(true)
    expect(principal.subject).toBe("alice")
    expect([...principal.context.roles].sort()).toEqual(["authenticated", "editor"])
    expect(principal.context.claims).toEqual({ sub: "alice", org: "acme" })
    expect(principal.expiresAt).toBe(Math.floor(expiresAt.getTime() / 1000) * 1000)
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(300_000)
  })

  it("carry a role without claims, and service only on its own", async () => {
    const tokens = new ViewTokens(MASTER)
    const auth = authenticator(tokens)
    const anon = await auth.authenticate(
      KEY,
      (await tokens.mint({ roles: ["anon"], claims: null })).token,
    )
    expect([...anon.context.roles]).toEqual(["anon"])
    expect(anon.context.claims).toBeNull()
    const service = await auth.authenticate(
      KEY,
      (await tokens.mint({ roles: ["service"], claims: null })).token,
    )
    expect([...service.context.roles]).toEqual(["service"])
    expect(service.readOnly).toBe(true)
    for (const identity of [
      { roles: ["service"], claims: { sub: "alice" } },
      { roles: ["service", "editor"], claims: null },
      { roles: ["anon", "editor"], claims: null },
      { roles: [], claims: null },
    ]) {
      await expect(
        auth.authenticate(KEY, (await tokens.mint(identity)).token),
      ).rejects.toMatchObject({ code: ErrorCode.Unauthorized })
    }
  })

  it("are accepted by every node sharing the master key, and by no other", async () => {
    const { token } = await new ViewTokens(MASTER).mint({ roles: ["anon"], claims: null })
    await expect(
      authenticator(new ViewTokens(MASTER)).authenticate(KEY, token),
    ).resolves.toMatchObject({
      readOnly: true,
    })
    await expect(
      authenticator(new ViewTokens("n".repeat(48))).authenticate(KEY, token),
    ).rejects.toMatchObject({ code: ErrorCode.Unauthorized })
    await expect(
      authenticator(new ViewTokens(undefined)).authenticate(KEY, token),
    ).rejects.toMatchObject({ code: ErrorCode.Unauthorized })
  })

  it("refuse forged, expired and malformed tokens, and still need a known API key", async () => {
    const tokens = new ViewTokens(MASTER)
    const auth = authenticator(tokens)
    await expect(
      auth.authenticate(
        KEY,
        await forged({ [VIEW_TOKEN_CLAIM]: { roles: ["anon"], claims: null } }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.Unauthorized })
    const expired = await tokens.mint({ roles: ["anon"], claims: null }, -120)
    await expect(auth.authenticate(KEY, expired.token)).rejects.toMatchObject({
      code: ErrorCode.TokenExpired,
    })
    const { token } = await tokens.mint({ roles: ["anon"], claims: null })
    await expect(auth.authenticate("pk_unknown", token)).rejects.toMatchObject({
      code: ErrorCode.Unauthorized,
    })
    const withoutViews = new Authenticator(undefined, { publishable: [KEY] })
    await expect(withoutViews.authenticate(KEY, token)).rejects.toMatchObject({
      code: ErrorCode.Unauthorized,
    })
  })
})
