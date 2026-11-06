import { compileFilter } from '@canopy/matcher'
import { stringify } from '@canopy/protocol'
import { DIFF_RUNS, describeWithMongo } from '@canopy/testing'
import fc from 'fast-check'
import type { Document } from 'mongodb'
import { beforeAll, expect, it } from 'vitest'
import { createPolicySet, PolicyEngine, type RequestContext, toFilter } from '../src/index.ts'
import { invoices, posts, todos } from './fixtures.ts'

const SEED = Number(process.env['CANOPY_DIFF_SEED'] ?? '20261106')

describeWithMongo('differential: compiled policies against MongoDB', (db) => {
  const engine = new PolicyEngine(createPolicySet([todos, invoices, posts]))
  const ids = fc.constantFrom('u1', 'u2', 'o1', 'o2', 't1', 't2')
  const doc = fc.record(
    {
      ownerId: fc.oneof(ids, fc.constant(null)),
      authorId: ids,
      orgId: ids,
      tenantId: ids,
      shared: fc.boolean(),
      published: fc.boolean(),
      archived: fc.oneof(fc.boolean(), fc.constant(null)),
      status: fc.constantFrom('draft', 'sent', 'paid'),
    },
    { requiredKeys: [] },
  )
  const claim = fc.oneof(
    ids,
    fc.constant(null),
    fc.constant(undefined),
    fc.array(ids, { maxLength: 2 }),
  )
  const context = fc
    .record({
      sub: claim,
      org_ids: fc.oneof(fc.array(ids, { maxLength: 3 }), claim),
      tenant_id: claim,
      anon: fc.boolean(),
      admin: fc.boolean(),
    })
    .map(
      ({ anon, admin, ...claims }): RequestContext =>
        anon
          ? { roles: new Set(['anon']), claims: null, now: new Date() }
          : {
              roles: new Set(['authenticated', ...(admin ? ['tenant_admin'] : [])]),
              claims,
              now: new Date(),
            },
    )
  let docs: Document[] = []

  beforeAll(async () => {
    const coll = db().collection('policy_docs')
    await coll.insertMany(
      fc
        .sample(doc, { numRuns: 200, seed: SEED })
        .map((d, index) => ({ _id: index, ...d }) as Document),
    )
    docs = await coll.find({}, { promoteValues: false }).toArray()
  })

  it('USING and CHECK filters select the same documents in MongoDB and in process', async () => {
    const coll = db().collection('policy_docs')
    const contexts = fc.sample(context, {
      numRuns: Math.max(50, Math.floor(DIFF_RUNS / 3)),
      seed: SEED,
    })
    const mismatches: string[] = []
    for (const ctx of contexts) {
      for (const [collection, op, clause] of [
        ['todos', 'read', 'using'],
        ['todos', 'delete', 'using'],
        ['todos', 'insert', 'check'],
        ['invoices', 'update', 'target'],
        ['invoices', 'insert', 'check'],
        ['posts', 'read', 'using'],
      ] as const) {
        const compiled =
          clause === 'using'
            ? engine.using(collection, op, ctx)
            : clause === 'check'
              ? engine.check(collection, op as 'insert', ctx)
              : engine.target(collection, op as 'update', ctx)
        const filter = toFilter(compiled)
        const expected = new Set(
          (await coll.find(filter, { projection: { _id: 1 } }).toArray()).map((d) =>
            Number(d['_id']),
          ),
        )
        const matcher = compileFilter(filter)
        for (const d of docs) {
          if (matcher.matches(d) !== expected.has(Number(d['_id']))) {
            mismatches.push(`${collection} ${op} ${clause} ${stringify(filter)} on ${stringify(d)}`)
          }
        }
      }
    }
    expect(mismatches.slice(0, 10)).toEqual([])
  }, 300_000)
})
