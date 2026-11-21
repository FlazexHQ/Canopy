import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { resolveConfig } from "@canopy/config"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { findGatewayBinary, gatewayConfig } from "../src/gateway.ts"

const BINARY = process.platform === "win32" ? "canopy-gateway.exe" : "canopy-gateway"
const URI = "mongodb://localhost:27017/?replicaSet=rs0"

function resolved(input: Record<string, unknown>) {
  return resolveConfig(
    { mongodb: { uri: URI, database: "app" }, ...input },
    { env: {}, baseDir: process.cwd(), cwd: process.cwd(), command: "realtime" },
  ).config
}

describe("findGatewayBinary", () => {
  let dir: string
  let empty: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "canopy-gateway-find-"))
    empty = join(dir, "empty")
    await mkdir(empty)
    for (const folder of ["beside", "path", join("repo", "target", "release")])
      await mkdir(join(dir, folder), { recursive: true })
    for (const folder of ["beside", "path", join("repo", "target", "release")])
      await writeFile(join(dir, folder, BINARY), "")
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("prefers CANOPY_GATEWAY_BIN, then a Cargo build, then the executable's folder, then PATH", () => {
    const exec = join(dir, "beside", "canopy")
    const path = [join(dir, "missing"), join(dir, "path")].join(delimiter)
    expect(findGatewayBinary({ CANOPY_GATEWAY_BIN: "x/gw", PATH: path }, exec, empty)).toBe(
      join(process.cwd(), "x", "gw"),
    )
    expect(findGatewayBinary({ PATH: path }, exec, join(dir, "repo", "packages"))).toBe(
      join(dir, "repo", "target", "release", BINARY),
    )
    expect(findGatewayBinary({ PATH: path }, exec, empty)).toBe(join(dir, "beside", BINARY))
    expect(findGatewayBinary({ PATH: path }, join(empty, "canopy"), empty)).toBe(
      join(dir, "path", BINARY),
    )
    expect(findGatewayBinary({ Path: path }, join(empty, "canopy"), empty)).toBe(
      join(dir, "path", BINARY),
    )
    expect(findGatewayBinary({ PATH: join(dir, "missing") }, join(empty, "canopy"), empty)).toBe(
      undefined,
    )
  })
})

describe("gatewayConfig", () => {
  it("passes the transports, the CORS origins and the front door settings", () => {
    const config = resolved({
      realtime: { transports: ["websocket", "sse"] },
      cors: { origins: ["https://app.test"] },
    })
    const json = gatewayConfig(
      config,
      undefined,
      {},
      {
        port: 9000,
        metricsPort: 0,
        metricsHost: "127.0.0.1",
        proxyUrl: "http://127.0.0.1:4000",
        mutationsUrl: "http://127.0.0.1:4000/rest/v1",
      },
    )
    expect(json["realtime"]).toMatchObject({ transports: ["websocket", "sse"] })
    expect(json["cors"]).toEqual({ origins: ["https://app.test"] })
    expect(json["server"]).toMatchObject({ port: 9000, metricsPort: 0, metricsHost: "127.0.0.1" })
    expect(json["proxy"]).toEqual({ url: "http://127.0.0.1:4000" })
    expect(json["mutations"]).toEqual({ url: "http://127.0.0.1:4000/rest/v1" })
  })

  it("takes the mutation URL from the environment without an override, and has no proxy by default", () => {
    const json = gatewayConfig(resolved({}), undefined, {
      CANOPY_GATEWAY_MUTATIONS_URL: "http://rest.internal/rest/v1",
    })
    expect(json["mutations"]).toEqual({ url: "http://rest.internal/rest/v1" })
    expect(json["proxy"]).toBeUndefined()
    expect(json["cors"]).toBeUndefined()
  })

  it("refuses built in auth unless the launcher gives the verification, and then uses it", () => {
    const config = resolved({
      auth: { kind: "builtin", secret: "s".repeat(32) },
      publicUrl: "https://api.test",
    })
    expect(() => gatewayConfig(config, undefined, {})).toThrow(TypeError)
    const json = gatewayConfig(
      config,
      undefined,
      {},
      {
        auth: {
          issuer: "https://api.test/auth/v1",
          audience: "https://api.test",
          jwksUrl: "http://127.0.0.1:4000/auth/v1/jwks",
          algorithms: ["EdDSA"],
          rolesClaim: "roles",
        },
      },
    )
    expect(json["auth"]).toEqual({
      issuer: "https://api.test/auth/v1",
      audience: "https://api.test",
      jwksUrl: "http://127.0.0.1:4000/auth/v1/jwks",
      algorithms: ["EdDSA"],
      rolesClaim: "roles",
    })
  })
})
