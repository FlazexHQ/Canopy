import { defineProject, mergeConfig } from 'vitest/config'
import { sharedConfig } from '../../vitest.shared.ts'

export default mergeConfig(
  sharedConfig,
  defineProject({
    test: {
      name: 'cli',
      include: ['test/**/*.test.ts'],
      exclude: ['test/fixtures/**'],
      testTimeout: 30_000,
    },
  }),
)
