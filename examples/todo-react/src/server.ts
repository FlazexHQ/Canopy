import { createTodoServer } from "./app.ts"

const env = process.env
const port = Number(env["PORT"] ?? "3000")
const todo = await createTodoServer({
  mongoUri: env["MONGODB_URI"] ?? "mongodb://localhost:27017/?replicaSet=rs0",
  database: env["TODO_DB"] ?? "todo_react",
  metaDatabase: env["CANOPY_META_DB"] ?? "canopy",
  publishableKey: env["CANOPY_PUBLISHABLE_KEY"] ?? "pk_todo_local",
  production: env["NODE_ENV"] === "production",
  disableWebSockets: env["TODO_DISABLE_WEBSOCKETS"] === "1",
  ...(env["TODO_DEV_ISSUER_KEY"] === undefined ? {} : { devIssuerKey: env["TODO_DEV_ISSUER_KEY"] }),
})
todo.server.listen(port, () => {
  process.stdout.write(`todo-react on http://localhost:${port}/?user=alice\n`)
})

let stopping = false
const stop = (): void => {
  if (stopping) return
  stopping = true
  todo.close().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error)
      process.exit(1)
    },
  )
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
