import type { ClientOptions } from "canopy.js"
import { connect } from "./client.ts"

/**
 * The same application code, byte for byte, in the untyped, generated and registered fixtures: it must compile
 * and behave the same however the client is typed.
 */
export function app(options: ClientOptions) {
  const canopy = connect(options)
  const todos = canopy.from("todos")
  const created = todos.insert({ title: "Ship", done: false, ownerId: "u1" })
  const open = todos.find({ done: false }).sort({ title: 1 }).fields({ title: 1 })
  const titles = (): string[] => open.getState().data.map(({ title }) => String(title))
  const completed = todos.update(created.id, { $set: { done: true } }, { where: { done: false } })
  const tagged = todos.updateMany({ ownerId: "u1" }, { $push: { tags: "launch" } })
  return { canopy, created, completed, tagged, titles }
}
