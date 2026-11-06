import { allow, auth, collection, createPolicySet, PolicyEngine } from '@canopy/policy'
import { type ClusterTime, canonicalString, compareCt, toCt } from '@canopy/protocol'
import { MONGODB_URI } from '@canopy/testing'
import { type ChangeStreamDocument, type Db, MongoClient } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Caller, WritePath, type WriteRequest, type WriteResult } from '../src/index.ts'

/**
 * Echo before ack correlates a committed write with its change events by `(ns, _id, ct >= T)`, where `T` is
 * the cluster time the write path reports. This suite fuzzes concurrent writes on both the transactional
 * and the fast path and checks, against the real change stream, that every changed `_id` has an event at
 * exactly `T`, that the stream is ordered by cluster time, and that a waiter following that rule never
 * resolves before the write's own events. `CANOPY_ECHO_MUTATIONS` scales the run.
 */
const MUTATIONS = Number(process.env['CANOPY_ECHO_MUTATIONS'] ?? '400')
const WORKERS = 8
const KEYS = 64

const items = collection('items', {
  exposed: true,
  realtime: true,
  policies: [
    allow.read('authenticated').where({ ownerId: auth('sub') }),
    allow.insert('authenticated').check({ ownerId: auth('sub') }),
    allow.update('authenticated').where({ ownerId: auth('sub') }),
    allow.delete('authenticated').where({ ownerId: auth('sub') }),
    allow.read('editor'),
    allow.insert('editor'),
    allow.update('editor'),
    allow.delete('editor'),
  ],
})

const owner: Caller = {
  context: { roles: new Set(['authenticated']), claims: { sub: 'u' }, now: new Date() },
  subject: 'u',
}
const editor: Caller = {
  context: { roles: new Set(['authenticated', 'editor']), claims: { sub: 'u' }, now: new Date() },
  subject: 'u',
}

function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Recorded {
  readonly request: WriteRequest
  readonly result: WriteResult
  readonly bulk: boolean
}

interface Event {
  readonly ct: ClusterTime
  readonly key: string
}

const suite = MONGODB_URI === undefined ? describe.skip : describe

