import { createHash, randomUUID } from "node:crypto"
import {
  type Operation,
  type PolicyEngine,
  projectReadable,
  Role,
  STORAGE_COLLECTION,
  toFilter,
} from "@canopy/policy"
import {
  CanopyError,
  ConflictError,
  ErrorCode,
  ForbiddenError,
  InvalidQueryError,
  NotFoundError,
  PolicyViolationError,
} from "@canopy/protocol"
import type { Caller } from "@canopy/rest"
import {
  type Collection,
  type Document,
  type MongoClient,
  MongoServerError,
  ObjectId,
} from "mongodb"
import type { ByteRange, StorageBackend } from "./backend.ts"
import { type ImageRenderer, type ImageTransform, transformHash } from "./images.ts"
import { checkPath, checkType, escapeRegex, isBucketName, mediaType } from "./paths.ts"
import type { UrlSigner } from "./tokens.ts"

/** The settings of one bucket. */
export interface BucketSettings {
  /** Anyone may read its files at `/public/<bucket>/<path>`, without a policy. */
  readonly public: boolean
  /** The largest file, in bytes. */
  readonly maxFileSize: number
  /** Accepted media types such as `image/png` or `image/*`; empty accepts any. */
  readonly allowedTypes: readonly string[]
}

/** The metadata document of a stored file, in `canopy.storage_objects`; storage policies see it. */
export interface StoredObject {
  readonly _id: ObjectId
  readonly bucket: string
  readonly path: string
  /** Where the content is in the backend. */
  readonly key: string
  readonly size: number
  readonly contentType: string
  /** The hex SHA-256 of the content, or of the part hashes and a part count for resumable uploads. */
  readonly etag: string
  /** The `sub` of the caller who first stored the file, or `null`. */
  readonly owner: string | null
  readonly metadata: Readonly<Record<string, unknown>>
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** What callers see of a stored file. */
export type ObjectInfo = Omit<StoredObject, "_id" | "key">

/** A cached image transformation of a stored file, in `canopy.storage_variants`. */
interface StoredVariant {
  /** Where the variant is in the backend: `<key>.variants/<hash>`. */
  readonly _id: string
  /** The key of the source content; the variant goes when that content is replaced or deleted. */
  readonly key: string
  readonly size: number
  readonly contentType: string
  readonly createdAt: Date
}

type RenderedVariant = StoredVariant & { readonly body: Uint8Array }

/** A resumable upload, in `canopy.storage_uploads`. */
interface UploadSession {
  readonly _id: string
  readonly bucket: string
  readonly path: string
  /** The subject of the caller who started it; only they may continue it. */
  readonly subject: string
  readonly size: number
  readonly contentType: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly upsert: boolean
  readonly key: string
  readonly uploadId: string
  readonly partSize: number
  readonly parts: Readonly<Record<string, { readonly etag: string; readonly size: number }>>
  readonly createdAt: Date
  readonly expiresAt: Date
}

/** The state of a resumable upload, for the client that resumes it. */
export interface UploadStatus {
  readonly id: string
  readonly bucket: string
  readonly path: string
  readonly size: number
  readonly partSize: number
  /** How many parts the upload has. */
  readonly partCount: number
  /** The parts stored so far. */
  readonly parts: readonly number[]
  readonly expiresAt: Date
}

/** Options of {@link Storage}. */
export interface StorageOptions {
  readonly client: MongoClient
  /** Where the metadata documents and upload sessions live. */
  readonly metaDatabase: string
  readonly policies: () => PolicyEngine
  readonly backend: StorageBackend
  readonly buckets: Readonly<Record<string, BucketSettings>>
  readonly signer: UrlSigner
  /** The largest resumable upload, in bytes. @default 5 GiB */
  readonly maxUploadSize?: number
  /** The size of every part of a resumable upload but the last. At least 5 MiB. @default 8 MiB */
  readonly partSize?: number
  /** How long a resumable upload may stay unfinished. @default 24 hours */
  readonly uploadTtlMs?: number
  /** How long a signed URL may live at most. @default 7 days */
  readonly maxSignedUrlSeconds?: number
  /** Transforms images on request; without it image transformations are off. */
  readonly images?: ImageRenderer
}

/** What an upload writes besides the content. */
export interface UploadOptions {
  readonly contentType: string
  /** Replace a file that exists at the path. @default false */
  readonly upsert?: boolean
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** A requested byte range: from `start` to `end` (or the end of the file), or the last `suffix` bytes. */
export type RangeRequest =
  { readonly start: number; readonly end?: number } | { readonly suffix: number }

/** A file being read: its metadata, the content and the range served. */
export interface OpenedObject {
  readonly object: ObjectInfo
  readonly body: ReadableStream<Uint8Array>
  /** The range served, or `undefined` for the whole file. */
  readonly range: ByteRange | undefined
}

const MIB = 1024 * 1024
const DUPLICATE_KEY = 11000
const ABORT = Symbol("dry run")

function info(object: StoredObject): ObjectInfo {
  const { _id: _, key: __, ...rest } = object
  return rest
}

/** The `sub` claim of a caller, the owner of what it stores. */
function ownerOf(caller: Caller): string | null {
  const sub = caller.context.claims?.["sub"]
  return typeof sub === "string" ? sub : null
}

/**
 * File storage with DLS: every stored file has a metadata document that the policies of the reserved
 * collection `storage.objects` apply to, as they apply to app documents. Reads need `USING(read)`; uploads
 * need `CHECK(insert)`, or `USING(update)` and `CHECK(update)` to replace a file; deletes need
 * `USING(delete)`. Checks run in MongoDB inside the transaction that writes the metadata, and content is
 * stored under a fresh key first, so a refused write leaves nothing behind.
 */
export class Storage {
  readonly backend: StorageBackend
  private readonly options: StorageOptions
  private readonly objects: Collection<StoredObject>
  private readonly uploads: Collection<UploadSession>
  private readonly variants: Collection<StoredVariant>
  private readonly rendering = new Map<string, Promise<RenderedVariant>>()

