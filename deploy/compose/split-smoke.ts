import { fileURLToPath } from "node:url"

const base = new URL(
  process.env["CANOPY_PUBLIC_URL"] ?? `http://localhost:${process.env["CANOPY_PORT"] ?? "8080"}`,
)
const secretKeys = process.env["CANOPY_SECRET_KEYS"] ?? "sk_dev_change_me"
const publishableKeys = process.env["CANOPY_PUBLISHABLE_KEYS"] ?? "pk_dev"
const key = secretKeys.split(",")[0]?.trim() ?? ""
const publishable = publishableKeys.split(",")[0]?.trim() ?? ""
const builtin = !process.argv.includes("--without-builtin-auth")
const composeFiles = builtin ? ["split.yaml", "split-auth.yaml"] : ["split.yaml"]
const compose = [
  "docker",
  "compose",
  "--project-name",
  `canopy-split-smoke-${crypto.randomUUID()}`,
  ...composeFiles.flatMap((file) => ["-f", fileURLToPath(new URL(file, import.meta.url))]),
]

async function run(args: string[], requireSuccess = true): Promise<void> {
  const child = Bun.spawn(args, {
    env: {
      ...process.env,
      CANOPY_SECRET_KEYS: secretKeys,
      CANOPY_PUBLISHABLE_KEYS: publishableKeys,
    },
    stdout: "inherit",
    stderr: "inherit",
  })
  const status = await child.exited
  if (status !== 0 && requireSuccess) throw new Error(`${args[0]} exited with status ${status}`)
}

async function request(path: string, status: number, init?: RequestInit): Promise<Response> {
  const response = await fetch(new URL(path, base), {
    ...init,
    signal: AbortSignal.timeout(15_000),
  })
  if (response.status !== status) {
    throw new Error(
      `${init?.method ?? "GET"} ${path} returned HTTP ${response.status}, expected ${status}`,
    )
  }
  return response
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function hasDocument(value: unknown, id: string): boolean {
  return Boolean(value && typeof value === "object" && "_id" in value && value._id === id)
}

async function writeAndRead(ownerId: string, headers: Record<string, string>): Promise<void> {
  const id = `split-smoke-${crypto.randomUUID()}`
  const inserted = await request("/rest/v1/notes", 201, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ _id: id, ownerId, text: "split smoke" }),
  })
  const written: unknown = await inserted.json()
  assert(
    written && typeof written === "object" && "data" in written && hasDocument(written.data, id),
    "insert response omitted the note",
  )
  const read = await request(`/rest/v1/notes/${id}`, 200, { headers })
  const json: unknown = await read.json()
  assert(
    json && typeof json === "object" && "data" in json && hasDocument(json.data, id),
    "read response omitted the inserted note",
  )
}

async function signIn(): Promise<{ sub: string; headers: Record<string, string> }> {
  const email = `split-${crypto.randomUUID()}@example.com`
  const credentials = { email, password: "split smoke test password" }
  const jsonHeaders = { "content-type": "application/json", origin: base.origin }
  const signUp = await request("/auth/v1/sign-up/email", 200, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ ...credentials, name: "Split smoke" }),
  })
  await signUp.text()
  const signIn = await request("/auth/v1/sign-in/email", 200, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(credentials),
  })
  const cookie = signIn.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ")
  const session: unknown = await signIn.json()
  assert(
    session &&
      typeof session === "object" &&
      "user" in session &&
      session.user &&
      typeof session.user === "object" &&
      "id" in session.user &&
      typeof session.user.id === "string",
    "sign in response omitted the user ID",
  )
  const response = await request("/auth/v1/token", 200, { headers: { cookie } })
  const token: unknown = await response.json()
  assert(
    token &&
      typeof token === "object" &&
      "access_token" in token &&
      typeof token.access_token === "string",
    "token response omitted the access token",
  )
  return {
    sub: session.user.id,
    headers: { apikey: publishable, authorization: `Bearer ${token.access_token}` },
  }
}

try {
  await run([
    ...compose,
    "up",
    "-d",
    process.argv.includes("--no-build") ? "--no-build" : "--build",
    "--wait",
    "--wait-timeout",
    "240",
  ])
  await request("/edge/healthz", 200)
  const studio = await request("/studio/", 200)
  assert((await studio.text()).includes("<title>Canopy Studio</title>"), "Studio index is missing")
  const icon = await request("/studio/favicon.svg", 200)
  assert(icon.headers.get("content-type")?.startsWith("image/svg+xml"), "Studio icon is missing")
  await writeAndRead("service", { apikey: key })
  const user = builtin ? await signIn() : undefined
  if (user) {
    await request("/.well-known/jwks.json", 200)
    await writeAndRead(user.sub, user.headers)
  }

  await run([...compose, "stop", "control"])
  const reply = await request("/admin/v1", 503)
  const problem: unknown = await reply.json()
  assert(
    problem &&
      typeof problem === "object" &&
      "code" in problem &&
      problem.code === "CANOPY_UNAVAILABLE",
    "admin response omitted the edge error code",
  )
  await writeAndRead("service", { apikey: key })
  if (user) {
    await request("/.well-known/jwks.json", 503)
    await Bun.sleep(5_100)
    await writeAndRead(user.sub, user.headers)
  }
  const ws = new URL("/realtime/v1", base)
  ws.protocol = base.protocol === "https:" ? "wss:" : "ws:"
  await run([
    process.execPath,
    fileURLToPath(new URL("../binary/ws-smoke.ts", import.meta.url)),
    ws.href,
    key,
  ])
  await request("/studio/", 200)
  process.stdout.write("Split stack smoke passed with the control service stopped\n")
} catch (error: unknown) {
  await run([...compose, "logs", "--tail", "100"], false)
  throw error
} finally {
  await run([...compose, "down", "--volumes"])
}
