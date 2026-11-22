import { describe, expect, it } from "vitest"
import { studioService } from "../src/service.ts"

describe("studioService", () => {
  const seen: string[] = []
  const service = studioService(async (request) => {
    seen.push(new URL(request.url).pathname)
    return new Response("studio", { status: 203 })
  })

  it("answers health checks itself", async () => {
    for (const path of ["/healthz", "/readyz"]) {
      const response = await service(new Request(`http://studio.test${path}`))
      expect(response.status).toBe(200)
      expect(await response.text()).toBe("ok")
    }
    expect(seen).toEqual([])
  })

  it("redirects the bare origin to the Studio base path on the same origin", async () => {
    const response = await service(new Request("https://canopy.example.com/"))
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe("https://canopy.example.com/studio/")
    expect(seen).toEqual([])
  })

  it("passes every other path, including unknown ones, to Studio", async () => {
    for (const path of ["/studio/", "/studio/assets/app.js", "/rest/v1/notes", "/healthz/x"]) {
      const response = await service(new Request(`http://studio.test${path}`))
      expect(response.status).toBe(203)
    }
    expect(seen).toEqual(["/studio/", "/studio/assets/app.js", "/rest/v1/notes", "/healthz/x"])
  })
})
