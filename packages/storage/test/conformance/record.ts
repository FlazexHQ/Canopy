import { createHash, createPrivateKey, createPublicKey, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Authenticator, DEFAULT_RATE_LIMITS, RateLimits } from "@canopy/auth"
import {
  allow,
  auth,
  ContextResolver,
  collection,
  createPolicySet,
  fromStored,
  restrict,
  toStored,
} from "@canopy/policy"
import { TEST_ENGINE, testPolicyEngine } from "@canopy/testing"
import { Transformer } from "@napi-rs/image"
import { exportJWK, SignJWT } from "jose"
import { BSON, type MongoClient, ObjectId } from "mongodb"
import {
  createStorageHandler,
  ImageRenderer,
  localBackend,
  Storage,
  UrlSigner,
} from "../../src/index.ts"

const ORIGIN = "http://canopy.test"
const BASE_PATH = "/storage/v1"
const PART_SIZE = 5 * 1024 * 1024
const BROWSER = "https://app.canopy.test"
const CONTRACT_HEADERS = new Set([
  "accept-ranges",
  "cache-control",
  "content-disposition",
  "content-length",
  "content-range",
  "content-security-policy",
  "content-type",
  "etag",
  "retry-after",
  "vary",
  "x-content-type-options",
  "x-request-id",
])

const objects = collection("storage.objects", {
  exposed: true,
  policies: [
    allow.read("authenticated").where({ owner: auth("sub") }),
    restrict.read("authenticated").where({ "metadata.archived": { $ne: true } }),
    allow
      .insert("authenticated")
      .check({ bucket: "docs", owner: auth("sub"), "metadata.blocked": { $ne: true } }),
    allow
      .update("authenticated")
      .where({ owner: auth("sub") })
      .check({ owner: auth("sub"), "metadata.blocked": { $ne: true } }),
    allow.delete("authenticated").where({ owner: auth("sub") }),
  ],
  fields: { read: { default: { omit: ["metadata.secret"] } } },
})

async function buildFixture() {
  const seed = createHash("sha256").update("canopy conformance storage JWT key v1").digest()
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  })
  const kid = "canopy-storage-fixture"
  const issuer = "https://storage.conformance.test/"
  const publishable = "canopy_pk_storage_fixture"
  const secret = "canopy_sk_storage_fixture"
  const { kty, crv, x } = await exportJWK(createPublicKey(privateKey))
  if (kty !== "OKP" || crv !== "Ed25519" || x === undefined)
    throw new Error("Expected an Ed25519 key for the storage fixture")
  const jwk = { kty, crv, x, kid, alg: "EdDSA", use: "sig" } as const
  const bearer = (token: string) => ({ apikey: publishable, authorization: `Bearer ${token}` })
  const sign = (sub: string) =>
    new SignJWT({ sub })
      .setProtectedHeader({ alg: "EdDSA", kid })
      .setIssuer(issuer)
      .setIssuedAt(1_767_225_600)
      .setExpirationTime(4_102_444_800)
      .sign(privateKey)
  const alice = await sign("alice")
  const tampered = `${alice.slice(0, -4)}${alice.endsWith("AAAA") ? "BBBB" : "AAAA"}`
  const callers: Record<string, Record<string, string>> = {
    none: {},
    anon: { apikey: publishable },
    alice: bearer(alice),
    bob: bearer(await sign("bob")),
    service: { apikey: secret },
    "unknown-key": { apikey: "canopy_pk_unknown" },
    tampered: bearer(tampered),
  }
  const signingMasterKey = "canopy conformance storage signing key v1"
  return {
    name: "storage",
    basePath: BASE_PATH,
    auth: {
      issuer,
      rolesClaim: "roles",
      jwks: { keys: [jwk] },
      publishableKeys: [publishable],
      secretKeys: [secret],
    },
    callers,
    policies: { collections: [toStored(objects, { version: 1 })], contexts: [] },
    buckets: {
      docs: {
        public: false,
        maxFileSize: 2 * PART_SIZE,
        allowedTypes: ["text/plain", "application/octet-stream"],
      },
      avatars: { public: true, maxFileSize: 1024, allowedTypes: ["image/*"] },
    },
    images: { maxDimension: 2500, maxSourceSize: 512 },
    partSize: PART_SIZE,
    signingMasterKey,
    expiredToken: new UrlSigner(signingMasterKey).sign({
      bucket: "docs",
      path: "file.txt",
      expiresAt: 1000,
    }),
    cors: { origins: [BROWSER] },
    rateLimited: { peer: "192.0.2.1", requests: { perSecond: 1, burst: 1 }, now: 0 },
  }
}

