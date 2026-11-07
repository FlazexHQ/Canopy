import { allow, auth, collection } from "@canopy/policy"

const visible = { $or: [{ shared: true }, { ownerId: auth("sub") }] }

/**
 * Todos: shared ones are visible to and editable by every signed in user, private ones only by their
 * owner. Only the owner may delete a todo, and nobody can create one in someone else's name.
 */
export const todos = collection("todos", {
  exposed: true,
  realtime: true,
  policies: [
    allow.read("authenticated").where(visible),
    allow.insert("authenticated").check({ ownerId: auth("sub") }),
    allow.update("authenticated").where(visible).check(visible),
    allow.delete("authenticated").where({ ownerId: auth("sub") }),
  ],
})
