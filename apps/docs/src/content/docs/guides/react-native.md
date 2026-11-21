---
title: React Native and Expo
description: Use the client in React Native and Expo apps, with persisters and app state driven reconnects.
---

The client runs in React Native and Expo with the platform's own `WebSocket` and `fetch`. Two pieces adapt it
to mobile: a persister for offline writes and sessions, and a lifecycle source, because React Native has no
`online` or `visibilitychange` events.

<!-- snippet: registered -->

```ts
import { createClient } from "@canopy/client"
import { mmkvPersister } from "@canopy/client/persist"
import { reactNativeLifecycle } from "@canopy/client/react-native"
import NetInfo from "@react-native-community/netinfo"
import { AppState } from "react-native"
import { MMKV } from "react-native-mmkv"
import { schema } from "./canopy.schema.ts"

const canopy = createClient({
  schema,
  url: "https://api.example.com",
  publishableKey: "pk_app",
  persist: mmkvPersister(new MMKV({ id: "canopy" })),
  cacheDocuments: true,
  lifecycle: reactNativeLifecycle({ AppState, NetInfo }),
})
```

`reactNativeLifecycle` reconnects as soon as the app returns to the foreground and stops retrying while
NetInfo reports no connection. NetInfo is optional; without it the client learns from failed connections.

## Persisters

| Persister                             | Storage                                     |
| ------------------------------------- | ------------------------------------------- |
| `mmkvPersister(mmkv)`                 | `react-native-mmkv`, synchronous and fast   |
| `asyncStoragePersister(AsyncStorage)` | `@react-native-async-storage/async-storage` |
| `indexedDbPersister()`                | Browsers, including Expo web                |
| `memoryPersister()`                   | Tests                                       |

Pending mutations are restored only for the user who queued them, so a second account on the same device
never sends or sees the first one's queue.

## Auth

`createAuth({ url, storage: mmkvPersister(...) })` works on mobile in the default `bearer` mode. OAuth sign in
needs a redirect URL registered in `auth.redirectUrls`, opened with the platform's browser session API.

The React hooks from `@canopy/react` work unchanged.
