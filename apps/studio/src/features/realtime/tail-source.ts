import { type RealtimeEvent, realtimeEventSchema } from "../../api/contract.ts"

/** The part of `EventSource` the tail uses, so tests can push events without a server. */
export interface TailSource {
  addEventListener(type: string, listener: (event: { readonly data?: unknown }) => void): void
  close(): void
  onopen: ((event: unknown) => void) | null
  onerror: ((event: unknown) => void) | null
}

export type TailSourceFactory = (url: string) => TailSource

/** A source that never connects, for runtimes without `EventSource`; the tail shows it as disconnected. */
function unavailable(): TailSource {
  const source: TailSource = {
    onopen: null,
    onerror: null,
    addEventListener() {},
    close() {},
  }
  queueMicrotask(() => source.onerror?.({}))
  return source
}

let factory: TailSourceFactory = (url) =>
  typeof EventSource === "undefined"
    ? unavailable()
    : (new EventSource(url, { withCredentials: true }) as unknown as TailSource)

/** Replaces how the tail connects; returns a function that restores the previous factory. */
export function setTailSourceFactory(next: TailSourceFactory): () => void {
  const previous = factory
  factory = next
  return () => {
    factory = previous
  }
}

export function openTailSource(url: string): TailSource {
  return factory(url)
}

/** Parses one `change` message; malformed messages are dropped rather than shown. */
export function parseTailMessage(data: unknown): RealtimeEvent | undefined {
  if (typeof data !== "string") return undefined
  try {
    return realtimeEventSchema.parse(JSON.parse(data))
  } catch {
    return undefined
  }
}
