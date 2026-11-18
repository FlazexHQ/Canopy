---
"@canopy/client": minor
"@canopy/react": minor
---

Add server rendering, multi-tab sharing and React Native support to the client.

- `@canopy/client/server`: `createServerClient({ url, publishableKey, token | cookies })` reads queries over REST as the request's user (cookies of built in auth are exchanged at `/auth/v1/token`), and `dehydrate()` turns the snapshots into JSON for the page. `client.hydrate(state)` seeds live queries with them: the documents show at once as `stale`, and events older than the snapshot's cluster time are ignored until the server confirms.
- `@canopy/client/leader-tab`: `createClient({ shared: leaderTab() })` elects one tab with the Web Locks API to hold the only socket; other tabs reach it over a `BroadcastChannel`. The next tab takes over when the leader closes, and every client resubscribes and resends its pending mutations with their original IDs. Tabs of another user connect directly.
- `@canopy/client/react-native`: `reactNativeLifecycle({ AppState, NetInfo })` drives reconnection from the app state, through the new `lifecycle` source option. `@canopy/client/persist` adds `mmkvPersister()`.
- `client.devtools()` exposes frame taps, subscriptions and the pending mutations for `@canopy/devtools`.
- `@canopy/react` adds `<Hydrate state>`, `useDocument(collection, id)` and `useSession()`, and is marked `"use client"` for React Server Components.

