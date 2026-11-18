import { createHash } from "node:crypto"
import { CanopyError, ErrorCode, InvalidQueryError } from "@canopy/protocol"

/** How an image is fitted into the requested width and height. */
export type ResizeMode = "cover" | "contain" | "fill"

/** The format a transformed image is encoded in; `origin` keeps the format of the source. */
export type ImageFormat = "origin" | "webp" | "avif" | "jpeg" | "png"

/** A requested image transformation. Without width and height the image keeps its size. */
export interface ImageTransform {
  readonly width?: number
  readonly height?: number
  /** @default "cover" */
  readonly resize?: ResizeMode
  /** From 20 to 100, for lossy formats. @default 80 */
  readonly quality?: number
  /** @default "origin" */
  readonly format?: ImageFormat
}

/** Limits of image transformations. */
export interface ImageLimits {
  /** The largest width or height asked for, in pixels. @default 2500 */
  readonly maxDimension?: number
  /** The largest source image, in bytes. @default 25 MiB */
  readonly maxSourceSize?: number
  /** The largest source image, in pixels, read from its header before it is decoded. @default 50 million */
  readonly maxPixels?: number
  /** How many transformations run at once. @default 2 */
  readonly concurrency?: number
  /**
   * How many variants of one file are cached. Further transformations are rendered but not stored, so
   * requests for many sizes cannot fill the backend. @default 25
   */
  readonly maxVariants?: number
}

/** The media types that can be transformed, with the format each is encoded in for `origin`. */
const SOURCES: Readonly<Record<string, "jpeg" | "png" | "webp" | "avif">> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "png",
  "image/bmp": "png",
}
const TYPES = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", avif: "image/avif" }
const MODES: readonly string[] = ["cover", "contain", "fill"]
const FORMATS: readonly string[] = ["origin", "webp", "avif", "jpeg", "png"]

function whole(name: string, value: string, min: number, max: number): number {
  if (!/^\d{1,6}$/.test(value) || Number(value) < min || Number(value) > max)
    throw new InvalidQueryError(`${name} must be a whole number from ${min} to ${max}`)
  return Number(value)
}

/** Reads `width`, `height`, `resize`, `quality` and `format` from query parameters. */
export function parseTransform(params: URLSearchParams, maxDimension = 2500): ImageTransform {
  const width = params.get("width")
  const height = params.get("height")
  const resize = params.get("resize")
  const quality = params.get("quality")
  const format = params.get("format")
  if (resize !== null && !MODES.includes(resize))
    throw new InvalidQueryError("resize must be cover, contain or fill")
  if (format !== null && !FORMATS.includes(format))
    throw new InvalidQueryError("format must be origin, webp, avif, jpeg or png")
  return {
    ...(width === null ? {} : { width: whole("width", width, 1, maxDimension) }),
    ...(height === null ? {} : { height: whole("height", height, 1, maxDimension) }),
    ...(resize === null ? {} : { resize: resize as ResizeMode }),
    ...(quality === null ? {} : { quality: whole("quality", quality, 20, 100) }),
    ...(format === null ? {} : { format: format as ImageFormat }),
  }
}

/** The transformation with its defaults applied, as a canonical string. */
function transformId(transform: ImageTransform): string {
  return [
    `w${transform.width ?? ""}`,
    `h${transform.height ?? ""}`,
    transform.resize ?? "cover",
    `q${transform.quality ?? 80}`,
    transform.format ?? "origin",
  ].join("_")
}

/** A short hash of the canonical transformation, used in variant keys and etags. */
export function transformHash(transform: ImageTransform): string {
  return createHash("sha256").update(transformId(transform)).digest("hex").slice(0, 32)
}

/** Whether images of this media type can be transformed. */
function isTransformable(contentType: string): boolean {
  return contentType in SOURCES
}

type ImageModule = typeof import("@napi-rs/image")

let loading: Promise<ImageModule> | undefined

function loadImages(): Promise<ImageModule> {
  loading ??= import("@napi-rs/image").catch((error: unknown) => {
    loading = undefined
    throw new CanopyError(
      ErrorCode.Unavailable,
      "Image transformations are not available on this platform: @napi-rs/image could not be loaded",
      { cause: error },
    )
  })
  return loading
}

