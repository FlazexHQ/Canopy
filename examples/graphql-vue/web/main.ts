import { createClient, type DocumentSchema, type ObjectId } from "canopy.js"
import { createAuth } from "canopy.js/auth"
import { indexedDbPersister } from "canopy.js/persist"
import { canopyPlugin, useCanopy, useQuery } from "canopy.js/vue"
import { createApp, defineComponent, h, onMounted, ref, shallowRef, watch } from "vue"

interface Post {
  readonly _id: ObjectId
  title: string
  topicId: string
  ownerId: string
}

type Database = DocumentSchema<{ posts: Post }>

interface Topic {
  readonly _id: string
  readonly name: string
}

interface PostView {
  readonly _id: string
  readonly title: string
  readonly ownerId: string
  readonly topic: { readonly name: string } | null
}

const publishableKey =
  document.querySelector<HTMLMetaElement>('meta[name="canopy-key"]')?.content ?? ""
const auth = createAuth({
  url: location.origin,
  storage: indexedDbPersister({ name: "canopy-board" }),
})
const canopy = createClient<Database>({ url: location.origin, publishableKey, auth })

/** Runs a GraphQL operation as the signed in user and returns its data, or throws its first error. */
async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const token = await auth.getToken()
  const response = await fetch("/graphql/v1", {
    method: "POST",
    headers: {
      apikey: publishableKey,
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ query, variables }),
  })
  const body = (await response.json()) as { data?: T; errors?: { message: string }[] }
  const error = body.errors?.[0]
  if (error !== undefined) throw new Error(error.message)
  if (body.data === undefined) throw new Error(`GraphQL answered ${response.status} without data`)
  return body.data
}

const BOARD = `query Board {
  topics(sort: [{ field: name, direction: ASC }]) { nodes { _id name } }
  posts(sort: [{ field: _id, direction: DESC }], limit: 50) {
    nodes { _id title ownerId topic { name } }
  }
}`

const CREATE = `mutation Create($title: String!, $topicId: String!, $ownerId: String!) {
  insertPost(doc: { title: $title, topicId: $topicId, ownerId: $ownerId }) { _id }
}`

const REMOVE = `mutation Remove($id: ObjectId!) { deletePost(id: $id) { _id } }`

const Board = defineComponent(() => {
  const live = useQuery(useCanopy<Database>().from("posts").find({}).sort({ _id: -1 }).limit(50))
  const topics = shallowRef<readonly Topic[]>([])
  const posts = shallowRef<readonly PostView[]>([])
  const title = ref("")
  const topicId = ref("")
  const error = ref("")
  const me = ref("")

  const report = (cause: unknown): void => {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
  const load = async (): Promise<void> => {
    const data = await graphql<{ topics: { nodes: Topic[] }; posts: { nodes: PostView[] } }>(BOARD)
    topics.value = data.topics.nodes
    posts.value = data.posts.nodes
    if (topicId.value === "") topicId.value = data.topics.nodes[0]?._id ?? ""
  }
  const submit = (event: Event): void => {
    event.preventDefault()
    const text = title.value.trim()
    if (text === "") return
    error.value = ""
    graphql(CREATE, { title: text, topicId: topicId.value, ownerId: me.value }).then(() => {
      title.value = ""
      return load()
    }, report)
  }
  const remove = (id: string): void => {
    graphql(REMOVE, { id }).then(load, report)
  }

  onMounted(() => {
    me.value = auth.user?.id ?? ""
    load().catch(report)
  })
  watch(
    () => live.data.value,
    () => {
      load().catch(report)
    },
  )

  return () =>
    h("div", [
      h("h1", "Board"),
      h("form", { onSubmit: submit }, [
        h("input", {
          "aria-label": "Title",
          value: title.value,
          maxlength: 200,
          onInput: (event: Event) => {
            title.value = (event.target as HTMLInputElement).value
          },
        }),
        h(
          "select",
          {
            "aria-label": "Topic",
            value: topicId.value,
            onChange: (event: Event) => {
              topicId.value = (event.target as HTMLSelectElement).value
            },
          },
          topics.value.map((topic) => h("option", { value: topic._id }, topic.name)),
        ),
        h("button", { type: "submit" }, "Post"),
      ]),
      h("p", { role: "status" }, `${live.status.value}, ${posts.value.length} posts`),
      h(
        "ul",
        posts.value.map((post) =>
          h("li", { key: post._id }, [
            h("span", { class: "title" }, post.title),
            h("span", { class: "topic" }, post.topic?.name ?? ""),
            post.ownerId === me.value
              ? h("button", { type: "button", onClick: () => remove(post._id) }, "Delete")
              : null,
          ]),
        ),
      ),
      h("p", { role: "alert" }, error.value),
    ])
})

async function start(): Promise<void> {
  if ((await auth.getToken()) === null) await auth.signInAnonymously()
  createApp(Board).use(canopyPlugin(canopy)).mount("#app")
}

start().catch((cause: unknown) => {
  document.body.textContent = cause instanceof Error ? cause.message : String(cause)
})
