class Utf8Encoder {
  encode(value = "") {
    const text = String(value)
    const bytes = new Uint8Array(text.length * 3)
    let offset = 0
    for (const char of text) {
      let point = char.codePointAt(0)
      if (point >= 0xd800 && point <= 0xdfff) point = 0xfffd
      if (point < 0x80) {
        bytes[offset++] = point
      } else if (point < 0x800) {
        bytes[offset++] = 0xc0 | (point >> 6)
        bytes[offset++] = 0x80 | (point & 63)
      } else if (point < 0x10000) {
        bytes[offset++] = 0xe0 | (point >> 12)
        bytes[offset++] = 0x80 | ((point >> 6) & 63)
        bytes[offset++] = 0x80 | (point & 63)
      } else {
        bytes[offset++] = 0xf0 | (point >> 18)
        bytes[offset++] = 0x80 | ((point >> 12) & 63)
        bytes[offset++] = 0x80 | ((point >> 6) & 63)
        bytes[offset++] = 0x80 | (point & 63)
      }
    }
    return bytes.subarray(0, offset)
  }
}

class Utf8Decoder {
  constructor(label = "utf-8", { fatal = false, ignoreBOM = false } = {}) {
    if (!["utf-8", "utf8"].includes(label.toLowerCase())) throw new RangeError(label)
    this.fatal = fatal
    this.ignoreBOM = ignoreBOM
  }

  decode(input = new Uint8Array()) {
    const bytes = ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : new Uint8Array(input)
    let text = ""
    for (let index = 0; index < bytes.length;) {
      const first = bytes[index++]
      if (first < 0x80) {
        text += String.fromCharCode(first)
        continue
      }
      let remaining = first >= 0xc2 && first <= 0xf4 ? (first < 0xe0 ? 1 : first < 0xf0 ? 2 : 3) : 0
      let point = first & (0x7f >> (remaining + 1))
      let low = first === 0xe0 ? 0xa0 : first === 0xf0 ? 0x90 : 0x80
      let high = first === 0xed ? 0x9f : first === 0xf4 ? 0x8f : 0xbf
      let valid = remaining > 0
      while (valid && remaining > 0) {
        const next = bytes[index]
        valid = next >= low && next <= high
        if (valid) {
          index++
          remaining--
          point = (point << 6) | (next & 0x3f)
          low = 0x80
          high = 0xbf
        }
      }
      if (!valid && this.fatal) throw new TypeError("Invalid UTF8")
      text += valid ? String.fromCodePoint(point) : "\ufffd"
    }
    return !this.ignoreBOM && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  }
}

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

globalThis.TextEncoder ??= Utf8Encoder
globalThis.TextDecoder ??= Utf8Decoder
globalThis.atob ??= (text) => {
  let output = ""
  let bits = 0
  let buffer = 0
  for (const char of text.replace(/[\t\n\f\r ]/g, "").replace(/={1,2}$/, "")) {
    const digit = alphabet.indexOf(char)
    if (digit < 0) throw new TypeError("Invalid base64")
    buffer = (buffer << 6) | digit
    bits += 6
    if (bits >= 8) {
      bits -= 8
      output += String.fromCharCode((buffer >> bits) & 255)
    }
  }
  if (bits === 6) throw new TypeError("Invalid base64 length")
  return output
}
globalThis.btoa ??= (text) => {
  let output = ""
  let bits = 0
  let buffer = 0
  for (let index = 0; index < text.length; index++) {
    const byte = text.charCodeAt(index)
    if (byte > 255) throw new TypeError("Invalid base64 input")
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 6) {
      bits -= 6
      output += alphabet[(buffer >> bits) & 63]
    }
  }
  if (bits > 0) output += alphabet[(buffer << (6 - bits)) & 63]
  return output.padEnd(Math.ceil(output.length / 4) * 4, "=")
}
