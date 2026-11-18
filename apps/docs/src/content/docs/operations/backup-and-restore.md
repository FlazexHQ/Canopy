---
title: Backup and restore
description: What to back up besides your app data, and how to restore Canopy's own databases.
---

Canopy keeps its state in two databases next to your app database. Back up all three together, from the same
point in time, with the backup tool you already use for MongoDB (Atlas backups, Ops Manager, or
`mongodump --oplog` against the replica set).

| Database      | Holds                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------- |
| your app DB   | your documents; Canopy adds no fields and no collections                                        |
| `canopy`      | published policies and their history, API keys (hashed), admin accounts, settings, the audit log, idempotency records, realtime checkpoints, applied meta migrations |
| `canopy_auth` | built in auth: users, accounts, sessions, revocations, signing keys (sealed), sign in limits      |

The names are the defaults; `CANOPY_META_DB` and `CANOPY_AUTH_DB` change them.

## Backing up

```sh
mongodump --uri "$MONGODB_URI" --oplog --gzip --archive=canopy.archive
```

`--oplog` makes the dump consistent across the three databases. Keep the archive together with a record of the
**master key** that was in use when it was taken: secrets in `canopy` and `canopy_auth` (TOTP secrets, signing
keys, OAuth client secrets) are sealed with it and cannot be opened without it. Keep the key in your secret
manager, not next to the archive.

## Restoring

1. Stop every Canopy instance (scale the Deployment to zero), so nothing writes during the restore.
2. Restore all three databases from the same archive:

   ```sh
   mongorestore --uri "$MONGODB_URI" --oplogReplay --gzip --archive=canopy.archive --drop
   ```

3. Start Canopy with the master key of the backup (if the key changed since, set the current one in
   `CANOPY_MASTER_KEY` and the backup's in `CANOPY_MASTER_KEY_PREVIOUS`). Meta migrations run on start, so an
   archive from an older version is brought up to date.
4. Expect every client to resync: their positions are newer than the restored data, so the realtime engine
   sends `resync` and clients take fresh snapshots. Mutations that were not acknowledged before the restore
   are retried by the SDK; those whose idempotency record was lost with the restore run again.

## Restoring only the app database

Policies, keys and users are independent of your documents, so you can restore the app database alone (for
example after a bad migration of your own) while Canopy runs. Connected clients receive the restored documents
as changes, or a `resync` when the restore drops collections.

Sessions and revocations in `canopy_auth` depend on time: restoring an old copy brings back sessions that were
signed out since. After restoring `canopy_auth` alone, sign everyone out (Studio, Settings, Danger zone, Revoke
all sessions) unless the copy is only minutes old.
