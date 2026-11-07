import {
  ConflictError,
  type ObjectId,
  PolicyViolationError,
  type StaleMutation,
} from "@canopy/client"
import { createReactDb, useCanopy, useCanopyStatus } from "@canopy/react"
import { type FormEvent, useEffect, useMemo, useState } from "react"

/** A todo as stored in MongoDB. */
export interface Todo {
  readonly [key: string]: unknown
  readonly _id: ObjectId
  readonly title: string
  readonly done: boolean
  readonly shared: boolean
  readonly ownerId: string
  /** Bumped by every rename, so concurrent renames are detected with a `where` precondition. */
  readonly v: number
  readonly createdAt: Date
}

function explain(error: Error): string {
  if (error instanceof ConflictError)
    return "Someone else changed that todo first, so your edit was undone."
  if (error instanceof PolicyViolationError || error.name === "ForbiddenError")
    return "You are not allowed to do that, so the change was undone."
  if ((error as { code?: unknown }).code === "CANOPY_NOT_FOUND")
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
    void db.todos
      .update(todo._id, { $set: { title: title.trim() }, $inc: { v: 1 } }, { where: { v: todo.v } })
      .catch(() => {})
  }
  return (
    <li data-testid="todo" data-title={todo.title} className={todo.done ? "done" : ""}>
      <input
        type="checkbox"
        aria-label={`Done: ${todo.title}`}
        checked={todo.done}
        onChange={() =>
          void db.todos.update(todo._id, { $set: { done: !todo.done } }).catch(() => {})
        }
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
      <button type="button" onClick={() => void db.todos.delete(todo._id).catch(() => {})}>
        Delete {todo.title}
      </button>
    </li>
  )
}

type TodoDb = ReturnType<typeof createReactDb<{ todos: Todo }>>

/** The todo list: optimistic, live across tabs and users, and usable offline. */
export function App({ user }: { user: string }) {
  const client = useCanopy()
  const status = useCanopyStatus()
  const db = useMemo(() => createReactDb<{ todos: Todo }>(client), [client])
  const list = db.todos.useQuery({}, { sort: { createdAt: 1 } })
  const [error, setError] = useState<string | undefined>()
  const [stale, setStale] = useState<readonly StaleMutation[]>([])
  const [title, setTitle] = useState("")
  const [shared, setShared] = useState(true)

  useEffect(() => {
    const stop = client.onMutationError((failure) => setError(explain(failure)))
    return () => {
      stop()
    }
  }, [client])
  useEffect(() => {
    const stop = client.onStaleMutations((mutations) => setStale([...mutations]))
    return () => {
      stop()
    }
  }, [client])

  const add = (event: FormEvent): void => {
    event.preventDefault()
    if (title.trim() === "") return
    void db.todos
      .insert({
        title: title.trim(),
        done: false,
        shared,
        ownerId: user,
        v: 0,
        createdAt: new Date(),
      })
      .catch(() => {})
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
      {error !== undefined && (
        <p role="alert" data-testid="error">
          {error}{" "}
          <button type="button" onClick={() => setError(undefined)}>
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
              for (const mutation of stale) void mutation.retry().catch(() => {})
              setStale([])
            }}
          >
            Send them
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              for (const mutation of stale) mutation.discard()
              setStale([])
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