type Fixture = Awaited<ReturnType<typeof buildFixture>>

interface Step {
  readonly method: string
  readonly target: string
  readonly caller: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
  readonly bodyBase64?: string
  readonly stream?: boolean
  readonly rustError?: string
  readonly cacheProbe?: boolean
}

interface Spec {
  readonly id: string
  readonly steps: readonly Step[]
  readonly observe?: boolean
  readonly rateLimited?: boolean
}

function call(
  method: string,
  path: string,
  caller = "alice",
  headers?: Step["headers"],
  body?: string,
): Step {
  return {
    method,
    target: `${BASE_PATH}/${path}`,
    caller,
    ...(headers === undefined ? {} : { headers }),
    ...(body === undefined ? {} : { body }),
  }
}

const FILE = "object/docs/file.txt"
const UPLOAD = "uploads/<upload-id>"
const SIGNED = "signed/docs/file.txt"
const ALPHABET = "abcdefghij"

function upload(path = FILE, caller = "alice", headers: Step["headers"] = {}, body = ALPHABET) {
  return call("POST", path, caller, { "content-type": "text/plain", ...headers }, body)
}

function jsonCall(path: string, body: object) {
  return call("POST", path, "alice", { "content-type": "application/json" }, JSON.stringify(body))
}

function scenario(id: string, ...steps: Step[]): Spec {
  return { id, steps }
}

function mutation(id: string, ...steps: Step[]): Spec {
  return { ...scenario(id, ...steps), observe: true }
}

