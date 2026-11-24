import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveConfig } from "@canopy/config"
import { createControlPlane } from "@canopy/control"
import { type CollectionPolicies, toStored } from "@canopy/policy"
import { builtin, listenCanopy, migrationStatus } from "@canopy/server"
import { describeWithMongo, MONGODB_URI, TEST_ENV } from "@canopy/testing"
import { expect, it } from "vitest"

describeWithMongo("the control plane", (handle) => {
  it("serves built in auth, admin and health, refuses data routes, and keeps webhooks running", async () => {
    const { client, collection } = handle()
    const suffix = randomUUID().slice(0, 8)
    const authDatabase = `canopy_control_auth_${suffix}`
    const root = await mkdtemp(join(tmpdir(), "canopy-control-"))
    try {
      const { config } = resolveConfig(
        {
          mongodb: {
            uri: MONGODB_URI,
            database: `canopy_control_app_${suffix}`,
            metaDatabase: collection("policies").dbName,
            authDatabase,
          },
          publicUrl: "http://127.0.0.1:8080",
          masterKey: "m".repeat(48),
          auth: builtin(),
          storage: { backend: { kind: "local", root }, buckets: { files: {} } },
          webhooks: {
            secret: "control-webhook-test-secret-012345",
            schedules: { nightly: { cron: "0 3 * * *", url: "http://hooks.test/nightly" } },
          },
        },
        { cwd: root, baseDir: root, command: "start", env: TEST_ENV },
      )
      await using control = await createControlPlane(config, { mongo: client, onSetupToken: false })
      const { info } = await control.keys.create({
        kind: "secret",
        name: "wire client",
        createdBy: "test",
      })
      const key = await control.keys.collection.findOne({ _id: info.id })
      expect(key).toMatchObject({ kind: "secret", scram: { iterations: 15_000 } })
      const http = await listenCanopy(control, 0, "127.0.0.1")
      try {
        const base = `http://127.0.0.1:${http.port}`
        const settings = await fetch(`${base}/auth/v1/settings`)
        expect(settings.status).toBe(200)
        expect(await settings.json()).toMatchObject({ issuer: "http://127.0.0.1:8080/auth/v1" })
        expect((await fetch(`${base}/.well-known/jwks.json`)).status).toBe(200)
        const setup = await fetch(`${base}/admin/v1/setup`)
        expect(setup.status).toBe(200)
        expect(await setup.json()).toEqual({ claimed: false })
        expect((await fetch(`${base}/healthz`)).status).toBe(200)
        expect((await fetch(`${base}/readyz`)).status).toBe(200)
        for (const path of [
          "/rest/v1",
          "/rest/v1/notes",
          "/graphql/v1",
          "/storage/v1",
          "/realtime/v1",
        ]) {
          const response = await fetch(`${base}${path}`)
          expect(response.status, path).toBe(404)
        }
        expect(await control.webhooks?.hooks()).toEqual([
          expect.objectContaining({ name: "nightly", kind: "schedule" }),
        ])
      } finally {
        await http.stop()
      }
    } finally {
      await client.db(authDatabase).dropDatabase()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it("migrates a fresh meta database, publishes the data plane format and skips unchanged versions", async () => {
    const { client } = handle()
    const meta = client.db(`canopy_control_meta_${randomUUID().slice(0, 8)}`)
    const folder = await mkdtemp(join(tmpdir(), "canopy-control-policies-"))
    try {
      const definition: CollectionPolicies = {
        collection: "notes",
        exposed: true,
        realtime: false,
        policies: [],
      }
      const expected = toStored(definition, { version: 1, updatedBy: "system:canopy-control" })
      await writeFile(
        join(folder, "notes.json"),
        JSON.stringify(toStored(definition, { version: 0 })),
      )
      const { config } = resolveConfig(
        {
          mongodb: {
            uri: MONGODB_URI,
            database: "canopy_control_unused",
            metaDatabase: meta.databaseName,
          },
          policies: { dir: folder, watch: false },
          masterKey: "m".repeat(48),
        },
        { cwd: folder, baseDir: folder, command: "start", env: TEST_ENV },
      )
      expect(await meta.listCollections().toArray()).toEqual([])
      const options = { mongo: client, onSetupToken: false } as const
      const start = async () => {
        await using control = await createControlPlane(config, options)
        expect(control.admin.policies.isWritable).toBe(true)
      }
      await start()
      const migrations = await migrationStatus(meta)
      expect(migrations.length).toBeGreaterThan(0)
      for (const migration of migrations) expect(migration.appliedAt).toBeInstanceOf(Date)
      const policies = meta.collection<{ _id: string }>("policies")
      const history = meta.collection("policy_history")
      const published = await policies.findOne({ _id: "notes" })
      expect(published).toEqual({ ...expected, updatedAt: expect.any(Date) })
      expect(await history.countDocuments()).toBe(1)
      await start()
      expect(await policies.findOne({ _id: "notes" })).toEqual(published)
      expect(await history.countDocuments()).toBe(1)
    } finally {
      await meta.dropDatabase()
      await rm(folder, { recursive: true, force: true })
    }
  }, 30_000)
})
