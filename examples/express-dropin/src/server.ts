import { createApp } from "./app.ts"
import { configFromEnv } from "./config.ts"

const config = configFromEnv(process.env)
const helpdesk = await createApp(config)
const server = helpdesk.app.listen(config.port, (error?: Error | null) => {
  if (error) throw error
  const auth =
    config.identity.kind === "dev" ? "development issuer" : `Auth0 (${config.identity.domain})`
  process.stdout.write(`Helpdesk on http://localhost:${config.port} with ${auth}\n`)
  process.stdout.write(`Live updates from canopy-realtime at ${config.canopyUrl}\n`)
})

let stopping = false
const stop = (): void => {
  if (stopping) return
  stopping = true
  server.close()
  helpdesk.close().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error)
      process.exit(1)
    },
  )
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
