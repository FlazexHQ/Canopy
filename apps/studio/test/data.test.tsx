import { canonicalString } from "@canopy/protocol"
import { EditorView } from "@codemirror/view"
import { waitFor, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { StoredPolicyInput } from "../mock/admin.ts"
import { conditionsToFilter, filterToConditions, parseValue } from "../src/features/data/filter.ts"
import { collectDocuments } from "../src/features/data/transfer-dialogs.tsx"
import { buildViewAs } from "../src/features/data/view-as-dialog.tsx"
import { renderStudio, screen } from "./harness.tsx"

const TODOS_POLICY: StoredPolicyInput = {
  _id: "todos",
  exposed: true,
  realtime: true,
  policies: [
    {
      name: "read own",
      kind: "permissive",
      ops: ["read"],
      roles: ["authenticated"],
      using: canonicalString({ ownerId: { $auth: "sub" } }),
    },
    {
      name: "delete own",
      kind: "permissive",
      ops: ["delete"],
      roles: ["authenticated"],
      using: canonicalString({ ownerId: { $auth: "sub" } }),
    },
  ],
  fields: { read: { default: { omit: ["internalNotes"] } } },
}

function editorIn(container: HTMLElement, label: string): EditorView {
  const content = within(container).getByLabelText(label)
  const view = EditorView.findFromDOM(content)
  if (view === null) throw new Error(`No editor labelled ${label}`)
  return view
}

function setEditor(view: EditorView, text: string): void {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
}

async function grid(): Promise<HTMLElement> {
  return screen.findByRole("table", { name: /Documents of todos/ })
}

const bodyRows = (table: HTMLElement) => within(table).getAllByRole("row").slice(1)

describe("filter builder model", () => {
  it("builds filters with typed values and folds several operators on one field", () => {
    expect(
      conditionsToFilter([
        { field: "done", op: "$eq", value: "true" },
        { field: "priority", op: "$gte", value: "2" },
        { field: "priority", op: "$lt", value: "5" },
        { field: "title", op: "$regex", value: "^Buy" },
        { field: "ownerId", op: "$in", value: "u_alice, u_bob" },
        { field: "", op: "$eq", value: "ignored" },
      ]),
    ).toEqual({
      done: true,
      priority: { $gte: 2, $lt: 5 },
      title: { $regex: "^Buy" },
      ownerId: { $in: ["u_alice", "u_bob"] },
    })
  })

  it("reads filters back, and refuses what the builder cannot show", () => {
    expect(filterToConditions({ ownerId: "u_alice", n: { $gt: 3 } })).toEqual([
      { field: "ownerId", op: "$eq", value: "u_alice" },
      { field: "n", op: "$gt", value: "3" },
    ])
    expect(filterToConditions({ _id: { $oid: "65f1a2b3c4d5e6f7a8b90001" } })).toEqual([
      { field: "_id", op: "$eq", value: '{"$oid":"65f1a2b3c4d5e6f7a8b90001"}' },
    ])
    expect(filterToConditions({ $or: [{ a: 1 }] })).toBeUndefined()
    expect(filterToConditions({ a: { $elemMatch: { b: 1 } } })).toBeUndefined()
    expect(parseValue("123", "$eq")).toBe(123)
    expect(parseValue('"123"', "$eq")).toBe("123")
    expect(parseValue("hello", "$eq")).toBe("hello")
  })

  it("round trips a string that looks like a number", () => {
    const conditions = filterToConditions({ code: "42" }) ?? []
    expect(conditionsToFilter(conditions)).toEqual({ code: "42" })
  })
})

describe("view as identities", () => {
  it("gives anon no claims and users the authenticated role plus extra roles", () => {
    const anon = buildViewAs({ mode: "anon", subject: "", email: "", roles: "", claims: "" })
    expect(anon.ok && anon.value.roles).toEqual(["anon"])
    expect(anon.ok && anon.value.claims).toEqual({})
    const user = buildViewAs({
      mode: "user",
      subject: "u_bob",
      email: "",
      roles: "editor, authenticated",
      claims: "",
    })
    expect(user.ok && user.value).toEqual({
      roles: ["authenticated", "editor"],
      claims: { sub: "u_bob" },
      label: "u_bob",
    })
    expect(buildViewAs({ mode: "user", subject: " ", email: "", roles: "", claims: "" }).ok).toBe(
      false,
    )
    expect(
      buildViewAs({ mode: "claims", subject: "", email: "", roles: "", claims: "[1]" }).ok,
    ).toBe(false)
  })
})

describe("export paging", () => {
  it("collects every page until a short one", async () => {
    const all = Array.from({ length: 1203 }, (_, index) => ({ _id: index }))
    const asked: number[] = []
    const documents = await collectDocuments(async (query) => {
      asked.push(query.skip ?? 0)
      const skip = query.skip ?? 0
      return { documents: all.slice(skip, skip + (query.limit ?? 0)) }
    }, {})
    expect(documents).toHaveLength(1203)
    expect(asked).toEqual([0, 500, 1000])
  })
})

describe("Collections page", () => {
  it("lists collections with counts and policy badges, and toggles exposure", async () => {
    const { user, mock } = await renderStudio("/data", { policies: [TODOS_POLICY] })
    const table = await screen.findByRole("table", { name: "Collections in the app database" })
    const todosRow = within(table)
      .getByRole("link", { name: "Browse documents of todos" })
      .closest("tr")
    if (todosRow === null) throw new Error("no todos row")
    expect(within(todosRow).getByText("24")).toBeTruthy()
    expect(within(todosRow).getByText("v1, 2 policies")).toBeTruthy()
    const ordersRow = within(table)
      .getByRole("link", { name: "Browse documents of orders" })
      .closest("tr")
    if (ordersRow === null) throw new Error("no orders row")
    expect(within(ordersRow).getByText("No policy")).toBeTruthy()
    await user.click(
      within(ordersRow).getByRole("switch", { name: "Expose orders through the Data API" }),
    )
    await waitFor(() => expect(mock.state.collections.get("orders")?.exposed).toBe(true))
    expect(mock.state.audit[0]).toMatchObject({ action: "collection.update", target: "orders" })
  })

  it("does not let a viewer change exposure", async () => {
    const viewer = {
      id: "adm_v",
      email: "viewer@example.com",
      role: "viewer" as const,
      password: "viewer password 1",
    }
    await renderStudio("/data", { admins: [viewer] })
    const toggle = await screen.findByRole("switch", { name: "Expose todos through the Data API" })
    expect((toggle as HTMLButtonElement).disabled).toBe(true)
  })
})

describe("Documents page", () => {
  it("keeps the builder and the JSON filter in sync and applies the filter to the grid", async () => {
    const { user, container } = await renderStudio("/data/todos")
    expect(bodyRows(await grid())).toHaveLength(20)
    await user.type(screen.getByLabelText("Field"), "ownerId")
    await user.type(screen.getByLabelText("Value"), "u_bob")
    await user.click(screen.getByRole("tab", { name: "JSON" }))
    const editor = editorIn(container, "Filter as EJSON")
    expect(JSON.parse(editor.state.doc.toString())).toEqual({ ownerId: "u_bob" })
    setEditor(editor, '{ "ownerId": "u_carol", "orgId": "o1" }')
    await user.click(screen.getByRole("tab", { name: "Builder" }))
    const fields = screen.getAllByLabelText("Field") as HTMLInputElement[]
    expect(fields.map((input) => input.value)).toEqual(["ownerId", "orgId"])
    await user.click(screen.getByRole("button", { name: "Apply filter" }))
    await waitFor(async () => {
      const rows = bodyRows(await grid())
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) expect(row.textContent).toContain("u_carol")
    })
    const expected = (await import("../mock/seed.ts"))
      .seedCollections()
      ["todos"]?.filter((todo) => todo["ownerId"] === "u_carol" && todo["orgId"] === "o1").length
    expect(bodyRows(await grid())).toHaveLength(expected ?? -1)
  })

  it("explains a filter the builder cannot show", async () => {
    const { user, container } = await renderStudio("/data/todos")
    await grid()
    await user.click(screen.getByRole("tab", { name: "JSON" }))
    setEditor(
      editorIn(container, "Filter as EJSON"),
      '{ "$or": [{ "done": true }, { "priority": 1 }] }',
    )
    await user.click(screen.getByRole("tab", { name: "Builder" }))
    expect(screen.getByText(/uses operators the builder cannot show/)).toBeTruthy()
  })

  it("inserts, replaces and deletes documents as service, each audited", async () => {
    const { user, mock } = await renderStudio("/data/todos")
    await grid()
    await user.click(screen.getByRole("button", { name: "Insert document" }))
    const dialog = await screen.findByRole("dialog")
    setEditor(
      editorIn(dialog, "Document as EJSON"),
      '{ "title": "From Studio", "ownerId": "u_alice" }',
    )
    await user.type(within(dialog).getByLabelText(/Reason/), "support ticket 7")
    await user.click(within(dialog).getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mock.state.collections.get("todos")?.documents).toHaveLength(25))
    expect(mock.state.audit[0]).toMatchObject({
      action: "document.insert",
      comment: "support ticket 7",
    })

    const firstEdit = (await screen.findAllByRole("button", { name: /^Edit document/ }))[0]
    if (firstEdit === undefined) throw new Error("no edit button")
    await user.click(firstEdit)
    const editDialog = await screen.findByRole("dialog")
    setEditor(
      editorIn(editDialog, "Document as EJSON"),
      '{ "title": "Renamed", "ownerId": "u_alice" }',
    )
    await user.click(within(editDialog).getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mock.state.audit[0]?.action).toBe("document.update"))
    const edited = mock.state.collections
      .get("todos")
      ?.documents.find((todo) => todo["title"] === "Renamed")
    expect(edited).toBeDefined()
    expect(Object.keys(edited ?? {}).sort()).toEqual(["_id", "ownerId", "title"])

    const firstDelete = (await screen.findAllByRole("button", { name: /^Delete document/ }))[0]
    if (firstDelete === undefined) throw new Error("no delete button")
    await user.click(firstDelete)
    const deleteDialog = await screen.findByRole("dialog")
    await user.click(within(deleteDialog).getByRole("button", { name: "Delete" }))
    await waitFor(() => expect(mock.state.collections.get("todos")?.documents).toHaveLength(24))
    expect(mock.state.audit[0]?.action).toBe("document.delete")
  })

  it("rejects invalid EJSON without writing", async () => {
    const { user, mock } = await renderStudio("/data/todos")
    await grid()
    await user.click(screen.getByRole("button", { name: "Insert document" }))
    const dialog = await screen.findByRole("dialog")
    setEditor(editorIn(dialog, "Document as EJSON"), '{ "_id": { "$oid": "nope" } }')
    await user.click(within(dialog).getByRole("button", { name: "Save" }))
    expect(await within(dialog).findByText(/not valid EJSON/)).toBeTruthy()
    expect(mock.state.collections.get("todos")?.documents).toHaveLength(24)
  })

  it("requires the collection name typed before a production delete", async () => {
    const { user, mock } = await renderStudio("/data/todos", { environment: "production" })
    await grid()
    const firstDelete = (await screen.findAllByRole("button", { name: /^Delete document/ }))[0]
    if (firstDelete === undefined) throw new Error("no delete button")
    await user.click(firstDelete)
    const dialog = await screen.findByRole("dialog")
    const confirm = within(dialog).getByRole("button", { name: "Delete" }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    await user.type(within(dialog).getByLabelText("Type todos to confirm"), "todo")
    expect(confirm.disabled).toBe(true)
    await user.type(within(dialog).getByLabelText("Type todos to confirm"), "s")
    expect(confirm.disabled).toBe(false)
    await user.click(confirm)
    await waitFor(() => expect(mock.state.collections.get("todos")?.documents).toHaveLength(23))
  })

  it("hides write actions from roles that cannot edit data", async () => {
    const developer = {
      id: "adm_d",
      email: "dev@example.com",
      role: "developer" as const,
      password: "developer password",
    }
    await renderStudio("/data/todos", { admins: [developer], environment: "production" })
    await grid()
    expect(screen.queryByRole("button", { name: "Insert document" })).toBeNull()
    expect(screen.queryAllByRole("button", { name: /^Delete document/ })).toHaveLength(0)
  })

  it("renders the page through a user's policies, read only, with hidden fields masked", async () => {
    const { user, mock } = await renderStudio("/data/todos", { policies: [TODOS_POLICY] })
    await grid()
    await user.click(screen.getByRole("button", { name: "View as" }))
    const dialog = await screen.findByRole("dialog")
    await user.type(within(dialog).getByLabelText("Subject (sub claim)"), "u_alice")
    await user.click(within(dialog).getByRole("button", { name: "View as" }))
    expect(await screen.findByText("Viewing as u_alice")).toBeTruthy()
    await waitFor(async () => expect(bodyRows(await grid())).toHaveLength(8))
    for (const row of bodyRows(await grid())) expect(row.textContent).toContain("u_alice")
    const header = within(await grid()).getByRole("columnheader", { name: /internalNotes/ })
    expect(header.textContent).toContain("hidden by policy")
    expect(within(await grid()).queryByText("Escalated by support")).toBeNull()
    expect(screen.queryByRole("button", { name: "Insert document" })).toBeNull()
    expect(mock.state.audit.some((entry) => entry.action === "impersonation.view")).toBe(true)
  })

  it("needs a reason before writing as the impersonated user, and audits it", async () => {
    const { user, mock } = await renderStudio("/data/todos", { policies: [TODOS_POLICY] })
    await grid()
    await user.click(screen.getByRole("button", { name: "View as" }))
    const pick = await screen.findByRole("dialog")
    await user.type(within(pick).getByLabelText("Subject (sub claim)"), "u_alice")
    await user.click(within(pick).getByRole("button", { name: "View as" }))
    await waitFor(async () => expect(bodyRows(await grid())).toHaveLength(8))
    await user.click(screen.getByRole("button", { name: "Allow writes as this identity" }))
    const unlock = await screen.findByRole("dialog")
    const allow = within(unlock).getByRole("button", { name: "Allow writes" }) as HTMLButtonElement
    expect(allow.disabled).toBe(true)
    await user.type(within(unlock).getByLabelText(/Reason/), "reproduce bug 12")
    await user.click(allow)
    const firstDelete = (await screen.findAllByRole("button", { name: /^Delete document/ }))[0]
    if (firstDelete === undefined) throw new Error("no delete button")
    await user.click(firstDelete)
    const confirm = await screen.findByRole("dialog")
    expect(within(confirm).queryByLabelText(/Reason/)).toBeNull()
    await user.click(within(confirm).getByRole("button", { name: "Delete" }))
    await waitFor(() =>
      expect(mock.state.audit.find((entry) => entry.action === "document.delete")).toMatchObject({
        comment: "reproduce bug 12",
        actor: "admin:owner@example.com",
        impersonating: "u_alice",
      }),
    )
    expect(mock.state.collections.get("todos")?.documents).toHaveLength(23)
  })

  it("imports documents from a CSV file", async () => {
    const { user, mock } = await renderStudio("/data/feedback")
    await screen.findByText("No documents match this filter.")
    await user.click(screen.getByRole("button", { name: "Import" }))
    const dialog = await screen.findByRole("dialog")
    const file = new File(['message,rating\nGreat app,5\n"Slow, sometimes",3\n'], "feedback.csv", {
      type: "text/csv",
    })
    await user.upload(within(dialog).getByLabelText("File"), file)
    expect(await within(dialog).findByText("2 documents ready to import")).toBeTruthy()
    await user.click(within(dialog).getByRole("button", { name: "Import" }))
    await waitFor(() => expect(mock.state.collections.get("feedback")?.documents).toHaveLength(2))
    const ratings = mock.state.collections
      .get("feedback")
      ?.documents.map((document) => document["rating"])
    expect(ratings).toEqual([5, 3])
    expect(await screen.findByText("Slow, sometimes")).toBeTruthy()
  })

  it("disables live updates with an explanation when the server issues no realtime tokens", async () => {
    await renderStudio("/data/todos")
    await grid()
    const toggle = await screen.findByRole("switch", { name: "Live" })
    await waitFor(() =>
      expect(
        screen.getByText("Live updates need a server that issues admin realtime tokens."),
      ).toBeTruthy(),
    )
    expect((toggle as HTMLButtonElement).disabled).toBe(true)
  })
})
