import * as bson from 'bson'
import { describe, expect, it } from 'vitest'
import {
  Binary,
  BSONRegExp,
  Decimal128,
  decode,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  toBsonLibrary,
} from '../src/index.ts'

const library = bson.BSON

function roundTrip(value: Record<string, unknown>): bson.Document {
  const converted = toBsonLibrary(value, library) as bson.Document
  return bson.BSON.deserialize(bson.BSON.serialize(converted), {
    promoteValues: false,
    bsonRegExp: true,
  })
}

describe('toBsonLibrary', () => {
  it('lets the bson library serialize every protocol value class', () => {
    const hex = '6728f0c2a1b2c3d4e5f60718'
    const out = roundTrip({
      oid: new ObjectId(hex),
      long: new Long(-(2n ** 63n)),
      dec: new Decimal128('1234.5600'),
      bin: new Binary(new Uint8Array([1, 2, 255]), 4),
      ts: new Timestamp(1_700_000_000, 7),
      re: new BSONRegExp('^a.b$', 'im'),
      min: new MinKey(),
      max: new MaxKey(),
    })
    expect((out['oid'] as bson.ObjectId).toHexString()).toBe(hex)
    expect((out['long'] as bson.Long).toBigInt()).toBe(-(2n ** 63n))
    expect((out['dec'] as bson.Decimal128).toString()).toBe('1234.5600')
    const bin = out['bin'] as bson.Binary
    expect(bin.sub_type).toBe(4)
    expect([...bin.buffer]).toEqual([1, 2, 255])
    const ts = out['ts'] as bson.Timestamp
    expect([ts.t, ts.i]).toEqual([1_700_000_000, 7])
    const re = out['re'] as bson.BSONRegExp
    expect([re.pattern, re.options]).toEqual(['^a.b$', 'im'])
    expect((out['min'] as bson.MinKey)._bsontype).toBe('MinKey')
    expect((out['max'] as bson.MaxKey)._bsontype).toBe('MaxKey')
  })

  it('refuses to serialize protocol values without conversion', () => {
    expect(() => bson.BSON.serialize({ a: new ObjectId() })).toThrow()
  })

  it('converts nested documents and arrays decoded from EJSON', () => {
    const decoded = decode({
      $and: [
        { owner: { $in: [{ $oid: '6728f0c2a1b2c3d4e5f60718' }] } },
        { n: { $numberLong: '5' } },
      ],
      when: { $date: '2026-11-06T00:00:00Z' },
    }) as Record<string, unknown>
    const out = roundTrip(decoded)
    const [first, second] = out['$and'] as [bson.Document, bson.Document]
    const owner = (first['owner'] as bson.Document)['$in'] as bson.ObjectId[]
    expect(owner[0]?.toHexString()).toBe('6728f0c2a1b2c3d4e5f60718')
    expect((second['n'] as bson.Long).toBigInt()).toBe(5n)
    expect((out['when'] as Date).toISOString()).toBe('2026-11-06T00:00:00.000Z')
  })

  it('keeps library instances, dates and primitives as they are', () => {
    const oid = new bson.ObjectId()
    const date = new Date(0)
    const input = { oid, date, s: 'x', n: 1.5, b: true, z: null }
    const out = toBsonLibrary(input, library) as Record<string, unknown>
    expect(out['oid']).toBe(oid)
    expect(out['date']).toBe(date)
    expect(out).toMatchObject({ s: 'x', n: 1.5, b: true, z: null })
    expect(out).not.toBe(input)
  })
})
