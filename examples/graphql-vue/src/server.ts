import { createBoardServer } from "./app.ts"

const env = process.env
const port = Number(env["PORT"] ?? "3000")
const board = await createBoardServer({
  mongoUri: env["MONGODB_URI"] ?? "mongodb://localhost:27017/?replicaSet=rs0",
  database: env["BOARD_DB"] ?? "graphql_vue",
  publicUrl: env["PUBLIC_URL"] ?? `http://localhost:${port}`,
  publishableKey: env["CANOPY_PUBLISHABLE_KEY"] ?? "pk_board_local",
  production: env["NODE_ENV"] === "production",
  ...(env["CANOPY_MASTER_KEY"] === undefined ? {} : { masterKey: env["CANOPY_MASTER_KEY"] }),
})
board.server.listen(port, () => {
  process.stdout.write(`graphql-vue on http://localhost:${port}/\n`)
})

let stopping = false
const stop = (): void => {
  if (stopping) return
  stopping = true
  board.close().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error)
      process.exit(1)
    },
  )
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
if (process.platform === "win32") process.on("SIGBREAK", stop)
