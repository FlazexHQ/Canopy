import { allow, auth, collection, restrict } from '@canopy/policy'

export default collection('todos', {
  exposed: true,
  realtime: true,
  policies: [
    allow
      .read('authenticated')
      .where({ ownerId: auth('sub') })
      .named('read own'),
    allow
      .insert('authenticated')
      .check({ ownerId: auth('sub') })
      .named('create own'),
    allow
      .update('authenticated')
      .where({ ownerId: auth('sub') })
      .named('edit own'),
    allow
      .delete('authenticated')
      .where({ ownerId: auth('sub') })
      .named('delete own'),
    restrict
      .delete('authenticated')
      .where({ archived: { $ne: true } })
      .named('archived is permanent'),
  ],
  fields: {
    read: { default: { omit: ['internalNotes'] } },
    write: { default: { only: ['title', 'done', 'ownerId', 'archived', 'tags'] } },
  },
  immutable: ['ownerId'],
})
