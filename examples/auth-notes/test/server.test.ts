import type { AddressInfo } from "node:net"
import { MONGODB_URI } from "@canopy/testing"
import { createAuth } from "canopy.js/auth"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createNotesServer, type NotesServer } from "../src/app.ts"

const suite = MONGODB_URI === undefined ? describe.skip : describe
const KEY = "pk_notes_test"

suite("auth-notes server", () => {
  const database = `notes_test_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let mongo: MongoClient
  let notes: NotesServer
  let base: string
  let address = 0

  /** Signs a new user up and returns a token for them, from a client address of their own. */
  const signUp = async (email: string): Promise<{ id: string; token: string }> => {
    address++
    const forwarded = `10.9.0.${address}`
    const auth = createAuth({
      url: base,
      fetch: (input, init) => {
        const headers = new Headers(init?.headers)
        headers.set("x-forwarded-for", forwarded)
        return fetch(input, { ...init, headers })
      },
    })
    const result = await auth.signUp({ email, password: "a long enough password" })
    if (!("user" in result)) throw new Error("expected to be signed in after sign up")
    const token = await auth.getToken()
    if (token === null) throw new Error("expected a token after sign up")
    return { id: result.user.id, token }
  }

  const rest = (token: string, path: string, init: RequestInit = {}) =>
    fetch(`${base}/rest/v1${path}`, {
      ...init,
      headers: {
        apikey: KEY,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    })

  beforeAll(async () => {
    mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
    notes = await createNotesServer({
      mongoUri: MONGODB_URI ?? "",
      database,
      publicUrl: "http://127.0.0.1",
      publishableKey: KEY,
      masterKey: "m".repeat(48),
      conditions: ["@canopy/source"],
    })
    await new Promise<void>((resolve) => notes.server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(notes.server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await notes?.close()
    for (const suffix of ["", "_meta", "_auth"])
      await mongo.db(`${database}${suffix}`).dropDatabase()
    await mongo.close()
  })

  it("serves the page with the publishable key and the bundled script", async () => {
    const page = await fetch(`${base}/`)
    expect(page.headers.get("content-type")).toContain("text/html")
    expect(await page.text()).toContain(`content="${KEY}"`)
    const script = await fetch(`${base}/app.js`)
    expect(script.status).toBe(200)
    expect(await script.text()).toContain("canopy-notes")
  })

  it("keeps each user's notes private", async () => {
    const ann = await signUp("ann@example.com")
    const ben = await signUp("ben@example.com")
    const created = await rest(ann.token, "/notes", {
      method: "POST",
      body: JSON.stringify({
        _id: "a1",
        text: "ann's note",
        ownerId: ann.id,
        createdAt: { $date: "2026-01-01T00:00:00Z" },
      }),
    })
    expect(created.status).toBe(201)

    const own = await rest(ann.token, "/notes")
    expect(
      ((await own.json()) as { data: { text: string }[] }).data.map((note) => note.text),
    ).toEqual(["ann's note"])
    const other = await rest(ben.token, "/notes")
    expect(((await other.json()) as { data: unknown[] }).data).toEqual([])

    const forged = await rest(ben.token, "/notes", {
      method: "POST",
      body: JSON.stringify({ text: "planted", ownerId: ann.id }),
    })
    expect(forged.status).toBe(403)
    const removed = await rest(ben.token, "/notes/a1", { method: "DELETE" })
    expect(removed.status).toBe(404)
    expect(await mongo.db(database).collection("notes").countDocuments()).toBe(1)
  })

  it("shows anonymous callers nothing and refuses a wrong password", async () => {
    const anonymous = await fetch(`${base}/rest/v1/notes`, { headers: { apikey: KEY } })
    expect(anonymous.status).toBe(200)
    expect(((await anonymous.json()) as { data: unknown[] }).data).toEqual([])
    const auth = createAuth({ url: base })
    await expect(
      auth.signInWithPassword({ email: "ann@example.com", password: "not the password" }),
    ).rejects.toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD" })
  })
})
