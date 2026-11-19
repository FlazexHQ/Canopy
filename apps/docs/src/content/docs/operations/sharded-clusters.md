---
title: Sharded clusters
description: Running Canopy against mongos, and keeping realtime latency low when some shards are idle.
---

Canopy runs against a sharded cluster the same way as against a replica set: point `mongodb.uri` at the
`mongos` routers (no `replicaSet` parameter, because mongos is a router). Snapshots, policies, writes and
resumable realtime subscriptions work across shards. `canopy doctor` reports the topology as
"Sharded cluster (mongos)".

## Idle shards and realtime latency

The realtime engine follows one change stream through mongos. mongos returns events in cluster time order, so
it holds an event back until every shard has reported a later time. A shard that receives no writes reports
its time only through a periodic no-op write, every 10 seconds by default. While one shard is idle, changes on
the other shards can therefore reach subscribers up to 10 seconds late.

The same delay affects acknowledgements. A write's `ack` waits up to 2 seconds for the write's change events,
so the client can drop its optimistic change without flicker. When the events arrive later than that, the ack
carries `echo: false` and the post images instead: the result is still correct, but the change reaches other
subscribers late.

Lower the no-op interval on every shard member to bound the delay. It is a startup parameter of `mongod`:

```sh
mongod --shardsvr --replSet shard1 --setParameter periodicNoopIntervalSecs=1
```

The sharded cluster in `deploy/compose/sharded.yaml` sets it to 1 second, which is what the sharded checks run
against. A busy cluster, where every shard receives writes continuously, does not need it.
