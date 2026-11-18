import { Transformer } from "@napi-rs/image"
import { describe, expect, it } from "vitest"
import { ImageRenderer, parseTransform } from "../src/index.ts"

/** A test image whose left half is red and right half blue, so a crop can be told from a squash. */
function pixels(width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const left = x < width / 2
      out.set([left ? 255 : 0, 0, left ? 0 : 255, 255], i)
    }
  return out
}

const png = (width: number, height: number) =>
  Transformer.fromRgbaPixels(pixels(width, height), width, height).png()
const jpeg = (width: number, height: number) =>
  Transformer.fromRgbaPixels(pixels(width, height), width, height).jpeg(90)

async function sizeOf(
  body: Uint8Array,
): Promise<{ width: number; height: number; format: string }> {
  const { width, height, format } = await new Transformer(body).metadata()
  return { width, height, format }
}

describe("parseTransform", () => {
  it("reads every parameter", () => {
    expect(
      parseTransform(
        new URLSearchParams("width=200&height=100&resize=contain&quality=60&format=webp"),
      ),
    ).toEqual({ width: 200, height: 100, resize: "contain", quality: 60, format: "webp" })
    expect(parseTransform(new URLSearchParams(""))).toEqual({})
  })

  it("refuses values out of range or of the wrong kind", () => {
    for (const query of [
      "width=0",
      "width=2501",
      "height=-1",
      "width=1.5",
      "width=1e3",
      "width=",
      "quality=19",
      "quality=101",
      "resize=crop",
      "format=gif",
      "format=",
    ])
      expect(() => parseTransform(new URLSearchParams(query)), query).toThrow(
        expect.objectContaining({ code: "CANOPY_INVALID_QUERY" }),
      )
    expect(() => parseTransform(new URLSearchParams("width=600"), 500)).toThrow("1 to 500")
  })
})

describe("ImageRenderer", () => {
  const renderer = new ImageRenderer({ maxSourceSize: 1_000_000 })

  it("covers the box by cropping, keeping the centre", async () => {
    const out = await renderer.render(await png(400, 200), "image/png", {
      width: 100,
      height: 100,
    })
    expect(out.contentType).toBe("image/png")
    expect(await sizeOf(out.body)).toEqual({ width: 100, height: 100, format: "png" })
    const raw = await new Transformer(out.body).rawPixels()
    const at = (x: number, y: number) => [...raw.subarray((y * 100 + x) * 4, (y * 100 + x) * 4 + 3)]
    expect(at(10, 50)).toEqual([255, 0, 0])
    expect(at(90, 50)).toEqual([0, 0, 255])
  })

  it("fits inside the box with contain, and stretches with fill", async () => {
    const source = await png(400, 200)
    const contained = await renderer.render(source, "image/png", {
      width: 100,
      height: 100,
      resize: "contain",
    })
    expect(await sizeOf(contained.body)).toMatchObject({ width: 100, height: 50 })
    const filled = await renderer.render(source, "image/png", {
      width: 100,
      height: 100,
      resize: "fill",
    })
    expect(await sizeOf(filled.body)).toMatchObject({ width: 100, height: 100 })
  })

  it("keeps the aspect ratio when only one side is given", async () => {
    const source = await png(400, 200)
    expect(
      await sizeOf((await renderer.render(source, "image/png", { width: 50 })).body),
    ).toMatchObject({ width: 50, height: 25 })
    expect(
      await sizeOf((await renderer.render(source, "image/png", { height: 50 })).body),
    ).toMatchObject({ width: 100, height: 50 })
    expect(
      await sizeOf((await renderer.render(source, "image/png", { width: 1 })).body),
    ).toMatchObject({ width: 1, height: 1 })
  })

  it("keeps the source format for origin and converts to the asked format", async () => {
    const source = await jpeg(64, 32)
    const origin = await renderer.render(source, "image/jpeg", { width: 32 })
    expect(origin.contentType).toBe("image/jpeg")
    expect((await sizeOf(origin.body)).format).toBe("jpeg")
    for (const [format, type] of [
      ["webp", "image/webp"],
      ["avif", "image/avif"],
      ["png", "image/png"],
      ["jpeg", "image/jpeg"],
    ] as const) {
      const out = await renderer.render(source, "image/jpeg", { format })
      expect(out.contentType).toBe(type)
      expect(await sizeOf(out.body)).toEqual({ width: 64, height: 32, format })
    }
  })

  it("lowers the size of lossy output with the quality", async () => {
    const noisy = new Uint8Array(256 * 256 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 37) % 251))
    const detailed = await Transformer.fromRgbaPixels(noisy, 256, 256).png()
    const high = await renderer.render(detailed, "image/png", { format: "jpeg", quality: 95 })
    const low = await renderer.render(detailed, "image/png", { format: "jpeg", quality: 20 })
    expect(low.body.byteLength).toBeLessThan(high.body.byteLength)
  })

  it("refuses types it cannot transform, sources over the limits, and data that is no image", async () => {
    await expect(
      renderer.render(new Uint8Array([60, 115, 118, 103]), "image/svg+xml", { width: 10 }),
    ).rejects.toMatchObject({ code: "CANOPY_INVALID_QUERY" })
    await expect(
      renderer.render(new Uint8Array(1_000_001), "image/png", { width: 10 }),
    ).rejects.toThrow("larger than 1000000 bytes")
    await expect(
      renderer.render(new TextEncoder().encode("not an image"), "image/png", { width: 10 }),
    ).rejects.toThrow("not an image that can be decoded")
    const small = new ImageRenderer({ maxPixels: 100 })
    await expect(small.render(await png(11, 10), "image/png", { width: 5 })).rejects.toThrow(
      "more than 100 pixels",
    )
    expect(
      await sizeOf((await small.render(await png(10, 10), "image/png", { width: 5 })).body),
    ).toMatchObject({ width: 5 })
  })

  it("runs at most `concurrency` transformations at once and finishes them all", async () => {
    const one = new ImageRenderer({ concurrency: 1 })
    const source = await png(200, 200)
    const results = await Promise.all(
      [10, 20, 30, 40].map((width) => one.render(source, "image/png", { width })),
    )
    expect(await Promise.all(results.map(async (r) => (await sizeOf(r.body)).width))).toEqual([
      10, 20, 30, 40,
    ])
  })
})
