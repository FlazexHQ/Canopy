import { DurableObject } from "cloudflare:workers"

const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })

export class Connection extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'))
  }

  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/connect") {
      const pair = new WebSocketPair()
      const user = url.searchParams.get("user")
      const collection = url.searchParams.get("c")
      this.ctx.acceptWebSocket(pair[1], [collection, `u:${user}`])
      pair[1].serializeAttachment({ user, collection, sid: crypto.randomUUID() })
      return new Response(null, { status: 101, webSocket: pair[0] })
    }
    if (url.pathname === "/deliver") {
      const { collection, events } = await request.json()
      const sockets = this.ctx.getWebSockets(collection)
      let sent = 0
      let checked = 0
      if (url.searchParams.get("mode") === "index") {
        for (const event of events) {
          const targets = event.public ? sockets : this.ctx.getWebSockets(`u:${event.owner}`)
          const frame = JSON.stringify({ t: "changed", c: collection, id: event.id, set: event.set })
          for (const ws of targets) {
            checked += 1
            ws.send(frame)
            sent += 1
          }
        }
      } else {
        const attachments = sockets.map((ws) => ws.deserializeAttachment())
        for (const event of events) {
          const frame = JSON.stringify({ t: "changed", c: collection, id: event.id, set: event.set })
          for (let index = 0; index < sockets.length; index += 1) {
            checked += 1
            if (event.public || attachments[index].user === event.owner) {
              sockets[index].send(frame)
              sent += 1
            }
          }
        }
      }
      return json({ sent, checked, sockets: sockets.length })
    }
    if (url.pathname === "/users") {
      const users = new Set()
      for (const ws of this.ctx.getWebSockets(url.searchParams.get("c"))) users.add(ws.deserializeAttachment().user)
      return json([...users])
    }
    return new Response("not found", { status: 404 })
  }

  webSocketMessage(ws, message) {
    ws.send(JSON.stringify({ t: "ack", echo: String(message).length }))
  }

  webSocketClose(ws, code) {
    ws.close(code, "bye")
  }
}

export class Topic extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url)
    const shards = Number(url.searchParams.get("shards"))
    const mode = url.searchParams.get("mode")
    const { collection, events } = await request.json()
    if (mode === "index" && this.owners === undefined) {
      this.owners = new Map()
      await Promise.all(
        Array.from({ length: shards }, async (_, shard) => {
          const stub = this.env.CONNECTION.get(this.env.CONNECTION.idFromName(`conn-${shard}`))
          const users = await (await stub.fetch(`https://do/users?c=${collection}`)).json()
          for (const user of users) this.owners.set(user, shard)
        }),
      )
    }
    const byShard = new Map()
    for (const event of events) {
      const targets = mode === "index" && !event.public ? [this.owners.get(event.owner)] : Array.from({ length: shards }, (_, i) => i)
      for (const shard of targets) {
        if (shard === undefined) continue
        let list = byShard.get(shard)
        if (list === undefined) byShard.set(shard, (list = []))
        list.push(event)
      }
    }
    const results = await Promise.all(
      [...byShard].map(async ([shard, list]) => {
        const stub = this.env.CONNECTION.get(this.env.CONNECTION.idFromName(`conn-${shard}`))
        const response = await stub.fetch(`https://do/deliver?mode=${mode}`, {
          method: "POST",
          body: JSON.stringify({ collection, events: list }),
        })
        return response.json()
      }),
    )
    return json({
      forwarded: results.length,
      sent: results.reduce((sum, r) => sum + r.sent, 0),
      checked: results.reduce((sum, r) => sum + r.checked, 0),
    })
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === "/connect") {
      const shard = url.searchParams.get("shard")
      return env.CONNECTION.get(env.CONNECTION.idFromName(`conn-${shard}`)).fetch(request)
    }
    if (url.pathname === "/relay") {
      const collection = url.searchParams.get("c")
      return env.TOPIC.get(env.TOPIC.idFromName(`topic-${collection}`)).fetch(request)
    }
    return new Response("not found", { status: 404 })
  },
}
