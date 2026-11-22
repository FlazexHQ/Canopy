import { createClient, type Doc } from "canopy.js"
import { AuthError, createAuth } from "canopy.js/auth"
import { indexedDbPersister } from "canopy.js/persist"
import { schema } from "./canopy.schema.ts"

const byId = <E extends HTMLElement>(id: string): E => {
  const element = document.getElementById(id)
  if (element === null) throw new Error(`#${id} is missing from the page`)
  return element as E
}

const publishableKey =
  document.querySelector<HTMLMetaElement>('meta[name="canopy-key"]')?.content ?? ""
const auth = createAuth({
  url: location.origin,
  storage: indexedDbPersister({ name: "canopy-notes" }),
})
const canopy = createClient({ url: location.origin, publishableKey, auth, schema })

const signedOut = byId<HTMLElement>("signed-out")
const signedIn = byId<HTMLElement>("signed-in")
const list = byId<HTMLUListElement>("notes")
const status = byId<HTMLParagraphElement>("status")
const error = byId<HTMLParagraphElement>("error")
let stop: (() => void) | undefined

const report = (cause: unknown): void => {
  error.textContent =
    cause instanceof AuthError || cause instanceof Error ? cause.message : String(cause)
}

function renderNotes(notes: readonly Doc<"notes">[]): void {
  list.replaceChildren(
    ...notes.map((note) => {
      const item = document.createElement("li")
      const text = document.createElement("span")
      text.textContent = note.text
      const remove = document.createElement("button")
      remove.type = "button"
      remove.textContent = "Delete"
      remove.addEventListener("click", () => {
        canopy.from("notes").delete(note._id).catch(report)
      })
      item.append(text, remove)
      return item
    }),
  )
}

function show(): void {
  const user = auth.user
  stop?.()
  stop = undefined
  signedOut.hidden = user !== undefined
  signedIn.hidden = user === undefined
  if (user === undefined) {
    list.replaceChildren()
    return
  }
  byId("user-email").textContent = user.email ?? user.id
  stop = canopy
    .from("notes")
    .find({ ownerId: user.id })
    .sort({ createdAt: -1 })
    .limit(100)
    .subscribe(({ data, status: state }) => {
      status.textContent = state === "ready" ? `${data.length} notes` : state
      renderNotes(data)
    })
}

byId<HTMLFormElement>("auth-form").addEventListener("submit", (event) => {
  event.preventDefault()
  const form = event.currentTarget as HTMLFormElement
  const values = new FormData(form)
  const email = String(values.get("email"))
  const password = String(values.get("password"))
  const action = (event.submitter as HTMLButtonElement | null)?.value
  error.textContent = ""
  const done =
    action === "sign-up"
      ? auth.signUp({ email, password }).then(async (result) => {
          if ("verification" in result)
            error.textContent = "Check your inbox to verify the address."
        })
      : auth.signInWithPassword({ email, password })
  done.then(() => {
    form.reset()
    show()
  }, report)
})

byId<HTMLFormElement>("note-form").addEventListener("submit", (event) => {
  event.preventDefault()
  const form = event.currentTarget as HTMLFormElement
  const user = auth.user
  if (user === undefined) return
  const text = String(new FormData(form).get("text")).trim()
  if (text === "") return
  error.textContent = ""
  canopy.from("notes").insert({ text, ownerId: user.id, createdAt: new Date() }).catch(report)
  form.reset()
})

byId("sign-out").addEventListener("click", () => {
  auth.signOut().then(show, report)
})

auth.getToken().then(show, report)
