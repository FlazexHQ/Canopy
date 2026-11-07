import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router"
import { type RenderResult, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  createMockAdmin,
  type MockAdmin,
  type MockAdminAccount,
  type MockAdminOptions,
  TEST_SESSION_HEADER,
} from "../mock/admin.ts"
import { AdminApi } from "../src/api/client.ts"
import { ApiProvider } from "../src/app/context.tsx"
import { routeTree } from "../src/routeTree.gen.ts"

/** An owner that exists in every harness unless `admins` is given. */
export const OWNER: MockAdminAccount = {
  id: "adm_owner",
  email: "owner@example.com",
  role: "owner",
  totp: true,
  password: "correct horse battery",
}

/** The authenticator code the mock accepts. */
export const TOTP_CODE = "123456"

/** An admin of another role, with an enrolled authenticator. */
export function adminOf(role: MockAdminAccount["role"]): MockAdminAccount {
  return {
    id: `adm_${role}`,
    email: `${role}@example.com`,
    role,
    totp: true,
    password: "correct horse battery",
  }
}

/** A `fetch` over the mock that keeps the session like a browser keeps the cookie. */
export function cookieFetch(mock: MockAdmin): typeof fetch {
  let session = ""
  return async (input, init) => {
    const request = new Request(new URL(String(input), "http://studio.test"), init)
    if (session !== "") request.headers.set(TEST_SESSION_HEADER, session)
    const response = await mock.fetch(request)
    const next = response.headers.get(TEST_SESSION_HEADER)
    if (next !== null) session = next
    return response
  }
}

/** Options of {@link renderStudio}. */
export interface HarnessOptions extends MockAdminOptions {
  /** Signs in as this admin before rendering; `false` starts signed out. */
  readonly signedInAs?: MockAdminAccount | false
  /** Changes the mock's state before Studio renders. */
  readonly prepare?: (mock: MockAdmin) => void
}

export interface Harness extends RenderResult {
  readonly mock: MockAdmin
  readonly api: AdminApi
  readonly user: ReturnType<typeof userEvent.setup>
  readonly router: ReturnType<typeof createRouter>
}

/**
 * Renders Studio at `path` (relative to `/studio`) with the real route tree, query cache and admin API
 * client, backed by the in memory mock.
 */
export async function renderStudio(path: string, options: HarnessOptions = {}): Promise<Harness> {
  const admins = options.admins ?? [OWNER]
  const mock = createMockAdmin({ ...options, admins })
  const api = new AdminApi({
    baseUrl: "http://studio.test",
    fetch: cookieFetch(mock),
    cookies: () => "",
  })
  const signedInAs = options.signedInAs ?? admins[0] ?? false
  if (signedInAs !== false) {
    await api.login({
      email: signedInAs.email,
      password: signedInAs.password,
      ...(signedInAs.totp === true ? { totp: TOTP_CODE } : {}),
    })
  }
  options.prepare?.(mock)
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const router = createRouter({
    routeTree,
    basepath: "/studio/",
    history: createMemoryHistory({ initialEntries: [`/studio${path}`] }),
    context: { api, queryClient },
  })
  const user = userEvent.setup()
  const result = render(
    <QueryClientProvider client={queryClient}>
      <ApiProvider api={api}>
        <RouterProvider router={router} />
      </ApiProvider>
    </QueryClientProvider>,
  )
  return {
    ...result,
    mock,
    api,
    user,
    router: router as unknown as ReturnType<typeof createRouter>,
  }
}

export { screen }
