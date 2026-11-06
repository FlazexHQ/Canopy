import { Auth0Provider, useAuth0 } from "@auth0/auth0-react"
import { type ReactNode, useMemo, useState } from "react"
import type { PublicConfig, Session } from "./types.ts"

type Render = (session: Session) => ReactNode

const STORAGE_KEY = "helpdesk.devUser"

function remembered(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function remember(user: string | null): void {
  try {
    if (user === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, user)
  } catch {}
}

function DevSignIn({
  users,
  children,
}: {
  readonly users: Extract<PublicConfig["auth"], { kind: "dev" }>["users"]
  readonly children: Render
}): ReactNode {
  const [userId, setUserId] = useState(() => {
    const saved = remembered()
    return users.some((user) => user.id === saved) ? saved : null
  })
  const session = useMemo<Session | undefined>(() => {
    const user = users.find((candidate) => candidate.id === userId)
    if (user === undefined) return undefined
    return {
      label: user.name,
      async getToken() {
        const response = await fetch("/dev/token", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ user: user.id }),
        })
        if (!response.ok) throw new Error(`The development issuer answered ${response.status}`)
        const { token } = (await response.json()) as { token: string }
        return token
      },
      signOut() {
        remember(null)
        setUserId(null)
      },
    }
  }, [users, userId])

  if (session !== undefined) return children(session)
  return (
    <main className="signin">
      <h1>Helpdesk</h1>
      <p>
        Running with the development issuer, a local stand in for Auth0. Pick a demo user, then open
        a second window as someone else to watch changes arrive live.
      </p>
      <div className="users">
        {users.map((user) => (
          <button
            key={user.id}
            type="button"
            onClick={() => {
              remember(user.id)
              setUserId(user.id)
            }}
          >
            {user.name}
          </button>
        ))}
      </div>
    </main>
  )
}

function Auth0Gate({ children }: { readonly children: Render }): ReactNode {
  const {
    isLoading,
    isAuthenticated,
    error,
    user,
    loginWithRedirect,
    logout,
    getAccessTokenSilently,
  } = useAuth0()
  const subject = user?.sub
  const name = user?.name ?? user?.email ?? subject ?? "Signed in"
  const session = useMemo<Session>(
    () => ({
      label: name,
      async getToken() {
        const token = await getAccessTokenSilently()
        if (token === undefined || token === "") throw new Error("Auth0 returned no access token")
        return token
      },
      signOut: () => {
        logout({ logoutParams: { returnTo: window.location.origin } }).catch(() => {})
      },
    }),
    [name, getAccessTokenSilently, logout],
  )
  if (isLoading) return <main className="signin">Signing in…</main>
  if (error !== undefined) return <main className="signin">Auth0 error: {error.message}</main>
  if (!isAuthenticated || subject === undefined) {
    return (
      <main className="signin">
        <h1>Helpdesk</h1>
        <button type="button" onClick={() => loginWithRedirect().catch(() => {})}>
          Sign in with Auth0
        </button>
      </main>
    )
  }
  return children(session)
}

/** Signs the user in with Auth0 or the development issuer, then renders `children` with the session. */
export function SignIn({
  auth,
  children,
}: {
  readonly auth: PublicConfig["auth"]
  readonly children: Render
}): ReactNode {
  if (auth.kind === "dev") return <DevSignIn users={auth.users}>{children}</DevSignIn>
  return (
    <Auth0Provider
      domain={auth.domain}
      clientId={auth.clientId}
      authorizationParams={{ audience: auth.audience, redirect_uri: window.location.origin }}
    >
      <Auth0Gate>{children}</Auth0Gate>
    </Auth0Provider>
  )
}
