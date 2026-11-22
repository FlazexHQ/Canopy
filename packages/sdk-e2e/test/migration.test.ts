import { readFile } from "node:fs/promises"
import { generateTypes, type ObjectShape } from "@canopy/schema"
import { type CanopyClient, type ClientOptions, ObjectId } from "canopy.js"
import { afterEach, describe, expect, it } from "vitest"
import { Server, ServerSocket } from "./support.ts"

/**
 * The consumers a release must keep compiling: an untyped app, an app typed by the `Database` interface of
 * `canopy gen types`, and an app with a registered `canopy.schema.ts`. Each folder is its own TypeScript
 * program (the registered one augments `Register`), compiled by `tsc -b`; the modules are loaded here by URL
 * so this program stays untyped.
 */
const VARIANTS = ["untyped", "generated", "registered"] as const
const folder = (variant: string): URL => new URL(`./migration/${variant}/`, import.meta.url)

interface App {
  readonly canopy: CanopyClient
  readonly created: PromiseLike<unknown> & { readonly id: unknown }
  readonly completed: PromiseLike<unknown>
  readonly tagged: PromiseLike<unknown>
}

async function load(variant: string): Promise<(options: ClientOptions) => App> {
  const module: unknown = await import(new URL("app.ts", folder(variant)).href)
  if (typeof module !== "object" || module === null || !("app" in module))
    throw new Error(`${variant}/app.ts exports no app`)
  return module.app as (options: ClientOptions) => App
}

afterEach(() => {
  for (const socket of ServerSocket.all) socket.close()
  ServerSocket.all.length = 0
})

describe("the migration fixture", () => {
  it("shares one application source between the three consumers", async () => {
    const [first, ...rest] = await Promise.all(
      VARIANTS.map((variant) => readFile(new URL("app.ts", folder(variant)), "utf8")),
    )
    for (const source of rest) expect(source).toBe(first)
  })

  it("types the generated consumer with what canopy gen types emits for the schema file", async () => {
    const module: unknown = await import(new URL("canopy.schema.ts", folder("registered")).href)
    const { todos } = module as { todos: { name: string; shape: ObjectShape } }
    const generated = await readFile(new URL("canopy.gen.ts", folder("generated")), "utf8")
    expect(generated.replace(/\r\n/g, "\n")).toBe(
      generateTypes([{ name: todos.name, shape: todos.shape, source: "validator" }]),
    )
  })

  it("sends the same subscriptions and mutations whichever way the client is typed", async () => {
    const sent: unknown[] = []
    for (const variant of VARIANTS) {
      const app = (await load(variant))({
        url: "http://canopy.test",
        publishableKey: "pk",
        WebSocket: Server,
      })
      const socket = ServerSocket.all.at(-1)
      if (socket === undefined) throw new Error(`${variant} opened no socket`)
      await socket.accept()
      const stop = app.canopy
        .from("todos")
        .find({ done: false })
        .subscribe(() => {})
      const subscribed = app.canopy
        .from("todos")
        .find({ done: false })
        .sort({ title: 1 })
        .fields({ title: 1 })
        .subscribe(() => {})
      await expect.poll(() => socket.of("mut").length).toBe(3)
      const id = app.created.id
      expect(id).toBeInstanceOf(ObjectId)
      const hex = String(id)
      const frames = [...socket.of("sub"), ...socket.of("mut")].map((frame) =>
        JSON.parse(JSON.stringify(frame).replaceAll(hex, "<created>")),
      )
      for (const handle of [app.created, app.completed, app.tagged])
        void Promise.resolve(handle).catch(() => undefined)
      stop()
      subscribed()
      app.canopy.close()
      sent.push(frames.map(({ id: _id, ...frame }) => frame))
    }
    const [untyped, generated, registered] = sent
    expect(generated).toEqual(untyped)
    expect(registered).toEqual(untyped)
    expect(untyped).toEqual([
      { t: "sub", c: "todos", q: { filter: { done: false } } },
      {
        t: "sub",
        c: "todos",
        q: { filter: { done: false }, sort: { title: 1 }, fields: { title: 1 } },
      },
      {
        t: "mut",
        c: "todos",
        op: "insert",
        args: { doc: { title: "Ship", done: false, ownerId: "u1", _id: { $oid: "<created>" } } },
      },
      {
        t: "mut",
        c: "todos",
        op: "update",
        args: {
          id: { $oid: "<created>" },
          update: { $set: { done: true } },
          where: { done: false },
        },
      },
      {
        t: "mut",
        c: "todos",
        op: "updateMany",
        args: { filter: { ownerId: "u1" }, update: { $push: { tags: "launch" } }, bulk: true },
      },
    ])
  })
})
