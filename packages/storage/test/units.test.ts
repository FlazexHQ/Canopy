import { createHash } from "node:crypto"
import { createServer, type IncomingHttpHeaders, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { r2Backend, s3Backend, signV4, UrlSigner } from "../src/index.ts"
import { checkPath, checkType } from "../src/paths.ts"

describe("signV4", () => {
  // The "GET Object" example of the AWS Signature Version 4 documentation for S3.
  it("matches the AWS example signature", () => {
    const headers = signV4({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { range: "bytes=0-9" },
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      region: "us-east-1",
      service: "s3",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      now: new Date("2013-05-24T00:00:00Z"),
    })
    expect(headers["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    )
    expect(headers["x-amz-date"]).toBe("20130524T000000Z")
  })

  it("signs the query string sorted and encoded, and the session token", () => {
    const sign = (url: string) =>
      signV4({
        method: "POST",
        url: new URL(url),
        headers: {},
        payloadHash: "UNSIGNED-PAYLOAD",
        region: "eu-west-1",
        service: "s3",
        accessKeyId: "AK",
        secretAccessKey: "SK",
        sessionToken: "token",
        now: new Date("2026-11-18T00:00:00Z"),
      })
    const a = sign("https://s3.example.com/b/k?uploadId=x%2By&partNumber=2")
    const b = sign("https://s3.example.com/b/k?partNumber=2&uploadId=x%2By")
    expect(a["authorization"]).toBe(b["authorization"])
    expect(a["x-amz-security-token"]).toBe("token")
    expect(a["authorization"]).toContain(
      "SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token",
    )
    expect(
      sign("https://s3.example.com/b/k?partNumber=3&uploadId=x%2By")["authorization"],
    ).not.toBe(a["authorization"])
  })
})

interface Seen {
  readonly method: string
  readonly url: string
  readonly headers: IncomingHttpHeaders
  readonly body: Buffer
}

/** A minimal S3: objects, ranges and multipart uploads in memory. */
class FakeS3 {
  readonly seen: Seen[] = []
  readonly objects = new Map<string, Buffer>()
  private readonly uploads = new Map<string, Map<number, Buffer>>()
  private server: Server | undefined
  endpoint = ""

  async start(): Promise<void> {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on("data", (chunk: Buffer) => chunks.push(chunk))
      request.on("end", () => {
        const body = Buffer.concat(chunks)
        const url = new URL(request.url ?? "/", "http://s3.test")
        this.seen.push({
          method: request.method ?? "",
          url: url.pathname + url.search,
          headers: request.headers,
          body,
        })
        if (!String(request.headers.authorization).startsWith("AWS4-HMAC-SHA256 Credential=AK/")) {
          response.writeHead(403).end("<Error><Code>AccessDenied</Code></Error>")
          return
        }
        if (
          request.headers["x-amz-content-sha256"] !==
          createHash("sha256").update(body).digest("hex")
        ) {
          response.writeHead(400).end("<Error><Code>XAmzContentSHA256Mismatch</Code></Error>")
          return
        }
        const key = url.pathname
        const uploadId = url.searchParams.get("uploadId")
        if (request.method === "POST" && url.searchParams.has("uploads")) {
          this.uploads.set("u1", new Map())
          response
            .writeHead(200)
            .end(
              "<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>",
            )
        } else if (request.method === "PUT" && uploadId !== null) {
          this.uploads.get(uploadId)?.set(Number(url.searchParams.get("partNumber")), body)
          response.writeHead(200, { etag: `"p${url.searchParams.get("partNumber")}"` }).end()
        } else if (request.method === "POST" && uploadId !== null) {
          const parts = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) =>
            Number(m[1]),
          )
          const stored = this.uploads.get(uploadId)
          this.objects.set(
            key,
            Buffer.concat(parts.map((part) => stored?.get(part) ?? Buffer.alloc(0))),
          )
          response.writeHead(200).end("<CompleteMultipartUploadResult/>")
        } else if (request.method === "DELETE" && uploadId !== null) {
          this.uploads.delete(uploadId)
          response.writeHead(204).end()
        } else if (request.method === "PUT") {
          this.objects.set(key, body)
          response.writeHead(200).end()
        } else if (request.method === "GET") {
          const object = this.objects.get(key)
          if (object === undefined) {
            response.writeHead(404).end("<Error><Code>NoSuchKey</Code></Error>")
            return
          }
          const range = /^bytes=(\d+)-(\d+)$/.exec(String(request.headers.range ?? ""))
          if (range === null) response.writeHead(200).end(object)
          else response.writeHead(206).end(object.subarray(Number(range[1]), Number(range[2]) + 1))
        } else if (request.method === "DELETE") {
          this.objects.delete(key)
          response.writeHead(204).end()
        } else {
          response.writeHead(405).end()
        }
      })
    })
    this.server = server
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    this.endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }
}

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text()
}

