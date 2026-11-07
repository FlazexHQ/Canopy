/** The demo user, from `?user=alice` or `?user=bob`. */
export const user: string = new URLSearchParams(location.search).get("user") ?? "alice"

const storageKey = `todo-react:token:${user}`

function expiresAt(token: string): number {
  try {
    const part = token.split(".")[1] ?? ""
    const claims = JSON.parse(atob(part.replaceAll("-", "+").replaceAll("_", "/"))) as {
      exp?: number
    }
    return (claims.exp ?? 0) * 1000
  } catch {
    return 0
  }
}

/**
 * Returns a token for the demo user from the development issuer. It is kept in `localStorage` so the app
 * still knows who it is when it starts offline and replays queued changes. A real app gets its token
 * from its identity provider instead.
 */
export async function token(): Promise<string> {
  const stored = localStorage.getItem(storageKey)
  if (stored !== null && expiresAt(stored) - Date.now() > 5 * 60_000) return stored
  const response = await fetch("/dev/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user }),
  })
  if (!response.ok) throw new Error(`The development issuer answered ${response.status}`)
  const fresh = ((await response.json()) as { token: string }).token
  localStorage.setItem(storageKey, fresh)
  return fresh
}
