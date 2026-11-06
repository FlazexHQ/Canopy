import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  type ClientMessage,
  decodeClientMessage,
  decodeServerMessage,
  ErrorCode,
  encodeMessage,
  ObjectId,
  ProtocolError,
  type ServerMessage,
  unbatch,
} from '../src/index.ts'

function protocolError(run: () => unknown): void {
  expect(run).toThrow(ProtocolError)
}

describe('client messages', () => {
  it('decodes the documented client examples', () => {
    const hello = decodeClientMessage(
      '{"t":"hello","v":1,"key":"canopy_pk_8f","token":"eyJ","caps":["batch","diff"],"sdk":"canopy-js/0.1.0"}',
    )
    expect(hello).toEqual({
      t: 'hello',
      v: 1,
      key: 'canopy_pk_8f',
      token: 'eyJ',
      caps: ['batch', 'diff'],
      sdk: 'canopy-js/0.1.0',
    })

    const sub = decodeClientMessage(
      '{"t":"sub","id":"s1","c":"todos","q":{"filter":{"status":"active"},"sort":{"createdAt":-1},"limit":50}}',
    )
    expect(sub).toMatchObject({ t: 'sub', id: 's1', c: 'todos', q: { limit: 50 } })

    const mut = decodeClientMessage(
      '{"t":"mut","id":"0192f6a1-7c2e-7b1a-9d3e-5f0a1b2c3d4e","c":"todos","op":"update","args":{"id":{"$oid":"6728f0c2a1b2c3d4e5f60718"},"update":{"$set":{"done":true}},"where":{"done":false}}}',
    )
    expect(mut?.t).toBe('mut')
    if (mut?.t !== 'mut') throw new Error('unreachable')
    expect(mut.args['id']).toBeInstanceOf(ObjectId)
  })

  it('decodes EJSON values inside filters', () => {
    const sub = decodeClientMessage(
      '{"t":"sub","id":"s2","c":"todos","q":{"filter":{"createdAt":{"$gte":{"$date":"2026-01-01T00:00:00Z"}}}}}',
    )
    if (sub?.t !== 'sub') throw new Error('expected sub')
    const createdAt = sub.q.filter?.['createdAt'] as Record<string, unknown> | undefined
    const gte = createdAt?.['$gte']
    expect(gte).toBeInstanceOf(Date)
  })

  it('accepts a sub without a query', () => {
    expect(decodeClientMessage('{"t":"sub","id":"a","c":"x"}')).toEqual({
      t: 'sub',
      id: 'a',
      c: 'x',
      q: {},
    })
  })

  it('returns undefined for unknown but well formed types', () => {
    expect(decodeClientMessage('{"t":"future","x":1}')).toBeUndefined()
  })

  it.each([
    ['a non object frame', '[1,2]'],
    ['a missing type', '{"v":1}'],
    ['a hello without a key', '{"t":"hello","v":1}'],
    ['a negative version', '{"t":"hello","v":-1,"key":"k"}'],
    ['a resume without seq', '{"t":"hello","v":1,"key":"k","resume":{"sid":"a"}}'],
    ['a sub id with spaces', '{"t":"sub","id":"a b","c":"x"}'],
    ['a sub id longer than 64', `{"t":"sub","id":"${'a'.repeat(65)}","c":"x"}`],
    ['a collection starting with $', '{"t":"sub","id":"a","c":"$cmd"}'],
    ['a non integer limit', '{"t":"sub","id":"a","c":"x","q":{"limit":1.5}}'],
    ['a filter that is an array', '{"t":"sub","id":"a","c":"x","q":{"filter":[]}}'],
    ['an unknown mutation op', '{"t":"mut","id":"m","c":"x","op":"drop","args":{}}'],
    ['a polluting key', '{"t":"sub","id":"a","c":"x","q":{"filter":{"__proto__":{"x":1}}}}'],
    ['broken JSON', '{"t":'],
  ])('rejects %s', (_name, text) => {
    protocolError(() => decodeClientMessage(text))
  })

  it('round trips through encodeMessage', () => {
    const messages: ClientMessage[] = [
      { t: 'hello', v: 1, key: 'k', resume: { sid: 'n1.abc', seq: 41 } },
      { t: 'auth', token: '' },
      { t: 'sub', id: 's9', c: 'todos', q: { filter: { a: 1 } }, o: { buffer: 10 } },
      { t: 'unsub', id: 's9' },
      { t: 'ping', ts: 12.5 },
      { t: 'bye' },
    ]
    for (const message of messages) {
      expect(JSON.stringify(decodeClientMessage(encodeMessage(message)))).toBe(
        JSON.stringify(message),
      )
    }
  })
})

