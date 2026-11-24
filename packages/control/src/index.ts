import { amendConfig, type ResolvedConfig } from "@canopy/config"
import { hashCollection, type PolicySet } from "@canopy/policy"
import { directoryPolicies } from "@canopy/realtime"
import {
  AuditLog,
  type Canopy,
  type CreateCanopyOptions,
  createCanopy,
  hashContexts,
  PolicyStore,
  planServerRole,
} from "@canopy/server"

/** Options for starting the control plane. */
export interface CreateControlPlaneOptions extends Pick<
  CreateCanopyOptions,
  "logger" | "mongo" | "onSetupToken"
> {
  /** Policy folder to publish at startup. Defaults to the configured folder. Pass false to skip publishing. */
  readonly policyDir?: string | false
}

async function publishPolicies(store: PolicyStore, local: PolicySet): Promise<void> {
  const actor = { type: "system", id: "canopy-control" } as const
  const { stored } = await store.all()
  const contexts = await store.getContexts()
  if (hashContexts(local.contexts) !== (contexts?.hash ?? hashContexts({}))) {
    await store.publishContexts({
      lookups: local.contexts,
      expectedVersion: contexts?.version ?? 0,
      actor,
    })
  }
  for (const definition of local.collections.values()) {
    const current = stored.get(definition.collection)
    if (current?.hash === hashCollection(definition)) continue
    await store.publish({ definition, expectedVersion: current?.version ?? 0, actor })
  }
}

/**
 * Starts the control plane with auth, the admin API and webhooks. Migrates the meta database and
 * publishes changed definitions from the policy folder before loading policies from MongoDB.
 */
export async function createControlPlane(
  config: ResolvedConfig,
  options: CreateControlPlaneOptions = {},
): Promise<Canopy> {
  const { policyDir = "dir" in config.policies ? config.policies.dir : false, ...server } = options
  const local = policyDir === false ? undefined : await directoryPolicies(policyDir).load()
  const plan = planServerRole(config, "control")
  const metaDatabase = config.mongodb.metaDatabase
  return createCanopy(
    amendConfig(plan.config, { policies: { source: "database", watch: config.policies.watch } }),
    {
      ...server,
      ...plan.options,
      migrate: true,
      ...(local === undefined
        ? {}
        : {
            afterMigrate: (client) =>
              publishPolicies(
                new PolicyStore({
                  client,
                  metaDatabase,
                  audit: new AuditLog(client.db(metaDatabase)),
                  writable: true,
                }),
                local,
              ),
          }),
    },
  )
}
