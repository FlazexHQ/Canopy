---
title: Devtools
description: An in page panel for connections, subscriptions, the cache and mutations, plus development warnings.
---

```ts
import { attachDevtools } from "@canopy/devtools"

if (import.meta.env.DEV) attachDevtools(canopy)
```

A toggle button opens a panel with five tabs:

| Tab           | Shows                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| Connection    | The status, transport, session id and counts of subscriptions, pending mutations and cached documents |
| Subscriptions | Every live query with its filter, document count and status                                           |
| Store         | The cached documents per collection                                                                   |
| Mutations     | Pending mutations, which can be discarded, and stale ones                                             |
| Log           | The last protocol frames in both directions                                                           |

The panel is plain DOM with no framework, so it works with every binding.

## Warnings

`watchMistakes(canopy)` (on by default in the panel) warns in the console about common mistakes: a
subscription without `limit` whose result is large (500 documents by default, `largeResult` changes it), a
query with operators the client cannot evaluate, so optimistic writes do not move documents in or out of it,
and a mutation the server refused, with its error code.

```ts
import { attachDevtools } from "@canopy/devtools"

attachDevtools(canopy, { open: true, logSize: 500, warnings: false })
```

Keep devtools out of production builds: it shows every document the client holds.
