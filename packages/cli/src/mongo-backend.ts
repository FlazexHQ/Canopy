import {
  canAccess,
  documentPaths,
  type PolicyEngine,
  projectReadable,
  Role,
  toFilter,
} from '@canopy/policy'
import {
  contextOf,
  type PolicyBackend,
  type PolicyOutcome,
  type PolicyTestCase,
} from '@canopy/policy/testing'
import { parseUpdate, pathsOverlap } from '@canopy/query'
import type { Db, Document } from 'mongodb'

/**
 * Evaluates policy test cases against a real MongoDB: every case stores its document in a throwaway
 * collection and lets MongoDB decide `USING` and `CHECK`, and update cases run the real update. Disagreement
 * with the in-memory backend is the bug class that makes realtime and REST differ.
 */
export function mongoBackend(engine: PolicyEngine, db: Db, now: Date = new Date()): PolicyBackend {
  let counter = 0
  return {
    name: 'mongodb',
    async evaluate(testCase: PolicyTestCase): Promise<PolicyOutcome> {
      counter += 1
      const coll = db.collection<Document>(`case_${counter}`)
      const ctx = contextOf(testCase.actor, now)
      const { collection, doc } = testCase
      const service = ctx.roles.has(Role.Service)
      const id = doc['_id'] ?? counter
      const stored = { ...doc, _id: id } as Document
      try {
        if (!service && !engine.isExposed(collection))
          return { allowed: false, reason: 'the collection is not exposed' }
        const visible = async (filter: Record<string, unknown>): Promise<boolean> =>
          (await coll.countDocuments({ $and: [{ _id: id }, filter] } as Document)) === 1
        switch (testCase.action) {
          case 'read': {
            await coll.insertOne(stored)
            if (!(await visible(toFilter(engine.using(collection, 'read', ctx))))) {
              return { allowed: false, reason: 'not returned by find()' }
            }
            const found = (await coll.findOne({ _id: id } as Document)) as Record<string, unknown>
            return {
              allowed: true,
              reason: 'returned by find()',
              document: projectReadable(engine.readable(collection, ctx), found),
            }
          }
          case 'insert': {
            if (!engine.hasGrant(collection, 'insert', ctx))
              return { allowed: false, reason: 'no policy grants insert' }
            const writable = engine.writable(collection, 'insert', ctx)
            const denied = documentPaths(doc).filter((path) => !canAccess(writable, path))
            if (denied.length > 0)
              return { allowed: false, reason: `fields not writable: ${denied.join(', ')}` }
            await coll.insertOne(stored)
            if (!(await visible(toFilter(engine.check(collection, 'insert', ctx))))) {
              return { allowed: false, reason: 'MongoDB rejected CHECK(insert)' }
            }
            return { allowed: true, reason: 'inserted' }
          }
          case 'update': {
            if (!engine.hasGrant(collection, 'update', ctx))
              return { allowed: false, reason: 'no policy grants update' }
            await coll.insertOne(stored)
            if (!(await visible(toFilter(engine.target(collection, 'update', ctx))))) {
              return { allowed: false, reason: 'not a target (matched 0)' }
            }
            const update = testCase.update ?? {}
            let written: readonly string[]
            try {
              written = parseUpdate(update, { allowPipeline: service }).writtenPaths
            } catch (error: unknown) {
              return {
                allowed: false,
                reason: error instanceof Error ? error.message : String(error),
              }
            }
            if (!service) {
              const writable = engine.writable(collection, 'update', ctx)
              const denied = written.filter((path) => !canAccess(writable, path))
              if (denied.length > 0)
                return { allowed: false, reason: `fields not writable: ${denied.join(', ')}` }
              const immutable = written.filter((path) =>
                engine.immutable(collection).some((field) => pathsOverlap(path, field)),
              )
              if (immutable.length > 0)
                return { allowed: false, reason: `immutable fields: ${immutable.join(', ')}` }
            }
            try {
              await coll.updateOne({ _id: id } as Document, update as Document)
            } catch (error: unknown) {
              return {
                allowed: false,
                reason: `MongoDB rejected the update: ${error instanceof Error ? error.message : String(error)}`,
              }
            }
            if (!(await visible(toFilter(engine.check(collection, 'update', ctx))))) {
              return { allowed: false, reason: 'MongoDB rejected CHECK(update)' }
            }
            return { allowed: true, reason: 'updated' }
          }
          case 'delete': {
            if (!engine.hasGrant(collection, 'delete', ctx))
              return { allowed: false, reason: 'no policy grants delete' }
            await coll.insertOne(stored)
            if (!(await visible(toFilter(engine.target(collection, 'delete', ctx))))) {
              return { allowed: false, reason: 'not a target (matched 0)' }
            }
            return { allowed: true, reason: 'deleted' }
          }
        }
      } finally {
        await coll.drop().catch(() => {})
      }
    },
  }
}