  constructor(options: StorageOptions) {
    this.options = options
    this.backend = options.backend
    const meta = options.client.db(options.metaDatabase)
    this.objects = meta.collection<StoredObject>("storage_objects")
    this.uploads = meta.collection<UploadSession>("storage_uploads")
    this.variants = meta.collection<StoredVariant>("storage_variants")
    const partSize = options.partSize ?? 8 * MIB
    if (partSize < 5 * MIB)
      throw new TypeError("The part size of resumable uploads must be at least 5 MiB")
  }

  /** The settings of a bucket. Throws `NotFoundError` for a bucket that is not configured. */
  bucket(name: string): BucketSettings {
    const settings = isBucketName(name) ? this.options.buckets[name] : undefined
    if (settings === undefined) throw new NotFoundError(`No bucket is named ${name}`)
    return settings
  }

  private get partSize(): number {
    return this.options.partSize ?? 8 * MIB
  }

  private engine(): PolicyEngine {
    return this.options.policies()
  }

  private readFilter(caller: Caller): Document {
    return toFilter(this.engine().using(STORAGE_COLLECTION, "read", caller.context))
  }

  private visible(caller: Caller, bucket: string, path: string): Promise<StoredObject | null> {
    return this.objects.findOne({ $and: [{ bucket, path }, this.readFilter(caller)] })
  }

  private checkFile(
    bucket: string,
    path: string,
    size: number,
    contentType: string,
  ): BucketSettings {
    const settings = this.bucket(bucket)
    checkPath(path)
    if (size > settings.maxFileSize)
      throw new CanopyError(
        ErrorCode.PayloadTooLarge,
        `Files in ${bucket} may not exceed ${settings.maxFileSize} bytes`,
      )
    checkType(contentType, settings.allowedTypes)
    return settings
  }

