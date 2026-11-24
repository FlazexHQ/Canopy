import { readFile } from "node:fs/promises"
import { Transformer } from "@napi-rs/image"

async function decode(path: string) {
  const image = new Transformer(await readFile(path))
  const { format, width, height } = await image.metadata()
  const pixels = await image.rawPixels()
  const channels = pixels.length / (width * height)
  if (channels !== 3 && channels !== 4)
    throw new Error(`Expected RGB or RGBA pixels, got ${channels} channels`)
  const sample = (pixel: number, channel: number) =>
    channel === 3 && channels === 3 ? 255 : (pixels[pixel * channels + channel] ?? 0)
  return { format, width, height, sample }
}

const [, , actualPath, referencePath] = process.argv
if (actualPath === undefined || referencePath === undefined)
  throw new Error("Two paths are required")
const actual = await decode(actualPath)
const reference = await decode(referencePath)
const { format, width, height } = reference
if (actual.format !== format || actual.width !== width || actual.height !== height)
  throw new Error(
    `Expected ${format} ${width}x${height}, got ${actual.format} ${actual.width}x${actual.height}`,
  )

const gridWidth = Math.min(width, 8)
const gridHeight = Math.min(height, 8)
const bins = new Int32Array(gridWidth * gridHeight * 4)
const counts = new Uint32Array(gridWidth * gridHeight)
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const bin =
      Math.floor((y * gridHeight) / height) * gridWidth + Math.floor((x * gridWidth) / width)
    counts[bin] = (counts[bin] ?? 0) + 1
    for (let channel = 0; channel < 4; channel++) {
      const source = y * width + x
      const target = bin * 4 + channel
      bins[target] =
        (bins[target] ?? 0) + actual.sample(source, channel) - reference.sample(source, channel)
    }
  }
}
const maxDifference = bins.reduce(
  (max, delta, index) => Math.max(max, Math.abs(delta) / (counts[Math.floor(index / 4)] ?? 1)),
  0,
)
if (maxDifference > 30)
  throw new Error(`Maximum channel difference is ${maxDifference}, expected at most 30`)
