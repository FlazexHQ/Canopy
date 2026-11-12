---
title: Multiple tabs
description: Share one realtime connection between the tabs of a browser.
---

```ts
import { createClient } from "@canopy/client"
import { leaderTab } from "@canopy/client/leader-tab"

const canopy = createClient({ url, publishableKey, shared: leaderTab() })
```

The tabs of an origin elect a leader with the Web Locks API. The leader holds the only WebSocket; the other tabs
reach it over a `BroadcastChannel`. A user with ten tabs open costs the server one connection.

- When the leader tab closes, the next tab takes over. Every client resubscribes and resends its pending
  mutations with the same mutation ids, so nothing is applied twice.
- Each tab keeps its own cache and optimistic layer; only the connection is shared.
- Tabs signed in as another user connect on their own, so one user's data never passes through another
  user's connection.
- Browsers without Web Locks or `BroadcastChannel` connect directly.

| Option         | Default   | What                                                        |
| -------------- | --------- | ----------------------------------------------------------- |
| `name`         | `default` | Separates apps served from one origin                       |
| `tabTimeoutMs` | 75 s      | How long a silent tab keeps its subscriptions on the leader |

Call `dispose()` on the returned object to leave the group, for example in tests.
