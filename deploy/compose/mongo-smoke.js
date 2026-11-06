const TIMEOUT_MS = 10000

function fail(message) {
  print(`mongo smoke: FAILED: ${message}`)
  quit(1)
}

const hello = db.hello()
if (hello.setName === undefined) fail("the server is not a replica set member")
if (!hello.isWritablePrimary) fail(`the member is not primary (setName ${hello.setName})`)

const smoke = db.getSiblingDB("canopy_smoke")
smoke.dropDatabase()
const events = smoke.events

const stream = events.watch([], { fullDocument: "updateLookup" })
events.insertOne({ _id: 1, step: "insert" })
events.updateOne({ _id: 1 }, { $set: { step: "update" } })

const seen = []
const deadline = Date.now() + TIMEOUT_MS
while (seen.length < 2 && Date.now() < deadline) {
  const event = stream.tryNext()
  if (event !== null) seen.push(event)
}
stream.close()
if (seen.length < 2) fail(`expected 2 change events, received ${seen.length}`)
if (seen[0].operationType !== "insert") fail(`first event was ${seen[0].operationType}`)
if (seen[1].operationType !== "update") fail(`second event was ${seen[1].operationType}`)
if (seen[1].fullDocument?.step !== "update")
  fail("updateLookup did not return the post update document")

const session = db.getMongo().startSession()
const inSession = session.getDatabase("canopy_smoke").events
session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } })
inSession.insertOne({ _id: 2, step: "transaction" })
session.abortTransaction()
if (events.countDocuments({ _id: 2 }) !== 0) fail("an aborted transaction left its write behind")
session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } })
inSession.insertOne({ _id: 3, step: "transaction" })
session.commitTransaction()
session.endSession()
if (events.countDocuments({ _id: 3 }) !== 1)
  fail("a committed transaction did not persist its write")

smoke.dropDatabase()
print(`mongo smoke: ok (MongoDB ${db.version()}, replica set ${hello.setName})`)