  /**
   * Writes a metadata document under the policies: inserts it, or replaces `existing`, and checks the result
   * in the same transaction. With `dryRun` the transaction is always rolled back, to test a write early.
   */
  private async commit(
    caller: Caller,
    next: StoredObject,
    existing: StoredObject | null,
    dryRun = false,
  ): Promise<void> {
    const ctx = caller.context
    const engine = this.engine()
    const op: Operation = existing === null ? "insert" : "update"
    if (!ctx.roles.has(Role.Service) && !engine.hasGrant(STORAGE_COLLECTION, op, ctx))
      throw new ForbiddenError(`No storage policy grants ${op} to these roles`)
    const session = this.options.client.startSession()
    try {
      await session.withTransaction(async () => {
        if (existing === null) {
          await this.objects.insertOne(next, { session })
        } else {
          const target = toFilter(engine.target(STORAGE_COLLECTION, "update", ctx))
          const replaced = await this.objects.findOneAndReplace(
            { $and: [{ _id: existing._id, key: existing.key }, target] },
            next,
            { session },
          )
          if (replaced === null) throw new NotFoundError("No such file")
        }
        const check = engine.check(STORAGE_COLLECTION, op, ctx)
        if (check.kind !== "all") {
          const passes = await this.objects.findOne(
            { $and: [{ _id: next._id }, toFilter(check)] },
            { session, projection: { _id: 1 } },
          )
          if (passes === null)
            throw new PolicyViolationError(
              `The file does not satisfy the ${op} check of storage.objects`,
            )
        }
        if (dryRun) throw ABORT
      })
    } catch (error: unknown) {
      if (error === ABORT) return
      if (error instanceof MongoServerError && error.code === DUPLICATE_KEY)
        throw new ConflictError("A file exists at this path; send x-upsert: true to replace it")
      throw error
    } finally {
      await session.endSession()
    }
  }

