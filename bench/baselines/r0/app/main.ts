const tEval = performance.now()
const win = window as unknown as {
  __scriptStart: number
  __evalDuration: number
  __firstResultDuration?: number
  __firstReadyDuration?: number
  __done: boolean
  __error?: string
}
win.__evalDuration = tEval - win.__scriptStart

import { createClient } from "canopy.js"

const publishableKey = "canopy_pk_dev_test123456"
const serverUrl = "http://localhost:3000"

const client = createClient({
  url: serverUrl,
  publishableKey,
})

const query = client.live("notes", { public: true })

query.subscribe((state) => {
  if (win.__done) return
  if (state.status === "stale" || state.status === "ready") {
    const elapsed = performance.now() - win.__scriptStart
    win.__firstResultDuration ??= elapsed
    const el = document.getElementById("status")
    if (el !== null) {
      el.textContent = `${state.status}: ${state.data.length}`
    }
    if (state.status === "ready") {
      win.__firstReadyDuration = elapsed
      win.__done = true
    }
  } else if (state.status === "error") {
    win.__error = state.error?.message ?? "unknown query error"
    win.__done = true
    const el = document.getElementById("status")
    if (el !== null) {
      el.textContent = `error: ${win.__error}`
    }
  }
})
