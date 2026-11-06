#!/usr/bin/env node
import { createServer } from 'node:http'
import { MongoClient } from 'mongodb'
import type { FullDocumentMode } from '../ingestor.ts'
import type { Logger } from '../logger.ts'
import { createRealtime, type RealtimeOptions } from '../realtime.ts'
import { attach, type BunServerLike, bunHandlers } from '../transports.ts'

/**
 * The `canopy-realtime` sidecar, which runs next to an existing app. Configured through environment
 * variables: `MONGODB_URI`, `CANOPY_DB`, `CANOPY_POLICIES`, `CANOPY_JWT_*`, `CANOPY_PUBLISHABLE_KEYS`, `PORT`
 * and `METRICS_PORT`.
 */

const LEVELS = ['debug', 'info', 'warn', 'error'] as const

function jsonLogger(level: string): Logger {
  const threshold = Math.max(0, LEVELS.indexOf(level as (typeof LEVELS)[number]))
  const write =
    (name: (typeof LEVELS)[number]) => (object: Record<string, unknown>, message?: string) => {
      if (LEVELS.indexOf(name) < threshold) return
      const err = object['err']
      const record = {
        level: name,
        time: new Date().toISOString(),
        msg: message,
        ...object,
        ...(err instanceof Error ? { err: { message: err.message, name: err.name } } : {}),
      }
      process.stderr.write(`${JSON.stringify(record)}\n`)
    }
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') }
}

function list(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === '') return undefined
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

function duration(value: string | undefined, fallbackMs: number): number {
  if (value === undefined) return fallbackMs
  const match = /^(\d+)(ms|s|m|h)?$/.exec(value.trim())
  if (match === null) throw new TypeError(`Invalid duration: ${value}`)
  const unit = match[2] ?? 's'
  const factor = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000
  return Number(match[1]) * factor
}

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new TypeError(`${name} is required`)
  return value
}

async function main(): Promise<void> {
  const env = process.env
  const logger = jsonLogger(env['CANOPY_LOG_LEVEL'] ?? 'info')
  const uri = required('MONGODB_URI')
  const database =
    env['CANOPY_DB'] ??
    new URL(uri.replace(/^mongodb(\+srv)?:/, 'http:')).pathname.replace(/^\//, '')
  if (database === '')
    throw new TypeError('Set CANOPY_DB or put the app database in the MONGODB_URI path')
  const policiesDir = env['CANOPY_POLICIES']
  const jwks = env['CANOPY_JWT_JWKS_URL']
  const mode = (env['CANOPY_REALTIME_FULL_DOCUMENT'] ?? 'auto') as FullDocumentMode
  if (!['auto', 'updateLookup', 'images'].includes(mode))
    throw new TypeError('Invalid CANOPY_REALTIME_FULL_DOCUMENT')
  const algorithms = list(env['CANOPY_JWT_ALGORITHMS'])
  const publishable = list(env['CANOPY_PUBLISHABLE_KEYS'])
  const secret = list(env['CANOPY_SECRET_KEYS'])
  const options: RealtimeOptions = {
    mongo: new MongoClient(uri, { appName: 'canopy-realtime' }),
    database,
    metaDatabase: env['CANOPY_META_DB'] ?? 'canopy',
    ...(jwks === undefined
      ? {}
      : {
          auth: {
            jwksUrl: jwks,
            issuer: required('CANOPY_JWT_ISSUER'),
            audience: required('CANOPY_JWT_AUDIENCE'),
            ...(algorithms === undefined ? {} : { algorithms }),
            ...(env['CANOPY_JWT_ROLES_CLAIM'] === undefined
              ? {}
              : { rolesClaim: env['CANOPY_JWT_ROLES_CLAIM'] }),
          },
        }),
    keys: {
      ...(publishable === undefined ? {} : { publishable }),
      ...(secret === undefined ? {} : { secret }),
    },
    policies: policiesDir === undefined ? { source: 'database' } : { dir: policiesDir },
    fullDocument: mode,
    checkpoints: env['CANOPY_CHECKPOINTS'] === 'off' ? 'off' : 'meta',
    resumeWindowMs: duration(env['CANOPY_RESUME_WINDOW'], 120_000),
    nodeId: env['CANOPY_NODE_ID'] ?? 'n1',
    logger,
  }
  const realtime = await createRealtime(options)
  const port = Number(env['PORT'] ?? '8080')
  const metricsPort = Number(env['METRICS_PORT'] ?? '9464')
  const health = (path: string): { status: number; body: string } | undefined =>
    path === '/healthz' || path === '/readyz' ? { status: 200, body: 'ok' } : undefined

  const metrics = createServer((request, response) => {
    if (new URL(request.url ?? '/', 'http://localhost').pathname !== '/metrics') {
      response.statusCode = 404
      response.end()
      return
    }
    response.setHeader('content-type', 'text/plain; version=0.0.4')
    response.end(realtime.renderMetrics())
  })
  metrics.listen(metricsPort)

  const bun = (
    globalThis as { Bun?: { serve(options: Record<string, unknown>): { stop(): void } } }
  ).Bun
  let stopServer: () => Promise<void>
  if (bun !== undefined) {
    const handlers = bunHandlers(realtime, {
      fallback: (request) => {
        const result = health(new URL(request.url).pathname)
        return new Response(result?.body ?? 'Not found', { status: result?.status ?? 404 })
      },
    })
    const server = bun.serve({
      port,
      fetch: (request: Request, srv: BunServerLike<{ connection: undefined }>) =>
        handlers.fetch(request, srv as never),
      websocket: handlers.websocket,
    })
    stopServer = async () => server.stop()
  } else {
    const server = createServer((request, response) => {
      const result = health(new URL(request.url ?? '/', 'http://localhost').pathname)
      response.statusCode = result?.status ?? 404
      response.end(result?.body ?? 'Not found')
    })
    const attachment = await attach(realtime, server)
    await new Promise<void>((resolve) => server.listen(port, resolve))
    stopServer = async () => {
      await attachment.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
  logger.info(
    { port, metricsPort, database, runtime: bun === undefined ? 'node' : 'bun' },
    'canopy-realtime listening',
  )

  let stopping = false
  const shutdown = (): void => {
    if (stopping) return
    stopping = true
    logger.info({}, 'draining')
    realtime
      .close({ drainMs: duration(env['CANOPY_DRAIN_WINDOW'], 30_000) })
      .then(stopServer)
      .then(() => {
        metrics.close()
        return options.mongo.close()
      })
      .then(
        () => process.exit(0),
        (error: unknown) => {
          logger.error({ err: error }, 'shutdown failed')
          process.exit(1)
        },
      )
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ level: 'error', msg: 'canopy-realtime failed to start', err: error instanceof Error ? error.message : String(error) })}\n`,
  )
  process.exit(1)
})
