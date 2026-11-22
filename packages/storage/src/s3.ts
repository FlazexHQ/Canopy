import { hmacSha256, sha256 } from "@canopy/auth/crypto"
import { CanopyError, ErrorCode, NotFoundError } from "@canopy/protocol"
import type { ByteRange, StorageBackend, UploadedPart } from "./backend.ts"

/** Where an S3 compatible store is and how to sign requests to it. */
export interface S3Options {
  /**
   * The endpoint of a store other than AWS S3, such as `http://localhost:9000` for MinIO.
   * @default `https://s3.<region>.amazonaws.com`
   */
  readonly endpoint?: string
  readonly region: string
  readonly bucket: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
  /**
   * Addresses the bucket in the path (`endpoint/bucket/key`) rather than the host name.
   * @default false for AWS S3, true when `endpoint` is given
   */
  readonly forcePathStyle?: boolean
  /** A key prefix inside the bucket, such as `canopy/`. @default "" */
  readonly prefix?: string
  readonly fetch?: typeof fetch
  /** The `kind` the backend reports. @default "s3" */
  readonly kind?: string
}

/** Where a Cloudflare R2 bucket is and the R2 API token to reach it with. */
export interface R2Options {
  /** The Cloudflare account id, the first label of `<accountId>.r2.cloudflarestorage.com`. */
  readonly accountId: string
  readonly bucket: string
  /** The access key id of an R2 API token. */
  readonly accessKeyId: string
  readonly secretAccessKey: string
  /** For a bucket created in a jurisdiction, such as `eu`. */
  readonly jurisdiction?: string
  /** A key prefix inside the bucket, such as `canopy/`. @default "" */
  readonly prefix?: string
  readonly fetch?: typeof fetch
}

/** A request to sign with {@link signV4}. */
export interface SignInput {
  readonly method: string
  readonly url: URL
  /** Lower case names; `host`, `x-amz-date` and `x-amz-content-sha256` are added. */
  readonly headers: Readonly<Record<string, string>>
  /** The hex SHA-256 of the body, or `UNSIGNED-PAYLOAD`. */
  readonly payloadHash: string
  readonly region: string
  readonly service: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
  readonly now: Date
}

const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

function hex(data: Uint8Array | string): string {
  return sha256(data).toString("hex")
}

/** Percent encodes as AWS expects (RFC 3986 unreserved characters stay; `/` stays when asked). */
function awsEncode(text: string, keepSlash: boolean): string {
  return encodeURIComponent(text)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replaceAll(keepSlash ? "%2F" : "\u0000", "/")
}

/**
 * Signs a request with AWS Signature Version 4 and returns every header to send, `authorization`
 * included. The URL path must already be encoded as it is sent.
 */
export function signV4(input: SignInput): Record<string, string> {
  const amzDate = input.now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "")
  const date = amzDate.slice(0, 8)
  const headers: Record<string, string> = {
    ...input.headers,
    host: input.url.host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": input.payloadHash,
    ...(input.sessionToken === undefined ? {} : { "x-amz-security-token": input.sessionToken }),
  }
  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort()
  const canonicalHeaders = names
    .map((name) => `${name}:${(headers[name] ?? "").trim().replace(/\s+/g, " ")}\n`)
    .join("")
  const signedHeaders = names.join(";")
  const query = [...input.url.searchParams.entries()]
    .map(([name, value]) => [awsEncode(name, false), awsEncode(value, false)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&")
  const canonicalRequest = [
    input.method,
    input.url.pathname,
    query,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n")
  const scope = `${date}/${input.region}/${input.service}/aws4_request`
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(canonicalRequest)].join("\n")
  const key = hmacSha256(
    hmacSha256(
      hmacSha256(hmacSha256(`AWS4${input.secretAccessKey}`, date), input.region),
      input.service,
    ),
    "aws4_request",
  )
  const signature = hmacSha256(key, stringToSign).toString("hex")
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}

function xmlValue(xml: string, tag: string): string | undefined {
  return new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1]
}

function xmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

/**
 * Stores contents in an S3 compatible object store (AWS S3, MinIO and others) through its REST API, signed
 * with Signature Version 4. Multipart uploads use the store's own; parts other than the last must be at
 * least 5 MiB.
 */