/** The width and height to resize to, keeping the aspect ratio when only one of them is given. */
function target(
  transform: ImageTransform,
  width: number,
  height: number,
): { width: number; height: number; keepRatio: boolean } | undefined {
  if (transform.width !== undefined && transform.height !== undefined)
    return { width: transform.width, height: transform.height, keepRatio: false }
  if (transform.width !== undefined)
    return {
      width: transform.width,
      height: Math.max(1, Math.round((height * transform.width) / width)),
      keepRatio: true,
    }
  if (transform.height !== undefined)
    return {
      width: Math.max(1, Math.round((width * transform.height) / height)),
      height: transform.height,
      keepRatio: true,
    }
  return undefined
}

/**
 * Resizes and re encodes images with `@napi-rs/image`, which is loaded when the first image is transformed.
 * Sources are checked against the limits before they are decoded, and at most `concurrency` images are
 * transformed at once.
 */
export class ImageRenderer {
  private readonly limits: Required<ImageLimits>
  private running = 0
  private readonly waiting: (() => void)[] = []

  constructor(limits: ImageLimits = {}) {
    this.limits = {
      maxDimension: limits.maxDimension ?? 2500,
      maxSourceSize: limits.maxSourceSize ?? 25 * 1024 * 1024,
      maxPixels: limits.maxPixels ?? 50_000_000,
      concurrency: limits.concurrency ?? 2,
      maxVariants: limits.maxVariants ?? 25,
    }
  }

  /** The largest width or height a transformation may ask for. */
  get maxDimension(): number {
    return this.limits.maxDimension
  }

  /** How many variants of one file are cached. */
  get maxVariants(): number {
    return this.limits.maxVariants
  }

  /** Throws `InvalidQueryError` when a source of this type and size cannot be transformed. */
  accepts(contentType: string, size: number): void {
    if (!isTransformable(contentType))
      throw new InvalidQueryError(
        "Only JPEG, PNG, WebP, AVIF, GIF and BMP images can be transformed",
      )
    if (size > this.limits.maxSourceSize)
      throw new InvalidQueryError(
        `Images larger than ${this.limits.maxSourceSize} bytes cannot be transformed`,
      )
  }

  private async slot<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= this.limits.concurrency)
      await new Promise<void>((resume) => this.waiting.push(resume))
    else this.running += 1
    try {
      return await work()
    } finally {
      const next = this.waiting.shift()
      if (next === undefined) this.running -= 1
      else next()
    }
  }

  /** Transforms an image. Returns the encoded image and its media type. */
  async render(
    source: Uint8Array,
    contentType: string,
    transform: ImageTransform,
  ): Promise<{ readonly body: Uint8Array; readonly contentType: string }> {
    this.accepts(contentType, source.byteLength)
    const images = await loadImages()
    return this.slot(async () => {
      let metadata: Awaited<ReturnType<InstanceType<ImageModule["Transformer"]>["metadata"]>>
      try {
        metadata = await new images.Transformer(source).metadata()
      } catch (error: unknown) {
        throw new InvalidQueryError("The file is not an image that can be decoded", {
          cause: error,
        })
      }
      if (metadata.width * metadata.height > this.limits.maxPixels)
        throw new InvalidQueryError(
          `Images of more than ${this.limits.maxPixels} pixels cannot be transformed`,
        )
      const image = new images.Transformer(source).rotate()
      const size = target(transform, metadata.width, metadata.height)
      if (size !== undefined) {
        const mode = transform.resize ?? "cover"
        image.resize({
          width: size.width,
          height: size.height,
          filter: images.ResizeFilterType.Lanczos3,
          fit:
            size.keepRatio || mode === "fill"
              ? images.ResizeFit.Fill
              : mode === "contain"
                ? images.ResizeFit.Inside
                : images.ResizeFit.Cover,
        })
      }
      const requested = transform.format ?? "origin"
      const format = requested === "origin" ? (SOURCES[contentType] ?? "png") : requested
      const quality = transform.quality ?? 80
      let body: Uint8Array
      try {
        body =
          format === "jpeg"
            ? await image.jpeg(quality)
            : format === "webp"
              ? await image.webp(quality)
              : format === "avif"
                ? await image.avif({ quality, speed: 8 })
                : await image.png()
      } catch (error: unknown) {
        throw new InvalidQueryError("The image could not be transformed", { cause: error })
      }
      return { body, contentType: TYPES[format] }
    })
  }
}
