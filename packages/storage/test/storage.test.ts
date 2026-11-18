import { createHash } from "node:crypto"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Authenticator } from "@canopy/auth"
import { createStorage } from "@canopy/client"
import {
  allow,
  auth,
  ContextResolver,
  collection,
  createPolicySet,
  PolicyEngine,
} from "@canopy/policy"
import { MONGODB_URI } from "@canopy/testing"
import { Transformer } from "@napi-rs/image"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  createStorageHandler,
  ImageRenderer,
  localBackend,
  Storage,
  type StorageHandler,
  UrlSigner,
} from "../src/index.ts"

const ISSUER = "https://idp.example.test/"
const PUBLISHABLE = "canopy_pk_storage"
const SECRET = "canopy_sk_storage"
const MIB = 1024 * 1024

const objects = collection("storage.objects", {
  exposed: true,
  policies: [
    allow.read("authenticated").where({ bucket: "docs", owner: auth("sub") }),
    allow.insert("authenticated").check({ bucket: "docs", owner: auth("sub") }),
    allow
      .update("authenticated")
      .where({ owner: auth("sub") })
      .check({ owner: auth("sub") }),
    allow.delete("authenticated").where({ owner: auth("sub") }),
    allow.read("public").where({ bucket: "avatars" }),
  ],
  fields: { read: { default: { omit: ["metadata.secret"] } } },
})
const strict = collection("storage.objects", {
  exposed: true,
  policies: [allow.read("authenticated").where({ owner: auth("sub") })],
})

const suite = MONGODB_URI === undefined ? describe.skip : describe

