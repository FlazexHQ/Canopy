import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { isLoopbackHost, serveMetrics } from "../src/index.ts"

const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

async function start(token?: string): Promise<string> {
  const server = await serveMetrics({
    port: 0,
    host: "127.0.0.1",
    token,
    render: () => "canopy_up 1\n",
  })
  servers.push(server)
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe("serveMetrics", () => {
  it("serves the text exposition on /metrics and 404 elsewhere", async () => {
    const base = await start()
    const response = await fetch(`${base}/metrics`)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/plain; version=0.0.4")
    expect(await response.text()).toBe("canopy_up 1\n")
    expect((await fetch(`${base}/`)).status).toBe(404)
    expect((await fetch(`${base}/metrics/x`)).status).toBe(404)
  })

  it("binds the host it is given", async () => {
    const server = await serveMetrics({ port: 0, host: "127.0.0.1", render: () => "" })
    servers.push(server)
    expect((server.address() as AddressInfo).address).toBe("127.0.0.1")
  })

  it("requires the bearer token when one is set", async () => {
    const base = await start("s3cret-metrics-token")
    const missing = await fetch(`${base}/metrics`)
    expect(missing.status).toBe(401)
    expect(missing.headers.get("www-authenticate")).toBe('Bearer realm="metrics"')
    expect(await missing.text()).toBe("")
    const wrong = await fetch(`${base}/metrics`, {
      headers: { authorization: "Bearer s3cret-metrics-tokeN" },
    })
    expect(wrong.status).toBe(401)
    const basic = await fetch(`${base}/metrics`, {
      headers: { authorization: "Basic s3cret-metrics-token" },
    })
    expect(basic.status).toBe(401)
    const right = await fetch(`${base}/metrics`, {
      headers: { authorization: "bearer s3cret-metrics-token" },
    })
    expect(right.status).toBe(200)
    expect(await right.text()).toBe("canopy_up 1\n")
  })

  it("rejects when the port is taken", async () => {
    const server = await serveMetrics({ port: 0, host: "127.0.0.1", render: () => "" })
    servers.push(server)
    const port = (server.address() as AddressInfo).port
    await expect(serveMetrics({ port, host: "127.0.0.1", render: () => "" })).rejects.toMatchObject(
      {
        code: "EADDRINUSE",
      },
    )
  })
})

describe("isLoopbackHost", () => {
  it("knows loopback addresses from the rest", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]", "LOCALHOST"])
      expect(isLoopbackHost(host)).toBe(true)
    for (const host of [
      "0.0.0.0",
      "::",
      "10.0.0.1",
      "128.0.0.1",
      "example.com",
      "127.0.0.1.nip.io",
    ])
      expect(isLoopbackHost(host)).toBe(false)
  })
})