describe('server messages', () => {
  const examples = [
    '{"t":"welcome","seq":0,"sid":"n3.Zq8c","v":1,"resumed":false,"hb":25000,"pv":"sha256:9f2c","ct":"7704617278242816001","caps":["batch","diff"],"limits":{"subs":100}}',
    '{"t":"added","seq":1,"c":"todos","id":{"$oid":"6728f0c2a1b2c3d4e5f60718"},"d":{"_id":{"$oid":"6728f0c2a1b2c3d4e5f60718"},"title":"Ship v0.1","done":false,"createdAt":{"$date":"2026-11-05T09:30:00Z"}},"ct":"7704617278242816001","s":["s1"]}',
    '{"t":"ready","seq":2,"s":"s1","ct":"7704617278242816001"}',
    '{"t":"changed","seq":3,"c":"todos","id":{"$oid":"6728f0c2a1b2c3d4e5f60718"},"ct":"7704617295422685185","set":{"done":true}}',
    '{"t":"ack","seq":4,"m":"0192f6a1-7c2e-7b1a-9d3e-5f0a1b2c3d4e","ok":true,"ct":"7704617295422685185","echo":true,"res":{"matched":1,"modified":1}}',
  ]

  it('decodes the documented server examples', () => {
    const decoded = examples.map((text) => decodeServerMessage(text))
    expect(decoded.map((message) => message?.t)).toEqual([
      'welcome',
      'added',
      'ready',
      'changed',
      'ack',
    ])
    const added = decoded[1]
    if (added?.t !== 'added') throw new Error('expected added')
    expect(added.id).toBeInstanceOf(ObjectId)
    expect(added.d?.['createdAt']).toBeInstanceOf(Date)
  })

  it('unwraps batches and drops unknown inner types', () => {
    const batch = decodeServerMessage(
      `{"t":"batch","m":[${examples[2]},{"t":"later","seq":9},${examples[3]}]}`,
    )
    if (batch === undefined) throw new Error('expected a batch')
    expect(unbatch(batch).map((message) => message.t)).toEqual(['ready', 'changed'])
  })

  it.each([
    ['a message without seq', '{"t":"ready","s":"s1","ct":"1"}'],
    ['a cluster time that is a number', '{"t":"ready","seq":1,"s":"s1","ct":1}'],
    ['an unknown error code', '{"t":"err","seq":1,"code":"NOPE","msg":"x"}'],
    [
      'a replace without a document',
      '{"t":"changed","seq":1,"c":"x","id":1,"ct":"1","replace":true}',
    ],
    ['an added without id', '{"t":"added","seq":1,"c":"x","ct":"1","s":[]}'],
    [
      'docs that are not documents',
      '{"t":"ack","seq":1,"m":"m","ok":true,"res":{"matched":1,"modified":1,"docs":[1]}}',
    ],
  ])('rejects %s', (_name, text) => {
    protocolError(() => decodeServerMessage(text))
  })

  it('round trips arbitrary sequenced messages', () => {
    fc.assert(
      fc.property(
        fc.nat(),
        fc.string(),
        fc.dictionary(
          fc
            .string({ minLength: 1 })
            .filter(
              (key) =>
                !key.startsWith('$') && !['__proto__', 'constructor', 'prototype'].includes(key),
            ),
          fc.oneof(fc.integer(), fc.string(), fc.boolean(), fc.constant(null)),
        ),
        (seq, title, set) => {
          const message: ServerMessage = {
            t: 'changed',
            seq,
            c: 'todos',
            id: title,
            ct: '42',
            set: { ...set },
            unset: ['a.b'],
          }
          expect(JSON.stringify(decodeServerMessage(encodeMessage(message)))).toBe(
            JSON.stringify(message),
          )
        },
      ),
    )
  })

  it('carries wire errors on nosub', () => {
    const nosub = decodeServerMessage(
      '{"t":"nosub","seq":5,"s":"s1","err":{"code":"CANOPY_COLLECTION_DROPPED","msg":"gone"}}',
    )
    expect(nosub).toEqual({
      t: 'nosub',
      seq: 5,
      s: 's1',
      err: { code: ErrorCode.CollectionDropped, msg: 'gone' },
    })
  })
})
