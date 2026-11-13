---
title: Standalone MongoDB
description: Canopy needs a replica set or a sharded cluster, because change streams and transactions do not run on a standalone server.
---

**Diagnostic:** `change streams are not available`

Canopy reads one change stream for realtime and commits every policy checked write in a multi document
transaction. MongoDB offers both only on a replica set or a sharded cluster, so the server refuses to start
against a standalone `mongod`.

## Fix

A single node replica set is enough for development and small deployments:

1. Start `mongod` with `--replSet rs0` (or set `replication.replSetName: rs0` in its config file).
2. Run `rs.initiate()` once in `mongosh`.
3. Add `replicaSet=rs0` to the connection string, for example
   `mongodb://localhost:27017/app?replicaSet=rs0`.

`bun run db:up` in this repository and `canopy dev --with-mongo` start such a replica set in Docker. MongoDB
Atlas clusters are replica sets already.
