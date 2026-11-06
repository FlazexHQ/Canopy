import { type Collection, type Document, MongoClient } from 'mongodb'
import { afterAll, beforeAll, describe } from 'vitest'

/** The replica set used by integration and differential tests, from `CANOPY_TEST_MONGODB_URI`. */
export const MONGODB_URI = process.env['CANOPY_TEST_MONGODB_URI']

/** Number of generated cases per differential property; raised in nightly runs through `CANOPY_DIFF_RUNS`. */
export const DIFF_RUNS = Number(process.env['CANOPY_DIFF_RUNS'] ?? '300')

/**
 * Declares a suite that needs a MongoDB replica set. Without `CANOPY_TEST_MONGODB_URI` the suite is reported as
 * skipped, never as passed; CI always provides the URI.
 */
export function describeWithMongo(name: string, body: (db: () => MongoTestDb) => void): void {
  const suite = MONGODB_URI === undefined ? describe.skip : describe
  suite(name, () => {
    let client: MongoClient | undefined
    let handle: MongoTestDb | undefined
    beforeAll(async () => {
      if (MONGODB_URI === undefined) return
      client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 10_000 })
      await client.connect()
      const dbName = `canopy_test_${process.pid}_${Math.floor(Math.random() * 1e9)}`
      const db = client.db(dbName)
      handle = {
        collection: <T extends Document>(name: string) => db.collection<T>(name),
        client,
      }
    })
    afterAll(async () => {
      if (client === undefined || handle === undefined) return
      await client.db(handle.collection('x').dbName).dropDatabase()
      await client.close()
    })
    body(() => {
      if (handle === undefined) throw new Error('MongoDB is not connected')
      return handle
    })
  })
}

/** Access to a throwaway database. */
export interface MongoTestDb {
  collection<T extends Document>(name: string): Collection<T>
  readonly client: MongoClient
}
