import { defineProject, mergeConfig } from 'vitest/config'
import { sharedConfig } from '../../vitest.shared.ts'

export default mergeConfig(
  sharedConfig,
  defineProject({
    test: {
      name: 'rest',
      include: ['test/**/*.test.ts'],
      testTimeout: 30_000,
    },
  }),
)
