import { formatConfig } from "@canopy/config"
import { doctor } from "./commands.ts"
import { dev } from "./dev.ts"
import { genTypes, watchTypes } from "./gen-types.ts"
import { indexes } from "./indexes.ts"
import { init } from "./init.ts"
import {
  ANY,
  type AppTarget,
  type CommandSpec,
  type Configured,
  databaseOf,
  type Invocation,
  port,
  text,
} from "./invocation.ts"
import { DEFAULT_MONGO_IMAGE, dockerAvailable, startLocalMongo } from "./local-mongo.ts"
import {
  DEFAULT_MONGO_VERSION,
  mongoCacheDir,
  type RunningMongo,
  startBinaryMongo,
} from "./mongod-binary.ts"
import { messageOf } from "./output.ts"
import { realtimeImages } from "./realtime-images.ts"

/** Commands that set up and inspect a project: init, dev, doctor, types, config, realtime images and indexes. */
export const PROJECT_COMMANDS: Readonly<Record<string, CommandSpec>> = {
  doctor: {
    flags: [],
    handler: {
      kind: "app",
      load: "doctor",
      run: (call, app) => doctor({ ...app, ...(call.dirGiven ? { dir: call.dir } : {}) }, call.out),
    },
  },
  "gen types": {
    flags: ["out", "role", "check", "infer-enums", "sample", "watch"],
    handler: { kind: "app", load: "gen", run: runGenTypes },
  },
  "config print": {
    flags: ["sources"],
    handler: {
      kind: "config",
      load: "print",
      run: (call) => {
        call.out.log(formatConfig(call.loaded, { sources: call.flags.has("sources") }).trimEnd())
        return 0
      },
    },
  },
  init: { flags: [], handler: { kind: "direct", run: runInit } },
  dev: {
    flags: [
      "with-mongo",
      "mongo-binary",
      "mongo-version",
      "port",
      "mongo-port",
      "mongo-image",
      "types",
    ],
    handler: { kind: "direct", run: runDev },
  },
  "realtime enable-images": {
    flags: ["yes"],
    args: ANY,
    handler: { kind: "app", load: "gen", run: (call, app) => runImages(call, app, true) },
  },
  "realtime disable-images": {
    flags: ["yes"],
    args: ANY,
    handler: { kind: "app", load: "gen", run: (call, app) => runImages(call, app, false) },
  },
  "indexes advise": {
    flags: [],
    handler: { kind: "app", load: "gen", run: (call, app) => runIndexes(call, app, false) },
  },
  "indexes create": {
    flags: ["yes"],
    handler: { kind: "app", load: "gen", run: (call, app) => runIndexes(call, app, true) },
  },
}

function runInit(call: Invocation): number | Promise<number> {
  const uriFlag = text(call.flags, "mongodb-uri")
  const database =
    text(call.flags, "database") ?? (uriFlag === undefined ? "" : databaseOf(uriFlag))
  if (uriFlag !== undefined && database === "") {
    call.out.error("init --mongodb-uri needs --database or a database in the URI path")
    return 1
  }
  return init(
    { cwd: call.cwd, ...(uriFlag === undefined ? {} : { mongodbUri: uriFlag, database }) },
    call.out,
  )
}

function runImages(call: Configured, app: AppTarget, enable: boolean): Promise<number> {
  return realtimeImages(
    { ...app, collections: call.args, enable, yes: call.flags.has("yes") },
    call.out,
  )
}

function runIndexes(call: Configured, app: AppTarget, create: boolean): Promise<number> {
  return indexes(
    {
      ...app,
      metaDatabase: call.config.mongodb.metaDatabase,
      create,
      yes: call.flags.has("yes"),
      ...(call.dirGiven ? { dir: call.dir } : {}),
    },
    call.out,
  )
}

function runGenTypes(call: Configured, app: AppTarget): number | Promise<number> {
  const { flags, config } = call
  const sample = text(flags, "sample")
  const role = text(flags, "role") ?? config.types.role
  if (sample !== undefined && !/^[1-9]\d*$/.test(sample)) {
    call.out.error("--sample needs a positive integer")
    return 1
  }
  const options = {
    ...app,
    out: text(flags, "out") ?? config.types.out,
    check: flags.has("check"),
    inferEnums: flags.has("infer-enums"),
    ...(call.dirGiven ? { dir: call.dir } : {}),
    ...(role === undefined ? {} : { role }),
    ...(sample === undefined ? {} : { sampleSize: Number(sample) }),
  }
  if (flags.has("watch")) {
    if (flags.has("check")) {
      call.out.error("--watch and --check do not go together")
      return 1
    }
    return watchTypes(options, call.out, call.signal)
  }
  return genTypes(options, call.out)
}

async function runDev(call: Invocation): Promise<number> {
  const { flags, env, out, cwd, signal } = call
  const serverPort = port(text(flags, "port"), "port", out)
  const mongoPort = port(text(flags, "mongo-port"), "mongo-port", out)
  if (serverPort === false || mongoPort === false) return 1
  let devEnv = env
  let binary: RunningMongo | undefined
  if (flags.has("with-mongo")) {
    const configured = env["MONGODB_URI"]
    const database =
      text(flags, "database") ??
      env["CANOPY_DB"] ??
      (configured === undefined ? "" : databaseOf(configured))
    const app = database === "" ? "app" : database
    try {
      const useDocker = !flags.has("mongo-binary") && (await dockerAvailable())
      let uri: string
      if (useDocker) {
        uri = await startLocalMongo({
          projectDir: cwd,
          port: mongoPort ?? 27017,
          database: app,
          image: text(flags, "mongo-image") ?? env["CANOPY_MONGO_IMAGE"] ?? DEFAULT_MONGO_IMAGE,
          log: (line) => out.log(line),
        })
      } else {
        if (!flags.has("mongo-binary")) out.log("Docker is not running: using the MongoDB binaries")
        binary = await startBinaryMongo({
          projectDir: cwd,
          port: mongoPort ?? 27017,
          database: app,
          version: text(flags, "mongo-version") ?? DEFAULT_MONGO_VERSION,
          cacheDir: mongoCacheDir(env),
          log: (line) => out.log(line),
        })
        uri = binary.uri
      }
      devEnv = { ...env, MONGODB_URI: uri }
      out.log(`MongoDB is ready at ${uri}`)
    } catch (error: unknown) {
      out.error(`--with-mongo: ${messageOf(error)}`)
      return 1
    }
  }
  try {
    return await dev(
      {
        cwd,
        env: devEnv,
        ...(text(flags, "config") === undefined ? {} : { configFile: text(flags, "config") ?? "" }),
        ...(serverPort === undefined ? {} : { port: serverPort }),
        ...(flags.has("types") ? { types: true } : {}),
      },
      out,
      signal,
    )
  } finally {
    await binary?.stop()
  }
}
