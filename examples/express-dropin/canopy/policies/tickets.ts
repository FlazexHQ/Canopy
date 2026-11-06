import { allow, auth, collection } from '@canopy/policy'

export default collection('tickets', {
  exposed: true,
  realtime: true,
  policies: [
    allow
      .read('authenticated')
      .where({ ownerId: auth('sub') })
      .named('customers read their own tickets'),
    allow.read('support').named('support reads every ticket'),
  ],
  fields: {
    read: {
      default: { omit: ['internalNotes'] },
      support: { only: ['*'] },
    },
  },
})