const groups: Readonly<Record<string, readonly Spec[]>> = {
  uploads: [
    mutation(
      "post-metadata",
      upload(FILE, "alice", { "x-metadata": '{"title":"notes","secret":"internal"}' }),
    ),
    mutation(
      "put-upsert",
      call("PUT", FILE, "alice", { "content-type": "text/plain" }, "new"),
      call("PUT", FILE, "alice", { "content-type": "text/plain" }, "replacement"),
      call("GET", FILE),
    ),
    mutation(
      "post-upsert",
      upload(),
      upload(FILE, "alice", { "x-upsert": "true" }, "replacement"),
      call("GET", FILE),
    ),
    mutation("conflict", upload(), upload()),
    mutation("invalid-metadata-json", upload(FILE, "alice", { "x-metadata": "{" })),
    mutation("invalid-metadata-shape", upload(FILE, "alice", { "x-metadata": "[]" })),
    mutation(
      "declared-size-limit",
      upload(FILE, "alice", { "content-length": String(2 * PART_SIZE + 1) }),
    ),
    mutation("streamed-size-limit", {
      ...upload(
        "object/avatars/large.png",
        "service",
        { "content-type": "image/png" },
        "x".repeat(1025),
      ),
      stream: true,
    }),
    mutation("disallowed-type", upload(FILE, "alice", { "content-type": "image/png" })),
    mutation("empty-path", upload("object/docs/")),
    mutation("invalid-path", upload("object/docs/nested//file.txt")),
    mutation("invalid-path-encoding", upload("object/docs/%FF")),
    mutation("unknown-bucket", upload("object/unknown/file.txt")),
  ],
  downloads: [
    scenario(
      "get-head-and-conditional",
      upload(),
      call("GET", FILE),
      call("HEAD", FILE),
      call("GET", FILE, "alice", { "if-none-match": "<etag>" }),
    ),
    scenario(
      "download-names",
      upload(),
      call("GET", `${FILE}?download`),
      call("GET", `${FILE}?download=report%20%281%29.txt`),
    ),
    scenario(
      "unicode-path",
      upload("object/docs/caf%C3%A9.txt"),
      call("GET", "object/docs/caf%C3%A9.txt?download"),
    ),
    scenario(
      "binary-download",
      {
        ...call("POST", "object/docs/bytes.bin", "alice", {
          "content-type": "application/octet-stream",
        }),
        bodyBase64: "AP+A",
      },
      call("GET", "object/docs/bytes.bin"),
    ),
  ],
  ranges: [
    ...[
      ["first-byte", "bytes=0-0"],
      ["middle", "bytes=2-5"],
      ["open-ended", "bytes=6-"],
      ["suffix", "bytes=-3"],
      ["past-end", "bytes=10-"],
      ["multiple-ignored", "bytes=0-1,4-5"],
      ["malformed-ignored", "bytes=oops"],
    ].map(([id, range]) =>
      scenario(id ?? "", upload(), call("GET", FILE, "alice", { range: range ?? "" })),
    ),
    scenario("head-range", upload(), call("HEAD", FILE, "alice", { range: "bytes=2-5" })),
  ],
  public: [
    scenario(
      "public-without-credentials",
      {
        ...call("POST", "object/avatars/icon.png", "service", { "content-type": "image/png" }),
        bodyBase64: "iVBORw0KGgo=",
      },
      call("GET", "public/avatars/icon.png", "none"),
    ),
    scenario("private-not-public", upload(), call("GET", "public/docs/file.txt", "none")),
  ],
  signed: [
    scenario(
      "signed-download",
      upload(),
      jsonCall("sign/docs/file.txt", { expiresIn: 60 }),
      call("GET", `${SIGNED}?token=<signed-token>`, "none"),
      call("GET", "signed/docs/other.txt?token=<signed-token>", "none"),
    ),
    scenario("invalid-expiry", upload(), jsonCall("sign/docs/file.txt", { expiresIn: 0 })),
    scenario("bad-token", upload(), call("GET", `${SIGNED}?token=invalid`, "none")),
    scenario("expired-token", upload(), call("GET", `${SIGNED}?token=<expired-token>`, "none")),
  ],
  lists: [
    scenario(
      "prefix-after-limit-and-owner",
      upload("object/docs/reports/a.txt"),
      upload("object/docs/reports/b.txt", "bob"),
      upload("object/docs/reports/c.txt"),
      upload("object/docs/outside.txt"),
      call("GET", "list/docs?prefix=reports%2F&limit=1"),
      call("GET", "list/docs?prefix=reports%2F&after=reports%2Fa.txt&limit=1"),
      call("GET", "list/docs?prefix=reports%2F", "bob"),
    ),
    scenario(
      "invalid-limit",
      call("GET", "list/docs?limit=oops"),
      call("GET", "list/docs?limit=0"),
    ),
  ],
  deletes: [
    mutation("delete", upload(), call("DELETE", FILE), call("GET", FILE)),
    mutation("delete-missing", call("DELETE", FILE)),
    mutation("delete-hidden", upload(), call("DELETE", FILE, "bob")),
    mutation("delete-forbidden", upload(), call("DELETE", FILE, "anon")),
  ],
  resumable: [
    mutation(
      "complete",
      jsonCall("upload/docs/file.txt", { size: 3, contentType: "text/plain" }),
      call("GET", UPLOAD),
      call("POST", `${UPLOAD}/complete`),
      call("PUT", `${UPLOAD}/1`, "alice", {}, "ab"),
      call("PUT", `${UPLOAD}/nope`, "alice", {}, "abc"),
      call("PUT", `${UPLOAD}/0`, "alice", {}, "abc"),
      call("PUT", `${UPLOAD}/2`, "alice", {}, "abc"),
      call("PUT", `${UPLOAD}/1`, "alice", {}, "abc"),
      call("GET", UPLOAD),
      call("POST", `${UPLOAD}/complete`),
      call("GET", FILE),
      call("GET", UPLOAD),
    ),
    mutation(
      "multipart-abort",
      jsonCall("upload/docs/file.txt", { size: PART_SIZE + 1, contentType: "text/plain" }),
      call("GET", UPLOAD, "bob"),
      call("PUT", `${UPLOAD}/2`, "alice", {}, "z"),
      call("DELETE", UPLOAD),
      call("GET", UPLOAD),
    ),
  ],
  policies: [
    mutation("insert-check", upload(FILE, "alice", { "x-metadata": '{"blocked":true}' })),
    mutation(
      "update-target",
      upload(),
      call("PUT", FILE, "bob", { "content-type": "text/plain" }, "denied"),
    ),
    mutation(
      "update-check",
      upload(),
      call(
        "PUT",
        FILE,
        "alice",
        { "content-type": "text/plain", "x-metadata": '{"blocked":true}' },
        "denied",
      ),
    ),
    scenario("using-hides", upload(), call("GET", FILE, "bob"), call("HEAD", FILE, "bob")),
    scenario(
      "restrictive-policy",
      upload(FILE, "alice", { "x-metadata": '{"archived":true}' }),
      call("GET", FILE),
      call("GET", "list/docs"),
    ),
    scenario(
      "field-projection",
      upload(FILE, "alice", { "x-metadata": '{"title":"notes","secret":"internal"}' }),
      call("GET", "list/docs"),
      call("GET", "list/docs", "service"),
    ),
    mutation(
      "anonymous-caller",
      upload(),
      call("GET", FILE, "anon"),
      upload("object/docs/anon.txt", "anon"),
    ),
  ],
  errors: [
    scenario("missing-key", call("GET", FILE, "none")),
    scenario("bad-key", call("GET", FILE, "unknown-key")),
    scenario("bad-bearer", call("GET", FILE, "tampered")),
    {
      ...scenario("rate-limited", call("GET", "list/docs"), call("GET", "list/docs")),
      rateLimited: true,
    },
    scenario("unknown-route", call("GET", "unknown")),
    scenario(
      "unsupported-method",
      call("PATCH", FILE),
      call("POST", "list/docs"),
      call("GET", "sign/docs/file.txt"),
    ),
  ],
  cors: [
    scenario(
      "preflight",
      call("OPTIONS", FILE, "none", {
        origin: BROWSER,
        "access-control-request-method": "PUT",
        "access-control-request-headers": "apikey, content-type",
      }),
    ),
    scenario(
      "denied-preflight",
      call("OPTIONS", FILE, "none", {
        origin: "https://other.canopy.test",
        "access-control-request-method": "GET",
      }),
    ),
    scenario(
      "cors-file-and-error",
      upload(),
      call("GET", FILE, "alice", { origin: BROWSER }),
      call("GET", FILE, "none", { origin: BROWSER }),
      call("GET", FILE, "alice", { origin: "https://other.canopy.test" }),
    ),
  ],
}

