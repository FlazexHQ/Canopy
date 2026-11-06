import { CanopyClient, type WebSocketLike } from '@canopy/client'
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { CanopyProvider, createReactDb, type ReactDb, useCanopyStatus } from '../src/index.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class FakeSocket implements WebSocketLike {
  static all: FakeSocket[] = []
  readyState = 0
  protocol = 'canopy.v1+json'
  readonly sent: { t: string; id?: string }[] = []
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { readonly data: unknown }) => void) | null = null
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  constructor() {
    FakeSocket.all.push(this)
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.({})
    })
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as { t: string })
  }
  close(): void {
    this.readyState = 3
  }
  push(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

interface Todo extends Record<string, unknown> {
  _id: number
  title: string
}

const counter = { renders: 0 }

function List({ db }: { readonly db: ReactDb<{ todos: Todo }> }): ReactNode {
  counter.renders += 1
  const { data, status } = db.todos.useQuery({ done: false }, { sort: { title: 1 } })
  const connection = useCanopyStatus()
  return (
    <ul data-status={status} data-connection={connection}>
      {data.map((todo) => (
        <li key={todo._id}>{todo.title}</li>
      ))}
    </ul>
  )
}

function Status(): ReactNode {
  return <span>{useCanopyStatus()}</span>
}

const tick = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
  })
}

describe('@canopy/react', () => {
  const containers: HTMLElement[] = []
  afterEach(() => {
    for (const element of containers.splice(0)) element.remove()
  })

  it('renders live results and the connection status, sharing one subscription between components', async () => {
    const client = new CanopyClient({
      url: 'http://canopy.test',
      publishableKey: 'pk',
      WebSocket: FakeSocket,
    })
    const db = createReactDb<{ todos: Todo }>(client)
    const container = document.createElement('div')
    document.body.append(container)
    containers.push(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <CanopyProvider client={client}>
          <List db={db} />
          <List db={db} />
        </CanopyProvider>,
      )
    })
    await tick()
    const socket = FakeSocket.all.at(-1) as FakeSocket
    expect(container.querySelector('ul')?.dataset['status']).toBe('loading')
    await act(async () => {
      socket.push({
        t: 'welcome',
        seq: 0,
        sid: 'n1.x',
        v: 1,
        resumed: false,
        hb: 25000,
        pv: '',
        ct: '1',
        caps: [],
        limits: { subs: 100 },
      })
    })
    await tick()
    expect(socket.sent.filter((message) => message.t === 'sub')).toHaveLength(1)
    await act(async () => {
      socket.push({
        t: 'added',
        seq: 1,
        c: 'todos',
        id: 2,
        d: { _id: 2, title: 'b' },
        ct: '1',
        s: ['s1'],
      })
      socket.push({
        t: 'added',
        seq: 2,
        c: 'todos',
        id: 1,
        d: { _id: 1, title: 'a' },
        ct: '1',
        s: ['s1'],
      })
      socket.push({ t: 'ready', seq: 3, s: 's1', ct: '1' })
    })
    await tick()
    const lists = [...container.querySelectorAll('ul')]
    expect(lists.map((list) => list.textContent)).toEqual(['ab', 'ab'])
    expect(lists[0]?.dataset['status']).toBe('ready')
    expect(lists[0]?.dataset['connection']).toBe('live')

    const before = counter.renders
    await act(async () => {
      socket.push({ t: 'changed', seq: 4, c: 'todos', id: 1, ct: '2', set: { title: 'c' } })
    })
    await tick()
    expect([...container.querySelectorAll('ul')].map((list) => list.textContent)).toEqual([
      'bc',
      'bc',
    ])
    expect(counter.renders - before).toBeLessThanOrEqual(4)

    await act(async () => root.unmount())
    await tick()
    expect(socket.sent.filter((message) => message.t === 'unsub')).toEqual([
      { t: 'unsub', id: 's1' },
    ])
    client.close()
  })

  it('requires a provider for the status hook', async () => {
    const container = document.createElement('div')
    containers.push(container)
    const root = createRoot(container)
    const errors: unknown[] = []
    const original = console.error
    console.error = () => {}
    try {
      await act(async () => {
        root.render(<Status />)
      })
    } catch (error: unknown) {
      errors.push(error)
    } finally {
      console.error = original
    }
    expect(String(errors[0])).toContain('CanopyProvider')
  })
})
