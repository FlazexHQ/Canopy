import { as, describePolicies } from '@canopy/policy/testing'

describePolicies('todos', ({ doc, expect }) => {
  const alice = as.user({ sub: 'u_alice' })
  const bob = as.user({ sub: 'u_bob' })
  const t = doc({ _id: 't1', ownerId: 'u_alice', title: 'x', internalNotes: 'secret' })
  expect(alice).can.read(t).withoutFields(['internalNotes'])
  expect(bob).cannot.read(t)
  expect(alice).can.update(t, { $set: { done: true } })
  expect(alice).can.update(t, { $push: { tags: 'urgent' } })
  expect(alice).cannot.update(t, { $set: { ownerId: 'u_bob' } })
  expect(alice).cannot.update(t, { $inc: { title: 1 } })
  expect(alice).cannot.delete({ ...t, archived: true })
  expect(alice).can.delete(t)
  expect(alice).can.insert({ _id: 't2', title: 'y', ownerId: 'u_alice' })
  expect(alice).cannot.insert({ _id: 't3', title: 'y', ownerId: 'u_bob' })
  expect(as.anon()).cannot.read(t)
})
