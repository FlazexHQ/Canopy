import { type Doc, isCanopyError } from "canopy.js"
import {
  createReactDb,
  type ReactDb,
  useCanopy,
  useCanopyStatus,
  useMutationError,
  useStaleMutations,
} from "canopy.js/react"
import { type FormEvent, useMemo, useState } from "react"
/** A todo as stored in MongoDB, typed from `canopy.schema.ts`. */
export type Todo = Doc<"todos">

function explain(error: Error): string {
  if (isCanopyError(error, "CANOPY_CONFLICT"))
    return "Someone else changed that todo first, so your edit was undone."
  if (isCanopyError(error, "CANOPY_POLICY_VIOLATION") || isCanopyError(error, "CANOPY_FORBIDDEN"))
    return "You are not allowed to do that, so the change was undone."
  if (isCanopyError(error, "CANOPY_NOT_FOUND"))
    return "That todo is gone or not yours to change, so the change was undone."
  return error.message
}

function TodoRow({ todo, user, db }: { todo: Todo; user: string; db: TodoDb }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(todo.title)
  const rename = (event: FormEvent): void => {
    event.preventDefault()
    setEditing(false)
    if (title.trim() === "" || title === todo.title) return
    void db.todos.update(
      todo._id,
      { $set: { title: title.trim() }, $inc: { v: 1 } },
      { where: { v: todo.v } },
    )
  }
  return (
    <li data-testid="todo" data-title={todo.title} className={todo.done ? "done" : ""}>
      <input
        type="checkbox"
        aria-label={`Done: ${todo.title}`}
        checked={todo.done}
        onChange={() => void db.todos.update(todo._id, { $set: { done: !todo.done } })}
      />
      {editing ? (
        <form onSubmit={rename}>
          <input
            aria-label={`New title for ${todo.title}`}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <button type="submit">Save</button>
        </form>
      ) : (
        <span className="title">{todo.title}</span>
      )}
      <span className="meta">
        {todo.shared ? "shared" : "private"} · {todo.ownerId === user ? "you" : todo.ownerId}
      </span>
      {!editing && (
        <button
          type="button"
          onClick={() => {
            setTitle(todo.title)
            setEditing(true)
          }}
        >
          Rename {todo.title}
        </button>
      )}
      <button type="button" onClick={() => void db.todos.delete(todo._id)}>
        Delete {todo.title}
      </button>
    </li>
  )
}

type TodoDb = ReactDb

/** The todo list: optimistic, live across tabs and users, and usable offline. */
export function App({ user }: { user: string }) {
  const client = useCanopy()
  const status = useCanopyStatus()
  const db = useMemo(() => createReactDb(client), [client])
  const list = db.todos.useQuery({}, { sort: { createdAt: 1 } })
  const failure = useMutationError()
  const stale = useStaleMutations()
  const [title, setTitle] = useState("")
  const [shared, setShared] = useState(true)

  const add = (event: FormEvent): void => {
    event.preventDefault()
    if (title.trim() === "") return
    void db.todos.insert({
      title: title.trim(),
      done: false,
      shared,
      ownerId: user,
      v: 0,
      createdAt: new Date(),
    })
    setTitle("")
  }

  return (
    <main>
      <header>
        <h1>Todos for {user}</h1>
        <span data-testid="status" className={`status ${status}`}>
          {status}
        </span>
      </header>
      {failure.error !== undefined && (
        <p role="alert" data-testid="error">
          {explain(failure.error)}{" "}
          <button type="button" onClick={failure.clear}>
            Dismiss
          </button>
        </p>
      )}
      {stale.length > 0 && (
        <p data-testid="stale">
          {stale.length} change(s) from more than 20 hours ago were not sent.{" "}
          <button
            type="button"
            onClick={() => {
              for (const mutation of stale) void mutation.retry()
            }}
          >
            Send them
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              for (const mutation of stale) mutation.discard()
            }}
          >
            Discard them
          </button>
        </p>
      )}
      <form onSubmit={add} className="add">
        <input
          aria-label="New todo"
          placeholder="What needs doing?"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <label>
          <input
            type="checkbox"
            checked={shared}
            onChange={(event) => setShared(event.target.checked)}
          />{" "}
          Shared
        </label>
        <button type="submit">Add</button>
      </form>
      <p className="query" data-testid="query-status">
        {list.status}
      </p>
      <ul>
        {list.data.map((todo) => (
          <TodoRow key={todo._id.hex} todo={todo} user={user} db={db} />
        ))}
      </ul>
    </main>
  )
}
