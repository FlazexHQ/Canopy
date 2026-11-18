import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { StorageBackend } from "../src/index.ts"
import { localBackend } from "../src/index.ts"

const encode = (text: string) => new TextEncoder().encode(text)
const text = (stream: ReadableStream<Uint8Array>) => new Response(stream).text()

describe("localBackend", () => {
  let root: string
  let store: StorageBackend

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "canopy-local-"))
    store = await localBackend({ root })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("creates its folders and reports its kind", async () => {
    expect(store.kind).toBe("local")
    expect((await readdir(root)).sort()).toEqual(["objects", "tmp", "uploads"])
  })

  it("stores a file under objects, reads it whole and by range, and deletes it", async () => {
    await store.put("docs/65a1b2c3d4e5f60718293a4b", encode("hello world"), "text/plain")
    expect(await readFile(join(root, "objects", "docs", "65a1b2c3d4e5f60718293a4b"), "utf8")).toBe(
      "hello world",
    )
    expect(await text(await store.get("docs/65a1b2c3d4e5f60718293a4b"))).toBe("hello world")
    expect(
      await text(await store.get("docs/65a1b2c3d4e5f60718293a4b", { start: 6, end: 10 })),
    ).toBe("world")
    expect(await text(await store.get("docs/65a1b2c3d4e5f60718293a4b", { start: 0, end: 0 }))).toBe(
      "h",
    )
    await store.delete("docs/65a1b2c3d4e5f60718293a4b")
    await store.delete("docs/65a1b2c3d4e5f60718293a4b")
    await expect(store.get("docs/65a1b2c3d4e5f60718293a4b")).rejects.toMatchObject({
      code: "CANOPY_NOT_FOUND",
    })
    expect(await readdir(join(root, "tmp"))).toEqual([])
  })

  it("stores variants next to their source key", async () => {
    await store.put("img/abc.variants/0f0f", encode("variant"), "image/webp")
    expect(await text(await store.get("img/abc.variants/0f0f"))).toBe("variant")
  })

  it("refuses keys that leave the folder or that Windows cannot store", async () => {
    for (const key of [
      "../escape",
      "docs/../../escape",
      "docs/..",
      "/absolute",
      "docs//x",
      "docs/x/",
      "C:/x",
      "docs\\x",
      "con/x",
      "docs/NUL.txt",
      "docs/trailing.",
      ".hidden/x",
      "",
    ])
      await expect(store.put(key, encode("x"), "text/plain"), key).rejects.toMatchObject({
        code: "CANOPY_INTERNAL",
      })
    expect(await readdir(join(root, "objects"))).toEqual([])
  })

  it("joins the parts of a multipart upload in part order and removes them", async () => {
    const id = await store.createMultipart("big/0001", "application/octet-stream")
    const second = await store.putPart("big/0001", id, 2, encode("second"))
    const first = await store.putPart("big/0001", id, 1, encode("first,"))
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(first).not.toBe(second)
    expect((await readdir(join(root, "uploads", id))).sort()).toEqual(["1", "2"])
    await store.putPart("big/0001", id, 1, encode("FIRST,"))
    await store.completeMultipart("big/0001", id, [
      { part: 2, etag: second },
      { part: 1, etag: first },
    ])
    expect(await text(await store.get("big/0001"))).toBe("FIRST,second")
    expect(await readdir(join(root, "uploads"))).toEqual([])
  })

  it("fails to join an upload with a missing part and leaves no half file", async () => {
    const id = await store.createMultipart("big/0002", "application/octet-stream")
    await store.putPart("big/0002", id, 1, encode("only one"))
    await expect(
      store.completeMultipart("big/0002", id, [
        { part: 1, etag: "a" },
        { part: 2, etag: "b" },
      ]),
    ).rejects.toMatchObject({ code: "CANOPY_CONFLICT" })
    await expect(store.get("big/0002")).rejects.toMatchObject({ code: "CANOPY_NOT_FOUND" })
    expect(await readdir(join(root, "tmp"))).toEqual([])
  })

  it("aborts an upload, and refuses parts of unknown or malformed uploads", async () => {
    const id = await store.createMultipart("big/0003", "text/plain")
    await store.putPart("big/0003", id, 1, encode("x"))
    await store.abortMultipart("big/0003", id)
    expect(await readdir(join(root, "uploads"))).toEqual([])
    await expect(store.putPart("big/0003", id, 1, encode("x"))).rejects.toMatchObject({
      code: "CANOPY_NOT_FOUND",
    })
    await expect(store.putPart("big/0003", "../../objects", 1, encode("x"))).rejects.toMatchObject({
      code: "CANOPY_NOT_FOUND",
    })
  })

  it("sweeps stale temporary files and old uploads, and keeps recent ones", async () => {
    const old = new Date(Date.now() - 3 * 86_400_000)
    await writeFile(join(root, "tmp", "stale"), "x")
    await utimes(join(root, "tmp", "stale"), old, old)
    await writeFile(join(root, "tmp", "fresh"), "x")
    const abandoned = await store.createMultipart("k/1", "text/plain")
    await utimes(join(root, "uploads", abandoned), old, old)
    const active = await store.createMultipart("k/2", "text/plain")
    const removed = await store.sweep?.(new Date(Date.now() - 86_400_000))
    expect(removed).toBe(2)
    expect(await readdir(join(root, "tmp"))).toEqual(["fresh"])
    expect(await readdir(join(root, "uploads"))).toEqual([active])
  })

  it("fails at startup when the folder cannot be created", async () => {
    const file = join(root, "a-file")
    await writeFile(file, "x")
    await expect(localBackend({ root: join(file, "inside") })).rejects.toThrow(/not writable/)
  })

  it("lets two backends share one folder", async () => {
    await mkdir(join(root, "objects", "shared"), { recursive: true })
    const other = await localBackend({ root })
    await store.put("shared/one", encode("from one"), "text/plain")
    expect(await text(await other.get("shared/one"))).toBe("from one")
  })
})
