---
title: Realtime guarantees
description: How live queries stay correct across reconnects, failovers and missed events.
---

Canopy reads one change stream per deployment, not one per client. Events go through an in memory predicate
index to the live queries they affect, and identical queries share one observer.

## Snapshot, then stream

A live query starts with a snapshot read at a known cluster time. Change events after that time are applied
on top, so nothing between the snapshot and the first event is lost or applied twice.

## Ordered delivery

Every message on a connection carries a sequence number. The client applies messages in order and detects a
gap immediately.

## Resume and resync

When a connection drops, the client reconnects with its session id and last sequence number. Within the
resume window (two minutes by default) the server replays what was missed. When it cannot prove a gap free
replay, for example after a long disconnect or when the change stream itself had to restart, it sends
`resync`, and the client takes a fresh snapshot of each live query. Data is never dropped silently.

## Echo before ack

The acknowledgement of a mutation is sent only after the change events it caused. When the ack arrives, the
client already holds the server's version of the documents, so the optimistic layer is dropped without the
document flickering back to its old state.

## Full documents

Visibility decisions need the whole document. The `fullDocument` setting chooses how Canopy gets it:

| Mode           | How                                                                                   |
| -------------- | ------------------------------------------------------------------------------------- |
| `auto`         | Uses pre and post images when a collection has them, and reads the document otherwise |
| `updateLookup` | MongoDB looks up the current document for each update                                 |
| `images`       | Pre and post images only; `canopy realtime enable-images <collection>` turns them on  |

With pre images, Canopy can tell a client that a document left its query because an update made it invisible,
even when the new version cannot be read.

## Transports

The client prefers WebSockets. Where a proxy blocks them it falls back to server sent events, then long
polling, and probes for WebSockets again in the background. All three carry the same `canopy.v1` frames.
