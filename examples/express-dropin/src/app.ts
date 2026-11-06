import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import express, { type ErrorRequestHandler, type Express, type Request } from 'express'
import { auth } from 'express-oauth2-jwt-bearer'
import mongoose, { isValidObjectId } from 'mongoose'
import { bundleDashboard } from './bundle.ts'
import type { AppConfig } from './config.ts'
import { createDevIssuer, DEV_USERS } from './dev-issuer.ts'
import { PRIORITIES, STATUSES, ticketModel } from './tickets.ts'

/** A running helpdesk app. */
export interface HelpdeskApp {
  readonly app: Express
  close(): Promise<void>
}

interface Caller {
  readonly id: string
  readonly name: string
  readonly support: boolean
}

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const webDir = fileURLToPath(new URL('../web/', import.meta.url))

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

/**
 * Builds the helpdesk: a plain Express and Mongoose app with its own REST API and Auth0 access tokens. The
 * only addition for realtime is `/config.json`, which tells the dashboard where the canopy-realtime sidecar is.
 */
export async function createApp(config: AppConfig): Promise<HelpdeskApp> {
  const connection = await mongoose
    .createConnection(config.mongodbUri, {
      ...(config.database === undefined ? {} : { dbName: config.database }),
    })
    .asPromise()
  const Tickets = ticketModel(connection)
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '16kb' }))

  const identity = config.identity
  const issuer =
    identity.kind === 'dev'
      ? await createDevIssuer({
          issuer: identity.issuer,
          audience: identity.audience,
          rolesClaim: config.rolesClaim,
        })
      : undefined
  if (issuer !== undefined) {
    app.get('/.well-known/jwks.json', (_req, res) => {
      res.json(issuer.jwks)
    })
    app.post('/dev/token', async (req, res) => {
      const user: unknown = req.body?.user
      const token = typeof user === 'string' ? await issuer.sign(user) : undefined
      if (token === undefined) throw new HttpError(404, 'Unknown demo user')
      res.json({ token })
    })
  }

  const requireAuth =
    identity.kind === 'dev'
      ? auth({
          issuer: identity.issuer,
          jwksUri: `${identity.issuer}.well-known/jwks.json`,
          audience: identity.audience,
          tokenSigningAlg: 'RS256',
        })
      : auth({ issuerBaseURL: `https://${identity.domain}/`, audience: identity.audience })

  const caller = (req: Request): Caller => {
    const payload = req.auth?.payload
    const sub = payload?.sub
    if (payload === undefined || typeof sub !== 'string' || sub === '') {
      throw new HttpError(401, 'The token has no subject')
    }
    const roles = payload[config.rolesClaim]
    const name = payload['name']
    return {
      id: sub,
      name: typeof name === 'string' && name !== '' ? name : sub,
      support: Array.isArray(roles) && roles.includes('support'),
    }
  }

  app.get('/api/tickets', requireAuth, async (req, res) => {
    const me = caller(req)
    const tickets = await Tickets.find(me.support ? {} : { ownerId: me.id })
      .select(me.support ? {} : { internalNotes: 0 })
      .sort({ updatedAt: -1 })
      .limit(100)
    res.json(tickets)
  })

  app.post('/api/tickets', requireAuth, async (req, res) => {
    const me = caller(req)
    const { title, priority } = (req.body ?? {}) as Record<string, unknown>
    if (typeof title !== 'string') throw new HttpError(400, 'title must be a string')
    if (priority !== undefined && !oneOf(PRIORITIES, priority)) {
      throw new HttpError(400, `priority must be one of ${PRIORITIES.join(', ')}`)
    }
    const ticket = await Tickets.create({
      title,
      ownerId: me.id,
      ownerName: me.name,
      ...(priority === undefined ? {} : { priority }),
    })
    const { internalNotes: _hidden, ...visible } = ticket.toJSON()
    res.status(201).json(me.support ? ticket.toJSON() : visible)
  })

  app.patch('/api/tickets/:id', requireAuth, async (req, res) => {
    const me = caller(req)
    const id = req.params['id']
    if (!isValidObjectId(id)) throw new HttpError(404, 'No such ticket')
    const { status, priority, internalNotes } = (req.body ?? {}) as Record<string, unknown>
    const set: Record<string, string> = {}
    if (status !== undefined) {
      if (!oneOf(STATUSES, status))
        throw new HttpError(400, `status must be one of ${STATUSES.join(', ')}`)
      set['status'] = status
    }
    if (priority !== undefined) {
      if (!oneOf(PRIORITIES, priority)) {
        throw new HttpError(400, `priority must be one of ${PRIORITIES.join(', ')}`)
      }
      set['priority'] = priority
    }
    if (internalNotes !== undefined) {
      if (!me.support) throw new HttpError(403, 'Only support can edit internal notes')
      if (typeof internalNotes !== 'string')
        throw new HttpError(400, 'internalNotes must be a string')
      set['internalNotes'] = internalNotes
    }
    if (Object.keys(set).length === 0) throw new HttpError(400, 'Nothing to change')
    const ticket = await Tickets.findOneAndUpdate(
      me.support ? { _id: id } : { _id: id, ownerId: me.id },
      { $set: set },
      {
        returnDocument: 'after',
        runValidators: true,
        projection: me.support ? {} : { internalNotes: 0 },
      },
    )
    if (ticket === null) throw new HttpError(404, 'No such ticket')
    res.json(ticket)
  })

  app.get('/config.json', (_req, res) => {
    res.json({
      canopyUrl: config.canopyUrl,
      publishableKey: config.publishableKey,
      auth:
        identity.kind === 'dev'
          ? { kind: 'dev', users: DEV_USERS.map(({ id, name }) => ({ id, name })) }
          : {
              kind: 'auth0',
              domain: identity.domain,
              clientId: identity.clientId,
              audience: identity.audience,
            },
    })
  })

  let bundle: Promise<string> | undefined
  app.get('/app.js', async (_req, res) => {
    const pending =
      (config.production ? bundle : undefined) ??
      bundleDashboard(`${webDir}main.tsx`, config.production)
    bundle = pending
    res.type('text/javascript').send(await pending)
  })
  for (const [path, file, type] of [
    ['/', 'index.html', 'html'],
    ['/styles.css', 'styles.css', 'css'],
  ] as const) {
    app.get(path, async (_req, res) => {
      res.type(type).send(await readFile(`${webDir}${file}`, 'utf8'))
    })
  }

  const onError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const status =
      error instanceof mongoose.Error.ValidationError
        ? 400
        : typeof (error as { status?: unknown }).status === 'number'
          ? (error as { status: number }).status
          : 500
    if (status >= 500) console.error(error)
    const headers = (error as { headers?: unknown }).headers
    if (typeof headers === 'object' && headers !== null) res.set(headers as Record<string, string>)
    res.status(status).json({
      error:
        status >= 500 ? 'Internal error' : error instanceof Error ? error.message : String(error),
    })
  }
  app.use(onError)

  return {
    app,
    close: () => connection.close(),
  }
}