suite('echo correlation between write results and change events', () => {
  const dbName = `canopy_echo_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let client: MongoClient
  let db: Db
  let writes: WritePath

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI ?? '', { maxPoolSize: WORKERS * 2 })
    await client.connect()
    db = client.db(dbName)
    await db.createCollection('items')
    writes = new WritePath({
      client,
      database: dbName,
      metaDatabase: `${dbName}_meta`,
      policies: new PolicyEngine(createPolicySet([items])),
      limits: { maxBulk: KEYS },
    })
    await writes.ensureIndexes()
  })

  afterAll(async () => {
    await db.dropDatabase()
    await client.db(`${dbName}_meta`).dropDatabase()
    await client.close()
  })

  it(`matches every changed _id to an event at the reported ct (${MUTATIONS} mutations)`, async () => {
    const session = client.startSession()
    await db.command({ ping: 1 }, { session })
    const start = session.operationTime
    await session.endSession()
    if (start === undefined) throw new Error('no cluster time')
    const stream = db.collection('items').watch([], { startAtOperationTime: start })

    const recorded: Recorded[] = []
    const usedIds: string[] = []
    let nextId = 0
    let counter = 0
    const worker = async (seed: number): Promise<void> => {
      const rand = random(seed)
      const pick = <T>(values: readonly T[]): T => values[Math.floor(rand() * values.length)] as T
      while (counter < MUTATIONS) {
        counter += 1
        const caller = rand() < 0.5 ? owner : editor
        const key = Math.floor(rand() * KEYS)
        const roll = rand()
        let request: WriteRequest
        let bulk = false
        if (roll < 0.2) {
          nextId += 1
          request = {
            op: 'insert',
            collection: 'items',
            doc: { _id: `i${nextId}`, ownerId: 'u', k: key },
          }
        } else if (roll < 0.25) {
          const docs = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => {
            nextId += 1
            return { _id: `i${nextId}`, ownerId: 'u', k: key }
          })
          request = { op: 'insertMany', collection: 'items', docs }
          bulk = true
        } else if (roll < 0.6) {
          request = {
            op: 'update',
            collection: 'items',
            id: `i${1 + Math.floor(rand() * Math.max(1, nextId))}`,
            update: pick([{ $inc: { n: 1 } }, { $set: { k: key } }, { $push: { log: key } }]),
          }
        } else if (roll < 0.7) {
          request = {
            op: 'replace',
            collection: 'items',
            id: `i${1 + Math.floor(rand() * Math.max(1, nextId))}`,
            doc: { ownerId: 'u', k: key, replaced: true },
            upsert: rand() < 0.5,
          }
        } else if (roll < 0.8) {
          request = {
            op: 'delete',
            collection: 'items',
            id: `i${1 + Math.floor(rand() * Math.max(1, nextId))}`,
          }
        } else if (roll < 0.92) {
          request = {
            op: 'updateMany',
            collection: 'items',
            filter: { k: key },
            update: { $inc: { m: 1 } },
            bulk: true,
          }
          bulk = true
        } else {
          request = { op: 'deleteMany', collection: 'items', filter: { k: key }, bulk: true }
          bulk = true
        }
        let mutationId: string | undefined
        if (rand() < 0.3) {
          if (usedIds.length > 0 && rand() < 0.2) mutationId = pick(usedIds)
          else {
            mutationId = `echo-${seed}-${counter}`
            usedIds.push(mutationId)
          }
        }
        try {
          const result = await writes.execute(
            caller,
            request,
            mutationId === undefined ? {} : { mutationId },
          )
          recorded.push({ request, result, bulk })
        } catch (error: unknown) {
          const code = (error as { code?: unknown }).code
          if (
            code !== 'CANOPY_CONFLICT' &&
            code !== 'CANOPY_DUPLICATE_KEY' &&
            code !== 'CANOPY_BULK_LIMIT'
          )
            throw error
        }
      }
    }
    await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(1000 + i)))

    await db.collection('items').insertOne({ _id: 'sentinel' as never, ownerId: 'x' })
    const events: Event[] = []
    for await (const change of stream as AsyncIterable<ChangeStreamDocument>) {
      if (!('documentKey' in change)) continue
      const id: unknown = change.documentKey['_id']
      if (id === 'sentinel') break
      const ct = toCt(change.clusterTime)
      if (ct === undefined) throw new Error('event without clusterTime')
      events.push({ ct, key: canonicalString(id) })
    }
    await stream.close()

    const unordered = events.filter(
      (event, i) => i > 0 && compareCt(event.ct, events[i - 1]?.ct ?? '0') < 0,
    )
    expect(unordered).toEqual([])

    const byKeyAndCt = new Map<string, number[]>()
    events.forEach((event, index) => {
      const slot = `${event.key}@${event.ct}`
      const list = byKeyAndCt.get(slot) ?? []
      list.push(index)
      byKeyAndCt.set(slot, list)
    })

    const missing: string[] = []
    const early: string[] = []
    let applied = 0
    for (const { request, result, bulk } of recorded) {
      if (result.replayed) continue
      applied += 1
      const changed = result.changedIds.map((id) => canonicalString(id))
      const exact = changed.filter((key) => byKeyAndCt.has(`${key}@${result.ct}`))
      const expected = bulk
        ? request.op === 'updateMany'
          ? result.modified
          : request.op === 'deleteMany'
            ? result.deleted
            : result.insertedIds.length
        : changed.length
      if (exact.length !== expected)
        missing.push(`${request.op} ct=${result.ct} expected=${expected} exact=${exact.length}`)
      const own = exact.flatMap((key) => byKeyAndCt.get(`${key}@${result.ct}`) ?? [])
      if (own.length === 0) continue
      const lastOwn = Math.max(...own)
      const pending = new Set(changed)
      for (let i = firstAtOrAfter(events, result.ct); i < events.length; i += 1) {
        const event = events[i] as Event
        if (compareCt(event.ct, result.ct) >= 0) pending.delete(event.key)
        const resolved = pending.size === 0 || compareCt(event.ct, result.ct) > 0
        if (resolved) {
          if (i < lastOwn)
            early.push(`${request.op} ct=${result.ct} resolved at ${i} before ${lastOwn}`)
          break
        }
      }
    }
    expect(events.length).toBeGreaterThanOrEqual(applied / 2)
    expect(missing).toEqual([])
    expect(early).toEqual([])
    expect(applied).toBeGreaterThan(MUTATIONS / 2)
    const appliedKeys = new Set(
      recorded
        .filter((entry) => !entry.result.replayed)
        .flatMap((entry) => entry.result.changedIds.map((id) => canonicalString(id))),
    )
    const orphans = recorded
      .filter((entry) => entry.result.replayed)
      .flatMap((entry) => entry.result.changedIds.map((id) => canonicalString(id)))
      .filter((key) => !appliedKeys.has(key))
    expect(orphans).toEqual([])
  }, 3_600_000)
})

/** The index of the first event whose cluster time is at or after `ct`; events are ordered by cluster time. */
function firstAtOrAfter(events: readonly Event[], ct: ClusterTime): number {
  let low = 0
  let high = events.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (compareCt((events[mid] as Event).ct, ct) < 0) low = mid + 1
    else high = mid
  }
  return low
}
