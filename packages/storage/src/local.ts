import { createHash, randomUUID } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { mkdir, open, readdir, rename, rm, stat, unlink } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { CanopyError, ErrorCode, NotFoundError } from "@canopy/protocol"
import type { ByteRange, StorageBackend, UploadedPart } from "./backend.ts"

/** Where the local backend keeps files. */
export interface LocalOptions {
  /** The folder files are stored under, relative to the working directory unless absolute. Created when missing. */
  readonly root: string
}

const SEGMENT = /^[A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/
/** Device names Windows reserves in every folder, with or without an extension. */
const RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i
const UPLOAD_ID = /^[0-9a-f-]{36}$/
/** Temporary files older than this are left over from a crash and are removed by the sweep. */
const STALE_TEMPORARY_MS = 3_600_000

function hasCode(error: unknown, ...codes: string[]): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    codes.includes(String((error as { code: unknown }).code))
  )
}

function validSegment(segment: string): boolean {
  return SEGMENT.test(segment) && !RESERVED.test(segment)
}

/** Renames, retrying briefly while Windows still holds the target open (antivirus, a reader). */
async function renameInto(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error: unknown) {
      if (attempt >= 5 || !hasCode(error, "EPERM", "EBUSY", "EACCES")) throw error
      await new Promise((done) => setTimeout(done, 20 * 2 ** attempt))
    }
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

/**
 * Stores contents as files on disk: `<root>/objects/<key>`, parts of multipart uploads under
 * `<root>/uploads/<upload id>/`, and files being written under `<root>/tmp/` until they are complete and
 * renamed into place, so a reader never sees half a file. Keys must be relative paths of plain segments
 * (letters, digits, `.`, `_` and `-`) and always stay inside `root`. Several servers may share `root` only
 * through one shared volume.
 */
export async function localBackend(options: LocalOptions): Promise<StorageBackend> {
  const root = resolve(options.root)
  const objects = join(root, "objects")
  const uploads = join(root, "uploads")
  const tmp = join(root, "tmp")
  try {
    for (const folder of [objects, uploads, tmp]) await mkdir(folder, { recursive: true })
    const probe = join(tmp, `${randomUUID()}.probe`)
    await (await open(probe, "w")).close()
    await unlink(probe)
  } catch (error: unknown) {
    throw new CanopyError(
      ErrorCode.Internal,
      `The storage folder ${root} is not writable; set storage.backend.root to a folder this process may write to`,
      { cause: error },
    )
  }

  const pathOf = (key: string): string => {
    const segments = key.split("/")
    if (segments.some((segment) => !validSegment(segment)))
      throw new CanopyError(ErrorCode.Internal, `The storage key ${key} is not valid`)
    const path = join(objects, ...segments)
    if (!inside(objects, path))
      throw new CanopyError(ErrorCode.Internal, `The storage key ${key} is not valid`)
    return path
  }

  const uploadFolder = (uploadId: string): string => {
    if (!UPLOAD_ID.test(uploadId)) throw new NotFoundError("No such upload")
    return join(uploads, uploadId)
  }

  /** Writes a file under `tmp` with `write`, flushes it to disk and renames it to `target`. */
  const atomically = async (
    target: string,
    write: (path: string) => Promise<void>,
  ): Promise<void> => {
    const temporary = join(tmp, randomUUID())
    try {
      await write(temporary)
      const handle = await open(temporary, "r+")
      try {
        await handle.datasync()
      } finally {
        await handle.close()
      }
      await mkdir(resolve(target, ".."), { recursive: true })
      await renameInto(temporary, target)
    } catch (error: unknown) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }

  const writeBytes = async (target: string, body: Uint8Array): Promise<void> => {
    await atomically(target, async (path) => {
      const handle = await open(path, "w")
      try {
        await handle.writeFile(body)
      } finally {
        await handle.close()
      }
    })
  }

  return {
    kind: "local",
    async put(key, body) {
      await writeBytes(pathOf(key), body)
    },
    async get(key: string, range?: ByteRange) {
      const path = pathOf(key)
      let handle: Awaited<ReturnType<typeof open>>
      try {
        handle = await open(path, "r")
      } catch (error: unknown) {
        if (hasCode(error, "ENOENT", "ENOTDIR"))
          throw new NotFoundError("The file content is missing")
        throw error
      }
      const stream = createReadStream("", {
        fd: handle,
        autoClose: true,
        ...(range === undefined ? {} : { start: range.start, end: range.end }),
      })
      return Readable.toWeb(stream) as ReadableStream<Uint8Array>
    },
    async delete(key) {
      await rm(pathOf(key), { force: true })
    },
    async createMultipart() {
      const uploadId = randomUUID()
      await mkdir(uploadFolder(uploadId), { recursive: true })
      return uploadId
    },
    async putPart(_key, uploadId, part, body) {
      if (!Number.isSafeInteger(part) || part < 1)
        throw new CanopyError(ErrorCode.Internal, "Part numbers start at 1")
      const folder = uploadFolder(uploadId)
      try {
        await stat(folder)
      } catch {
        throw new NotFoundError("No such upload")
      }
      await writeBytes(join(folder, String(part)), body)
      return createHash("sha256").update(body).digest("hex")
    },
    async completeMultipart(key: string, uploadId: string, parts: readonly UploadedPart[]) {
      const folder = uploadFolder(uploadId)
      const ordered = [...parts].sort((a, b) => a.part - b.part)
      await atomically(pathOf(key), async (path) => {
        const target = createWriteStream(path)
        await pipeline(async function* () {
          for (const { part } of ordered) {
            try {
              yield* createReadStream(join(folder, String(part)))
            } catch (error: unknown) {
              if (hasCode(error, "ENOENT"))
                throw new CanopyError(ErrorCode.Conflict, `Part ${part} is missing`, {
                  cause: error,
                })
              throw error
            }
          }
        }, target)
      })
      await rm(folder, { recursive: true, force: true })
    },
    async abortMultipart(_key, uploadId) {
      await rm(uploadFolder(uploadId), { recursive: true, force: true })
    },
    async sweep(olderThan: Date) {
      let removed = 0
      const now = Date.now()
      for (const name of await readdir(tmp).catch(() => [] as string[])) {
        const path = join(tmp, name)
        const info = await stat(path).catch(() => undefined)
        if (info !== undefined && now - info.mtimeMs > STALE_TEMPORARY_MS) {
          await rm(path, { force: true, recursive: true })
          removed += 1
        }
      }
      for (const name of await readdir(uploads).catch(() => [] as string[])) {
        const path = join(uploads, name)
        const info = await stat(path).catch(() => undefined)
        if (info !== undefined && info.mtime < olderThan) {
          await rm(path, { force: true, recursive: true })
          removed += 1
        }
      }
      return removed
    },
  }
}