export function s3Backend(options: S3Options): StorageBackend {
  const send = options.fetch ?? globalThis.fetch
  const endpoint = new URL(options.endpoint ?? `https://s3.${options.region}.amazonaws.com`)
  const pathStyle = options.forcePathStyle ?? options.endpoint !== undefined
  const prefix = options.prefix ?? ""

  const urlOf = (key: string, query: Readonly<Record<string, string>> = {}): URL => {
    const encoded = awsEncode(`${prefix}${key}`, true)
    const base = pathStyle
      ? `${endpoint.origin}${endpoint.pathname.replace(/\/$/, "")}/${awsEncode(options.bucket, false)}/${encoded}`
      : `${endpoint.protocol}//${options.bucket}.${endpoint.host}/${encoded}`
    const url = new URL(base)
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value)
    return url
  }

  const request = async (
    method: string,
    key: string,
    init: {
      readonly query?: Readonly<Record<string, string>>
      readonly headers?: Readonly<Record<string, string>>
      readonly body?: Uint8Array | string
      readonly expect?: readonly number[]
    } = {},
  ): Promise<Response> => {
    const url = urlOf(key, init.query)
    const body = init.body
    const headers = signV4({
      method,
      url,
      headers: init.headers ?? {},
      payloadHash: body === undefined ? EMPTY_HASH : hex(body),
      region: options.region,
      service: "s3",
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      ...(options.sessionToken === undefined ? {} : { sessionToken: options.sessionToken }),
      now: new Date(),
    })
    delete headers["host"]
    let response: Response
    try {
      response = await send(url, {
        method,
        headers,
        ...(body === undefined
          ? {}
          : { body: typeof body === "string" ? body : Buffer.from(body) }),
        redirect: "manual",
      })
    } catch (error: unknown) {
      throw new CanopyError(ErrorCode.Unavailable, "The object store is unreachable", {
        cause: error,
      })
    }
    if ((init.expect ?? [200]).includes(response.status)) return response
    const text = await response.text().catch(() => "")
    if (response.status === 404 && method === "GET")
      throw new NotFoundError("The file content is missing")
    throw new CanopyError(
      ErrorCode.Unavailable,
      `The object store answered ${response.status}${xmlValue(text, "Code") === undefined ? "" : ` (${xmlValue(text, "Code")})`}`,
    )
  }

  return {
    kind: options.kind ?? "s3",
    async put(key, body, contentType) {
      await request("PUT", key, { headers: { "content-type": contentType }, body })
    },
    async get(key: string, range?: ByteRange) {
      const response = await request("GET", key, {
        ...(range === undefined ? {} : { headers: { range: `bytes=${range.start}-${range.end}` } }),
        expect: [200, 206],
      })
      if (response.body === null) return new ReadableStream({ start: (c) => c.close() })
      return response.body
    },
    async delete(key) {
      await request("DELETE", key, { expect: [200, 204, 404] })
    },
    async createMultipart(key, contentType) {
      const response = await request("POST", key, {
        query: { uploads: "" },
        headers: { "content-type": contentType },
      })
      const id = xmlValue(await response.text(), "UploadId")
      if (id === undefined)
        throw new CanopyError(ErrorCode.Unavailable, "The object store did not start the upload")
      return id
    },
    async putPart(key, uploadId, part, body) {
      const response = await request("PUT", key, {
        query: { partNumber: String(part), uploadId },
        body,
      })
      const etag = response.headers.get("etag")
      if (etag === null)
        throw new CanopyError(ErrorCode.Unavailable, "The object store did not return an ETag")
      return etag
    },
    async completeMultipart(key: string, uploadId: string, parts: readonly UploadedPart[]) {
      const xml = `<CompleteMultipartUpload>${[...parts]
        .sort((a, b) => a.part - b.part)
        .map(
          ({ part, etag }) =>
            `<Part><PartNumber>${part}</PartNumber><ETag>${xmlEscape(etag)}</ETag></Part>`,
        )
        .join("")}</CompleteMultipartUpload>`
      const response = await request("POST", key, {
        query: { uploadId },
        headers: { "content-type": "application/xml" },
        body: xml,
      })
      const text = await response.text()
      if (text.includes("<Error>"))
        throw new CanopyError(
          ErrorCode.Unavailable,
          `The object store could not join the parts (${xmlValue(text, "Code") ?? "unknown"})`,
        )
    },
    async abortMultipart(key, uploadId) {
      await request("DELETE", key, { query: { uploadId }, expect: [200, 204, 404] })
    },
  }
}

/**
 * Stores contents in a Cloudflare R2 bucket through its S3 API, at
 * `https://<accountId>[.<jurisdiction>].r2.cloudflarestorage.com` in the region `auto`. R2 needs every part
 * of a multipart upload but the last to have the same size, which resumable uploads guarantee.
 */
export function r2Backend(options: R2Options): StorageBackend {
  if (!/^[0-9a-f]{32}$/i.test(options.accountId))
    throw new TypeError("An R2 account id is 32 hexadecimal characters")
  if (options.jurisdiction !== undefined && !/^[a-z]+$/.test(options.jurisdiction))
    throw new TypeError("An R2 jurisdiction is a lower case word such as eu")
  const host = [options.accountId, options.jurisdiction, "r2.cloudflarestorage.com"]
    .filter((part) => part !== undefined)
    .join(".")
  return s3Backend({
    kind: "r2",
    endpoint: `https://${host}`,
    region: "auto",
    bucket: options.bucket,
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    forcePathStyle: true,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  })
}