  /** The metadata document a write at `bucket/path` would store, replacing `existing` when given. */
  private nextObject(
    caller: Caller,
    bucket: string,
    path: string,
    existing: StoredObject | null,
    content: { key: string; size: number; contentType: string; etag: string },
    metadata: Readonly<Record<string, unknown>> | undefined,
  ): StoredObject {
    const now = new Date()
    return {
      _id: existing?._id ?? new ObjectId(),
      bucket,
      path,
      ...content,
      owner: existing === null ? ownerOf(caller) : existing.owner,
      metadata: metadata ?? existing?.metadata ?? {},
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
  }

  /** Stores a whole file in one request. */
  async upload(
    caller: Caller,
    bucket: string,
    path: string,
    body: Uint8Array,
    options: UploadOptions,
  ): Promise<ObjectInfo> {
    this.checkFile(bucket, path, body.byteLength, options.contentType)
    const existing = options.upsert === true ? await this.objects.findOne({ bucket, path }) : null
    const key = `${bucket}/${new ObjectId().toHexString()}`
    const next = this.nextObject(
      caller,
      bucket,
      path,
      existing,
      {
        key,
        size: body.byteLength,
        contentType: mediaType(options.contentType) || "application/octet-stream",
        etag: createHash("sha256").update(body).digest("hex"),
      },
      options.metadata,
    )
    await this.commit(caller, next, existing, true)
    await this.backend.put(key, body, next.contentType)
    try {
      await this.commit(caller, next, existing)
    } catch (error: unknown) {
      await this.backend.delete(key).catch(() => {})
      throw error
    }
    if (existing !== null) await this.discard(existing.key)
    return info(next)
  }

  /** Deletes stored content and every cached variant of it. A failure leaves garbage, never an error. */
  private async discard(key: string): Promise<void> {
    await this.backend.delete(key).catch(() => {})
    try {
      const variants = await this.variants.find({ key }, { projection: { _id: 1 } }).toArray()
      for (const { _id } of variants) await this.backend.delete(_id).catch(() => {})
      await this.variants.deleteMany({ key })
    } catch {
      return
    }
  }

  /** The metadata of a file the caller may read. Throws `NotFoundError` otherwise. */
  async stat(caller: Caller, bucket: string, path: string): Promise<ObjectInfo> {
    this.bucket(bucket)
    const object = await this.visible(caller, bucket, path)
    if (object === null) throw new NotFoundError("No such file")
    return this.readable(caller, object)
  }

  private readable(caller: Caller, object: StoredObject): ObjectInfo {
    return projectReadable(
      this.engine().readable(STORAGE_COLLECTION, caller.context),
      info(object) as unknown as Record<string, unknown>,
    ) as unknown as ObjectInfo
  }

  private async read(object: StoredObject, range: RangeRequest | undefined): Promise<OpenedObject> {
    const served = range === undefined ? undefined : clamp(range, object.size)
    return {
      object: info(object),
      body: await this.backend.get(object.key, served),
      range: served,
    }
  }

  private async findVisible(caller: Caller, bucket: string, path: string): Promise<StoredObject> {
    this.bucket(bucket)
    const object = await this.visible(caller, bucket, path)
    if (object === null) throw new NotFoundError("No such file")
    return object
  }

  private async findPublic(bucket: string, path: string): Promise<StoredObject> {
    if (!this.bucket(bucket).public) throw new NotFoundError("No such file")
    const object = await this.objects.findOne({ bucket, path })
    if (object === null) throw new NotFoundError("No such file")
    return object
  }

  private async findSigned(token: string, bucket: string, path: string): Promise<StoredObject> {
    const grant = this.options.signer.verify(token)
    if (grant === undefined || grant.bucket !== bucket || grant.path !== path)
      throw new CanopyError(ErrorCode.Unauthorized, "The signed URL is not valid or has expired")
    this.bucket(bucket)
    const object = await this.objects.findOne({ bucket, path })
    if (object === null) throw new NotFoundError("No such file")
    return object
  }

  /** Opens a file the caller may read. */
  async open(
    caller: Caller,
    bucket: string,
    path: string,
    range?: RangeRequest,
  ): Promise<OpenedObject> {
    const object = await this.findVisible(caller, bucket, path)
    const opened = await this.read(object, range)
    return { ...opened, object: this.readable(caller, object) }
  }

  /** Opens a file of a public bucket, without a policy. */
  async openPublic(bucket: string, path: string, range?: RangeRequest): Promise<OpenedObject> {
    return this.read(await this.findPublic(bucket, path), range)
  }

  /** Opens the file a signed URL token grants. */
  async openSigned(
    token: string,
    bucket: string,
    path: string,
    range?: RangeRequest,
  ): Promise<OpenedObject> {
    return this.read(await this.findSigned(token, bucket, path), range)
  }

  /** The image renderer, or `undefined` when image transformations are off. */
  get images(): ImageRenderer | undefined {
    return this.options.images
  }

  /** Opens a transformed image the caller may read. */
  async openImage(
    caller: Caller,
    bucket: string,
    path: string,
    transform: ImageTransform,
  ): Promise<OpenedObject> {
    const object = await this.findVisible(caller, bucket, path)
    const opened = await this.transformed(object, transform)
    return {
      ...opened,
      object: this.readable(caller, { ...object, ...opened.object }),
    }
  }

  /** Opens a transformed image of a public bucket, without a policy. */
  async openPublicImage(
    bucket: string,
    path: string,
    transform: ImageTransform,
  ): Promise<OpenedObject> {
    return this.transformed(await this.findPublic(bucket, path), transform)
  }

  /** Opens a transformed image of the file a signed URL token grants. */
  async openSignedImage(
    token: string,
    bucket: string,
    path: string,
    transform: ImageTransform,
  ): Promise<OpenedObject> {
    return this.transformed(await this.findSigned(token, bucket, path), transform)
  }

  /**
   * Serves a transformation of an image from the variant cache, or renders and caches it. Identical
   * transformations in flight share one rendering.
   */
  private async transformed(
    object: StoredObject,
    transform: ImageTransform,
  ): Promise<OpenedObject> {
    const images = this.options.images
    if (images === undefined) throw new NotFoundError("Image transformations are off")
    images.accepts(object.contentType, object.size)
    const hash = transformHash(transform)
    const variantKey = `${object.key}.variants/${hash}`
    const served = (
      variant: { readonly size: number; readonly contentType: string },
      body: ReadableStream<Uint8Array>,
    ): OpenedObject => ({
      object: {
        ...info(object),
        size: variant.size,
        contentType: variant.contentType,
        etag: `${object.etag}-${hash}`,
      },
      body,
      range: undefined,
    })
    const cached = await this.variants.findOne({ _id: variantKey })
    if (cached !== null) {
      try {
        return served(cached, await this.backend.get(variantKey))
      } catch (error: unknown) {
        if (!(error instanceof NotFoundError)) throw error
        await this.variants.deleteOne({ _id: variantKey })
      }
    }
    let pending = this.rendering.get(variantKey)
    if (pending === undefined) {
      pending = this.render(object, variantKey, transform, images).finally(() =>
        this.rendering.delete(variantKey),
      )
      this.rendering.set(variantKey, pending)
    }
    const variant = await pending
    return served(variant, bytesStream(variant.body))
  }

  /** Renders a variant and caches it, unless the source was replaced or deleted meanwhile. */
  private async render(
    object: StoredObject,
    variantKey: string,
    transform: ImageTransform,
    images: ImageRenderer,
  ): Promise<RenderedVariant> {
    const source = await collect(await this.backend.get(object.key), object.size)
    const rendered = await images.render(source, object.contentType, transform)
    const variant: StoredVariant = {
      _id: variantKey,
      key: object.key,
      size: rendered.body.byteLength,
      contentType: rendered.contentType,
      createdAt: new Date(),
    }
    try {
      const cached = await this.variants.countDocuments(
        { key: object.key },
        { limit: images.maxVariants },
      )
      if (cached >= images.maxVariants) return { ...variant, body: rendered.body }
      await this.backend.put(variantKey, rendered.body, rendered.contentType)
      await this.variants.replaceOne({ _id: variantKey }, variant, { upsert: true })
      if ((await this.objects.countDocuments({ key: object.key }, { limit: 1 })) === 0)
        await this.discard(object.key)
    } catch {
      await this.backend.delete(variantKey).catch(() => {})
    }
    return { ...variant, body: rendered.body }
  }

  /** A token that lets anyone read one file the caller may read, for `expiresIn` seconds. */
  async sign(
    caller: Caller,
    bucket: string,
    path: string,
    expiresIn: number,
  ): Promise<{ readonly token: string; readonly expiresAt: Date }> {
    const max = this.options.maxSignedUrlSeconds ?? 7 * 86_400
    if (!Number.isSafeInteger(expiresIn) || expiresIn < 1 || expiresIn > max)
      throw new InvalidQueryError(`expiresIn must be a number of seconds from 1 to ${max}`)
    this.bucket(bucket)
    if ((await this.visible(caller, bucket, path)) === null) throw new NotFoundError("No such file")
    const expiresAt = Date.now() + expiresIn * 1000
    return {
      token: this.options.signer.sign({ bucket, path, expiresAt }),
      expiresAt: new Date(expiresAt),
    }
  }

  /** Deletes a file the caller may delete. */
  async remove(caller: Caller, bucket: string, path: string): Promise<void> {
    this.bucket(bucket)
    const ctx = caller.context
    const engine = this.engine()
    if (!ctx.roles.has(Role.Service) && !engine.hasGrant(STORAGE_COLLECTION, "delete", ctx))
      throw new ForbiddenError("No storage policy grants delete to these roles")
    const removed = await this.objects.findOneAndDelete({
      $and: [{ bucket, path }, toFilter(engine.target(STORAGE_COLLECTION, "delete", ctx))],
    })
    if (removed === null) throw new NotFoundError("No such file")
    await this.discard(removed.key)
  }

  /** Lists the files of a bucket the caller may read, by path, after `after`. */
  async list(
    caller: Caller,
    bucket: string,
    options: { readonly prefix?: string; readonly limit?: number; readonly after?: string } = {},
  ): Promise<{ readonly data: readonly ObjectInfo[]; readonly next: string | undefined }> {
    this.bucket(bucket)
    const limit = options.limit ?? 100
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new InvalidQueryError("limit must be from 1 to 1000")
    const path: Record<string, unknown> = {}
    if (options.prefix !== undefined && options.prefix !== "")
      path["$regex"] = `^${escapeRegex(options.prefix)}`
    if (options.after !== undefined) path["$gt"] = options.after
    const found = await this.objects
      .find({
        $and: [
          { bucket, ...(Object.keys(path).length === 0 ? {} : { path }) },
          this.readFilter(caller),
        ],
      })
      .sort({ path: 1 })
      .limit(limit + 1)
      .toArray()
    const page = found.slice(0, limit)
    return {
      data: page.map((object) => this.readable(caller, object)),
      next: found.length > limit ? page.at(-1)?.path : undefined,
    }
  }

  /** Starts a resumable upload. The write is checked now, and again when it completes. */
  async createUpload(
    caller: Caller,
    bucket: string,
    path: string,
    options: UploadOptions & { readonly size: number },
  ): Promise<UploadStatus> {
    const max = this.options.maxUploadSize ?? 5 * 1024 * MIB
    if (!Number.isSafeInteger(options.size) || options.size < 1)
      throw new InvalidQueryError("size must be a positive number of bytes")
    if (options.size > max)
      throw new CanopyError(ErrorCode.PayloadTooLarge, `Uploads may not exceed ${max} bytes`)
    this.checkFile(bucket, path, options.size, options.contentType)
    const existing = options.upsert === true ? await this.objects.findOne({ bucket, path }) : null
    const key = `${bucket}/${new ObjectId().toHexString()}`
    const contentType = mediaType(options.contentType) || "application/octet-stream"
    await this.commit(
      caller,
      this.nextObject(
        caller,
        bucket,
        path,
        existing,
        { key, size: options.size, contentType, etag: "" },
        options.metadata,
      ),
      existing,
      true,
    )
    const now = Date.now()
    const session: UploadSession = {
      _id: randomUUID(),
      bucket,
      path,
      subject: caller.subject,
      size: options.size,
      contentType,
      metadata: options.metadata ?? {},
      upsert: options.upsert === true,
      key,
      uploadId: await this.backend.createMultipart(key, contentType),
      partSize: this.partSize,
      parts: {},
      createdAt: new Date(now),
      expiresAt: new Date(now + (this.options.uploadTtlMs ?? 86_400_000)),
    }
    await this.uploads.insertOne(session)
    return status(session)
  }

  private async session(caller: Caller, id: string): Promise<UploadSession> {
    const session = await this.uploads.findOne({ _id: id })
    if (
      session === null ||
      session.subject !== caller.subject ||
      session.expiresAt.getTime() <= Date.now()
    )
      throw new NotFoundError("No such upload")
    return session
  }

  /** The parts of a resumable upload stored so far. */
  async uploadStatus(caller: Caller, id: string): Promise<UploadStatus> {
    return status(await this.session(caller, id))
  }

  /** Stores one part of a resumable upload; every part but the last has exactly the part size. */
  async putPart(caller: Caller, id: string, part: number, body: Uint8Array): Promise<UploadStatus> {
    const session = await this.session(caller, id)
    const count = Math.ceil(session.size / session.partSize)
    if (!Number.isSafeInteger(part) || part < 1 || part > count)
      throw new InvalidQueryError(`The part number must be from 1 to ${count}`)
    const expected = part < count ? session.partSize : session.size - (count - 1) * session.partSize
    if (body.byteLength !== expected)
      throw new InvalidQueryError(
        `Part ${part} must have ${expected} bytes, not ${body.byteLength}`,
      )
    const etag = await this.backend.putPart(session.key, session.uploadId, part, body)
    const updated = await this.uploads.findOneAndUpdate(
      { _id: id },
      { $set: { [`parts.${part}`]: { etag, size: body.byteLength } } },
      { returnDocument: "after" },
    )
    if (updated === null) throw new NotFoundError("No such upload")
    return status(updated)
  }

  /** Joins the parts and stores the metadata document, checking the write again. */
  async completeUpload(caller: Caller, id: string): Promise<ObjectInfo> {
    const session = await this.session(caller, id)
    const count = Math.ceil(session.size / session.partSize)
    const parts = Array.from({ length: count }, (_, index) => {
      const stored = session.parts[String(index + 1)]
      if (stored === undefined) throw new ConflictError(`Part ${index + 1} has not been uploaded`)
      return { part: index + 1, etag: stored.etag }
    })
    await this.backend.completeMultipart(session.key, session.uploadId, parts)
    const existing = session.upsert
      ? await this.objects.findOne({ bucket: session.bucket, path: session.path })
      : null
    const next = this.nextObject(
      caller,
      session.bucket,
      session.path,
      existing,
      {
        key: session.key,
        size: session.size,
        contentType: session.contentType,
        etag: `${createHash("sha256")
          .update(parts.map((p) => p.etag).join(""))
          .digest("hex")}-${count}`,
      },
      session.metadata,
    )
    try {
      await this.commit(caller, next, existing)
    } catch (error: unknown) {
      await this.backend.delete(session.key).catch(() => {})
      await this.uploads.deleteOne({ _id: id })
      throw error
    }
    await this.uploads.deleteOne({ _id: id })
    if (existing !== null) await this.discard(existing.key)
    return info(next)
  }

  /** Drops a resumable upload and its parts. */
  async abortUpload(caller: Caller, id: string): Promise<void> {
    const session = await this.session(caller, id)
    await this.backend.abortMultipart(session.key, session.uploadId)
    await this.uploads.deleteOne({ _id: id })
  }

  /**
   * Drops the parts of uploads that expired unfinished, and what interrupted writes left in the backend.
   * Returns how many uploads were dropped.
   */
  async sweep(now: Date = new Date()): Promise<number> {
    const ttl = this.options.uploadTtlMs ?? 86_400_000
    await this.backend.sweep?.(new Date(now.getTime() - 2 * ttl)).catch(() => 0)
    let dropped = 0
    for (const session of await this.uploads
      .find({ expiresAt: { $lte: now } })
      .limit(1000)
      .toArray()) {
      await this.backend.abortMultipart(session.key, session.uploadId).catch(() => {})
      const removed = await this.uploads.deleteOne({ _id: session._id })
      dropped += removed.deletedCount
    }
    return dropped
  }
}

function bytesStream(body: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(body)
      controller.close()
    },
  })
}

