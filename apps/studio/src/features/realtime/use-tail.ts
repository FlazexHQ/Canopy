import { useEffect, useRef, useState } from "react"
import type { RealtimeEvent } from "../../api/contract.ts"
import { useApi } from "../../app/context.tsx"
import { openTailSource, parseTailMessage } from "./tail-source.ts"

/** How many events the tail keeps in memory. */
export const TAIL_CAPACITY = 500

export type TailStatus = "connecting" | "open" | "error"

/** The live event tail: newest first, bounded, with pause and clear. */
export interface Tail {
  readonly events: readonly RealtimeEvent[]
  readonly status: TailStatus
  readonly paused: boolean
  /** Events that arrived while paused. */
  readonly buffered: number
  /** Arrival times of recent events, for a client side rate. */
  readonly ratePerSecond: number
  pause(): void
  resume(): void
  clear(): void
}

export function useTail(): Tail {
  const api = useApi()
  const [events, setEvents] = useState<readonly RealtimeEvent[]>([])
  const [status, setStatus] = useState<TailStatus>("connecting")
  const [paused, setPaused] = useState(false)
  const pending = useRef<RealtimeEvent[]>([])
  const [buffered, setBuffered] = useState(0)
  const pausedRef = useRef(false)
  const arrivals = useRef<number[]>([])
  const [rate, setRate] = useState(0)

  useEffect(() => {
    const source = openTailSource(api.url("/realtime/tail"))
    source.onopen = () => setStatus("open")
    source.onerror = () => setStatus("error")
    source.addEventListener("change", (message) => {
      const event = parseTailMessage(message.data)
      if (event === undefined) return
      setStatus("open")
      const now = Date.now()
      arrivals.current = [...arrivals.current.filter((at) => now - at < 10_000), now]
      if (pausedRef.current) {
        pending.current = [event, ...pending.current].slice(0, TAIL_CAPACITY)
        setBuffered(pending.current.length)
        return
      }
      setEvents((all) => [event, ...all].slice(0, TAIL_CAPACITY))
    })
    const timer = setInterval(() => {
      const now = Date.now()
      arrivals.current = arrivals.current.filter((at) => now - at < 10_000)
      setRate(arrivals.current.length / 10)
    }, 2000)
    return () => {
      clearInterval(timer)
      source.close()
    }
  }, [api])

  return {
    events,
    status,
    paused,
    buffered,
    ratePerSecond: rate,
    pause() {
      pausedRef.current = true
      setPaused(true)
    },
    resume() {
      pausedRef.current = false
      setPaused(false)
      const waiting = pending.current
      pending.current = []
      setBuffered(0)
      setEvents((all) => [...waiting, ...all].slice(0, TAIL_CAPACITY))
    },
    clear() {
      pending.current = []
      setBuffered(0)
      setEvents([])
    },
  }
}