async function imageCases(): Promise<readonly Spec[]> {
  const width = 48
  const height = 24
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      rgba.set(
        [x < 12 ? 240 : 12, x >= 12 && x < 36 ? 200 : 16, x >= 36 ? 240 : y * 8, 255],
        (y * width + x) * 4,
      )
    }
  }
  const source = Transformer.fromRgbaPixels(rgba, width, height)
  const photo = "avatars/photo.png"
  const put = (path: string, type: string, bytes: Uint8Array): Step => ({
    ...call("POST", `object/${path}`, "service", { "content-type": type }),
    bodyBase64: Buffer.from(bytes).toString("base64"),
  })
  const png = await source.png()
  const save = put(photo, "image/png", png)
  const render = "render/image"
  const publicPath = `${render}/public/${photo}`
  const square = `${publicPath}?width=20&height=20`
  const avif = await Transformer.fromRgbaPixels(rgba, width, height).avif({ speed: 8 })
  const webp = await Transformer.fromRgbaPixels(rgba, width, height).webp(80)
  return [
    mutation(
      "geometry",
      save,
      call("GET", square, "none", { range: "bytes=0-1" }),
      {
        ...call("HEAD", `${square}&resize=cover&quality=80&format=origin`, "none"),
        cacheProbe: true,
      },
      call("GET", square, "none", { "if-none-match": "<etag>" }),
      call("GET", `${square}&resize=contain`, "none"),
      call("GET", `${square}&resize=fill&download=`, "none"),
      call("GET", `${publicPath}?width=19`, "none"),
      call("GET", `${publicPath}?height=15`, "none"),
    ),
    mutation(
      "formats",
      save,
      call("GET", `${square}&format=jpeg&quality=20`, "none"),
      call("GET", `${square}&format=jpeg&quality=95`, "none"),
      call("GET", `${square}&format=avif&quality=80`, "none"),
      call("GET", `${square}&format=png`, "none"),
      {
        ...call("GET", `${square}&format=webp`, "none"),
        rustError: "Lossy WebP output is not supported",
      },
      put("avatars/input.webp", "image/webp", webp),
      call("GET", `${render}/public/avatars/input.webp?width=20&format=png`, "none"),
      {
        ...call("GET", `${render}/public/avatars/input.webp?width=20`, "none"),
        rustError: "Lossy WebP output is not supported",
      },
      put("avatars/input.avif", "image/avif", avif),
      {
        ...call("GET", `${render}/public/avatars/input.avif?width=20&format=png`, "none"),
        rustError: "AVIF input is not supported",
      },
    ),
    mutation(
      "authorization",
      save,
      call("GET", `${render}/object/${photo}?width=20`, "none"),
      call("GET", `${render}/object/${photo}?width=20`, "bob"),
      call("GET", `${render}/object/${photo}?width=20`, "service"),
      call(
        "POST",
        `sign/${photo}`,
        "service",
        { "content-type": "application/json" },
        '{"expiresIn":60}',
      ),
      call("GET", `${render}/signed/${photo}?width=20&token=<signed-token>`, "none"),
      call("GET", `${render}/signed/${photo}?width=20&token=<expired-token>`, "none"),
      call("GET", `${render}/public/docs/file.txt?width=20`, "none"),
    ),
    mutation(
      "limits",
      save,
      call("GET", `${publicPath}?width=2501`, "none"),
      call("GET", `${publicPath}?quality=101`, "none"),
      call("GET", `${publicPath}?resize=crop`, "none"),
      call("GET", `${publicPath}?format=gif`, "none"),
      put("avatars/large.png", "image/png", Buffer.concat([png, Buffer.alloc(513 - png.length)])),
      call("GET", `${render}/public/avatars/large.png`, "none"),
      put("avatars/bad.png", "image/png", Buffer.from("invalid image")),
      call("GET", `${render}/public/avatars/bad.png`, "none"),
      upload(),
      call("GET", `${render}/object/docs/file.txt`),
    ),
    mutation(
      "cache-cap-and-invalidation",
      save,
      ...Array.from({ length: 26 }, (_, i) => call("HEAD", `${publicPath}?width=${i + 1}`, "none")),
      call("DELETE", `object/${photo}`, "service"),
      call("GET", square, "none"),
      save,
      call("GET", square, "none"),
    ),
    mutation(
      "cache-cap",
      save,
      ...Array.from({ length: 26 }, (_, i) => call("HEAD", `${publicPath}?width=${i + 1}`, "none")),
    ),
  ]
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function normalizedDates(text: string): string {
  return text.replace(
    /"(createdAt|updatedAt|expiresAt)":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"/g,
    (_, field: string) => `"${field}":"<${field}>"`,
  )
}

