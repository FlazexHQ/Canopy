import { createHash, randomUUID } from "node:crypto"
import { once } from "node:events"
import { Readable, type Writable } from "node:stream"
import { NotFoundError } from "@canopy/protocol"
import { type Db, GridFSBucket } from "mongodb"
import type { ByteRange, StorageBackend, UploadedPart } from "./backend.ts"

async function write(stream: Writable, chunk: Uint8Array): Promise<void> {
  if (!stream.write(chunk)) await once(stream, "drain")
}

async function finish(stream: Writable): Promise<void> {
  const done = once(stream, "finish")
  stream.end()
  await done
}

/**
 * Stores contents in GridFS, in the database given (the meta database, so the app database is untouched).
 * Multipart uploads keep each part as a file of its own until they are joined.
 */
export function gridfsBackend(db: Db, bucketName = "storage"): StorageBackend {
  const bucket = new GridFSBucket(db, { bucketName })
  const files = db.collection<{ _id: string; metadata?: { upload?: string } }>(
    `${bucketName}.files`,
  )
  const remove = async (id: string): Promise<void> => {
    if ((await files.countDocuments({ _id: id }, { limit: 1 })) === 0) return
    try {
      await bucket.delete(id as never)
    } catch (error: unknown) {
      if ((await files.countDocuments({ _id: id }, { limit: 1 })) > 0) throw error
    }
  }
  const upload = async (id: string, body: Uint8Array, metadata: object): Promise<void> => {
    await remove(id)
    const stream = bucket.openUploadStreamWithId(id as never, id, { metadata })
    await write(stream, body)
    await finish(stream)
  }
  const partId = (key: string, uploadId: string, part: number): string =>
    `${key}#${uploadId}#${part}`

  return {
    kind: "gridfs",
    put: (key, body, contentType) => upload(key, body, { contentType }),
    async get(key: string, range?: ByteRange) {
      if ((await files.countDocuments({ _id: key }, { limit: 1 })) === 0)
        throw new NotFoundError("The file content is missing")
      const stream = bucket.openDownloadStream(
        key as never,
        range === undefined ? {} : { start: range.start, end: range.end + 1 },
      )
      return Readable.toWeb(stream) as ReadableStream<Uint8Array>
    },
    delete: remove,
    createMultipart: async () => randomUUID(),
    async putPart(key, uploadId, part, body) {
      await upload(partId(key, uploadId, part), body, { upload: uploadId, part })
      return createHash("sha256").update(body).digest("hex")
    },
    async completeMultipart(key: string, uploadId: string, parts: readonly UploadedPart[]) {
      await remove(key)
      const target = bucket.openUploadStreamWithId(key as never, key)
      try {
        for (const { part } of [...parts].sort((a, b) => a.part - b.part)) {
          const source = bucket.openDownloadStream(partId(key, uploadId, part) as never)
          for await (const chunk of source) await write(target, chunk as Uint8Array)
        }
        await finish(target)
      } catch (error: unknown) {
        await target.abort().catch(() => {})
        throw error
      }
      for (const { part } of parts) await remove(partId(key, uploadId, part))
    },
    async abortMultipart(_key: string, uploadId: string) {
      const ids = await files
        .find({ "metadata.upload": uploadId }, { projection: { _id: 1 } })
        .toArray()
      for (const { _id } of ids) await remove(_id)
    },
  }
}