suite("storage over HTTP on the local backend", () => {
  const dbName = `canopy_storage_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let client: MongoClient
  let meta: Db
  let handler: StorageHandler
  let root: string
  let engine = new PolicyEngine(createPolicySet([objects]))
  const tokens: Record<"alice" | "bob", string> = { alice: "", bob: "" }

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI ?? "")
    await client.connect()
    meta = client.db(`${dbName}_meta`)
    root = await mkdtemp(join(tmpdir(), "canopy-storage-"))
    await meta.collection("storage_objects").createIndex({ bucket: 1, path: 1 }, { unique: true })
    const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "EdDSA", use: "sig" }
    for (const sub of ["alice", "bob"] as const)
      tokens[sub] = await new SignJWT({ sub })
        .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
        .setIssuer(ISSUER)
        .setIssuedAt()
        .setExpirationTime("10m")
        .sign(pair.privateKey)
    const storage = new Storage({
      client,
      metaDatabase: `${dbName}_meta`,
      policies: () => engine,
      backend: await localBackend({ root }),
      buckets: {
        docs: { public: false, maxFileSize: 12 * MIB, allowedTypes: [] },
        avatars: { public: true, maxFileSize: 1000, allowedTypes: ["image/*"] },
      },
      signer: new UrlSigner("a master key of enough length for tests"),
      partSize: 5 * MIB,
      images: new ImageRenderer({ maxDimension: 500 }),
    })
    handler = createStorageHandler({
      storage,
      authenticator: new Authenticator(
        { jwks: { keys: [jwk] }, issuer: ISSUER },
        { publishable: [PUBLISHABLE], secret: [SECRET] },
      ),
      policies: () => engine,
      contexts: new ContextResolver({ reader: async () => [] }),
    })
  })

  afterAll(async () => {
    await meta.dropDatabase()
    await client.close()
    await rm(root, { recursive: true, force: true })
  })

  const call = (
    method: string,
    path: string,
    as: "alice" | "bob" | "service" | "nobody",
    init: { body?: string | Uint8Array; headers?: Record<string, string> } = {},
  ): Promise<Response> =>
    handler.fetch(
      new Request(`http://canopy.test/storage/v1/${path}`, {
        method,
        headers: {
          ...(as === "nobody" ? {} : { apikey: as === "service" ? SECRET : PUBLISHABLE }),
          ...(as === "alice" || as === "bob" ? { authorization: `Bearer ${tokens[as]}` } : {}),
          ...init.headers,
        },
        ...(init.body === undefined ? {} : { body: init.body }),
      }),
    )
  const filesUnder = async (folder: string): Promise<number> =>
    (await readdir(join(root, folder), { recursive: true, withFileTypes: true })).filter((entry) =>
      entry.isFile(),
    ).length
  const storedFiles = () => filesUnder("objects")
  const partFiles = () => filesUnder("uploads")
  const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex")

  it("stores a file for its owner and serves it with its type, length, etag and a sandbox", async () => {
    const upload = await call("POST", "object/docs/reports/q3.pdf", "alice", {
      body: "%PDF quarterly",
      headers: { "content-type": "application/pdf", "x-metadata": '{"title":"Q3","secret":"s"}' },
    })
    expect(upload.status).toBe(201)
    expect(await upload.json()).toMatchObject({
      bucket: "docs",
      path: "reports/q3.pdf",
      size: 14,
      contentType: "application/pdf",
      etag: sha("%PDF quarterly"),
      owner: "alice",
    })
    const read = await call("GET", "object/docs/reports/q3.pdf", "alice")
    expect(read.status).toBe(200)
    expect(await read.text()).toBe("%PDF quarterly")
    expect(read.headers.get("content-type")).toBe("application/pdf")
    expect(read.headers.get("content-length")).toBe("14")
    expect(read.headers.get("etag")).toBe(`"${sha("%PDF quarterly")}"`)
    expect(read.headers.get("content-security-policy")).toContain("sandbox")
    expect(read.headers.get("x-content-type-options")).toBe("nosniff")
    const cached = await call("GET", "object/docs/reports/q3.pdf", "alice", {
      headers: { "if-none-match": `"${sha("%PDF quarterly")}"` },
    })
    expect(cached.status).toBe(304)
    const head = await call("HEAD", "object/docs/reports/q3.pdf", "alice")
    expect(head.status).toBe(200)
    expect(head.headers.get("content-length")).toBe("14")
  })

  it("serves byte ranges and refuses ranges past the end", async () => {
    const part = await call("GET", "object/docs/reports/q3.pdf", "alice", {
      headers: { range: "bytes=5-13" },
    })
    expect(part.status).toBe(206)
    expect(part.headers.get("content-range")).toBe("bytes 5-13/14")
    expect(await part.text()).toBe("quarterly")
    const tail = await call("GET", "object/docs/reports/q3.pdf", "alice", {
      headers: { range: "bytes=-4" },
    })
    expect(await tail.text()).toBe("erly")
    const open = await call("GET", "object/docs/reports/q3.pdf", "alice", {
      headers: { range: "bytes=10-" },
    })
    expect(await open.text()).toBe("erly")
    const beyond = await call("GET", "object/docs/reports/q3.pdf", "alice", {
      headers: { range: "bytes=14-20" },
    })
    expect(beyond.status).toBe(416)
    expect(beyond.headers.get("content-range")).toBe("bytes */14")
  })

  it("hides another user's file as if it did not exist", async () => {
    expect((await call("GET", "object/docs/reports/q3.pdf", "bob")).status).toBe(404)
    expect((await call("HEAD", "object/docs/reports/q3.pdf", "bob")).status).toBe(404)
    expect((await call("DELETE", "object/docs/reports/q3.pdf", "bob")).status).toBe(404)
    expect(await (await call("GET", "list/docs", "bob")).json()).toEqual({ data: [] })
    const sign = await call("POST", "sign/docs/reports/q3.pdf", "bob", {
      body: JSON.stringify({ expiresIn: 60 }),
      headers: { "content-type": "application/json" },
    })
    expect(sign.status).toBe(404)
    const overwrite = await call("PUT", "object/docs/reports/q3.pdf", "bob", {
      body: "bob was here",
      headers: { "content-type": "text/plain" },
    })
    expect(overwrite.status).toBe(404)
    expect(await (await call("GET", "object/docs/reports/q3.pdf", "alice")).text()).toBe(
      "%PDF quarterly",
    )
    expect((await call("GET", "object/docs/reports/q3.pdf", "nobody")).status).toBe(401)
  })

  it("refuses a second upload to a path without upsert, and a write the check refuses, leaving nothing", async () => {
    const before = await storedFiles()
    const again = await call("POST", "object/docs/reports/q3.pdf", "alice", {
      body: "x",
      headers: { "content-type": "text/plain" },
    })
    expect(again.status).toBe(409)
    const wrongBucket = await call("POST", "object/avatars/alice.png", "alice", {
      body: "png",
      headers: { "content-type": "image/png" },
    })
    expect(wrongBucket.status).toBe(403)
    expect(((await wrongBucket.json()) as { code: string }).code).toBe("CANOPY_POLICY_VIOLATION")
    expect(await storedFiles()).toBe(before)
    expect(
      (
        await call("POST", "object/avatars/a.txt", "service", {
          body: "t",
          headers: { "content-type": "text/plain" },
        })
      ).status,
    ).toBe(422)
    expect(
      (
        await call("POST", "object/avatars/big.png", "service", {
          body: "x".repeat(1001),
          headers: { "content-type": "image/png" },
        })
      ).status,
    ).toBe(413)
    expect((await call("POST", "object/nope/a.txt", "alice", { body: "x" })).status).toBe(404)
    expect((await call("POST", "object/docs/a%2F..%2Fb.txt", "alice", { body: "x" })).status).toBe(
      400,
    )
    expect(await storedFiles()).toBe(before)
  })

  it("replaces a file for its owner and drops the old content", async () => {
    const before = await storedFiles()
    const replaced = await call("PUT", "object/docs/reports/q3.pdf", "alice", {
      body: "%PDF revised",
      headers: { "content-type": "application/pdf" },
    })
    expect(replaced.status).toBe(200)
    expect(await (await call("GET", "object/docs/reports/q3.pdf", "alice")).text()).toBe(
      "%PDF revised",
    )
    expect(await storedFiles()).toBe(before)
    const stored = await meta.collection("storage_objects").findOne({ path: "reports/q3.pdf" })
    expect(stored?.["owner"]).toBe("alice")
    expect(stored?.["metadata"]).toEqual({ title: "Q3", secret: "s" })
  })

  it("lists by prefix in pages, with the field rules applied", async () => {
    for (const name of ["reports/q1.pdf", "reports/q2.pdf", "notes/n.txt"])
      expect(
        (
          await call("POST", `object/docs/${name}`, "alice", {
            body: name,
            headers: { "content-type": "text/plain" },
          })
        ).status,
      ).toBe(201)
    const first = (await (
      await call("GET", "list/docs?prefix=reports/&limit=2", "alice")
    ).json()) as {
      data: { path: string; metadata: Record<string, unknown> }[]
      next?: string
    }
    expect(first.data.map((o) => o.path)).toEqual(["reports/q1.pdf", "reports/q2.pdf"])
    expect(first.next).toBe("reports/q2.pdf")
    const second = (await (
      await call("GET", `list/docs?prefix=reports/&limit=2&after=${first.next ?? ""}`, "alice")
    ).json()) as { data: { path: string; metadata: Record<string, unknown> }[]; next?: string }
    expect(second.data.map((o) => o.path)).toEqual(["reports/q3.pdf"])
    expect(second.next).toBeUndefined()
    expect(second.data[0]?.metadata).toEqual({ title: "Q3" })
    expect(
      (await call("GET", "list/docs?prefix=re.orts", "alice").then((r) => r.json())) as {
        data: []
      },
    ).toEqual({ data: [] })
  })

  it("signs a URL anyone can read until it expires", async () => {
    const signed = await call("POST", "sign/docs/reports/q3.pdf", "alice", {
      body: JSON.stringify({ expiresIn: 60 }),
      headers: { "content-type": "application/json" },
    })
    expect(signed.status).toBe(200)
    const { url } = (await signed.json()) as { url: string }
    expect(url).toMatch(/^\/storage\/v1\/signed\/docs\/reports\/q3\.pdf\?token=/)
    const read = await handler.fetch(new Request(`http://canopy.test${url}`))
    expect(read.status).toBe(200)
    expect(await read.text()).toBe("%PDF revised")
    const other = await handler.fetch(
      new Request(`http://canopy.test${url.replace("q3.pdf", "q1.pdf")}`),
    )
    expect(other.status).toBe(401)
    const forged = await handler.fetch(new Request(`http://canopy.test${url.slice(0, -2)}xx`))
    expect(forged.status).toBe(401)
    const tooLong = await call("POST", "sign/docs/reports/q3.pdf", "alice", {
      body: JSON.stringify({ expiresIn: 8 * 86_400 }),
      headers: { "content-type": "application/json" },
    })
    expect(tooLong.status).toBe(400)
    const expired = new UrlSigner("a master key of enough length for tests").sign({
      bucket: "docs",
      path: "reports/q3.pdf",
      expiresAt: Date.now() - 1,
    })
    expect(
      (
        await handler.fetch(
          new Request(`http://canopy.test/storage/v1/signed/docs/reports/q3.pdf?token=${expired}`),
        )
      ).status,
    ).toBe(401)
  })

  it("serves public buckets to anyone and only public buckets", async () => {
    expect(
      (
        await call("POST", "object/avatars/alice.png", "service", {
          body: "png!",
          headers: { "content-type": "image/png" },
        })
      ).status,
    ).toBe(201)
    const read = await handler.fetch(
      new Request("http://canopy.test/storage/v1/public/avatars/alice.png?download"),
    )
    expect(read.status).toBe(200)
    expect(read.headers.get("cache-control")).toBe("public, max-age=3600")
    expect(read.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''alice.png")
    expect(await read.text()).toBe("png!")
    expect(
      (await handler.fetch(new Request("http://canopy.test/storage/v1/public/docs/reports/q3.pdf")))
        .status,
    ).toBe(404)
  })

  it("uploads in parts in any order, resumes, and joins them", async () => {
    const size = 2 * 5 * MIB + 100
    const content = new Uint8Array(size)
    for (let i = 0; i < size; i += 1) content[i] = (i * 31) % 251
    const created = await call("POST", "upload/docs/big/data.bin", "alice", {
      body: JSON.stringify({
        size,
        contentType: "application/octet-stream",
        metadata: { kind: "blob" },
      }),
      headers: { "content-type": "application/json" },
    })
    expect(created.status).toBe(201)
    const status = (await created.json()) as {
      id: string
      partSize: number
      partCount: number
      parts: number[]
    }
    expect(status).toMatchObject({ partSize: 5 * MIB, partCount: 3, parts: [] })
    const part = (n: number) => content.slice((n - 1) * 5 * MIB, Math.min(n * 5 * MIB, size))
    const put = (n: number, body: Uint8Array, as: "alice" | "bob" = "alice") =>
      call("PUT", `uploads/${status.id}/${n}`, as, { body })
    expect((await put(3, part(3))).status).toBe(200)
    expect((await put(1, part(1))).status).toBe(200)
    expect((await put(2, part(2).slice(1))).status).toBe(400)
    expect((await put(2, part(2), "bob")).status).toBe(404)
    expect((await put(4, part(3))).status).toBe(400)
    expect(await (await call("GET", `uploads/${status.id}`, "alice")).json()).toMatchObject({
      parts: [1, 3],
    })
    expect((await call("POST", `uploads/${status.id}/complete`, "alice")).status).toBe(409)
    expect((await put(2, part(2))).status).toBe(200)
    const done = await call("POST", `uploads/${status.id}/complete`, "alice")
    expect(done.status).toBe(201)
    expect(((await done.json()) as { etag: string }).etag).toMatch(/-3$/)
    const read = await call("GET", "object/docs/big/data.bin", "alice")
    expect(read.headers.get("content-length")).toBe(String(size))
    expect(sha(new Uint8Array(await read.arrayBuffer()))).toBe(sha(content))
    expect(await partFiles()).toBe(0)
    expect((await call("GET", `uploads/${status.id}`, "alice")).status).toBe(404)
  })

  it("aborts an upload and drops its parts", async () => {
    const created = await call("POST", "upload/docs/big/aborted.bin", "alice", {
      body: JSON.stringify({ size: 6 * MIB }),
      headers: { "content-type": "application/json" },
    })
    const { id } = (await created.json()) as { id: string }
    expect(
      (await call("PUT", `uploads/${id}/1`, "alice", { body: new Uint8Array(5 * MIB) })).status,
    ).toBe(200)
    expect(await partFiles()).toBe(1)
    expect((await call("DELETE", `uploads/${id}`, "alice")).status).toBe(204)
    expect(await partFiles()).toBe(0)
    expect((await call("GET", "object/docs/big/aborted.bin", "alice")).status).toBe(404)
  })

  it("checks a resumable upload again when it completes", async () => {
    const created = await call("POST", "upload/docs/late.bin", "alice", {
      body: JSON.stringify({ size: 10 }),
      headers: { "content-type": "application/json" },
    })
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: string }
    expect(
      (await call("PUT", `uploads/${id}/1`, "alice", { body: new Uint8Array(10) })).status,
    ).toBe(200)
    const before = await storedFiles()
    const lenient = engine
    engine = new PolicyEngine(createPolicySet([strict]))
    try {
      expect((await call("POST", `uploads/${id}/complete`, "alice")).status).toBe(403)
    } finally {
      engine = lenient
    }
    expect(await storedFiles()).toBe(before)
    expect(await partFiles()).toBe(0)
    expect(await meta.collection("storage_objects").countDocuments({ path: "late.bin" })).toBe(0)
  })

  it("refuses to start an upload the policies refuse", async () => {
    const created = await call("POST", "upload/avatars/x.png", "alice", {
      body: JSON.stringify({ size: 10, contentType: "image/png" }),
      headers: { "content-type": "application/json" },
    })
    expect(created.status).toBe(403)
    expect(await meta.collection("storage_uploads").countDocuments({ bucket: "avatars" })).toBe(0)
  })

  it("transforms images for readers, caches the variant, and serves it again from the cache", async () => {
    const source = await Transformer.fromRgbaPixels(
      new Uint8Array(80 * 40 * 4).fill(200),
      80,
      40,
    ).png()
    expect(
      (
        await call("POST", "object/docs/pics/wide.png", "alice", {
          body: source,
          headers: { "content-type": "image/png" },
        })
      ).status,
    ).toBe(201)
    const path = "render/image/object/docs/pics/wide.png?width=20&format=webp&quality=70"
    const first = await call("GET", path, "alice")
    expect(first.status).toBe(200)
    expect(first.headers.get("content-type")).toBe("image/webp")
    expect(first.headers.get("content-security-policy")).toContain("sandbox")
    const body = new Uint8Array(await first.arrayBuffer())
    expect(first.headers.get("content-length")).toBe(String(body.byteLength))
    const { width, height, format } = await new Transformer(body).metadata()
    expect({ width, height, format }).toEqual({ width: 20, height: 10, format: "webp" })
    const etag = first.headers.get("etag") ?? ""
    expect(etag).toBe(`"${sha(source)}-${etag.slice(-33, -1)}"`)
    const variants = meta.collection("storage_variants")
    expect(await variants.countDocuments()).toBe(1)
    const variant = await variants.findOne()
    expect(variant?.["contentType"]).toBe("image/webp")
    expect(variant?.["size"]).toBe(body.byteLength)
    const again = await call("GET", path, "alice")
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(body)
    expect(await variants.countDocuments()).toBe(1)
    expect((await call("GET", path, "alice", { headers: { "if-none-match": etag } })).status).toBe(
      304,
    )
    const reordered = await call(
      "GET",
      "render/image/object/docs/pics/wide.png?quality=70&format=webp&width=20&resize=cover",
      "alice",
    )
    expect(reordered.headers.get("etag")).toBe(etag)
    expect(await variants.countDocuments()).toBe(1)
  })

  it("applies the read policies, bucket access and limits to transformations", async () => {
    const path = "render/image/object/docs/pics/wide.png?width=20"
    expect((await call("GET", path, "bob")).status).toBe(404)
    expect((await call("GET", path, "nobody")).status).toBe(401)
    expect(
      (await call("GET", "render/image/public/docs/pics/wide.png?width=20", "nobody")).status,
    ).toBe(404)
    expect(
      (await call("GET", "render/image/object/docs/pics/wide.png?width=501", "alice")).status,
    ).toBe(400)
    expect(
      (await call("GET", "render/image/object/docs/reports/q3.pdf?width=20", "alice")).status,
    ).toBe(400)
    expect((await call("GET", "render/image/other/docs/pics/wide.png", "alice")).status).toBe(404)
    const signed = (await (
      await call("POST", "sign/docs/pics/wide.png", "alice", {
        body: JSON.stringify({ expiresIn: 60 }),
        headers: { "content-type": "application/json" },
      })
    ).json()) as { url: string }
    const token = new URL(signed.url, "http://canopy.test").searchParams.get("token") ?? ""
    const viaToken = await call(
      "GET",
      `render/image/signed/docs/pics/wide.png?width=8&format=png&token=${encodeURIComponent(token)}`,
      "nobody",
    )
    expect(viaToken.status).toBe(200)
    expect(
      (await new Transformer(new Uint8Array(await viaToken.arrayBuffer())).metadata()).width,
    ).toBe(8)
    expect(
      (
        await call(
          "GET",
          `render/image/signed/docs/pics/other.png?width=8&token=${encodeURIComponent(token)}`,
          "nobody",
        )
      ).status,
    ).toBe(401)
  })

  it("drops the variants of a file when it is replaced or deleted", async () => {
    const variants = meta.collection("storage_variants")
    const before = await storedFiles()
    expect(await variants.countDocuments()).toBe(2)
    const replacement = await Transformer.fromRgbaPixels(
      new Uint8Array(30 * 30 * 4).fill(9),
      30,
      30,
    ).png()
    expect(
      (
        await call("PUT", "object/docs/pics/wide.png", "alice", {
          body: replacement,
          headers: { "content-type": "image/png" },
        })
      ).status,
    ).toBe(200)
    expect(await variants.countDocuments()).toBe(0)
    expect(await storedFiles()).toBe(before - 2)
    const square = await call("GET", "render/image/object/docs/pics/wide.png?width=20", "alice")
    const { width, height } = await new Transformer(
      new Uint8Array(await square.arrayBuffer()),
    ).metadata()
    expect({ width, height }).toEqual({ width: 20, height: 20 })
    expect(await variants.countDocuments()).toBe(1)
    expect((await call("DELETE", "object/docs/pics/wide.png", "alice")).status).toBe(204)
    expect(await variants.countDocuments()).toBe(0)
    expect(await storedFiles()).toBe(before - 3)
  })

  it("caches at most maxVariants variants of a file and still serves the others", async () => {
    const capped = createStorageHandler({
      storage: new Storage({
        client,
        metaDatabase: `${dbName}_meta`,
        policies: () => engine,
        backend: await localBackend({ root }),
        buckets: { docs: { public: false, maxFileSize: MIB, allowedTypes: [] } },
        signer: new UrlSigner("a master key of enough length for tests"),
        images: new ImageRenderer({ maxVariants: 2 }),
      }),
      authenticator: new Authenticator(
        { jwks: { keys: [] }, issuer: ISSUER },
        { secret: [SECRET] },
      ),
      policies: () => engine,
      contexts: new ContextResolver({ reader: async () => [] }),
    })
    const send = (method: string, path: string, body?: Uint8Array) =>
      capped.fetch(
        new Request(`http://canopy.test/storage/v1/${path}`, {
          method,
          headers: { apikey: SECRET, "content-type": "image/png" },
          ...(body === undefined ? {} : { body }),
        }),
      )
    const source = await Transformer.fromRgbaPixels(
      new Uint8Array(30 * 30 * 4).fill(50),
      30,
      30,
    ).png()
    expect((await send("POST", "object/docs/capped.png", source)).status).toBe(201)
    const stored = await meta.collection("storage_objects").findOne({ path: "capped.png" })
    const variants = meta.collection("storage_variants")
    for (const width of [4, 5, 6, 7]) {
      const response = await send("GET", `render/image/object/docs/capped.png?width=${width}`)
      expect(response.status).toBe(200)
      const body = new Uint8Array(await response.arrayBuffer())
      expect((await new Transformer(body).metadata()).width).toBe(width)
    }
    expect(await variants.countDocuments({ key: stored?.["key"] })).toBe(2)
    expect((await send("DELETE", "object/docs/capped.png")).status).toBe(204)
    expect(await variants.countDocuments({ key: stored?.["key"] })).toBe(0)
  })

  it("serves no transformations when they are off", async () => {
    const off = createStorageHandler({
      storage: new Storage({
        client,
        metaDatabase: `${dbName}_meta`,
        policies: () => engine,
        backend: await localBackend({ root }),
        buckets: { docs: { public: false, maxFileSize: MIB, allowedTypes: [] } },
        signer: new UrlSigner("a master key of enough length for tests"),
      }),
      authenticator: new Authenticator(
        { jwks: { keys: [] }, issuer: ISSUER },
        { secret: [SECRET] },
      ),
      policies: () => engine,
      contexts: new ContextResolver({ reader: async () => [] }),
    })
    const response = await off.fetch(
      new Request("http://canopy.test/storage/v1/render/image/object/docs/x.png?width=5", {
        headers: { apikey: SECRET },
      }),
    )
    expect(response.status).toBe(404)
  })

  it("works end to end with the client SDK", async () => {
    const client = createStorage({
      url: "http://canopy.test",
      publishableKey: PUBLISHABLE,
      auth: { getToken: async () => tokens.alice },
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        handler.fetch(new Request(input, init))) as typeof fetch,
    })
    const docs = client.from("docs")
    const small = await docs.upload("sdk/hello.txt", "hello from the sdk", {
      contentType: "text/plain",
      metadata: { lang: "en" },
    })
    expect(small).toMatchObject({ path: "sdk/hello.txt", size: 18, owner: "alice" })
    expect(await (await docs.download("sdk/hello.txt", { range: [6, 9] })).text()).toBe("from")
    const content = new Uint8Array(5 * MIB + 10).map((_, i) => i % 7)
    const sent: number[] = []
    const large = await docs.uploadResumable("sdk/large.bin", content, {
      onProgress: (bytes) => sent.push(bytes),
    })
    expect(large.size).toBe(content.length)
    expect(sent).toEqual([0, 5 * MIB, 5 * MIB + 10])
    const back = new Uint8Array(await (await docs.download("sdk/large.bin")).arrayBuffer())
    expect(sha(back)).toBe(sha(content))
    expect((await docs.list({ prefix: "sdk/" })).data.map((o) => o.path)).toEqual([
      "sdk/hello.txt",
      "sdk/large.bin",
    ])
    const signed = await docs.createSignedUrl("sdk/hello.txt", 30)
    expect(await (await handler.fetch(new Request(signed))).text()).toBe("hello from the sdk")
    const picture = await Transformer.fromRgbaPixels(
      new Uint8Array(40 * 40 * 4).fill(80),
      40,
      40,
    ).png()
    await docs.upload("sdk/pic.png", picture, { contentType: "image/png" })
    const thumb = await docs.download("sdk/pic.png", { transform: { width: 10, format: "jpeg" } })
    expect(thumb.type).toBe("image/jpeg")
    expect(
      (await new Transformer(new Uint8Array(await thumb.arrayBuffer())).metadata()).width,
    ).toBe(10)
    const signedImage = await docs.createSignedUrl("sdk/pic.png", 30, {
      transform: { height: 4, format: "png" },
    })
    const viaSigned = await handler.fetch(new Request(signedImage))
    expect(viaSigned.headers.get("content-type")).toBe("image/png")
    expect(
      (await new Transformer(new Uint8Array(await viaSigned.arrayBuffer())).metadata()).height,
    ).toBe(4)
    await docs.remove("sdk/pic.png")
    await docs.remove("sdk/hello.txt")
    await docs.remove("sdk/large.bin")
    await expect(docs.download("sdk/hello.txt")).rejects.toMatchObject({ code: "CANOPY_NOT_FOUND" })
  })

  it("deletes a file and its content for its owner", async () => {
    const before = await storedFiles()
    expect((await call("DELETE", "object/docs/reports/q3.pdf", "alice")).status).toBe(204)
    expect((await call("GET", "object/docs/reports/q3.pdf", "alice")).status).toBe(404)
    expect(await storedFiles()).toBe(before - 1)
  })
})
