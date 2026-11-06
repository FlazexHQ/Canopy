import { allow, auth, collection, restrict } from '../src/index.ts'

/** Personal todos: owners read and write their own, org members read shared ones. */
export const todos = collection('todos', {
  exposed: true,
  realtime: true,
  policies: [
    allow
      .read('authenticated')
      .where({ ownerId: auth('sub') })
      .named('read own'),
    allow
      .read('authenticated')
      .where({ orgId: { $in: auth('org_ids') }, shared: true })
      .named('read shared in my orgs'),
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
    write: {
      default: {
        only: ['title', 'done', 'dueAt', 'tags', 'ownerId', 'orgId', 'shared', 'archived'],
      },
    },
  },
  immutable: ['ownerId', 'createdAt'],
})

/** Multi tenant invoices with tenant admins; paid invoices are frozen. */
export const invoices = collection('invoices', {
  exposed: true,
  policies: [
    allow
      .read('authenticated')
      .where({ tenantId: auth('tenant_id') })
      .named('read tenant'),
    allow
      .ops(['insert', 'update'], 'authenticated')
      .where({ tenantId: auth('tenant_id') })
      .check({ tenantId: auth('tenant_id'), status: { $in: ['draft', 'sent'] } })
      .named('write tenant'),
    allow
      .ops(['update', 'delete'], 'tenant_admin')
      .where({ tenantId: auth('tenant_id') })
      .named('admin'),
    restrict
      .ops(['update', 'delete'], 'public')
      .where({ status: { $ne: 'paid' } })
      .named('paid is frozen'),
  ],
  immutable: ['tenantId'],
})

/** A blog: published posts are public, drafts are visible to their author. */
export const posts = collection('posts', {
  exposed: true,
  policies: [
    allow.read('public').where({ published: true }).named('published'),
    allow
      .read('authenticated')
      .where({ authorId: auth('sub') })
      .named('own drafts'),
    allow
      .insert('authenticated')
      .check({ authorId: auth('sub') })
      .named('write own'),
    allow
      .update('authenticated')
      .where({ authorId: auth('sub') })
      .named('edit own'),
  ],
  immutable: ['authorId'],
})

/** HR records with salaries hidden from everyone but `hr`. */
export const employees = collection('employees', {
  exposed: true,
  policies: [
    allow
      .read('authenticated')
      .where({ orgId: auth('org_id') })
      .named('same org'),
  ],
  fields: { read: { default: { omit: ['salary', 'ssn'] }, hr: { only: ['*'] } } },
})

/** A collection nobody exposed. */
export const secrets = collection('secrets', {
  policies: [allow.read('public').named('everyone')],
})
