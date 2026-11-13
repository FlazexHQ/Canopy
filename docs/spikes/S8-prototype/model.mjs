// Monthly cost and load of the edge fan-out topologies. Prices: Workers Paid, Durable Objects (Nov 2026).
const PRICE = {
  base: 5,
  doRequestsIncluded: 1e6,
  doRequestPerM: 0.15,
  gbSecondsIncluded: 400_000,
  gbSecondPerM: 12.5,
  workerRequestsIncluded: 10e6,
  workerRequestPerM: 0.3,
  memoryGb: 0.128,
}
const MONTH = 30 * 24 * 3600

const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.split("=")))
const calibration = {
  // Active time of one delivery request in a connection DO: fixed part plus per socket checked and per frame sent.
  fixedMs: Number(args.fixedMs ?? 2),
  perCheckUs: Number(args.perCheckUs ?? 0.05),
  perSendUs: Number(args.perSendUs ?? 3),
  perInboundMs: Number(args.perInboundMs ?? 0.5),
}

function month({ sockets, perDo, eventsPerSecond, privateShare, collections, routing, inboundPerHour, connectsPerDay, batchMs }) {
  const connectionDos = Math.ceil(sockets / perDo)
  const perCollection = eventsPerSecond / collections
  const batchesPerSecond = collections * Math.min(perCollection, 1000 / batchMs)
  const eventsPerBatch = perCollection / Math.min(perCollection, 1000 / batchMs)
  const privatePerBatch = eventsPerBatch * privateShare
  const publicPerBatch = eventsPerBatch - privatePerBatch
  const touched =
    routing === "broadcast"
      ? connectionDos
      : connectionDos * (1 - (1 - 1 / connectionDos) ** privatePerBatch * Math.exp(-publicPerBatch))
  const checksPerBatch =
    routing === "broadcast" ? eventsPerBatch * sockets : privatePerBatch + publicPerBatch * sockets
  const sendsPerBatch = privatePerBatch + publicPerBatch * sockets

  const relayRequests = batchesPerSecond * MONTH
  const forwardRequests = batchesPerSecond * touched * MONTH
  const inboundRequests = (sockets * inboundPerHour * 24 * 30) / 20
  const connectRequests = sockets * connectsPerDay * 30
  const doRequests = relayRequests + forwardRequests + inboundRequests + connectRequests

  const activeSecondsPerBatch =
    (touched * calibration.fixedMs + (checksPerBatch * calibration.perCheckUs + sendsPerBatch * calibration.perSendUs) / 1000) / 1000
  const deliverySeconds = activeSecondsPerBatch * batchesPerSecond * MONTH
  const inboundSeconds = (sockets * inboundPerHour * 24 * 30 * calibration.perInboundMs) / 1000
  const gbSeconds = (deliverySeconds + inboundSeconds) * PRICE.memoryGb

  const requestCost = (Math.max(0, doRequests - PRICE.doRequestsIncluded) / 1e6) * PRICE.doRequestPerM
  const durationCost = (Math.max(0, gbSeconds - PRICE.gbSecondsIncluded) / 1e6) * PRICE.gbSecondPerM
  const workerCost = (Math.max(0, connectRequests - PRICE.workerRequestsIncluded) / 1e6) * PRICE.workerRequestPerM
  return {
    connectionDos,
    touchedPerBatch: Math.round(touched * 10) / 10,
    forwardsPerSecond: Math.round(batchesPerSecond * touched),
    framesPerSecond: Math.round(sendsPerBatch * batchesPerSecond),
    avgDoBusyPct: Math.round((activeSecondsPerBatch / connectionDos) * batchesPerSecond * 1000) / 10,
    doRequestsM: Math.round(doRequests / 1e5) / 10,
    gbSecondsK: Math.round(gbSeconds / 100) / 10,
    usd: Math.round((PRICE.base + requestCost + durationCost + workerCost) * 100) / 100,
  }
}

const rows = []
for (const sockets of [10_000, 100_000])
  for (const eventsPerSecond of [10, 100, 1000])
    for (const privateShare of [1, 0.99])
      for (const routing of ["broadcast", "index"])
        rows.push({
          sockets,
          eventsPerSecond,
          privateShare,
          routing,
          ...month({
            sockets,
            perDo: Number(args.perDo ?? 1000),
            eventsPerSecond,
            privateShare,
            collections: 4,
            routing,
            inboundPerHour: 30,
            connectsPerDay: 4,
            batchMs: Number(args.batchMs ?? 50),
          }),
        })
console.table(rows)
if (args.json) process.stdout.write(`${JSON.stringify({ calibration, rows })}\n`)