describe("s3Backend", () => {
  const s3 = new FakeS3()
  beforeAll(() => s3.start())
  afterAll(() => s3.stop())

  const backend = (secret = "SK") =>
    s3Backend({
      endpoint: s3.endpoint,
      region: "us-east-1",
      bucket: "files",
      accessKeyId: secret === "SK" ? "AK" : "OTHER",
      secretAccessKey: secret,
      prefix: "canopy/",
    })

  it("puts, reads a range of, and deletes an object under the prefix, path style", async () => {
    const store = backend()
    await store.put("docs/a b.txt", new TextEncoder().encode("hello world"), "text/plain")
    const put = s3.seen.at(-1)
    expect(put?.method).toBe("PUT")
    expect(put?.url).toBe("/files/canopy/docs/a%20b.txt")
    expect(put?.headers["content-type"]).toBe("text/plain")
    expect(await text(await store.get("docs/a b.txt"))).toBe("hello world")
    expect(await text(await store.get("docs/a b.txt", { start: 6, end: 10 }))).toBe("world")
    expect(s3.seen.at(-1)?.headers.range).toBe("bytes=6-10")
    await store.delete("docs/a b.txt")
    await store.delete("docs/a b.txt")
    await expect(store.get("docs/a b.txt")).rejects.toMatchObject({ code: "CANOPY_NOT_FOUND" })
  })

  it("joins multipart uploads in part order", async () => {
    const store = backend()
    const id = await store.createMultipart("big", "application/octet-stream")
    expect(id).toBe("u1")
    const e2 = await store.putPart("big", id, 2, new TextEncoder().encode("second"))
    const e1 = await store.putPart("big", id, 1, new TextEncoder().encode("first,"))
    expect([e1, e2]).toEqual(['"p1"', '"p2"'])
    await store.completeMultipart("big", id, [
      { part: 2, etag: e2 },
      { part: 1, etag: e1 },
    ])
    const complete = s3.seen.at(-1)
    expect(complete?.url).toBe("/files/canopy/big?uploadId=u1")
    expect(complete?.body.toString()).toBe(
      "<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>&quot;p1&quot;</ETag></Part><Part><PartNumber>2</PartNumber><ETag>&quot;p2&quot;</ETag></Part></CompleteMultipartUpload>",
    )
    expect(await text(await store.get("big"))).toBe("first,second")
  })

  it("reports a refused request as unavailable with the store's error code", async () => {
    await expect(backend("WRONG").put("x", new Uint8Array([1]), "text/plain")).rejects.toThrow(
      "The object store answered 403 (AccessDenied)",
    )
  })
})