/** Reads a stream of at most `size` bytes into one array. */
async function collect(stream: ReadableStream<Uint8Array>, size: number): Promise<Uint8Array> {
  const out = new Uint8Array(size)
  let offset = 0
  for await (const chunk of stream) {
    if (offset + chunk.byteLength > size)
      throw new CanopyError(ErrorCode.Internal, "The stored file is larger than its metadata says")
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return offset === size ? out : out.subarray(0, offset)
}

function status(session: UploadSession): UploadStatus {
  return {
    id: session._id,
    bucket: session.bucket,
    path: session.path,
    size: session.size,
    partSize: session.partSize,
    partCount: Math.ceil(session.size / session.partSize),
    parts: Object.keys(session.parts)
      .map(Number)
      .sort((a, b) => a - b),
    expiresAt: session.expiresAt,
  }
}

/** Fits a requested range into a file of `size` bytes. Throws when no byte of the file is in it. */
function clamp(range: RangeRequest, size: number): ByteRange {
  const unsatisfiable = (): never => {
    throw new CanopyError(ErrorCode.InvalidQuery, "The range is not satisfiable", {
      details: { rangeNotSatisfiable: true, size },
    })
  }
  if ("suffix" in range) {
    if (range.suffix < 1 || size === 0) unsatisfiable()
    return { start: Math.max(0, size - range.suffix), end: size - 1 }
  }
  const end = Math.min(range.end ?? size - 1, size - 1)
  if (range.start >= size || range.start > end) unsatisfiable()
  return { start: range.start, end }
}
