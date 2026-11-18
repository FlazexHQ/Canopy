import { policiesLint, policiesTest } from "./commands.ts"
import { policiesExplain } from "./explain.ts"
import {
  ANY,
  type CommandSpec,
  type Configured,
  count,
  databaseOf,
  text,
  withComment,
} from "./invocation.ts"
import {
  policiesDiff,
  policiesHistory,
  policiesPull,
  policiesPush,
  policiesRollback,
} from "./policies.ts"

const EXPLAIN_FLAGS = ["as", "roles", "op", "filter", "ctx"]

/** The `policies` commands: lint, test, explain, and the lifecycle in the meta database. */
export const POLICY_COMMANDS: Readonly<Record<string, CommandSpec>> = {
  "policies lint": {
    flags: [],
    handler: {
      kind: "config",
      load: "policies",
      run: (call) => policiesLint({ dir: call.dir }, call.out),
    },
  },
  "policies test": {
    flags: [],
    handler: {
      kind: "config",
      load: "policies",
      run: (call) =>
        policiesTest(
          { dir: call.dir, ...(call.uriFlag === undefined ? {} : { mongodbUri: call.uriFlag }) },
          call.out,
        ),
    },
  },
  "policies explain": {
    flags: EXPLAIN_FLAGS,
    args: [1, 1],
    needs: "exactly one collection",
    handler: { kind: "config", load: "policies", run: runExplain },
  },
  "policies diff": {
    flags: ["fail-on-drift", "env"],
    args: ANY,
    handler: {
      kind: "meta",
      run: (call, meta) =>
        policiesDiff(
          {
            ...meta,
            dir: call.dir,
            collections: call.args,
            failOnDrift: call.flags.has("fail-on-drift"),
          },
          call.out,
        ),
    },
  },
  "policies push": {
    flags: ["expect-version", "comment", "dry-run", "env"],
    args: ANY,
    handler: {
      kind: "meta",
      run: (call, meta) => {
        const expectVersion = text(call.flags, "expect-version")
        return policiesPush(
          {
            ...meta,
            dir: call.dir,
            collections: call.args,
            dryRun: call.flags.has("dry-run"),
            ...withComment(call.flags),
            ...(expectVersion === undefined ? {} : { expectVersion }),
          },
          call.out,
        )
      },
    },
  },
  "policies pull": {
    flags: ["force", "env"],
    args: ANY,
    handler: {
      kind: "meta",
      run: (call, meta) =>
        policiesPull(
          { ...meta, dir: call.dir, collections: call.args, force: call.flags.has("force") },
          call.out,
        ),
    },
  },
  "policies history": {
    flags: ["limit", "env"],
    args: [1, 1],
    needs: "exactly one collection",
    handler: {
      kind: "meta",
      run: (call, meta) => {
        const limit = count(text(call.flags, "limit"), "limit", call.out)
        if (limit === false) return 1
        return policiesHistory(
          { ...meta, collection: call.args[0] ?? "", ...(limit === undefined ? {} : { limit }) },
          call.out,
        )
      },
    },
  },
  "policies rollback": {
    flags: ["expect-version", "comment", "yes", "env"],
    args: [2, 2],
    needs: "a collection and a version",
    handler: {
      kind: "meta",
      run: (call, meta) => {
        const version = count(call.args[1], "version", call.out)
        const expectVersion = count(text(call.flags, "expect-version"), "expect-version", call.out)
        if (version === false || version === undefined || expectVersion === false) return 1
        return policiesRollback(
          {
            ...meta,
            collection: call.args[0] ?? "",
            version,
            yes: call.flags.has("yes"),
            ...withComment(call.flags),
            ...(expectVersion === undefined ? {} : { expectVersion }),
          },
          call.out,
        )
      },
    },
  },
}

function runExplain(call: Configured): number | Promise<number> {
  const bare = EXPLAIN_FLAGS.find((flag) => call.flags.get(flag) === true)
  if (bare !== undefined) {
    call.out.error(`--${bare} needs a value`)
    return 1
  }
  const explainOptions = EXPLAIN_FLAGS.flatMap((flag) => {
    const value = text(call.flags, flag)
    return value === undefined ? [] : [[flag, value] as const]
  })
  const { uriFlag } = call
  return policiesExplain(
    {
      dir: call.dir,
      collection: call.args[0] ?? "",
      ...Object.fromEntries(explainOptions),
      ...(uriFlag === undefined
        ? {}
        : {
            mongodbUri: uriFlag,
            database: text(call.flags, "database") ?? call.env["CANOPY_DB"] ?? databaseOf(uriFlag),
          }),
    },
    call.out,
  )
}
