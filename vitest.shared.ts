import { defineProject } from 'vitest/config'

/**
 * Settings shared by every package's Vitest project. Workspace packages export their TypeScript sources under
 * the `@canopy/source` condition, so tests run against source without a build step.
 */
export const sharedConfig = defineProject({
  resolve: {
    conditions: ['@canopy/source', 'module', 'browser', 'development|production'],
  },
  ssr: {
    resolve: {
      conditions: ['@canopy/source', 'node', 'import', 'module', 'development|production'],
    },
  },
})
