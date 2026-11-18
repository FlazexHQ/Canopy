---
title: Upgrades
description: Upgrade Canopy and its meta database, and roll back safely.
---

## Rolling upgrade

Upgrade one instance at a time (the Kubernetes manifests and the Helm chart do this with `maxUnavailable: 0`):

1. Read the release notes (the changelog of `@canopy/server`) for breaking changes and new settings.
2. Back up `canopy` and `canopy_auth` ([backup and restore](/operations/backup-and-restore/)).
3. Roll out the new image. The first instance to start runs the meta migrations; the others wait for it.
4. Watch `/readyz`, the error rate and `canopy_changestream_restarts_total` while the rollout proceeds.

Connected clients are drained from each old instance during the drain window and reconnect to the others.

## Meta migrations

The meta database records the migrations applied to it. Each migration is forward only and idempotent, and one
instance at a time applies them, holding a lease (60 s); an instance that starts meanwhile waits up to two
minutes for it. `canopy migrate --status` lists applied and pending migrations, and `canopy migrate` applies
them without starting the server (for example as a Kubernetes Job before the rollout). When embedding Canopy,
`createCanopy(config, { migrate: false })` skips them on start.

Migrations never touch your app database: Canopy creates no collections and adds no fields there.

## Rolling back

Migrations only add (collections, indexes, default settings), so the previous version keeps working against a
migrated meta database within one minor version, and rolling back the image is enough. Across a larger jump,
restore the backup from step 2.

## MongoDB upgrades

Canopy needs a replica set on MongoDB 7.0 or later. Upgrade MongoDB the usual way (one member at a time, then
`setFeatureCompatibilityVersion`). An election closes change streams briefly; the realtime engine resumes from
its last position, so clients notice nothing unless the election outlasts the oplog window.
