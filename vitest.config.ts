import { existsSync, readdirSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

const projects = ['packages', 'apps', 'examples']
  .filter((dir) => existsSync(dir) && readdirSync(dir).length > 0)
  .map((dir) => `${dir}/*`)

export default defineConfig({
  test: projects.length > 0 ? { projects } : { include: [], passWithNoTests: true },
})