describe("AWS S3 and Cloudflare R2 addressing", () => {
  const capture = () => {
    const seen: { url: string; authorization: string }[] = []
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seen.push({ url: String(input), authorization: headers.get("authorization") ?? "" })
      return new Response(null, { status: 200 })
    }) as typeof globalThis.fetch
    return { seen, fetch }
  }

  it("addresses AWS S3 by virtual host in its region unless an endpoint is given", async () => {
    const aws = capture()
    const store = s3Backend({
      region: "eu-west-1",
      bucket: "my-files",
      accessKeyId: "AK",
      secretAccessKey: "SK",
      fetch: aws.fetch,
    })
    expect(store.kind).toBe("s3")
    await store.put("docs/1", new Uint8Array([1]), "text/plain")
    expect(aws.seen[0]?.url).toBe("https://my-files.s3.eu-west-1.amazonaws.com/docs/1")
    expect(aws.seen[0]?.authorization).toContain("/eu-west-1/s3/aws4_request")
    const minio = capture()
    await s3Backend({
      endpoint: "http://localhost:9000",
      region: "us-east-1",
      bucket: "my-files",
      accessKeyId: "AK",
      secretAccessKey: "SK",
      fetch: minio.fetch,
    }).put("docs/1", new Uint8Array([1]), "text/plain")
    expect(minio.seen[0]?.url).toBe("http://localhost:9000/my-files/docs/1")
  })

  it("addresses R2 by account and jurisdiction in the region auto", async () => {
    const r2 = capture()
    const store = r2Backend({
      accountId: "0123456789abcdef0123456789abcdef",
      bucket: "uploads",
      accessKeyId: "AK",
      secretAccessKey: "SK",
      prefix: "app/",
      fetch: r2.fetch,
    })
    expect(store.kind).toBe("r2")
    await store.put("docs/1", new Uint8Array([1]), "text/plain")
    expect(r2.seen[0]?.url).toBe(
      "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/uploads/app/docs/1",
    )
    expect(r2.seen[0]?.authorization).toContain("/auto/s3/aws4_request")
    const eu = capture()
    await r2Backend({
      accountId: "0123456789abcdef0123456789abcdef",
      bucket: "uploads",
      accessKeyId: "AK",
      secretAccessKey: "SK",
      jurisdiction: "eu",
      fetch: eu.fetch,
    }).delete("docs/1")
    expect(eu.seen[0]?.url).toBe(
      "https://0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com/uploads/docs/1",
    )
  })

  it("refuses an R2 account id or jurisdiction that would change the host", () => {
    const base = { bucket: "b", accessKeyId: "AK", secretAccessKey: "SK" }
    expect(() => r2Backend({ ...base, accountId: "evil.example.com#" })).toThrow("32 hexadecimal")
    expect(() =>
      r2Backend({ ...base, accountId: "0123456789abcdef0123456789abcdef", jurisdiction: "x.y" }),
    ).toThrow("jurisdiction")
  })
})

describe("signed URL tokens", () => {
  const signer = new UrlSigner("a master key of enough length for tests")

  it("grants one path until it expires, and other servers with the same master key accept it", () => {
    const token = signer.sign({ bucket: "docs", path: "a/b.pdf", expiresAt: 2_000 })
    expect(signer.verify(token, 1_999)).toEqual({
      bucket: "docs",
      path: "a/b.pdf",
      expiresAt: 2_000,
    })
    expect(signer.verify(token, 2_000)).toBeUndefined()
    expect(new UrlSigner("a master key of enough length for tests").verify(token, 0)).toBeDefined()
    expect(new UrlSigner("another master key entirely").verify(token, 0)).toBeUndefined()
    expect(new UrlSigner(undefined).verify(token, 0)).toBeUndefined()
  })

  it("refuses tampered or malformed tokens", () => {
    const token = signer.sign({ bucket: "docs", path: "a.pdf", expiresAt: 5_000 })
    const [payload = "", mac = ""] = token.split(".")
    const other = Buffer.from(JSON.stringify({ b: "docs", p: "b.pdf", e: 5_000 })).toString(
      "base64url",
    )
    expect(signer.verify(`${other}.${mac}`, 0)).toBeUndefined()
    expect(signer.verify(`${payload}.${mac.slice(0, -1)}A`, 0)).toBeUndefined()
    expect(signer.verify(`${payload}`, 0)).toBeUndefined()
    expect(signer.verify(`${token}.x`, 0)).toBeUndefined()
    expect(signer.verify("", 0)).toBeUndefined()
  })
})

describe("paths and types", () => {
  it("accepts nested paths and refuses empty, dot and control segments", () => {
    expect(() => checkPath("a/b/c.txt")).not.toThrow()
    expect(() => checkPath("ünïcödé file.txt")).not.toThrow()
    for (const bad of [
      "",
      "/a",
      "a/",
      "a//b",
      "a/../b",
      "./a",
      "a\\b",
      "a\u0000b",
      "x".repeat(1025),
    ])
      expect(() => checkPath(bad), bad).toThrow()
  })

  it("matches exact types and wildcards, ignoring parameters and case", () => {
    expect(() => checkType("image/PNG", ["image/*"])).not.toThrow()
    expect(() => checkType("text/plain; charset=utf-8", ["text/plain"])).not.toThrow()
    expect(() => checkType("anything/at-all", [])).not.toThrow()
    expect(() => checkType("imagery/png", ["image/*"])).toThrow(/does not accept imagery\/png/)
    expect(() => checkType("application/pdf", ["image/*", "text/plain"])).toThrow()
  })
})