function fileBody(bytes: Buffer) {
  const body = bytes.toString("utf8")
  return Buffer.from(body).equals(bytes) ? { body } : { bodyBase64: bytes.toString("base64") }
}

async function captureCase(
  client: MongoClient,
  fixture: Fixture,
  database: string,
  group: string,
  spec: Spec,
) {
  const meta = client.db(database)
  await meta.dropDatabase()
  const documents = meta.collection("storage_objects")
  await documents.createIndex({ bucket: 1, path: 1 }, { unique: true })
  const root = await mkdtemp(join(tmpdir(), "canopy-storage-oracle-"))
  try {
    const engine = testPolicyEngine(
      createPolicySet(fixture.policies.collections.map((doc) => fromStored(doc))),
    )
    const policies = () => engine
    const handler = createStorageHandler({
      storage: new Storage({
        client,
        metaDatabase: database,
        policies,
        backend: await localBackend({ root }),
        buckets: fixture.buckets,
        signer: new UrlSigner(fixture.signingMasterKey),
        partSize: fixture.partSize,
        images: new ImageRenderer(fixture.images),
      }),
      authenticator: new Authenticator(
        {
          jwks: fixture.auth.jwks,
          issuer: fixture.auth.issuer,
          rolesClaim: fixture.auth.rolesClaim,
        },
        { publishable: fixture.auth.publishableKeys, secret: fixture.auth.secretKeys },
      ),
      policies,
      contexts: new ContextResolver({ reader: async () => [] }),
      cors: fixture.cors,
      ...(spec.rateLimited === true
        ? {
            rateLimits: new RateLimits({
              ...DEFAULT_RATE_LIMITS,
              requests: fixture.rateLimited.requests,
              now: () => fixture.rateLimited.now,
            }),
          }
        : {}),
      onError: (error) => {
        throw error
      },
    })

    const bindings = new Map([["<expired-token>", fixture.expiredToken]])
    const steps = []
    for (const [index, step] of spec.steps.entries()) {
      const caller = fixture.callers[step.caller]
      if (caller === undefined) throw new Error(`Unknown caller ${step.caller}`)
      const resolve = (template: string) =>
        template.replace(/<(?:upload-id|signed-token|expired-token|etag)>/g, (name) => {
          const value = bindings.get(name)
          if (value === undefined) throw new Error(`Missing ${name} in ${spec.id}`)
          return value
        })
      const request = {
        ...step,
        headers: { ...step.headers, "x-request-id": `${group}.${spec.id}.${index}` },
      }
      const headers = new Headers(caller)
      for (const [name, value] of Object.entries(request.headers)) headers.set(name, resolve(value))
      const body =
        step.bodyBase64 === undefined
          ? step.body
          : new Uint8Array(Buffer.from(step.bodyBase64, "base64"))
      const init = {
        method: step.method,
        headers,
        ...(body === undefined ? {} : { body }),
        ...(step.stream === true && typeof body === "string"
          ? { body: new Blob([body]).stream(), duplex: "half" as const }
          : {}),
      }
      const send = () =>
        handler.fetch(
          new Request(`${ORIGIN}${resolve(step.target)}`, init),
          spec.rateLimited === true ? { ip: fixture.rateLimited.peer } : undefined,
        )
      const response =
        step.cacheProbe === true
          ? await (async () => {
              const object = await documents.findOne({})
              if (typeof object?.["key"] !== "string") throw new Error("Missing cache probe source")
              const file = join(root, "objects", object["key"])
              const hidden = join(root, "hidden-source")
              await rename(file, hidden)
              try {
                return await send()
              } finally {
                await rename(hidden, file)
              }
            })()
          : await send()
      const responseHeaders = Object.fromEntries(
        [...response.headers]
          .filter(([name]) => CONTRACT_HEADERS.has(name) || name.startsWith("access-control-"))
          .sort(([left], [right]) => left.localeCompare(right, "en")),
      )
      const bytes = Buffer.from(await response.arrayBuffer())
      const content = fileBody(bytes)
      const image =
        group === "render" && step.target.includes("/render/") && response.status === 200
      if (image) responseHeaders["content-length"] = "<image-size>"
      const etag = response.headers.get("etag")
      if (etag !== null) bindings.set("<etag>", etag)
      if (content.body !== undefined && response.status < 300 && step.method === "POST") {
        if (step.target.startsWith(`${BASE_PATH}/upload/`)) {
          const { id } = JSON.parse(content.body) as { id: string }
          bindings.set("<upload-id>", id)
        }
        if (step.target.startsWith(`${BASE_PATH}/sign/`)) {
          const { url } = JSON.parse(content.body) as { url: string }
          const token = new URL(url, ORIGIN).searchParams.get("token")
          if (token === null) throw new Error(`Missing signed token in ${spec.id}`)
          bindings.set("<signed-token>", token)
        }
      }
      let responseBody = content.body
      if (responseBody !== undefined) {
        if (responseHeaders["content-type"]?.includes("json") === true)
          responseBody = normalizedDates(responseBody)
        for (const [name, value] of bindings) {
          if (name !== "<etag>") responseBody = responseBody.replaceAll(value, name)
        }
      }
      let rustResponse:
        { status: number; headers: Record<string, string>; body: string } | undefined
      if (step.rustError !== undefined) {
        const invalid = new URL(resolve(step.target), ORIGIN)
        invalid.search = "?quality=101"
        const error = await handler.fetch(new Request(invalid, { headers }))
        const problem = await error.text()
        rustResponse = {
          status: error.status,
          headers: Object.fromEntries(
            [...error.headers].filter(([name]) => CONTRACT_HEADERS.has(name)),
          ),
          body: problem.replace("quality must be a whole number from 20 to 100", step.rustError),
        }
      }
      steps.push({
        request,
        ...(image ? { image: true } : {}),
        ...(rustResponse === undefined ? {} : { rustResponse }),
        response: {
          status: response.status,
          headers: responseHeaders,
          ...(responseBody === undefined
            ? { bodyBase64: content.bodyBase64 }
            : { body: responseBody }),
        },
      })
    }
    const state =
      spec.observe === true
        ? {
            storage_objects: (await documents.find().sort({ bucket: 1, path: 1 }).toArray()).map(
              (document, index) => {
                const { _id, key, createdAt, updatedAt } = document
                if (
                  !(_id instanceof ObjectId) ||
                  typeof key !== "string" ||
                  !(createdAt instanceof Date) ||
                  !(updatedAt instanceof Date)
                )
                  throw new Error(`Unexpected storage document in ${spec.id}`)
                return BSON.EJSON.stringify(document, { relaxed: false })
                  .replace(_id.toHexString(), `<object-id-${index + 1}>`)
                  .replace(key, `${document["bucket"]}/<backend-id-${index + 1}>`)
                  .replace(
                    /"(createdAt|updatedAt)":\{"\$date":\{"\$numberLong":"\d+"\}\}/g,
                    (_, field: string) => `"${field}":{"$date":{"$numberLong":"<${field}>"}}`,
                  )
              },
            ),
          }
        : undefined
    if (group === "render" && state === undefined) throw new Error("Render state is required")
    const variants =
      group === "render"
        ? await meta.collection("storage_variants").find().sort({ _id: 1 }).toArray()
        : undefined
    const keys =
      variants === undefined ? [] : await documents.find().sort({ bucket: 1, path: 1 }).toArray()
    const variantState = variants
      ?.flatMap(({ _id, key, size, contentType, createdAt, ...rest }) => {
        if (typeof key !== "string" || typeof size !== "number" || !(createdAt instanceof Date))
          throw new Error("Invalid variant metadata")
        if (
          contentType === "image/webp" ||
          key === keys.find((doc) => doc["path"] === "input.avif")?.["key"]
        )
          return []
        const id = keys.findIndex((doc) => doc["key"] === key) + 1
        if (id === 0) throw new Error("Variant without a source")
        const canonical = `${keys[id - 1]?.["bucket"]}/<backend-id-${id}>`
        return [
          JSON.stringify({
            _id: String(_id).replace(key, canonical),
            key: canonical,
            size: "<image-size>",
            contentType,
            createdAt: "<createdAt>",
            ...rest,
          }),
        ]
      })
      .sort()
    return {
      id: spec.id,
      ...(spec.rateLimited === true ? { rateLimited: true } : {}),
      steps,
      ...(state === undefined
        ? {}
        : {
            state: {
              ...state,
              ...(variantState === undefined ? {} : { storage_variants: variantState }),
            },
          }),
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** Captures Storage HTTP vectors or reports the files that differ in check mode. */
export async function recordStorage(options: {
  readonly client: MongoClient
  readonly dir: string
  readonly check?: boolean
}): Promise<string[]> {
  if (TEST_ENGINE !== "ts")
    throw new Error("Unset CANOPY_TEST_ENGINE to record TypeScript behavior")
  const { client } = options
  const fixture = await buildFixture()
  const outputs = new Map([["fixture.json", json(fixture)]])
  const database = `canopy_storage_oracle_${randomUUID()}`
  try {
    for (const [group, specs] of Object.entries({ ...groups, render: await imageCases() })) {
      const cases = []
      for (const spec of specs)
        cases.push(await captureCase(client, fixture, database, group, spec))
      outputs.set(join("cases", `${group}.json`), json({ group, cases }))
    }
  } finally {
    await client.db(database).dropDatabase()
  }
  const differing: string[] = []
  for (const [name, content] of outputs) {
    const path = join(options.dir, name)
    if (options.check === true) {
      const current = await readFile(path, "utf8").catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
        throw error
      })
      if (current?.replaceAll("\r\n", "\n") !== content) differing.push(name)
    } else {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content)
    }
  }
  return differing
}
