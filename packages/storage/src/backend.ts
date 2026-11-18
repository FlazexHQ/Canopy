/** A byte range, both ends included, as in an HTTP `Range` header. */
export interface ByteRange {
  readonly start: number
  readonly end: number
}

/** A part of a multipart upload, as the backend acknowledged it. */
export interface UploadedPart {
  /** From 1. */
  readonly part: number
  readonly etag: string
}

/**
 * Where file contents live. Keys are chosen by Canopy (`<bucket>/<id>`), never by callers, and a key is
 * written once: replacing a file writes a new key and deletes the old one.
 */
export interface StorageBackend {
  /** A name for logs and the admin API: `local`, `r2` or `s3`. */
  readonly kind: string
  /** Stores the whole content of a key. */
  put(key: string, body: Uint8Array, contentType: string): Promise<void>
  /** Streams the content of a key, or one range of it. */
  get(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array>>
  /** Deletes a key; a missing key is not an error. */
  delete(key: string): Promise<void>
  /** Starts a multipart upload of a key and returns its id. */
  createMultipart(key: string, contentType: string): Promise<string>
  /** Stores one part (from 1); storing a part again replaces it. Returns its etag. */
  putPart(key: string, uploadId: string, part: number, body: Uint8Array): Promise<string>
  /** Joins the parts, in order, into the content of the key. */
  completeMultipart(key: string, uploadId: string, parts: readonly UploadedPart[]): Promise<void>
  /** Drops the parts of an upload. */
  abortMultipart(key: string, uploadId: string): Promise<void>
  /**
   * Removes what an interrupted write left behind, and multipart uploads untouched since `olderThan`.
   * Returns how many entries it removed. Stores that clean up by themselves leave it out.
   */
  sweep?(olderThan: Date): Promise<number>
}
